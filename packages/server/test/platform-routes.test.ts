import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sqliteSchema } from "@prism/storage-sql";
import type { D1BoundStatementLike, D1DatabaseLike, SqlValue } from "@prism/adapter-d1";
import type { AppBindings, Env } from "../src/bindings.js";
import { attachUser } from "../src/middleware/auth.js";
import { sha256 } from "../src/crypto.js";
import { authRouter } from "../src/routes/platform/auth.js";
import { passkeysRouter } from "../src/routes/platform/passkeys.js";
import { userRouter } from "../src/routes/platform/user.js";
import { createApp } from "../src/app.js";
import { shopsRouter } from "../src/routes/platform/shops.js";
import { healthRouter } from "../src/routes/system/health.js";
import { versionRouter } from "../src/routes/system/version.js";
import { serveWebAssets, isAssetEligiblePath } from "../src/routes/web-assets.js";

class InMemoryD1Database implements D1DatabaseLike {
  constructor(private readonly db: Database) {}

  prepare(sql: string) {
    const db = this.db;
    return {
      bind(...values: SqlValue[]) {
        return {
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
        };
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

function createTestEnvironment(): { db: D1DatabaseLike; sqlite: Database; env: Env; app: Hono<AppBindings> } {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = OFF;");
  for (const statement of sqliteSchema) {
    sqlite.run(statement);
  }

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
      id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS shop_staff_accounts (
      shop_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      staff_id TEXT NOT NULL,
      PRIMARY KEY (shop_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS machine_tickets (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY,
      public_id TEXT,
      shop_id TEXT NOT NULL,
      name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL DEFAULT 'machine',
      aliases_json TEXT NOT NULL DEFAULT '[]', hinata_url_encrypted TEXT DEFAULT '',
      resource_group_id TEXT, pricing_config_override_id TEXT,
      capacity INTEGER NOT NULL DEFAULT 0, occupancy_minutes INTEGER NOT NULL DEFAULT 15
    );
    CREATE TABLE IF NOT EXISTS device_capabilities (
      shop_id TEXT NOT NULL, device_id TEXT NOT NULL, capability TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}', secret_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT, updated_at TEXT,
      PRIMARY KEY (shop_id, device_id, capability)
    );
    CREATE TABLE IF NOT EXISTS resource_groups (
      shop_id TEXT NOT NULL,
      id TEXT NOT NULL,
      PRIMARY KEY (shop_id, id)
    );
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS player_operations (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS machine_login_events (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL
    );
  `);

  const db = new InMemoryD1Database(sqlite);
  const env: Env = {
    DB: db,
    APP_ORIGIN: "https://prism.test",
    PRISM_DEPLOY_REVISION: "rev-test-123",
  };

  const app = new Hono<AppBindings>();
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    return c.json({ error: { message: err.message } }, 500);
  });

  app.use("*", attachUser);

  app.route("/api/v1/auth", authRouter);
  app.route("/api/v1/user", userRouter);
  app.route("/api/v1", userRouter);
  app.route("/api/v1/shops", shopsRouter);
  app.route("/api/v1/merchant/shops", shopsRouter);
  app.route("/api/v1/health", healthRouter);
  app.route("/health", healthRouter);
  app.route("/api/v1/version", versionRouter);
  app.route("/version", versionRouter);

  return { db, sqlite, env, app };
}

// Test-only fixture: simulate a user already authenticated through MuNET.
// Never issue platform sessions via an unauthenticated username-only HTTP route.
async function authenticatedTestUser(
  env: Env,
  username: string,
  displayName = username,
): Promise<string> {
  const userId = crypto.randomUUID();
  const token = `test-session-${crypto.randomUUID()}`;
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, role) VALUES (?, 'user')").bind(userId),
    env.DB.prepare(
      "INSERT INTO auth_identities (id, user_id, provider, provider_subject, username, display_name) VALUES (?, ?, 'munet', ?, ?, ?)",
    ).bind(crypto.randomUUID(), userId, username, username, displayName),
    env.DB.prepare(
      "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), userId, await sha256(token), expiry),
  ]);
  return `arcadelink_session=${token}`;
}

describe("Platform & System Routes", () => {
  let env: Env;
  let app: Hono<AppBindings>;
  let sqlite: Database;

  beforeEach(() => {
    const ctx = createTestEnvironment();
    env = ctx.env;
    app = ctx.app;
    sqlite = ctx.sqlite;
  });

  describe("System Routes: Health & Version", () => {
    it("GET /health returns healthy status and service name", async () => {
      const res = await app.request("https://prism.test/health", {}, env);
      expect(res.status).toBe(200);
      const data = await res.json() as { ok: boolean; service: string; status: string };
      expect(data.ok).toBe(true);
      expect(data.service).toBe("prism-api");
      expect(data.status).toBe("healthy");
      expect(res.headers.get("x-prism-revision")).toBe("rev-test-123");
    });

    it("GET /api/v1/health also returns healthy status", async () => {
      const res = await app.request("https://prism.test/api/v1/health", {}, env);
      expect(res.status).toBe(200);
      const data = await res.json() as { ok: boolean };
      expect(data.ok).toBe(true);
    });

    it("GET /version and /api/v1/version return version info", async () => {
      const res1 = await app.request("https://prism.test/version", {}, env);
      expect(res1.status).toBe(200);
      const data1 = await res1.json() as { service: string; version: string; revision: string };
      expect(data1.service).toBe("prism-api");
      expect(data1.version).toBe("1.0.0");
      expect(data1.revision).toBe("rev-test-123");

      const res2 = await app.request("https://prism.test/api/v1/version", {}, env);
      expect(res2.status).toBe(200);
      const data2 = await res2.json() as { service: string };
      expect(data2.service).toBe("prism-api");
    });
  });

  describe("Platform Auth: verified sessions only", () => {
    it("does not expose username-only platform login or registration", async () => {
      // Even an existing username must not create an authenticated session.
      await authenticatedTestUser(env, "admin");
      // Check both the isolated router fixture and the actual deployed app,
      // including its legacy fallback routes.
      for (const targetApp of [app, createApp()]) {
        for (const route of ["login", "register"]) {
          const res = await targetApp.request(
            `https://prism.test/api/v1/auth/${route}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ username: "admin" }),
            },
            env,
          );
          expect(res.status).toBe(404);
          expect(res.headers.get("set-cookie")).toBeNull();
        }
      }
    });

    it("keeps verified session inspection and logout working", async () => {
      const sessionCookie = await authenticatedTestUser(env, "charlie");
      const meBefore = await app.request(
        "https://prism.test/api/v1/user/me",
        { headers: { cookie: sessionCookie } },
        env,
      );
      expect((await meBefore.json() as { user: { username: string } }).user.username).toBe("charlie");

      const logout = await app.request(
        "https://prism.test/api/v1/auth/logout",
        { method: "POST", headers: { cookie: sessionCookie } },
        env,
      );
      expect(logout.status).toBe(200);

      const meAfter = await app.request(
        "https://prism.test/api/v1/user/me",
        { headers: { cookie: sessionCookie } },
        env,
      );
      expect((await meAfter.json() as { user: null }).user).toBeNull();
    });
  });

  describe("Platform Passkeys: Options & Challenges", () => {
    it("generates authentication options challenge", async () => {
      const res = await app.request(
        "https://prism.test/api/v1/auth/passkey/options",
        {},
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as { challenge: string; rpId: string };
      expect(typeof data.challenge).toBe("string");
      expect(data.challenge.length).toBeGreaterThan(10);
      expect(data.rpId).toBe("prism.test");

      const cookie = res.headers.get("set-cookie");
      expect(cookie).toContain("arcadelink_passkey_challenge=");
    });

    it("requires user for registration options", async () => {
      const res = await app.request(
        "https://prism.test/api/v1/auth/passkey/register/options",
        {},
        env,
      );
      expect(res.status).toBe(401);
    });

    it("generates registration options for authenticated user", async () => {
      const sessionCookie = await authenticatedTestUser(env, "dave");

      const res = await app.request(
        "https://prism.test/api/v1/auth/passkey/register/options",
        { headers: { cookie: sessionCookie } },
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as {
        challenge: string;
        rp: { id: string; name: string };
        user: { name: string; displayName: string };
      };
      expect(data.challenge).toBeDefined();
      expect(data.rp.name).toBe("PRiSM");
      expect(data.user.name).toBe("dave");
    });
  });

  describe("User Profile & Account", () => {
    it("GET /api/v1/account lists user identities and passkeys", async () => {
      const sessionCookie = await authenticatedTestUser(env, "eve", "Eve Tester");

      const res = await app.request(
        "https://prism.test/api/v1/account",
        { headers: { cookie: sessionCookie } },
        env,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as { identities: Array<{ username: string; displayName: string }>; passkeys: Array<unknown> };
      expect(data.identities).toHaveLength(1);
      expect(data.identities[0]!.username).toBe("eve");
      expect(data.identities[0]!.displayName).toBe("Eve Tester");
      expect(data.passkeys).toHaveLength(0);
    });
  });

  describe("Production app route contract", () => {
    it("serves the account overview instead of the user profile at /api/v1/account", async () => {
      // Unlike the lightweight router fixture, this uses the actual deployed
      // route ordering and { data } envelope, which previously hid the regression.
      const cookie = await authenticatedTestUser(env, "route-account", "Account Route");
      const productionApp = createApp();

      const accountResponse = await productionApp.request(
        "https://prism.test/api/v1/account",
        { headers: { cookie } },
        env,
      );
      expect(accountResponse.status).toBe(200);
      const account = await accountResponse.json() as {
        data?: { identities?: Array<{ username: string; displayName: string }>; passkeys?: unknown[]; user?: unknown };
      };
      expect(account.data?.identities).toHaveLength(1);
      expect(account.data?.identities?.[0]?.username).toBe("route-account");
      expect(account.data?.identities?.[0]?.displayName).toBe("Account Route");
      expect(account.data?.passkeys).toEqual([]);
      expect(account.data?.user).toBeUndefined();

      const meResponse = await productionApp.request(
        "https://prism.test/api/v1/me",
        { headers: { cookie } },
        env,
      );
      expect(meResponse.status).toBe(200);
      const me = await meResponse.json() as { data?: { user?: { username: string } } };
      expect(me.data?.user?.username).toBe("route-account");

      const unauthenticated = await productionApp.request(
        "https://prism.test/api/v1/account", {}, env,
      );
      expect(unauthenticated.status).toBe(401);
      const error = await unauthenticated.json() as { error?: { code: string } };
      expect(error.error?.code).toBe("AUTHENTICATION_REQUIRED");
    });
  });

  describe("Platform Shops: Creation, Listing, Updating, Deletion", () => {
    let ownerCookie: string;
    let otherCookie: string;

    beforeEach(async () => {
      ownerCookie = await authenticatedTestUser(env, "shop-owner");
      otherCookie = await authenticatedTestUser(env, "other-user");
    });

    it("requires shop-owner role to manage members and protects the last owner", async () => {
      const ownerId = (await env.DB.prepare(
        "SELECT user_id FROM auth_identities WHERE provider='munet' AND provider_subject='shop-owner'",
      ).bind().first<{ user_id: string }>())!.user_id;
      const staffId = (await env.DB.prepare(
        "SELECT user_id FROM auth_identities WHERE provider='munet' AND provider_subject='other-user'",
      ).bind().first<{ user_id: string }>())!.user_id;
      const shopId = "security-shop";
      await env.DB.batch([
        env.DB.prepare("INSERT INTO shops (id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES (?,?,?,0,0,80,?)")
          .bind(shopId,shopId,"Security Shop",ownerId),
        env.DB.prepare("INSERT INTO shop_members(id,shop_id,user_id,role) VALUES (?,?,?,'owner')")
          .bind("member-owner",shopId,ownerId),
        env.DB.prepare("INSERT INTO shop_members(id,shop_id,user_id,role) VALUES (?,?,?,'staff')")
          .bind("member-staff",shopId,staffId),
      ]);
      const productionApp = createApp();
      const post = (cookie: string, role: string) => productionApp.request(
        "https://prism.test/api/v1/merchant/shop-members",
        { method: "POST", headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ shopId, user: "other-user", role }) }, env,
      );

      expect((await post(otherCookie, "owner")).status).toBe(403);
      expect((await productionApp.request(
        "https://prism.test/api/v1/merchant/shop-members/member-owner",
        { method: "DELETE", headers: { cookie: otherCookie } }, env,
      )).status).toBe(403);

      // Last owner cannot give up ownership by changing their own role.
      const demote = await productionApp.request(
        "https://prism.test/api/v1/merchant/shop-members",
        { method: "POST", headers: { cookie: ownerCookie, "content-type": "application/json" },
          body: JSON.stringify({ shopId, user: "shop-owner", role: "staff" }) }, env,
      );
      expect(demote.status).toBe(409);
      expect((await post(ownerCookie, "owner")).status).toBe(200);
    });

    it("prevents platform admins from downgrading their own session", async () => {
      const ownerId = (await env.DB.prepare(
        "SELECT user_id FROM auth_identities WHERE provider='munet' AND provider_subject='shop-owner'",
      ).bind().first<{ user_id: string }>())!.user_id;
      await env.DB.prepare("UPDATE users SET role='admin' WHERE id=?").bind(ownerId).run();
      const res = await createApp().request("https://prism.test/api/v1/admin/users/role", {
        method: "POST", headers: { cookie: ownerCookie, "content-type": "application/json" },
        body: JSON.stringify({ userId: ownerId, role: "user" }),
      }, env);
      expect(res.status).toBe(409);
    });

    it("requires authentication to create a shop", async () => {
      const res = await app.request(
        "https://prism.test/api/v1/shops",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Arcade Central",
            latitude: 31.23,
            longitude: 121.47,
          }),
        },
        env,
      );
      expect(res.status).toBe(401);
    });

    it("lets a new shop's first binding create the player, with or without billing", async () => {
      for (const billingSetup of [undefined, {
        paidName: "余额", freeName: "赠送余额", hourlyPrice: 12, graceMinutes: 5, dailyCap: 60,
      }]) {
        const res = await app.request("https://prism.test/api/v1/shops", {
          method: "POST",
          headers: { "content-type": "application/json", cookie: ownerCookie },
          body: JSON.stringify({ name: "Default Shop", latitude: 31.23, longitude: 121.47, billingSetup }),
        }, env);
        expect(res.status).toBe(201);
        const { shop } = await res.json() as { shop: { id: string } };
        const row = await env.DB.prepare(
          "SELECT json_array_length(entry_pricing_ids_json) AS plans, auto_register, identity_binding_required FROM shop_billing_settings WHERE shop_id=?",
        ).bind(shop.id).first();
        // Billing setup gives the default group a plan; without it every resource is free.
        expect(row).toEqual({ plans: billingSetup ? 1 : 0, auto_register: 1, identity_binding_required: 1 });
      }
    });

    it("opens a front-desk shop with the cashier already enabled", async () => {
      const res = await app.request("https://prism.test/api/v1/shops", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookie },
        body: JSON.stringify({ name: "Desk Shop", latitude: 31.23, longitude: 121.47, billingSetup: {
          paidName: "余额", freeName: "赠送余额", hourlyPrice: 12, graceMinutes: 5, dailyCap: 60, cashierEnabled: true,
        } }),
      }, env);
      expect(res.status).toBe(201);
      const { shop } = await res.json() as { shop: { id: string } };
      const row = await env.DB.prepare("SELECT value_json FROM app_settings WHERE shop_id=? AND key='cashier.settings'").bind(shop.id).first();
      expect(row).toEqual({ value_json: '{"enabled":true}' });
    });

    it("creates a shop with billing setup and bot integration token", async () => {
      const res = await app.request(
        "https://prism.test/api/v1/shops",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: ownerCookie,
          },
          body: JSON.stringify({
            name: "Neon Arcade",
            latitude: 31.2304,
            longitude: 121.4737,
            radiusMeters: 100,
            billingSetup: {
              paidName: "代币",
              freeName: "活动币",
              hourlyPrice: 15,
              graceMinutes: 5,
              dailyCap: 80,
              botContact: "@arcade_bot",
              autoRegister: true,
              createBotToken: true,
            },
          }),
        },
        env,
      );

      expect(res.status).toBe(201);
      const data = await res.json() as {
        botToken: string | null;
        shop: { id: string; publicId: string; name: string; timeZone: string; radiusMeters: number };
      };
      expect(data.shop.name).toBe("Neon Arcade");
      expect(data.shop.publicId).toBeDefined();
      expect(data.shop.timeZone).toBe("Asia/Shanghai");
      expect(data.shop.radiusMeters).toBe(100);
      expect(data.botToken).toMatch(/^prism_integration_/);
      // The bot is a resource from the start, in the default group, so the shop
      // sees it before it ever connects and its credential names one resource.
      const bot = sqlite.query("SELECT m.id, m.resource_group_id AS grp FROM machines m JOIN device_capabilities c ON c.device_id=m.id AND c.capability='bot'").get() as { id: string; grp: string | null };
      expect(bot.grp).toBeNull();

      // Verify owner can list the shop
      const listRes = await app.request(
        "https://prism.test/api/v1/shops",
        { headers: { cookie: ownerCookie } },
        env,
      );
      expect(listRes.status).toBe(200);
      const listData = await listRes.json() as { shops: Array<{ id: string; name: string }> };
      expect(listData.shops).toHaveLength(1);
      expect(listData.shops[0]!.name).toBe("Neon Arcade");

      // Verify other user does not see this shop
      const otherListRes = await app.request(
        "https://prism.test/api/v1/shops",
        { headers: { cookie: otherCookie } },
        env,
      );
      expect(otherListRes.status).toBe(200);
      const otherListData = await otherListRes.json() as { shops: Array<unknown> };
      expect(otherListData.shops).toHaveLength(0);
    });

    it("updates shop details", async () => {
      const createRes = await app.request(
        "https://prism.test/api/v1/shops",
        {
          method: "POST",
          headers: { "content-type": "application/json", cookie: ownerCookie },
          body: JSON.stringify({
            name: "Original Name",
            latitude: 35.6895,
            longitude: 139.6917,
          }),
        },
        env,
      );
      const created = await createRes.json() as { shop: { id: string } };

      const patchRes = await app.request(
        `https://prism.test/api/v1/shops/${created.shop.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json", cookie: ownerCookie },
          body: JSON.stringify({
            name: "Updated Name Tokyo",
            radiusMeters: 150,
          }),
        },
        env,
      );

      expect(patchRes.status).toBe(200);
      const patchData = await patchRes.json() as { shop: { name: string; radiusMeters: number; timeZone: string } };
      expect(patchData.shop.name).toBe("Updated Name Tokyo");
      expect(patchData.shop.radiusMeters).toBe(150);
      expect(patchData.shop.timeZone).toBe("Asia/Tokyo");
    });

    it("serves shop hero image bytes and supports ETag 304", async () => {
      const samplePng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const createRes = await app.request(
        "https://prism.test/api/v1/shops",
        {
          method: "POST",
          headers: { "content-type": "application/json", cookie: ownerCookie },
          body: JSON.stringify({
            name: "Hero Store",
            latitude: 30,
            longitude: 120,
            heroData: samplePng,
          }),
        },
        env,
      );
      const created = await createRes.json() as { shop: { publicId: string; heroUrl: string } };
      expect(created.shop.heroUrl).toBeDefined();

      const heroRes = await app.request(
        `https://prism.test/api/v1/shops/${created.shop.publicId}/hero`,
        {},
        env,
      );
      expect(heroRes.status).toBe(200);
      expect(heroRes.headers.get("content-type")).toBe("image/png");
      const etag = heroRes.headers.get("etag")!;
      expect(etag).toBeDefined();

      // If-None-Match test
      const notModifiedRes = await app.request(
        `https://prism.test/api/v1/shops/${created.shop.publicId}/hero`,
        { headers: { "if-none-match": etag } },
        env,
      );
      expect(notModifiedRes.status).toBe(304);
    });

    it("deletes a shop without business records, prevents non-owner deletion", async () => {
      const createRes = await app.request(
        "https://prism.test/api/v1/shops",
        {
          method: "POST",
          headers: { "content-type": "application/json", cookie: ownerCookie },
          body: JSON.stringify({
            name: "To Be Deleted",
            latitude: 30,
            longitude: 120,
          }),
        },
        env,
      );
      const created = await createRes.json() as { shop: { id: string } };

      // Non-owner cannot delete
      const forbidRes = await app.request(
        `https://prism.test/api/v1/shops/${created.shop.id}`,
        { method: "DELETE", headers: { cookie: otherCookie } },
        env,
      );
      expect(forbidRes.status).toBe(403);

      // Owner can delete
      const delRes = await app.request(
        `https://prism.test/api/v1/shops/${created.shop.id}`,
        { method: "DELETE", headers: { cookie: ownerCookie } },
        env,
      );
      expect(delRes.status).toBe(200);

      // Verify it's gone
      const getRes = await app.request(
        `https://prism.test/api/v1/shops/${created.shop.id}`,
        {},
        env,
      );
      expect(getRes.status).toBe(404);
    });
  });

  describe("Web Assets", () => {
    it("recognizes asset-eligible paths", () => {
      expect(isAssetEligiblePath("/index.html")).toBe(true);
      expect(isAssetEligiblePath("/assets/app.js")).toBe(true);
      expect(isAssetEligiblePath("/api/v1/health")).toBe(false);
      expect(isAssetEligiblePath("/callback")).toBe(false);
      expect(isAssetEligiblePath("/.well-known/apple")).toBe(false);
      expect(isAssetEligiblePath("/health")).toBe(false);
      expect(isAssetEligiblePath("/version")).toBe(false);
      expect(isAssetEligiblePath("/t/shop1/mach1")).toBe(false);
    });

    it("serves static assets via Fetcher when ASSETS is configured", async () => {
      const assetApp = new Hono<AppBindings>();
      assetApp.use("*", serveWebAssets());
      assetApp.get("/api/ping", (c) => c.text("pong"));

      const customEnv: Env = {
        ...env,
        ASSETS: {
          fetch: async (req: Request) => {
            const url = new URL(req.url);
            if (url.pathname === "/test.css") {
              return new Response("body { color: red; }", {
                headers: { "content-type": "text/css" },
              });
            }
            return new Response("Not Found", { status: 404 });
          },
        } as Fetcher,
      };

      const assetRes = await assetApp.request("https://prism.test/test.css", {}, customEnv);
      expect(assetRes.status).toBe(200);
      expect(await assetRes.text()).toBe("body { color: red; }");

      const apiRes = await assetApp.request("https://prism.test/api/ping", {}, customEnv);
      expect(apiRes.status).toBe(200);
      expect(await apiRes.text()).toBe("pong");
    });
  });
});
