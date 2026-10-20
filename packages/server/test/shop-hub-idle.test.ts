import { describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { newHaConnection, writeHaConnection } from "../src/devices/ha-connections.js";
import { IDLE_SETTINGS_KEY } from "../src/devices/idle-power.js";
import { ShopHub } from "../src/durable-objects/shop-hub.js";

const migrations = resolve(import.meta.dir, "../../../migrations");
const KEY = "idle-test-key";
const MIN = 60_000;

async function fixture(settings: unknown) {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=OFF");
  for (const name of readdirSync(migrations).filter((s) => s.endsWith(".sql")).sort())
    for (const sql of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) sqlite.run(sql);
  // Players and users are beside the point here.
  sqlite.run("PRAGMA foreign_keys=OFF");
  const db = createD1DatabaseFromSqlite(sqlite);
  sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('shop','shop-code','A',0,0,80,'u')");
  const connection = await newHaConnection("https://ha.example", "control", KEY);
  await writeHaConnection(db, "shop", connection).run();
  sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted) VALUES ('m1','p1','shop','舞萌','')");
  sqlite.run(
    `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
     VALUES ('shop','m1','power',?,'{}','2026-01-01','2026-01-01')`,
    [JSON.stringify({ connectionId: connection.id, entityId: "switch.m1" })],
  );
  const onSince = new Date(Date.now() - 40 * MIN).toISOString();
  sqlite.run(
    `INSERT INTO device_state(shop_id,device_id,capability,key,value_json,authority,changed_at)
     VALUES ('shop','m1','power','power','"on"','observed',?)`,
    [onSince],
  );
  sqlite.run("INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES ('shop',?,?,?)", [IDLE_SETTINGS_KEY, JSON.stringify(settings), onSince]);
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
  };
  const hub = new ShopHub(ctx as any, { DB: db, URL_ENCRYPTION_KEY: KEY } as any);
  const run = async () => {
    await hub.touch("shop");
    state.set("touchAt", Date.now() - 1);
    await hub.alarm();
  };
  const offs = () =>
    sqlite.query<{ action: string; player_id: string | null; staff_id: string | null }, []>(
      "SELECT action, player_id, staff_id FROM device_operations WHERE action='power.off'",
    ).all();
  const idle = () =>
    (sqlite.query("SELECT value_json FROM device_state WHERE key='idle'").get() as { value_json: string } | null)?.value_json ?? null;
  return { sqlite, run, offs, idle, state, alarm: () => alarm };
}

const haCalls = () => spyOn(globalThis, "fetch").mockImplementation((async (url: string | URL | Request) => {
  const path = new URL(String(url)).pathname;
  if (path === "/api/services/switch/turn_off") return new Response("[]", { status: 200 });
  if (path === "/api/states/switch.m1") return Response.json({ state: "off" });
  return new Response("", { status: 404 });
}) as typeof fetch);

describe("idle check in the shop hub", () => {
  it("switches an empty shop's machines off as the system once its time is up", async () => {
    const { run, offs, sqlite } = await fixture({ shopEmpty: { enabled: true, minutes: 15 } });
    sqlite.run(
      "INSERT INTO sessions(shop_id,id,player_id,started_at,ended_at,status) VALUES ('shop','s1','p','2026-01-01T00:00:00Z',?,'closed')",
      [new Date(Date.now() - 20 * MIN).toISOString()],
    );
    const spy = haCalls();
    try {
      await run();
      expect(offs()).toEqual([{ action: "power.off", player_id: null, staff_id: null }]);
      expect(spy.mock.calls.map(([url]) => new URL(String(url)).pathname)).toContain("/api/services/switch/turn_off");
      // The same empty period does not switch it off twice.
      await run();
      expect(offs()).toHaveLength(1);
    } finally { spy.mockRestore(); sqlite.close(); }
  });

  it("waits while the shop has players, and marks an idle machine when the owner chose only that", async () => {
    const { run, offs, idle, sqlite, state } = await fixture({ shopEmpty: { enabled: true, minutes: 15 }, device: { defaultMinutes: 30, whileOccupied: "mark" } });
    sqlite.run("INSERT INTO sessions(shop_id,id,player_id,started_at,status) VALUES ('shop','s1','p','2026-01-01T00:00:00Z','active')");
    const spy = haCalls();
    try {
      await run();
      expect(offs()).toEqual([]);
      expect(idle()).toBe("true");
      // A card at the machine is activity: the mark goes away.
      sqlite.run(
        `INSERT INTO device_events(shop_id,id,device_id,capability,kind,name,origin,payload_json,occurred_at)
         VALUES ('shop','e1','m1','hinata_io','signal','card.consumed','device','{}',?)`,
        [new Date().toISOString()],
      );
      await run();
      expect(idle()).toBe("false");
      expect((state.get("idle") as { wakeAt: number }).wakeAt).toBeGreaterThan(Date.now() + 29 * MIN);
    } finally { spy.mockRestore(); sqlite.close(); }
  });

  it("does not count its own power-off as activity", async () => {
    const { run, sqlite } = await fixture({ device: { defaultMinutes: 30, whileOccupied: "off" } });
    sqlite.run("INSERT INTO sessions(shop_id,id,player_id,started_at,status) VALUES ('shop','s1','p','2026-01-01T00:00:00Z','active')");
    const spy = haCalls();
    try {
      await run();
      const events = sqlite.query("SELECT kind, name FROM device_events WHERE device_id='m1' AND kind='request'").all();
      expect(events).toEqual([{ kind: "request", name: "power.off" }]);
    } finally { spy.mockRestore(); sqlite.close(); }
  });
});
