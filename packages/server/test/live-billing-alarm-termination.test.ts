import { describe, expect, it } from "bun:test";
import { LiveBilling } from "../src/durable-objects/live-billing.js";
import { LiveBilling as MaintenanceLiveBilling } from "../src/maintenance-worker.js";

const APNS_ENV = {
  APNS_KEY_ID: "key",
  APNS_TEAM_ID: "team",
  APNS_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----test-----END PRIVATE KEY-----",
};

function expiredAlarmHarness(createdAt: string | null) {
  const state = new Map<string, unknown>([
    ["visit", { shopId: "s", playerId: "p", revision: 1 }],
    ["sent:activity", "old-signature"],
    ["retry:activity", { signature: "x", failures: 2, nextAt: 1 }],
  ]);
  let alarm: number | null = Date.now();
  let deletes = 0;
  let alarmWrites = 0;
  const storage = {
    async get<T>(key: string): Promise<T | null> {
      return (state.get(key) as T) ?? null;
    },
    async put(key: string, value: unknown) { state.set(key, value); },
    async delete(key: string) { state.delete(key); },
    async deleteAlarm() { alarm = null; },
    async deleteAll() { state.clear(); alarm = null; },
    async setAlarm(next: number) { alarm = next; alarmWrites++; },
  };
  const token = createdAt === null ? [] : [{
    id: "activity", token: "abc123", bundle_id: "moe.neri.hinatago",
    environment: "sandbox", session_id: "sess",
    created_at: createdAt, started_at: createdAt,
    ended_at: null, payment_status: "unpaid",
    checkout_total: null, settled_at: null,
  }];
  const db = {
    prepare(_sql: string) {
      return {
        bind(..._values: unknown[]) {
          return {
            async all() { return { results: token }; },
            async run() { deletes++; return { success: true }; },
          };
        },
      };
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      for (const statement of statements) await statement.run();
    },
  };
  const object = new LiveBilling({ storage } as any, {
    ...APNS_ENV,
    DB: db,
  } as any);
  return { object, state, getAlarm: () => alarm, getAlarmWrites: () => alarmWrites, getDeletes: () => deletes };
}

describe("LiveBilling alarm termination", () => {
  it("clears the alarm and old token state after a token expires", async () => {
    const harness = expiredAlarmHarness(new Date(Date.now() - 9 * 3600_000).toISOString());
    await harness.object.alarm();
    expect(harness.getAlarm()).toBeNull();
    expect(harness.getAlarmWrites()).toBe(0);
    expect(harness.getDeletes()).toBe(1);
    expect(harness.state.has("visit")).toBe(false);
    expect(harness.state.has("retry:activity")).toBe(false);
    expect(harness.state.has("sent:activity")).toBe(false);
    expect(harness.state.has("alarm-budget")).toBe(true);
  });

  it("clears a stale DO when its activity list is empty", async () => {
    const harness = expiredAlarmHarness(null);
    await harness.object.alarm();
    expect(harness.getAlarm()).toBeNull();
    expect(harness.getAlarmWrites()).toBe(0);
    expect(harness.state.has("visit")).toBe(false);
  });

  it("does not keep alarming on malformed or far-future activity timestamps", async () => {
    for (const createdAt of ["not-a-date", "2035-01-01T00:00:00.000Z"]) {
      const harness = expiredAlarmHarness(createdAt);
      await harness.object.alarm();
      expect(harness.getAlarm()).toBeNull();
      expect(harness.getAlarmWrites()).toBe(0);
      expect(harness.getDeletes()).toBe(1);
    }
  });
});


describe("maintenance worker alarm termination", () => {
  it("does not shorten an existing maintenance alarm on repeated refreshes", async () => {
    const state = new Map<string, unknown>();
    const initial = Date.now() + 30 * 60_000;
    let alarm: number | null = initial;
    let writes = 0;
    const storage = {
      async get<T>(key: string): Promise<T | null> { return (state.get(key) as T) ?? null; },
      async put(key: string, value: unknown) { state.set(key, value); },
      async getAlarm() { return alarm; },
      async setAlarm(at: number) { alarm = at; writes++; },
      async deleteAlarm() { alarm = null; },
    };
    const object = new MaintenanceLiveBilling({ storage } as any, {} as any);
    await object.refresh("s", "p", true, true);
    for (let i = 0; i < 9; i++) await object.refresh("s", "p");
    expect(state.get("visit")).toMatchObject({ terminal: true, urgent: true });
    expect(writes).toBe(0);
    expect(alarm).toBe(initial);
    expect((state.get("visit") as { revision: number }).revision).toBe(10);
  });
});
