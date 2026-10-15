/**
 * A per-player, persistent ordinary billing budget. Count executions, not changed billing
 * signatures: a merchant can legitimately configure a one-minute billing step,
 * but this must not result in unlimited one-minute DO alarms / APNs pushes.
 *
 * Four short-spaced updates are allowed, then the budget refills at one
 * execution per five minutes. All decisions survive DO hibernation.
 */
export const MIN_BILLING_ALARM_INTERVAL_MS = 60_000;
export const BILLING_ALARM_BURST = 4;
export const BILLING_ALARM_REFILL_MS = 5 * 60_000;

export type AlarmBudget = {
  tokens: number;
  updatedAt: number;
  lastRunAt: number;
};

export type AlarmDecision = {
  allowed: boolean;
  nextAllowedAt: number;
  state: AlarmBudget;
};

function normalizeBudget(previous: AlarmBudget | null | undefined, now: number): AlarmBudget {
  if (!previous || !Number.isFinite(previous.tokens) ||
      !Number.isFinite(previous.updatedAt) || !Number.isFinite(previous.lastRunAt)) {
    return { tokens: BILLING_ALARM_BURST, updatedAt: now, lastRunAt: 0 };
  }
  const elapsed = Math.max(0, now - previous.updatedAt);
  return {
    tokens: Math.min(BILLING_ALARM_BURST, Math.max(0, previous.tokens) + elapsed / BILLING_ALARM_REFILL_MS),
    updatedAt: now,
    lastRunAt: Math.max(0, previous.lastRunAt),
  };
}

export function checkAlarmBudget(
  previous: AlarmBudget | null | undefined,
  now: number,
): AlarmDecision {
  const state = normalizeBudget(previous, now);
  const nextInterval = state.lastRunAt ? state.lastRunAt + MIN_BILLING_ALARM_INTERVAL_MS : now;
  const nextRefill = state.tokens >= 1
    ? now
    : now + Math.ceil((1 - state.tokens) * BILLING_ALARM_REFILL_MS);
  const nextAllowedAt = Math.max(now, nextInterval, nextRefill);
  return { allowed: nextAllowedAt <= now, nextAllowedAt, state };
}

export function spendAlarmBudget(decision: AlarmDecision, now: number): AlarmBudget {
  if (!decision.allowed) throw new Error("Cannot spend a blocked alarm budget");
  return {
    ...decision.state,
    tokens: Math.max(0, decision.state.tokens - 1),
    updatedAt: now,
    lastRunAt: now,
  };
}

export const MAX_MAINTENANCE_WAIT_MS = 8 * 60 * 60_000;
export type MaintenanceWait = { startedAt: number; attempts: number };
export function nextMaintenanceRetry(previous: MaintenanceWait | null | undefined, now: number): {
  state: MaintenanceWait;
  nextAt: number | null;
} {
  const startedAt = previous && Number.isFinite(previous.startedAt) && previous.startedAt <= now
    ? previous.startedAt : now;
  const attempts = previous && Number.isFinite(previous.attempts)
    ? Math.max(0, previous.attempts) : 0;
  const state = { startedAt, attempts: attempts + 1 };
  const deadline = startedAt + MAX_MAINTENANCE_WAIT_MS;
  if (now >= deadline) return { state, nextAt: null };
  const delay = Math.min(60 * 60_000, 60_000 * 2 ** Math.min(attempts, 6));
  return { state, nextAt: Math.min(now + delay, deadline) };
}
