import {
  addCents,
  isPositiveCents,
  maxCents,
  settleTimeCaps,
  sumCents,
  ZERO_CENTS,
  type Cents,
  type ChargeItem,
  type SettlementAdjustment,
  type TimeCapPricingProviderConfig,
  type TimeCapPricingWindow,
} from "@prism/core";

/**
 * One answer to "what does this set of sessions cost": the sessions' own
 * quotes, then every cap over them settled together.
 *
 * Checkout and the shop's simulator both come through here, so a cap behaves
 * the same in a simulation as it does on a bill. A cap's plan list is filled
 * from the time plans it holds; the stored list is empty (a cap holds every
 * time plan), and settling with that empty list would let every charge through.
 */
export function settleSessionsWithCaps(input: {
  /** Per session, its quotes; the session id is filled in on each charge. */
  sessions: readonly { sessionId: string; chargeItems: readonly ChargeItem[] }[];
  /** Every cap across plans in force, exactly as settlement builds it. */
  caps: readonly TimeCapPricingProviderConfig[];
  /** What each cap window counted before these charges, from settlement history. */
  paidHistory?: Record<string, Cents>;
}): {
  chargeItems: ChargeItem[];
  windows: TimeCapPricingWindow[];
  adjustments: SettlementAdjustment[];
  /** What each charge is charged after every cap, for period history. */
  chargedByItem: Map<string, Cents>;
  subtotal: Cents;
  total: Cents;
} {
  const chargeItems = input.sessions.flatMap((session) =>
    session.chargeItems.map((item) => (item.sessionId ? item : { ...item, sessionId: session.sessionId })),
  );
  const settlement = settleTimeCaps({
    configs: input.caps,
    chargeItems,
    ...(input.paidHistory ? { paidHistory: input.paidHistory } : {}),
  });
  const chargedByItem = new Map<string, Cents>();
  for (const unit of settlement.units) {
    chargedByItem.set(unit.item.id, addCents(chargedByItem.get(unit.item.id) ?? ZERO_CENTS, unit.charged));
  }
  const subtotal = sumCents(chargeItems.map((item) => item.amount));
  const total = maxCents(ZERO_CENTS, addCents(subtotal, sumCents(settlement.adjustments.map((item) => item.amount))));
  return { chargeItems, windows: settlement.windows, adjustments: settlement.adjustments, chargedByItem, subtotal, total };
}

/** Whether a bill still has anything to charge after its caps. */
export const hasCharge = (items: readonly ChargeItem[]) =>
  items.some((item) => isPositiveCents(item.amount));
