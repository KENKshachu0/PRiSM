import { describe, expect, it } from "bun:test";
import {
  BILLING_ALARM_BURST,
  BILLING_ALARM_REFILL_MS,
  MIN_BILLING_ALARM_INTERVAL_MS,
  MAX_MAINTENANCE_WAIT_MS,
  checkAlarmBudget,
  nextMaintenanceRetry,
  spendAlarmBudget,
  type AlarmBudget,
  type MaintenanceWait,
} from "../src/durable-objects/alarm-budget.js";

describe("persistent LiveBilling alarm abuse budget", () => {
  const start = 1_800_000_000_000;

  it("permits occasional one-minute updates without suppressing legitimate changes", () => {
    let state: AlarmBudget | null = null;
    for (const minute of [0, 1, 10, 11]) {
      const now = start + minute * 60_000;
      const decision = checkAlarmBudget(state, now);
      expect(decision.allowed).toBe(true);
      state = spendAlarmBudget(decision, now);
    }
  });

  it("limits sustained minute-by-minute billing even when every bill changes", () => {
    let state: AlarmBudget | null = null;
    const sentAt: number[] = [];
    // Simulate a tenant whose configured price changes once per minute for 2h.
    for (let minute = 0; minute < 120; minute++) {
      const now = start + minute * MIN_BILLING_ALARM_INTERVAL_MS;
      const decision = checkAlarmBudget(state, now);
      if (decision.allowed) {
        state = spendAlarmBudget(decision, now);
        sentAt.push(minute);
      }
    }
    expect(sentAt.slice(0, 4)).toEqual([0, 1, 2, 3]);
    expect(sentAt).not.toContain(4);
    // Long-lived high-frequency pricing cannot sustain 60 alarms per hour.
    expect(sentAt.length).toBeLessThanOrEqual(2 * (BILLING_ALARM_BURST + 60 * 60_000 / BILLING_ALARM_REFILL_MS));
    expect(sentAt.length).toBeLessThan(30);
  });

  it("blocks a push less than one minute after a completed calculation", () => {
    const state = spendAlarmBudget(checkAlarmBudget(null, start), start);
    const early = checkAlarmBudget(state, start + 59_999);
    expect(early.allowed).toBe(false);
    expect(early.nextAllowedAt).toBe(start + 60_000);
    expect(checkAlarmBudget(state, start + 60_000).allowed).toBe(true);
  });

  it("does not reset exhausted quota when a refresh or new billing revision arrives", () => {
    let state: AlarmBudget | null = null;
    for (let i = 0; i < 4; i++) {
      const now = start + i * 60_000;
      state = spendAlarmBudget(checkAlarmBudget(state, now), now);
    }
    // Business revision is intentionally NOT a policy input.
    const blocked = checkAlarmBudget(state, start + 4 * 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.nextAllowedAt).toBe(start + 5 * 60_000);
  });

  it("reads budgets from older deployments without resetting ordinary quota", () => {
    const previous = {
      tokens: 0, updatedAt: start, lastRunAt: start, lastTerminalBypassAt: start,
    };
    const decision = checkAlarmBudget(previous, start + 1000);
    expect(decision.allowed).toBe(false);
    expect(decision.nextAllowedAt).toBe(start + BILLING_ALARM_REFILL_MS);
  });

  it("backs off maintenance alarms and stops after the eight-hour token lifetime", () => {
    let state: MaintenanceWait | null = null;
    const delays: number[] = [];
    let now = start;
    for (let i = 0; i < 10; i++) {
      const next = nextMaintenanceRetry(state, now);
      expect(next.nextAt).not.toBeNull();
      delays.push(next.nextAt! - now);
      state = next.state;
      now = next.nextAt!;
    }
    expect(delays.slice(0, 4)).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(delays.every(delay => delay <= 60 * 60_000)).toBe(true);
    expect(nextMaintenanceRetry(state, start + MAX_MAINTENANCE_WAIT_MS).nextAt).toBeNull();
  });
});
