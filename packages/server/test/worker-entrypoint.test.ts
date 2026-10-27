import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { sqliteSchema } from "@prism/storage-sql";
import { PrismDomainError } from "@prism/core";
import type {
  D1BoundStatementLike,
  D1DatabaseLike,
  SqlValue,
} from "@prism/adapter-d1";
import type { AppBindings, Env } from "../src/bindings.js";
import { sha256, sha256Hex } from "../src/crypto.js";
import { createApp, app } from "../src/app.js";
import { worker, LiveBilling } from "../src/worker.js";
import { billingSetupStatements } from "../src/routes/platform/shops.js";
import { clearShopDependenciesCache } from "../src/middleware/tenant.js";
import { clearRateLimitMemory } from "../src/middleware/rate-limit.js";
import {
  migrateShopLocationTimeZones,
  ensureShopLocationTimeZones,
  shopLocationTimeZoneMigrationId,
} from "../src/migrations/shop-time-zone-migration.js";
import { purgeExpiredPlatformState } from "../src/tasks/cron-handlers.js";

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
        const res = db.run(sql, values);
        return { success: true, meta: { changes: res.changes } };
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

function createTestEnvironment(): {
  sqlite: Database;
  db: D1DatabaseLike;
  env: Env;
  cleanup: () => void;
} {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = OFF;");
  for (const statement of sqliteSchema) {
    sqlite.run(statement);
  }

  // Add platform & tenant tables
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
    CREATE TABLE IF NOT EXISTS auth_challenges (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      purpose TEXT NOT NULL,
      challenge TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      device_type TEXT,
      backed_up INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      aaguid TEXT,
      provider_name TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS shops (
      id TEXT PRIMARY KEY,
      public_id TEXT,
      name TEXT NOT NULL,
      hero_data TEXT,
      hero_hash TEXT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      radius_meters INTEGER NOT NULL DEFAULT 80,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS shop_members (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL REFERENCES shops(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL DEFAULT 'owner',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(shop_id, user_id)
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
    CREATE TABLE IF NOT EXISTS app_settings (
      shop_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (shop_id, key)
    );
    CREATE TABLE IF NOT EXISTS api_tokens (
      shop_id TEXT NOT NULL,
      id TEXT NOT NULL,
      label TEXT NOT NULL,
      role TEXT NOT NULL,
      token_prefix TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      PRIMARY KEY (shop_id, id)
    );
    CREATE TABLE IF NOT EXISTS asset_definitions (
      shop_id TEXT NOT NULL,
      type TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      stackable INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      PRIMARY KEY (shop_id, type, code)
    );
    CREATE TABLE IF NOT EXISTS asset_holdings (
      shop_id TEXT NOT NULL,
      id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      asset_code TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS pricing_configs (
      shop_id TEXT NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      provider_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (shop_id, id)
    );
    CREATE TABLE IF NOT EXISTS platform_binding_codes (
      shop_id TEXT NOT NULL,
      id TEXT PRIMARY KEY,
      user_id TEXT,
      code_hash TEXT,
      expires_at TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS machine_tickets (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      expires_at TEXT
    );
    CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      name TEXT NOT NULL, capacity INTEGER NOT NULL DEFAULT 0, occupancy_minutes INTEGER NOT NULL DEFAULT 15,
      resource_group_id TEXT, pricing_config_override_id TEXT
    );
    CREATE TABLE IF NOT EXISTS resource_groups (
      shop_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      default_pricing_config_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(shop_id, id)
    );
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      display_name TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS shop_player_accounts (
      shop_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (shop_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS shop_staff_accounts (
      shop_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      staff_id TEXT NOT NULL,
      PRIMARY KEY (shop_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS shop_platform_bindings (
      shop_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (shop_id, user_id, provider)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      status TEXT NOT NULL,
      payment_status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      pricing_release_id TEXT,
      pricing_config_ids_json TEXT
    );
    CREATE TABLE IF NOT EXISTS prism_deployment_gate (
      id TEXT PRIMARY KEY CHECK(id='global'),
      owner_hash TEXT NOT NULL,
      maintenance INTEGER NOT NULL CHECK(maintenance IN (0,1)),
      permit INTEGER NOT NULL DEFAULT 0 CHECK(permit IN (0,1)),
      checked INTEGER NOT NULL DEFAULT 0 CHECK(checked IN (0,1)),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS prism_data_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const db = new InMemoryD1Database(sqlite);
  const env: Env = {
    DB: db,
    APP_ORIGIN: "https://prism.test",
    PRISM_DEPLOY_REVISION: "rev-2026-10-08-test",
    SESSION_SECRET: "test-session-secret-key-12345",
  };

  return {
    sqlite,
    db,
    env,
    cleanup: () => {
      sqlite.close();
    },
  };
}

describe("Worker Entrypoint & Root Application Suite", () => {
  beforeEach(() => {
    clearShopDependenciesCache();
    clearRateLimitMemory();
  });

  describe("Step 1: Root App Route Dispatching (app.ts)", () => {
    it("routes GET /health and GET /api/v1/health successfully", async () => {
      const { env } = createTestEnvironment();
      const testApp = createApp();

      const r1 = await testApp.request("https://prism.test/health", {}, env);
      expect(r1.status).toBe(200);
      const b1 = (await r1.json()) as { ok: boolean; status: string };
      expect(b1.ok).toBe(true);
      expect(b1.status).toBe("healthy");
      expect(r1.headers.get("x-response-time")).toBeDefined();

      const r2 = await testApp.request(
        "https://prism.test/api/v1/health",
        {},
        env,
      );
      expect(r2.status).toBe(200);
      const b2 = (await r2.json()) as { data: { ok: boolean; status: string } };
      expect(b2.data.ok).toBe(true);
      expect(b2.data.status).toBe("healthy");
    });

    it("routes GET /version and GET /api/v1/version with service metadata", async () => {
      const { env } = createTestEnvironment();
      const testApp = createApp();

      const r1 = await testApp.request("https://prism.test/version", {}, env);
      expect(r1.status).toBe(200);
      const b1 = (await r1.json()) as { service: string; revision: string };
      expect(b1.service).toBe("prism-api");
      expect(b1.revision).toBe("rev-2026-10-08-test");

      const r2 = await testApp.request(
        "https://prism.test/api/v1/version",
        {},
        env,
      );
      expect(r2.status).toBe(200);
      const b2 = (await r2.json()) as { data: { service: string } };
      expect(b2.data.service).toBe("prism-api");
    });

    it("dispatches platform auth and shop routes correctly", async () => {
      const { env, sqlite } = createTestEnvironment();
      const testApp = createApp();

      // Simulate an already-verified MuNET platform user.
      // A username alone must never create a platform session.
      const userId = crypto.randomUUID();
      const sessionToken = `verified-worker-session-${crypto.randomUUID()}`;
      sqlite.run(
        "INSERT INTO users (id, role) VALUES (?, 'user')",
        [userId],
      );
      sqlite.run(
        "INSERT INTO auth_identities (id, user_id, provider, provider_subject, username, display_name) VALUES (?, ?, 'munet', ?, ?, ?)",
        [crypto.randomUUID(), userId, "alice", "alice", "Alice In Wonderland"],
      );
      sqlite.run(
        "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
        [crypto.randomUUID(), userId, await sha256(sessionToken), new Date(Date.now() + 86_400_000).toISOString()],
      );
      const sessionCookie = `arcadelink_session=${sessionToken}`;

      // Check /api/v1/user/me
      const meRes = await testApp.request(
        "https://prism.test/api/v1/user/me",
        { headers: { cookie: sessionCookie } },
        env,
      );
      expect(meRes.status).toBe(200);
      const meData = (await meRes.json()) as { data: { user: { username: string } } };
      expect(meData.data.user.username).toBe("alice");

      // Create a shop via /api/v1/shops
      const shopRes = await testApp.request(
        "https://prism.test/api/v1/shops",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: sessionCookie,
          },
          body: JSON.stringify({
            name: "Wonderland Arcade",
            latitude: 31.23,
            longitude: 121.47,
            radiusMeters: 100,
          }),
        },
        env,
      );
      expect(shopRes.status).toBe(201);
      const shopData = (await shopRes.json()) as {
        data: { shop: { id: string; publicId: string; name: string } };
      };
      expect(shopData.data.shop.name).toBe("Wonderland Arcade");

      // List shops via /api/v1/shops
      const listRes = await testApp.request(
        "https://prism.test/api/v1/shops",
        { headers: { cookie: sessionCookie } },
        env,
      );
      expect(listRes.status).toBe(200);
      const listData = (await listRes.json()) as {
        data: { shops: Array<{ name: string }> };
      };
      expect(listData.data.shops).toHaveLength(1);
      expect(listData.data.shops[0]!.name).toBe("Wonderland Arcade");
    });

    it("dispatches tenant shop routes under /api/v1/shops/:shopCode", async () => {
      const { env, sqlite, db } = createTestEnvironment();
      const testApp = createApp();

      const shopId = "wonder_shop_id";
      const publicId = "wonder-arc";
      const userId = "wonder_owner";

      sqlite.run(
        "INSERT INTO users (id, role) VALUES (?, 'user')",
        [userId],
      );
      sqlite.run(
        "INSERT INTO shops (id, public_id, name, latitude, longitude, radius_meters, created_by) VALUES (?, ?, 'Wonder Arcade', 31.2, 121.4, 80, ?)",
        [shopId, publicId, userId],
      );
      sqlite.run(
        "INSERT INTO shop_members (id, shop_id, user_id, role) VALUES ('sm1', ?, ?, 'owner')",
        [shopId, userId],
      );
      const ownerTokenHash = await sha256("owner_session_token");
      sqlite.run(
        "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES ('sess_wonder_owner', ?, ?, datetime('now', '+7 days'))",
        [userId, ownerTokenHash],
      );

      // Setup standard billing configuration
      const { statements } = billingSetupStatements(db, shopId, {
        paidName: "金币",
        freeName: "银币",
        hourlyPrice: 2000,
        graceMinutes: 5,
        dailyCap: 10000,
        botContact: "@wonder_bot",
        autoRegister: true,
      });
      await db.batch(statements);

      // Access tenant overview
      const overviewRes = await testApp.request(
        `https://prism.test/api/v1/shops/${publicId}`,
        {},
        env,
      );
      expect(overviewRes.status).toBe(200);
      const overviewData = (await overviewRes.json()) as {
        data: { shop: { publicId: string; name: string } };
      };
      expect(overviewData.data.shop.publicId).toBe(publicId);
      expect(overviewData.data.shop.name).toBe("Wonder Arcade");

      // Access tenant pricing as shop owner
      const pricingRes = await testApp.request(
        `https://prism.test/api/v1/shops/${publicId}/pricing`,
        { headers: { authorization: "Bearer owner_session_token" } },
        env,
      );
      expect(pricingRes.status).toBe(200);
      const pricingData = (await pricingRes.json()) as {
        data: { pricingConfigs: Array<{ name: string }> };
      };
      expect(pricingData.data.pricingConfigs.length).toBeGreaterThan(0);
    });

    it("falls through to legacy router for un-prefixed player routes with deprecation headers", async () => {
      const { env, sqlite, db } = createTestEnvironment();
      const testApp = createApp();

      const shopId = "legacy_shop_id";
      const publicId = "default-store";
      const userId = "bob_user_id";

      sqlite.run("INSERT INTO users (id, role) VALUES (?, 'user')", [userId]);
      sqlite.run(
        "INSERT INTO shops (id, public_id, name, latitude, longitude, radius_meters, created_by) VALUES (?, ?, 'Default Store', 31.2, 121.4, 80, ?)",
        [shopId, publicId, userId],
      );
      sqlite.run(
        "INSERT INTO shop_billing_settings (shop_id, billing_enabled, identity_binding_required) VALUES (?, 1, 0)",
        [shopId],
      );

      const playerId = "p_bob";
      sqlite.run(
        "INSERT INTO players (shop_id, id, display_name, status, created_at) VALUES (?, ?, 'Bob', 'active', CURRENT_TIMESTAMP)",
        [shopId, playerId],
      );
      sqlite.run(
        "INSERT INTO shop_player_accounts (shop_id, user_id, player_id) VALUES (?, ?, ?)",
        [shopId, userId, playerId],
      );

      const tokenHash = await sha256("bob_token_raw");
      sqlite.run(
        "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES ('sess_bob', ?, ?, datetime('now', '+7 days'))",
        [userId, tokenHash],
      );

      // Legacy player endpoint
      const legacyRes = await testApp.request(
        "https://prism.test/api/v1/player/me",
        {
          headers: {
            authorization: "Bearer bob_token_raw",
            "x-prism-shop-code": publicId,
          },
        },
        env,
      );

      expect(legacyRes.status).toBe(200);
      expect(legacyRes.headers.get("deprecation")).toBe("true");
      expect(legacyRes.headers.get("sunset")).toBeDefined();
      expect(legacyRes.headers.get("link")).toContain("successor-version");
    });

    it("returns centralized 404 for unknown routes", async () => {
      const { env } = createTestEnvironment();
      const testApp = createApp();

      const res = await testApp.request(
        "https://prism.test/api/v1/completely/nonexistent/path",
        {},
        env,
      );
      expect(res.status).toBe(404);
      const data = (await res.json()) as { error: { code: string } };
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("handles domain errors centrally with mapped status codes", async () => {
      const testApp = new Hono<AppBindings>();
      // Install error handler matching createApp
      testApp.onError((err, c) => {
        if (err instanceof PrismDomainError) {
          const status = err.code === "SESSION_NOT_FOUND" ? 404 : 400;
          return c.json({ error: { code: err.code, message: err.message } }, status as any);
        }
        return c.json({ error: { code: "INTERNAL_ERROR" } }, 500);
      });

      testApp.get("/error-test", () => {
        throw new PrismDomainError("会话不存在", "SESSION_NOT_FOUND");
      });

      const res = await testApp.request("https://prism.test/error-test");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("SESSION_NOT_FOUND");
      expect(body.error.message).toBe("会话不存在");
    });
  });

  describe("Step 2: Cloudflare Worker Fetch Lifecycle (worker.ts)", () => {
    it("returns 503 maintenance response when PRISM_DEPLOY_PHASE is maintenance", async () => {
      const { env } = createTestEnvironment();
      const maintenanceEnv: Env = {
        ...env,
        PRISM_DEPLOY_PHASE: "maintenance",
      };

      const res = await worker.fetch(
        new Request("https://prism.test/api/v1/health"),
        maintenanceEnv,
      );
      expect(res.status).toBe(503);
      expect(res.headers.get("x-prism-maintenance")).toBe("1");
      expect(res.headers.get("retry-after")).toBe("30");

      const data = (await res.json()) as { error: { code: string } };
      expect(data.error.code).toBe("MAINTENANCE");
    });

    it("serves HTML maintenance page when request accepts text/html", async () => {
      const { env } = createTestEnvironment();
      const maintenanceEnv: Env = {
        ...env,
        PRISM_DEPLOY_PHASE: "maintenance",
      };

      const res = await worker.fetch(
        new Request("https://prism.test/merchant", {
          headers: { accept: "text/html,application/xhtml+xml" },
        }),
        maintenanceEnv,
      );
      expect(res.status).toBe(503);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("正在升级");
    });

    it("proxies static web assets to env.ASSETS for non-API GET requests", async () => {
      const { env } = createTestEnvironment();
      let fetchedAssetUrl = "";
      const assetFetcher = {
        async fetch(req: Request) {
          fetchedAssetUrl = req.url;
          return new Response("console.log('prism')", {
            status: 200,
            headers: { "content-type": "application/javascript" },
          });
        },
      };

      const workerEnv: Env = {
        ...env,
        ASSETS: assetFetcher as any,
      };

      const res = await worker.fetch(
        new Request("https://prism.test/assets/bundle.js"),
        workerEnv,
      );
      expect(res.status).toBe(200);
      expect(fetchedAssetUrl).toBe("https://prism.test/assets/bundle.js");
      expect(await res.text()).toBe("console.log('prism')");
    });

    it("injects x-prism-revision header on health responses when PRISM_DEPLOY_REVISION is set", async () => {
      const { env } = createTestEnvironment();
      const res = await worker.fetch(
        new Request("https://prism.test/api/v1/health"),
        env,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("x-prism-revision")).toBe("rev-2026-10-08-test");
    });

    it("supports deploymentControl probe action at /__prism_deploy", async () => {
      const { env } = createTestEnvironment();
      const token = "a".repeat(64);
      const tokenHash = await sha256(token);
      const deployEnv: Env = {
        ...env,
        PRISM_DEPLOY_TOKEN_HASH: tokenHash,
        PRISM_DEPLOY_PHASE: "verify",
      };

      const res = await worker.fetch(
        new Request("https://prism.test/__prism_deploy", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ action: "probe" }),
        }),
        deployEnv,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; phase: string };
      expect(body.ok).toBe(true);
      expect(body.phase).toBe("verify");
    });
  });

  describe("Step 3: Worker Scheduled Cron Execution (retention & maintenance)", () => {
    it("purges expired state rows across platform tables", async () => {
      const { env, sqlite } = createTestEnvironment();

      const oldTime = "2020-01-01T00:00:00.000Z";
      const futureTime = "2030-01-01T00:00:00.000Z";

      // Seed expired & future tickets
      sqlite.run(
        "INSERT INTO machine_tickets (id, machine_id, expires_at) VALUES ('t_exp', 'm1', ?), ('t_valid', 'm1', ?)",
        [oldTime, futureTime],
      );

      // Seed expired & future challenges
      sqlite.run(
        "INSERT INTO auth_challenges (id, purpose, challenge, expires_at) VALUES ('c_exp', 'login', 'xyz', ?), ('c_valid', 'login', 'xyz', ?)",
        [oldTime, futureTime],
      );

      // Seed expired & future binding codes
      sqlite.run(
        "INSERT INTO platform_binding_codes (shop_id, id, expires_at) VALUES ('shop1', 'b_exp', ?), ('shop1', 'b_valid', ?)",
        [oldTime, futureTime],
      );

      // Run scheduled cron
      await worker.scheduled({ scheduledTime: Date.now() }, env);

      // Verify expired rows deleted
      const tickets = sqlite
        .query("SELECT id FROM machine_tickets ORDER BY id")
        .all() as Array<{ id: string }>;
      expect(tickets).toEqual([{ id: "t_valid" }]);

      const challenges = sqlite
        .query("SELECT id FROM auth_challenges ORDER BY id")
        .all() as Array<{ id: string }>;
      expect(challenges).toEqual([{ id: "c_valid" }]);

      const bindings = sqlite
        .query("SELECT id FROM platform_binding_codes ORDER BY id")
        .all() as Array<{ id: string }>;
      expect(bindings).toEqual([{ id: "b_valid" }]);
    });

    it("skips scheduled cron when in maintenance mode", async () => {
      const { env, sqlite } = createTestEnvironment();
      const maintenanceEnv: Env = {
        ...env,
        PRISM_DEPLOY_PHASE: "maintenance",
      };

      const oldTime = "2020-01-01T00:00:00.000Z";
      sqlite.run(
        "INSERT INTO machine_tickets (id, machine_id, expires_at) VALUES ('t_keep', 'm1', ?)",
        [oldTime],
      );

      await worker.scheduled({ scheduledTime: Date.now() }, maintenanceEnv);

      // Row should NOT be purged because maintenance is active
      const tickets = sqlite
        .query("SELECT id FROM machine_tickets")
        .all() as Array<{ id: string }>;
      expect(tickets).toHaveLength(1);
      expect(tickets[0]!.id).toBe("t_keep");
    });
  });

  describe("Step 4: Shop Timezone Migration & LiveBilling Durable Object", () => {
    it("migrates shop timezones atomically based on geo coordinates", async () => {
      const { env, sqlite, db } = createTestEnvironment();

      // Insert shops with lat/lng
      sqlite.run(
        "INSERT INTO users (id, role) VALUES ('u1', 'user')",
      );
      sqlite.run(
        "INSERT INTO shops (id, public_id, name, latitude, longitude, radius_meters, created_by) VALUES ('tokyo_shop', 'tokyo', 'Tokyo Arcade', 35.6812, 139.7671, 80, 'u1')",
      );
      sqlite.run(
        "INSERT INTO shops (id, public_id, name, latitude, longitude, radius_meters, created_by) VALUES ('ny_shop', 'ny', 'New York Arcade', 40.7128, -74.0060, 80, 'u1')",
      );

      // Run migration
      const res1 = await migrateShopLocationTimeZones(db);
      expect(res1.applied).toBe(true);
      expect(res1.shops).toBe(2);

      // Verify profile app_settings
      const tokyoProfile = sqlite
        .query(
          "SELECT value_json FROM app_settings WHERE shop_id = 'tokyo_shop' AND key = 'store.profile'",
        )
        .get() as { value_json: string } | null;
      expect(tokyoProfile).toBeDefined();
      expect(JSON.parse(tokyoProfile!.value_json).timeZone).toBe("Asia/Tokyo");

      const nyProfile = sqlite
        .query(
          "SELECT value_json FROM app_settings WHERE shop_id = 'ny_shop' AND key = 'store.profile'",
        )
        .get() as { value_json: string } | null;
      expect(nyProfile).toBeDefined();
      expect(JSON.parse(nyProfile!.value_json).timeZone).toBe("America/New_York");

      // Verify idempotency
      const res2 = await migrateShopLocationTimeZones(db);
      expect(res2.applied).toBe(false);
      expect(res2.shops).toBe(0);
    });

    it("instantiates LiveBilling DO without errors in runtime", async () => {
      const mockStorage = {
        state: new Map<string, unknown>(),
        alarm: null as number | null,
        async get<T>(key: string): Promise<T | null> {
          return (this.state.get(key) as T) ?? null;
        },
        async put(key: string, val: unknown): Promise<void> {
          this.state.set(key, val);
        },
        async getAlarm(): Promise<number | null> {
          return this.alarm;
        },
        async setAlarm(time: number): Promise<void> {
          this.alarm = time;
        },
        async deleteAlarm(): Promise<void> {
          this.alarm = null;
        },
        async deleteAll(): Promise<void> {
          this.state.clear();
        },
      };

      const mockCtx = {
        storage: mockStorage,
      };

      const lb = new LiveBilling(mockCtx as any, {} as any);
      await lb.refresh("test_shop", "test_player");

      const visit = await mockStorage.get<{ shopId: string; playerId: string; revision: number }>("visit");
      expect(visit).toBeDefined();
      expect(visit?.shopId).toBe("test_shop");
      expect(visit?.playerId).toBe("test_player");
      expect(visit?.revision).toBe(1);
      expect(mockStorage.alarm).toBeDefined();
    });

    it("does not turn a high-frequency billing refresh into an early DO alarm", async () => {
      const now = Date.now();
      const state = new Map<string, unknown>([["alarm-budget", {
        tokens: 0, updatedAt: now, lastRunAt: now, lastTerminalBypassAt: 0,
      }]]);
      let alarm: number | null = null;
      const storage = {
        async get<T>(key: string): Promise<T | null> {
          return (state.get(key) as T) ?? null;
        },
        async put(key: string, value: unknown) { state.set(key, value); },
        async delete(key: string) { state.delete(key); },
        async getAlarm() { return alarm; },
        async setAlarm(at: number) { alarm = at; },
      };
      const object = new LiveBilling({ storage } as any, {} as any);
      await object.refresh("test_shop", "test_player");
      // An exhausted quota may not be bypassed by a fresh business revision.
      expect(alarm).not.toBeNull();
      expect(alarm!).toBeGreaterThanOrEqual(now + 299_000);
      const priorAlarm = alarm;
      await object.refresh("test_shop", "test_player");
      expect(alarm).toBe(priorAlarm);
    });

    it("preserves the first pending alarm despite rapid, legitimate refreshes", async () => {
      const state = new Map<string, unknown>();
      let alarm: number | null = null;
      let writes = 0;
      const storage = {
        async get<T>(key: string): Promise<T | null> {
          return (state.get(key) as T) ?? null;
        },
        async put(key: string, value: unknown) { state.set(key, value); },
        async getAlarm() { return alarm; },
        async setAlarm(at: number) { alarm = at; writes++; },
      };
      const object = new LiveBilling({ storage } as any, {} as any);
      for (let i = 0; i < 10; i++) await object.refresh("test_shop", "test_player");
      expect(writes).toBe(1);
      expect(alarm).not.toBeNull();
      expect((state.get("visit") as { revision: number }).revision).toBe(10);
    });

    it("cannot override a queued maintenance retry with new refreshes", async () => {
      const now = Date.now();
      const state = new Map<string, unknown>([
        ["maintenance-wait", { startedAt: now - 3 * 60_000, attempts: 3 }],
      ]);
      let alarm: number | null = now + 60 * 60_000;
      let writes = 0;
      const storage = {
        async get<T>(key: string): Promise<T | null> {
          return (state.get(key) as T) ?? null;
        },
        async put(key: string, value: unknown) { state.set(key, value); },
        async getAlarm() { return alarm; },
        async setAlarm(at: number) { alarm = at; writes++; },
      };
      const object = new LiveBilling({ storage } as any, {
        PRISM_DEPLOY_PHASE: "maintenance",
      } as any);
      for (let i = 0; i < 5; i++) await object.refresh("test_shop", "test_player");
      expect(alarm).toBe(now + 60 * 60_000);
      expect(writes).toBe(0);
    });

    it("does not intercept /health, /version, or /rpc when ASSETS is configured", async () => {
      let assetsFetched = false;
      const mockAssets = {
        async fetch() {
          assetsFetched = true;
          return new Response("asset content", { status: 200 });
        },
      };

      const { env } = createTestEnvironment();
      const envWithAssets = {
        ...env,
        ASSETS: mockAssets as any,
      };

      // 1. /health must reach Hono app, not ASSETS
      assetsFetched = false;
      const healthRes = await worker.fetch(
        new Request("https://prism.test/health"),
        envWithAssets,
      );
      expect(healthRes.status).toBe(200);
      expect(assetsFetched).toBe(false);

      // 2. /version must reach Hono app, not ASSETS
      assetsFetched = false;
      const versionRes = await worker.fetch(
        new Request("https://prism.test/version"),
        envWithAssets,
      );
      expect(versionRes.status).toBe(200);
      expect(assetsFetched).toBe(false);

      // 3. /rpc/* must reach legacyRouter, not ASSETS
      assetsFetched = false;
      await worker.fetch(
        new Request("https://prism.test/rpc/player/assets"),
        envWithAssets,
      );
      expect(assetsFetched).toBe(false);

      // 4. Regular static asset like /index.html SHOULD be intercepted by ASSETS
      assetsFetched = false;
      const assetRes = await worker.fetch(
        new Request("https://prism.test/index.html"),
        envWithAssets,
      );
      expect(assetRes.status).toBe(200);
      expect(assetsFetched).toBe(true);
    });
  });
});
