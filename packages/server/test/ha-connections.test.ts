import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { D1BoundStatementLike, D1DatabaseLike, SqlValue } from "@prism/adapter-d1";
import type { AppBindings, Env } from "../src/bindings.js";
import { deviceEventSchema } from "@prism/storage-sql";
import { decryptSecret, encryptSecret } from "../src/crypto.js";
import { merchantResourceRouter } from "../src/routes/platform/merchant-resources.js";
import { merchantHaRouter } from "../src/routes/platform/merchant-ha.js";
import { loadResources } from "../src/resources/resource.js";
import { getHaConnection, listHaConnections, newHaConnection, writeHaConnection } from "../src/resources/capabilities/ha-connections.js";
import { provisionReadAccess } from "../src/resources/capabilities/ha-read-access.js";
import type { HaSocket } from "../src/hardware/home-assistant-ws.js";

const KEY = "unit-test-encryption-key";

class SqliteD1 implements D1DatabaseLike {
  constructor(private readonly sqlite: Database) {}
  prepare(sql: string) {
    const db = this.sqlite;
    return { bind(...values: SqlValue[]) {
      return {
        async first<T = unknown>() { return (db.query(sql).get(...values) as T | null) ?? null; },
        async all<T = unknown>() { return { results: db.query(sql).all(...values) as T[] }; },
        async run() { const result = db.run(sql, values); return { meta: { changes: result.changes } }; },
      };
    } };
  }
  async batch(statements: readonly D1BoundStatementLike[]) {
    const results = [];
    for (const stmt of statements) results.push(await stmt.run());
    return results;
  }
}

function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE shops(id TEXT PRIMARY KEY, public_id TEXT NOT NULL, name TEXT NOT NULL,
      latitude REAL NOT NULL, longitude REAL NOT NULL, radius_meters INTEGER NOT NULL, hero_data TEXT, hero_hash TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE app_settings(shop_id TEXT,key TEXT,value_json TEXT,updated_at TEXT,PRIMARY KEY(shop_id,key));
    CREATE TABLE machines(shop_id TEXT NOT NULL,id TEXT NOT NULL,public_id TEXT NOT NULL,name TEXT NOT NULL,
      hinata_url_encrypted TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 1,kind TEXT NOT NULL DEFAULT 'machine',
      aliases_json TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,resource_group_id TEXT,pricing_config_override_id TEXT,capacity INTEGER NOT NULL DEFAULT 0,occupancy_minutes INTEGER NOT NULL DEFAULT 15,PRIMARY KEY(shop_id,id));
  `);
  sqlite.run("CREATE TABLE players(shop_id TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(shop_id,id))");
  for (const statement of deviceEventSchema) sqlite.run(statement);
  sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters) VALUES ('shop-1','shop-code','Test',0,0,80)");
  const db = new SqliteD1(sqlite);
  const env = { DB: db, SESSION_SECRET: "s", URL_ENCRYPTION_KEY: KEY } as unknown as Env;
  const app = new Hono<AppBindings>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "admin-1", role: "admin", username: "admin", displayName: "Admin", bannedAt: null });
    await next();
  });
  app.route("/api/v1/merchant", merchantResourceRouter);
  app.route("/api/v1/merchant", merchantHaRouter);
  const send = (method: string, path: string, body?: unknown) =>
    app.fetch(new Request(`https://prism.test/api/v1/merchant${path}`, {
      method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
  const capabilities = () =>
    sqlite.query<{ capability: string; config_json: string; secret_json: string }, []>(
      "SELECT capability,config_json,secret_json FROM device_capabilities ORDER BY capability",
    ).all();
  return { sqlite, db, env, send, capabilities };
}

describe("shop Home Assistant connections", () => {
  it("makes one connection for a Home Assistant and points every entity of it there", async () => {
    const { send, db, capabilities } = fixture();
    const created = await send("POST", "/machines", {
      shopId: "shop-1", name: "包间",
      homeAssistant: { url: "https://ha.example/", entityId: "switch.room", token: "ha-token" },
      // No token: the power side's connection to the same address is used.
      climate: { url: "https://ha.example", entityId: "climate.room" },
    });
    expect(created.status).toBe(201);
    const connections = await listHaConnections(db, "shop-1");
    expect(connections.map((c) => c.url)).toEqual(["https://ha.example"]);
    expect(await decryptSecret(connections[0]!.token, KEY)).toBe("ha-token");
    const id = connections[0]!.id;
    expect(capabilities().map((row) => [row.capability, JSON.parse(row.config_json), row.secret_json])).toEqual([
      ["climate", { connectionId: id, entityId: "climate.room" }, "{}"],
      ["power", { connectionId: id, entityId: "switch.room" }, "{}"],
    ]);
    const { machine } = await created.json() as { machine: { homeAssistant: unknown; climate: unknown } };
    expect(machine.homeAssistant).toEqual({ connectionId: id, url: "https://ha.example", entityId: "switch.room" });

    // A second device on the same Home Assistant can name the connection directly.
    const second = await send("POST", "/machines", {
      shopId: "shop-1", name: "华卡", homeAssistant: { connectionId: id, entityId: "switch.wacca" },
    });
    expect(second.status).toBe(201);
    expect(await listHaConnections(db, "shop-1")).toHaveLength(1);
    const listed = await (await send("GET", "/ha-connections?shopId=shop-1")).json() as { connections: Array<{ devices: number }> };
    expect(listed.connections[0]!.devices).toBe(3);
  });

  it("changes the token once for every device on the connection", async () => {
    const { send, db } = fixture();
    await send("POST", "/machines", { shopId: "shop-1", name: "A", homeAssistant: { url: "https://ha.example", entityId: "switch.a", token: "old" } });
    const [connection] = await listHaConnections(db, "shop-1");
    const patched = await send("PATCH", `/ha-connections/${connection!.id}?shopId=shop-1`, { token: "new" });
    expect(patched.status).toBe(200);
    expect(JSON.stringify(await patched.json())).not.toContain("new");
    expect(await decryptSecret((await getHaConnection(db, "shop-1", connection!.id))!.token, KEY)).toBe("new");
    // In use, so it cannot be removed.
    expect((await send("DELETE", `/ha-connections/${connection!.id}?shopId=shop-1`)).status).toBe(409);
  });

  it("moves an old binding that kept url and token in the capability onto a connection", async () => {
    const { sqlite, db, capabilities } = fixture();
    sqlite.run("INSERT INTO machines(shop_id,id,public_id,name) VALUES ('shop-1','m1','p1','Old')");
    const binding = await encryptSecret(JSON.stringify({ url: "https://ha.example", token: "t", entityId: "switch.old" }), KEY);
    sqlite.run(
      `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
       VALUES ('shop-1','m1','power','{}',?,'2026-01-01','2026-01-01')`,
      [JSON.stringify({ binding })],
    );
    const [device] = await loadResources(db, "shop-1", KEY);
    const [connection] = await listHaConnections(db, "shop-1");
    expect(connection!.url).toBe("https://ha.example");
    expect(JSON.parse(capabilities()[0]!.config_json)).toEqual({ connectionId: connection!.id, entityId: "switch.old" });
    expect(capabilities()[0]!.secret_json).toBe("{}");
    // Reading again changes nothing.
    await loadResources(db, "shop-1", KEY);
    expect(await listHaConnections(db, "shop-1")).toHaveLength(1);
    expect(device!.name).toBe("Old");
  });
});

/** A scripted Home Assistant WebSocket: answers by command type, per token. */
function fakeHa(handlers: Record<string, (msg: Record<string, unknown>, token: string) => unknown>) {
  const sent: Array<{ token: string; msg: Record<string, unknown> }> = [];
  const open = async (): Promise<HaSocket> => {
    const listeners: Record<string, Array<(event: unknown) => void>> = {};
    let token = "";
    // Sockets deliver messages as tasks, after the caller has attached listeners.
    const emit = (type: string, data?: unknown) => setTimeout(() => {
      for (const listener of listeners[type] ?? []) listener({ data: JSON.stringify(data) });
    }, 0);
    const socket: HaSocket = {
      addEventListener(type, listener) { (listeners[type] ??= []).push(listener); },
      close() {},
      send(raw) {
        const msg = JSON.parse(raw) as Record<string, unknown>;
        if (msg.type === "auth") {
          token = String(msg.access_token);
          emit("message", { type: "auth_ok" });
          return;
        }
        sent.push({ token, msg });
        const handler = handlers[String(msg.type)];
        if (!handler) {
          emit("message", { id: msg.id, type: "result", success: false, error: { message: "unknown" } });
          return;
        }
        emit("message", { id: msg.id, type: "result", success: true, result: handler(msg, token) });
      },
    };
    emit("message", { type: "auth_required" });
    return socket;
  };
  return { open, sent };
}

describe("read-only Home Assistant account", () => {
  async function seeded() {
    const ctx = fixture();
    const connection = await newHaConnection("https://ha.example", "admin-token", KEY);
    await writeHaConnection(ctx.db, "shop-1", connection).run();
    return { ...ctx, id: connection.id };
  }
  const loginFetch = (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path === "/auth/login_flow") return Response.json({ flow_id: "flow-1" });
    if (path === "/auth/login_flow/flow-1") return Response.json({ type: "create_entry", result: "code-1" });
    if (path === "/auth/token") return Response.json({ access_token: "short-lived" });
    if (path === "/api/config") return Response.json({ internal_url: "http://ha.local:8123/" });
    return new Response("", { status: 404 });
  }) as typeof fetch;

  it("creates a read-only user, mints its token and removes its password", async () => {
    const { db, id } = await seeded();
    const ha = fakeHa({
      "auth/current_user": () => ({ is_admin: true }),
      "config/auth/create": (msg) => {
        expect(msg.group_ids).toEqual(["system-read-only"]);
        return { user: { id: "reader-1" } };
      },
      "config/auth_provider/homeassistant/create": () => null,
      "auth/long_lived_access_token": (_msg, token) => {
        // Minted by the new user, not by the administrator.
        expect(token).toBe("short-lived");
        return "read-token";
      },
      "config/auth_provider/homeassistant/delete": () => null,
    });
    const result = await provisionReadAccess(db, "shop-1", id, KEY, { origin: "https://prism.test", open: ha.open, fetcher: loginFetch });
    expect(result).toEqual({ access: "ready", error: null });
    const stored = (await getHaConnection(db, "shop-1", id))!;
    expect(await decryptSecret(stored.readToken!, KEY)).toBe("read-token");
    expect(stored).toMatchObject({ readUserId: "reader-1", readAccess: "ready", internalUrl: "http://ha.local:8123" });
    expect(ha.sent.map((s) => s.msg.type)).toContain("config/auth_provider/homeassistant/delete");
  });

  it("asks for an administrator when the control token is not one", async () => {
    const { db, id } = await seeded();
    const ha = fakeHa({ "auth/current_user": () => ({ is_admin: false }) });
    const result = await provisionReadAccess(db, "shop-1", id, KEY, { origin: "https://prism.test", open: ha.open, fetcher: loginFetch });
    expect(result.access).toBe("needs_admin");
    expect((await getHaConnection(db, "shop-1", id))!.readToken).toBeNull();
    expect(ha.sent.map((s) => s.msg.type)).toEqual(["auth/current_user"]);
  });

  it("records a failure instead of throwing", async () => {
    const { db, id } = await seeded();
    const ha = fakeHa({ "auth/current_user": () => ({ is_admin: true }) });
    const result = await provisionReadAccess(db, "shop-1", id, KEY, { origin: "https://prism.test", open: ha.open, fetcher: loginFetch });
    expect(result.access).toBe("failed");
    expect((await getHaConnection(db, "shop-1", id))!.readAccess).toBe("failed");
  });
});
