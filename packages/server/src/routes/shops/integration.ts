import { Hono, type Context } from "hono";
import { yuanOf } from "@prism/core";
import type { AppBindings, TenantShop } from "../../bindings.js";
import { sha256Hex } from "../../crypto.js";
import { jsonError } from "../../http.js";
import { confirmPlatformBinding } from "./binding.js";
import { getShop, getShopDeps } from "../../middleware/tenant.js";
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
} from "./views.js";

export async function requireIntegrationAuth(
  c: Context<AppBindings>,
  shop: TenantShop,
): Promise<void> {
  const auth = c.req.header("authorization");
  const token = auth?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) {
    // Bot credentials are independent of platform admin sessions.
    jsonError(403, "店铺 Bot 凭据无效", "FORBIDDEN");
  }

  const tokenHash = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    "SELECT id, role, status FROM api_tokens WHERE shop_id = ? AND token_hash = ? AND status = 'active'",
  )
    .bind(shop.id, tokenHash)
    .first<{ id: string; role: string; status: string }>();

  if (!row || row.role !== "integration") {
    // Bot credentials are independent of platform admin sessions.
    jsonError(403, "店铺 Bot 凭据无效", "FORBIDDEN");
  }
}

export const integrationRouter = new Hono<AppBindings>();

/**
 * Every Bot route passes here. Binding a platform identity does not need
 * billing: a shop that bills elsewhere still admits players to its doors.
 * Which commands a bot offers its players is the bot's own configuration.
 */
export async function guardIntegration(c: Context<AppBindings>): Promise<void> {
  const shop = getShop(c);
  // The bot's connection carries reminders even for a shop without billing;
  // each request over it is guarded again on its own path.
  const identityOnly = c.req.path.endsWith("/integration/platform-binding/confirm") || c.req.path.endsWith("/integration/ws");
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

// Start session by identity
integrationRouter.post("/players/by-identity/session/start", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const session = await deps.integrationCommands.startSessionByIdentity({
    ...botRequest(c, body),
  });
  return c.json({ session: toSessionView(session) });
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

// Active sessions
integrationRouter.get("/sessions/active", async (c) => {
  const deps = getShopDeps(c);
  const sessions = await deps.staffQueries.listActiveSessions();
  return c.json({ sessions: sessions.map(toStaffActiveSessionView) });
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
  return confirmPlatformBinding(c, shop, "integration");
});
