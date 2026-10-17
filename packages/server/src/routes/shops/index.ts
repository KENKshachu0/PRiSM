import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  buildPriorityTimePricingTimeline,
  buildTimeCapPricingTimeline,
  formatLocalDate,
  PrismDomainError,
  type PricingConfig,
} from "@prism/core";
import {
  toPricingConfig,
  type PricingConfigRow,
} from "@prism/storage-sql";
import { withOperationLease } from "@prism/application";
import type { AppBindings, TenantShop } from "../../bindings.js";
import { sha256 } from "../../crypto.js";
import { jsonError } from "../../http.js";
import { optionalUser, requireUser, staffPrincipal } from "../../middleware/auth.js";
import { getShop, getShopDeps, tenantMiddleware } from "../../middleware/tenant.js";
import { billingSetupStatements } from "../platform/shops.js";

import { playerRouter } from "./player.js";
import { staffRouter } from "./staff.js";
import { integrationRouter } from "./integration.js";
import { pricingRouter } from "./pricing.js";
import { assetsRouter, staffAssetsCompatRouter } from "./assets.js";
import { cashierRouter } from "./cashier.js";
import { staffBusinessRouter } from "./business.js";
import { staffPricingCompatRouter } from "./staff-compat.js";
import { redeemRouter, staffRedeemCompatRouter } from "./redeem.js";
import { billingCompatRouter } from "./billing-compat.js";
import { identityConversionRouter } from "./identity-conversion.js";
import { shopDataRouter } from "./data/index.js";
import { legacyStaffRouter } from "../../legacy/handlers/staff.js";
import { legacyIntegrationRouter } from "../../legacy/handlers/integration.js";
import { refreshActivityBill } from "../../durable-objects/live-activity-billing.js";
import { liveActivityConfig } from "../../durable-objects/live-activity-push.js";
import {
  extractSessionIds, playerIdsFromPayload, pushSessionEvent, sessionEventForPath,
} from "./live-activity-events.js";

export * from "./player.js";
export * from "./staff.js";
export * from "./integration.js";
export * from "./pricing.js";
export * from "./assets.js";
export * from "./cashier.js";
export * from "./redeem.js";
export * from "./binding.js";
export * from "./views.js";

export async function billingConfiguration(
  db: Context<AppBindings>["env"]["DB"],
  shopId: string,
  entryPricingIds: readonly string[],
) {
  const [currency, pricing] = await Promise.all([
    db
      .prepare(
        "SELECT 1 FROM asset_definitions WHERE shop_id = ? AND type = 'currency' AND status = 'active' LIMIT 1",
      )
      .bind(shopId)
      .first(),
    db
      .prepare(
        "SELECT id FROM pricing_configs WHERE shop_id = ? AND enabled = 1 AND status = 'active' AND kind != 'time.cap'",
      )
      .bind(shopId)
      .all<{ id: string }>(),
  ]);

  const validIds = new Set(pricing.results.map((row) => row.id));
  const invalidEntryPricingIds = entryPricingIds.filter((id) => !validIds.has(id));
  const balanceAssetsReady = !!currency;
  const entryPricingReady = entryPricingIds.length > 0 && invalidEntryPricingIds.length === 0;

  return {
    ready: balanceAssetsReady && entryPricingReady,
    balanceAssetsReady,
    entryPricingReady,
    invalidEntryPricingIds,
  };
}

export function publicSettings(shop: TenantShop) {
  let entryPricingIds: string[] = [];
  try {
    entryPricingIds = JSON.parse(shop.entry_pricing_ids_json) as string[];
  } catch {
    entryPricingIds = [];
  }
  return {
    billingEnabled: !!shop.billing_enabled,
    cashierEnabled: !!shop.cashier_enabled,
    autoRegister: !!shop.auto_register,
    identityBindingRequired: !!shop.identity_binding_required,
    locationEnabled: !!shop.machine_geo,
    checkinGeo: !!shop.checkin_geo,
    checkoutGeo: !!shop.checkout_geo,
    machineGeo: !!shop.machine_geo,
    entryPricingIds,
    botContact: shop.bot_contact,
  };
}

const settingsSchema = z.object({
  billingEnabled: z.boolean(),
  cashierEnabled: z.boolean().optional(),
  autoRegister: z.boolean(),
  identityBindingRequired: z.boolean().optional(),
  locationEnabled: z.boolean().optional(),
  checkinGeo: z.boolean().optional(),
  checkoutGeo: z.boolean().optional(),
  machineGeo: z.boolean().optional(),
  entryPricingIds: z.array(z.string().min(1)).max(30),
  botContact: z.string().trim().max(160),
});

export const shopRouter = new Hono<AppBindings>();

// Tenant resolution & dependency container injection
shopRouter.use("*", tenantMiddleware);

// Restore the pre-consolidation event bridge at the tenant boundary. All player,
// staff, cashier and integration mutations pass here, so new commands cannot silently
// forget to wake the Live Activity. Send APNs after the response is committed.
shopRouter.use("*", async (c, next) => {
  await next();
  if (!c.res.ok || !liveActivityConfig(c.env) || c.res.headers.get("x-prism-operation-replayed") === "true" ||
      c.req.method === "GET" || !c.req.path.startsWith("/api/v1/shops/")) return;
  const match = c.req.path.match(/^\/api\/v1\/shops\/[^/]+\/(player|staff|integration|cashier|assets|pricing)(?:\/(.*))?$/);
  if (!match) return;
  const [, channel, path = ""] = match;
  if (!channel || path.startsWith("live-activity/") || path.endsWith("/preview") ||
      path === "lookup" || /^players\/by-identity\/(resolve|wallet|assets|history)$/.test(path)) return;

  const work = (async () => {
    const responseBody = await c.res.clone().json().catch(() => null) as Record<string, unknown> | null;
    if (!responseBody) return;
    const payload = (responseBody.data && typeof responseBody.data === "object"
      ? responseBody.data : responseBody) as Record<string, unknown>;
    const event = sessionEventForPath(path);
    const playerIds = new Set(playerIdsFromPayload(payload));
    const explicitId = path.match(/^(?:players|profiles)\/([^/]+)\//)?.[1];
    if (explicitId && explicitId !== "by-identity") playerIds.add(decodeURIComponent(explicitId));

    const shop = getShop(c);
    // Shared discount/asset definitions can change every registered player's bill.
    if (payload.assetDefinition || payload.pricingEffect || payload.pricingConfig) {
      const affected = await c.env.DB.prepare(
        `SELECT DISTINCT a.player_id AS playerId FROM live_activity_tokens t
         JOIN shop_player_accounts a ON a.shop_id=t.shop_id AND a.user_id=t.user_id
         WHERE t.shop_id=? AND t.session_id IS NOT NULL`,
      ).bind(shop.id).all<{ playerId: string }>();
      for (const row of affected.results) playerIds.add(row.playerId);
    }
    if (channel === "player" && !playerIds.size) {
      const user = c.get("user");
      if (user) {
        const membership = await c.env.DB.prepare(
          "SELECT player_id AS playerId FROM shop_player_accounts WHERE shop_id=? AND user_id=?",
        ).bind(shop.id, user.id).first<{ playerId: string }>();
        if (membership) playerIds.add(membership.playerId);
      }
    }
    if (!playerIds.size) return;
    const sessionIds = event ? extractSessionIds(payload, event) : [];
    const initiatorClientId = c.req.header("x-prism-client-id") ?? null;
    await Promise.all([...playerIds].map(async (playerId) => {
      if (event && sessionIds.length) {
        await pushSessionEvent(c, { shopId: shop.id, playerId, sessionIds, event, initiatorClientId });
      } else {
        await refreshActivityBill(c.env, shop.id, playerId, false, true);
      }
    }));
  })().catch((error) => {
    console.error("Live Activity event dispatch failed", error);
  });
  try { c.executionCtx.waitUntil(work); }
  catch { void work; }
});


// Centralized error mapping for direct domain errors
shopRouter.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  if (err instanceof PrismDomainError) {
    const status =
      err.code === "CHECKOUT_NOT_FOUND" ||
      err.code === "SESSION_NOT_FOUND" ||
      err.code === "PLAYER_NOT_FOUND" ||
      err.code === "PLAYER_IDENTITY_NOT_FOUND" ||
      err.code === "PRICING_CONFIG_NOT_FOUND"
        ? 404
        : err.code === "INSUFFICIENT_BALANCE" ||
          err.code === "CHECKIN_CONSENT_REQUIRED"
        ? 409
        : 400;
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
        },
      },
      status as any,
    );
  }
  console.error("[shopRouter] unhandled error:", err);
  return c.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
      },
    },
    500,
  );
});

// Mount modular sub-routers
shopRouter.route("/player", playerRouter);
shopRouter.route("/staff", staffRouter);
shopRouter.route("/staff", staffBusinessRouter);
shopRouter.route("/staff", staffPricingCompatRouter);
shopRouter.route("/integration", integrationRouter);
shopRouter.route("/cashier", cashierRouter);
shopRouter.route("/pricing", pricingRouter);
shopRouter.route("/staff/pricing-configs", pricingRouter);
shopRouter.route("/assets", assetsRouter);
shopRouter.route("/staff", staffAssetsCompatRouter);
shopRouter.route("/redeem", redeemRouter);
shopRouter.route("/staff", staffRedeemCompatRouter);
shopRouter.route("/", billingCompatRouter);
shopRouter.route("/identity-conversion", identityConversionRouter);
shopRouter.route("/data", shopDataRouter);
// Keep the historical tenant-scoped staff administration and Bot commands.
// Root-level /api/v1/staff and /integration alone cannot replace these: their
// tenant selection is different and the shopCode is part of the public contract.
shopRouter.route("/staff", legacyStaffRouter);
shopRouter.route("/integration", legacyIntegrationRouter);

// Shop Overview, Entry Pricing and Today's Schedule
shopRouter.get("/", async (c) => {
  const shop = getShop(c);
  const user = optionalUser(c);

  const membership = user
    ? await c.env.DB.prepare(
        `SELECT player_id AS playerId, EXISTS(SELECT 1 FROM shop_platform_bindings b WHERE b.shop_id=a.shop_id AND b.user_id=a.user_id) AS identityBound
         FROM shop_player_accounts a WHERE shop_id=? AND user_id=?`,
      )
        .bind(shop.id, user.id)
        .first<{ playerId: string; identityBound: number }>()
    : null;

  const pricing = shop.billing_enabled
    ? await c.env.DB.prepare(
        "SELECT id,name,kind,enabled,status,provider_json,created_at,updated_at FROM pricing_configs WHERE shop_id=? AND enabled=1 AND status='active' AND (id IN (SELECT value FROM json_each(?)) OR kind='time.cap')",
      )
        .bind(shop.id, shop.entry_pricing_ids_json)
        .all<PricingConfigRow>()
    : { results: [] };

  const localDate =
    c.req.query("date") ?? formatLocalDate(new Date(), shop.time_zone);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(localDate) ||
    !Number.isFinite(Date.parse(localDate)) ||
    new Date(localDate).toISOString().slice(0, 10) !== localDate
  ) {
    jsonError(400, "日期无效", "INVALID_DATE");
  }

  let ids: string[] = [];
  try {
    ids = JSON.parse(shop.entry_pricing_ids_json) as string[];
  } catch {
    ids = [];
  }

  const configs = pricing.results
    .map(toPricingConfig)
    .filter(
      (row) =>
        row.kind !== "time.cap" ||
        ("includedPricingConfigIds" in row.provider &&
          row.provider.includedPricingConfigIds.some((id: string) =>
            ids.includes(id),
          )),
    );

  // Main's browser billing previews consume raw UTC pricing rules directly.
  if (c.req.query("pricing") === "raw") return c.json({
    entryPricing: configs,
    pricingSchedule: { localDate, timeZone: shop.time_zone, groups: [], clientCalculation: true },
    shop: { publicId: shop.public_id, name: shop.name, timeZone: shop.time_zone, heroUrl: shop.hero_url, ...publicSettings(shop) },
    membership: membership ? { ...membership, identityBound: !!membership.identityBound } : null,
  });

  const groups = configs.map((row) => {
    const config = {
      ...row,
      provider: {
        ...row.provider,
        timeZone:
          ("timeZone" in row.provider ? row.provider.timeZone : undefined) ??
          "UTC",
      },
    } as PricingConfig;

    if (config.kind === "charge.fixed") {
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        amount: config.provider.amount,
        segments: [],
      };
    }

    const timeline =
      config.kind === "time.cap"
        ? buildTimeCapPricingTimeline({
            localDate,
            config: config.provider,
            displayTimeZone: shop.time_zone,
          })
        : buildPriorityTimePricingTimeline({
            localDate,
            config: config.provider,
            displayTimeZone: shop.time_zone,
          });

    return { id: row.id, name: row.name, kind: row.kind, ...timeline };
  });

  return c.json({
    entryPricing: configs
      .map((row, index) => {
        const activeRuleIds = new Set(
          groups[index]!.segments
            .filter((segment) => !segment.isClosed)
            .map((segment) => segment.ruleId),
        );
        const dateTime = new Intl.DateTimeFormat("sv-SE", {
          timeZone: shop.time_zone,
          dateStyle: "short",
          timeStyle: "medium",
          hourCycle: "h23",
        });
        return {
          id: row.id,
          name: row.name,
          kind: row.kind,
          provider: {
            ...row.provider,
            rules: ("rules" in row.provider ? row.provider.rules : undefined)
              ?.filter(
                (rule: { id: string; status?: string }) =>
                  (rule.status ?? "active") === "active" &&
                  activeRuleIds.has(rule.id),
              )
              .sort(
                (a: { priority: number }, b: { priority: number }) =>
                  b.priority - a.priority,
              )
              .map((rule) => ({
                ...rule,
                ...(rule.dateTimeRange
                  ? {
                      displayDateTimeRange: {
                        start: dateTime.format(
                          new Date(rule.dateTimeRange.start),
                        ),
                        end: dateTime.format(new Date(rule.dateTimeRange.end)),
                      },
                    }
                  : {}),
              })),
          },
        };
      })
      .filter(
        (plan) => plan.kind === "charge.fixed" || plan.provider.rules?.length,
      ),
    pricingSchedule: {
      localDate,
      timeZone: shop.time_zone,
      groups,
    },
    shop: {
      publicId: shop.public_id,
      name: shop.name,
      timeZone: shop.time_zone,
      heroUrl: shop.hero_url,
      ...publicSettings(shop),
    },
    membership: membership
      ? { ...membership, identityBound: !!membership.identityBound }
      : null,
  });
});

// Shop cover image: preserve immutable versioned URLs and conditional caching.
shopRouter.get("/hero", async (c) => {
  const shop = getShop(c);
  const row = await c.env.DB.prepare(
    "SELECT hero_data AS heroData, COALESCE(hero_hash,'original') AS version FROM shops WHERE id=?",
  ).bind(shop.id).first<{ heroData: string | null; version: string }>();
  const version = c.req.query("v");
  const missing = () => new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  if (!row || (version !== undefined && row.version !== version)) return missing();
  const match = row.heroData?.match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || !match[1] || !match[2]) return missing();
  const headers = {
    "cache-control": version ? "public, max-age=31536000, immutable" : "public, max-age=60, must-revalidate",
    "content-type": match[1],
    etag: `"${row.version}"`,
  };
  const validators = c.req.header("if-none-match")?.split(",").map(v => v.trim().replace(/^W\//, ""));
  if (validators?.some(v => v === "*" || v === headers.etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(Uint8Array.from(atob(match[2]), ch => ch.charCodeAt(0)), { headers });
});

// Shop Settings
shopRouter.get("/settings", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  let entryPricingIds: string[] = [];
  try {
    entryPricingIds = JSON.parse(shop.entry_pricing_ids_json) as string[];
  } catch {
    entryPricingIds = [];
  }
  return c.json({
    ...publicSettings(shop),
    billingConfiguration: await billingConfiguration(
      c.env.DB,
      shop.id,
      entryPricingIds,
    ),
  });
});

// Update Shop Settings
shopRouter.put("/settings", async (c) => {
  const initialShop = getShop(c);
  const principal = await staffPrincipal(c, initialShop);
  if (principal.staffRole !== "owner") {
    jsonError(403, "只有店铺负责人可以修改平台设置");
  }

  const deps = getShopDeps(c);
  return withOperationLease(
    {
      repository: deps.repositories.operationLocks,
      scope: "shop.cashier",
      resourceId: initialShop.id,
      now: () => new Date(),
    },
    async () => {
      const body = settingsSchema.parse(await c.req.json());
      // The unified toggle wins over aliases included in a read/merge/write request.
      const checkinGeo = body.locationEnabled ?? body.checkinGeo ?? !!initialShop.checkin_geo;
      const checkoutGeo = body.locationEnabled ?? body.checkoutGeo ?? !!initialShop.checkout_geo;
      const machineGeo = body.locationEnabled ?? body.machineGeo ?? !!initialShop.machine_geo;
      const cashierEnabled = body.cashierEnabled ?? !!initialShop.cashier_enabled;
      const identityBindingRequired = body.identityBindingRequired ?? !!initialShop.identity_binding_required;

      if (cashierEnabled && !body.billingEnabled) {
        jsonError(409, "请先启用入场计费", "BILLING_DISABLED");
      }

      if (initialShop.cashier_enabled && !cashierEnabled) {
        const unpaid = await c.env.DB.prepare(`SELECT 1 FROM sessions s JOIN cashier_profiles cp
          ON cp.shop_id=s.shop_id AND cp.player_id=s.player_id
          WHERE s.shop_id=? AND s.payment_status='unpaid' LIMIT 1`)
          .bind(initialShop.id).first();
        if (unpaid) jsonError(409, "存在未结清的前台账单，请先收款结账", "CASHIER_UNSETTLED_SESSIONS");
      }

      const configuration = await billingConfiguration(c.env.DB, initialShop.id, body.entryPricingIds);
      const billingChanged = !initialShop.billing_enabled ||
        (!initialShop.cashier_enabled && cashierEnabled) ||
        JSON.stringify(body.entryPricingIds) !== JSON.stringify(publicSettings(initialShop).entryPricingIds);
      // Existing invalid pricing must not prevent editing unrelated settings.
      if (body.billingEnabled && billingChanged && !configuration.ready) {
        jsonError(
          409,
          !configuration.balanceAssetsReady
            ? "请先配置有效的余额资产"
            : !body.entryPricingIds.length
            ? "请选择至少一个入场计费规则"
            : "选中的入场规则已停用、归档或不可用于入场，请重新选择",
          "BILLING_CONFIGURATION_REQUIRED",
          configuration,
        );
      }

      if (initialShop.billing_enabled && !body.billingEnabled) {
        const unpaid = await c.env.DB.prepare(
          "SELECT 1 FROM sessions WHERE shop_id=? AND payment_status='unpaid' LIMIT 1",
        ).bind(initialShop.id).first();
        if (unpaid) jsonError(409, "存在未结消费，不能停用计费", "UNSETTLED_SESSIONS");
      }

      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO shop_billing_settings (shop_id, billing_enabled, auto_register, checkin_geo, checkout_geo, machine_geo, entry_pricing_ids_json, bot_contact, identity_binding_required)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(shop_id) DO UPDATE SET
             billing_enabled=excluded.billing_enabled, auto_register=excluded.auto_register,
             checkin_geo=excluded.checkin_geo, checkout_geo=excluded.checkout_geo, machine_geo=excluded.machine_geo,
             entry_pricing_ids_json=excluded.entry_pricing_ids_json, bot_contact=excluded.bot_contact,
             identity_binding_required=excluded.identity_binding_required`,
        ).bind(
          initialShop.id,
          +body.billingEnabled,
          +body.autoRegister,
          +checkinGeo,
          +checkoutGeo,
          +machineGeo,
          JSON.stringify(body.entryPricingIds),
          body.botContact,
          +identityBindingRequired,
        ),
        c.env.DB.prepare(
          `INSERT INTO app_settings(shop_id, key, value_json, updated_at)
           VALUES (?, 'cashier.settings', ?, ?)
           ON CONFLICT(shop_id, key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
        ).bind(
          initialShop.id,
          JSON.stringify({ enabled: cashierEnabled }),
          new Date().toISOString(),
        ),
      ]);

      return c.json({
        ...body,
        locationEnabled: checkinGeo || checkoutGeo || machineGeo,
        checkinGeo,
        checkoutGeo,
        machineGeo,
        cashierEnabled,
        identityBindingRequired,
        billingConfiguration: configuration,
      });
    },
  );
});

// Platform Binding Code
shopRouter.post("/platform-binding", async (c) => {
  const user = requireUser(c);
  const shop = getShop(c);
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const code = Array.from(
    crypto.getRandomValues(new Uint8Array(8)),
    (b) => alphabet[b % 32],
  ).join("");
  const expiresAt = new Date(Date.now() + 300000).toISOString();

  await c.env.DB.prepare(
    `INSERT INTO platform_binding_codes (shop_id, user_id, code_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(shop_id, user_id) DO UPDATE SET
       code_hash=excluded.code_hash, expires_at=excluded.expires_at, created_at=excluded.created_at`,
  )
    .bind(
      shop.id,
      user.id,
      await sha256(code),
      expiresAt,
      new Date().toISOString(),
    )
    .run();

  return c.json({ code, expiresAt, botContact: shop.bot_contact });
});

// List Platform Bindings
shopRouter.get("/platform-binding", async (c) => {
  const user = requireUser(c);
  const shop = getShop(c);
  const bindings = await c.env.DB.prepare(
    `SELECT a.player_id AS playerId, b.provider, b.subject, b.verified_at AS verifiedAt
     FROM shop_platform_bindings b
     JOIN shop_player_accounts a ON a.shop_id=b.shop_id AND a.user_id=b.user_id
     WHERE b.shop_id=? AND b.user_id=? ORDER BY b.provider`,
  )
    .bind(shop.id, user.id)
    .all();

  return c.json({ bindings: bindings.results });
});
