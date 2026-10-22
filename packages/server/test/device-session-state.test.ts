import { describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createApp } from "../src/app.js";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { sha256 } from "../src/crypto.js";
import { loadDevice } from "../src/devices/device.js";
import { newHaConnection, writeHaConnection } from "../src/devices/ha-connections.js";
import { createRuntimeBus } from "../src/devices/runtime.js";
import { mintMachineTicket } from "../src/routes/platform/machine-session.js";
import type { Env } from "../src/bindings.js";

const migrations = resolve(import.meta.dir, "../../../migrations");
const KEY = "state-test-key";
const PLAYER = "player-token";
const ADMIN = "admin-token";

const view = {
  mode: "cool", modes: ["off", "cool"], temperature: 24, currentTemperature: 27, minTemperature: 16,
  maxTemperature: 30, temperatureStep: 1, fanMode: "low", fanModes: ["auto", "low"],
};

async function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=OFF");
  for (const name of readdirSync(migrations).filter((s) => s.endsWith(".sql")).sort())
    for (const sql of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) sqlite.run(sql);
  const now = new Date().toISOString();
  for (const [id, role, token] of [["player-one", "user", PLAYER], ["boss", "admin", ADMIN]] as const) {
    sqlite.run("INSERT INTO users(id,role,created_at,updated_at) VALUES (?,?,?,?)", [id, role, now, now]);
    sqlite.run("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,?)", [
      `s-${id}`, id, await sha256(token), new Date(Date.now() + 86_400_000).toISOString(),
    ]);
  }
  sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('shop-id','shop-code','Arcade',0,0,80,'boss')");
  sqlite.run("INSERT INTO shop_billing_settings(shop_id,billing_enabled,auto_register,identity_binding_required) VALUES ('shop-id',0,1,0)");
  const db = createD1DatabaseFromSqlite(sqlite);
  const connection = await newHaConnection("https://ha.test", "control", KEY);
  await writeHaConnection(db, "shop-id", connection).run();
  const bind = (device: string, capability: string, config: Record<string, unknown>) =>
    sqlite.run(
      `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
       VALUES ('shop-id',?,?,?,'{}',?,?)`,
      [device, capability, JSON.stringify(config), now, now],
    );
  // A cabinet with its power and an air conditioner, and an IO-driven machine with power.
  sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted) VALUES ('cab','cab','shop-id','Cabinet','')");
  bind("cab", "power", { connectionId: connection.id, entityId: "switch.cab" });
  bind("cab", "climate", { connectionId: connection.id, entityId: "climate.room" });
  sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted) VALUES ('io','io','shop-id','Mai','')");
  bind("io", "power", { connectionId: connection.id, entityId: "switch.io" });
  bind("io", "hinata_io", { transport: "embedded", channel: "m_io", coinKey: 32 });

  const hub = {
    markDown: [] as Array<[string, string]>,
    /** What the route handed the hub when a board connected. */
    boards: [] as Array<{ name: string; headers: Record<string, string | null> }>,
  };
  const env = {
    DB: db,
    URL_ENCRYPTION_KEY: KEY,
    SESSION_SECRET: "session-test-secret",
    RATE_LIMIT_10: { limit: async () => ({ success: true }) },
    SHOP_HUB: {
      getByName: (name: string) => ({
        async markDown(shop: string, machine: string) { hub.markDown.push([shop, machine]); },
        async fetch(request: Request) {
          const read = (header: string) => request.headers.get(header);
          hub.boards.push({ name, headers: { shop: read("x-prism-hub-shop"), board: read("x-prism-hub-board"), device: read("x-prism-hub-device"), authorization: read("authorization") } });
          return new Response("hub");
        },
      }),
    },
  } as unknown as Env;
  const ticket = async (publicId: string) => (await mintMachineTicket(env.SESSION_SECRET, "shop-code", publicId)).ticket;
  const app = createApp();
  const call = (path: string, token: string | null = PLAYER, init: RequestInit = {}) =>
    app.fetch(new Request(`https://prism.test${path}`, {
      ...init,
      headers: {
        ...((init.headers as Record<string, string> | undefined) ?? {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    }), env);
  const json = async (response: Response): Promise<any> => ((await response.json()) as { data: unknown }).data;
  const jsonAs = async <T>(response: Response): Promise<T> => ((await response.json()) as { data: T }).data;
  const watch = () => {
    sqlite.run("INSERT INTO ha_event_connections(shop_id,connection_id,since) VALUES ('shop-id',?,?)", [connection.id, now]);
    const state = (device: string, capability: string, key: string, value: unknown) =>
      sqlite.run(
        `INSERT INTO device_state(shop_id,device_id,capability,key,value_json,authority,changed_at)
         VALUES ('shop-id',?,?,?,?,'observed',?)`,
        [device, capability, key, JSON.stringify(value), now],
      );
    state("cab", "power", "power", "off");
    state("cab", "climate", "view", view);
  };
  const recorded = () => (sqlite.query("SELECT (SELECT COUNT(*) FROM device_events WHERE kind='change') + (SELECT COUNT(*) FROM device_state) AS n").get() as { n: number }).n;
  return { sqlite, db, env, call, json, jsonAs, ticket, watch, recorded, hub, connection };
}

/** Home Assistant as the unwatched path sees it: asked on demand. */
const homeAssistant = () => {
  const calls: Array<{ method: string; path: string }> = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? "GET", path: url.pathname });
    if (url.pathname.startsWith("/api/services/")) return Response.json([]);
    if (url.pathname === "/api/states/climate.room")
      return Response.json({
        state: "cool",
        attributes: {
          hvac_modes: ["off", "cool"], min_temp: 16, max_temp: 30, target_temp_step: 1,
          temperature: 24, current_temperature: 27, fan_mode: "low", fan_modes: ["auto", "low"],
        },
      });
    if (url.pathname.startsWith("/api/states/")) return Response.json({ state: "on" });
    return new Response("", { status: 404 });
  }) as typeof fetch);
  return { calls, spy };
};

describe("device page state", () => {
  it("answers a signed-out scan with the machine and no state", async () => {
    const { call, jsonAs, ticket, sqlite } = await fixture();
    const ha = homeAssistant();
    try {
      const res = await call(`/api/v1/devices/session/bootstrap?ticket=${await ticket("cab")}`, null);
      expect(res.status).toBe(200);
      const data = await jsonAs<{ machine: { publicId: string; capabilities: { power: boolean; climate: boolean } }; state: unknown }>(res);
      expect(data.machine).toMatchObject({ publicId: "cab", capabilities: { power: true, climate: true } });
      expect(data.state).toBeNull();
      expect(ha.calls).toEqual([]);
    } finally { ha.spy.mockRestore(); sqlite.close(); }
  });

  it("carries a watched device's stored facts in the first read and never asks Home Assistant", async () => {
    const { call, jsonAs, ticket, watch, sqlite } = await fixture();
    watch();
    const ha = homeAssistant();
    try {
      const res = await call(`/api/v1/devices/session/bootstrap?ticket=${await ticket("cab")}`);
      const { state } = await jsonAs<{ state: { gate: string; power: string; climate: unknown; device: unknown } }>(res);
      expect(state.gate).toBe("ready");
      expect(state.device).toEqual({ watching: true, power: "off", climate: view });
      // The older fields only exist for clients that have not moved to `device`.
      expect(state.power).toBe("unmanaged");
      expect(state.climate).toBeNull();
      expect(ha.calls).toEqual([]);
    } finally { ha.spy.mockRestore(); sqlite.close(); }
  });

  it("says an unwatched device has no state, without asking Home Assistant", async () => {
    const { call, jsonAs, ticket, sqlite } = await fixture();
    const ha = homeAssistant();
    try {
      const res = await call(`/api/v1/devices/session/bootstrap?ticket=${await ticket("cab")}`);
      const { state } = await jsonAs<{ state: { device: unknown } }>(res);
      expect(state.device).toEqual({ watching: false, power: null, climate: null });
      expect(ha.calls).toEqual([]);
    } finally { ha.spy.mockRestore(); sqlite.close(); }
  });

  it("asks Home Assistant for both power and climate at once when unwatched, and records nothing", async () => {
    const { call, json, ticket, recorded, sqlite } = await fixture();
    const ha = homeAssistant();
    try {
      const res = await call(`/api/v1/devices/session/device?ticket=${await ticket("cab")}`);
      expect(await json(res)).toEqual({ watching: false, power: "on", climate: view });
      expect(ha.calls.map((call) => call.path).sort()).toEqual(["/api/states/climate.room", "/api/states/switch.cab"]);
      expect(recorded()).toBe(0);
    } finally { ha.spy.mockRestore(); sqlite.close(); }
  });

  it("answers from the stored facts while watched", async () => {
    const { call, json, ticket, watch, sqlite } = await fixture();
    watch();
    const ha = homeAssistant();
    try {
      const res = await call(`/api/v1/devices/session/device?ticket=${await ticket("cab")}`);
      expect(await json(res)).toEqual({ watching: true, power: "off", climate: view });
      const power = await call(`/api/v1/devices/session/power?ticket=${await ticket("cab")}`);
      expect(await json(power)).toEqual({ power: "off" });
      expect(ha.calls).toEqual([]);
    } finally { ha.spy.mockRestore(); sqlite.close(); }
  });

  it("keeps the older state read asking Home Assistant for clients that still rely on it", async () => {
    const { call, jsonAs, ticket, sqlite } = await fixture();
    const ha = homeAssistant();
    try {
      const old = await jsonAs<{ power: string; climate: { mode: string } }>(await call(`/api/v1/devices/session/state?ticket=${await ticket("cab")}`));
      expect(old).toMatchObject({ power: "on", climate: { mode: "cool" } });
      expect(ha.calls.length).toBe(2);
      ha.calls.length = 0;
      const lean = await jsonAs<{ power: string; climate: unknown }>(
        await call(`/api/v1/devices/session/state?ticket=${await ticket("cab")}&includePower=0&includeClimate=0`));
      expect(lean).toMatchObject({ power: "unmanaged", climate: null });
      expect(ha.calls).toEqual([]);
    } finally { ha.spy.mockRestore(); sqlite.close(); }
  });

  it("treats a power action as done when Home Assistant accepts it, without reading the state back", async () => {
    const { call, json, ticket, recorded, sqlite } = await fixture();
    const ha = homeAssistant();
    try {
      const res = await call("/api/v1/devices/session/actions", PLAYER, {
        method: "POST",
        body: JSON.stringify({ ticket: await ticket("cab"), operationId: crypto.randomUUID(), action: "power.on" }),
      });
      expect(res.status).toBe(200);
      expect(await json(res)).not.toHaveProperty("power");
      expect(ha.calls).toEqual([{ method: "POST", path: "/api/services/switch/turn_on" }]);
      // Only the request and its result are logged; no state change was observed or invented.
      expect((sqlite.query("SELECT COUNT(*) AS n FROM device_events WHERE kind='change'").get() as { n: number }).n).toBe(0);
      expect(recorded()).toBe(0);
    } finally { ha.spy.mockRestore(); sqlite.close(); }
  });

  it("does the same for an air conditioner setting", async () => {
    const { call, json, ticket, sqlite } = await fixture();
    const ha = homeAssistant();
    try {
      const res = await call("/api/v1/devices/session/actions", PLAYER, {
        method: "POST",
        body: JSON.stringify({ ticket: await ticket("cab"), operationId: crypto.randomUUID(), action: "climate.set_temperature", temperature: 23 }),
      });
      expect(res.status).toBe(200);
      expect(await json(res)).not.toHaveProperty("climate");
      expect(ha.calls).toEqual([{ method: "POST", path: "/api/services/climate/set_temperature" }]);
    } finally { ha.spy.mockRestore(); sqlite.close(); }
  });
});

describe("one device's state for the board", () => {
  it("asks Home Assistant for a device with no state of its own, and records nothing", async () => {
    const { call, json, recorded, sqlite } = await fixture();
    const ha = homeAssistant();
    try {
      const state = await json(await call("/api/v1/merchant/machines/cab/state", ADMIN));
      expect(state).toEqual({ watching: false, power: "on", climate: view });
      expect(ha.calls.length).toBe(2);
      expect(recorded()).toBe(0);
    } finally { ha.spy.mockRestore(); sqlite.close(); }
  });

  it("answers a watched device from its stored facts without asking Home Assistant", async () => {
    const { call, json, watch, sqlite } = await fixture();
    watch();
    const ha = homeAssistant();
    try {
      expect(await json(await call("/api/v1/merchant/machines/cab/state", ADMIN))).toEqual({ watching: true, power: "off", climate: view });
      expect(ha.calls).toEqual([]);
    } finally { ha.spy.mockRestore(); sqlite.close(); }
  });

  it("keeps the mahjong seats apart: they are not Home Assistant state and reading them asks it nothing", async () => {
    const { call, json, sqlite } = await fixture();
    const ha = homeAssistant();
    try {
      const table = await json(await call("/api/v1/merchant/machines/cab/mahjong", ADMIN));
      expect(table).toEqual({ mahjong: null });
      expect(ha.calls).toEqual([]);
      expect((await call("/api/v1/merchant/machines/cab/mahjong", PLAYER)).status).toBe(403);
    } finally { ha.spy.mockRestore(); sqlite.close(); }
  });
});

describe("shop-wide board state", () => {
  const BOARD = "/api/v1/merchant/machines/states?shopId=shop-id";
  const idle = { watching: false, power: null, climate: null };

  it("asks Home Assistant for every device with no state of its own, in one read, and records nothing", async () => {
    const { call, json, sqlite, recorded } = await fixture();
    sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted) VALUES ('door','door','shop-id','Door','')");
    sqlite.run(
      `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
       VALUES ('shop-id','door','door','{"lockId":7}','{}','2026-01-01','2026-01-01')`,
    );
    const ha = homeAssistant();
    try {
      const board = await json(await call(BOARD, ADMIN));
      // The door has nothing to show, so it is not part of the board's state.
      expect(board.states).toEqual({
        cab: { watching: false, power: "on", climate: view },
        io: { watching: false, power: "on", climate: null },
      });
      expect(ha.calls.map((entry) => entry.path).sort())
        .toEqual(["/api/states/climate.room", "/api/states/switch.cab", "/api/states/switch.io"]);
      expect(recorded()).toBe(0);
    } finally { ha.spy.mockRestore(); sqlite.close(); }
  });

  it("answers a watched device from its stored facts and asks Home Assistant only for the others", async () => {
    const { call, json, watch, sqlite, db } = await fixture();
    // The IO's switch lives on a second Home Assistant that nothing watches.
    const other = await newHaConnection("https://ha2.test", "control-2", KEY);
    await writeHaConnection(db, "shop-id", other).run();
    sqlite.run(
      "UPDATE device_capabilities SET config_json=? WHERE device_id='io' AND capability='power'",
      [JSON.stringify({ connectionId: other.id, entityId: "switch.io" })],
    );
    watch();
    const ha = homeAssistant();
    try {
      const board = await json(await call(BOARD, ADMIN));
      expect(board.states).toEqual({
        cab: { watching: true, power: "off", climate: view },
        io: { watching: false, power: "on", climate: null },
      });
      expect(ha.calls).toEqual([{ method: "GET", path: "/api/states/switch.io" }]);
    } finally { ha.spy.mockRestore(); sqlite.close(); }
  });

  it("asks Home Assistant nothing when every device is watched", async () => {
    const { call, json, watch, sqlite } = await fixture();
    watch();
    const ha = homeAssistant();
    try {
      const board = await json(await call(BOARD, ADMIN));
      expect(board.states.cab).toEqual({ watching: true, power: "off", climate: view });
      expect(ha.calls.map((entry) => entry.path)).not.toContain("/api/states/switch.cab");
    } finally { ha.spy.mockRestore(); sqlite.close(); }
  });

  it("treats a device whose Home Assistant cannot be reached as unknown, not as failed", async () => {
    const { call, json, sqlite } = await fixture();
    const spy = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new TypeError("offline"); }) as unknown as typeof fetch);
    try {
      const res = await call(BOARD, ADMIN);
      expect(res.status).toBe(200);
      expect((await json(res)).states).toEqual({ cab: idle, io: idle });
    } finally { spy.mockRestore(); sqlite.close(); }
  });

  it("needs a shop, and only shows it to that shop's members", async () => {
    const { call, sqlite } = await fixture();
    try {
      expect((await call("/api/v1/merchant/machines/states", ADMIN)).status).toBe(400);
      // A signed-in player who is not a member of the shop.
      expect((await call(BOARD, PLAYER)).status).toBe(403);
      expect((await call(BOARD, null)).status).toBe(401);
    } finally { sqlite.close(); }
  });
});

describe("board live channel", () => {
  const WS = "/api/v1/merchant/machines/ws?shopId=shop-id";
  const upgrade = { upgrade: "websocket" };

  it("hands a member's connection to the shop's hub as a board, without the caller's credentials", async () => {
    const { call, hub, sqlite } = await fixture();
    try {
      const res = await call(WS, ADMIN, { headers: upgrade });
      expect(res.status).toBe(200);
      expect(hub.boards).toEqual([{ name: "shop-id", headers: { shop: "shop-id", board: "1", device: null, authorization: null } }]);
    } finally { sqlite.close(); }
  });

  it("is only for a WebSocket upgrade from a member of the shop", async () => {
    const { call, hub, sqlite } = await fixture();
    try {
      expect((await call(WS, ADMIN)).status).toBe(426);
      expect((await call("/api/v1/merchant/machines/ws", ADMIN, { headers: upgrade })).status).toBe(400);
      expect((await call(WS, PLAYER, { headers: upgrade })).status).toBe(403);
      expect((await call(WS, null, { headers: upgrade })).status).toBe(401);
      expect(hub.boards).toEqual([]);
    } finally { sqlite.close(); }
  });

  it("refuses a browser page from another origin, because the session is a cookie", async () => {
    const { call, hub, env, sqlite } = await fixture();
    (env as unknown as { APP_ORIGIN: string }).APP_ORIGIN = "https://prism.test";
    try {
      expect((await call(WS, ADMIN, { headers: { ...upgrade, origin: "https://evil.example" } })).status).toBe(403);
      expect(hub.boards).toEqual([]);
      expect((await call(WS, ADMIN, { headers: { ...upgrade, origin: "https://prism.test" } })).status).toBe(200);
      expect(hub.boards).toHaveLength(1);
    } finally { sqlite.close(); }
  });
});

describe("switching a HINATA IO off", () => {
  const off = async (machine: string, runtime: { notifyHub?: boolean } = {}) => {
    const { db, env, hub, sqlite } = await fixture();
    const ha = homeAssistant();
    try {
      const device = (await loadDevice(db, "shop-id", machine))!;
      const bus = createRuntimeBus({ db, env, shopId: "shop-id", ...runtime });
      const done = await bus.perform({ device, action: "power.off", actor: { type: "system" } });
      return { status: done.operation.status, markDown: hub.markDown };
    } finally { ha.spy.mockRestore(); sqlite.close(); }
  };

  it("tells the shop hub, so the watch moves without waiting out the lease", async () => {
    expect(await off("io")).toEqual({ status: "succeeded", markDown: [["shop-id", "io"]] });
  });

  it("says nothing for a device that is not an IO, or when the hub switched it off itself", async () => {
    expect((await off("cab")).markDown).toEqual([]);
    expect((await off("io", { notifyHub: false })).markDown).toEqual([]);
  });
});
