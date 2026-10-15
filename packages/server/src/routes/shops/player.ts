import { z } from "zod";
import { activityBill, refreshActivityBill } from "../../durable-objects/live-activity-billing.js";
import { enforceRateLimits } from "../../middleware/rate-limit.js";
import { isKnownLiveActivityBundle, type LiveActivityEnvironment } from "../../durable-objects/live-activity-push.js";
import { Hono, type Context } from "hono";
import { createD1Repositories } from "@prism/adapter-d1";
import { withOperationLease } from "@prism/application";
import type { AppBindings, TenantShop } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { requireUser, staffPrincipal } from "../../middleware/auth.js";
import { getShop, getShopDeps } from "../../middleware/tenant.js";
import { checkShopLocation } from "../../middleware/geo.js";
import { resolveMachineSession } from "../platform/machine-session.js";
import { runPlayerOperation } from "./player-operation.js";
import {
  toPlayerAssetsView,
  toPlayerCheckoutPreviewView,
  toPlayerCheckoutResultView,
  toPlayerRedeemRecordsView,
  toPlayerSummaryView,
  toRedeemGiftView,
  toSessionHistoryDetailView,
  toSessionHistoryView,
  toSessionView,
  toStoppedSessionView,
  toDeviceCommandView,
  toBusinessItemOrderView,
} from "./views.js";

export async function hasPlatformBinding(
  c: Context<AppBindings>,
  shopId: string,
  userId: string,
): Promise<boolean> {
  return !!(await c.env.DB.prepare(
    "SELECT 1 FROM shop_platform_bindings WHERE shop_id = ? AND user_id = ? LIMIT 1",
  )
    .bind(shopId, userId)
    .first());
}

export async function requireShopPlayer(
  c: Context<AppBindings>,
  shop: TenantShop,
  deviceOnly = false,
  enforceBinding = true,
): Promise<{ id: string; status: string }> {
  const user = requireUser(c);
  if (!shop.billing_enabled && !deviceOnly) {
    jsonError(409, "店铺未启用计费", "BILLING_DISABLED");
  }

  const playerIdHeader = c.req.header("X-PRiSM-Player-Id");
  if (playerIdHeader) {
    const isStaff = await staffPrincipal(c, shop).then(() => true).catch(() => false);
    if (!isStaff && user.role !== "admin") {
      jsonError(403, "无权指定玩家身份", "FORBIDDEN");
    }
    const playerRow = await c.env.DB.prepare(
      "SELECT id, status FROM players WHERE shop_id = ? AND id = ?",
    )
      .bind(shop.id, playerIdHeader)
      .first<{ id: string; status: string }>();
    if (!playerRow) {
      jsonError(404, "玩家不存在", "PLAYER_NOT_FOUND");
    }
    if (playerRow.status !== "active") {
      jsonError(403, "店铺玩家资格已停用", "PLAYER_DISABLED");
    }
    return playerRow;
  }

  const find = () =>
    c.env.DB.prepare(
      `SELECT p.id, p.status FROM shop_player_accounts a
       JOIN players p ON p.shop_id = a.shop_id AND p.id = a.player_id
       WHERE a.shop_id = ? AND a.user_id = ?`,
    )
      .bind(shop.id, user.id)
      .first<{ id: string; status: string }>();

  let player = await find();
  if (
    shop.identity_binding_required &&
    (!player || enforceBinding) &&
    !(await hasPlatformBinding(c, shop.id, user.id))
  ) {
    jsonError(403, "请先绑定平台身份", "PLATFORM_BINDING_REQUIRED");
  }

  if (!player) {
    const deps = getShopDeps(c);
    const repos = createD1Repositories({
      db: c.env.DB,
      shopId: shop.id,
      id: crypto.randomUUID,
      now: () => new Date(),
    });
    player = await withOperationLease(
      {
        repository: repos.operationLocks,
        scope: "platform.membership",
        resourceId: user.id,
        now: () => new Date(),
      },
      async () => {
        const current = await find();
        if (current) return current;
        const created = await deps.integrationCommands.resolveOrRegisterPlayerByIdentity({
          identity: { provider: "web-account", subject: user.id },
          autoRegister: true,
          displayName: user.displayName || user.username || "玩家",
        });
        await c.env.DB.prepare(
          "INSERT INTO shop_player_accounts(shop_id, user_id, player_id, verified_at) VALUES (?, ?, ?, ?)",
        )
          .bind(shop.id, user.id, created.id, new Date().toISOString())
          .run();
        return created;
      },
    );
  }

  if (player.status !== "active") {
    jsonError(403, "店铺玩家资格已停用", "PLAYER_DISABLED");
  }
  return player;
}

export const playerRouter = new Hono<AppBindings>();

// The ActivityKit client uses these store-scoped endpoints. They must be routed
// before normal player commands; they were previously handled by billing.ts's wildcard.
playerRouter.get("/live-activity/bill", async (c) => {
  const shop = getShop(c);
  const player = await requireShopPlayer(c, shop);
  return handleLiveActivityRoute(c, shop, player, "live-activity/bill", undefined);
});
for (const action of ["register", "unregister"] as const) {
  playerRouter.post(`/live-activity/${action}`, async (c) => {
    const shop = getShop(c);
    const player = await requireShopPlayer(c, shop);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    return handleLiveActivityRoute(c, shop, player, `live-activity/${action}`, body);
  });
}

// Player Summary
playerRouter.get("/me", async (c) => {
  const shop = getShop(c);
  const player = await requireShopPlayer(c, shop);
  const deps = getShopDeps(c);
  const summary = await deps.playerQueries.getPlayerSummary(player.id);
  return c.json(toPlayerSummaryView(summary));
});

// Client billing inputs are restricted to the authenticated player's holdings.
playerRouter.get("/billing-inputs", async (c) => {
  const shop = getShop(c);
  const player = await requireShopPlayer(c, shop);
  const deps = getShopDeps(c);
  if (!deps.staffLiveBillingSnapshot) jsonError(503, "Client billing is unavailable for this runtime.", "CLIENT_BILLING_UNAVAILABLE");
  const snapshot = await deps.staffLiveBillingSnapshot([player.id]);
  const held = new Set(snapshot.players.flatMap(row => row.holdings.map(h => `${h.assetType}:${h.assetCode}`)));
  return c.json({ playerId: player.id, billingSnapshot: {
    ...snapshot,
    assetDefinitions: snapshot.assetDefinitions.filter(d => held.has(`${d.type}:${d.code}`)),
  } });
});

// Player Assets
playerRouter.get("/assets", async (c) => {
  const shop = getShop(c);
  const player = await requireShopPlayer(c, shop);
  const deps = getShopDeps(c);
  const assets = deps.playerQueries.listPlayerAssets
    ? await deps.playerQueries.listPlayerAssets(player.id)
    : { holdings: [], ledgerEntries: [] };
  return c.json(toPlayerAssetsView(assets));
});

// Checkout History
playerRouter.get("/checkouts/history", async (c) => {
  const shop = getShop(c);
  const player = await requireShopPlayer(c, shop);
  const deps = getShopDeps(c);
  const offset = Number(c.req.query("offset") ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    jsonError(400, "Invalid history offset.", "INVALID_OFFSET");
  }
  if (!deps.playerQueries.listPlayerCheckouts) {
    jsonError(503, "Checkout queries are not configured.", "CHECKOUT_QUERIES_NOT_CONFIGURED");
  }
  return c.json(await deps.playerQueries.listPlayerCheckouts(player.id, offset));
});

// Single Checkout Detail
playerRouter.get("/checkouts/:checkoutId", async (c) => {
  const shop = getShop(c);
  const player = await requireShopPlayer(c, shop);
  const deps = getShopDeps(c);
  if (!deps.playerQueries.getPlayerCheckout) {
    jsonError(503, "Checkout queries are not configured.", "CHECKOUT_QUERIES_NOT_CONFIGURED");
  }
  const receipt = await deps.playerQueries.getPlayerCheckout(player.id, c.req.param("checkoutId"));
  if (!receipt) {
    jsonError(404, "Checkout not found.", "CHECKOUT_NOT_FOUND");
  }
  return c.json({ receipt });
});

// Latest Checkout
playerRouter.get("/checkout/latest", async (c) => {
  const shop = getShop(c);
  const player = await requireShopPlayer(c, shop);
  const deps = getShopDeps(c);
  if (!deps.playerQueries.getLatestPlayerCheckout) {
    jsonError(503, "Checkout queries are not configured.", "CHECKOUT_QUERIES_NOT_CONFIGURED");
  }
  return c.json({ receipt: await deps.playerQueries.getLatestPlayerCheckout(player.id) });
});

// Session History
playerRouter.get("/sessions/history", async (c) => {
  const shop = getShop(c);
  const player = await requireShopPlayer(c, shop);
  const deps = getShopDeps(c);
  if (!deps.playerQueries.listPlayerSessionHistory) {
    jsonError(503, "Player session history queries are not configured.", "PLAYER_SESSION_HISTORY_QUERIES_NOT_CONFIGURED");
  }
  const sessions = await deps.playerQueries.listPlayerSessionHistory(player.id);
  return c.json(toSessionHistoryView(sessions));
});

// Single Session History Detail
playerRouter.get("/sessions/:sessionId/history", async (c) => {
  const shop = getShop(c);
  const player = await requireShopPlayer(c, shop);
  const deps = getShopDeps(c);
  if (!deps.playerQueries.getPlayerSessionHistoryDetail) {
    jsonError(503, "Player session history queries are not configured.", "PLAYER_SESSION_HISTORY_QUERIES_NOT_CONFIGURED");
  }
  const detail = await deps.playerQueries.getPlayerSessionHistoryDetail(player.id, c.req.param("sessionId"));
  if (!detail) {
    jsonError(404, "Session not found.", "SESSION_NOT_FOUND");
  }
  return c.json(toSessionHistoryDetailView(detail));
});

// Start Session — original contract requires a valid machine ticket,
// consent and shop check-in location before any billing operation.
playerRouter.post("/session/start", async (c) => {
  const shop = getShop(c);
  const player = await requireShopPlayer(c, shop, false, true);
  const body = (await c.req.json<{ ticket?: string; consent?: boolean; location?: unknown; operationId?: string }>().catch(() => ({}))) as { ticket?: string; consent?: boolean; location?: unknown; operationId?: string };
  const machine = await resolveMachineSession(c, body.ticket ?? "");
  if (machine.shop_id !== shop.id) {
    jsonError(403, "请扫描设备二维码", "DEVICE_QR_REQUIRED");
  }
  if (body.consent !== true) {
    jsonError(409, "请确认入场计费规则", "CHECKIN_CONSENT_REQUIRED");
  }
  checkShopLocation(shop, "checkin", body.location);
  return runPlayerOperation(c, shop.id, "session/start", body, async () => {
    const session = await getShopDeps(c).playerCommands.startSession({ playerId: player.id });
    return c.json({ session: toSessionView(session) });
  });
});

// Stop Session
playerRouter.post("/sessions/:sessionId/stop", async (c) => {
  const shop = getShop(c);
  const player = await requireShopPlayer(c, shop);
  const deps = getShopDeps(c);
  const session = await deps.playerCheckoutCommands.stopSession({
    playerId: player.id,
    sessionId: c.req.param("sessionId"),
  });
  return c.json(toStoppedSessionView(session));
});

// Checkout Preview
playerRouter.post("/checkout/preview", async (c) => {
  const shop = getShop(c);
  const player = await requireShopPlayer(c, shop);
  const deps = getShopDeps(c);

  const result = await deps.playerCheckoutCommands.previewCheckout({
    playerId: player.id,
  });
  return c.json(toPlayerCheckoutPreviewView(result));
});

// Checkout Confirm
playerRouter.post("/checkout/confirm", async (c) => {
  const shop = getShop(c);
  const player = await requireShopPlayer(c, shop);
  const body = (await c.req.json<{ location?: unknown; operationId?: string }>().catch(() => ({}))) as { location?: unknown; operationId?: string };
  checkShopLocation(shop, "checkout", body.location);
  const deps = getShopDeps(c);

  return runPlayerOperation(c, shop.id, "checkout/confirm", body, async () => {
    const result = await deps.playerCheckoutCommands.checkout({
      playerId: player.id,
      closeSessionsBeforeBalanceCheck: false,
    });
    return c.json(toPlayerCheckoutResultView(result));
  });
});

// Redeem
playerRouter.post("/redeem", async (c) => {
  const shop = getShop(c);
  const player = await requireShopPlayer(c, shop);
  const deps = getShopDeps(c);
  const body = await c.req.json<{ code: string }>();
  if (!body?.code?.trim()) {
    jsonError(400, "请输入兑换码", "INVALID_CODE");
  }
  return runPlayerOperation(c, shop.id, "redeem", body, async () => {
    const result = await deps.playerRedeemCommands.redeemCode({
      playerId: player.id,
      code: body.code.trim(),
    });
    return c.json(toRedeemGiftView(result));
  });
});

// Device Commands
playerRouter.post("/device-commands", async (c) => {
  // As before the consolidation, authenticated players must operate devices
  // through the short-lived QR machine-session endpoint, not a tenant command
  // accepting arbitrary target identifiers.
  jsonError(409, "请通过设备二维码操作", "DEVICE_QR_REQUIRED");
});

// Purchase Business Item
playerRouter.post("/business-items/:businessItemId/purchase", async (c) => {
  const shop = getShop(c);
  const player = await requireShopPlayer(c, shop);
  const deps = getShopDeps(c);
  const body = (await c.req.json<{ metadata?: Record<string, unknown> | null }>().catch(() => ({}))) as {
    metadata?: Record<string, unknown> | null;
  };
  const result = await deps.businessItemOrderCommands.purchaseBusinessItem({
    businessItemId: c.req.param("businessItemId"),
    playerId: player.id,
    metadata: body?.metadata ?? null,
  });
  return c.json({ order: toBusinessItemOrderView(result.order) }, 201);
});

// Business Item Orders
playerRouter.get("/business-item-orders", async (c) => {
  const shop = getShop(c);
  const player = await requireShopPlayer(c, shop);
  const deps = getShopDeps(c);
  const orders = await deps.businessItemOrderCommands.listPlayerBusinessItemOrders({
    playerId: player.id,
  });
  return c.json({ orders: orders.map(toBusinessItemOrderView) });
});

async function handleLiveActivityRoute(
  c: Context<AppBindings>,
  shop: TenantShop,
  player: { id: string },
  path: string,
  body: Record<string, unknown> | undefined,
): Promise<Response> {
  const user = requireUser(c);
  if (path === "live-activity/bill" && c.req.method === "GET") {
    // A local activity must recover its own checkout, never the player's latest visit.
    const sessionId = c.req.query("sessionId");
    if (sessionId) {
      const session = await c.env.DB.prepare(`SELECT s.started_at, s.ended_at, s.payment_status,
        pc.total, pc.settled_at FROM sessions s
        LEFT JOIN settlements st ON st.shop_id=s.shop_id AND st.session_id=s.id
        LEFT JOIN player_checkouts pc ON pc.shop_id=st.shop_id AND pc.id=st.checkout_id
        WHERE s.shop_id=? AND s.player_id=? AND s.id=?`)
        .bind(shop.id, player.id, sessionId)
        .first<{ started_at: string; ended_at: string | null; payment_status: string; total: number | null; settled_at: string | null }>();
      if (!session) jsonError(404, "未找到对应的在店计费会话");
      if (session.payment_status === "paid") {
        if (session.total === null || !session.ended_at || !session.settled_at)
          jsonError(409, "结算账单尚不可用");
        return c.json({ phase: "ended", startedAtUnix: Date.parse(session.started_at) / 1000,
          endedAtUnix: Date.parse(session.ended_at) / 1000, nextCheckAtUnix: null,
          bill: { amountCents: session.total, planLabel: "", nextEvent: null,
            asOfUnix: Date.parse(session.settled_at) / 1000 } });
      }
    }
    const snapshot = await activityBill(c.env, shop.id, player.id);
    const sync = refreshActivityBill(c.env, shop.id, player.id).catch(error => console.error("Live bill recovery failed", error));
    try { c.executionCtx.waitUntil(sync); } catch { void sync; }
    return c.json({ phase: snapshot ? "active" : null, startedAtUnix: snapshot?.startedAtUnix ?? null, bill: snapshot?.bill ?? null, nextBill: snapshot?.nextBill ?? null, nextCheckAtUnix: snapshot?.nextCheckAt ? snapshot.nextCheckAt / 1000 : null, endedAtUnix: snapshot?.endedAtUnix ?? null });
  }
  if (path === "live-activity/register") {
    await enforceRateLimits(c, [{ key: `live-activity:mutation:${user.id}`, limit: 5 }]);
    const parsed = z
      .object({
        activityId: z.string().min(1).max(200),
        token: z.string().regex(/^[0-9a-fA-F]{32,200}$/),
        environment: z.enum(["sandbox", "production"]),
        bundleId: z.string().min(1).max(200),
        sessionId: z.string().min(1).max(200).nullish(),
        attributes: z.record(z.string(), z.unknown()).optional(),
      })
      .safeParse(body);
    if (!parsed.success) jsonError(400, "实时活动注册参数无效");
    const input = parsed.data;
    if (!isKnownLiveActivityBundle(input.bundleId))
      jsonError(400, "未知的应用标识");

    if (input.sessionId) {
      const session = await c.env.DB.prepare(
        "SELECT id FROM sessions WHERE id=? AND shop_id=? AND player_id=?",
      )
        .bind(input.sessionId, shop.id, player.id)
        .first();
      if (!session) jsonError(404, "未找到对应的在店计费会话");
    }

    const now = new Date().toISOString();
    const attributes = JSON.stringify(input.attributes ?? {});
    if (attributes.length > 4096) jsonError(413, "实时活动属性过大");
    // Remove expired entries before enforcing the limit; the client can recover
    // from an uninstalled app without needing an old token to be pushed first.
    await c.env.DB.prepare(
      "DELETE FROM live_activity_tokens WHERE shop_id=? AND user_id=? AND created_at<?",
    ).bind(shop.id, user.id, new Date(Date.now() - 8 * 3600_000).toISOString()).run();
    // Atomic quota check and upsert: concurrent requests cannot exceed four
    // activities even when they use different attacker-supplied activity IDs.
    await c.env.DB.prepare(
      `INSERT INTO live_activity_tokens
        (id, shop_id, user_id, activity_id, token, environment, bundle_id, session_id, attributes_json, created_at, updated_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,?
       WHERE EXISTS(SELECT 1 FROM live_activity_tokens WHERE shop_id=? AND user_id=? AND activity_id=?)
          OR (SELECT COUNT(*) FROM live_activity_tokens WHERE shop_id=? AND user_id=?) < 4
       ON CONFLICT(shop_id, user_id, activity_id) DO UPDATE SET
         token=excluded.token, environment=excluded.environment, bundle_id=excluded.bundle_id,
         session_id=excluded.session_id, attributes_json=excluded.attributes_json, updated_at=excluded.updated_at`,
    )
      .bind(
        crypto.randomUUID(),
        shop.id,
        user.id,
        input.activityId,
        // APNs requires lowercase hex; normalising here keeps the lookup exact.
        input.token.toLowerCase(),
        input.environment satisfies LiveActivityEnvironment,
        input.bundleId,
        input.sessionId ?? null,
        attributes,
        now,
        now,
        shop.id,
        user.id,
        input.activityId,
        shop.id,
        user.id,
      )
      .run();
    const accepted = await c.env.DB.prepare(
      "SELECT 1 FROM live_activity_tokens WHERE shop_id=? AND user_id=? AND activity_id=? AND token=?",
    ).bind(shop.id, user.id, input.activityId, input.token.toLowerCase()).first();
    if (!accepted) jsonError(429, "实时活动已达到每人最多 4 个的上限");
    await refreshActivityBill(c.env, shop.id, player.id);
    return c.json({ ok: true });
  }

  if (path === "live-activity/unregister") {
    await enforceRateLimits(c, [{ key: `live-activity:mutation:${user.id}`, limit: 5 }]);
    const parsed = z
      .object({ activityId: z.string().min(1).max(200) })
      .safeParse(body);
    if (!parsed.success) jsonError(400, "实时活动注销参数无效");
    // Scoped by user so one player can never retire another player's activity.
    await c.env.DB.prepare(
      "DELETE FROM live_activity_tokens WHERE shop_id=? AND user_id=? AND activity_id=?",
    )
      .bind(shop.id, user.id, parsed.data.activityId)
      .run();
    return c.json({ ok: true });
  }

  // Any other `live-activity/*` path is a client bug; answering 200 would hide it.
  jsonError(404, "未知的实时活动操作");
}
