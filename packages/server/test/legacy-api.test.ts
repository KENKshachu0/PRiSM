import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { sqliteSchema } from "@prism/storage-sql";
import type { D1BoundStatementLike, D1DatabaseLike, SqlValue } from "@prism/adapter-d1";
import type { AppBindings, Env } from "../src/bindings.js";
import { attachUser } from "../src/middleware/auth.js";
import { clearShopDependenciesCache } from "../src/middleware/tenant.js";
import { shopRouter } from "../src/routes/shops/index.js";
import { billingSetupStatements } from "../src/routes/platform/shops.js";
import { sha256, sha256Hex } from "../src/crypto.js";
import { mintResourceTicket } from "../src/routes/platform/resource-ticket.js";
import { legacyRouter } from "../src/legacy/index.js";

class InMemoryD1Database implements D1DatabaseLike {
  constructor(private readonly db: Database) {}

  prepare(sql: string) {
    const db = this.db;
    const createStatement = (...values: SqlValue[]) => ({
      async first<T = unknown>() {
        return (db.query(sql).get(...values) as T | null) ?? null;
      },
      async all<T = unknown>() {
        return {
          results: db.query(sql).all(...values) as T[],
        };
      },
      async run() {
        db.run(sql, values);
        return { success: true };
      },
    });

    return {
      ...createStatement(),
      bind(...values: SqlValue[]) {
        return createStatement(...values);
      },
    };
  }

  async batch(statements: readonly D1BoundStatementLike[]) {
    for (const statement of statements) {
      await statement.run();
    }
    return [];
  }
}

function createTestContext(): { db: D1DatabaseLike; sqlite: Database; env: Env } {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = OFF;");
  for (const statement of sqliteSchema) {
    sqlite.run(statement);
  }

  // These platform tables live in D1 migrations rather than the embedded SQL
  // repository schema; command contract fixtures need both.
  sqlite.run(`CREATE TABLE IF NOT EXISTS player_operations (
    shop_id TEXT NOT NULL, user_id TEXT NOT NULL, id TEXT NOT NULL,
    kind TEXT NOT NULL, status TEXT NOT NULL, request_hash TEXT NOT NULL,
    result_json TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY(shop_id,user_id,id))`);

  sqlite.run(`CREATE TABLE IF NOT EXISTS machines (
    shop_id TEXT NOT NULL, id TEXT NOT NULL, public_id TEXT NOT NULL,
    name TEXT NOT NULL, kind TEXT NOT NULL, enabled INTEGER NOT NULL,
    resource_group_id TEXT, pricing_config_override_id TEXT, capacity INTEGER NOT NULL DEFAULT 0, occupancy_minutes INTEGER NOT NULL DEFAULT 15,
    PRIMARY KEY(shop_id,id)
  )`);
  sqlite.run(`CREATE TABLE IF NOT EXISTS resource_groups (
    shop_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    default_pricing_config_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(shop_id,id)
  )`);

  sqlite.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'user',
      banned_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS auth_identities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_subject TEXT NOT NULL,
      username TEXT,
      display_name TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at TEXT,
      UNIQUE(provider, provider_subject),
      UNIQUE(user_id, provider)
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS shops (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      radius_meters INTEGER NOT NULL DEFAULT 80,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      public_id TEXT,
      hero_data TEXT,
      hero_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS shop_billing_settings (
      shop_id TEXT PRIMARY KEY REFERENCES shops(id),
      billing_enabled INTEGER NOT NULL DEFAULT 0,
      auto_register INTEGER NOT NULL DEFAULT 0,
      identity_binding_required INTEGER NOT NULL DEFAULT 1,
      checkin_geo INTEGER NOT NULL DEFAULT 0,
      checkout_geo INTEGER NOT NULL DEFAULT 0,
      machine_geo INTEGER NOT NULL DEFAULT 0,
      entry_pricing_ids_json TEXT NOT NULL DEFAULT '[]',
      bot_contact TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS shop_members (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL REFERENCES shops(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL DEFAULT 'owner',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(shop_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS shop_staff_accounts (
      shop_id TEXT NOT NULL REFERENCES shops(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      staff_id TEXT NOT NULL,
      PRIMARY KEY(shop_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS shop_player_accounts (
      shop_id TEXT NOT NULL REFERENCES shops(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      player_id TEXT NOT NULL,
      verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(shop_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS shop_platform_bindings (
      shop_id TEXT NOT NULL REFERENCES shops(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(shop_id, provider, subject),
      UNIQUE(shop_id, user_id, provider)
    );
    CREATE TABLE IF NOT EXISTS platform_binding_codes (
      shop_id TEXT NOT NULL REFERENCES shops(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      code_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(shop_id, user_id)
    );
  `);

  const db = new InMemoryD1Database(sqlite);
  const env: Env = {
    DB: db,
    APP_ORIGIN: "https://prism.test",
    SESSION_SECRET: "test-secret-key-32-chars-long!",
  };

  return { db, sqlite, env };
}

describe("Legacy Single-Store API Centralization & Isolation Suite", () => {
  beforeEach(() => {
    clearShopDependenciesCache();
  });

  it("requires a configured one-time secret for legacy setup install", async () => {
    const { env, sqlite } = createTestContext();
    const url = "https://prism.test/api/v1/setup/install";
    const request = (token?: string) => legacyRouter.request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { "X-PRiSM-Bootstrap-Token": token } : {}) },
      body: JSON.stringify({ storeName: "Unclaimed Shop" }),
    }, env);
    expect((await request()).status).toBe(503);
    env.PRISM_BOOTSTRAP_TOKEN_HASH = await sha256Hex("correct-bootstrap-token");
    expect((await request()).status).toBe(403);
    expect((await request("wrong-bootstrap-token")).status).toBe(403);
    expect(sqlite.query("SELECT id FROM shops").all()).toEqual([]);
  });

  async function setupFixture(db: D1DatabaseLike, sqlite: Database) {
    const shopId = "shop_default_1";
    const publicId = "default-store";
    const staffUserId = "user_staff_1";
    const staffSessionToken = "session_token_staff_1";
    const botToken = "bot_token_secret_1";

    const branchShopId = "shop_branch_2";
    const branchPublicId = "branch-store";

    // Setup staff user
    const tokenHash = await sha256(staffSessionToken);
    const futureExpiry = new Date(Date.now() + 86400000 * 7).toISOString();
    sqlite.run(
      "INSERT INTO users (id, role, created_at, updated_at) VALUES (?, 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      [staffUserId],
    );
    sqlite.run(
      "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('sess_staff', ?, ?, ?, CURRENT_TIMESTAMP)",
      [staffUserId, tokenHash, futureExpiry],
    );

    // Setup Default Shop
    sqlite.run(
      "INSERT INTO shops (id, public_id, name, latitude, longitude, radius_meters, created_by, created_at) VALUES (?, ?, 'Default Arcade', 31.23, 121.47, 100, ?, '2026-01-01 00:00:00')",
      [shopId, publicId, staffUserId],
    );
    sqlite.run(
      "INSERT INTO shop_members (id, shop_id, user_id, role) VALUES ('sm_1', ?, ?, 'owner')",
      [shopId, staffUserId],
    );

    // Default shop staff user record
    sqlite.run(
      "INSERT INTO staff_users (shop_id, id, username, display_name, password_hash, password_salt, role, status, created_at, updated_at) VALUES (?, 'staff_1', 'owner_user', 'Owner', 'hash123', 'salt123', 'owner', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      [shopId],
    );
    sqlite.run(
      "INSERT INTO shop_staff_accounts (shop_id, user_id, staff_id) VALUES (?, ?, 'staff_1')",
      [shopId, staffUserId],
    );

    // Billing setup for default shop
    const { statements: defaultStatements } = billingSetupStatements(db, shopId, {
      paidName: "默认充值余额",
      freeName: "默认赠送余额",
      hourlyPrice: 3000,
      graceMinutes: 5,
      dailyCap: 18000,
      botContact: "bot-contact-default",
      autoRegister: true,
    });
    await db.batch(defaultStatements);

    sqlite.run(
      "UPDATE shop_billing_settings SET identity_binding_required = 0, checkin_geo = 0, checkout_geo = 0, machine_geo = 0 WHERE shop_id = ?",
      [shopId],
    );

    // Register bot token for default shop
    const botTokenHash = await sha256Hex(botToken);
    sqlite.run(
      "INSERT INTO api_tokens (shop_id, id, label, role, token_prefix, token_hash, status, created_at) VALUES (?, 'tok_1', 'bot', 'integration', 'integration', ?, 'active', CURRENT_TIMESTAMP)",
      [shopId, botTokenHash],
    );

    // Setup Branch Shop
    sqlite.run(
      "INSERT INTO shops (id, public_id, name, latitude, longitude, radius_meters, created_by, created_at) VALUES (?, ?, 'Branch Arcade', 39.90, 116.40, 100, ?, '2026-02-01 00:00:00')",
      [branchShopId, branchPublicId, staffUserId],
    );
    sqlite.run(
      "INSERT INTO shop_members (id, shop_id, user_id, role) VALUES ('sm_2', ?, ?, 'owner')",
      [branchShopId, staffUserId],
    );

    const { statements: branchStatements } = billingSetupStatements(db, branchShopId, {
      paidName: "分店充值余额",
      freeName: "分店赠送余额",
      hourlyPrice: 5000,
      graceMinutes: 10,
      dailyCap: 30000,
      botContact: "bot-contact-branch",
      autoRegister: true,
    });
    await db.batch(branchStatements);

    sqlite.run(
      "UPDATE shop_billing_settings SET identity_binding_required = 0, checkin_geo = 0, checkout_geo = 0, machine_geo = 0 WHERE shop_id = ?",
      [branchShopId],
    );

    return {
      shopId,
      publicId,
      branchShopId,
      branchPublicId,
      staffUserId,
      staffSessionToken,
      botToken,
    };
  }

  function createTestApp() {
    const app = new Hono<AppBindings>();
    app.use("*", attachUser);
    app.route("/api/v1/shops/:shopCode", shopRouter);
    app.route("/", legacyRouter);
    return app;
  }

  it("resolves default shop automatically and appends standard deprecation headers", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, shopId } = await setupFixture(db, sqlite);
    const app = createTestApp();

    // Create an active player in default shop
    const playerId = "player_bob";
    sqlite.run(
      "INSERT INTO players (shop_id, id, display_name, status, created_at) VALUES (?, ?, 'Bob', 'active', CURRENT_TIMESTAMP)",
      [shopId, playerId],
    );
    sqlite.run(
      "INSERT INTO asset_holdings (shop_id, id, player_id, asset_type, asset_code, quantity) VALUES (?, 'hold_bob_1', ?, 'currency', 'paid', 50000)",
      [shopId, playerId],
    );

    // Create Bob's user account and session
    const bobUserId = "user_bob";
    const bobToken = "session_token_bob";
    const bobTokenHash = await sha256(bobToken);
    const futureExpiry = new Date(Date.now() + 86400000 * 7).toISOString();
    sqlite.run(
      "INSERT INTO users (id, role, created_at, updated_at) VALUES (?, 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      [bobUserId],
    );
    sqlite.run(
      "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('sess_bob', ?, ?, ?, CURRENT_TIMESTAMP)",
      [bobUserId, bobTokenHash, futureExpiry],
    );
    sqlite.run(
      "INSERT INTO shop_player_accounts (shop_id, user_id, player_id, verified_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
      [shopId, bobUserId, playerId],
    );

    const bobHeaders = {
      Authorization: `Bearer ${bobToken}`,
      "Content-Type": "application/json",
    };

    // 1. GET /api/v1/player/assets (without shopCode in path or header)
    const assetsRes = await app.fetch(
      new Request("https://prism.test/api/v1/player/assets", {
        headers: bobHeaders,
      }),
      env,
    );

    expect(assetsRes.status).toBe(200);
    // Verify deprecation headers
    expect(assetsRes.headers.get("X-API-Deprecated")).toBe("true");
    expect(assetsRes.headers.get("X-API-Replacement")).toBe(
      `/api/v1/shops/${publicId}/player/assets`,
    );
    expect(assetsRes.headers.get("Link")).toBe(
      `</api/v1/shops/${publicId}/player/assets>; rel="successor-version"`,
    );
    expect(assetsRes.headers.get("Warning")).toContain("299");
    expect(assetsRes.headers.get("Deprecation")).toBe("true");

    const assetsData = (await assetsRes.json()) as any;
    expect(assetsData.holdings).toBeDefined();
    expect(assetsData.holdings.length).toBeGreaterThanOrEqual(1);
    expect(assetsData.holdings[0].assetCode).toBe("paid");
    expect(assetsData.holdings[0].quantity).toBe(500);

    // Preserve the legacy path alias, but require the same QR session
    // ticket and entry acknowledgement as the canonical tenant route.
    sqlite.run("INSERT INTO machines(shop_id,id,public_id,name,kind,enabled) VALUES (?, 'entry-machine', 'entry-machine', 'Entry Machine', 'machine', 1)", [shopId]);
    const ticket = (await mintResourceTicket(env.SESSION_SECRET, publicId, "entry-machine")).ticket;
    // 2. POST /api/v1/player/session/start (start session without shopCode)
    const startRes = await app.fetch(
      new Request("https://prism.test/api/v1/player/session/start", {
        method: "POST",
        headers: bobHeaders,
        body: JSON.stringify({ ticket, consent: true, operationId: crypto.randomUUID() }),
      }),
      env,
    );
    if (!startRes.ok) console.error("QR-confirmed start failed", startRes.status, await startRes.clone().text());
    expect(startRes.status).toBe(200);
    expect(startRes.headers.get("X-API-Deprecated")).toBe("true");
    expect(startRes.headers.get("X-API-Replacement")).toBe(
      `/api/v1/shops/${publicId}/player/session/start`,
    );
    const startData = (await startRes.json()) as any;
    expect(startData.session).toBeDefined();
    expect(startData.session.playerId).toBe(playerId);
    expect(startData.session.status).toBe("active");

    // 3. GET /api/v1/player/me (get player summary)
    const meRes = await app.fetch(
      new Request("https://prism.test/api/v1/player/me", {
        headers: bobHeaders,
      }),
      env,
    );
    expect(meRes.status).toBe(200);
    expect(meRes.headers.get("X-API-Deprecated")).toBe("true");
    const meData = (await meRes.json()) as any;
    expect(meData.activeSession).toBeDefined();
    expect(meData.activeSession.id).toBe(startData.session.id);
  });

  it("accepts X-PRiSM-Shop-Code header to override target shop resolution", async () => {
    const { db, sqlite, env } = createTestContext();
    const { branchPublicId, branchShopId } = await setupFixture(db, sqlite);
    const app = createTestApp();

    // Create player in branch shop
    const playerId = "player_charlie";
    sqlite.run(
      "INSERT INTO players (shop_id, id, display_name, status, created_at) VALUES (?, ?, 'Charlie', 'active', CURRENT_TIMESTAMP)",
      [branchShopId, playerId],
    );
    sqlite.run(
      "INSERT INTO asset_holdings (shop_id, id, player_id, asset_type, asset_code, quantity) VALUES (?, 'hold_charlie_1', ?, 'currency', 'paid', 88000)",
      [branchShopId, playerId],
    );

    const charlieUserId = "user_charlie";
    const charlieToken = "session_token_charlie";
    const charlieTokenHash = await sha256(charlieToken);
    const futureExpiry = new Date(Date.now() + 86400000 * 7).toISOString();
    sqlite.run(
      "INSERT INTO users (id, role, created_at, updated_at) VALUES (?, 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      [charlieUserId],
    );
    sqlite.run(
      "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('sess_charlie', ?, ?, ?, CURRENT_TIMESTAMP)",
      [charlieUserId, charlieTokenHash, futureExpiry],
    );
    sqlite.run(
      "INSERT INTO shop_player_accounts (shop_id, user_id, player_id, verified_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
      [branchShopId, charlieUserId, playerId],
    );

    // Call legacy player assets with X-PRiSM-Shop-Code header specifying branch store
    const res = await app.fetch(
      new Request("https://prism.test/api/v1/player/assets", {
        headers: {
          Authorization: `Bearer ${charlieToken}`,
          "X-PRiSM-Shop-Code": branchPublicId,
        },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-API-Deprecated")).toBe("true");
    expect(res.headers.get("X-API-Replacement")).toBe(
      `/api/v1/shops/${branchPublicId}/player/assets`,
    );
    expect(res.headers.get("Link")).toBe(
      `</api/v1/shops/${branchPublicId}/player/assets>; rel="successor-version"`,
    );

    const data = (await res.json()) as any;
    expect(data.holdings).toBeDefined();
    expect(data.holdings[0].quantity).toBe(880);
  });

  it("accepts ?shopCode=... query parameter to override target shop resolution", async () => {
    const { db, sqlite, env } = createTestContext();
    const { branchPublicId, branchShopId } = await setupFixture(db, sqlite);
    const app = createTestApp();

    const playerId = "player_david";
    sqlite.run(
      "INSERT INTO players (shop_id, id, display_name, status, created_at) VALUES (?, ?, 'David', 'active', CURRENT_TIMESTAMP)",
      [branchShopId, playerId],
    );
    sqlite.run(
      "INSERT INTO asset_holdings (shop_id, id, player_id, asset_type, asset_code, quantity) VALUES (?, 'hold_david_1', ?, 'currency', 'paid', 25000)",
      [branchShopId, playerId],
    );

    const davidUserId = "user_david";
    const davidToken = "session_token_david";
    const davidTokenHash = await sha256(davidToken);
    const futureExpiry = new Date(Date.now() + 86400000 * 7).toISOString();
    sqlite.run(
      "INSERT INTO users (id, role, created_at, updated_at) VALUES (?, 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      [davidUserId],
    );
    sqlite.run(
      "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('sess_david', ?, ?, ?, CURRENT_TIMESTAMP)",
      [davidUserId, davidTokenHash, futureExpiry],
    );
    sqlite.run(
      "INSERT INTO shop_player_accounts (shop_id, user_id, player_id, verified_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
      [branchShopId, davidUserId, playerId],
    );

    const res = await app.fetch(
      new Request(`https://prism.test/api/v1/player/assets?shopCode=${branchPublicId}`, {
        headers: {
          Authorization: `Bearer ${davidToken}`,
        },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-API-Deprecated")).toBe("true");
    expect(res.headers.get("X-API-Replacement")).toBe(
      `/api/v1/shops/${branchPublicId}/player/assets`,
    );

    const data = (await res.json()) as any;
    expect(data.holdings[0].quantity).toBe(250);
  });

  it("handles legacy staff routes with default shop resolution and deprecation headers", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, shopId, staffSessionToken } = await setupFixture(db, sqlite);
    const app = createTestApp();

    // Register a player in default shop
    sqlite.run(
      "INSERT INTO players (shop_id, id, display_name, status, created_at) VALUES (?, 'p_staff_test', 'StaffTestPlayer', 'active', CURRENT_TIMESTAMP)",
      [shopId],
    );

    const res = await app.fetch(
      new Request("https://prism.test/api/v1/staff/players", {
        headers: {
          Authorization: `Bearer ${staffSessionToken}`,
        },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-API-Deprecated")).toBe("true");
    expect(res.headers.get("X-API-Replacement")).toBe(
      `/api/v1/shops/${publicId}/staff/players`,
    );
    expect(res.headers.get("Link")).toBe(
      `</api/v1/shops/${publicId}/staff/players>; rel="successor-version"`,
    );

    const data = (await res.json()) as any;
    expect(data.players).toBeDefined();
    expect(data.players.some((p: any) => p.displayName === "StaffTestPlayer")).toBe(true);
  });

  it("handles legacy bot integration routes with identity resolution and deprecation headers", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, shopId, botToken } = await setupFixture(db, sqlite);
    const app = createTestApp();

    // Register a player identity in the default shop
    sqlite.run(
      "INSERT INTO players (shop_id, id, display_name, status, created_at) VALUES (?, 'p_bot_test', 'BotPlayer', 'active', CURRENT_TIMESTAMP)",
      [shopId],
    );
    sqlite.run(
      "INSERT INTO player_identities (shop_id, player_id, provider, subject, created_at) VALUES (?, 'p_bot_test', 'onebot', '10086001', CURRENT_TIMESTAMP)",
      [shopId],
    );

    // Call legacy integration resolve endpoint
    const res = await app.fetch(
      new Request("https://prism.test/api/v1/integration/players/by-identity/resolve", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "onebot",
          subject: "10086001",
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-API-Deprecated")).toBe("true");
    expect(res.headers.get("X-API-Replacement")).toBe(
      `/api/v1/shops/${publicId}/integration/players/by-identity/resolve`,
    );
    expect(res.headers.get("Link")).toBe(
      `</api/v1/shops/${publicId}/integration/players/by-identity/resolve>; rel="successor-version"`,
    );

    const data = (await res.json()) as any;
    expect(data.player).toBeDefined();
    expect(data.player.status).toBe("active");
  });

  it("handles legacy setup routes (/api/v1/setup/status)", async () => {
    const { db, sqlite, env } = createTestContext();
    await setupFixture(db, sqlite);
    const app = createTestApp();

    const res = await app.fetch(
      new Request("https://prism.test/api/v1/setup/status"),
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-API-Deprecated")).toBe("true");
    expect(res.headers.get("X-API-Replacement")).toBe("/api/v1/setup/status");
    const data = (await res.json()) as any;
    expect(data.installed).toBe(true);
  });

  it("supports /rpc/* fallback route with unnested responses and deprecation headers", async () => {
    const { db, sqlite, env } = createTestContext();
    const { shopId } = await setupFixture(db, sqlite);
    const app = createTestApp();

    const playerId = "player_rpc";
    sqlite.run(
      "INSERT INTO players (shop_id, id, display_name, status, created_at) VALUES (?, ?, 'RpcUser', 'active', CURRENT_TIMESTAMP)",
      [shopId, playerId],
    );
    sqlite.run(
      "INSERT INTO asset_holdings (shop_id, id, player_id, asset_type, asset_code, quantity) VALUES (?, 'hold_rpc_1', ?, 'currency', 'paid', 30000)",
      [shopId, playerId],
    );

    const rpcUserId = "user_rpc";
    const rpcToken = "session_token_rpc";
    const rpcTokenHash = await sha256(rpcToken);
    const futureExpiry = new Date(Date.now() + 86400000 * 7).toISOString();
    sqlite.run(
      "INSERT INTO users (id, role, created_at, updated_at) VALUES (?, 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      [rpcUserId],
    );
    sqlite.run(
      "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('sess_rpc', ?, ?, ?, CURRENT_TIMESTAMP)",
      [rpcUserId, rpcTokenHash, futureExpiry],
    );
    sqlite.run(
      "INSERT INTO shop_player_accounts (shop_id, user_id, player_id, verified_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
      [shopId, rpcUserId, playerId],
    );

    const res = await app.fetch(
      new Request("https://prism.test/rpc/player/assets", {
        headers: {
          Authorization: `Bearer ${rpcToken}`,
        },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-API-Deprecated")).toBe("true");
    expect(res.headers.get("deprecation")).toBe("true");

    const data = (await res.json()) as any;
    expect(data.holdings).toBeDefined();
    expect(data.holdings[0].quantity).toBe(300);
  });

  it("rejects unauthenticated requests on legacy integration override endpoints with 403", async () => {
    const { db, sqlite, env } = createTestContext();
    await setupFixture(db, sqlite);
    const app = createTestApp();

    const res = await app.fetch(
      new Request("https://prism.test/api/v1/integration/players/by-identity/checkout/override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "qq", subject: "12345", total: 0 }),
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when explicit shopCode does not match any shop instead of silent fallback", async () => {
    const { db, sqlite, env } = createTestContext();
    await setupFixture(db, sqlite);
    const app = createTestApp();

    const res = await app.fetch(
      new Request("https://prism.test/api/v1/player/me", {
        headers: {
          "X-PRiSM-Shop-Code": "non-existent-shop",
        },
      }),
      env,
    );
    expect(res.status).toBe(404);
    const data = (await res.json()) as any;
    expect(data.error?.code).toBe("SHOP_NOT_FOUND");
  });
});
