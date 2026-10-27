import { Hono } from "hono";
import { z } from "zod";
import { withOperationLease } from "@prism/application";
import type { AppBindings } from "../../bindings.js";
import { sha256 } from "../../crypto.js";
import { notifyBotsChangedAfter } from "../../durable-objects/shop-hub-client.js";
import { jsonError } from "../../http.js";
import { requireUser, staffPrincipal } from "../../middleware/auth.js";
import { getShop, getShopDeps } from "../../middleware/tenant.js";
import { billingSetupSchema, billingSetupStatements } from "../platform/shops.js";
import { DEFAULT_RESOURCE_GROUP_ID } from "../../resources/billing.js";
import { publicSettings } from "./index.js";

/** Backward-compatible merchant billing routes. */
export const billingCompatRouter = new Hono<AppBindings>();

billingCompatRouter.get("/operations/:operationId", async (c) => {
  const user = requireUser(c);
  const shop = getShop(c);
  const operation = await c.env.DB.prepare(
    "SELECT id,kind,status,result_json,created_at AS createdAt FROM player_operations WHERE shop_id=? AND user_id=? AND id=?",
  ).bind(shop.id, user.id, c.req.param("operationId")).first();
  if (!operation) jsonError(404, "没有找到这个操作", "OPERATION_NOT_FOUND");
  return c.json({ operation });
});

billingCompatRouter.get("/billing-members", async (c) => {
  const shop = getShop(c);
  const principal = await staffPrincipal(c, shop);
  if (principal.staffRole !== "owner") jsonError(403, "此操作需要店主权限", "FORBIDDEN");
  const members = await c.env.DB.prepare(
    `SELECT m.user_id AS userId,i.display_name AS name,m.role AS shopRole,
      CASE WHEN s.status='active' THEN s.role ELSE 'none' END AS billingRole
      FROM shop_members m LEFT JOIN auth_identities i ON i.user_id=m.user_id AND i.provider='munet'
      LEFT JOIN shop_staff_accounts a ON a.shop_id=m.shop_id AND a.user_id=m.user_id
      LEFT JOIN staff_users s ON s.shop_id=a.shop_id AND s.id=a.staff_id WHERE m.shop_id=?`,
  ).bind(shop.id).all();
  return c.json({ members: members.results });
});

billingCompatRouter.put("/billing-members/:userId", async (c) => {
  const shop = getShop(c);
  const principal = await staffPrincipal(c, shop);
  if (principal.staffRole !== "owner") jsonError(403, "此操作需要店主权限", "FORBIDDEN");
  const userId = c.req.param("userId");
  const body = z.object({ role: z.enum(["manager", "viewer", "none"]) }).parse(await c.req.json());
  const member = await c.env.DB.prepare(
    "SELECT role FROM shop_members WHERE shop_id=? AND user_id=?",
  ).bind(shop.id, userId).first<{ role: string }>();
  if (!member) jsonError(404, "请先把账号添加为店铺成员", "MEMBER_NOT_FOUND");
  if (member.role === "owner") jsonError(409, "店主的账务权限由店铺身份决定", "OWNER_ROLE_IMMUTABLE");
  const existing = await c.env.DB.prepare(
    "SELECT staff_id FROM shop_staff_accounts WHERE shop_id=? AND user_id=?",
  ).bind(shop.id, userId).first<{ staff_id: string }>();
  const staffId = existing?.staff_id ?? `account:${userId}`;
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO staff_users(shop_id,id,username,display_name,password_hash,password_salt,role,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(shop_id,id) DO UPDATE SET
      role=excluded.role,status=excluded.status,updated_at=excluded.updated_at`,
    ).bind(
      shop.id, staffId, `account:${userId}`, userId,
      crypto.randomUUID(), crypto.randomUUID(),
      body.role === "none" ? "viewer" : body.role,
      body.role === "none" ? "disabled" : "active", now, now,
    ),
    c.env.DB.prepare(
      "INSERT INTO shop_staff_accounts(shop_id,user_id,staff_id) VALUES (?,?,?) ON CONFLICT(shop_id,user_id) DO NOTHING",
    ).bind(shop.id, userId, staffId),
  ]);
  return c.json({ role: body.role });
});

billingCompatRouter.post("/billing/setup", async (c) => {
  const shop = getShop(c);
  const principal = await staffPrincipal(c, shop);
  if (principal.staffRole !== "owner") jsonError(403, "只有店铺负责人可以启用计费", "FORBIDDEN");
  const body = billingSetupSchema.omit({ autoRegister: true, botContact: true }).extend({
    operationId: z.string().uuid(),
    cashierEnabled: z.boolean().default(false),
  }).parse(await c.req.json());
  const user = requireUser(c);
  const { operationId, ...payload } = body;
  const requestHash = await sha256(JSON.stringify(payload));
  const deps = getShopDeps(c);
  return withOperationLease(
    { repository: deps.repositories.operationLocks, scope: "shop.cashier", resourceId: shop.id, now: () => new Date() },
    async () => {
      const operation = await c.env.DB.prepare(
        "SELECT kind,request_hash,result_json FROM player_operations WHERE shop_id=? AND user_id=? AND id=?",
      ).bind(shop.id, user.id, operationId).first<{ kind: string; request_hash: string; result_json: string | null }>();
      if (operation && (operation.kind !== "billing/setup" || operation.request_hash !== requestHash)) {
        jsonError(409, "请求编号已用于其他操作", "OPERATION_CONFLICT");
      }
      if (operation?.result_json) {
        const result = JSON.parse(operation.result_json) as { status: number; body: unknown };
        return Response.json(result.body, { status: result.status });
      }
      const current = await c.env.DB.prepare(
        `SELECT (SELECT g.default_pricing_config_id FROM resource_groups g WHERE g.shop_id=s.id AND g.id=?) AS default_group_plan,
        COALESCE(b.auto_register,0) AS auto_register, COALESCE(b.bot_contact,'') AS bot_contact
        FROM shops s LEFT JOIN shop_billing_settings b ON b.shop_id=s.id WHERE s.id=?`,
      ).bind(DEFAULT_RESOURCE_GROUP_ID, shop.id).first<{ default_group_plan: string | null; auto_register: number; bot_contact: string }>();
      if (!current) jsonError(404, "店铺不存在", "SHOP_NOT_FOUND");
      // Quick setup prices the default group; one that has a plan is adjusted on the resources page.
      if (current.default_group_plan) jsonError(409, "默认资源组已有计费方案，请在资源页调整", "BILLING_ALREADY_ENABLED");
      const archived = await c.env.DB.prepare(
        "SELECT 1 FROM asset_definitions WHERE shop_id=? AND type='currency' AND code IN ('paid','free') AND status='archived' LIMIT 1",
      ).bind(shop.id).first();
      if (archived) jsonError(409, "基础余额资产已归档，请先恢复后再转换", "BILLING_ASSETS_ARCHIVED");
      const setup = billingSetupStatements(c.env.DB, shop.id, {
        ...body, autoRegister: !!current.auto_register, botContact: current.bot_contact,
      });
      const result = {
        ...publicSettings(shop), cashierEnabled: body.cashierEnabled || !!shop.cashier_enabled,
        ...(body.cashierEnabled ? { cashierResourceId: `desk-${shop.id}` } : {}),
        pricingConfigId: setup.ruleId,
        billingConfiguration: { ready: true, balanceAssetsReady: true },
      };
      const now = new Date().toISOString();
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO player_operations(shop_id,user_id,id,kind,status,request_hash,created_at)
          SELECT ?,?,?,'billing/setup','pending',?,? WHERE NOT EXISTS (
            SELECT 1 FROM player_operations WHERE shop_id=? AND user_id=? AND id=? AND kind='billing/setup' AND request_hash=?
          )`,
        ).bind(shop.id, user.id, operationId, requestHash, now, shop.id, user.id, operationId, requestHash),
        // Turning the front desk on also makes it a resource (see frontDeskStatements).
        ...setup.statements,
        c.env.DB.prepare(
          "UPDATE player_operations SET status='completed',result_json=? WHERE shop_id=? AND user_id=? AND id=? AND kind='billing/setup' AND request_hash=?",
        ).bind(JSON.stringify({ status: 200, body: result }), shop.id, user.id, operationId, requestHash),
      ]);
      // The default group bills now, and so do its bots.
      notifyBotsChangedAfter(c, shop.id);
      return c.json(result);
    },
  );
});
