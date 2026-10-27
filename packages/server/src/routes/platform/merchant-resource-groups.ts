import { Hono, type Context } from "hono";
import { z } from "zod";
import { isStartablePricingKind, type PricingConfigKind } from "@prism/core";
import type { AppBindings } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { requireUser } from "../../middleware/auth.js";
import { DEFAULT_RESOURCE_GROUP_ID } from "../../resources/billing.js";
import { defaultResourceGroup, findResourceGroup, listResourceGroups } from "../../resources/repository.js";
import { assertResourceShop, canConfigureResource } from "./merchant-resources.js";

/**
 * Resource groups: a name and a default plan for the resources in them. The
 * shop's default group is not stored; its plan is the shop's default plan, so
 * a shop that never creates a group keeps billing exactly as it did.
 */
export const merchantResourceGroupRouter = new Hono<AppBindings>();
type C = Context<AppBindings>;

const planInput = z.string().min(1).nullable();
const createInput = z.object({
  shopId: z.string().min(1),
  name: z.string().trim().min(1).max(40),
  enabled: z.boolean().default(true),
  defaultPricingConfigId: planInput.default(null),
}).strict();
const patchInput = z.object({
  shopId: z.string().min(1),
  name: z.string().trim().min(1).max(40).optional(),
  enabled: z.boolean().optional(),
  defaultPricingConfigId: planInput.optional(),
}).strict();

async function configurable(c: C, shopId: string) {
  const user = requireUser(c);
  await assertResourceShop(c, user, shopId);
  if (!await canConfigureResource(c, user, shopId)) jsonError(403, "只读账号不能配置资源组", "FORBIDDEN");
}

/**
 * A plan a resource may bill: a plan of this shop a session can run (a time
 * plan, or a fixed charge billed once per session) that is not archived. The
 * shop's default plan times every visit with nothing else running, so it is a
 * time plan.
 */
/**
 * A plan given to a group or resource starts billing it, so it must be usable
 * and players need a balance to pay from. Clearing the plan (null) makes it free.
 */
export async function assertBillablePlan(c: C, shopId: string, planId: string | null | undefined, timeOnly = false) {
  if (!planId) return;
  const [plan, currency] = await Promise.all([
    c.env.DB.prepare("SELECT kind, status FROM pricing_configs WHERE shop_id = ? AND id = ?")
      .bind(shopId, planId).first<{ kind: PricingConfigKind; status: string }>(),
    c.env.DB.prepare("SELECT 1 FROM asset_definitions WHERE shop_id = ? AND type = 'currency' AND status = 'active' LIMIT 1")
      .bind(shopId).first(),
  ]);
  if (!plan || plan.status !== "active" || !isStartablePricingKind(plan.kind) || (timeOnly && plan.kind !== "time.priority"))
    jsonError(400, timeOnly ? "请选择有效的按时计费规则" : "请选择有效的计费规则", "RESOURCE_PRICING_INVALID");
  if (!currency) jsonError(409, "请先配置有效的余额资产", "BILLING_CONFIGURATION_REQUIRED");
}

async function shopDefaultGroup(c: C, shopId: string) {
  const row = await c.env.DB.prepare("SELECT entry_pricing_ids_json AS ids FROM shop_billing_settings WHERE shop_id = ?")
    .bind(shopId).first<{ ids: string }>();
  return defaultResourceGroup(shopId, row?.ids ?? "[]");
}

async function view(c: C, shopId: string) {
  const [defaultGroup, groups, counts] = await Promise.all([
    shopDefaultGroup(c, shopId),
    listResourceGroups(c.env.DB, shopId),
    c.env.DB.prepare("SELECT COALESCE(resource_group_id, ?) AS id, COUNT(*) AS n FROM machines WHERE shop_id = ? GROUP BY 1")
      .bind(DEFAULT_RESOURCE_GROUP_ID, shopId).all<{ id: string; n: number }>(),
  ]);
  const count = new Map(counts.results.map((row) => [row.id, row.n]));
  return [defaultGroup, ...groups].map((group) => ({
    id: group.id,
    name: group.name,
    enabled: group.enabled,
    isDefault: group.isDefault,
    defaultPricingConfigId: group.defaultPricingConfigId,
    resourceCount: count.get(group.id) ?? 0,
  }));
}

merchantResourceGroupRouter.get("/resource-groups", async (c) => {
  const user = requireUser(c);
  const shopId = c.req.query("shopId");
  if (!shopId) jsonError(400, "请选择店铺", "SHOP_REQUIRED");
  await assertResourceShop(c, user, shopId);
  return c.json({ resourceGroups: await view(c, shopId) });
});

merchantResourceGroupRouter.post("/resource-groups", async (c) => {
  const body = createInput.parse(await c.req.json());
  await configurable(c, body.shopId);
  await assertBillablePlan(c, body.shopId, body.defaultPricingConfigId);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO resource_groups(shop_id, id, name, enabled, default_pricing_config_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(body.shopId, id, body.name, +body.enabled, body.defaultPricingConfigId, now, now).run();
  return c.json({ resourceGroup: (await view(c, body.shopId)).find((group) => group.id === id) }, 201);
});

merchantResourceGroupRouter.patch("/resource-groups/:id", async (c) => {
  const body = patchInput.parse(await c.req.json());
  const id = c.req.param("id");
  await configurable(c, body.shopId);
  await assertBillablePlan(c, body.shopId, body.defaultPricingConfigId, id === DEFAULT_RESOURCE_GROUP_ID);
  if (id === DEFAULT_RESOURCE_GROUP_ID) {
    if (body.name !== undefined || body.enabled === false)
      jsonError(400, "默认资源组只能修改计费方案", "RESOURCE_GROUP_DEFAULT_FIXED");
    if (body.defaultPricingConfigId !== undefined) {
      await c.env.DB.prepare(
        `INSERT INTO shop_billing_settings(shop_id, auto_register, entry_pricing_ids_json, bot_contact)
         VALUES (?, 0, ?, '') ON CONFLICT(shop_id) DO UPDATE SET entry_pricing_ids_json = excluded.entry_pricing_ids_json`,
      ).bind(body.shopId, JSON.stringify(body.defaultPricingConfigId ? [body.defaultPricingConfigId] : [])).run();
    }
  } else {
    const group = await findResourceGroup(c.env.DB, body.shopId, id);
    if (!group) jsonError(404, "没有找到这个资源组", "RESOURCE_GROUP_NOT_FOUND");
    await c.env.DB.prepare(
      `UPDATE resource_groups SET name = ?, enabled = ?, default_pricing_config_id = ?, updated_at = ?
       WHERE shop_id = ? AND id = ?`,
    ).bind(
      body.name ?? group.name,
      +(body.enabled ?? group.enabled),
      body.defaultPricingConfigId === undefined ? group.defaultPricingConfigId : body.defaultPricingConfigId,
      new Date().toISOString(),
      body.shopId,
      id,
    ).run();
  }
  return c.json({ resourceGroup: (await view(c, body.shopId)).find((group) => group.id === id) });
});

merchantResourceGroupRouter.delete("/resource-groups/:id", async (c) => {
  const shopId = c.req.query("shopId");
  if (!shopId) jsonError(400, "请选择店铺", "SHOP_REQUIRED");
  const id = c.req.param("id");
  await configurable(c, shopId);
  if (id === DEFAULT_RESOURCE_GROUP_ID) jsonError(400, "默认资源组不能删除", "RESOURCE_GROUP_DEFAULT_FIXED");
  if (!await findResourceGroup(c.env.DB, shopId, id)) jsonError(404, "没有找到这个资源组", "RESOURCE_GROUP_NOT_FOUND");
  const used = await c.env.DB.prepare("SELECT 1 FROM machines WHERE shop_id = ? AND resource_group_id = ? LIMIT 1")
    .bind(shopId, id).first();
  if (used) jsonError(409, "请先把组内资源移到其他资源组", "RESOURCE_GROUP_IN_USE");
  await c.env.DB.prepare("DELETE FROM resource_groups WHERE shop_id = ? AND id = ?").bind(shopId, id).run();
  return c.json({ ok: true });
});
