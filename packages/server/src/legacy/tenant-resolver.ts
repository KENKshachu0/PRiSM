import type { Context, MiddlewareHandler } from "hono";
import type { D1DatabaseLike } from "@prism/adapter-d1";
import type { AppBindings, TenantShop } from "../bindings.js";
import { jsonError } from "../http.js";
import { getOrCreateShopDependencies } from "../middleware/tenant.js";

/**
 * Normalizes shop record by ensuring numerical boolean representation for geo flags.
 */
export function normalizeShop(shopRow: TenantShop): TenantShop {
  return {
    ...shopRow,
    // Keep the three independent geofence settings; the aggregate is UI-only.
    checkin_geo: +!!shopRow.checkin_geo,
    checkout_geo: +!!shopRow.checkout_geo,
    machine_geo: +!!shopRow.machine_geo,
  };
}

const SHOP_QUERY = `SELECT s.id, s.public_id, s.name, s.latitude, s.longitude, s.radius_meters,
  COALESCE(b.auto_register, 0) AS auto_register,
  COALESCE(b.identity_binding_required, 1) AS identity_binding_required,
  COALESCE((SELECT json_extract(value_json, '$.enabled') FROM app_settings WHERE shop_id = s.id AND key = 'cashier.settings'), 0) AS cashier_enabled,
  COALESCE(b.checkin_geo, 0) AS checkin_geo,
  COALESCE(b.checkout_geo, 0) AS checkout_geo,
  COALESCE(b.machine_geo, 0) AS machine_geo,
  COALESCE(b.bot_contact, '') AS bot_contact,
  CASE WHEN s.hero_data IS NULL OR s.hero_data = '' THEN NULL ELSE '/api/v1/shops/' || s.public_id || '/hero?v=' || COALESCE(s.hero_hash, 'original') END AS hero_url,
  COALESCE((SELECT json_extract(value_json, '$.timeZone') FROM app_settings WHERE shop_id = s.id AND key = 'store.profile'), 'Asia/Shanghai') AS time_zone
FROM shops s
LEFT JOIN shop_billing_settings b ON b.shop_id = s.id`;

async function queryShop(db: D1DatabaseLike, code: string): Promise<TenantShop | null> {
  return await db
    .prepare(`${SHOP_QUERY} WHERE s.public_id = ? OR s.id = ?`)
    .bind(code, code)
    .first<TenantShop>();
}

/** Resolve an explicit shop for authenticated cross-shop management endpoints. */
export async function findLegacyShopByCode(db: D1DatabaseLike, code: string): Promise<TenantShop | null> {
  const shop = await queryShop(db, code);
  return shop ? normalizeShop(shop) : null;
}

/**
 * Resolves the target tenant shop for legacy single-store requests:
 * 1. Checks explicit client headers (`X-PRiSM-Shop-Code`, `X-PRiSM-Shop`, `X-Shop-Id`) or `?shopCode=...` query
 *    (returns null if not found to prevent silent cross-tenant fallback)
 * 2. Checks environment variables (`DEFAULT_SHOP_CODE`, `DEFAULT_FALLBACK_SHOP`)
 * 3. Fallback: queries the database for 'default' shop or the first active/created shop.
 */
export async function resolveLegacyShop(
  c: Context<AppBindings>,
): Promise<TenantShop | null> {
  // 1. Explicit caller override
  const explicitShopCode =
    c.req.header("X-PRiSM-Shop-Code")?.trim() ||
    c.req.header("X-PRiSM-Shop")?.trim() ||
    c.req.header("X-Shop-Id")?.trim() ||
    c.req.query("shopCode")?.trim();

  if (explicitShopCode) {
    const shopRow = await queryShop(c.env.DB, explicitShopCode);
    return shopRow ? normalizeShop(shopRow) : null;
  }

  // 2. Environment variable configuration
  const envShopCode =
    (c.env as any)?.DEFAULT_SHOP_CODE ||
    (c.env as any)?.DEFAULT_FALLBACK_SHOP ||
    (typeof process !== "undefined"
      ? process.env?.DEFAULT_SHOP_CODE || process.env?.DEFAULT_FALLBACK_SHOP
      : undefined);

  if (envShopCode) {
    const shopRow = await queryShop(c.env.DB, envShopCode);
    if (shopRow) {
      return normalizeShop(shopRow);
    }
  }

  // 3. Fallback to default or first shop in the database
  const fallbackRow = await c.env.DB.prepare(
    `${SHOP_QUERY}
    ORDER BY CASE WHEN s.public_id = 'default' OR s.id = 'default' THEN 0 ELSE 1 END, s.created_at ASC
    LIMIT 1`,
  )
    .bind()
    .first<TenantShop>();

  return fallbackRow ? normalizeShop(fallbackRow) : null;
}

/**
 * Middleware that resolves tenant context for legacy single-store endpoints and injects dependencies.
 */
export const legacyTenantMiddleware: MiddlewareHandler<AppBindings> = async (
  c,
  next,
) => {
  const isLegacyPath =
    /^\/(?:api\/v1\/)?(?:player|staff|integration|setup|admin|player-auth|bot)\b/.test(c.req.path) ||
    c.req.path.startsWith("/rpc");
  if (!isLegacyPath) {
    await next();
    return;
  }

  const shop = await resolveLegacyShop(c);

  if (!shop) {
    // Setup routes may run before any shop exists in the database
    if (c.req.path.includes("/setup")) {
      await next();
      return;
    }
    jsonError(404, "未找到目标店铺，请指定店铺代码或先创建店铺", "SHOP_NOT_FOUND");
  }

  c.set("shop", shop);
  c.set("responseTimeZone", shop.time_zone);

  const deps = getOrCreateShopDependencies(c.env.DB, shop, c.env.URL_ENCRYPTION_KEY);
  c.set("deps", deps);

  await next();
};
