import { mahjongRoster } from "./mahjong";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { createD1Repositories } from "@prism/adapter-d1";
import { createPrismWorkerDependencies } from "@prism/runtime";
import {
  createPrismApp,
  type PrismAppDependencies,
  type Principal,
} from "@prism/server-hono";
import {
  buildPriorityTimePricingTimeline,
  buildTimeCapPricingTimeline,
  formatLocalDate,
  type DeviceCommandType,
  type Session,
  type PricingConfig,
} from "@prism/core";
import { resolveMachineSession } from "./machine-session";
import { withOperationLease } from "@prism/application";
import { runPlayerOperation } from "./operations";
import { requireUser } from "./auth";
import { sha256 } from "./crypto";
import { checkLocation } from "./geo";
import { jsonError } from "./http";
import { enforceRateLimits } from "./risk";
import type { AppBindings } from "./types";

type C = Context<AppBindings>;
export type BillingShop = {
  id: string;
  public_id: string;
  name: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
  billing_enabled: number;
  auto_register: number;
  checkin_geo: number;
  checkout_geo: number;
  machine_geo: number;
  entry_pricing_ids_json: string;
  bot_contact: string;
  time_zone: string;
};
const settingsSchema = z.object({
  billingEnabled: z.boolean(),
  autoRegister: z.boolean(),
  locationEnabled: z.boolean().optional(),
  checkinGeo: z.boolean().optional(),
  checkoutGeo: z.boolean().optional(),
  machineGeo: z.boolean().optional(),
  entryPricingIds: z.array(z.string().min(1)).max(30),
  botContact: z.string().trim().max(160),
}).refine((value) => value.locationEnabled !== undefined ||
  [value.checkinGeo, value.checkoutGeo, value.machineGeo].every((flag) => flag !== undefined),
  "locationEnabled is required").transform((value) => {
  const enabled = value.locationEnabled ?? !!(value.checkinGeo || value.checkoutGeo || value.machineGeo);
  return { ...value, locationEnabled: enabled, checkinGeo: enabled, checkoutGeo: enabled, machineGeo: enabled };
});
const coordinates = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  accuracy: z.number().finite().min(0).max(10000),
});

export async function getBillingShop(c: C, code: string): Promise<BillingShop> {
  const shop = await c.env.DB.prepare(
    `SELECT s.id, s.public_id, s.name, s.latitude, s.longitude, s.radius_meters,
    COALESCE(b.billing_enabled,0) AS billing_enabled, COALESCE(b.auto_register,0) AS auto_register,
    COALESCE(b.checkin_geo,0) AS checkin_geo, COALESCE(b.checkout_geo,0) AS checkout_geo,
    COALESCE(b.machine_geo,0) AS machine_geo, COALESCE(b.entry_pricing_ids_json,'[]') AS entry_pricing_ids_json,
    COALESCE(b.bot_contact,'') AS bot_contact,
    COALESCE((SELECT json_extract(value_json,'$.timeZone') FROM app_settings WHERE shop_id=s.id AND key='store.profile'),'Asia/Shanghai') AS time_zone FROM shops s LEFT JOIN shop_billing_settings b ON b.shop_id=s.id WHERE s.public_id=?`,
  )
    .bind(code)
    .first<BillingShop>();
  if (!shop) jsonError(404, "没有找到这个店铺", "SHOP_NOT_FOUND");
  // Preserve older clients while enforcing one location policy for every player action.
  const enabled = +(!!(shop.checkin_geo || shop.checkout_geo || shop.machine_geo));
  return { ...shop, checkin_geo: enabled, checkout_geo: enabled, machine_geo: enabled };
}

export function checkShopLocation(
  shop: BillingShop,
  action: "checkin" | "checkout" | "machine",
  location: unknown,
): void {
  if (!(shop.checkin_geo || shop.checkout_geo || shop.machine_geo)) return;
  const result = coordinates.safeParse(location);
  if (!result.success)
    jsonError(403, "此操作需要获取当前位置", "LOCATION_REQUIRED");
  const check = checkLocation({
    userLat: result.data.lat,
    userLng: result.data.lng,
    accuracy: result.data.accuracy,
    shopLat: shop.latitude,
    shopLng: shop.longitude,
    radiusMeters: shop.radius_meters,
  });
  if (check.reason === "low_accuracy")
    jsonError(403, "定位精度不足，请重试", "LOCATION_LOW_ACCURACY");
  if (action === "checkout") {
    if (check.allowed)
      jsonError(403, "请离开店铺定位范围后再结账", "LOCATION_STILL_INSIDE");
  } else if (!check.allowed) {
    jsonError(403, "请到店后再操作", "LOCATION_OUT_OF_RANGE");
  }
}

export async function requireShopPlayer(
  c: C,
  shop: BillingShop,
  deviceOnly = false,
) {
  const user = requireUser(c);
  if (!shop.billing_enabled && !deviceOnly)
    jsonError(409, "店铺未启用计费", "BILLING_DISABLED");
  const player = await c.env.DB.prepare(
    `SELECT p.id, p.status, a.qq FROM shop_player_accounts a
    JOIN players p ON p.shop_id=a.shop_id AND p.id=a.player_id WHERE a.shop_id=? AND a.user_id=?`,
  )
    .bind(shop.id, user.id)
    .first<{ id: string; status: string; qq: string }>();
  if (!player) jsonError(403, "请先绑定 QQ", "QQ_BINDING_REQUIRED");
  if (player.status !== "active")
    jsonError(403, "店铺玩家资格已停用", "PLAYER_DISABLED");
  return player;
}

export function isEntry(session: Session, shop: BillingShop): boolean {
  if (session.metadata?.mahjongDeviceId) return false;
  if (session.label === "entry" || session.metadata?.entry === true)
    return true;
  const rules = JSON.parse(shop.entry_pricing_ids_json) as string[];
  // Imported Bot sessions retain their labels and billing history.
  return (
    rules.length > 0 &&
    session.pricingConfigIds?.length === rules.length &&
    rules.every((id) => session.pricingConfigIds!.includes(id))
  );
}

export async function requireActiveEntry(
  c: C,
  shop: BillingShop,
): Promise<string> {
  const player = await requireShopPlayer(c, shop);
  const repos = createD1Repositories({
    db: c.env.DB,
    shopId: shop.id,
    id: crypto.randomUUID,
    now: () => new Date(),
  });
  const row = (await repos.sessions.findActiveByPlayerId(player.id)).find(
    (session) => isEntry(session, shop),
  );
  if (!row) jsonError(403, "请先确认入场", "CHECKIN_REQUIRED");
  return player.id;
}

function publicSettings(shop: BillingShop) {
  return {
    billingEnabled: !!shop.billing_enabled,
    autoRegister: !!shop.auto_register,
    locationEnabled: !!shop.machine_geo,
    checkinGeo: !!shop.checkin_geo,
    checkoutGeo: !!shop.checkout_geo,
    machineGeo: !!shop.machine_geo,
    entryPricingIds: JSON.parse(shop.entry_pricing_ids_json) as string[],
    botContact: shop.bot_contact,
  };
}

export async function staffPrincipal(
  c: C,
  shop: BillingShop,
): Promise<Extract<Principal, { role: "staff" }>> {
  const user = requireUser(c);
  const mapping = await c.env.DB.prepare(
    `SELECT s.id,s.role,s.status FROM shop_staff_accounts a
    JOIN staff_users s ON s.shop_id=a.shop_id AND s.id=a.staff_id WHERE a.shop_id=? AND a.user_id=?`,
  )
    .bind(shop.id, user.id)
    .first<{
      id: string;
      role: "owner" | "manager" | "viewer";
      status: string;
    }>();
  const member = await c.env.DB.prepare(
    "SELECT role FROM shop_members WHERE shop_id=? AND user_id=?",
  )
    .bind(shop.id, user.id)
    .first<{ role: string }>();
  if (!member && user.role !== "admin")
    jsonError(403, "没有店铺账务管理权限", "FORBIDDEN");
  if (mapping?.status === "active")
    return { role: "staff", staffId: mapping.id, staffRole: mapping.role };
  if (member?.role !== "owner" && user.role !== "admin")
    jsonError(403, "没有店铺账务管理权限", "FORBIDDEN");
  const staffId = `account:${user.id}`;
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO staff_users (shop_id,id,username,display_name,password_hash,password_salt,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'owner','active',?,?) ON CONFLICT(shop_id,id) DO NOTHING",
    ).bind(
      shop.id,
      staffId,
      `account:${user.id}`,
      user.displayName,
      crypto.randomUUID(),
      crypto.randomUUID(),
      new Date().toISOString(),
      new Date().toISOString(),
    ),
    c.env.DB.prepare(
      "INSERT INTO shop_staff_accounts (shop_id,user_id,staff_id) VALUES (?,?,?) ON CONFLICT(shop_id,user_id) DO NOTHING",
    ).bind(shop.id, user.id, staffId),
  ]);
  return { role: "staff", staffId, staffRole: "owner" };
}

export function dependencies(c: C, shop: BillingShop): PrismAppDependencies {
  const logicalDeviceResolver = async (ref: string, actionType?: DeviceCommandType) =>
    (await import("./devices")).resolveLogicalDevice(c, shop.id, ref, actionType);
  const deps = createPrismWorkerDependencies(
    { DB: c.env.DB },
    { shopId: shop.id, logicalDeviceResolver } as any,
  );
  const repos = createD1Repositories({
    db: c.env.DB,
    shopId: shop.id,
    id: crypto.randomUUID,
    now: () => new Date(),
  });
  const start = deps.playerCommands.startSession;
  const startEntry: typeof start = (input) =>
    withOperationLease(
      {
        repository: repos.operationLocks,
        scope: "player.entry",
        resourceId: input.playerId,
        now: () => new Date(),
      },
      async () => {
        const active = (
          await repos.sessions.findActiveByPlayerId(input.playerId)
        ).find((session) => isEntry(session, shop));
        if (active) return { ...active, status: "active" as const };
        return start({
          ...input,
          pricingConfigIds: JSON.parse(shop.entry_pricing_ids_json),
          label: "entry",
        });
      },
    );
  deps.playerCommands = { ...deps.playerCommands, startSession: startEntry };
  const integration = deps.integrationCommands;
  if (integration)
    deps.integrationCommands = {
      ...integration,
      startSessionByIdentity: async (input) => {
        const rules = JSON.parse(shop.entry_pricing_ids_json) as string[];
        // Explicit specialist rules (e.g. Mahjong) retain their existing Bot flow.
        if (input.pricingConfigIds?.some((id) => !rules.includes(id)))
          return integration.startSessionByIdentity(input);
        const player = await integration.resolveOrRegisterPlayerByIdentity({
          ...input,
          autoRegister: !!shop.auto_register,
        });
        // Keep the audit trail consistent with the specialist branch below: every Bot
        // entry session should record that a Bot opened it. Authorisation is scoped by
        // player, never by this marker.
        return startEntry({
          ...input,
          playerId: player.id,
          metadata: { createdBy: "integration" },
        });
      },
    };
  const checkout = deps.playerCheckoutCommands;
  if (checkout)
    deps.playerCheckoutCommands = {
      ...checkout,
      checkout: (input) =>
        checkout.checkout({ ...input, closeSessionsBeforeBalanceCheck: false }),
    };
  return deps;
}

async function forward(
  c: C,
  deps: PrismAppDependencies,
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = new URL(c.req.url);
  url.pathname = `/api/v1/${path}`;
  const headers = new Headers(c.req.raw.headers);
  headers.delete("content-length");
  const request =
    body === undefined
      ? new Request(url, c.req.raw)
      : new Request(url, {
          method: c.req.method,
          headers,
          body: JSON.stringify(body),
        });
  const response = await createPrismApp(deps).fetch(request);
  const payload = (await response.json()) as {
    data?: unknown;
    error?: unknown;
  };
  return c.json(response.ok ? payload.data : payload, response.status as 200);
}

export function registerBillingRoutes(app: Hono<AppBindings>) {
  app.get("/api/v1/shops/:shopCode/operations/:operationId", async (c) => {
    const user = requireUser(c);
    const shop = await getBillingShop(c, c.req.param("shopCode"));
    const operation = await c.env.DB.prepare(
      "SELECT id,kind,status,result_json,created_at AS createdAt FROM player_operations WHERE shop_id=? AND user_id=? AND id=?",
    )
      .bind(shop.id, user.id, c.req.param("operationId"))
      .first();
    if (!operation) jsonError(404, "没有找到这个操作", "OPERATION_NOT_FOUND");
    return c.json({ operation });
  });
  app.get("/api/v1/shops/:shopCode/billing-members", async (c) => {
    const shop = await getBillingShop(c, c.req.param("shopCode"));
    const principal = await staffPrincipal(c, shop);
    if (principal.staffRole !== "owner") jsonError(403, "此操作需要店主权限");
    const members = await c.env.DB.prepare(
      `SELECT m.user_id AS userId,i.display_name AS name,m.role AS shopRole,
      CASE WHEN s.status='active' THEN s.role ELSE 'none' END AS billingRole
      FROM shop_members m LEFT JOIN auth_identities i ON i.user_id=m.user_id AND i.provider='munet'
      LEFT JOIN shop_staff_accounts a ON a.shop_id=m.shop_id AND a.user_id=m.user_id
      LEFT JOIN staff_users s ON s.shop_id=a.shop_id AND s.id=a.staff_id WHERE m.shop_id=?`,
    )
      .bind(shop.id)
      .all();
    return c.json({ members: members.results });
  });
  app.put("/api/v1/shops/:shopCode/billing-members/:userId", async (c) => {
    const shop = await getBillingShop(c, c.req.param("shopCode"));
    const principal = await staffPrincipal(c, shop);
    if (principal.staffRole !== "owner") jsonError(403, "此操作需要店主权限");
    const userId = c.req.param("userId");
    const body = z
      .object({ role: z.enum(["manager", "viewer", "none"]) })
      .parse(await c.req.json());
    const member = await c.env.DB.prepare(
      "SELECT role FROM shop_members WHERE shop_id=? AND user_id=?",
    )
      .bind(shop.id, userId)
      .first<{ role: string }>();
    if (!member) jsonError(404, "请先把账号添加为店铺成员");
    if (member.role === "owner") jsonError(409, "店主的账务权限由店铺身份决定");
    const existing = await c.env.DB.prepare(
      "SELECT staff_id FROM shop_staff_accounts WHERE shop_id=? AND user_id=?",
    )
      .bind(shop.id, userId)
      .first<{ staff_id: string }>();
    const staffId = existing?.staff_id ?? `account:${userId}`;
    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO staff_users(shop_id,id,username,display_name,password_hash,password_salt,role,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(shop_id,id) DO UPDATE SET role=excluded.role,status=excluded.status,updated_at=excluded.updated_at`,
      ).bind(
        shop.id,
        staffId,
        `account:${userId}`,
        userId,
        crypto.randomUUID(),
        crypto.randomUUID(),
        body.role === "none" ? "viewer" : body.role,
        body.role === "none" ? "disabled" : "active",
        now,
        now,
      ),
      c.env.DB.prepare(
        "INSERT INTO shop_staff_accounts(shop_id,user_id,staff_id) VALUES (?,?,?) ON CONFLICT(shop_id,user_id) DO NOTHING",
      ).bind(shop.id, userId, staffId),
    ]);
    return c.json({ role: body.role });
  });
  app.get("/api/v1/me/shops", async (c) => {
    const user = requireUser(c);
    const shops = await c.env.DB.prepare(
      `SELECT s.public_id AS publicId,s.name,COUNT(active.id) AS activeSessions
      FROM shop_player_accounts a JOIN shops s ON s.id=a.shop_id
      LEFT JOIN sessions active ON active.shop_id=a.shop_id AND active.player_id=a.player_id AND active.status='active'
      WHERE a.user_id=? GROUP BY s.id ORDER BY activeSessions DESC,s.name`,
    )
      .bind(user.id)
      .all();
    return c.json({ shops: shops.results });
  });
  app.get("/api/v1/shops/:shopCode", async (c) => {
    const shop = await getBillingShop(c, c.req.param("shopCode"));
    const user = c.get("user");
    const membership = user
      ? await c.env.DB.prepare(
          "SELECT player_id AS playerId FROM shop_player_accounts WHERE shop_id=? AND user_id=?",
        )
          .bind(shop.id, user.id)
          .first()
      : null;
    const pricing = shop.billing_enabled
      ? await c.env.DB.prepare(
          "SELECT id,name,kind,provider_json FROM pricing_configs WHERE shop_id=? AND enabled=1 AND status='active' AND (id IN (SELECT value FROM json_each(?)) OR kind='time.cap')",
        )
          .bind(shop.id, shop.entry_pricing_ids_json)
          .all<{
            id: string;
            name: string;
            kind: string;
            provider_json: string;
          }>()
      : { results: [] };
    const localDate =
      c.req.query("date") ?? formatLocalDate(new Date(), shop.time_zone);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(localDate) ||
      !Number.isFinite(Date.parse(localDate)) ||
      new Date(localDate).toISOString().slice(0, 10) !== localDate
    )
      jsonError(400, "日期无效", "INVALID_DATE");
    const ids = JSON.parse(shop.entry_pricing_ids_json) as string[];
    const configs = pricing.results
      .map(({ provider_json, ...row }) => ({
        ...row,
        provider: JSON.parse(provider_json),
      }))
      .filter(
        (row) =>
          row.kind !== "time.cap" ||
          row.provider.includedPricingConfigIds.some((id: string) =>
            ids.includes(id),
          ),
      );
    const groups = configs.map((row) => {
      const config = {
        ...row,
        provider: {
          ...row.provider,
          timeZone: row.provider.timeZone ?? shop.time_zone,
          rules: row.provider.rules?.map(
            (rule: { dateTimeRange?: { start: string; end: string } }) => ({
              ...rule,
              ...(rule.dateTimeRange
                ? {
                    dateTimeRange: {
                      start: new Date(rule.dateTimeRange.start),
                      end: new Date(rule.dateTimeRange.end),
                    },
                  }
                : {}),
            }),
          ),
        },
      } as PricingConfig;
      if (config.kind === "charge.fixed")
        return {
          id: row.id,
          name: row.name,
          kind: row.kind,
          amount: config.provider.amount,
          segments: [],
        };
      const timeline =
        config.kind === "time.cap"
          ? buildTimeCapPricingTimeline({
              localDate,
              config: config.provider,
            })
          : buildPriorityTimePricingTimeline({
              localDate,
              config: config.provider,
            });
      return { id: row.id, name: row.name, kind: row.kind, ...timeline };
    });
    return c.json({
      entryPricing: configs.map((row, index) => {
        const activeRuleIds = new Set(
          groups[index]!.segments
            .filter((segment) => !segment.isClosed)
            .map((segment) => segment.ruleId),
        );
        const dateTime = new Intl.DateTimeFormat("sv-SE", {
          timeZone: row.provider.timeZone ?? shop.time_zone,
          dateStyle: "short",
          timeStyle: "medium",
          hourCycle: "h23",
        });
        return {
          ...row,
          provider: {
            ...row.provider,
            rules: row.provider.rules
              ?.filter(
                (rule: { id: string; status?: string }) =>
                  (rule.status ?? "active") === "active" &&
                  activeRuleIds.has(rule.id),
              )
              .sort(
                (a: { priority: number }, b: { priority: number }) =>
                  b.priority - a.priority,
              )
              .map(
                (rule: { dateTimeRange?: { start: string; end: string } }) => ({
                  ...rule,
                  ...(rule.dateTimeRange
                    ? {
                        displayDateTimeRange: {
                          start: dateTime.format(
                            new Date(rule.dateTimeRange.start),
                          ),
                          end: dateTime.format(
                            new Date(rule.dateTimeRange.end),
                          ),
                        },
                      }
                    : {}),
                }),
              ),
          },
        };
      }).filter(
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
        ...publicSettings(shop),
      },
      membership,
    });
  });
  app.get("/api/v1/shops/:shopCode/settings", async (c) => {
    const shop = await getBillingShop(c, c.req.param("shopCode"));
    await staffPrincipal(c, shop);
    return c.json(publicSettings(shop));
  });
  app.put("/api/v1/shops/:shopCode/settings", async (c) => {
    const shop = await getBillingShop(c, c.req.param("shopCode"));
    const principal = await staffPrincipal(c, shop);
    if (principal.staffRole !== "owner")
      jsonError(403, "只有店铺负责人可以修改平台设置");
    const body = settingsSchema.parse(await c.req.json());
    if (body.billingEnabled) {
      const bot = await c.env.DB.prepare(
        "SELECT 1 FROM api_tokens WHERE shop_id=? AND role='integration' AND status='active' LIMIT 1",
      )
        .bind(shop.id)
        .first();
      const configured = await c.env.DB.prepare(
        "SELECT id FROM pricing_configs WHERE shop_id=? AND enabled=1 AND status='active'",
      )
        .bind(shop.id)
        .all<{ id: string }>();
      const currency = await c.env.DB.prepare(
        "SELECT 1 FROM asset_definitions WHERE shop_id=? AND type='currency' AND status='active' LIMIT 1",
      )
        .bind(shop.id)
        .first();
      if (
        !bot ||
        !currency ||
        !body.entryPricingIds.length ||
        body.entryPricingIds.some(
          (id) => !configured.results.some((r) => r.id === id),
        )
      )
        jsonError(
          409,
          "请先配置 Bot 凭据、余额资产和入场规则",
          "BILLING_CONFIGURATION_REQUIRED",
        );
    }
    if (shop.billing_enabled && !body.billingEnabled) {
      const active = await c.env.DB.prepare(
        "SELECT 1 FROM sessions WHERE shop_id=? AND payment_status='unpaid' LIMIT 1",
      )
        .bind(shop.id)
        .first();
      if (active)
        jsonError(409, "存在未结消费，不能停用计费", "UNSETTLED_SESSIONS");
    }
    await c.env.DB.prepare(
      `INSERT INTO shop_billing_settings (shop_id,billing_enabled,auto_register,checkin_geo,checkout_geo,machine_geo,entry_pricing_ids_json,bot_contact)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(shop_id) DO UPDATE SET billing_enabled=excluded.billing_enabled,auto_register=excluded.auto_register,
      checkin_geo=excluded.checkin_geo,checkout_geo=excluded.checkout_geo,machine_geo=excluded.machine_geo,entry_pricing_ids_json=excluded.entry_pricing_ids_json,bot_contact=excluded.bot_contact`,
    )
      .bind(
        shop.id,
        +body.billingEnabled,
        +body.autoRegister,
        +body.checkinGeo,
        +body.checkoutGeo,
        +body.machineGeo,
        JSON.stringify(body.entryPricingIds),
        body.botContact,
      )
      .run();
    return c.json(body);
  });
  app.post("/api/v1/shops/:shopCode/qq-binding", async (c) => {
    const user = requireUser(c);
    const shop = await getBillingShop(c, c.req.param("shopCode"));
    await enforceRateLimits(c, [
      {
        key: `bind:${shop.id}:${user.id}:${Math.floor(Date.now() / 60000)}`,
        limit: 3,
        windowSeconds: 90,
      },
    ]);
    const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    const code = Array.from(
      crypto.getRandomValues(new Uint8Array(8)),
      (b) => alphabet[b % 32],
    ).join("");
    const expiresAt = new Date(Date.now() + 300000).toISOString();
    await c.env.DB.prepare(
      `INSERT INTO qq_binding_codes (shop_id,user_id,code_hash,expires_at,created_at) VALUES (?,?,?,?,?)
      ON CONFLICT(shop_id,user_id) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,created_at=excluded.created_at`,
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
  app.get("/api/v1/shops/:shopCode/qq-binding", async (c) => {
    const user = requireUser(c);
    const shop = await getBillingShop(c, c.req.param("shopCode"));
    const binding = await c.env.DB.prepare(
      "SELECT player_id AS playerId,qq,verified_at AS verifiedAt FROM shop_player_accounts WHERE shop_id=? AND user_id=?",
    )
      .bind(shop.id, user.id)
      .first();
    return c.json({ binding });
  });
  for (const channel of ["integration", "staff"] as const) app.post(
    `/api/v1/shops/:shopCode/${channel}/qq-binding/confirm`,
    async (c) => {
      const shop = await getBillingShop(c, c.req.param("shopCode"));
      const deps = dependencies(c, shop);
      const token = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
      if (channel === "staff") {
        const principal = await staffPrincipal(c, shop);
        if (principal.staffRole === "viewer") jsonError(403, "没有玩家管理权限", "FORBIDDEN");
      } else if (
        !token ||
        (await deps.apiTokenAuth?.authenticateApiToken(token))?.role !== "integration"
      ) {
        jsonError(403, "店铺 Bot 凭据无效");
      }
      await enforceRateLimits(c, [
        {
          key: `bind-confirm:${shop.id}:${Math.floor(Date.now() / 60000)}`,
          limit: 20,
          windowSeconds: 90,
        },
      ]);
      const body = z
        .object({
          code: z
            .string()
            .trim()
            .toUpperCase()
            .regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/),
          qq: z.string().regex(/^[1-9]\d{4,19}$/),
        })
        .parse(await c.req.json());
      const code = await c.env.DB.prepare(
        "DELETE FROM qq_binding_codes WHERE shop_id=? AND code_hash=? AND expires_at>? RETURNING user_id",
      )
        .bind(shop.id, await sha256(body.code), new Date().toISOString())
        .first<{ user_id: string }>();
      if (!code)
        jsonError(410, "验证码已失效，请重新生成", "BINDING_CODE_EXPIRED");
      const conflict = await c.env.DB.prepare(
        "SELECT user_id,qq FROM shop_player_accounts WHERE shop_id=? AND (user_id=? OR qq=?)",
      )
        .bind(shop.id, code.user_id, body.qq)
        .all<{ user_id: string; qq: string }>();
      if (
        conflict.results.some(
          (r) => r.user_id !== code.user_id || r.qq !== body.qq,
        )
      )
        jsonError(409, "账号或 QQ 已有其他绑定", "QQ_BINDING_CONFLICT");
      const repos = createD1Repositories({
        db: c.env.DB,
        shopId: shop.id,
        id: crypto.randomUUID,
        now: () => new Date(),
      });
      const player = await withOperationLease(
        {
          repository: repos.operationLocks,
          scope: "qq.binding",
          resourceId: body.qq,
          now: () => new Date(),
        },
        async () => {
          const player =
            await deps.integrationCommands!.resolveOrRegisterPlayerByIdentity({
              identity: { provider: "qq", subject: body.qq },
              autoRegister: channel === "staff" || !!shop.auto_register,
            });
          if (player.status !== "active")
            jsonError(403, "店铺玩家资格已停用", "PLAYER_DISABLED");
          await c.env.DB.prepare(
            "INSERT INTO shop_player_accounts (shop_id,user_id,player_id,qq,verified_at) VALUES (?,?,?,?,?) ON CONFLICT(shop_id,user_id) DO NOTHING",
          )
            .bind(
              shop.id,
              code.user_id,
              player.id,
              body.qq,
              new Date().toISOString(),
            )
            .run();
          const bound = await c.env.DB.prepare(
            "SELECT qq FROM shop_player_accounts WHERE shop_id=? AND user_id=?",
          )
            .bind(shop.id, code.user_id)
            .first<{ qq: string }>();
          if (bound?.qq !== body.qq)
            jsonError(409, "账号已有其他绑定", "QQ_BINDING_CONFLICT");
          return player;
        },
      );
      return c.json({ playerId: player.id, verified: true });
    },
  );
  app.all("/api/v1/shops/:shopCode/staff/*", async (c) => {
    const shop = await getBillingShop(c, c.req.param("shopCode"));
    const principal = await staffPrincipal(c, shop);
    const path = c.req.path.split("/staff/")[1]!;
    if (
      principal.staffRole === "viewer" &&
      (c.req.method !== "GET" || path === "settings")
    )
      jsonError(403, "只读账号不能执行此操作");
    if (
      principal.staffRole !== "owner" &&
      (path.startsWith("api-tokens") || path.startsWith("users"))
    )
      jsonError(403, "此操作需要店主权限");
    if (path === "device-actions")
      jsonError(409, "请在设备页面操作", "DEVICE_QR_REQUIRED");
    const body =
      c.req.method === "POST"
        ? await c.req.json<Record<string, unknown>>()
        : undefined;
    const execute = () =>
      forward(
        c,
        { ...dependencies(c, shop), authenticatedPrincipal: principal },
        "staff/" + path,
        body,
      );
    return body &&
      (path === "device-actions" ||
        /\/(wallet\/adjustment|assets\/grants|checkout\/(confirm|override))$/.test(
          path,
        ) ||
        path === "sessions/active/checkout")
      ? runPlayerOperation(c, shop.id, "staff/" + path, body, execute)
      : execute();
  });
  app.all("/api/v1/shops/:shopCode/player/*", async (c) => {
    const shop = await getBillingShop(c, c.req.param("shopCode"));
    const player = await requireShopPlayer(c, shop);
    const path = c.req.path.split("/player/")[1]!;
    const body =
      c.req.method === "GET"
        ? undefined
        : await c.req.json<Record<string, unknown>>();
    if (path === "session/start") {
      const { machine } = await resolveMachineSession(
        c,
        typeof body?.ticket === "string" ? body.ticket : "",
      );
      if (machine.shop_id !== shop.id)
        jsonError(403, "请扫描设备二维码", "DEVICE_QR_REQUIRED");
      if (body?.consent !== true)
        jsonError(409, "请确认入场计费规则", "CHECKIN_CONSENT_REQUIRED");
      checkShopLocation(shop, "checkin", body?.location);
    }
    if (path === "checkout/confirm")
      checkShopLocation(shop, "checkout", body?.location);
    if (path === "device-commands")
      checkShopLocation(shop, "machine", body?.location);
    const deps = dependencies(c, shop);
    if (path === "devices" || path === "device-commands")
      jsonError(409, "请通过设备二维码操作", "DEVICE_QR_REQUIRED");
    const execute = () =>
      forward(
        c,
        {
          ...deps,
          authenticatedPrincipal: {
            role: "player_session",
            playerId: player.id,
          },
        },
        "player/" + path,
        body,
      );
    return body &&
      ["session/start", "checkout/confirm", "redeem"].includes(path)
      ? runPlayerOperation(c, shop.id, path, body, execute)
      : execute();
  });
  app.all("/api/v1/shops/:shopCode/integration/*", async (c) => {
    const shop = await getBillingShop(c, c.req.param("shopCode"));
    const path = c.req.path.split("/integration/")[1]!;
    const body =
      c.req.method === "GET"
        ? undefined
        : await c.req.json<Record<string, unknown>>();
    if (!shop.billing_enabled)
      jsonError(409, "店铺未启用计费", "BILLING_DISABLED");
    // Integration credentials authorize shop automation independently of player GPS/tickets.
    const deps = dependencies(c, shop);
    const token = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
    if (!token || (await deps.apiTokenAuth?.authenticateApiToken(token))?.role !== "integration")
      jsonError(403, "店铺 Bot 凭据无效", "FORBIDDEN");
    if (path === "device-states")
      return c.json({ deviceStates: await (await import("./devices")).listLogicalDevicePowerStates(c, shop.id) });
    if (body) {
      body.autoRegister = !!shop.auto_register;
      body.closeSessionsBeforeBalanceCheck = false;
    }
    const result = await forward(c, deps, "integration/" + path, body);
    if (path === "sessions/active" && result.ok) {
      const payload = await result.json() as Record<string, unknown>;
      return c.json({ ...payload, mahjongTables: await mahjongRoster(c, shop.id) });
    }
    return result;
  });
}
