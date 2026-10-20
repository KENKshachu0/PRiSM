import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { deviceEventSchema } from "@prism/storage-sql";
import { encryptSecret } from "../src/crypto.js";
import { newHaConnection, writeHaConnection } from "../src/devices/ha-connections.js";
import { ShopHub } from "../src/durable-objects/shop-hub.js";
import type { HaWatch } from "../src/durable-objects/machine-relay.js";

const KEY = "hub-test-key";
const SHOP = "shop-1";

async function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.run(`CREATE TABLE players(shop_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(shop_id, id))`);
  sqlite.run(`CREATE TABLE machines(shop_id TEXT NOT NULL, id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(shop_id, id))`);
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
  for (const [device, entity] of [["m1", "switch.a"], ["m2", "switch.b"]]) {
    sqlite.run("INSERT INTO machines(shop_id,id) VALUES (?,?)", [SHOP, device]);
    sqlite.run(
      `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
       VALUES (?,?,'power',?,'{}','2026-01-01','2026-01-01')`,
      [SHOP, device, JSON.stringify({ connectionId: connection.id, entityId: entity })],
    );
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
  let alarm: number | null = null;
  const ctx = {
    storage: {
      async get<T>(key: string) { return structuredClone(state.get(key)) as T | undefined; },
      async put(key: string, value: unknown) { state.set(key, structuredClone(value)); },
      async delete(key: string) { return state.delete(key); },
      async setAlarm(at: number) { alarm = at; },
      async deleteAlarm() { alarm = null; },
    },
    getWebSockets() { return []; },
  };
  const hub = new ShopHub(ctx as any, env as any);
  const power = () =>
    sqlite.query<{ device_id: string; value_json: string; changed_at: string }, []>(
      "SELECT device_id, value_json, changed_at FROM device_state WHERE key='power' ORDER BY device_id",
    ).all();
  return { hub, watches, reachable, state, power, connectionId: connection.id, alarm: () => alarm };
}

const states = (term: number, connection: string, list: Array<[string, string, string]>) => ({
  method: "ha.states" as const,
  params: {
    term,
    connection,
    full: true,
    states: list.map(([entity_id, state, last_changed]) => ({ entity_id, state, last_changed, attributes: {} })),
  },
});

describe("ShopHub watcher", () => {
  it("gives the watch to the IO online longest, with the shop-local address first", async () => {
    const { hub, watches, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    expect(watches).toHaveLength(1);
    expect(watches[0]).toEqual({
      channel: "chan-a",
      watch: {
        term: 1,
        connections: [{ id: connectionId, urls: ["http://ha.local:8123", "https://ha.example"], token: "reader", entities: ["switch.a", "switch.b"] }],
      },
    });
  });

  it("records only reports from the current watcher and term, at the time Home Assistant gives", async () => {
    const { hub, power, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    await hub.haReport(SHOP, "b", states(1, connectionId, [["switch.a", "on", "2026-10-21T09:00:00.000Z"]]));
    await hub.haReport(SHOP, "a", states(0, connectionId, [["switch.a", "on", "2026-10-21T09:00:00.000Z"]]));
    expect(power()).toEqual([]);
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", "2026-10-21T09:00:00.000Z"], ["switch.b", "off", "2026-10-21T08:00:00.000Z"]]));
    expect(power()).toEqual([
      { device_id: "m1", value_json: '"on"', changed_at: "2026-10-21T09:00:00.000Z" },
      { device_id: "m2", value_json: '"off"', changed_at: "2026-10-21T08:00:00.000Z" },
    ]);
    expect(await hub.readState(connectionId, "switch.a")).toMatchObject({ state: "on" });
  });

  it("moves the watch when its IO leaves, and tells nobody when nobody is left", async () => {
    const { hub, watches } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    await hub.relayOffline(SHOP, "a");
    const assigned = watches.filter((entry) => entry.watch);
    expect(assigned.map((entry) => [entry.channel, entry.watch!.term])).toEqual([["chan-a", 1], ["chan-b", 2]]);
    await hub.relayOffline(SHOP, "b");
    expect(await hub.watcher()).toBeNull();
  });

  it("replaces a watcher that went quiet past its lease", async () => {
    const { hub, watches, state, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    const leader = state.get("leader") as { leaseUntil: number };
    state.set("leader", { ...leader, leaseUntil: Date.now() - 1 });
    expect(await hub.readState(connectionId, "switch.a")).toBeNull();
    await hub.alarm();
    expect(watches.filter((entry) => entry.watch).at(-1)?.channel).toBe("chan-b");
  });

  it("hands over when the watcher cannot reach Home Assistant and another IO can try", async () => {
    const { hub, watches, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    await hub.haReport(SHOP, "a", { method: "ha.status", params: { term: 1, connection: connectionId, connected: false, error: "refused" } });
    expect(watches.filter((entry) => entry.watch).map((entry) => entry.channel)).toEqual(["chan-a", "chan-b"]);
  });

  it("skips an IO that could not be told and tries the next", async () => {
    const { hub, watches, reachable } = await fixture();
    reachable.delete("chan-a");
    await hub.relayOnline(SHOP, "a", "chan-a");
    expect(await hub.watcher()).toBeNull();
    await hub.relayOnline(SHOP, "b", "chan-b");
    expect(watches.filter((entry) => entry.watch).map((entry) => entry.channel)).toEqual(["chan-a", "chan-b"]);
    expect((await hub.watcher())?.machineId).toBe("b");
  });
});
