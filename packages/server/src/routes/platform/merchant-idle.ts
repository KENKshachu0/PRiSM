/**
 * Idle power-off settings: the shop-wide rules and which devices are never
 * switched off. A device's idle time is its occupancy time, set on the
 * resource. Owners and managers edit them; anyone on the shop's staff can read
 * them.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../bindings.js";
import { IDLE_SETTINGS_KEY, idleSettingsSchema, parseIdleSettings, type IdleSettings } from "../../resources/capabilities/idle-power.js";
import { touchShopHubAfter } from "../../durable-objects/shop-hub-client.js";
import { jsonError } from "../../http.js";
import { requireUser } from "../../middleware/auth.js";
import { assertResourceShop, canConfigureResource } from "./merchant-resources.js";

export const merchantIdleRouter = new Hono<AppBindings>();
type C = Context<AppBindings>;

async function shopOf(c: C, write: boolean) {
  const user = requireUser(c);
  const shopId = c.req.query("shopId");
  if (!shopId) jsonError(400, "请选择店铺", "SHOP_REQUIRED");
  await assertResourceShop(c, user, shopId);
  if (write && !(await canConfigureResource(c, user, shopId))) jsonError(403, "只读账号不能配置资源", "FORBIDDEN");
  return shopId;
}

async function read(c: C, shopId: string): Promise<IdleSettings> {
  const row = await c.env.DB.prepare("SELECT value_json FROM app_settings WHERE shop_id = ? AND key = ?")
    .bind(shopId, IDLE_SETTINGS_KEY).first<{ value_json: string }>();
  try {
    return parseIdleSettings(row ? JSON.parse(row.value_json) : {});
  } catch {
    return parseIdleSettings({});
  }
}

async function write(c: C, shopId: string, settings: IdleSettings) {
  await c.env.DB.prepare(
    `INSERT INTO app_settings(shop_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(shop_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).bind(shopId, IDLE_SETTINGS_KEY, JSON.stringify(settings), new Date().toISOString()).run();
  // New rules apply right away rather than at the next activity.
  touchShopHubAfter(c, shopId);
}

merchantIdleRouter.get("/idle-power", async (c) => {
  const shopId = await shopOf(c, false);
  return c.json({ settings: await read(c, shopId) });
});

/** The shop-wide rules. Which devices are never switched off is kept unless sent. */
merchantIdleRouter.put("/idle-power", async (c) => {
  const shopId = await shopOf(c, true);
  const body = z.object({ shopEmpty: z.unknown().optional(), device: z.unknown().optional(), devices: z.unknown().optional() })
    .parse(await c.req.json());
  const current = await read(c, shopId);
  const next = idleSettingsSchema.parse({
    ...current,
    ...Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)),
  });
  await write(c, shopId, next);
  return c.json({ settings: next });
});

/** Whether one device is never switched off automatically. */
merchantIdleRouter.put("/idle-power/devices/:deviceId", async (c) => {
  const shopId = await shopOf(c, true);
  const body = z.object({ exclude: z.boolean().default(false) }).parse(await c.req.json());
  const device = await c.env.DB.prepare("SELECT 1 FROM machines WHERE shop_id = ? AND id = ?")
    .bind(shopId, c.req.param("deviceId")).first();
  if (!device) jsonError(404, "没有找到这个资源", "DEVICE_NOT_FOUND");
  const current = await read(c, shopId);
  const devices = { ...current.devices };
  if (!body.exclude) delete devices[c.req.param("deviceId")];
  else devices[c.req.param("deviceId")] = { exclude: true };
  const next = { ...current, devices };
  await write(c, shopId, next);
  return c.json({ settings: next });
});
