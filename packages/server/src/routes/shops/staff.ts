import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { staffPrincipal } from "../../middleware/auth.js";
import { staffMeView } from "./staff-me-view.js";
import { confirmPlatformBinding } from "./binding.js";
import { getShop, getShopDeps } from "../../middleware/tenant.js";
import { runPlayerOperation } from "./player-operation.js";
import { withPrismAccountIdentities } from "./shop-player-identities.js";
import {
  toGrantAssetsView,
  toPlayerAssetsView,
  toPlayerCheckoutPreviewView,
  toPlayerCheckoutResultView,
  toPlayerIdentityView,
  toPlayerManagementView,
  toStaffPlayerListView,
  toPlayerRedeemRecordsView,
  toSessionHistoryDetailView,
  toSessionHistoryView,
  toSessionView,
  toBillingChangeView,
  toRosterView,
  toStaffActiveSessionView,
  toStaffReportPlayerView,
  toStaffReportSettlementView,
  toStaffReportsSummaryView,
  toStoppedSessionView,
} from "./views.js";

export const staffRouter = new Hono<AppBindings>();

// Only serialize the historic staff API view, not the authentication principal.
staffRouter.get("/me", async (c) => {
  const shop = getShop(c);
  const principal = await staffPrincipal(c, shop, true);
  return c.json({ staff: await staffMeView(c, shop, principal) });
});

// List Players
staffRouter.get("/players", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  const players = await deps.staffQueries.listPlayers();
  const data = await withPrismAccountIdentities(c.env.DB, shop.id, {
    players: players.map(toStaffPlayerListView),
  }) as { players: unknown[] };
  return c.json(data);
});

// Standalone and tenant-scoped staff browser billing preview inputs.
staffRouter.get("/players/:playerId/billing-inputs", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const playerId = c.req.param("playerId");
  const deps = getShopDeps(c);
  const found = await deps.staffQueries.listPlayers({ playerIds: [playerId] });
  if (!found.length) jsonError(404, "Player not found.", "PLAYER_NOT_FOUND");
  if (!deps.staffLiveBillingSnapshot) jsonError(503, "Client billing is unavailable for this runtime.", "CLIENT_BILLING_UNAVAILABLE");
  return c.json({ playerId, billingSnapshot: await deps.staffLiveBillingSnapshot([playerId]) });
});

// Create Player
staffRouter.post("/players", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const body = await c.req.json<{ displayName: string; externalIdentity?: any }>();
  if (!body.displayName?.trim()) {
    jsonError(400, "玩家昵称不能为空", "PLAYER_NAME_REQUIRED");
  }
  const player = await deps.staffPlayerCommands.createPlayer(body);
  return c.json({ player: toPlayerManagementView(player) }, 201);
});

// Update Player Status
staffRouter.patch("/players/:playerId/status", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const body = await c.req.json<{ status: "active" | "disabled" }>();
  const player = await deps.staffPlayerCommands.updatePlayerStatus({
    playerId: c.req.param("playerId"),
    status: body.status,
  });
  return c.json({ player: toPlayerManagementView(player) });
});

// Player Assets
staffRouter.get("/players/:playerId/assets", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  const assets = deps.staffQueries.getPlayerAssets
    ? await deps.staffQueries.getPlayerAssets(c.req.param("playerId"))
    : deps.playerQueries.listPlayerAssets
      ? await deps.playerQueries.listPlayerAssets(c.req.param("playerId"))
      : { holdings: [], ledgerEntries: [] };
  return c.json(toPlayerAssetsView(assets));
});

// Grant Assets
staffRouter.post("/players/:playerId/assets/grants", async (c) => {
  const shop = getShop(c);
  const staff = await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const body = await c.req.json<{ grants: any[]; reason?: string }>();
  return runPlayerOperation(c, shop.id, `staff/players/${c.req.param("playerId")}/assets/grants`, body, async () => {
    const result = await deps.staffAssetCommands.grantAssets({
      staffId: staff.staffId,
      playerId: c.req.param("playerId"),
      grants: (body.grants ?? []).map((g) => ({
        ...g,
        activeAt: g.activeAt ? new Date(g.activeAt) : undefined,
        expiresAt: g.expiresAt ? new Date(g.expiresAt) : undefined,
      })),
    });
    return c.json(toGrantAssetsView(result));
  });
});

// Adjust Assets
staffRouter.post("/players/:playerId/assets/adjustments", async (c) => {
  const shop = getShop(c);
  const staff = await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const body = await c.req.json<{ adjustments: any[] }>();
  const result = await deps.staffAssetCommands.adjustAssets({
    staffId: staff.staffId,
    playerId: c.req.param("playerId"),
    adjustments: (body.adjustments ?? []).map((a) => ({
      ...a,
      activeAt: a.activeAt ? new Date(a.activeAt) : undefined,
      expiresAt: a.expiresAt ? new Date(a.expiresAt) : undefined,
    })),
  });
  return c.json(toGrantAssetsView(result));
});

// Adjust Wallet
staffRouter.post("/players/:playerId/wallet/adjustment", async (c) => {
  const shop = getShop(c);
  const staff = await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const body = await c.req.json<{ amount: number; reason?: string }>();
  if (!deps.staffAssetCommands.adjustWallet) {
    jsonError(503, "Staff asset commands are not configured.", "STAFF_ASSET_COMMANDS_NOT_CONFIGURED");
  }
  return runPlayerOperation(c, shop.id, `staff/players/${c.req.param("playerId")}/wallet/adjustment`, body, async () => {
    const result = await deps.staffAssetCommands.adjustWallet({
      staffId: staff.staffId,
      playerId: c.req.param("playerId"),
      amount: body.amount,
      reason: body.reason ?? "wallet adjustment",
    });
    return c.json(result);
  });
});

// Add Player Identity
staffRouter.post("/players/:playerId/identities", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const body = await c.req.json<{ provider: string; subject: string }>();
  const identity = await deps.staffPlayerCommands.bindPlayerIdentity({
    playerId: c.req.param("playerId"),
    provider: body.provider,
    subject: body.subject,
  });
  return c.json({ identity: toPlayerIdentityView(identity) }, 201);
});

// Remove Player Identity
staffRouter.delete("/players/:playerId/identities/:provider/:subject", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  await deps.staffPlayerCommands.deletePlayerIdentity({
    playerId: c.req.param("playerId"),
    provider: c.req.param("provider"),
    subject: c.req.param("subject"),
  });
  return c.json({ ok: true });
});

type PlanStartBody = { pricingConfigId?: unknown; pricingConfigIds?: unknown; expectedRevision?: unknown };

/** The plan a staff start names, or undefined for the shop's default plan. */
function namedPlan(body: PlanStartBody): string | undefined {
  const named = typeof body.pricingConfigId === "string" && body.pricingConfigId
    ? [body.pricingConfigId]
    : Array.isArray(body.pricingConfigIds) ? body.pricingConfigIds.filter((id): id is string => typeof id === "string") : [];
  if (named.length > 1) jsonError(400, "一次只能开始一个计费方案", "PRICING_CONFIG_SINGLE_PLAN_REQUIRED");
  return named[0];
}

// Preview a plan start: what would start, stop and keep.
staffRouter.post("/players/:playerId/session/preview", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const body = (await c.req.json<PlanStartBody>().catch(() => ({}))) as PlanStartBody;
  const pricingConfigId = namedPlan(body);
  const preview = await getShopDeps(c).resourceBilling.preview({
    playerId: c.req.param("playerId"),
    ...(pricingConfigId ? { pricingConfigId } : {}),
  });
  return c.json({
    pricingConfigId: preview.pricingConfigId,
    planName: preview.planName,
    revision: preview.revision,
    ...toBillingChangeView(preview),
  });
});

// Start Session: the plan staff named; there is no default plan to fall back on.
staffRouter.post("/players/:playerId/session/start", async (c) => {
  const shop = getShop(c);
  const staff = await staffPrincipal(c, shop);
  const body = (await c.req.json<PlanStartBody>().catch(() => ({}))) as PlanStartBody;
  const pricingConfigId = namedPlan(body);
  if (body.expectedRevision !== undefined && typeof body.expectedRevision !== "string") {
    jsonError(400, "计费确认无效", "VALIDATION_FAILED");
  }
  const result = await getShopDeps(c).resourceBilling.activate({
    playerId: c.req.param("playerId"),
    ...(pricingConfigId ? { pricingConfigId } : {}),
    ...(typeof body.expectedRevision === "string" ? { expectedRevision: body.expectedRevision } : {}),
    metadata: { createdBy: "staff", staffId: staff.staffId },
  });
  return c.json({ session: toSessionView(result.session), billing: toBillingChangeView(result) });
});

// Stop Session
staffRouter.post("/players/:playerId/sessions/:sessionId/stop", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const session = await deps.staffCheckoutCommands.stopSession({
    playerId: c.req.param("playerId"),
    sessionId: c.req.param("sessionId"),
  });
  return c.json(toStoppedSessionView(session));
});

// Preview Checkout
staffRouter.post("/players/:playerId/checkout/preview", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const result = await deps.staffCheckoutCommands.previewCheckout({
    playerId: c.req.param("playerId"),
  });
  return c.json(toPlayerCheckoutPreviewView(result));
});

// Confirm Checkout
staffRouter.post("/players/:playerId/checkout/confirm", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  return runPlayerOperation(c, shop.id, `staff/players/${c.req.param("playerId")}/checkout/confirm`, body, async () => {
    const result = await deps.staffCheckoutCommands.checkout({
      playerId: c.req.param("playerId"),
    });
    return c.json(toPlayerCheckoutResultView(result));
  });
});

// Override Checkout
staffRouter.post("/players/:playerId/checkout/override", async (c) => {
  const shop = getShop(c);
  const staff = await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const body = z.object({
    sessionId: z.string().optional(),
    finalTotal: z.number().finite().nonnegative(),
    reason: z.string().trim().min(1),
    previewedAt: z.string().optional(),
    expectedSubtotal: z.number().finite().optional(),
    expectedTotal: z.number().finite().optional(),
    operationId: z.string().optional(),
  }).parse(await c.req.json());
  return runPlayerOperation(c, shop.id, `staff/players/${c.req.param("playerId")}/checkout/override`, body, async () => {
    const result = await deps.staffCheckoutCommands.checkoutWithOverride({
      staffId: staff.staffId,
      playerId: c.req.param("playerId"),
      total: body.finalTotal,
      reason: body.reason,
      closeSessionsBeforeBalanceCheck: false,
    });
    return c.json(toPlayerCheckoutResultView(result));
  });
});

// Recharge the paid wallet and settle in one atomic checkout transaction.
staffRouter.post("/players/:playerId/checkout/recharge", async (c) => {
  const shop = getShop(c);
  const staff = await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const body = z.object({
    amount: z.number().finite().positive(),
    operationId: z.string().uuid(),
  }).parse(await c.req.json());
  return runPlayerOperation(c, shop.id, `staff/players/${c.req.param("playerId")}/checkout/recharge`, body, async () => {
    const result = await deps.staffCheckoutCommands.checkoutWithRecharge({
      staffId: staff.staffId,
      playerId: c.req.param("playerId"),
      amount: body.amount,
    });
    return c.json(toPlayerCheckoutResultView(result));
  });
});

// Player Session History
staffRouter.get("/players/:playerId/sessions/history", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  if (!deps.playerQueries.listPlayerSessionHistory) {
    jsonError(503, "Player session history queries are not configured.", "PLAYER_SESSION_HISTORY_QUERIES_NOT_CONFIGURED");
  }
  const sessions = await deps.playerQueries.listPlayerSessionHistory(c.req.param("playerId"));
  return c.json(toSessionHistoryView(sessions));
});

// Player Session History Detail
staffRouter.get("/players/:playerId/sessions/:sessionId/history", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  if (!deps.playerQueries.getPlayerSessionHistoryDetail) {
    jsonError(503, "Player session history queries are not configured.", "PLAYER_SESSION_HISTORY_QUERIES_NOT_CONFIGURED");
  }
  const detail = await deps.playerQueries.getPlayerSessionHistoryDetail(
    c.req.param("playerId"),
    c.req.param("sessionId"),
  );
  if (!detail) {
    jsonError(404, "Session not found.", "SESSION_NOT_FOUND");
  }
  return c.json(toSessionHistoryDetailView(detail));
});

// Player Redeem Records
staffRouter.get("/players/:playerId/redeem-records", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  const records = deps.staffQueries.listPlayerRedeemRecords
    ? await deps.staffQueries.listPlayerRedeemRecords(c.req.param("playerId"))
    : [];
  return c.json(toPlayerRedeemRecordsView(records));
});

// Live Players
staffRouter.get("/live-players", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  // The browser expects grouped LivePlayerView objects (including sessions[]),
  // not the flat StaffActiveSessionListItem rows returned by listLiveSessions().
  // Flat rows caused a render-time TypeError and an entirely white /live page.
  const players = await deps.staffOperations.listLivePlayers({ summary: true });
  const billingSnapshot = players.length && deps.staffLiveBillingSnapshot
    ? await deps.staffLiveBillingSnapshot(players.map((player) => player.playerId))
    : undefined;
  // Where each person is listed: the resource they occupy or their most specific plan.
  const roster = toRosterView(await deps.roster.list());
  const data = await withPrismAccountIdentities(c.env.DB, shop.id, {
    players, roster, ...(billingSnapshot ? { billingSnapshot } : {}),
  });
  return c.json(data);
});

// Who is in the shop, each listed once; with `?name=`, one resource or one plan only.
staffRouter.get("/roster", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  const name = c.req.query("name")?.trim();
  if (!name) return c.json(toRosterView(await deps.roster.list()));
  const roster = await deps.roster.only(name);
  if (!roster) jsonError(404, `找不到「${name}」`, "ROSTER_TARGET_NOT_FOUND");
  return c.json(toRosterView(roster));
});

// Active Sessions
staffRouter.get("/sessions/active", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  const sessions = await deps.staffQueries.listActiveSessions();
  return c.json({ sessions: sessions.map(toStaffActiveSessionView) });
});

// Reports Summary
staffRouter.get("/reports/summary", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  const from = c.req.query("from") ? new Date(c.req.query("from")!) : new Date(Date.now() - 30 * 86400000);
  const to = c.req.query("to") ? new Date(c.req.query("to")!) : new Date();
  if (!deps.staffQueries.getReportsSummary) {
    return c.json(toStaffReportsSummaryView({
      from,
      to,
      revenueTotal: 0 as any,
      sessionCount: 0,
      assetGrantTotal: 0,
      coinCommandCount: 0,
    }));
  }
  const summary = await deps.staffQueries.getReportsSummary({ from, to });
  return c.json(toStaffReportsSummaryView(summary));
});

// Settlement Reports
staffRouter.get("/reports/settlements", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  const from = c.req.query("from") ? new Date(c.req.query("from")!) : new Date(0);
  const to = c.req.query("to") ? new Date(c.req.query("to")!) : new Date();
  const offset = Number(c.req.query("offset") ?? 0);
  const limit = Number(c.req.query("limit") ?? 50);
  const settlements = deps.staffQueries.listReportSettlements
    ? await deps.staffQueries.listReportSettlements({ from, to, offset, limit })
    : [];
  return c.json({ settlements: settlements.map(toStaffReportSettlementView) });
});

// Player Reports
staffRouter.get("/reports/players", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  const from = c.req.query("from") ? new Date(c.req.query("from")!) : new Date(0);
  const to = c.req.query("to") ? new Date(c.req.query("to")!) : new Date();
  const offset = Number(c.req.query("offset") ?? 0);
  const limit = Number(c.req.query("limit") ?? 50);
  const players = deps.staffQueries.listReportPlayers
    ? await deps.staffQueries.listReportPlayers({ from, to, offset, limit })
    : [];
  return c.json({ players: players.map(toStaffReportPlayerView) });
});

// Checkout Reports: retain the paginated, archivable contract of server-hono.
staffRouter.get("/reports/checkouts", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  const from = c.req.query("from") ? new Date(c.req.query("from")!) : null;
  const to = c.req.query("to") ? new Date(c.req.query("to")!) : null;
  if (!from || !to || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
    jsonError(400, "请选择有效日期", "INVALID_REPORT_RANGE");
  }
  const archive = c.req.query("archive") ?? "active";
  if (archive !== "active" && archive !== "archived" && archive !== "all") {
    jsonError(400, "无效的归档筛选", "INVALID_REPORT_FILTER");
  }
  if (!deps.staffQueries.listReportCheckouts) {
    jsonError(503, "Report queries are not configured.", "STAFF_REPORT_QUERIES_NOT_CONFIGURED");
  }
  const rawOffset = Number(c.req.query("offset") ?? 0);
  const rawLimit = Number(c.req.query("limit") ?? 50);
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
  const records = await deps.staffQueries.listReportCheckouts({ from, to, archive, offset, limit: limit + 1 });
  return c.json({
    records: records.slice(0, limit),
    page: { limit, offset, hasMore: records.length > limit },
  });
});

staffRouter.post("/reports/checkouts/:checkoutId/archive", async (c) => {
  const shop = getShop(c);
  const principal = await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  if (!deps.staffReportCommands) {
    jsonError(503, "Report commands are not configured.", "STAFF_REPORT_COMMANDS_NOT_CONFIGURED");
  }
  const body = (await c.req.json<{ archived?: unknown }>().catch(() => ({}))) as { archived?: unknown };
  if (typeof body.archived !== "boolean") {
    jsonError(400, "无效的归档状态", "INVALID_REQUEST");
  }
  await deps.staffReportCommands.setArchived({
    checkoutId: c.req.param("checkoutId"),
    archived: body.archived,
    staffId: principal.staffId,
  });
  return c.json({ archived: body.archived });
});

// Checkout Report Detail
staffRouter.get("/reports/checkouts/:checkoutId", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  const detail = deps.staffQueries.getReportCheckout
    ? await deps.staffQueries.getReportCheckout(c.req.param("checkoutId"))
    : null;
  if (!detail) {
    jsonError(404, "Checkout report not found.", "CHECKOUT_REPORT_NOT_FOUND");
  }
  return c.json(detail);
});

// Platform Binding Confirm
staffRouter.post("/platform-binding/confirm", async (c) => {
  const shop = getShop(c);
  const principal = await staffPrincipal(c, shop);
  if (principal.staffRole === "viewer") {
    jsonError(403, "没有玩家管理权限", "FORBIDDEN");
  }
  return confirmPlatformBinding(c, shop, "staff");
});
