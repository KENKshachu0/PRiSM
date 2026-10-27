import { Hono } from "hono";
import type { AppBindings, TenantShop } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { sha256Hex } from "../../crypto.js";
import { getOrCreateShopDependencies } from "../../middleware/tenant.js";

export const legacySetupRouter = new Hono<AppBindings>();

// GET /api/v1/setup/status
legacySetupRouter.get("/status", async (c) => {
  const shop = c.get("shop");
  if (!shop) {
    return c.json({ installed: false });
  }

  const deps = c.get("deps");
  if (!deps?.setupCommands) {
    return c.json({ installed: false });
  }

  const status = await deps.setupCommands.getSetupStatus();
  return c.json(status);
});

// POST /api/v1/setup/install
legacySetupRouter.post("/install", async (c) => {
  const expectedHash = c.env.PRISM_BOOTSTRAP_TOKEN_HASH;
  if (!expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash))
    jsonError(503, "首次安装凭据未配置", "BOOTSTRAP_NOT_CONFIGURED");
  const supplied = c.req.header("X-PRiSM-Bootstrap-Token");
  if (!supplied || (await sha256Hex(supplied)) !== expectedHash.toLowerCase())
    jsonError(403, "首次安装凭据无效", "BOOTSTRAP_FORBIDDEN");
  let shop = c.get("shop");
  let deps = c.get("deps");
  const body = await c.req.json<any>();

  if (!shop) {
    // If running in fresh database without shops, create initial default shop
    const shopId = crypto.randomUUID();
    const publicId = "default";
    const now = new Date().toISOString();

    // The bootstrap creator must exist before a shop can reference it.
    // This is not a login identity and cannot authenticate as a platform user.
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO users(id,role,created_at,updated_at) VALUES ('system','user',?,?) ON CONFLICT(id) DO NOTHING",
      ).bind(now,now),
      c.env.DB.prepare(
        `INSERT INTO shops (id, public_id, name, latitude, longitude, radius_meters, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 0, 0, 80, 'system', ?, ?)`,
      ).bind(shopId, publicId, body.storeName || "Default Shop", now, now),
    ]);

    const createdShop: TenantShop = {
      id: shopId,
      public_id: publicId,
      name: body.storeName || "Default Shop",
      latitude: 0,
      longitude: 0,
      radius_meters: 80,
      auto_register: 0,
      identity_binding_required: 1,
      cashier_enabled: 0,
      checkin_geo: 0,
      checkout_geo: 0,
      machine_geo: 0,
      bot_contact: "",
      hero_url: null,
      time_zone: body.timeZone || "Asia/Shanghai",
    };

    shop = createdShop;
    c.set("shop", shop);
    deps = getOrCreateShopDependencies(c.env.DB, shop, c.env.URL_ENCRYPTION_KEY);
    c.set("deps", deps);
  }

  if (!deps?.setupCommands) {
    jsonError(503, "Setup commands are not configured.", "SETUP_NOT_CONFIGURED");
  }

  const result = await deps.setupCommands.install(body);
  return c.json({
    staff: {
      id: result.staffUser.id,
      username: result.staffUser.username,
      displayName: result.staffUser.displayName,
      role: result.staffUser.role,
    },
    apiTokens: result.apiTokens,
  });
});
