import {
  addCents,
  maxCents,
  priorityTimePricingWindowAt,
  timeCapPricingWindowAt,
  yuanOf,
  ZERO_CENTS,
  type Cents,
  type ChargeItem,
  type PricingCapHistoryRepository,
  type PricingConfig,
  type PricingHistoryRepository,
  type TimeCapPricingWindow,
} from "@prism/core";
import { capProviderConfig, capTimePlanIds, historyVersionedConfig } from "./versioned-pricing";

/** How far a cap is used up: what it allows in its current window and what was charged there before now. */
export type CapProgressItem = {
  pricingConfigId: string;
  ruleId: string;
  ruleLabel: string;
  priceCap: number;
  paidBefore: number;
  startsAt: Date;
  endsAt: Date;
};

export type CapProgress = {
  /** What the player's unsettled bill comes to now, after every cap. */
  unsettled: number;
  /** Each plan's own cap, for the period it is in now; an uncapped period has none. */
  plans: CapProgressItem[];
  /** Caps across plans that include any of them. */
  shared: Array<CapProgressItem & { name: string; includedPricingConfigIds: string[]; config: Extract<PricingConfig, { kind: "time.cap" }> }>;
};

/**
 * The caps a player is under at `at` for some plans, counting what was settled
 * in each window and what the player's running sessions have charged there so far.
 */
export async function capProgressAt(input: {
  configs: readonly PricingConfig[];
  planIds: readonly string[];
  timeZone: string;
  playerId: string | null;
  at: Date;
  pricingHistory: Pick<PricingHistoryRepository, "sumByPlayerAndKeys">;
  pricingCapHistory: Pick<PricingCapHistoryRepository, "sumByPlayerAndKeys">;
  /** The player's unsettled bill, when sessions are running. */
  running?: {
    chargeItems: readonly ChargeItem[];
    globalCapWindows: readonly TimeCapPricingWindow[];
    settlementPreview: { total: Cents };
  } | null;
}): Promise<CapProgress> {
  const wanted = new Set(input.planIds);
  const planWindows = input.configs.flatMap((config) => {
    if (config.kind !== "time.priority" || !wanted.has(config.id)) return [];
    const versioned = historyVersionedConfig(config) as typeof config;
    const window = priorityTimePricingWindowAt({
      config: { ...versioned.provider, timeZone: versioned.provider.timeZone ?? input.timeZone, pricingConfigId: config.id },
      at: input.at,
    });
    return window && window.priceCap > 0 ? [{ config, window }] : [];
  });
  const capWindows = input.configs.flatMap((config) => {
    if (config.kind !== "time.cap" || !config.enabled || config.status === "archived") return [];
    const window = timeCapPricingWindowAt({ config: capProviderConfig(config, input.timeZone, capTimePlanIds(input.configs)), at: input.at });
    return window ? [{ config, window }] : [];
  });
  const none: Record<string, Cents> = {};
  const playerId = input.playerId;
  const [settled, settledCaps] = await Promise.all([
    playerId && planWindows.length ? input.pricingHistory.sumByPlayerAndKeys(playerId, planWindows.map(({ window }) => window.lookup)) : none,
    playerId && capWindows.length ? input.pricingCapHistory.sumByPlayerAndKeys(playerId, capWindows.map(({ window }) => window.lookup)) : none,
  ]);
  const charged = new Map<string, Cents>();
  for (const item of input.running?.chargeItems ?? []) {
    const history = item.pricingHistory;
    if (!history) continue;
    const key = `${history.pricingConfigId}@${history.providerId}@${history.ruleId}@${history.ruleAnchorAt.toISOString()}`;
    charged.set(key, addCents(charged.get(key) ?? ZERO_CENTS, history.amount));
  }
  const item = (pricingConfigId: string, window: { ruleId: string; ruleLabel: string; priceCap: number; endsAt: Date }, startsAt: Date, paid: Cents): CapProgressItem => ({
    pricingConfigId,
    ruleId: window.ruleId,
    ruleLabel: window.ruleLabel,
    priceCap: window.priceCap,
    paidBefore: yuanOf(paid),
    startsAt,
    endsAt: window.endsAt,
  });
  return {
    unsettled: yuanOf(input.running?.settlementPreview.total ?? ZERO_CENTS),
    plans: planWindows.map(({ config, window }) =>
      item(config.id, window, window.lookup.ruleAnchorAt, addCents(settled[window.lookup.key] ?? ZERO_CENTS, charged.get(window.lookup.key) ?? ZERO_CENTS))),
    shared: capWindows.map(({ config, window }) => {
      const running = input.running?.globalCapWindows.find((candidate) => candidate.key === window.lookup.key);
      const paid = addCents(settledCaps[window.lookup.key] ?? ZERO_CENTS, maxCents(ZERO_CENTS, running?.amountApplied ?? ZERO_CENTS));
      return {
        ...item(config.id, window, window.lookup.capAnchorAt, paid),
        name: config.name,
        includedPricingConfigIds: capTimePlanIds(input.configs),
        config,
      };
    }),
  };
}
