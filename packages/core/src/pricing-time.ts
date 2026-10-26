import { dateTimeFormatterCache } from "./date-time-formatter";
import { PrismDomainError } from "./errors";
import {
  type Cents,
  addCents,
  allocate,
  centsOf,
  compareCents,
  isPositiveCents,
  maxCents,
  minCents,
  mulDivRound,
  subCents,
  yuanOf,
  ZERO_CENTS,
} from "./money";
import type { ChargeItem, PricingProvider, SettlementAdjustment } from "./settlement";
import type { Session } from "./session";

export type UnitPricingConfig = {
  unitMinutes: number;
  unitPrice: number;
  roundGraceMinutes: number;
  priceCap: number;
};

export type TimePricingProviderConfig = UnitPricingConfig & {
  id: string;
  label: string;
};

export type TimeRange = {
  start: string;
  end: string;
};

export type PriorityTimePricingRuleStatus = "active" | "archived";

export type PriorityTimePricingRule = {
  id: string;
  label: string;
  priority: number;
  status?: PriorityTimePricingRuleStatus;
  weekdays?: readonly number[];
  specificDates?: readonly string[];
  /** Absolute UTC anchor retained by the historical data migration. */
  anchorAt?: Date;
  /** Original rule identity when UTC date groups need distinct editor IDs. */
  historyRuleId?: string;
  timeRange?: TimeRange;
  dateTimeRange?: {
    start: Date;
    end: Date;
  };
  pricing: UnitPricingConfig;
};

export type TimeCapPricingRule = {
  id: string;
  label: string;
  priority: number;
  status?: PriorityTimePricingRuleStatus;
  weekdays?: readonly number[];
  specificDates?: readonly string[];
  /** Absolute UTC anchor retained by the historical data migration. */
  anchorAt?: Date;
  /** Original rule identity when UTC date groups need distinct editor IDs. */
  historyRuleId?: string;
  timeRange?: TimeRange;
  dateTimeRange?: {
    start: Date;
    end: Date;
  };
  priceCap: number;
};

export type PriorityTimePricingProviderConfig = {
  /** Historical aliases retain the original cap/history identity. */
  historyProviderId?: string;
  name?: string;
  id: string;
  pricingConfigId?: string;
  rules: readonly PriorityTimePricingRule[];
  timeZone?: string;
  paidHistory?: Record<string, Cents>;
};

export type TimeCapPricingProviderConfig = {
  id: string;
  name?: string;
  pricingConfigId?: string;
  includedPricingConfigIds: readonly string[];
  rules: readonly TimeCapPricingRule[];
  timeZone?: string;
  paidHistory?: Record<string, Cents>;
};

export type TimeCapPricingHistoryLookupKey = {
  capConfigId: string;
  capRuleId: string;
  capAnchorAt: Date;
  key: string;
};

type TimeRuleLike = {
  id: string;
  label: string;
  priority: number;
  status?: PriorityTimePricingRuleStatus;
  weekdays?: readonly number[];
  specificDates?: readonly string[];
  /** Absolute UTC anchor retained by the historical data migration. */
  anchorAt?: Date;
  /** Original rule identity when UTC date groups need distinct editor IDs. */
  historyRuleId?: string;
  timeRange?: TimeRange;
  dateTimeRange?: {
    start: Date;
    end: Date;
  };
};

export type PriorityTimePricingHistoryLookupKey = {
  pricingConfigId: string;
  providerId: string;
  ruleId: string;
  ruleAnchorAt: Date;
  key: string;
};

export type PriorityTimePricingTimelineSegment = {
  ruleId: string;
  label: string;
  priority: number;
  startMinute: number;
  endMinute: number;
  startLabel: string;
  endLabel: string;
  startedAt?: string;
  endedAt?: string;
  /** The rule's window this piece belongs to; a window can run past either end of the day. */
  windowStartedAt?: string;
  windowEndedAt?: string;
  pricing?: UnitPricingConfig;
  priceCap?: number;
  isClosed?: true;
};

export type PriorityTimePricingTimeline = {
  providerId: string;
  localDate: string;
  timeZone: string;
  segments: PriorityTimePricingTimelineSegment[];
};

export type PricingSegmentExplanation = {
  timeZone?: string;
  planName?: string;
  pricing?: UnitPricingConfig;
  paidBefore?: number;
  units?: number;
  pricingConfigId: string;
  providerId: string;
  ruleId: string;
  ruleLabel: string;
  period: { startedAt: Date; endedAt: Date };
  ruleTimeRange: TimeRange | null;
  intervalCap: number;
  intervalCapReached: boolean;
};

export type TimeCapPricingWindow = {
  key: string;
  capName?: string;
  capConfigId: string;
  capRuleId: string;
  ruleLabel: string;
  windowStartedAt: Date;
  windowEndedAt: Date;
  priceCap: Cents;
  paidBefore: Cents;
  /** What the charges in the window come to before any cap across plans. */
  currentAmount: Cents;
  /** What they come to after every cap across plans: what the window counts. */
  amountApplied: Cents;
  /**
   * What this cap takes off the bill's quotes: its share of what all caps across
   * plans took off, by what it stopped when it was full. A unit is held back once,
   * by the cap whose allowance ran out first.
   */
  heldBack?: Cents;
  /** Each session's plan in the window: what it is charged there after every cap. */
  contributions: Array<{ sessionId: string; pricingConfigId: string; amount: Cents }>;
};

export function createTimePricingProvider(config: TimePricingProviderConfig): PricingProvider {
  return {
    id: config.id,
    quote(context) {
      const endedAt = context.session.endedAt ?? context.now;
      const durationMinutes = Math.floor((endedAt.getTime() - context.session.startedAt.getTime()) / 60_000);
      const hasDeviceActivity = Boolean(
        context.session.metadata?.deviceOperated || context.session.metadata?.hasDeviceActivity,
      );
      const amount = calculateUnitPrice(durationMinutes, config, hasDeviceActivity);

      return [
        {
          id: `${context.session.id}:${config.id}`,
          sessionId: context.session.id,
          source: config.id,
          label: config.label,
          amount,
        },
      ];
    },
  };
}

export function createPriorityTimePricingProvider(config: PriorityTimePricingProviderConfig): PricingProvider {
  const rules = activeRules(config.rules).sort((a, b) => b.priority - a.priority);
  const timeZone = config.timeZone ?? "UTC";

  return {
    id: config.id,
    quote(context) {
      const endedAt = context.session.endedAt ?? context.now;
      const charges: ChargeItem[] = [];
      const currentPaidHistory = { ...config.paidHistory };
      let cursor = new Date(context.session.startedAt);
      const hasDeviceActivity = Boolean(
        context.session.metadata?.deviceOperated || context.session.metadata?.hasDeviceActivity,
      );

      let effectiveEndedAt = endedAt;
      if (effectiveEndedAt <= cursor && hasDeviceActivity) {
        effectiveEndedAt = new Date(cursor.getTime() + 60_000);
      }

      let invalidateFirstGrace = hasDeviceActivity;

      while (cursor < effectiveEndedAt) {
        const rule = findActiveRule(cursor, rules, timeZone);
        if (!rule) {
          cursor = findNextAnyRuleActivationAfter(cursor, effectiveEndedAt, rules, timeZone);
          continue;
        }
        const nextBoundary = findNextPriorityBoundary(cursor, effectiveEndedAt, rule, rules, timeZone);
        const durationMinutes = Math.floor((nextBoundary.getTime() - cursor.getTime()) / 60_000);
        const historyKey = buildRuleHistoryKey(
          config.pricingConfigId ?? config.id,
          config.id,
          cursor,
          rule,
          timeZone,
        );
        const paidBefore = currentPaidHistory[historyKey] ?? ZERO_CENTS;
        const amount = calculateUnitPriceWithHistory(
          durationMinutes,
          rule.pricing,
          paidBefore,
          invalidateFirstGrace,
        );
        const units = calculateUnits(durationMinutes, rule.pricing, invalidateFirstGrace);
        currentPaidHistory[historyKey] = addCents(paidBefore, amount);
        if (isPositiveCents(amount)) {
          invalidateFirstGrace = false;
        }

        charges.push({
          id: `${context.session.id}:${config.id}:${rule.id}:${cursor.toISOString()}`,
          sessionId: context.session.id,
          source: config.id,
          label: rule.label,
          amount,
          period: {
            startedAt: cursor,
            endedAt: nextBoundary,
          },
          pricingHistory: {
            pricingConfigId: config.pricingConfigId ?? config.id,
            providerId: config.id,
            ruleId: rule.historyRuleId ?? rule.id,
            ruleAnchorAt: getRuleAnchor(cursor, rule, timeZone),
            amount,
          },
          pricingExplanation: {
            timeZone,
            units,
            planName: config.name,
            pricing: { ...rule.pricing },
            paidBefore: yuanOf(paidBefore),
            pricingConfigId: config.pricingConfigId ?? config.id,
            providerId: config.id,
            ruleId: rule.id,
            ruleLabel: rule.label,
            period: {
              startedAt: cursor,
              endedAt: nextBoundary,
            },
            ruleTimeRange: rule.timeRange ?? null,
            intervalCap: rule.pricing.priceCap,
            intervalCapReached: periodCapOf(rule.pricing.priceCap) !== null && compareCents(
              addCents(paidBefore, amount),
              periodCapOf(rule.pricing.priceCap)!,
            ) >= 0,
          },
        });

        cursor = nextBoundary;
      }

      return charges;
    },
  };
}

export function collectTimeCapPricingHistoryLookupKeys(input: {
  config: TimeCapPricingProviderConfig;
  chargeItems: readonly ChargeItem[];
}): TimeCapPricingHistoryLookupKey[] {
  const rules = activeRules(input.config.rules).sort((a, b) => b.priority - a.priority);
  const timeZone = input.config.timeZone ?? "UTC";
  const capConfigId = input.config.pricingConfigId ?? input.config.id;
  const included = new Set(input.config.includedPricingConfigIds);
  const keys = new Map<string, TimeCapPricingHistoryLookupKey>();

  for (const item of input.chargeItems) {
    const pricingConfigId = item.pricingHistory?.pricingConfigId;
    if (!pricingConfigId || !included.has(pricingConfigId) || !item.period) continue;
    let cursor = new Date(item.period.startedAt);
    const endedAt = new Date(item.period.endedAt);
    while (cursor < endedAt) {
      const rule = findActiveRule(cursor, rules, timeZone);
      if (!rule) {
        cursor = findNextAnyRuleActivationAfter(cursor, endedAt, rules, timeZone);
        continue;
      }
      const nextBoundary = findNextPriorityBoundary(cursor, endedAt, rule, rules, timeZone);
      const capAnchorAt = getRuleAnchor(cursor, rule, timeZone);
      const key = buildTimeCapHistoryKey(capConfigId, rule.historyRuleId ?? rule.id, capAnchorAt);
      keys.set(key, {
        capConfigId,
        capRuleId: rule.historyRuleId ?? rule.id,
        capAnchorAt,
        key,
      });
      cursor = nextBoundary;
    }
  }

  return [...keys.values()];
}

export function applyTimeCapPricing(input: {
  config: TimeCapPricingProviderConfig;
  chargeItems: readonly ChargeItem[];
}): SettlementAdjustment[] {
  return settleTimeCaps({ configs: [input.config], chargeItems: input.chargeItems }).adjustments;
}

export function explainTimeCapPricing(input: {
  config: TimeCapPricingProviderConfig;
  chargeItems: readonly ChargeItem[];
  paidHistory?: Record<string, Cents>;
}): TimeCapPricingWindow[] {
  return settleTimeCaps({ configs: [input.config], chargeItems: input.chargeItems, paidHistory: input.paidHistory }).windows;
}

/**
 * One unit of a charge as the caps see it: when it began, its own price
 * (`nominal`), what its charge's quote put on it (`price`, with the period cap
 * counted on list prices), what it is charged after every cap, and the cap that
 * stopped it from being charged in full: `"period"` for its rule's period cap,
 * else the key of the cap window across plans.
 */
export type TimeCapUnit = { item: ChargeItem; index: number; at: Date; nominal: Cents; price: Cents; charged: Cents; heldBy: string | null };

export type TimeCapSettlement = {
  windows: TimeCapPricingWindow[];
  /** One per window that held something back or counted something, for settlement and history. */
  adjustments: SettlementAdjustment[];
  units: TimeCapUnit[];
};

type CapWindowSpec = Omit<TimeCapPricingWindow, "currentAmount" | "amountApplied" | "heldBack" | "contributions"> & {
  includedPricingConfigIds: readonly string[];
};
type KeyedUnit = { item: ChargeItem; index: number; at: Date; nominal: Cents; price: Cents; keys: string[] };

const capPlanOf = (item: ChargeItem) => item.pricingHistory?.pricingConfigId;

/**
 * Every cap over the same charges, together: each rule's period cap and every
 * cap across plans. The charges are cut into units (a charge without units into
 * pieces at the windows' edges), and the units are charged in the order they
 * began: each up to the smallest of its own price, what is left of its period
 * cap, and what is left in the cap windows it falls in. Every cap counts what
 * was actually charged, so a unit a cap across plans let off does not use up the
 * period cap. Once a cap is full, the units after it are free. A charge below
 * zero is never held back; it adds to the allowance of the windows it is in.
 *
 * With only one cap of either kind this charges what that cap always has.
 */
export function settleTimeCaps(input: {
  configs: readonly TimeCapPricingProviderConfig[];
  chargeItems: readonly ChargeItem[];
  /** Overrides each config's own history. */
  paidHistory?: Record<string, Cents>;
}): TimeCapSettlement {
  const specs = new Map<string, CapWindowSpec>();
  // Per item, per config, the windows it overlaps in time.
  const segments = new Map<ChargeItem, Array<{ key: string; from: number; to: number }[]>>();
  input.configs.forEach((config, configIndex) => {
    const rules = activeRules(config.rules).sort((a, b) => b.priority - a.priority);
    const timeZone = config.timeZone ?? "UTC";
    const capConfigId = config.pricingConfigId ?? config.id;
    const included = new Set(config.includedPricingConfigIds);
    const history = input.paidHistory ?? config.paidHistory ?? {};
    for (const item of input.chargeItems) {
      const plan = capPlanOf(item);
      const perConfig = segments.get(item) ?? input.configs.map(() => []);
      segments.set(item, perConfig);
      if (!plan || !included.has(plan) || !item.period) continue;
      let cursor = new Date(item.period.startedAt);
      const endedAt = new Date(item.period.endedAt);
      while (cursor < endedAt) {
        const rule = findActiveRule(cursor, rules, timeZone);
        if (!rule) {
          cursor = findNextAnyRuleActivationAfter(cursor, endedAt, rules, timeZone);
          continue;
        }
        const nextBoundary = findNextPriorityBoundary(cursor, endedAt, rule, rules, timeZone);
        const capAnchorAt = getRuleAnchor(cursor, rule, timeZone);
        const capRuleId = rule.historyRuleId ?? rule.id;
        const key = buildTimeCapHistoryKey(capConfigId, capRuleId, capAnchorAt);
        if (!specs.has(key)) {
          specs.set(key, {
            key, capName: config.name, capConfigId, capRuleId, ruleLabel: rule.label,
            windowStartedAt: capAnchorAt, windowEndedAt: getRuleNaturalEnd(capAnchorAt, rule, timeZone),
            priceCap: centsOf(rule.priceCap), paidBefore: history[key] ?? ZERO_CENTS,
            includedPricingConfigIds: config.includedPricingConfigIds,
          });
        }
        perConfig[configIndex]!.push({ key, from: cursor.getTime(), to: nextBoundary.getTime() });
        cursor = nextBoundary;
      }
    }
  });
  const units = input.chargeItems.flatMap((item) => {
    const perConfig = segments.get(item) ?? [];
    const cuts = perConfig.flat().flatMap((segment) => [segment.from, segment.to]);
    return capUnitsOf(item, cuts).map(({ at, nominal, price }, index) => ({
      item, index, at, nominal, price,
      keys: perConfig.flatMap((list) => list.filter((segment) => at.getTime() >= segment.from && at.getTime() < segment.to).map((segment) => segment.key)),
    }));
  });
  return settleUnits([...specs.values()], units);
}

/**
 * The same settlement replayed over windows already settled (a bill, a live
 * projection): a unit falls in a window when its session's plan is in the
 * window and it began inside it.
 */
export function settleTimeCapWindows(
  windows: readonly TimeCapPricingWindow[],
  chargeItems: readonly ChargeItem[],
): TimeCapSettlement {
  const specs: CapWindowSpec[] = windows.map((window) => ({
    key: window.key, capName: window.capName, capConfigId: window.capConfigId, capRuleId: window.capRuleId,
    ruleLabel: window.ruleLabel, windowStartedAt: window.windowStartedAt, windowEndedAt: window.windowEndedAt,
    priceCap: window.priceCap, paidBefore: window.paidBefore,
    includedPricingConfigIds: [...new Set(window.contributions.map((contribution) => contribution.pricingConfigId))],
  }));
  const holds = (window: TimeCapPricingWindow, item: ChargeItem) =>
    window.contributions.some((c) => c.sessionId === item.sessionId && c.pricingConfigId === capPlanOf(item));
  const units = chargeItems.flatMap((item) => {
    const own = windows.filter((window) => holds(window, item));
    const cuts = own.flatMap((window) => [window.windowStartedAt.getTime(), window.windowEndedAt.getTime()]);
    return capUnitsOf(item, cuts).map(({ at, nominal, price }, index) => ({
      item, index, at, nominal, price,
      keys: own.filter((window) => at >= window.windowStartedAt && at < window.windowEndedAt).map((window) => window.key),
    }));
  });
  return settleUnits(specs, units);
}

/**
 * A charge as units: its time units at their own price, with what its quote put
 * on each (in order, until the quote's amount, which has the period cap in it);
 * a charge without units is cut by time at the given edges instead.
 */
function capUnitsOf(item: ChargeItem, cuts: readonly number[]): Array<{ at: Date; nominal: Cents; price: Cents }> {
  if (!item.period) return [];
  const from = new Date(item.period.startedAt).getTime();
  const to = new Date(item.period.endedAt).getTime();
  if (to <= from) return [];
  const starts = chargeUnitStarts(item);
  if (starts?.length) {
    const nominal = centsOf(item.pricingExplanation!.pricing!.unitPrice);
    if (!isPositiveCents(nominal) || compareCents(mulDivRound(nominal, starts.length, 1, "trunc"), item.amount) < 0) {
      const prices = allocate(item.amount, starts.map(() => 1));
      return starts.map((at, i) => ({ at, nominal: prices[i]!, price: prices[i]! }));
    }
    let left = item.amount;
    return starts.map((at) => {
      const price = maxCents(ZERO_CENTS, minCents(nominal, left));
      left = subCents(left, price);
      return { at, nominal, price };
    });
  }
  const edges = [from, ...[...new Set(cuts.filter((at) => at > from && at < to))].sort((a, b) => a - b), to];
  const prices = allocate(item.amount, edges.slice(0, -1).map((edge, i) => edges[i + 1]! - edge));
  return edges.slice(0, -1).map((edge, i) => ({ at: new Date(edge), nominal: prices[i]!, price: prices[i]! }));
}

/**
 * A charge's period cap: its rule window, as its history is keyed, within its
 * session, and what is left of the cap in that window before this bill. Null
 * when the period is uncapped.
 */
function periodCapOfItem(item: ChargeItem): { key: string; allowance: Cents } | null {
  const explanation = item.pricingExplanation;
  const history = item.pricingHistory;
  if (!explanation?.pricing || !history || !(explanation.intervalCap > 0)) return null;
  return {
    key: JSON.stringify([item.sessionId ?? "", history.pricingConfigId, history.providerId, history.ruleId, history.ruleAnchorAt.toISOString()]),
    allowance: maxCents(ZERO_CENTS, subCents(centsOf(explanation.intervalCap), centsOf(explanation.paidBefore ?? 0))),
  };
}

function settleUnits(specs: readonly CapWindowSpec[], units: readonly KeyedUnit[]): TimeCapSettlement {
  const order = new Map(specs.map((spec, index) => [spec.key, index]));
  const state = new Map(specs.map((spec) => [spec.key, {
    // A window already over its cap takes nothing more, but still nets out a discount.
    allowance: maxCents(ZERO_CENTS, subCents(spec.priceCap, spec.paidBefore)),
    current: ZERO_CENTS, applied: ZERO_CENTS, held: ZERO_CENTS,
    contributions: new Map<string, { sessionId: string; pricingConfigId: string; amount: Cents }>(),
  }]));
  for (const unit of units) {
    if (compareCents(unit.price, ZERO_CENTS) >= 0) continue;
    for (const key of unit.keys) state.get(key)!.allowance = subCents(state.get(key)!.allowance, unit.price);
  }
  // Each period cap, from the earliest charge in its window: later charges' quotes already counted the earlier ones.
  const periods = new Map<string, Cents>();
  for (const unit of [...units].sort((a, b) => (a.item.period?.startedAt.getTime() ?? 0) - (b.item.period?.startedAt.getTime() ?? 0))) {
    const period = periodCapOfItem(unit.item);
    if (period && !periods.has(period.key)) periods.set(period.key, period.allowance);
  }
  // In the order the units began; units beginning together in a fixed order, so the input order never matters.
  const ordered = [...units].sort((a, b) =>
    a.at.getTime() - b.at.getTime()
    || (a.item.sessionId ?? "").localeCompare(b.item.sessionId ?? "")
    || (capPlanOf(a.item) ?? "").localeCompare(capPlanOf(b.item) ?? "")
    || (a.item.period?.startedAt.getTime() ?? 0) - (b.item.period?.startedAt.getTime() ?? 0)
    || a.index - b.index);
  const settled = new Map<KeyedUnit, { charged: Cents; heldBy: string | null }>();
  for (const unit of ordered) {
    const keys = [...unit.keys].sort((a, b) => order.get(a)! - order.get(b)!);
    const period = isPositiveCents(unit.nominal) ? periodCapOfItem(unit.item) : null;
    const periodLeft = period ? periods.get(period.key)! : null;
    // What its rule lets it charge, then what the windows it is in still allow.
    const limit = periodLeft == null ? unit.nominal : minCents(unit.nominal, periodLeft);
    let amount = isPositiveCents(unit.nominal) ? limit : unit.price;
    let binding: string | null = null;
    if (isPositiveCents(unit.nominal)) {
      for (const key of keys) {
        const allowance = state.get(key)!.allowance;
        if (compareCents(allowance, amount) < 0) {
          amount = maxCents(ZERO_CENTS, allowance);
          binding = key;
        }
      }
    }
    const heldBy = isPositiveCents(unit.nominal) && compareCents(amount, unit.nominal) < 0 ? binding ?? "period" : null;
    settled.set(unit, { charged: amount, heldBy });
    if (period) periods.set(period.key, subCents(periodLeft!, amount));
    if (binding) state.get(binding)!.held = addCents(state.get(binding)!.held, subCents(limit, amount));
    for (const key of keys) {
      const window = state.get(key)!;
      window.current = addCents(window.current, unit.price);
      window.applied = addCents(window.applied, amount);
      if (isPositiveCents(unit.nominal)) window.allowance = subCents(window.allowance, amount);
      if (!unit.item.sessionId) continue;
      const plan = capPlanOf(unit.item)!;
      const contributionKey = JSON.stringify([unit.item.sessionId, plan]);
      const contribution = window.contributions.get(contributionKey)
        ?? { sessionId: unit.item.sessionId, pricingConfigId: plan, amount: ZERO_CENTS };
      contribution.amount = addCents(contribution.amount, amount);
      window.contributions.set(contributionKey, contribution);
    }
  }
  // What the caps across plans take off the quotes, split over the windows that bound units. A
  // unit one of them let off leaves its period cap room for a later unit, so this can be less
  // than what they stopped at the moment they were full.
  let price = ZERO_CENTS, charged = ZERO_CENTS;
  for (const unit of units) {
    price = addCents(price, unit.price);
    charged = addCents(charged, settled.get(unit)!.charged);
  }
  const takenOff = subCents(price, charged);
  const weights = specs.map((spec) => state.get(spec.key)!.held as number);
  const shares = isPositiveCents(takenOff) && weights.some((weight) => weight > 0)
    ? allocate(takenOff, weights)
    : specs.map(() => ZERO_CENTS);
  const windows: TimeCapPricingWindow[] = specs.map(({ includedPricingConfigIds: _included, ...spec }, index) => {
    const window = state.get(spec.key)!;
    return {
      ...spec,
      currentAmount: window.current,
      amountApplied: window.applied,
      heldBack: shares[index]!,
      contributions: [...window.contributions.values()]
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.pricingConfigId.localeCompare(b.pricingConfigId)),
    };
  });
  const adjustments = windows.flatMap((window, index) => {
    const amount = subCents(ZERO_CENTS, window.heldBack ?? ZERO_CENTS);
    if (amount === 0 && !isPositiveCents(window.amountApplied)) return [];
    return [{
      id: `time-cap:${window.capConfigId}:${window.capRuleId}:${window.windowStartedAt.toISOString()}`,
      source: `time.cap:${window.capConfigId}:${window.capRuleId}`,
      label: window.ruleLabel,
      amount,
      pricingCapHistory: {
        capConfigId: window.capConfigId,
        capRuleId: window.capRuleId,
        capAnchorAt: window.windowStartedAt,
        includedPricingConfigIds: [...specs[index]!.includedPricingConfigIds],
        amount: maxCents(ZERO_CENTS, window.amountApplied),
      },
    }];
  });
  return {
    windows,
    adjustments,
    units: ordered.map((unit) => ({ item: unit.item, index: unit.index, at: unit.at, nominal: unit.nominal, price: unit.price, ...settled.get(unit)! })),
  };
}

/**
 * When each charged unit of a time charge starts: one every unit from the
 * start of its period, as many as it charged. Null for a charge not made of units.
 */
export function chargeUnitStarts(item: Pick<ChargeItem, "period" | "pricingExplanation">): Date[] | null {
  const explanation = item.pricingExplanation;
  if (!explanation?.pricing || explanation.units == null || !item.period) return null;
  const start = new Date(item.period.startedAt).getTime();
  const end = new Date(item.period.endedAt).getTime();
  const step = explanation.pricing.unitMinutes * 60_000;
  const starts: Date[] = [];
  for (let unit = 0; unit < explanation.units; unit += 1) {
    const at = start + unit * step;
    // A charge cut short (a live projection) has only the units begun before its end.
    if (unit > 0 && at >= end) break;
    starts.push(new Date(at));
  }
  return starts;
}

/**
 * When each unit of `chargeUnitStarts` is charged, as quote() counts units: once
 * it has run as long as the grace (a whole minute at least, the unit at most).
 * With the grace waived (the device was used) the first unit is charged at once.
 */
export function chargeUnitChargedAt(item: Pick<ChargeItem, "period" | "pricingExplanation">, graceWaived: boolean): Date[] | null {
  const starts = chargeUnitStarts(item);
  const pricing = item.pricingExplanation?.pricing;
  if (!starts || !pricing) return null;
  const after = Math.min(Math.max(pricing.roundGraceMinutes, 1), pricing.unitMinutes) * 60_000;
  return starts.map((at, index) => new Date(at.getTime() + (graceWaived && index === 0 ? 0 : after)));
}

export function collectPriorityTimePricingHistoryLookupKeys(input: {
  config: PriorityTimePricingProviderConfig;
  startedAt: Date;
  endedAt: Date;
}): PriorityTimePricingHistoryLookupKey[] {
  const rules = activeRules(input.config.rules).sort((a, b) => b.priority - a.priority);
  const timeZone = input.config.timeZone ?? "UTC";
  const keys = new Map<string, PriorityTimePricingHistoryLookupKey>();
  let cursor = new Date(input.startedAt);

  while (cursor < input.endedAt) {
    const rule = findActiveRule(cursor, rules, timeZone);
    if (!rule) {
      cursor = findNextAnyRuleActivationAfter(cursor, input.endedAt, rules, timeZone);
      continue;
    }
    const nextBoundary = findNextPriorityBoundary(cursor, input.endedAt, rule, rules, timeZone);
    const ruleAnchorAt = getRuleAnchor(cursor, rule, timeZone);
    const key = buildRuleHistoryKey(
      input.config.pricingConfigId ?? input.config.id,
      input.config.id,
      cursor,
      rule,
      timeZone,
    );
    keys.set(key, {
      pricingConfigId: input.config.pricingConfigId ?? input.config.id,
      providerId: input.config.id,
      ruleId: rule.historyRuleId ?? rule.id,
      ruleAnchorAt,
      key,
    });
    cursor = nextBoundary;
  }

  return [...keys.values()];
}

/** The capped period a plan is in at `at`: its rule, its cap and the key spending in it is recorded under. Null outside every period. */
export function priorityTimePricingWindowAt(input: {
  config: PriorityTimePricingProviderConfig;
  at: Date;
}): { lookup: PriorityTimePricingHistoryLookupKey; ruleId: string; ruleLabel: string; priceCap: number; endsAt: Date } | null {
  const rules = activeRules(input.config.rules).sort((a, b) => b.priority - a.priority);
  const timeZone = input.config.timeZone ?? "UTC";
  const rule = findActiveRule(input.at, rules, timeZone);
  if (!rule) return null;
  const pricingConfigId = input.config.pricingConfigId ?? input.config.id;
  const ruleAnchorAt = getRuleAnchor(input.at, rule, timeZone);
  return {
    lookup: {
      pricingConfigId,
      providerId: input.config.id,
      ruleId: rule.historyRuleId ?? rule.id,
      ruleAnchorAt,
      key: buildRuleHistoryKey(pricingConfigId, input.config.id, input.at, rule, timeZone),
    },
    ruleId: rule.id,
    ruleLabel: rule.label,
    priceCap: rule.pricing.priceCap,
    endsAt: getRuleNaturalEnd(input.at, rule, timeZone),
  };
}

/** The window of a cross-plan cap in force at `at`, with the key its spending is recorded under. Null outside every window. */
export function timeCapPricingWindowAt(input: {
  config: TimeCapPricingProviderConfig;
  at: Date;
}): { lookup: TimeCapPricingHistoryLookupKey; ruleId: string; ruleLabel: string; priceCap: number; endsAt: Date } | null {
  const rules = activeRules(input.config.rules).sort((a, b) => b.priority - a.priority);
  const timeZone = input.config.timeZone ?? "UTC";
  const rule = findActiveRule(input.at, rules, timeZone);
  if (!rule) return null;
  const capConfigId = input.config.pricingConfigId ?? input.config.id;
  const capAnchorAt = getRuleAnchor(input.at, rule, timeZone);
  const capRuleId = rule.historyRuleId ?? rule.id;
  return {
    lookup: { capConfigId, capRuleId, capAnchorAt, key: buildTimeCapHistoryKey(capConfigId, capRuleId, capAnchorAt) },
    ruleId: rule.id,
    ruleLabel: rule.label,
    priceCap: rule.priceCap,
    endsAt: getRuleNaturalEnd(input.at, rule, timeZone),
  };
}

export function canStartPriorityTimePricingSession(input: {
  config: PriorityTimePricingProviderConfig;
  at: Date;
}): boolean {
  const rules = activeRules(input.config.rules).sort((a, b) => b.priority - a.priority);
  return !!findActiveRule(input.at, rules, input.config.timeZone ?? "UTC");
}

export function buildPriorityTimePricingTimeline(input: {
  localDate: string;
  config: PriorityTimePricingProviderConfig;
  displayTimeZone?: string;
}): PriorityTimePricingTimeline {
  return buildTimeRuleTimeline({
    localDate: input.localDate,
    config: input.config,
    displayTimeZone: input.displayTimeZone,
    segmentValue: (rule) => ({ pricing: rule.pricing }),
  });
}

export function buildTimeCapPricingTimeline(input: {
  localDate: string;
  config: TimeCapPricingProviderConfig;
  displayTimeZone?: string;
}): PriorityTimePricingTimeline {
  return buildTimeRuleTimeline({
    localDate: input.localDate,
    config: input.config,
    displayTimeZone: input.displayTimeZone,
    segmentValue: (rule) => ({ priceCap: rule.priceCap }),
  });
}

function buildTimeRuleTimeline<T extends TimeRuleLike>(input: {
  localDate: string;
  displayTimeZone?: string;
  config: {
    id: string;
    rules: readonly T[];
    timeZone?: string;
  };
  segmentValue: (rule: T) => Pick<PriorityTimePricingTimelineSegment, "pricing" | "priceCap">;
}): PriorityTimePricingTimeline {
  const rules = activeRules(input.config.rules).sort((a, b) => b.priority - a.priority);
  const timeZone = input.config.timeZone ?? "UTC";
  const displayTimeZone = input.displayTimeZone ?? timeZone;
  const dayStart = parseLocalDateTime(input.localDate, "00:00", displayTimeZone);
  const dayEnd = parseLocalDateTime(addLocalDays(input.localDate, 1), "00:00", displayTimeZone);
  const segments: PriorityTimePricingTimelineSegment[] = [];
  let cursor = dayStart;

  while (cursor < dayEnd) {
    const rule = findActiveRule(cursor, rules, timeZone);
    const nextBoundary = rule
      ? findNextPriorityBoundary(cursor, dayEnd, rule, rules, timeZone)
      : findNextAnyRuleActivationAfter(cursor, dayEnd, rules, timeZone);
    if (nextBoundary <= cursor) {
      throw new PrismDomainError("Time pricing timeline cannot advance.", "TIME_PRICING_TIMELINE_STALLED");
    }

    const startMinute = getLocalMinuteOfDay(cursor, input.localDate, displayTimeZone);
    const endMinute = getLocalMinuteOfDay(nextBoundary, input.localDate, displayTimeZone);
    if (rule) {
      segments.push({
        ruleId: rule.id,
        label: rule.label,
        priority: rule.priority,
        startMinute,
        endMinute,
        startLabel: formatMinuteLabel(startMinute),
        endLabel: formatMinuteLabel(endMinute),
        startedAt: cursor.toISOString(),
        endedAt: nextBoundary.toISOString(),
        windowStartedAt: getRuleAnchor(cursor, rule, timeZone).toISOString(),
        windowEndedAt: getRuleNaturalEnd(cursor, rule, timeZone).toISOString(),
        ...input.segmentValue(rule),
      });
    } else {
      segments.push({
        ruleId: "__closed__",
        label: "非营业",
        priority: Number.NEGATIVE_INFINITY,
        startMinute,
        endMinute,
        startLabel: formatMinuteLabel(startMinute),
        endLabel: formatMinuteLabel(endMinute),
        startedAt: cursor.toISOString(),
        endedAt: nextBoundary.toISOString(),
        isClosed: true,
      });
    }

    cursor = nextBoundary;
  }

  return {
    providerId: input.config.id,
    localDate: input.localDate,
    timeZone: displayTimeZone,
    segments: mergeAdjacentTimelineSegments(segments),
  };
}

function activeRules<T extends TimeRuleLike>(rules: readonly T[]): T[] {
  return rules.filter((rule) => (rule.status ?? "active") === "active");
}

/** A period cap of 0 leaves the period uncapped, as the editor has always shown it ("不限"). */
function periodCapOf(priceCap: number): Cents | null {
  return priceCap > 0 ? centsOf(priceCap) : null;
}

function calculateUnitPrice(
  durationMinutes: number,
  config: UnitPricingConfig,
  invalidateFirstGrace?: boolean,
): Cents {
  if (durationMinutes <= 0 && !invalidateFirstGrace) return ZERO_CENTS;

  return calculateRawUnitPrice(durationMinutes, config, invalidateFirstGrace);
}

function calculateUnitPriceWithHistory(
  durationMinutes: number,
  config: UnitPricingConfig,
  paidBefore: Cents,
  invalidateFirstGrace?: boolean,
): Cents {
  if (durationMinutes <= 0 && !invalidateFirstGrace) return ZERO_CENTS;

  const raw = calculateRawUnitPrice(durationMinutes, config, invalidateFirstGrace, true);
  const cap = periodCapOf(config.priceCap);
  if (!isPositiveCents(raw) || cap === null) return raw;

  const effectiveTotal = minCents(addCents(paidBefore, raw), cap);
  return maxCents(ZERO_CENTS, subCents(effectiveTotal, paidBefore));
}

function calculateRawUnitPrice(
  durationMinutes: number,
  config: UnitPricingConfig,
  invalidateFirstGrace?: boolean,
  ignoreCap = false,
): Cents {
  const units = calculateUnits(durationMinutes, config, invalidateFirstGrace);
  const unitPrice = centsOf(config.unitPrice);
  const raw = mulDivRound(unitPrice, units, 1, "trunc");
  const cap = periodCapOf(config.priceCap);
  return ignoreCap || cap === null ? raw : minCents(raw, cap);
}

function calculateUnits(durationMinutes: number, config: UnitPricingConfig, invalidateFirstGrace?: boolean): number {
  let units = Math.floor(Math.max(0, durationMinutes) / config.unitMinutes);
  const leftover = durationMinutes % config.unitMinutes;
  // A partial unit rounds up once the leftover reaches the grace. Zero grace
  // still charges any nonzero leftover, while exact unit multiples never do.
  if (leftover > 0 && leftover >= config.roundGraceMinutes) {
    units += 1;
  }
  if (invalidateFirstGrace && units === 0) {
    units = 1;
  }

  return units;
}

// Uses the same rule priority, timezone and minute rounding as quote().
export function nextTimePricingEvent(input: {
  config: PriorityTimePricingProviderConfig | TimeCapPricingProviderConfig;
  session: Session;
  now: Date;
  intervalCapReached?: boolean;
  intervalStartedAt?: Date;
}): { ruleLabel: string | null; ruleAt: Date | null; chargeAt: Date | null; intervalStartedAt: Date } {
  const { config, session, now } = input;
  const rules = activeRules<PriorityTimePricingRule | TimeCapPricingRule>(config.rules).sort((a, b) => b.priority - a.priority);
  const zone = config.timeZone ?? "UTC";
  const horizon = new Date(now.getTime() + 8 * 60 * 60_000);
  let cursor = session.startedAt;
  // Recover the current segment's start; rounding restarts at each rule boundary.
  while (cursor < now) {
    const rule = findActiveRule(cursor, rules, zone);
    const boundary = rule ? findNextPriorityBoundary(cursor, horizon, rule, rules, zone)
      : findNextAnyRuleActivationAfter(cursor, horizon, rules, zone);
    if (boundary > now || boundary <= cursor) break;
    cursor = boundary;
  }
  const rule = findActiveRule(now, rules, zone);
  const boundary = rule ? findNextPriorityBoundary(now, horizon, rule, rules, zone)
    : findNextAnyRuleActivationAfter(now, horizon, rules, zone);
  const ruleAt = boundary < horizon ? boundary : null;
  let chargeAt: Date | null = null;
  const capped = input.intervalCapReached && (!input.intervalStartedAt || input.intervalStartedAt.getTime() === cursor.getTime());
  if (rule && "pricing" in rule && !capped && rule.pricing.unitPrice > 0) {
    const pricing = rule.pricing;
    const operated = Boolean(session.metadata?.deviceOperated || session.metadata?.hasDeviceActivity);
    let minutes = Math.max(0, Math.floor((now.getTime() - cursor.getTime()) / 60_000));
    const units = calculateUnits(minutes, pricing, operated);
    // At most two thresholds: grace expiry and the next whole unit. The unit
    // count rises once the leftover reaches the grace, so the grace boundary
    // is `cycle + max(grace, 1)` on the floored-minute grid (zero grace still
    // charges from the first whole minute).
    for (let attempt = 0; attempt < 3; attempt++) {
      const cycle = Math.floor(minutes / pricing.unitMinutes) * pricing.unitMinutes;
      const graceEnd = cycle + Math.max(pricing.roundGraceMinutes, 1);
      minutes = Math.min(cycle + pricing.unitMinutes, graceEnd > minutes ? graceEnd : Infinity);
      if (calculateUnits(minutes, pricing, operated) <= units) continue;
      const candidate = new Date(cursor.getTime() + minutes * 60_000);
      if (candidate <= boundary && candidate > now) chargeAt = candidate;
      break;
    }
  }
  return { ruleLabel: rule?.label ?? null, ruleAt, chargeAt, intervalStartedAt: cursor };
}

function findActiveRule<T extends TimeRuleLike>(
  date: Date,
  rules: readonly T[],
  timeZone: string,
): T | null {
  for (const rule of rules) {
    if (isRuleActiveAt(date, rule, timeZone)) return rule;
  }
  return null;
}

function buildRuleHistoryKey(
  pricingConfigId: string,
  providerId: string,
  date: Date,
  rule: TimeRuleLike,
  timeZone: string,
): string {
  return `${pricingConfigId}@${providerId}@${rule.historyRuleId ?? rule.id}@${getRuleAnchor(date, rule, timeZone).toISOString()}`;
}

function buildTimeCapHistoryKey(capConfigId: string, capRuleId: string, capAnchorAt: Date): string {
  return `${capConfigId}@${capRuleId}@${capAnchorAt.toISOString()}`;
}

function getRuleAnchor(date: Date, rule: TimeRuleLike, timeZone: string): Date {
  if (rule.anchorAt) return new Date(rule.anchorAt);
  if (rule.dateTimeRange && !rule.timeRange) return new Date(rule.dateTimeRange.start);
  if (!rule.timeRange) {
    throw new PrismDomainError("Time pricing rule has no time range.", "INVALID_TIME_PRICING_RULE");
  }

  const localDate = formatLocalDate(date, timeZone);
  let anchorLocalDate = localDate;
  const start = parseClockMinutes(rule.timeRange.start);
  const end = parseClockMinutes(rule.timeRange.end);
  const current = getZonedParts(date, timeZone).hour * 60 + getZonedParts(date, timeZone).minute;

  if (start >= end && current < start) {
    anchorLocalDate = addLocalDays(localDate, -1);
  }

  return parseLocalDateTime(anchorLocalDate, rule.timeRange.start, timeZone);
}

function isRuleActiveAt(date: Date, rule: TimeRuleLike, timeZone: string): boolean {
  if (rule.dateTimeRange) {
    if (date < rule.dateTimeRange.start || date >= rule.dateTimeRange.end) return false;
    if (!rule.timeRange) return true;
  }

  if (!rule.timeRange) return false;
  return isRuleDateMatch(date, rule, timeZone) && isTimeInRange(date, rule.timeRange, timeZone);
}

function findNextPriorityBoundary<T extends TimeRuleLike>(
  cursor: Date,
  endedAt: Date,
  activeRule: T,
  rules: readonly T[],
  timeZone: string,
): Date {
  let boundary = minDate(getRuleNaturalEnd(cursor, activeRule, timeZone), endedAt);

  for (const rule of rules) {
    if (rule.priority <= activeRule.priority) continue;
    const candidate = getNextRuleActivationAfter(cursor, rule, timeZone);
    if (candidate > cursor && candidate < boundary) {
      boundary = candidate;
    }
  }

  return boundary;
}

function getRuleNaturalEnd(cursor: Date, rule: TimeRuleLike, timeZone: string): Date {
  if (rule.dateTimeRange && !rule.timeRange) return new Date(rule.dateTimeRange.end);
  if (!rule.timeRange) {
    throw new PrismDomainError("Time pricing rule has no time range.", "INVALID_TIME_PRICING_RULE");
  }
  const clockEnd = parseNextClockTime(cursor, rule.timeRange.end, timeZone);
  return rule.dateTimeRange ? minDate(clockEnd, rule.dateTimeRange.end) : clockEnd;
}

function getNextRuleActivationAfter(cursor: Date, rule: TimeRuleLike, timeZone: string): Date {
  if (rule.dateTimeRange && !rule.timeRange) return new Date(rule.dateTimeRange.start);
  if (!rule.timeRange) {
    throw new PrismDomainError("Time pricing rule has no time range.", "INVALID_TIME_PRICING_RULE");
  }

  if (rule.dateTimeRange && rule.dateTimeRange.start > cursor && isRuleActiveAt(rule.dateTimeRange.start, rule, timeZone)) {
    return new Date(rule.dateTimeRange.start);
  }

  const baseLocalDate = formatLocalDate(cursor, timeZone);
  for (let dayOffset = 0; dayOffset <= 370; dayOffset += 1) {
    const localDate = addLocalDays(baseLocalDate, dayOffset);
    const candidate = parseLocalDateTime(localDate, rule.timeRange.start, timeZone);
    if (candidate <= cursor) continue;
    if (isRuleActiveAt(candidate, rule, timeZone)) return candidate;
  }

  return new Date(Number.POSITIVE_INFINITY);
}

function findNextAnyRuleActivationAfter(
  cursor: Date,
  fallbackBoundary: Date,
  rules: readonly TimeRuleLike[],
  timeZone: string,
): Date {
  let boundary = fallbackBoundary;
  for (const rule of rules) {
    const candidate = getNextRuleActivationAfter(cursor, rule, timeZone);
    if (candidate > cursor && candidate < boundary) boundary = candidate;
  }
  return boundary;
}

function isTimeInRange(date: Date, range: TimeRange, timeZone: string): boolean {
  const parts = getZonedParts(date, timeZone);
  const current = parts.hour * 60 + parts.minute;
  const start = parseClockMinutes(range.start);
  const end = parseClockMinutes(range.end);

  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

function isRuleDateMatch(date: Date, rule: TimeRuleLike, timeZone: string): boolean {
  const parts = getZonedParts(getRuleDateMatchAnchor(date, rule, timeZone), timeZone);
  if (rule.specificDates && !rule.specificDates.includes(formatLocalDateFromParts(parts))) return false;
  if (rule.weekdays && !rule.weekdays.includes(parts.weekday)) return false;
  return true;
}

function getRuleDateMatchAnchor(date: Date, rule: TimeRuleLike, timeZone: string): Date {
  if (!rule.timeRange) return date;

  const parts = getZonedParts(date, timeZone);
  const current = parts.hour * 60 + parts.minute;
  const start = parseClockMinutes(rule.timeRange.start);
  const end = parseClockMinutes(rule.timeRange.end);
  if (start >= end && current < start) {
    return parseLocalDateTime(addLocalDays(formatLocalDateFromParts(parts), -1), rule.timeRange.start, timeZone);
  }

  return date;
}

function parseNextClockTime(base: Date, time: string, timeZone: string): Date {
  const localDate = formatLocalDate(base, timeZone);
  let date = parseLocalDateTime(localDate, time, timeZone);
  if (date <= base) date = parseLocalDateTime(addLocalDays(localDate, 1), time, timeZone);
  return date;
}

export function parseLocalDateTime(localDate: string, time: string, timeZone: string): Date {
  const [year, month, day] = localDate.split("-").map(Number);
  const minutes = parseClockMinutes(time);
  return zonedLocalTimeToUtc(
    {
      year,
      month,
      day,
      hour: Math.floor(minutes / 60),
      minute: minutes % 60,
    },
    timeZone,
  );
}

function parseClockMinutes(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function minDate(a: Date, b: Date): Date {
  return a < b ? a : b;
}

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

const pricingFormatter = dateTimeFormatterCache({
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
});

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  if (timeZone === "UTC") {
    if (!Number.isFinite(date.getTime())) throw new RangeError("Invalid time value");
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
      hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds(), weekday: date.getUTCDay() };
  }
  const parts = pricingFormatter(timeZone).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: weekdayToNumber(map.weekday),
  };
}

function zonedLocalTimeToUtc(
  local: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date {
  let utc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0, 0);
  if (timeZone === "UTC") return new Date(utc);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const offset = getTimeZoneOffsetMs(new Date(utc), timeZone);
    utc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0, 0) - offset;
  }
  return new Date(utc);
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = getZonedParts(date, timeZone);
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
  return localAsUtc - date.getTime();
}

export function formatLocalDate(date: Date, timeZone: string): string {
  return formatLocalDateFromParts(getZonedParts(date, timeZone));
}

function formatLocalDateFromParts(parts: Pick<ZonedParts, "year" | "month" | "day">): string {
  const year = parts.year;
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addLocalDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 0, 0, 0, 0));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function getLocalMinuteOfDay(date: Date, localDate: string, timeZone: string): number {
  const parts = getZonedParts(date, timeZone);
  const dateString = formatLocalDateFromParts(parts);
  if (dateString < localDate) return 0;
  if (dateString > localDate) return 1440;
  return parts.hour * 60 + parts.minute;
}

function formatMinuteLabel(minute: number): string {
  if (minute >= 1440) return "24:00";
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function mergeAdjacentTimelineSegments(
  segments: PriorityTimePricingTimelineSegment[],
): PriorityTimePricingTimelineSegment[] {
  const merged: PriorityTimePricingTimelineSegment[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    // A rule that starts a new window where the last one ended (a cap resetting at 06:00) stays two pieces.
    if (previous && previous.ruleId === segment.ruleId && previous.endMinute === segment.startMinute
      && previous.windowStartedAt === segment.windowStartedAt) {
      previous.endMinute = segment.endMinute;
      previous.endLabel = segment.endLabel;
      previous.endedAt = segment.endedAt;
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
}

function weekdayToNumber(value: string): number {
  switch (value) {
    case "Sun":
      return 0;
    case "Mon":
      return 1;
    case "Tue":
      return 2;
    case "Wed":
      return 3;
    case "Thu":
      return 4;
    case "Fri":
      return 5;
    case "Sat":
      return 6;
    default:
      throw new PrismDomainError("Unknown weekday returned by Intl.", "INVALID_TIME_ZONE_WEEKDAY");
  }
}
