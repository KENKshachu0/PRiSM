import { describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { deviceEventSchema } from "@prism/storage-sql";
import { encryptSecret } from "../src/crypto.js";
import { loadDevice } from "../src/devices/device.js";
import { newHaConnection, writeHaConnection } from "../src/devices/ha-connections.js";
import { readDeviceFacts } from "../src/devices/state-view.js";
import { LEASE_MS, ShopHub } from "../src/durable-objects/shop-hub.js";
import type { HaWatch } from "../src/durable-objects/machine-relay.js";

const KEY = "hub-test-key";
const SHOP = "shop-1";

async function fixture(options: { climate?: boolean } = {}) {
  const sqlite = new Database(":memory:");
  sqlite.run(`CREATE TABLE players(shop_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(shop_id, id))`);
  sqlite.run(
    `CREATE TABLE machines(shop_id TEXT NOT NULL, id TEXT NOT NULL, public_id TEXT, name TEXT, aliases_json TEXT,
       kind TEXT DEFAULT 'machine', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT '2026-01-01', PRIMARY KEY(shop_id, id))`,
  );
  sqlite.run(`CREATE TABLE app_settings(shop_id TEXT, key TEXT, value_json TEXT, updated_at TEXT, PRIMARY KEY(shop_id, key))`);
  for (const statement of deviceEventSchema) sqlite.run(statement);
  const db = createD1DatabaseFromSqlite(sqlite);
  const connection = {
    ...(await newHaConnection("https://ha.example", "control", KEY)),
    internalUrl: "http://ha.local:8123",
    readToken: await encryptSecret("reader", KEY),
    readAccess: "ready" as const,
  };
  await writeHaConnection(db, SHOP, connection).run();
  const bind = (device: string, capability: string, entity: string) => {
    sqlite.run(
      `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
       VALUES (?,?,?,?,'{}','2026-01-01','2026-01-01')`,
      [SHOP, device, capability, JSON.stringify({ connectionId: connection.id, entityId: entity })],
    );
  };
  for (const [device, entity] of [["m1", "switch.a"], ["m2", "switch.b"]] as const) {
    sqlite.run("INSERT INTO machines(shop_id,id,public_id,name,aliases_json) VALUES (?,?,?,?,'[]')", [SHOP, device, `pub-${device}`, device]);
    bind(device, "power", entity);
  }
  if (options.climate) {
    sqlite.run("INSERT INTO machines(shop_id,id,public_id,name,aliases_json) VALUES (?,?,?,?,'[]')", [SHOP, "m3", "pub-m3", "m3"]);
    bind("m3", "climate", "climate.c");
  }
  const watches: Array<{ channel: string; watch: HaWatch | null }> = [];
  const reachable = new Set(["chan-a", "chan-b", "chan-c"]);
  const env = {
    DB: db,
    URL_ENCRYPTION_KEY: KEY,
    MACHINE_RELAY: {
      getByName: (channel: string) => ({
        async watchHa(watch: HaWatch | null) {
          watches.push({ channel, watch });
          return { ok: reachable.has(channel) };
        },
      }),
    },
  };
  const state = new Map<string, unknown>();
  const sockets: any[] = [];
  const puts: string[] = [];
  let alarm: number | null = null;
  let alarms = 0;
  const alarmHistory: number[] = [];
  const ctx = {
    storage: {
      async get<T>(key: string) { return structuredClone(state.get(key)) as T | undefined; },
      async put(key: string, value: unknown) { puts.push(key); state.set(key, structuredClone(value)); },
      async delete(key: string) { return state.delete(key); },
      async getAlarm() { return alarm; },
      async setAlarm(at: number) { alarms += 1; alarm = at; alarmHistory.push(at); },
      async deleteAlarm() { alarm = null; },
    },
    acceptWebSocket(ws: any, tags: string[] = []) { ws.tags = tags; sockets.push(ws); },
    getWebSockets(tag?: string) { return tag ? sockets.filter((ws) => ws.tags?.includes(tag)) : sockets; },
  };
  const hub = new ShopHub(ctx as any, env as any);
  const rows = <T>(sql: string) => sqlite.query<T, []>(sql).all();
  const power = () => rows<{ device_id: string; value_json: string; changed_at: string }>(
    "SELECT device_id, value_json, changed_at FROM device_state WHERE key='power' ORDER BY device_id",
  );
  const changes = (capability: string) => rows<{ name: string; payload_json: string }>(
    `SELECT name, payload_json FROM device_events WHERE kind='change' AND capability='${capability}' ORDER BY occurred_at, id`,
  );
  const watched = () => rows<{ connection_id: string }>("SELECT connection_id FROM ha_event_connections").map((row) => row.connection_id);
  const facts = async (deviceId: string) => readDeviceFacts(db, SHOP, (await loadDevice(db, SHOP, deviceId))!);
  const assigned = () => watches.filter((entry) => entry.watch).map((entry) => [entry.channel, entry.watch!.term] as const);
  return {
    hub, watches, reachable, state, sqlite, sockets, puts, alarm: () => alarm, alarms: () => alarms, alarmHistory,
    // The runtime has cleared the alarm by the time its handler runs.
    clearAlarm: () => { alarm = null; },
    connectionId: connection.id, power, changes, watched, facts, assigned,
  };
}

const NOON = "2026-10-21T09:00:00.000Z";
type Entry = [entity: string, state: string, lastChanged: string, lastUpdated?: string | null, attributes?: Record<string, unknown>];
const states = (term: number, connection: string, list: Entry[], full = true) => ({
  method: "ha.states" as const,
  params: {
    term,
    connection,
    full,
    states: list.map(([entity_id, state, last_changed, last_updated, attributes]) => ({
      entity_id, state, last_changed, last_updated: last_updated ?? null, attributes: attributes ?? {},
    })),
  },
});
const status = (term: number, connection: string, connected: boolean) => ({
  method: "ha.status" as const,
  params: { term, connection, connected, error: connected ? null : "refused" },
});

describe("ShopHub watchers", () => {
  it("gives the watch to the two IOs online longest, with the shop-local address first", async () => {
    const { hub, watches, assigned, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    await hub.relayOnline(SHOP, "c", "chan-c");
    expect(assigned()).toEqual([["chan-a", 1], ["chan-b", 2]]);
    expect(watches[0]).toEqual({
      channel: "chan-a",
      watch: {
        term: 1,
        connections: [{ id: connectionId, urls: ["http://ha.local:8123", "https://ha.example"], token: "reader", entities: ["switch.a", "switch.b"] }],
      },
    });
  });

  it("records only reports from a current watcher and term, at the time Home Assistant gives", async () => {
    const { hub, power, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    await hub.relayOnline(SHOP, "c", "chan-c");
    // c is not watching, and term 0 is not an assignment a has.
    await hub.haReport(SHOP, "c", states(3, connectionId, [["switch.a", "on", NOON]]));
    await hub.haReport(SHOP, "a", states(0, connectionId, [["switch.a", "on", NOON]]));
    expect(power()).toEqual([]);
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON], ["switch.b", "off", "2026-10-21T08:00:00.000Z"]]));
    expect(power()).toEqual([
      { device_id: "m1", value_json: '"on"', changed_at: NOON },
      { device_id: "m2", value_json: '"off"', changed_at: "2026-10-21T08:00:00.000Z" },
    ]);
  });

  it("announces a connection only once a watcher has delivered its full state", async () => {
    const { hub, watched, facts, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    expect(watched()).toEqual([]);
    // Subscribed but nothing stored yet: still not watched.
    await hub.haReport(SHOP, "a", status(1, connectionId, true));
    expect(watched()).toEqual([]);
    expect(await facts("m1")).toEqual({ watching: false, power: null, climate: null });
    // An incremental report is not the full state.
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON]], false));
    expect(watched()).toEqual([]);
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON], ["switch.b", "off", NOON]]));
    expect(watched()).toEqual([connectionId]);
    expect(await facts("m1")).toEqual({ watching: true, power: "on", climate: null });
    expect(await facts("m2")).toEqual({ watching: true, power: "off", climate: null });
  });

  it("does not announce a snapshot it could not store, and asks the IO to subscribe again", async () => {
    const { hub, watched, sqlite, assigned, connectionId } = await fixture();
    const quiet = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await hub.relayOnline(SHOP, "a", "chan-a");
      sqlite.run("ALTER TABLE device_state RENAME TO device_state_away");
      await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON]]));
      expect(watched()).toEqual([]);
      // A new term makes the IO send the full state again.
      expect(assigned()).toEqual([["chan-a", 1], ["chan-a", 2]]);
      sqlite.run("ALTER TABLE device_state_away RENAME TO device_state");
      await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON]]));
      expect(watched()).toEqual([]);
      await hub.haReport(SHOP, "a", states(2, connectionId, [["switch.a", "on", NOON]]));
      expect(watched()).toEqual([connectionId]);
    } finally { quiet.mockRestore(); }
  });

  it("keeps the state flowing when one of two watchers leaves, and fills the slot from a spare", async () => {
    const { hub, watched, assigned, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    await hub.relayOnline(SHOP, "c", "chan-c");
    for (const [machine, term] of [["a", 1], ["b", 2]] as const)
      await hub.haReport(SHOP, machine, states(term, connectionId, [["switch.a", "on", NOON]]));
    expect(watched()).toEqual([connectionId]);
    await hub.relayOffline(SHOP, "a");
    // b still carries it, and c took a's place under a new term.
    expect(watched()).toEqual([connectionId]);
    expect(assigned().at(-1)).toEqual(["chan-c", 3]);
    await hub.relayOffline(SHOP, "b");
    // c has not delivered its state yet, so nothing is watched until it does.
    expect(watched()).toEqual([]);
    await hub.haReport(SHOP, "c", states(3, connectionId, [["switch.a", "on", NOON]]));
    expect(watched()).toEqual([connectionId]);
    await hub.relayOffline(SHOP, "c");
    expect(watched()).toEqual([]);
    expect(await hub.watching()).toEqual([]);
  });

  it("drops a watcher that went quiet past its lease and withdraws what only it carried", async () => {
    const { hub, state, reachable, watched, facts, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON]]));
    expect(watched()).toEqual([connectionId]);
    const watchers = state.get("watchers") as Record<string, { leaseUntil: number }>;
    watchers.a!.leaseUntil = Date.now() - 1;
    state.set("watchers", watchers);
    // Nobody else is online and the IO cannot be told: nothing watches any more.
    reachable.delete("chan-a");
    await hub.alarm();
    expect(watched()).toEqual([]);
    // The stored value stays but is no longer a fact.
    expect(await facts("m1")).toEqual({ watching: false, power: null, climate: null });
  });

  it("settles what is due before scheduling, so the next alarm is never set in the past", async () => {
    const { hub, state, alarmHistory, clearAlarm, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON]]));
    // An idle check that has come due. Scheduling while it is still pending would set an alarm in
    // the past, which fires again at once; on a runtime that drops an alarm set to the time of the
    // one running, nothing would then wake for the watcher's lease.
    state.set("touchAt", Date.now() - 1);
    clearAlarm();
    alarmHistory.length = 0;
    await hub.alarm();
    const now = Date.now();
    expect(alarmHistory.length).toBeGreaterThan(0);
    expect(alarmHistory.every((at) => at > now)).toBe(true);
    expect(state.get("touchAt")).toBeUndefined();
  });

  it("replaces a quiet watcher with one that can be told", async () => {
    const { hub, state, assigned } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    await hub.relayOnline(SHOP, "c", "chan-c");
    const watchers = state.get("watchers") as Record<string, { leaseUntil: number }>;
    watchers.a!.leaseUntil = Date.now() - 1;
    state.set("watchers", watchers);
    await hub.alarm();
    expect(assigned().at(-1)).toEqual(["chan-c", 3]);
    expect((await hub.watching()).map((entry) => entry.machineId).sort()).toEqual(["b", "c"]);
  });

  it("hands over when a watcher cannot reach Home Assistant and another IO can try", async () => {
    const { hub, assigned, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    await hub.relayOnline(SHOP, "c", "chan-c");
    await hub.haReport(SHOP, "a", status(1, connectionId, false));
    expect(assigned().at(-1)).toEqual(["chan-c", 3]);
    expect((await hub.watching()).map((entry) => entry.machineId).sort()).toEqual(["b", "c"]);
  });

  it("stops announcing a connection its only watcher cannot reach, without giving up the watch", async () => {
    const { hub, watched, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON]]));
    expect(watched()).toEqual([connectionId]);
    await hub.haReport(SHOP, "a", status(1, connectionId, false));
    expect(watched()).toEqual([]);
    expect((await hub.watching()).map((entry) => entry.machineId)).toEqual(["a"]);
    // Back again: subscribed, and the full state comes with it.
    await hub.haReport(SHOP, "a", status(1, connectionId, true));
    expect(watched()).toEqual([]);
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "off", NOON]]));
    expect(watched()).toEqual([connectionId]);
  });

  it("moves the watch off an IO the platform switched off, without waiting for its lease", async () => {
    const { hub, assigned, watched, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON]]));
    await hub.markDown(SHOP, "a");
    expect((await hub.watching()).map((entry) => entry.machineId)).toEqual(["b"]);
    // Only b is left and it has not delivered its state.
    expect(watched()).toEqual([]);
    // a is not handed the watch again while it is down, even with a free slot...
    await hub.relayOnline(SHOP, "c", "chan-c");
    expect(assigned().map(([channel]) => channel)).toEqual(["chan-a", "chan-b", "chan-c"]);
    // ...until it says hello again.
    await hub.relayOffline(SHOP, "c");
    await hub.relayOnline(SHOP, "a", "chan-a");
    expect((await hub.watching()).map((entry) => entry.machineId).sort()).toEqual(["a", "b"]);
  });

  it("skips an IO that could not be told and tries the next", async () => {
    const { hub, reachable, assigned } = await fixture();
    reachable.delete("chan-a");
    await hub.relayOnline(SHOP, "a", "chan-a");
    expect(await hub.watching()).toEqual([]);
    await hub.relayOnline(SHOP, "b", "chan-b");
    // The open second slot still retries a, which cannot be told, after b.
    expect(assigned().map(([channel]) => channel)).toContain("chan-b");
    expect((await hub.watching()).map((entry) => entry.machineId)).toEqual(["b"]);
  });

  it("stores an event the second watcher also saw once, and ignores one that arrives out of order", async () => {
    const { hub, power, changes, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    const on = ["switch.a", "on", "2026-10-21T09:00:00.000Z", "2026-10-21T09:00:00.000Z"] as Entry;
    const off = ["switch.a", "off", "2026-10-21T09:05:00.000Z", "2026-10-21T09:05:00.000Z"] as Entry;
    await hub.haReport(SHOP, "a", states(1, connectionId, [on]));
    await hub.haReport(SHOP, "b", states(2, connectionId, [on]));
    expect(changes("power")).toHaveLength(1);
    await hub.haReport(SHOP, "a", states(1, connectionId, [off], false));
    // b sees the same event, and also the older one late.
    await hub.haReport(SHOP, "b", states(2, connectionId, [off], false));
    await hub.haReport(SHOP, "b", states(2, connectionId, [on], false));
    expect(power()).toEqual([{ device_id: "m1", value_json: '"off"', changed_at: "2026-10-21T09:05:00.000Z" }]);
    expect(changes("power").map((row) => JSON.parse(row.payload_json).to)).toEqual(["on", "off"]);
  });

  it("stores an unavailable entity as unknown rather than leaving its last value", async () => {
    const { hub, facts, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON, NOON]]));
    expect((await facts("m1")).power).toBe("on");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "unavailable", "2026-10-21T09:10:00.000Z", "2026-10-21T09:10:00.000Z"]], false));
    expect(await facts("m1")).toEqual({ watching: true, power: null, climate: null });
  });

  it("keeps an air conditioner's full view up to date but logs only its setting", async () => {
    const { hub, facts, changes, connectionId } = await fixture({ climate: true });
    await hub.relayOnline(SHOP, "a", "chan-a");
    const attributes = (current: number, temperature = 24) => ({
      hvac_modes: ["off", "cool"], temperature, current_temperature: current, fan_mode: "low", fan_modes: ["auto", "low"],
      min_temp: 16, max_temp: 30, target_temp_step: 1,
    });
    await hub.haReport(SHOP, "a", states(1, connectionId, [["climate.c", "cool", NOON, NOON, attributes(27)]]));
    expect((await facts("m3")).climate).toMatchObject({ mode: "cool", temperature: 24, currentTemperature: 27 });
    // Room temperature drifts: the view follows, the log does not.
    await hub.haReport(SHOP, "a", states(1, connectionId, [["climate.c", "cool", NOON, "2026-10-21T09:01:00.000Z", attributes(28)]], false));
    expect((await facts("m3")).climate).toMatchObject({ currentTemperature: 28 });
    expect(changes("climate")).toHaveLength(1);
    await hub.haReport(SHOP, "a", states(1, connectionId, [["climate.c", "cool", NOON, "2026-10-21T09:02:00.000Z", attributes(28, 22)]], false));
    expect((await facts("m3")).climate).toMatchObject({ temperature: 22 });
    expect(changes("climate")).toHaveLength(2);
  });

  it("rewrites every fact after the devices an entity drives changed, without un-announcing the connection", async () => {
    const { hub, sqlite, watched, facts, assigned, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON, NOON]]));
    sqlite.run("DELETE FROM device_state");
    await hub.refresh(SHOP);
    expect(assigned().at(-1)).toEqual(["chan-a", 2]);
    expect(watched()).toEqual([connectionId]);
    // The same state again is rewritten, because what was known about it was dropped.
    await hub.haReport(SHOP, "a", states(2, connectionId, [["switch.a", "on", NOON, NOON]]));
    expect((await facts("m1")).power).toBe("on");
  });

  it("writes one row per heartbeat and wakes only when the lease could lapse", async () => {
    const { hub, puts, alarms, state, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON]]));
    const before = { puts: puts.length, alarms: alarms() };
    await hub.haReport(SHOP, "a", status(1, connectionId, true));
    expect(puts.slice(before.puts)).toEqual(["watchers"]);
    expect(alarms()).toBe(before.alarms);
    expect((state.get("watchers") as Record<string, { leaseUntil: number }>).a!.leaseUntil).toBeGreaterThan(Date.now() + LEASE_MS - 5_000);
  });
});

describe("ShopHub device pages", () => {
  class PageSocket {
    readonly sent: any[] = [];
    attachment: unknown = null;
    tags: string[] = [];
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() {}
    serializeAttachment(value: unknown) { this.attachment = value; }
    deserializeAttachment() { return this.attachment; }
  }
  const open = async (hub: ShopHub, deviceId: string, userId = "u1") => {
    (globalThis as any).WebSocketPair = class { 0 = new PageSocket(); 1 = new PageSocket(); };
    try {
      const response = await hub.fetch(new Request("https://prism.test/api/v1/devices/session/ws", {
        headers: { Upgrade: "websocket", "x-prism-hub-shop": SHOP, "x-prism-hub-device": deviceId, "x-prism-hub-user": userId },
      }));
      expect(response.status).toBe(101);
    } finally {
      delete (globalThis as any).WebSocketPair;
    }
  };

  it("tells a page nothing is watched, then pushes the device's state once it is", async () => {
    const { hub, sockets, connectionId } = await fixture();
    await open(hub, "m1");
    const page = sockets[0] as PageSocket;
    expect(page.sent).toEqual([{ type: "hello", watching: false }]);
    await hub.relayOnline(SHOP, "a", "chan-a");
    expect(page.sent).toHaveLength(1);
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON], ["switch.b", "off", NOON]]));
    // Only its own device, the state before the announcement that it is now pushed.
    expect(page.sent.slice(1)).toEqual([
      { type: "state", power: "on" },
      { type: "watching", watching: true, power: "on" },
    ]);
    await open(hub, "m1");
    expect((sockets[1] as PageSocket).sent).toEqual([{ type: "hello", watching: true, power: "on" }]);
    await hub.relayOffline(SHOP, "a");
    expect(page.sent.at(-1)).toEqual({ type: "watching", watching: false });
  });

  it("tells a page when its own device switches, and only that device", async () => {
    const { hub, sockets, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON, NOON], ["switch.b", "on", NOON, NOON]]));
    await open(hub, "m1");
    await open(hub, "m2");
    const [one, two] = sockets as PageSocket[];
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "off", "2026-10-21T09:30:00.000Z", "2026-10-21T09:30:00.000Z"]], false));
    expect(one!.sent.at(-1)).toEqual({ type: "state", power: "off" });
    expect(two!.sent).toEqual([{ type: "hello", watching: true, power: "on" }]);
  });

  it("reaches only the pages of the user it names", async () => {
    const { hub, sockets } = await fixture();
    await open(hub, "m1", "u1");
    await open(hub, "m1", "u2");
    await hub.notifyUser("u1", { type: "refresh", reason: "binding" });
    const [first, second] = sockets as PageSocket[];
    expect(first!.sent.at(-1)).toEqual({ type: "refresh", reason: "binding" });
    expect(second!.sent).toEqual([{ type: "hello", watching: false }]);
  });

  const openBoard = async (hub: ShopHub) => {
    (globalThis as any).WebSocketPair = class { 0 = new PageSocket(); 1 = new PageSocket(); };
    try {
      const response = await hub.fetch(new Request("https://prism.test/api/v1/merchant/machines/ws", {
        headers: { Upgrade: "websocket", "x-prism-hub-shop": SHOP, "x-prism-hub-board": "1" },
      }));
      expect(response.status).toBe(101);
    } finally {
      delete (globalThis as any).WebSocketPair;
    }
  };
  const idle = { watching: false, power: null, climate: null };

  it("gives a board the whole shop when it connects, whether or not anything is watched", async () => {
    const { hub, sockets, connectionId } = await fixture({ climate: true });
    await openBoard(hub);
    expect((sockets[0] as PageSocket).sent).toEqual([{ type: "states", states: { m1: idle, m2: idle, m3: idle } }]);
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON, NOON], ["switch.b", "off", NOON, NOON]]));
    await openBoard(hub);
    // The climate device is on the same connection but has no stored view yet.
    expect((sockets[1] as PageSocket).sent).toEqual([{
      type: "states",
      states: {
        m1: { watching: true, power: "on", climate: null },
        m2: { watching: true, power: "off", climate: null },
        m3: { watching: true, power: null, climate: null },
      },
    }]);
  });

  it("gives a board the whole shop once a connection is live, then each change of a live device, and the whole shop again when it stops", async () => {
    const { hub, sockets, connectionId } = await fixture();
    await openBoard(hub);
    const board = sockets[0] as PageSocket;
    await hub.relayOnline(SHOP, "a", "chan-a");
    expect(board.sent).toHaveLength(1);
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON, NOON], ["switch.b", "off", NOON, NOON]]));
    // Nothing is live until the connection is announced, so the first snapshot is not a change per
    // device: the board gets the whole shop, with the values, once.
    expect(board.sent.slice(1)).toEqual([
      { type: "states", states: { m1: { watching: true, power: "on", climate: null }, m2: { watching: true, power: "off", climate: null } } },
    ]);
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "off", "2026-10-21T09:30:00.000Z", "2026-10-21T09:30:00.000Z"]], false));
    expect(board.sent.at(-1)).toEqual({ type: "state", power: "off", deviceId: "m1" });
    expect(board.sent).toHaveLength(3);
    // The connection stops being watched: the board is told which devices are no longer live.
    await hub.relayOffline(SHOP, "a");
    expect(board.sent.at(-1)).toEqual({ type: "states", states: { m1: idle, m2: idle } });
  });

  it("pushes and records a change once when two watchers report it at the same moment", async () => {
    const { hub, sockets, connectionId, changes } = await fixture();
    await openBoard(hub);
    const board = sockets[0] as PageSocket;
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    const snapshot: Entry[] = [["switch.a", "on", NOON, NOON], ["switch.b", "off", NOON, NOON]];
    await hub.haReport(SHOP, "a", states(1, connectionId, snapshot));
    await hub.haReport(SHOP, "b", states(2, connectionId, snapshot));
    const sent = board.sent.length;
    const recorded = changes("power").length;
    const change: Entry[] = [["switch.a", "off", "2026-10-21T09:30:00.000Z", "2026-10-21T09:30:00.000Z"]];
    // Both are in flight together: the second must not decide before the first has been applied.
    await Promise.all([
      hub.haReport(SHOP, "a", states(1, connectionId, change, false)),
      hub.haReport(SHOP, "b", states(2, connectionId, change, false)),
    ]);
    expect(board.sent.slice(sent)).toEqual([{ type: "state", power: "off", deviceId: "m1" }]);
    expect(changes("power")).toHaveLength(recorded + 1);
  });

  it("pushes an air conditioner's full view, room temperature included, to a board once it is live", async () => {
    const { hub, sockets, connectionId } = await fixture({ climate: true });
    await openBoard(hub);
    const board = sockets[0] as PageSocket;
    await hub.relayOnline(SHOP, "a", "chan-a");
    const attributes = (current: number) => ({
      hvac_modes: ["off", "cool"], temperature: 24, current_temperature: current, fan_mode: "low", fan_modes: ["auto", "low"],
      min_temp: 16, max_temp: 30, target_temp_step: 1,
    });
    await hub.haReport(SHOP, "a", states(1, connectionId, [["climate.c", "cool", NOON, NOON, attributes(27)]]));
    expect(board.sent.filter((frame) => frame.type === "state")).toEqual([]);
    expect(board.sent.at(-1)).toMatchObject({ type: "states", states: { m3: { watching: true, climate: { mode: "cool", currentTemperature: 27 } } } });
    await hub.haReport(SHOP, "a", states(1, connectionId, [["climate.c", "cool", NOON, "2026-10-21T09:01:00.000Z", attributes(28)]], false));
    expect(board.sent.at(-1)).toMatchObject({ type: "state", deviceId: "m3", climate: { mode: "cool", temperature: 24, currentTemperature: 28 } });
  });

  it("never tells a board about a device that is not live", async () => {
    const { hub, sockets, sqlite, connectionId } = await fixture();
    // m2's switch is on a second Home Assistant that nothing watches; both are reported by the same IO.
    sqlite.run("UPDATE device_capabilities SET config_json=? WHERE device_id='m2'", [JSON.stringify({ connectionId: "ha_other", entityId: "switch.b" })]);
    await openBoard(hub);
    const board = sockets[0] as PageSocket;
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON, NOON]]));
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "off", "2026-10-21T09:30:00.000Z", "2026-10-21T09:30:00.000Z"]], false));
    expect(board.sent.filter((frame) => frame.type === "state")).toEqual([{ type: "state", power: "off", deviceId: "m1" }]);
  });

  it("keeps boards, device pages and bots apart", async () => {
    const { hub, sockets, connectionId } = await fixture();
    await openBoard(hub);
    await open(hub, "m1");
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON, NOON]]));
    const [board, pageSocket] = sockets as PageSocket[];
    // A page never gets the board's frames, and a board never gets a page's greeting or watching frame.
    expect(pageSocket!.sent.every((frame) => frame.type !== "states" && frame.deviceId === undefined)).toBe(true);
    expect(board!.sent.every((frame) => frame.type === "states" || frame.type === "state")).toBe(true);
    // A board only listens: whatever it sends is not a bot request.
    await hub.webSocketMessage(board as any, JSON.stringify({ type: "request", id: "1", method: "GET", path: "integration/sessions/active" }));
    expect(board!.sent.at(-1)?.type).not.toBe("response");
  });

  it("needs the shop that the route names", async () => {
    const { hub } = await fixture();
    (globalThis as any).WebSocketPair = class { 0 = new PageSocket(); 1 = new PageSocket(); };
    try {
      const response = await hub.fetch(new Request("https://prism.test/x", { headers: { Upgrade: "websocket", "x-prism-hub-board": "1" } }));
      expect(response.status).toBe(400);
    } finally {
      delete (globalThis as any).WebSocketPair;
    }
  });
});
