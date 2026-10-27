import { Hono, type Context } from "hono";
import { z } from "zod";
import { PLAYER_BILLING_LOCK_SCOPE, withOperationLease } from "@prism/application";
import type { AppBindings, TenantShop } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { staffPrincipal } from "../../middleware/auth.js";
import { getShop, getShopDeps } from "../../middleware/tenant.js";
import {
  toPlayerCheckoutPreviewView,
  toPlayerCheckoutResultView,
} from "./views.js";

/** The resource a front-desk check-in bills through, as the cashier settings name it. */
export async function cashierResourceId(db: Context<AppBindings>["env"]["DB"], shopId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT json_extract(value_json, '$.resourceId') AS id FROM app_settings WHERE shop_id = ? AND key = 'cashier.settings'")
    .bind(shopId)
    .first<{ id: string | null }>();
  return typeof row?.id === "string" ? row.id : null;
}

const cardSchema = z
  .object({
    kind: z.enum(["type-a", "felica"]),
    uid: z
      .string()
      .trim()
      .transform((val) => val.toUpperCase())
      .pipe(z.string().regex(/^(?:[0-9A-F]{2}){4,10}$/)),
  })
  .refine(
    (val) => val.kind !== "felica" || val.uid.length === 16,
    "FeliCa IDm 必须为 8 字节",
  );

async function getCashierProfile(
  c: Context<AppBindings>,
  shop: TenantShop,
  playerId: string,
) {
  const found = await c.env.DB.prepare(
    `SELECT p.id, p.display_name AS displayName, p.status,
            cp.card_kind AS kind, cp.card_uid AS uid
     FROM cashier_profiles cp
     JOIN players p ON p.shop_id = cp.shop_id AND p.id = cp.player_id
     WHERE cp.shop_id = ? AND cp.player_id = ?`,
  )
    .bind(shop.id, playerId)
    .first<{
      id: string;
      displayName: string;
      status: string;
      kind: string;
      uid: string;
    }>();

  if (!found) {
    jsonError(404, "没有找到前台卡片档案", "CASHIER_PROFILE_NOT_FOUND");
  }

  const deps = getShopDeps(c);
  const activeSessions = await deps.repositories.sessions.findActiveByPlayerId(playerId);
  const unpaidSessions =
    (await deps.repositories.sessions.findUnpaidClosedByPlayerId?.(playerId)) ?? [];
  const sessions = [...activeSessions, ...unpaidSessions];

  return { ...found, paymentMode: "cashier" as const, sessions };
}

export const cashierRouter = new Hono<AppBindings>();

cashierRouter.use("*", async (c, next) => {
  const shop = getShop(c);
  const staff = await staffPrincipal(c, shop, true);
  if (staff.staffRole === "viewer" && c.req.method !== "GET" && !c.req.path.endsWith("/lookup")) {
    jsonError(403, "只读账号不能操作前台收银", "FORBIDDEN");
  }
  if (!shop.cashier_enabled) {
    jsonError(409, "店铺未启用前台收银", "CASHIER_DISABLED");
  }
  await next();
});

// Card Lookup
cashierRouter.post("/lookup", async (c) => {
  const shop = getShop(c);
  const body = cardSchema.parse(await c.req.json());
  const found = await c.env.DB.prepare(
    "SELECT player_id FROM cashier_profiles WHERE shop_id = ? AND card_kind = ? AND card_uid = ?",
  )
    .bind(shop.id, body.kind, body.uid)
    .first<{ player_id: string }>();

  return c.json({
    profile: found ? await getCashierProfile(c, shop, found.player_id) : null,
  });
});

// Profile by Player ID
cashierRouter.get("/profiles/:playerId", async (c) => {
  const shop = getShop(c);
  const playerId = c.req.param("playerId");
  return c.json({ profile: await getCashierProfile(c, shop, playerId) });
});

// Browser-side preview input for a cashier-associated player.
cashierRouter.get("/profiles/:playerId/billing-inputs", async (c) => {
  const shop = getShop(c);
  const playerId = c.req.param("playerId");
  await getCashierProfile(c, shop, playerId);
  const billingInputs = getShopDeps(c).staffLiveBillingSnapshot;
  if (!billingInputs) jsonError(503, "Client billing is unavailable for this runtime.", "CLIENT_BILLING_UNAVAILABLE");
  return c.json({ playerId, billingSnapshot: await billingInputs([playerId]) });
});

// Register Card Profile
cashierRouter.post("/register", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const body = z
    .object({
      card: cardSchema,
      displayName: z.string().trim().min(1, "姓名不能为空").max(80),
    })
    .parse(await c.req.json());

  return withOperationLease(
    {
      repository: deps.repositories.operationLocks,
      scope: "cashier.card",
      resourceId: `${body.card.kind}:${body.card.uid}`,
      now: () => new Date(),
    },
    async () => {
      const exists = await c.env.DB.prepare(
        "SELECT player_id FROM cashier_profiles WHERE shop_id = ? AND card_kind = ? AND card_uid = ?",
      )
        .bind(shop.id, body.card.kind, body.card.uid)
        .first();

      if (exists) {
        jsonError(409, "此卡已绑定档案，请重新刷卡", "CASHIER_CARD_BOUND");
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT INTO players (shop_id, id, display_name, status, created_at) VALUES (?, ?, ?, 'active', ?)",
        ).bind(shop.id, id, body.displayName, now),
        c.env.DB.prepare(
          "INSERT INTO cashier_profiles (shop_id, player_id, card_kind, card_uid, created_at) VALUES (?, ?, ?, ?, ?)",
        ).bind(shop.id, id, body.card.kind, body.card.uid, now),
      ]);

      return c.json({ profile: await getCashierProfile(c, shop, id) }, 201);
    },
  );
});

// Entry Session
cashierRouter.post("/profiles/:playerId/entry", async (c) => {
  const shop = getShop(c);
  const staff = await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const playerId = c.req.param("playerId");

  return withOperationLease(
    {
      repository: deps.repositories.operationLocks,
      scope: PLAYER_BILLING_LOCK_SCOPE,
      resourceId: playerId,
      now: () => new Date(),
    },
    async () => {
      const profile = await getCashierProfile(c, shop, playerId);
      if (profile.status !== "active") {
        jsonError(403, "店铺玩家资格已停用", "PLAYER_DISABLED");
      }
      if (profile.sessions.some((session) => session.status === "closed")) {
        jsonError(409, "请先结清上次账单", "CASHIER_UNPAID_VISIT");
      }

      // The front desk is a resource: its check-in bills its group's plan, or its own.
      const resourceId = await cashierResourceId(c.env.DB, shop.id);
      if (!resourceId) jsonError(409, "请先选择前台资源", "CASHIER_RESOURCE_REQUIRED");
      const { session } = await deps.resourceBilling.activate({
        playerId,
        resourceId,
        metadata: { createdBy: "cashier", staffId: staff.staffId },
      });

      return c.json({ session, profile: await getCashierProfile(c, shop, playerId) });
    },
  );
});

// Checkout Preview
cashierRouter.post("/profiles/:playerId/checkout/preview", async (c) => {
  const shop = getShop(c);
  const deps = getShopDeps(c);
  const playerId = c.req.param("playerId");
  await getCashierProfile(c, shop, playerId);

  const preview = await deps.staffCheckoutCommands.previewCheckout({ playerId });
  return c.json(toPlayerCheckoutPreviewView(preview));
});

// Checkout Confirm (External Payment Settle)
cashierRouter.post("/profiles/:playerId/checkout/confirm", async (c) => {
  const shop = getShop(c);
  const staff = await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const playerId = c.req.param("playerId");
  await getCashierProfile(c, shop, playerId);

  const body = z
    .object({
      method: z.enum(["wechat", "alipay", "cash", "other"]),
      previewedAt: z.string().datetime({ offset: true }),
      expectedTotal: z.number().finite().nonnegative(),
      sessionIds: z.array(z.string().min(1)).min(1).max(100),
    })
    .parse(await c.req.json());

  const result = await deps.staffCheckoutCommands.checkoutExternal({
    playerId,
    staffId: staff.staffId,
    previewedAt: new Date(body.previewedAt),
    expectedTotal: body.expectedTotal,
    method: body.method,
    sessionIds: body.sessionIds,
  });

  return c.json({
    ...toPlayerCheckoutResultView(result),
    payment: {
      method: body.method,
      staffId: staff.staffId,
      collected: true,
    },
  });
});
