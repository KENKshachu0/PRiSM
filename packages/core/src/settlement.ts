import type { AssetHolding, AssetLedgerEntry } from "./assets";
import { PrismDomainError } from "./errors";
import {
  type Cents,
  addCents,
  centsOf,
  compareCents,
  isNegativeCents,
  isPositiveCents,
  isZeroCents,
  minCents,
  negCents,
  subCents,
  sumCents,
  compareMoney,
  isNegativeQuantity,
  isPositiveQuantity,
  isZeroQuantity,
  normalizeQuantity,
  quantizeMoney,
  sumMoney,
} from "./money";
import type { PricingSegmentExplanation } from "./pricing-time";
import type { Session } from "./session";

export type ChargeItem = {
  id: string;
  sessionId?: string;
  source: string;
  label: string;
  amount: number;
  period?: {
    startedAt: Date;
    endedAt: Date;
  };
  pricingHistory?: PricingHistoryContribution;
  pricingExplanation?: PricingSegmentExplanation;
};

export type PricingHistoryContribution = {
  pricingConfigId: string;
  providerId: string;
  ruleId: string;
  ruleAnchorAt: Date;
  amount: number;
};

export type SettlementAdjustment = {
  id: string;
  source: string;
  label: string;
  amount: number;
  pricingCapHistory?: PricingCapHistoryContribution;
};

export type PricingCapHistoryContribution = {
  capConfigId: string;
  capRuleId: string;
  capAnchorAt: Date;
  includedPricingConfigIds: string[];
  amount: number;
};

export type PastAppliedAdjustment = {
  readonly source: string;
  readonly sessionStartedAt: Date;
};

export type Settlement = {
  sessionId: string;
  subtotal: Cents;
  total: Cents;
  status: "settled";
  settledAt: Date;
};

export type PlayerCheckout = {
  id: string;
  playerId: string;
  subtotal: number;
  total: number;
  status: "settled";
  settledAt: Date;
};

export type SettlementRecord = {
  settlement: Settlement;
  chargeItems: ChargeItem[];
  adjustments: SettlementAdjustment[];
};

export type SettlementPreview = {
  sessionId: string;
  subtotal: Cents;
  total: Cents;
  status: "preview";
  previewedAt: Date;
};

export type PricingContext = {
  session: Session;
  assetHoldings: readonly AssetHolding[];
  now: Date;
};

export type PricingProvider = {
  id: string;
  quote(context: PricingContext): ChargeItem[] | Promise<ChargeItem[]>;
};

export type AssetEffectContext = {
  session: Session;
  chargeItems: readonly ChargeItem[];
  assetHoldings: readonly AssetHolding[];
  subtotal: number;
  now: Date;
  timeZone?: string;
  pastAppliedAdjustments?: readonly PastAppliedAdjustment[];
};

export type AssetEffectProvider = {
  id: string;
  apply(context: AssetEffectContext): SettlementAdjustment[] | Promise<SettlementAdjustment[]>;
};

export type SettleSessionInput = {
  session: Session;
  pricingProviders: readonly PricingProvider[];
  assetEffectProviders?: readonly AssetEffectProvider[];
  assetHoldings: readonly AssetHolding[];
  now: Date;
  overrideTotal?: {
    total: number;
    id: string;
    source: string;
    label: string;
  };
  timeZone?: string;
  pastAppliedAdjustments?: readonly PastAppliedAdjustment[];
};

export type SettleSessionResult = {
  settlement: Settlement;
  chargeItems: ChargeItem[];
  adjustments: SettlementAdjustment[];
  assetLedgerEntries: AssetLedgerEntry[];
  assetHoldings: AssetHolding[];
};

export type PreviewSessionSettlementResult = {
  settlementPreview: SettlementPreview;
  chargeItems: ChargeItem[];
  adjustments: SettlementAdjustment[];
  assetHoldings: AssetHolding[];
};

const CURRENCY_DEDUCTION_ORDER = ["free", "paid"];

export async function settleSession(input: SettleSessionInput): Promise<SettleSessionResult> {
  const assetHoldings = input.assetHoldings.map((account) => ({ ...account }));
  const quote = await quoteSessionSettlement(input, availableHoldingsAt(assetHoldings, input.now));
  const { chargeItems, subtotal, adjustments, total } = applyOverride(input, quote);
  // The pricing engine works in yuan and owns the persisted cap history, so it
  // stays yuan; the settled amounts and the holdings they are paid from are
  // cents. This call is the boundary between the two.
  const subtotalCents = centsOf(subtotal);
  const totalCents = centsOf(total);
  const assetLedgerEntries = deductCurrency(assetHoldings, {
    amount: totalCents,
    reason: "session.settlement",
    refId: input.session.id,
    now: input.now,
  });

  return {
    settlement: {
      sessionId: input.session.id,
      subtotal: subtotalCents,
      total: totalCents,
      status: "settled",
      settledAt: input.now,
    },
    chargeItems,
    adjustments,
    assetLedgerEntries,
    assetHoldings,
  };
}

export async function previewSessionSettlement(input: SettleSessionInput): Promise<PreviewSessionSettlementResult> {
  const assetHoldings = input.assetHoldings.map((account) => ({ ...account }));
  const { chargeItems, subtotal, adjustments, total } = await quoteSessionSettlement(
    input,
    availableHoldingsAt(assetHoldings, input.now),
  );

  return {
    settlementPreview: {
      sessionId: input.session.id,
      subtotal: centsOf(subtotal),
      total: centsOf(total),
      status: "preview",
      previewedAt: input.now,
    },
    chargeItems,
    adjustments,
    assetHoldings,
  };
}

function applyOverride(
  input: SettleSessionInput,
  quote: {
    chargeItems: ChargeItem[];
    subtotal: number;
    adjustments: SettlementAdjustment[];
    total: number;
  },
): {
  chargeItems: ChargeItem[];
  subtotal: number;
  adjustments: SettlementAdjustment[];
  total: number;
} {
  if (!input.overrideTotal) return quote;

  const overrideTotal = quantizeMoney(input.overrideTotal.total);
  if (!Number.isFinite(overrideTotal) || isNegativeQuantity(overrideTotal)) {
    throw new PrismDomainError("Override total must be a non-negative finite number.", "INVALID_OVERRIDE_TOTAL");
  }

  const amount = quantizeMoney(overrideTotal - quote.total);
  return {
    chargeItems: quote.chargeItems,
    subtotal: quote.subtotal,
    adjustments: [
      ...quote.adjustments,
      {
        id: input.overrideTotal.id,
        source: input.overrideTotal.source,
        label: input.overrideTotal.label,
        amount,
      },
    ],
    total: overrideTotal,
  };
}

async function quoteSessionSettlement(
  input: SettleSessionInput,
  assetHoldings: readonly AssetHolding[],
): Promise<{
  chargeItems: ChargeItem[];
  subtotal: number;
  adjustments: SettlementAdjustment[];
  total: number;
}> {
  const chargeItems = await collectChargeItems(input, assetHoldings);
  const subtotal = sumCharges(chargeItems);
  const adjustments = await collectAdjustments(input, assetHoldings, chargeItems, subtotal);
  const total = applyAdjustments(subtotal, adjustments);
  return { chargeItems, subtotal, adjustments, total };
}

async function collectChargeItems(
  input: SettleSessionInput,
  assetHoldings: readonly AssetHolding[],
): Promise<ChargeItem[]> {
  const chargeItems: ChargeItem[] = [];

  for (const provider of input.pricingProviders) {
    const quoted = await provider.quote({
      session: input.session,
      assetHoldings: assetHoldings.map((account) => ({ ...account })),
      now: input.now,
    });
    chargeItems.push(...quoted);
  }

  return chargeItems;
}

async function collectAdjustments(
  input: SettleSessionInput,
  assetHoldings: readonly AssetHolding[],
  chargeItems: readonly ChargeItem[],
  subtotal: number,
): Promise<SettlementAdjustment[]> {
  const adjustments: SettlementAdjustment[] = [];

  for (const provider of input.assetEffectProviders ?? []) {
    const applied = await provider.apply({
      session: input.session,
      chargeItems: chargeItems.map((item) => ({ ...item })),
      assetHoldings: assetHoldings.map((account) => ({ ...account })),
      subtotal,
      now: input.now,
      timeZone: input.timeZone,
      pastAppliedAdjustments: input.pastAppliedAdjustments,
    });
    adjustments.push(...applied);
  }

  return adjustments;
}

function sumCharges(chargeItems: readonly ChargeItem[]): number {
  for (const item of chargeItems) {
    if (!Number.isFinite(item.amount)) {
      throw new PrismDomainError("Charge item amount must be a finite number.", "INVALID_CHARGE_AMOUNT");
    }
  }
  return sumMoney(chargeItems.map((item) => item.amount));
}

function applyAdjustments(subtotal: number, adjustments: readonly SettlementAdjustment[]): number {
  let total = subtotal;
  for (const adjustment of adjustments) {
    if (!Number.isFinite(adjustment.amount)) {
      throw new PrismDomainError("Settlement adjustment amount must be finite.", "INVALID_ADJUSTMENT_AMOUNT");
    }
    total += adjustment.amount;
  }
  return normalizeQuantity(Math.max(0, total));
}

export function deductCurrency(
  assetHoldings: AssetHolding[],
  input: {
    amount: Cents;
    reason: string;
    refId: string;
    now: Date;
  },
): AssetLedgerEntry[] {
  const requested = input.amount;
  if (isZeroCents(requested)) return [];

  const currencyAccounts: AssetHolding[] = [];
  for (const account of assetHoldings) {
    if (account.assetType !== "currency") continue;
    // Quantities are exact integers now, so there is no residue to canonicalise:
    // a balance of zero is zero, and every positive balance is spendable.
    if (!isPositiveCents(account.quantity)) continue;
    if (!isHoldingAvailableAt(account, input.now)) continue;
    currencyAccounts.push(account);
  }

  currencyAccounts.sort((a, b) => {
    const aIndex = CURRENCY_DEDUCTION_ORDER.indexOf(normalizeCurrencyCode(a.assetCode));
    const bIndex = CURRENCY_DEDUCTION_ORDER.indexOf(normalizeCurrencyCode(b.assetCode));
    return normalizeOrder(aIndex) - normalizeOrder(bIndex);
  });

  // Exact integer comparison: no tolerance, because two integers cannot be
  // "close but unequal".
  const available = sumCents(currencyAccounts.map((account) => account.quantity));
  if (compareCents(available, requested) < 0) {
    throw new PrismDomainError("Insufficient currency holdings for this operation.", "INSUFFICIENT_BALANCE");
  }

  let remaining = requested;
  const entries: AssetLedgerEntry[] = [];

  for (const account of currencyAccounts) {
    if (!isPositiveCents(remaining)) break;

    const deducted = minCents(account.quantity, remaining);
    account.quantity = subCents(account.quantity, deducted);
    remaining = subCents(remaining, deducted);
    entries.push({
      assetType: account.assetType,
      assetCode: account.assetCode,
      delta: negCents(deducted),
      reason: input.reason,
      refId: input.refId,
    });
  }

  return entries;
}

function availableHoldingsAt(assetHoldings: readonly AssetHolding[], now: Date): AssetHolding[] {
  return assetHoldings.filter((holding) => isHoldingAvailableAt(holding, now)).map((holding) => ({ ...holding }));
}

function isHoldingAvailableAt(holding: AssetHolding, now: Date): boolean {
  if (!isPositiveQuantity(holding.quantity)) return false;
  if (holding.activeAt && holding.activeAt > now) return false;
  if (holding.expiresAt && holding.expiresAt <= now) return false;
  return true;
}

function normalizeOrder(index: number): number {
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function normalizeCurrencyCode(assetCode: string): string {
  return assetCode.startsWith("currency.") ? assetCode.slice("currency.".length) : assetCode;
}

export type BillTimeline = {
  totals: { name: string; amount: number }[];
  tracks: { id: string; name: string; lane: number; color: number; startedAt: string; endedAt: string }[];
  events: { at: string; time: string; date: string; entries: BillTimelineEntry[] }[];
};
export type BillTimelineEntry = {
  trackId: string | null;
  kind: "start" | "end" | "current" | "switch" | "adjustment";
  name: string;
  rule: string | null;
  nextRule: string | null;
  periodLabel: string | null;
  amount: number | null;
  startedAt: string | null;
  endedAt: string | null;
  unitMinutes: number | null;
  unitPrice: number | null;
  units: number | null;
  cap: number | null;
  paidBefore: number | null;
};
