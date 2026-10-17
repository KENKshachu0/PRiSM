import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { D1BoundStatementLike, D1DatabaseLike, SqlValue } from "@prism/adapter-d1";
import type { AppBindings, Env } from "../src/bindings.js";
import { deviceEventSchema } from "@prism/storage-sql";
import { sha256Hex } from "../src/crypto.js";
import { merchantMachineRouter } from "../src/routes/platform/merchant-machines.js";

class SqliteD1 implements D1DatabaseLike {
  constructor(private readonly sqlite: Database) {}
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...values: SqlValue[]) {
        return {
          async first<T = unknown>() {
            return (db.query(sql).get(...values) as T | null) ?? null;
          },
          async all<T = unknown>() {
            return { results: db.query(sql).all(...values) as T[] };
          },
          async run() {
            const result = db.run(sql, values);
            return { meta: { changes: result.changes } };
          },
        };
      },
    };
  }
  async batch(statements: readonly D1BoundStatementLike[]) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

function fixture(options: { relay?: "online" | "offline" | "e2ee" | "throwing" } = {}) {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE shops(
      id TEXT PRIMARY KEY, public_id TEXT NOT NULL, name TEXT NOT NULL,
      latitude REAL NOT NULL, longitude REAL NOT NULL, radius_meters INTEGER NOT NULL,
      hero_data TEXT, hero_hash TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE machines(
      shop_id TEXT NOT NULL, id TEXT NOT NULL, public_id TEXT NOT NULL, name TEXT NOT NULL,
      hinata_url_encrypted TEXT NOT NULL DEFAULT '', hinata_password_encrypted TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL DEFAULT 'machine',
      ha_binding_encrypted TEXT, ttlock_lock_id INTEGER, coin_key INTEGER NOT NULL DEFAULT 32,
      coin_after_swipe INTEGER NOT NULL DEFAULT 0, mahjong_config_json TEXT,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(shop_id, id)
    );
    CREATE TABLE shop_members(shop_id TEXT, user_id TEXT, role TEXT);
    CREATE TABLE shop_staff_accounts(shop_id TEXT, staff_id TEXT, user_id TEXT);
    CREATE TABLE staff_users(shop_id TEXT, id TEXT, role TEXT, status TEXT);
    CREATE TABLE app_settings(shop_id TEXT, key TEXT, value_json TEXT, updated_at TEXT, PRIMARY KEY(shop_id,key));
    CREATE TABLE shop_billing_settings(
      shop_id TEXT PRIMARY KEY, billing_enabled INTEGER, auto_register INTEGER,
      identity_binding_required INTEGER, checkin_geo INTEGER, checkout_geo INTEGER, machine_geo INTEGER,
      entry_pricing_ids_json TEXT, bot_contact TEXT
    );
  `);
  for (const statement of deviceEventSchema) sqlite.exec(statement);
  sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters) VALUES ('shop-1','shop-code','Test Shop',0,0,80)");
  sqlite.run("INSERT INTO shop_members(shop_id,user_id,role) VALUES ('shop-1','admin-1','owner')");
  const env = {
    DB: new SqliteD1(sqlite),
    SESSION_SECRET: "session-secret",
    URL_ENCRYPTION_KEY: "unit-test-encryption-key",
    APP_ORIGIN: "https://prism.test",
    // Mirrors the namespace shape the route narrows to. Unset unless the test
    // asks for a status, so the default path exercises "no binding".
    ...(options.relay
      ? {
          MACHINE_RELAY: {
            getByName: () => ({
              async getCapabilities() {
                if (options.relay === "throwing") throw new Error("durable object unreachable");
                return {
                  online: options.relay !== "offline",
                  e2ee: options.relay === "e2ee",
                  agents: [],
                };
              },
            }),
          },
        }
      : {}),
  } as unknown as Env;
  const app = new Hono<AppBindings>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "admin-1", role: "owner", username: "admin", displayName: "Admin", bannedAt: null } as any);
    await next();
  });
  app.route("/api/v1/merchant", merchantMachineRouter);
  return { app, env, sqlite };
}

async function create(app: Hono<AppBindings>, env: Env, body: Record<string, unknown>) {
  const response = await app.fetch(
    new Request("https://prism.test/api/v1/merchant/machines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shopId: "shop-1", name: "Cabinet", ...body }),
    }),
    env,
  );
  return { status: response.status, body: (await response.json()) as any };
}

function io(sqlite: Database) {
  return sqlite.query<{ credential_hash: string | null; channel: string | null; config_json: string; secret_json: string }, []>(
    "SELECT credential_hash, json_extract(config_json,'$.channel') AS channel, config_json, secret_json FROM device_capabilities WHERE capability='hinata_io'",
  ).get()!;
}

describe("embedded relay machine configuration", () => {
  it("keeps a new machine on the external relay by default", async () => {
    // Nothing changes for existing stores until a machine opts in.
    const { app, env } = fixture();
    const created = await create(app, env, {});
    expect(created.status).toBe(201);
    expect(created.body.machine.relayConnection).toBe("external");
    expect(created.body.machine.relayUrl).toBeNull();
    expect(created.body.relayToken).toBeUndefined();
  });

  it("mints a device token and channel on opt-in and returns the token once", async () => {
    const { app, env, sqlite } = fixture();
    const created = await create(app, env, { relayConnection: "embedded" });
    expect(created.status).toBe(201);
    expect(created.body.machine.relayConnection).toBe("embedded");
    expect(created.body.machine.relayUrl).toBe("https://prism.test/io/ws");
    expect(created.body.machine.hasRelayToken).toBe(true);
    expect(typeof created.body.relayToken).toBe("string");
    expect(created.body.relayToken.startsWith("prism_io_")).toBe(true);

    // Only the hash is stored, and the plaintext is never persisted.
    const stored = io(sqlite);
    expect(stored.credential_hash).toBe(await sha256Hex(created.body.relayToken));
    expect(JSON.stringify(stored)).not.toContain(created.body.relayToken);
    expect(stored.channel).toMatch(/^m_/);
  });

  it("never re-exposes the token when the device list is reloaded", async () => {
    const { app, env } = fixture();
    await create(app, env, { relayConnection: "embedded" });
    const listed = await app.fetch(
      new Request("https://prism.test/api/v1/merchant/machines?shopId=shop-1"),
      env,
    );
    const body = (await listed.json()) as any;
    expect(body.machines[0].hasRelayToken).toBe(true);
    expect(JSON.stringify(body)).not.toContain("prism_io_");
  });

  it("rotates the token without changing the channel, so a live device is not orphaned", async () => {
    const { app, env, sqlite } = fixture();
    const created = await create(app, env, { relayConnection: "embedded" });
    const before = io(sqlite);
    const rotated = await app.fetch(
      new Request(`https://prism.test/api/v1/merchant/machines/${created.body.machine.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rotateRelayToken: true }),
      }),
      env,
    );
    const body = (await rotated.json()) as any;
    expect(body.relayToken).toBeDefined();
    expect(body.relayToken).not.toBe(created.body.relayToken);
    const after = io(sqlite);
    expect(after.channel).toBe(before.channel);
    expect(after.credential_hash).toBe(await sha256Hex(body.relayToken));
  });

  it("refuses an embedded machine that still has an E2EE password", async () => {
    // The device would reject every plaintext command, so this is caught at
    // configuration time rather than left to fail silently at the cabinet.
    const { app, env } = fixture();
    const created = await create(app, env, {
      relayConnection: "embedded",
      hinataUrl: "https://relay.example/instance",
      hinataPassword: "still-encrypted",
    });
    expect(created.status).toBe(400);
    expect(created.body.error.code).toBe("DEVICE_RELAY_PASSWORD_CONFLICT");
  });

  it("switches an external machine to direct mode without losing its coin key", async () => {
    const { app, env, sqlite } = fixture();
    const created = await create(app, env, {
      hinataUrl: "https://relay.example/instance", hinataPassword: "old-e2ee", coinKey: 40, coinAfterSwipe: true,
    });
    const switched = await app.fetch(
      new Request(`https://prism.test/api/v1/merchant/machines/${created.body.machine.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ relayConnection: "embedded" }),
      }),
      env,
    );
    expect(switched.status).toBe(200);
    const body = (await switched.json()) as any;
    expect(body.machine).toMatchObject({ relayConnection: "embedded", coinKey: 40, coinAfterSwipe: true, hasPassword: false });
    // The relay password means nothing to a direct connection and is dropped.
    expect(JSON.parse(io(sqlite).secret_json).password).toBeUndefined();
  });

  it("clears relay credentials when a machine goes back to external", async () => {
    const { app, env, sqlite } = fixture();
    const created = await create(app, env, { relayConnection: "embedded" });
    await app.fetch(
      new Request(`https://prism.test/api/v1/merchant/machines/${created.body.machine.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ relayConnection: "external" }),
      }),
      env,
    );
    // With no relay URL either, the machine no longer has a HINATA IO at all.
    expect(sqlite.query("SELECT 1 FROM device_capabilities WHERE capability='hinata_io'").get()).toBeNull();
  });
});

describe("embedded relay connection status", () => {
  async function listStatus(fixtureOptions: Parameters<typeof fixture>[0]) {
    const { app, env } = fixture(fixtureOptions);
    await create(app, env, { relayConnection: "embedded" });
    const listed = await app.fetch(
      new Request("https://prism.test/api/v1/merchant/machines?shopId=shop-1"),
      env,
    );
    return ((await listed.json()) as any).machines[0];
  }

  it("reports a connected IO as online", async () => {
    expect((await listStatus({ relay: "online" })).relayOnline).toBe(true);
  });

  it("reports a disconnected IO as offline", async () => {
    // A machine with a valid token whose IO is not connected is genuinely
    // offline, which is different from "we could not ask".
    expect((await listStatus({ relay: "offline" })).relayOnline).toBe(false);
  });

  it("reports unknown, not offline, when the relay cannot be reached", async () => {
    // Blanking the board or claiming offline would both mislead the store.
    const machine = await listStatus({ relay: "throwing" });
    expect(machine.relayOnline).toBeNull();
  });

  it("reports unknown when no relay binding is configured", async () => {
    expect((await listStatus({})).relayOnline).toBeNull();
  });

  it("surfaces that the IO is still encrypting", async () => {
    // Embedded mode cannot read E2EE payloads, so the editor must be able to
    // tell the store to clear remotePassword.
    expect((await listStatus({ relay: "e2ee" })).relayE2ee).toBe(true);
  });

  it("leaves an external machine without a direct connection status", async () => {
    const { app, env } = fixture({ relay: "online" });
    const created = await create(app, env, {});
    expect(created.body.machine.relayOnline).toBeNull();
    expect(created.body.machine.relayE2ee).toBeNull();
  });
});
