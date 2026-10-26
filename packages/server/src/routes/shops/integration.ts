import { Hono, type Context } from "hono";
import { yuanOf } from "@prism/core";
import type { AppBindings, TenantShop } from "../../bindings.js";
import { sha256Hex } from "../../crypto.js";
import { jsonError } from "../../http.js";
import { confirmPlatformBinding } from "./binding.js";
import { getShop, getShopDeps, loadTenantShop, setTenantFromShop } from "../../middleware/tenant.js";
import { botConfigView, ensureBotResource } from "../../resources/bot.js";
import { notifyBotsChangedAfter } from "../../durable-objects/shop-hub-client.js";
import { loadResources, matchesRef } from "../../resources/resource.js";
import { loadScannedResource } from "../platform/resource-ticket.js";
import { mahjongState, operateMahjong } from "../platform/mahjong.js";
import {
  toPlayerAssetsView,
  toPlayerCheckoutPreviewView,
  toPlayerCheckoutResultView,
  toPlayerManagementView,
  toRedeemGiftView,
  toSessionHistoryView,
  toSessionView,
  toStaffActiveSessionView,
  toStoppedSessionView,
  toBillingChangeView,
  toRosterView,
} from "./views.js";

/** The integration token a bot request carries, or a 403. */
export async function integrationToken(
  c: Context<AppBindings>,
  shop: TenantShop,
): Promise<{ id: string; label: string }> {
  const auth = c.req.header("authorization");
  const token = auth?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) {
    // Bot credentials are independent of platform admin sessions.
    jsonError(403, "店铺 Bot 凭据无效", "FORBIDDEN");
  }

  const tokenHash = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    "SELECT id, label, role, status FROM api_tokens WHERE shop_id = ? AND token_hash = ? AND status = 'active'",
  )
    .bind(shop.id, tokenHash)
    .first<{ id: string; label: string; role: string; status: string }>();

  if (!row || row.role !== "integration") {
    // Bot credentials are independent of platform admin sessions.
    jsonError(403, "店铺 Bot 凭据无效", "FORBIDDEN");
  }
  return { id: row.id, label: row.label };
}

export async function requireIntegrationAuth(
  c: Context<AppBindings>,
  shop: TenantShop,
): Promise<void> {
  await integrationToken(c, shop);
}

/**
 * The shop a bot credential belongs to, without a shop code in the address:
 * the credential names one shop, and only that shop's integration routes.
 */
export async function shopOfIntegrationToken(c: Context<AppBindings>) {
  const auth = c.req.header("authorization");
  const token = auth?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) jsonError(403, "店铺 Bot 凭据无效", "FORBIDDEN");
  const row = await c.env.DB.prepare(
    `SELECT s.public_id FROM api_tokens t JOIN shops s ON s.id = t.shop_id
     WHERE t.token_hash = ? AND t.role = 'integration' AND t.status = 'active'`,
  ).bind(await sha256Hex(token)).first<{ public_id: string }>();
  if (!row) jsonError(403, "店铺 Bot 凭据无效", "FORBIDDEN");
  return row.public_id;
}

export const integrationRouter = new Hono<AppBindings>();

/**
 * What a bot needs before it knows the shop: read by credential alone, so the
 * plugin is configured with an address and a token, not a shop code.
 */
export const integrationBootstrapRouter = new Hono<AppBindings>();

integrationBootstrapRouter.get("/bot", async (c) => {
  const publicId = await shopOfIntegrationToken(c);
  const shopRow = await loadTenantShop(c, publicId);
  if (!shopRow) jsonError(404, "没有找到这个店铺", "SHOP_NOT_FOUND");
  await setTenantFromShop(c, shopRow);
  const shop = getShop(c);
  const bot = await ensureBotResource(c.env.DB, shop.id, await integrationToken(c, shop));
  if (!bot.enabled) jsonError(403, "这个 Bot 已停用", "BOT_DISABLED");
  return c.json({
    ...(await botConfigView(c.env.DB, shop.id, bot)),
    shop: { code: shop.public_id, name: shop.name },
  });
});

/**
 * Every Bot route passes here. Binding a platform identity does not need
 * billing: a shop that bills elsewhere still admits players to its doors.
 * Which commands a bot offers its players is the bot's own configuration.
 */
export async function guardIntegration(c: Context<AppBindings>): Promise<void> {
  const shop = getShop(c);
  // The bot's connection carries reminders even for a shop without billing;
  // each request over it is guarded again on its own path.
  const identityOnly = ["/integration/platform-binding/confirm", "/integration/ws", "/integration/bot"].some((path) => c.req.path.endsWith(path));
  if (!identityOnly && !shop.billing_enabled) {
    jsonError(409, "店铺未启用计费", "BILLING_DISABLED");
  }
  await requireIntegrationAuth(c, shop);
}

integrationRouter.use("*", async (c, next) => {
  await guardIntegration(c);
  await next();
});

/**
 * The bot's single connection: requests go over it instead of HTTP, and the
 * shop hub pushes reminders down it. The hub runs each request through this
 * same router with the bot's token, so every route keeps its own checks.
 */
integrationRouter.get("/ws", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") jsonError(426, "需要 WebSocket 连接", "UPGRADE_REQUIRED");
  const hub = (c.env.SHOP_HUB as unknown as { getByName(name: string): { fetch(request: Request): Promise<Response> } } | undefined);
  if (!hub) jsonError(503, "店铺连接服务尚未配置", "SHOP_HUB_UNAVAILABLE");
  const shop = getShop(c);
  const code = c.req.path.match(/^\/api\/v1\/shops\/([^/]+)\//)?.[1] ?? shop.id;
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-prism-hub-shop", shop.id);
  headers.set("x-prism-hub-shop-code", decodeURIComponent(code));
  return hub.getByName(shop.id).fetch(new Request(c.req.raw, { headers }));
});

/** A Bot request never decides registration: the shop's switch does. */
export function botRequest<T extends Record<string, any>>(c: Context<AppBindings>, body: T) {
  return {
    ...body,
    identity:
      body.identity ??
      (body.provider && body.subject ? { provider: body.provider, subject: body.subject } : undefined),
    autoRegister: !!getShop(c).auto_register,
  } as T & { identity?: { provider: string; subject: string }; autoRegister: boolean };
}

// Accept the nested { identity: { provider, subject } } envelope used by
// koishi-plugin-prism as well as the historical flat { provider, subject }
// format. Other integration routes already accept both forms.
type BotIdentityBody = {
  identity?: { provider: string; subject: string };
  identityKey?: string;
  provider?: string;
  subject?: string;
  displayName?: string;
};

function botIdentity(body: BotIdentityBody) {
  return {
    identity: body.identity ?? (body.provider != null && body.subject != null
      ? { provider: body.provider, subject: body.subject }
      : undefined),
    identityKey: body.identityKey,
  };
}

// Resolve player by identity
integrationRouter.post("/players/by-identity/resolve", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<BotIdentityBody>();
  const player = await deps.integrationCommands.resolvePlayerByIdentity(botIdentity(body));
  return c.json({ player: toPlayerManagementView(player) });
});

// Register player by identity
integrationRouter.post("/players/by-identity/register", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<BotIdentityBody>();
  const player = await deps.integrationCommands.resolveOrRegisterPlayerByIdentity({
    ...botIdentity(body),
    displayName: body.displayName,
    // Auto registration remains controlled by the shop, never the Bot request.
    autoRegister: !!getShop(c).auto_register,
  });
  return c.json({ player: toPlayerManagementView(player) });
});

// Start session by identity. A bot is a resource: logging a player in through
// it starts the bot's plan, as scanning any resource starts that resource's
// plan (its own plan, otherwise its resource group's). Being in the shop is
// having a session; a plan already billing is returned as it is
// (`created: false`), so the bot can say the player is already there.
integrationRouter.post("/players/by-identity/session/start", async (c) => {
  const shop = getShop(c);
  const deps = getShopDeps(c);
  const bot = await ensureBotResource(c.env.DB, shop.id, await integrationToken(c, shop));
  if (!bot.enabled) jsonError(403, "这个 Bot 已停用", "BOT_DISABLED");
  const body = await c.req.json<any>();
  const player = await deps.integrationCommands.resolveOrRegisterPlayerByIdentity(botRequest(c, body));
  // Bots released before mahjong moved onto the platform start a table by naming
  // its plan, then end it by stopping the session returned here: that plan's.
  const named = Array.isArray(body.pricingConfigIds) && typeof body.pricingConfigIds[0] === "string"
    ? body.pricingConfigIds[0] as string
    : null;
  const result = await deps.resourceBilling.activate({
    playerId: player.id,
    ...(named ? { pricingConfigId: named } : { resourceId: bot.id }),
    ...(named && typeof body.label === "string" ? { label: body.label } : {}),
    // Audit trail only: records which bot started this session.
    metadata: { createdBy: "integration", botResourceId: bot.id },
  });
  const planName = result.session.pricingConfigId
    ? (await deps.repositories.pricingConfigs.findById(result.session.pricingConfigId))?.name ?? null
    : null;
  return c.json({
    session: toSessionView(result.session),
    created: result.created,
    planName,
    billing: toBillingChangeView(result),
  });
});

// One player: whether they are in the shop, the plans they bill and the resources they occupy.
integrationRouter.post("/players/by-identity/presence", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const player = await deps.integrationCommands.resolvePlayerByIdentity(botRequest(c, body));
  const presence = await deps.roster.ofPlayer(player.id);
  return c.json({ ...presence, plans: presence.plans.map((plan) => ({ ...plan, startedAt: plan.startedAt.toISOString() })) });
});

// Stop session by identity
integrationRouter.post("/players/by-identity/sessions/:sessionId/stop", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const session = await deps.integrationCommands.stopSessionByIdentity({
    ...botRequest(c, body),
    sessionId: c.req.param("sessionId"),
  });
  return c.json(toStoppedSessionView(session));
});

// Checkout preview by identity
integrationRouter.post("/players/by-identity/checkout/preview", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const result = await deps.integrationCommands.previewCheckoutByIdentity({
    ...botRequest(c, body),
  });
  return c.json(toPlayerCheckoutPreviewView(result));
});

// Checkout confirm by identity
integrationRouter.post("/players/by-identity/checkout/confirm", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const result = await deps.integrationCommands.confirmCheckoutByIdentity({
    ...botRequest(c, body),
  });
  return c.json(toPlayerCheckoutResultView(result));
});

// Get wallet by identity
integrationRouter.post("/players/by-identity/wallet", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const wallet = await deps.integrationCommands.getWalletByIdentity({
    ...botRequest(c, body),
  });
  return c.json({
    wallet: (wallet ?? []).map((entry: any) => ({
      ...entry,
      quantity: yuanOf(entry.quantity),
    })),
  });
});

// Get assets by identity
integrationRouter.post("/players/by-identity/assets", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const assets = await deps.integrationCommands.getAssetsByIdentity({
    ...botRequest(c, body),
  });
  return c.json(assets);
});

// Get history by identity
integrationRouter.post("/players/by-identity/history", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const history = await deps.integrationCommands.getHistoryByIdentity({
    ...botRequest(c, body),
  });
  return c.json(history);
});

// Redeem gift by identity
integrationRouter.post("/players/by-identity/redeem", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const result = await deps.integrationCommands.redeemByIdentity({
    ...botRequest(c, body),
    code: body.code,
  });
  return c.json(toRedeemGiftView(result));
});

// Adjust assets by identity
integrationRouter.post("/players/by-identity/assets/adjustments", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const result = await deps.integrationCommands.adjustAssetsByIdentity({
    ...botRequest(c, body),
    adjustments: body.adjustments,
  });
  return c.json(result);
});

// Adjust wallet by identity
integrationRouter.post("/players/by-identity/wallet/adjustment", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const result = await deps.integrationCommands.adjustWalletByIdentity({
    ...botRequest(c, body),
    amount: body.amount,
    reason: body.reason ?? "bot adjustment",
  });
  return c.json(result);
});

// The bot's own settings and what the platform knows that it needs. A bot
// reads this when it connects and again when told its configuration changed.
integrationRouter.get("/bot", async (c) => {
  const shop = getShop(c);
  const bot = await ensureBotResource(c.env.DB, shop.id, await integrationToken(c, shop));
  if (!bot.enabled) jsonError(403, "这个 Bot 已停用", "BOT_DISABLED");
  return c.json(await botConfigView(c.env.DB, shop.id, bot));
});

/** The shop's mahjong table named by id, name or alias. */
async function mahjongTable(c: Context<AppBindings>, ref: unknown) {
  const shop = getShop(c);
  const tables = (await loadResources(c.env.DB, shop.id, c.env.URL_ENCRYPTION_KEY))
    .filter((resource) => resource.capabilities.has("mahjong") && resource.enabled);
  const table = typeof ref === "string" ? tables.find((resource) => matchesRef(resource, ref)) : undefined;
  if (!table) jsonError(404, "没有找到这张麻将桌", "MAHJONG_TABLE_NOT_FOUND");
  return (await loadScannedResource(c, shop.id, table.id))!;
}

// Seat or unseat a player at a table, as the player's own command through the bot.
integrationRouter.post("/players/by-identity/mahjong", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<{ table?: unknown; action?: unknown } & Record<string, any>>();
  if (body.action !== "join" && body.action !== "leave") jsonError(400, "请说明上桌还是下桌", "VALIDATION_FAILED");
  const table = await mahjongTable(c, body.table);
  const player = body.action === "join"
    ? await deps.integrationCommands.resolveOrRegisterPlayerByIdentity(botRequest(c, body))
    : await deps.integrationCommands.resolvePlayerByIdentity(botIdentity(body as Parameters<typeof botIdentity>[0]));
  return operateMahjong(c, table, { action: `mahjong.${body.action}` }, { bot: { playerId: player.id } });
});

// Every table with its seats, for the bot's roster.
integrationRouter.get("/mahjong-tables", async (c) => {
  const shop = getShop(c);
  const tables = (await loadResources(c.env.DB, shop.id, c.env.URL_ENCRYPTION_KEY))
    .filter((resource) => resource.capabilities.has("mahjong") && resource.enabled);
  return c.json({
    tables: await Promise.all(tables.map(async (resource) => {
      const state = await mahjongState(c, (await loadScannedResource(c, shop.id, resource.id))!, { playerId: "" });
      return {
        id: resource.id,
        name: resource.name,
        aliases: resource.aliases,
        capacity: state?.capacity ?? 0,
        seats: (state?.seats ?? []).map(({ playerId, name, playing }) => ({ playerId, name, playing })),
      };
    })),
  });
});

// Who is in the shop, each listed once at the resource they occupy or their
// most specific plan; with `?name=`, one resource or one plan only.
integrationRouter.get("/roster", async (c) => {
  const deps = getShopDeps(c);
  const name = c.req.query("name")?.trim();
  if (!name) return c.json(toRosterView(await deps.roster.list()));
  const roster = await deps.roster.only(name);
  if (!roster) jsonError(404, `找不到「${name}」`, "ROSTER_TARGET_NOT_FOUND");
  return c.json(toRosterView(roster));
});

// Active sessions, flat, for older bots; each says which plan it bills.
integrationRouter.get("/sessions/active", async (c) => {
  const deps = getShopDeps(c);
  const [sessions, plans] = await Promise.all([deps.staffQueries.listActiveSessions(), deps.repositories.pricingConfigs.listAll()]);
  const nameOf = new Map(plans.map((plan) => [plan.id, plan.name]));
  return c.json({
    sessions: sessions.map((session) => ({
      ...toStaffActiveSessionView(session),
      pricingConfigId: session.pricingConfigId ?? null,
      planName: session.pricingConfigId ? nameOf.get(session.pricingConfigId) ?? null : null,
    })),
  });
});

// Device states
integrationRouter.get("/device-states", async (c) => {
  const deps = getShopDeps(c);
  const states = deps.staffQueries.listDeviceStates
    ? await deps.staffQueries.listDeviceStates()
    : [];
  return c.json({ deviceStates: states });
});

// Platform Binding Confirm
integrationRouter.post("/platform-binding/confirm", async (c) => {
  const shop = getShop(c);
  const response = await confirmPlatformBinding(c, shop, "integration");
  // A staff member binding an identity changes who the bots treat as staff.
  notifyBotsChangedAfter(c, shop.id);
  return response;
});
