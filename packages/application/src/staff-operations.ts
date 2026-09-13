import { buildBillTimeline } from "./bill-timeline";
import type { BillTimeline, SettlementAdjustment, ChargeItem, PricingConfig, TimeCapPricingWindow } from "@prism/core";
import type { StaffActiveSessionListItem, StaffPlayerListItem, StaffQueries } from "./query-contracts";

export type LivePricingChargeView = {
  pricingConfigId: string;
  planName: string;
  ruleLabel: string;
  amount: number;
};

export type LivePricingSegmentView = {
  pricingConfigId: string;
  planName: string;
  providerId: string;
  ruleId: string;
  ruleLabel: string;
  actualStartedAt: string;
  actualEndedAt: string;
  ruleTimeRange: { start: string; end: string } | null;
  amount: number;
  intervalCap: number;
  intervalCapReached: boolean;
};

export type LiveGlobalCapWindowView = {
  key: string;
  capConfigId: string;
  capRuleId: string;
  ruleLabel: string;
  windowStartedAt: string;
  windowEndedAt: string;
  priceCap: number;
  paidBefore: number;
  currentAmount: number;
  amountApplied: number;
  priceCapReached: boolean;
  contributions: Array<{
    sessionId: string;
    pricingConfigId: string;
    amount: number;
  }>;
};

export type LiveSessionView = {
  id: string;
  label?: string;
  startedAt: string;
  endedAt: string | null;
  elapsedMinutes: number;
  currentImpact: number | null;
  pricingCharges: LivePricingChargeView[];
  pricingSegments: LivePricingSegmentView[];
  status: "active" | "closed";
};

export type LivePlayerView = {
  timeline?: BillTimeline;
  identities: StaffPlayerListItem["identities"];
  playerId: string;
  displayName: string;
  status: "active" | "disabled" | "banned";
  walletTotal: number;
  stayDurationMinutes: number;
  estimatedTotal: number | null;
  globalCapWindows: LiveGlobalCapWindowView[];
  sessions: LiveSessionView[];
};

export type LiveCheckoutPreview = {
  adjustments?: SettlementAdjustment[];
  settlementPreview: { total: number };
  sessionPreviews: Array<{
    sessionId: string;
    label?: string | null;
    startedAt?: Date;
    endedAt?: Date | null;
    status?: "active" | "closed";
    total: number;
    chargeItems: ChargeItem[];
  }>;
  globalCapWindows?: TimeCapPricingWindow[];
};

export type StaffOperationsService<TCheckoutResult> = {
  listLivePlayers(): Promise<LivePlayerView[]>;
  checkoutAllActivePlayers(): Promise<TCheckoutResult[]>;
};

export type StaffOperationsServiceDependencies<TCheckoutResult> = {
  staffQueries: Pick<StaffQueries, "listPlayers" | "listActiveSessions" | "listLiveSessions">;
  checkout?: {
    previewCheckout?(input: { playerId: string }): Promise<LiveCheckoutPreview>;
    checkout(input: { playerId: string }): Promise<TCheckoutResult>;
  };
  listPricingConfigs?: () => Promise<readonly PricingConfig[]>;
  now: () => Date;
};

export function createStaffOperationsService<TCheckoutResult>(
  dependencies: StaffOperationsServiceDependencies<TCheckoutResult>,
): StaffOperationsService<TCheckoutResult> {
  return {
    async listLivePlayers() {
      const sessions = await (dependencies.staffQueries.listLiveSessions?.() ?? dependencies.staffQueries.listActiveSessions());
      if (!sessions.length) return [];
      const [players, pricingConfigs] = await Promise.all([
        dependencies.staffQueries.listPlayers({ playerIds: [...new Set(sessions.map(s => s.playerId))] }),
        dependencies.listPricingConfigs?.() ?? Promise.resolve([]),
      ]);
      const playerById = new Map(players.map((player) => [player.id, player]));
      const pricingConfigNameById = new Map(pricingConfigs.map((config) => [config.id, config.name]));
      const sessionsByPlayer = new Map<string, StaffActiveSessionListItem[]>();
      for (const session of sessions) {
        const current = sessionsByPlayer.get(session.playerId) ?? [];
        current.push(session);
        sessionsByPlayer.set(session.playerId, current);
      }

      const rows: LivePlayerView[] = [];
      const entries = [...sessionsByPlayer.entries()];
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
        for (;;) {
          const entry = entries[next++];
          if (!entry) return;
          const [playerId, playerSessions] = entry;
          const player = playerById.get(playerId);
          const preview = dependencies.checkout?.previewCheckout
            ? await dependencies.checkout.previewCheckout({ playerId })
            : null;
          const previewBySessionId = new Map(
            (preview?.sessionPreviews ?? []).map((item) => [item.sessionId, item]),
          );
          const activeSessionById = new Set(playerSessions.map((session) => session.id));
          const liveSessions = playerSessions.map(toLiveSession);
          for (const sessionPreview of preview?.sessionPreviews ?? []) {
            if (activeSessionById.has(sessionPreview.sessionId)) continue;
            if (sessionPreview.status !== "closed" || !sessionPreview.startedAt) continue;
            const end = sessionPreview.endedAt ?? dependencies.now();
            liveSessions.push({
              id: sessionPreview.sessionId,
              label: sessionPreview.label,
              startedAt: sessionPreview.startedAt,
              endedAt: sessionPreview.endedAt ?? null,
              elapsedMinutes: Math.max(0, Math.floor((end.getTime() - sessionPreview.startedAt.getTime()) / 60_000)),
              status: "closed",
            });
          }

          const orderedSessions = liveSessions.sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
          rows.push({
            playerId,
            identities: player?.identities ?? [],
            displayName: player?.displayName ?? playerSessions[0]?.playerDisplayName ?? playerId,
            status: player?.status ?? "active",
            walletTotal: player?.walletTotal ?? 0,
            stayDurationMinutes: Math.max(...orderedSessions.map((session) => session.elapsedMinutes)),
            estimatedTotal: preview?.settlementPreview.total ?? null,
            timeline: preview ? buildBillTimeline({
              at: dependencies.now(),
              sessions: orderedSessions.map(session => ({ sessionId: session.id, label: session.label ?? null,
                startedAt: session.startedAt, endedAt: session.endedAt ?? null,
                chargeItems: previewBySessionId.get(session.id)?.chargeItems ?? [] })),
              adjustments: preview.adjustments ?? [], globalCapWindows: preview.globalCapWindows ?? [],
            }) : undefined,
            sessions: orderedSessions.map((session) => {
              const sessionPreview = previewBySessionId.get(session.id);
              return {
                id: session.id,
                label: session.label ?? undefined,
                startedAt: session.startedAt.toISOString(),
                endedAt: session.endedAt?.toISOString() ?? null,
                elapsedMinutes: session.elapsedMinutes,
                currentImpact: sessionPreview?.total ?? null,
                pricingCharges: pricingChargesForSession(
                  sessionPreview?.chargeItems ?? [],
                  pricingConfigNameById,
                ),
                pricingSegments: pricingSegmentsForSession(
                  sessionPreview?.chargeItems ?? [],
                  pricingConfigNameById,
                ),
                status: session.status,
              };
            }),
            globalCapWindows: globalCapWindowsForPlayer(preview?.globalCapWindows ?? []),
          });
        }
      }));

      rows.sort((left, right) =>
        right.stayDurationMinutes - left.stayDurationMinutes
        || left.displayName.localeCompare(right.displayName)
      );
      return rows;
    },

    async checkoutAllActivePlayers() {
      if (!dependencies.checkout) return [];
      const sessions = await dependencies.staffQueries.listActiveSessions();
      const playerIds = [...new Set(sessions.map((session) => session.playerId))];
      const results: TCheckoutResult[] = [];
      for (const playerId of playerIds) {
        results.push(await dependencies.checkout.checkout({ playerId }));
      }
      return results;
    },
  };
}

function toLiveSession(session: StaffActiveSessionListItem): {
  id: string;
  label?: string | null;
  startedAt: Date;
  endedAt?: Date | null;
  elapsedMinutes: number;
  status: "active" | "closed";
} {
  return {
    id: session.id,
    label: session.label,
    startedAt: session.startedAt,
    endedAt: session.endedAt ?? null,
    elapsedMinutes: session.elapsedMinutes,
    status: session.status === "closed" ? "closed" : "active",
  };
}

function pricingChargesForSession(
  chargeItems: readonly ChargeItem[],
  pricingConfigNameById: ReadonlyMap<PricingConfig["id"], PricingConfig["name"]>,
): LivePricingChargeView[] {
  const chargesByKey = new Map<string, LivePricingChargeView>();
  for (const item of chargeItems) {
    const pricingConfigId = item.pricingHistory?.pricingConfigId ?? item.source;
    const ruleLabel = item.label || pricingConfigId;
    const key = `${pricingConfigId}:${ruleLabel}`;
    const existing = chargesByKey.get(key);
    if (existing) {
      existing.amount += item.amount;
      continue;
    }
    chargesByKey.set(key, {
      pricingConfigId,
      planName: pricingConfigNameById.get(pricingConfigId) ?? pricingConfigId,
      ruleLabel,
      amount: item.amount,
    });
  }
  return [...chargesByKey.values()];
}

function pricingSegmentsForSession(
  chargeItems: readonly ChargeItem[],
  pricingConfigNameById: ReadonlyMap<PricingConfig["id"], PricingConfig["name"]>,
): LivePricingSegmentView[] {
  return chargeItems
    .flatMap((item) => {
      const explanation = item.pricingExplanation;
      if (!explanation) return [];
      return [{
        pricingConfigId: explanation.pricingConfigId,
        planName: pricingConfigNameById.get(explanation.pricingConfigId) ?? explanation.pricingConfigId,
        providerId: explanation.providerId,
        ruleId: explanation.ruleId,
        ruleLabel: explanation.ruleLabel,
        actualStartedAt: explanation.period.startedAt.toISOString(),
        actualEndedAt: explanation.period.endedAt.toISOString(),
        ruleTimeRange: explanation.ruleTimeRange,
        amount: item.amount,
        intervalCap: explanation.intervalCap,
        intervalCapReached: explanation.intervalCapReached,
      }];
    })
    .sort((left, right) => left.actualStartedAt.localeCompare(right.actualStartedAt));
}

function globalCapWindowsForPlayer(
  windows: readonly TimeCapPricingWindow[],
): LiveGlobalCapWindowView[] {
  return windows.map((window) => ({
    key: window.key,
    capConfigId: window.capConfigId,
    capRuleId: window.capRuleId,
    ruleLabel: window.ruleLabel,
    windowStartedAt: window.windowStartedAt.toISOString(),
    windowEndedAt: window.windowEndedAt.toISOString(),
    priceCap: window.priceCap,
    paidBefore: window.paidBefore,
    currentAmount: window.currentAmount,
    amountApplied: window.amountApplied,
    priceCapReached: window.paidBefore + window.amountApplied >= window.priceCap,
    contributions: window.contributions.map((contribution) => ({ ...contribution })),
  }));
}
