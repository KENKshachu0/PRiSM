import { expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { LiveBilling } from "../src/durable-objects/live-billing.js";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { LiveActivityPusher, liveActivityUpdatePayload } from "../src/durable-objects/live-activity-push.js";

async function fixture(statuses: number[]) {
  let now = 1_800_000_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE shop_player_accounts(shop_id TEXT, user_id TEXT, player_id TEXT);
    CREATE TABLE sessions(shop_id TEXT, id TEXT, player_id TEXT, started_at TEXT, ended_at TEXT, payment_status TEXT);
    CREATE TABLE live_activity_tokens(id TEXT, token TEXT, environment TEXT, bundle_id TEXT, session_id TEXT, shop_id TEXT, user_id TEXT, created_at TEXT);
    CREATE TABLE settlements(shop_id TEXT, session_id TEXT, checkout_id TEXT);
    CREATE TABLE player_checkouts(shop_id TEXT, id TEXT, total INTEGER, settled_at TEXT);
    INSERT INTO shop_player_accounts VALUES ('shop','user','player');
  `);
  const state = new Map<string, unknown>([["alarm-budget", {
    tokens: 0, updatedAt: now, lastRunAt: now, lastTerminalBypassAt: now,
  }]]);
  let alarm: number | null = null;
  const storage = {
    async get<T>(key: string) { return state.get(key) as T | undefined; },
    async put(key: string, value: unknown) { state.set(key, value); },
    async delete(key: string) { return state.delete(key); },
    async getAlarm() { return alarm; },
    async setAlarm(at: number) { alarm = at; },
    async deleteAlarm() { alarm = null; },
    async deleteAll() { state.clear(); },
  };
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const encoded = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey))));
  const config = { keyId: "key", teamId: "team", privateKey: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----` };
  const env = {
    DB: createD1DatabaseFromSqlite(sqlite),
    APNS_KEY_ID: config.keyId, APNS_TEAM_ID: config.teamId, APNS_PRIVATE_KEY: config.privateKey,
  };
  const object = () => new LiveBilling({ storage } as any, env as any);
  const pushes: Array<{ headers: Headers; payload: any }> = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
    pushes.push({ headers: new Headers(init?.headers), payload: JSON.parse(String(init?.body)) });
    return new Response("", { status: statuses.shift() ?? 200 });
  }) as typeof fetch);
  const addVisit = (id: string) => {
    const date = new Date(now).toISOString();
    sqlite.run("INSERT INTO sessions VALUES ('shop',?,'player',?,?,'paid')", [id, date, date]);
    sqlite.run("INSERT INTO live_activity_tokens VALUES (?,?, 'production','moe.neri.hinatago.prism',?,'shop','user',?)", [id, id.repeat(64), id, date]);
    sqlite.run("INSERT INTO settlements VALUES ('shop',?,?)", [id, id]);
    sqlite.run("INSERT INTO player_checkouts VALUES ('shop',?,1234,?)", [id, date]);
  };
  return {
    state, sqlite, pushes, config, object, addVisit, now: () => now, alarm: () => alarm,
    advance: (ms: number) => { now += ms; },
    runAlarm: async () => { expect(alarm).not.toBeNull(); now = alarm!; alarm = null; await object().alarm(); },
    close: () => { fetchSpy.mockRestore(); clock.mockRestore(); sqlite.close(); },
  };
}

it("two settled visits of the same player end promptly despite exhausted ordinary quota and DO restart", async () => {
  const h = await fixture([]);
  try {
    for (const id of ["a", "b"]) {
      h.addVisit(id);
      await h.object().refresh("shop", "player", true);
      expect(h.alarm()).toBe(h.now() + 1000);
      await h.runAlarm();
      expect(h.pushes.at(-1)?.payload.aps).toMatchObject({
        event: "end", "content-state": { phase: "ended", bill: { amountCents: 1234 } },
      });
      expect(h.pushes.at(-1)?.headers.get("apns-priority")).toBe("10");
      expect(h.sqlite.query("SELECT COUNT(*) AS n FROM live_activity_tokens").get()).toEqual({ n: 0 });
      h.advance(1000);
    }
    expect(h.pushes).toHaveLength(2);
  } finally { h.close(); }
});

it("a failed final push retries after five seconds without waiting for billing quota", async () => {
  const h = await fixture([503, 200]);
  try {
    h.addVisit("a");
    await h.object().refresh("shop", "player", true);
    await h.runAlarm();
    expect(h.pushes).toHaveLength(1);
    expect(h.alarm()).toBe(h.now() + 5000);
    expect(h.sqlite.query("SELECT COUNT(*) AS n FROM live_activity_tokens").get()).toEqual({ n: 1 });
    await h.runAlarm();
    expect(h.pushes).toHaveLength(2);
    expect(h.sqlite.query("SELECT COUNT(*) AS n FROM live_activity_tokens").get()).toEqual({ n: 0 });
    expect(h.alarm()).toBeNull();
  } finally { h.close(); }
});

it("repeated checkout notifications cannot accelerate backoff or restart six exhausted final attempts", async () => {
  const h = await fixture(Array(6).fill(429));
  try {
    h.addVisit("a");
    await h.object().refresh("shop", "player", true);
    for (let attempt = 1; attempt <= 6; attempt++) {
      await h.runAlarm();
      expect(h.pushes).toHaveLength(attempt);
      if (attempt < 6) {
        const retryAt = h.alarm();
        await h.object().refresh("shop", "player", true);
        await h.runAlarm();
        expect(h.pushes).toHaveLength(attempt);
        expect(h.alarm()).toBe(retryAt);
      }
    }
    await h.object().refresh("shop", "player", true);
    await h.runAlarm();
    expect(h.pushes).toHaveLength(6);
    expect(h.alarm()).toBeGreaterThan(h.now() + 60_000);
  } finally { h.close(); }
});

it("ordinary bill updates use APNs priority five", async () => {
  const h = await fixture([]);
  try {
    const pusher = new LiveActivityPusher({ config: h.config });
    await pusher.send({ token: "a".repeat(64), environment: "production", bundleId: "moe.neri.hinatago.prism" },
      liveActivityUpdatePayload({ startedAtUnix: h.now() / 1000, now: h.now() / 1000 }));
    expect(h.pushes[0]?.headers.get("apns-priority")).toBe("5");
  } finally { h.close(); }
});

it("legacy oversized activity sets retain the four-request alarm ceiling", async () => {
  const h = await fixture([]);
  try {
    for (const id of ["a", "b", "c", "d", "e"]) h.addVisit(id);
    await h.object().refresh("shop", "player", true);
    await h.runAlarm();
    expect(h.pushes).toHaveLength(4);
    expect(h.alarm()).toBe(h.now() + 60_000);
    await h.runAlarm();
    expect(h.pushes).toHaveLength(5);
    expect(h.alarm()).toBeNull();
  } finally { h.close(); }
});
