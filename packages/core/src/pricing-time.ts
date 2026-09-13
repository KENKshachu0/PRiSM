import { PrismDomainError } from "./errors";
import type { ChargeItem, PricingProvider, SettlementAdjustment } from "./settlement";

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
  timeRange?: TimeRange;
  dateTimeRange?: {
    start: Date;
    end: Date;
  };
  priceCap: number;
};

export type PriorityTimePricingProviderConfig = {
  name?: string;
  id: string;
  pricingConfigId?: string;
  rules: readonly PriorityTimePricingRule[];
  timeZone?: string;
  paidHistory?: Record<string, number>;
};

export type TimeCapPricingProviderConfig = {
  id: string;
  pricingConfigId?: string;
  includedPricingConfigIds: readonly string[];
  rules: readonly TimeCapPricingRule[];
  timeZone?: string;
  paidHistory?: Record<string, number>;
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
  capConfigId: string;
  capRuleId: string;
  ruleLabel: string;
  windowStartedAt: Date;
  windowEndedAt: Date;
  priceCap: number;
  paidBefore: number;
  currentAmount: number;
  amountApplied: number;
  contributions: Array<{ sessionId: string; pricingConfigId: string; amount: number }>;
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
      const currentPaidHistory: Record<string, number> = { ...(config.paidHistory ?? {}) };
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
        const paidBefore = currentPaidHistory[historyKey] ?? 0;
        const amount = calculateUnitPriceWithHistory(
          durationMinutes,
          rule.pricing,
          paidBefore,
          invalidateFirstGrace,
        );
        const units = calculateUnits(durationMinutes, rule.pricing, invalidateFirstGrace);
        currentPaidHistory[historyKey] = paidBefore + amount;
        if (amount > 0) {
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
            ruleId: rule.id,
            ruleAnchorAt: getRuleAnchor(cursor, rule, timeZone),
            amount,
          },
          pricingExplanation: {
            timeZone,
            units,
            planName: config.name,
            pricing: { ...rule.pricing },
            paidBefore,
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
            intervalCapReached: paidBefore + amount >= rule.pricing.priceCap,
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
      const key = buildTimeCapHistoryKey(capConfigId, rule.id, capAnchorAt);
      keys.set(key, {
        capConfigId,
        capRuleId: rule.id,
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
  return explainTimeCapPricing(input)
    .map((window) => ({
      window,
      adjustmentAmount: window.amountApplied - window.currentAmount,
    }))
    .filter(({ window, adjustmentAmount }) => adjustmentAmount !== 0 || window.amountApplied > 0)
    .map(({ window, adjustmentAmount }) => ({
      id: `time-cap:${window.capConfigId}:${window.capRuleId}:${window.windowStartedAt.toISOString()}`,
      source: `time.cap:${window.capConfigId}:${window.capRuleId}`,
      label: window.ruleLabel,
      amount: adjustmentAmount,
      pricingCapHistory: {
        capConfigId: window.capConfigId,
        capRuleId: window.capRuleId,
        capAnchorAt: window.windowStartedAt,
        includedPricingConfigIds: [...input.config.includedPricingConfigIds],
        amount: Math.max(0, window.amountApplied),
      },
    }));
}

export function explainTimeCapPricing(input: {
  config: TimeCapPricingProviderConfig;
  chargeItems: readonly ChargeItem[];
  paidHistory?: Record<string, number>;
}): TimeCapPricingWindow[] {
  const rules = activeRules(input.config.rules).sort((a, b) => b.priority - a.priority);
  const timeZone = input.config.timeZone ?? "UTC";
  const capConfigId = input.config.pricingConfigId ?? input.config.id;
  const included = new Set(input.config.includedPricingConfigIds);
  const buckets = new Map<string, {
    rule: TimeCapPricingRule;
    capAnchorAt: Date;
    amount: number;
    contributions: Map<string, { sessionId: string; pricingConfigId: string; amount: number }>;
  }>();

  for (const item of input.chargeItems) {
    const pricingConfigId = item.pricingHistory?.pricingConfigId;
    if (!pricingConfigId || !included.has(pricingConfigId) || !item.period) continue;
    const startedAt = new Date(item.period.startedAt);
    const endedAt = new Date(item.period.endedAt);
    const totalMs = endedAt.getTime() - startedAt.getTime();
    if (totalMs <= 0) continue;

    let cursor = startedAt;
    while (cursor < endedAt) {
      const rule = findActiveRule(cursor, rules, timeZone);
      if (!rule) {
        cursor = findNextAnyRuleActivationAfter(cursor, endedAt, rules, timeZone);
        continue;
      }
      const nextBoundary = findNextPriorityBoundary(cursor, endedAt, rule, rules, timeZone);
      const overlapMs = nextBoundary.getTime() - cursor.getTime();
      const proratedAmount = item.amount * (overlapMs / totalMs);
      const capAnchorAt = getRuleAnchor(cursor, rule, timeZone);
      const key = buildTimeCapHistoryKey(capConfigId, rule.id, capAnchorAt);
      const bucket = buckets.get(key) ?? {
        rule,
        capAnchorAt,
        amount: 0,
        contributions: new Map(),
      };
      bucket.amount += proratedAmount;
      if (item.sessionId) {
        const contributionKey = JSON.stringify([item.sessionId, pricingConfigId]);
        const contribution = bucket.contributions.get(contributionKey) ?? {
          sessionId: item.sessionId,
          pricingConfigId,
          amount: 0,
        };
        contribution.amount += proratedAmount;
        bucket.contributions.set(contributionKey, contribution);
      }
      buckets.set(key, bucket);
      cursor = nextBoundary;
    }
  }

  const windows: TimeCapPricingWindow[] = [];
  const currentPaidHistory: Record<string, number> = { ...(input.paidHistory ?? input.config.paidHistory ?? {}) };
  for (const [key, bucket] of buckets) {
    const paidBefore = currentPaidHistory[key] ?? 0;
    const target = calculateCapWindowTarget(bucket.amount, bucket.rule.priceCap, paidBefore);
    currentPaidHistory[key] = paidBefore + Math.max(0, target);
    windows.push({
      key,
      capConfigId,
      capRuleId: bucket.rule.id,
      ruleLabel: bucket.rule.label,
      windowStartedAt: bucket.capAnchorAt,
      windowEndedAt: getRuleNaturalEnd(bucket.capAnchorAt, bucket.rule, timeZone),
      priceCap: bucket.rule.priceCap,
      paidBefore,
      currentAmount: bucket.amount,
      amountApplied: target,
      contributions: [...bucket.contributions.values()],
    });
  }

  return windows;
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
      ruleId: rule.id,
      ruleAnchorAt,
      key,
    });
    cursor = nextBoundary;
  }

  return [...keys.values()];
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
}): PriorityTimePricingTimeline {
  return buildTimeRuleTimeline({
    localDate: input.localDate,
    config: input.config,
    segmentValue: (rule) => ({ pricing: rule.pricing }),
  });
}

export function buildTimeCapPricingTimeline(input: {
  localDate: string;
  config: TimeCapPricingProviderConfig;
}): PriorityTimePricingTimeline {
  return buildTimeRuleTimeline({
    localDate: input.localDate,
    config: input.config,
    segmentValue: (rule) => ({ priceCap: rule.priceCap }),
  });
}

function buildTimeRuleTimeline<T extends TimeRuleLike>(input: {
  localDate: string;
  config: {
    id: string;
    rules: readonly T[];
    timeZone?: string;
  };
  segmentValue: (rule: T) => Pick<PriorityTimePricingTimelineSegment, "pricing" | "priceCap">;
}): PriorityTimePricingTimeline {
  const rules = activeRules(input.config.rules).sort((a, b) => b.priority - a.priority);
  const timeZone = input.config.timeZone ?? "UTC";
  const dayStart = parseLocalDateTime(input.localDate, "00:00", timeZone);
  const dayEnd = parseLocalDateTime(addLocalDays(input.localDate, 1), "00:00", timeZone);
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

    const startMinute = getLocalMinuteOfDay(cursor, input.localDate, timeZone);
    const endMinute = getLocalMinuteOfDay(nextBoundary, input.localDate, timeZone);
    if (rule) {
      segments.push({
        ruleId: rule.id,
        label: rule.label,
        priority: rule.priority,
        startMinute,
        endMinute,
        startLabel: formatMinuteLabel(startMinute),
        endLabel: formatMinuteLabel(endMinute),
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
        isClosed: true,
      });
    }

    cursor = nextBoundary;
  }

  return {
    providerId: input.config.id,
    localDate: input.localDate,
    timeZone,
    segments: mergeAdjacentTimelineSegments(segments),
  };
}

function activeRules<T extends TimeRuleLike>(rules: readonly T[]): T[] {
  return rules.filter((rule) => (rule.status ?? "active") === "active");
}

function calculateCapWindowTarget(currentAmount: number, priceCap: number, paidBefore: number): number {
  if (paidBefore >= priceCap) return 0;
  if (currentAmount <= 0) return currentAmount;
  return Math.max(0, Math.min(currentAmount, priceCap - paidBefore));
}

function calculateUnitPrice(
  durationMinutes: number,
  config: UnitPricingConfig,
  invalidateFirstGrace?: boolean,
): number {
  if (durationMinutes <= 0 && !invalidateFirstGrace) return 0;

  return calculateRawUnitPrice(durationMinutes, config, invalidateFirstGrace);
}

function calculateUnitPriceWithHistory(
  durationMinutes: number,
  config: UnitPricingConfig,
  paidBefore: number,
  invalidateFirstGrace?: boolean,
): number {
  if (durationMinutes <= 0 && !invalidateFirstGrace) return 0;

  const raw = calculateRawUnitPrice(durationMinutes, {
    ...config,
    priceCap: Number.MAX_SAFE_INTEGER,
  }, invalidateFirstGrace);
  if (raw <= 0) return raw;

  const effectiveTotal = Math.min(paidBefore + raw, config.priceCap);
  return Math.max(0, effectiveTotal - paidBefore);
}

function calculateRawUnitPrice(
  durationMinutes: number,
  config: UnitPricingConfig,
  invalidateFirstGrace?: boolean,
): number {
  return Math.min(calculateUnits(durationMinutes, config, invalidateFirstGrace) * config.unitPrice, config.priceCap);
}

function calculateUnits(durationMinutes: number, config: UnitPricingConfig, invalidateFirstGrace?: boolean): number {
  let units = Math.floor(Math.max(0, durationMinutes) / config.unitMinutes);
  if (durationMinutes % config.unitMinutes > config.roundGraceMinutes) {
    units += 1;
  }
  if (invalidateFirstGrace && units === 0) {
    units = 1;
  }

  return units;
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
  return `${pricingConfigId}@${providerId}@${rule.id}@${getRuleAnchor(date, rule, timeZone).toISOString()}`;
}

function buildTimeCapHistoryKey(capConfigId: string, capRuleId: string, capAnchorAt: Date): string {
  return `${capConfigId}@${capRuleId}@${capAnchorAt.toISOString()}`;
}

function getRuleAnchor(date: Date, rule: TimeRuleLike, timeZone: string): Date {
  if (rule.dateTimeRange && !rule.timeRange) return new Date(rule.dateTimeRange.start);
  if (!rule.timeRange) {
    throw new PrismDomainError("Time pricing rule has no time range.", "INVALID_TIME_PRICING_RULE");
  }

  const localDate = formatLocalDate(date, timeZone);
  let anchorLocalDate = localDate;
  const start = parseClockMinutes(rule.timeRange.start);
  const end = parseClockMinutes(rule.timeRange.end);
  const current = getZonedParts(date, timeZone).hour * 60 + getZonedParts(date, timeZone).minute;

  if (start > end && current < end) {
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
  if (start > end && current < end) {
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

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  }).formatToParts(date);
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
    if (previous && previous.ruleId === segment.ruleId && previous.endMinute === segment.startMinute) {
      previous.endMinute = segment.endMinute;
      previous.endLabel = segment.endLabel;
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
