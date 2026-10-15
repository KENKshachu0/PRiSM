import type { Context } from "hono";
import {
  LiveActivityPusher,
  liveActivityConfig,
  liveActivityEndPayload,
  liveActivityStartPayload,
  maskToken,
  type LiveActivityPushRecord,
  type ApnsTransport,
} from "../../durable-objects/live-activity-push.js";
import type { AppBindings } from "../../bindings.js";
import { activityBill, refreshActivityBill } from "../../durable-objects/live-activity-billing.js";

type C = Context<AppBindings>;

/**
 * Bridges store session events to the phones that are showing them.
 *
 * Sessions started or settled by players, staff, cashiers or shop bots all pass
 * through the tenant event bridge. Hooking here
 * means the core billing domain stays unaware that Live Activities exist, and a new
 * channel cannot silently miss notifications.
 */

/** Exact paths that open a visit, relative to the `/player/` or `/integration/` mount. */
const SESSION_START_PATHS = new Set([
  "session/start",
  "remote-entry",
  "players/by-identity/session/start",
]);

/** Paths that close a visit, including the per-session stop and the bulk active checkout. */
function isSessionEndPath(path: string): boolean {
  return (
    path === "checkout/confirm" ||
    path === "checkout/override" ||
    path === "checkout/recharge" ||
    path === "sessions/active/checkout" ||
    path === "players/by-identity/checkout/confirm" ||
    path === "players/by-identity/checkout/override" ||
    /^(players|profiles)\/[^/]+\/checkout\/(confirm|override|recharge)$/.test(path) ||
    /^sessions\/[^/]+\/stop$/.test(path) ||
    /^players\/[^/]+\/sessions\/[^/]+\/stop$/.test(path) ||
    /^players\/by-identity\/sessions\/[^/]+\/stop$/.test(path)
  );
}

export function sessionEventForPath(path: string): "start" | "end" | null {
  // The admin console addresses a player explicitly, so its start path carries an id.
  if (SESSION_START_PATHS.has(path) || /^players\/[^/]+\/session\/start$/.test(path) || /^profiles\/[^/]+\/entry$/.test(path)) {
    return "start";
  }
  return isSessionEndPath(path) ? "end" : null;
}

type SessionRow = {
  id: string;
  startedAt: string;
  endedAt: string | null;
};

/**
 * Resolves the store session a response refers to, so the push can carry its start time.
 * The shapes differ per channel: a start returns `session`, a checkout returns a
 * settlement plus per-session details.
 */
export function extractSessionIds(
  payload: Record<string, unknown>,
  event: "start" | "end",
): string[] {
  const ids: string[] = [];
  const session = payload.session as { id?: unknown } | undefined;
  if (session && typeof session.id === "string") ids.push(session.id);
  for (const key of ["sessions", "sessionDetails"] as const) {
    const list = payload[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const record = item as { sessionId?: unknown; session?: { sessionId?: unknown } };
      const id = record?.session?.sessionId ?? record?.sessionId;
      if (typeof id === "string") ids.push(id);
    }
  }
  // A checkout answers with settlement records that nest the session id.
  const settlements = payload.settlements;
  if (Array.isArray(settlements)) {
    for (const item of settlements) {
      const record = item as { settlement?: { sessionId?: unknown }; sessionId?: unknown };
      const id = record?.settlement?.sessionId ?? record?.sessionId;
      if (typeof id === "string") ids.push(id);
      if (item && typeof item === "object") {
        ids.push(...extractSessionIds(item as Record<string, unknown>, event));
      }
    }
  }
  if (event === "end" && ids.length === 0) {
    // A stop endpoint answers with the session itself.
    const stopped = payload.session as { id?: unknown } | undefined;
    if (stopped && typeof stopped.id === "string") ids.push(stopped.id);
  }
  return Array.from(new Set(ids));
}

/**
 * Looks up the sessions a response touched, keyed by id, to recover their start/end times.
 * Missing rows simply yield no push rather than a wrong timer.
 */
async function loadSessions(c: C, shopId: string, ids: string[]): Promise<Map<string, SessionRow>> {
  const found = new Map<string, SessionRow>();
  if (ids.length === 0) return found;
  const placeholders = ids.map(() => "?").join(",");
  const rows = await c.env.DB.prepare(
    `SELECT id, started_at AS startedAt, ended_at AS endedAt FROM sessions WHERE shop_id=? AND id IN (${placeholders})`,
  )
    .bind(shopId, ...ids)
    .all<SessionRow>();
  for (const row of rows.results ?? []) found.set(row.id, row);
  return found;
}

type TokenRow = {
  id: string;
  token: string;
  environment: "sandbox" | "production";
  bundle_id: string;
  session_id: string | null;
  created_at: string;
};

type StartTokenRow = {
  id: string;
  token: string;
  environment: "sandbox" | "production";
  bundle_id: string;
  client_id: string;
};

/**
 * Sends the start/end for a session that a channel just opened or settled.
 *
 * Runs inside `waitUntil`, so a slow or failing APNs call never delays the billing
 * response the player or staff member is waiting on.
 */
export async function pushSessionEvent(
  c: C,
  input: {
    shopId: string;
    playerId: string;
    sessionIds: string[];
    event: "start" | "end";
    initiatorClientId?: string | null;
  },
  // Test seam: APNs transport is injectable, never replaced in production.
  transport?: ApnsTransport,
): Promise<void> {
  const config = liveActivityConfig(c.env);
  // No APNs credentials (local, beta, tests) means the whole feature is inert.
  if (!config) return;

  if (c.env.LIVE_BILLING) {
    // A genuine completed session may send its final end state promptly.
    // Final delivery is bounded per activity by deduplication and retry limits.
    await refreshActivityBill(c.env, input.shopId, input.playerId, input.event === "end");
    // The scheduler checks all remaining sessions before ending the visit.
    if (input.event === "end") return;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const pusher = new LiveActivityPusher({ config, transport });

  if (input.event === "start") {
    if (c.env.LIVE_BILLING) {
      const first = await c.env.DB.prepare("SELECT id FROM sessions WHERE shop_id=? AND player_id=? AND payment_status='unpaid' ORDER BY started_at,id LIMIT 1")
        .bind(input.shopId, input.playerId).first<{ id: string }>();
      if (first && !input.sessionIds.includes(first.id)) return;
    }
    // Push-to-start: users who have previously signed in on a supported iOS device
    // registered their push-to-start tokens. We fan out APNs event=start so their
    // Dynamic Island / Live Activity starts automatically even if the app is killed.
    const account = await c.env.DB.prepare(
      "SELECT user_id AS userId FROM shop_player_accounts WHERE shop_id=? AND player_id=?",
    )
      .bind(input.shopId, input.playerId)
      .first<{ userId: string }>();
    if (!account) return;

    const startTokens = await c.env.DB.prepare(
      `SELECT id, token, environment, bundle_id, client_id
       FROM live_activity_start_tokens
       WHERE user_id=?`,
    )
      .bind(account.userId)
      .all<StartTokenRow>();
    const tokenRows = startTokens.results ?? [];
    if (tokenRows.length === 0) return;

    const shopRow = await c.env.DB.prepare(
      "SELECT public_id AS publicId, name FROM shops WHERE id=?",
    )
      .bind(input.shopId)
      .first<{ publicId: string; name: string }>();
    if (!shopRow) return;

    const sessions = await loadSessions(c, input.shopId, input.sessionIds);
    const sessionId = input.sessionIds[0];
    if (!sessionId) return;
    const sessionRow = sessions.get(sessionId);
    if (!sessionRow) return;
    const startedAtUnix = Math.floor(new Date(sessionRow.startedAt).getTime() / 1000);
    if (!Number.isFinite(startedAtUnix)) return;

    const origin = c.env.APP_ORIGIN || "https://link.neri.moe";
    const snapshot = c.env.LIVE_BILLING ? await activityBill(c.env, input.shopId, input.playerId) : null;
    const payload = liveActivityStartPayload({
      sessionId,
      shopCode: shopRow.publicId,
      shopName: shopRow.name,
      origin,
      startedAtUnix,
      now: nowSeconds,
      bill: snapshot?.bill,
      staleAfterSeconds: snapshot?.nextCheckAt ? Math.max(1, Math.ceil(snapshot.nextCheckAt / 1000 - nowSeconds)) : undefined,
    });

    for (const row of tokenRows) {
      if (input.initiatorClientId && row.client_id === input.initiatorClientId) {
        // Skip the client that initiated this session in the foreground to avoid race
        // condition / duplicate activity with local Activity.request().
        continue;
      }
      console.log("Pushing Live Activity start", {
        shopId: input.shopId,
        userId: account.userId,
        session: sessionId,
        bundle: row.bundle_id,
        environment: row.environment,
        token: maskToken(row.token),
      });
      const outcome = await pusher.send(
        {
          token: row.token,
          environment: row.environment,
          bundleId: row.bundle_id,
        } satisfies LiveActivityPushRecord,
        payload,
      );
      if (outcome.kind === "expired") {
        await c.env.DB.prepare("DELETE FROM live_activity_start_tokens WHERE id=?").bind(row.id).run();
      } else if (outcome.kind === "delivered") {
        await c.env.DB.prepare("UPDATE live_activity_start_tokens SET last_seen_at=? WHERE id=?")
          .bind(new Date().toISOString(), row.id)
          .run();
      } else if (outcome.kind === "failed") {
        console.error("Live Activity start push failed", {
          shopId: input.shopId,
          status: outcome.status,
          reason: outcome.reason,
        });
      }
    }
    return;
  }

  // End event: find existing per-activity tokens.
  // Match by player account, or directly by session_id when known, so tokens tied to the
  // ending session are always resolved even if identity resolution differed across channels.
  let tokensQuery: string;
  let bindings: string[];
  if (input.sessionIds.length > 0) {
    const placeholders = input.sessionIds.map(() => "?").join(",");
    tokensQuery = `SELECT DISTINCT t.id, t.token, t.environment, t.bundle_id, t.session_id, t.created_at
     FROM live_activity_tokens t
     LEFT JOIN shop_player_accounts a ON a.shop_id=t.shop_id AND a.user_id=t.user_id
     WHERE t.shop_id=? AND (t.session_id IN (${placeholders}) OR a.player_id=?)`;
    bindings = [input.shopId, ...input.sessionIds, input.playerId];
  } else {
    tokensQuery = `SELECT t.id, t.token, t.environment, t.bundle_id, t.session_id, t.created_at
     FROM live_activity_tokens t
     JOIN shop_player_accounts a ON a.shop_id=t.shop_id AND a.user_id=t.user_id
     WHERE t.shop_id=? AND a.player_id=?`;
    bindings = [input.shopId, input.playerId];
  }
  const tokens = await c.env.DB.prepare(tokensQuery)
    .bind(...bindings)
    .all<TokenRow>();
  const rows = tokens.results ?? [];
  if (rows.length === 0) return;

  const sessions = await loadSessions(c, input.shopId, input.sessionIds);

  for (const row of rows) {
    const sessionId =
      input.sessionIds.find((id) => id === row.session_id) ?? input.sessionIds[0] ?? null;
    const sessionRow = sessionId ? sessions.get(sessionId) : undefined;
    const startedAt = sessionRow?.startedAt;
    const startedAtUnix = startedAt
      ? Math.floor(new Date(startedAt).getTime() / 1000)
      : Math.floor(new Date(row.created_at).getTime() / 1000);
    if (!Number.isFinite(startedAtUnix)) continue;

    // Authoritative ended_at from the database session row
    const endedAtUnix = sessionRow?.endedAt
      ? Math.floor(new Date(sessionRow.endedAt).getTime() / 1000)
      : nowSeconds;

    const payload = liveActivityEndPayload({ startedAtUnix, endedAtUnix });
    console.log("Pushing Live Activity end", {
      shopId: input.shopId,
      session: sessionId,
      bundle: row.bundle_id,
      environment: row.environment,
      token: maskToken(row.token),
    });

    const outcome = await pusher.send(
      {
        token: row.token,
        environment: row.environment,
        bundleId: row.bundle_id,
      } satisfies LiveActivityPushRecord,
      payload,
    );

    if (outcome.kind === "expired") {
      await c.env.DB.prepare("DELETE FROM live_activity_tokens WHERE id=?").bind(row.id).run();
      continue;
    }
    if (outcome.kind === "failed") {
      console.error("Live Activity push failed", {
        shopId: input.shopId,
        status: outcome.status,
        reason: outcome.reason,
      });
      continue;
    }
    if (outcome.kind === "delivered") {
      await c.env.DB.prepare("UPDATE live_activity_tokens SET session_id=NULL, updated_at=? WHERE id=?")
        .bind(new Date().toISOString(), row.id)
        .run();
    }
  }
}

/**
 * Wraps a `forward()` call so that a successful session start or settlement fans out to
 * the player's phones.
 *
 * The response body is read through `clone()` because the caller still has to return the
 * original response; consuming it here would hand the client an empty body.
 */
export async function forwardWithLiveActivity(
  c: C,
  input: { shopId: string; event: "start" | "end" },
  execute: () => Promise<Response>,
): Promise<Response> {
  const response = await execute();
  if (!response.ok || !liveActivityConfig(c.env)) return response;

  let task: Promise<void> | null = null;
  try {
    const payload = (await response.clone().json()) as Record<string, unknown>;
    const sessionIds = extractSessionIds(payload, input.event);
    const playerId = playerIdFromPayload(payload);
    const initiatorClientId = c.req.header("x-prism-client-id") ?? null;
    if (playerId && sessionIds.length > 0) {
      task = pushSessionEvent(c, {
        shopId: input.shopId,
        playerId,
        sessionIds,
        event: input.event,
        initiatorClientId,
      });
    }
  } catch (error) {
    console.error("Live Activity dispatch planning failed", error);
    return response;
  }
  if (!task) return response;

  try {
    c.executionCtx.waitUntil(task);
  } catch {
    void task.catch((error) => console.error("Live Activity push failed", error));
  }
  return response;
}

/**
 * Reads the player from whatever shape the channel returned. Start answers carry
 * `session.playerId`; checkouts carry `playerSettlement.playerId` or per-session details.
 * Resolving from the response is what lets the bot channel — which identifies players by
 * platform identity or card, never by account id — participate without special casing.
 */
export function playerIdFromPayload(payload: Record<string, unknown>): string | null {
  const direct = payload.playerId;
  if (typeof direct === "string" && direct) return direct;
  const session = payload.session as { playerId?: unknown } | undefined;
  if (typeof session?.playerId === "string" && session.playerId) return session.playerId;
  const settlement = payload.playerSettlement as { playerId?: unknown } | undefined;
  if (typeof settlement?.playerId === "string" && settlement.playerId) return settlement.playerId;
  for (const key of ["sessions", "sessionDetails"] as const) {
    const list = payload[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const record = item as { playerId?: unknown };
      if (typeof record?.playerId === "string" && record.playerId) return record.playerId;
    }
  }
  return null;
}

export function playerIdsFromPayload(payload: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const visit = (item: Record<string, unknown>) => {
    const id = playerIdFromPayload(item);
    if (id) ids.add(id);
    for (const key of ["settlements", "sessions", "sessionDetails", "holdings", "grantedAssets", "assetLedgerEntries"] as const) {
      if (Array.isArray(item[key])) for (const child of item[key]) {
        if (child && typeof child === "object") visit(child as Record<string, unknown>);
      }
    }
    for (const key of ["order", "businessItemOrder", "redeemRecord"] as const) {
      const child = item[key];
      if (child && typeof child === "object") visit(child as Record<string, unknown>);
    }
    const preview = item.settlementPreview as { playerId?: unknown } | undefined;
    if (typeof preview?.playerId === "string") ids.add(preview.playerId);
  };
  visit(payload);
  return [...ids];
}
