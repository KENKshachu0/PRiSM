import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { sqliteSchema } from "@prism/storage-sql";
import type { D1BoundStatementLike, D1DatabaseLike, SqlValue } from "@prism/adapter-d1";
import type { AppBindings, Env } from "../src/bindings.js";
import {
  tenantMiddleware,
  getShop,
  getShopDeps,
  clearShopDependenciesCache,
  getOrCreateShopDependencies,
} from "../src/middleware/tenant.js";
import {
  responseTimeMiddleware,
  wrapApiResponse,
  projectApiTimes,
} from "../src/middleware/response-time.js";
import {
  corsMiddleware,
  allowedOrigins,
  assertAllowedOrigin,
} from "../src/middleware/cors.js";
import {
  attachUser,
  requireUser,
  optionalUser,
  requireAdmin,
  staffPrincipal,
  createSession,
} from "../src/middleware/auth.js";
import {
  enforceRateLimits,
  clearRateLimitMemory,
} from "../src/middleware/rate-limit.js";
import {
  checkLocation,
  checkShopLocation,
  clampShopRadius,
  haversineMeters,
} from "../src/middleware/geo.js";
import { sha256 } from "../src/crypto.js";

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
            db.run(sql, values);
            return { success: true };
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

function createTestContext(): { db: D1DatabaseLike; sqlite: Database; env: Env } {
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
    CREATE TABLE IF NOT EXISTS staff_users (
      shop_id TEXT NOT NULL,
      id TEXT NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'owner',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (shop_id, id)
    );
  `);

  const db = new InMemoryD1Database(sqlite);
  const env: Env = {
    DB: db,
    APP_ORIGIN: "https://prism.test",
    EXTRA_ALLOWED_ORIGINS: "https://admin.prism.test,https://player.prism.test",
    SESSION_SECRET: "secret-key",
  };

  return { db, sqlite, env };
}

describe("Middleware Test Suite", () => {
  beforeEach(() => {
    clearShopDependenciesCache();
    clearRateLimitMemory();
  });

  describe("Tenant Middleware", () => {
    it("resolves shop by public_id and injects shop and application dependencies", async () => {
      const { sqlite, env } = createTestContext();
      sqlite.run(
        "INSERT INTO shops (id, public_id, name, latitude, longitude, radius_meters, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["shop_uuid_1", "shanghai-hub", "Shanghai Hub", 31.23, 121.47, 100, "user_1"],
      );
      sqlite.run(
        "INSERT INTO shop_billing_settings (shop_id, billing_enabled, auto_register, checkin_geo, checkout_geo, machine_geo, entry_pricing_ids_json) VALUES (?, 1, 1, 1, 1, 1, ?)",
        ["shop_uuid_1", JSON.stringify(["entry_rule_1"])],
      );

      const app = new Hono<AppBindings>();
      app.use("/api/v1/shops/:shopCode/*", tenantMiddleware);
      app.get("/api/v1/shops/:shopCode/test", (c) => {
        const shop = getShop(c);
        const deps = getShopDeps(c);
        return c.json({
          shopId: shop.id,
          publicId: shop.public_id,
          shopName: shop.name,
          hasPlayerCommands: !!deps.playerCommands,
          hasPlayerQueries: !!deps.playerQueries,
          hasStaffOperations: !!deps.staffOperations,
          varShopId: c.var.shop?.id,
          varDepsOk: !!c.var.deps?.playerCommands,
          responseTimeZone: c.get("responseTimeZone"),
        });
      });

      const res = await app.fetch(
        new Request("https://prism.test/api/v1/shops/shanghai-hub/test"),
        env,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.shopId).toBe("shop_uuid_1");
      expect(data.publicId).toBe("shanghai-hub");
      expect(data.shopName).toBe("Shanghai Hub");
      expect(data.hasPlayerCommands).toBe(true);
      expect(data.hasPlayerQueries).toBe(true);
      expect(data.hasStaffOperations).toBe(true);
      expect(data.varShopId).toBe("shop_uuid_1");
      expect(data.varDepsOk).toBe(true);
      expect(data.responseTimeZone).toBe("Asia/Shanghai");
    });

    it("resolves shop by UUID", async () => {
      const { sqlite, env } = createTestContext();
      sqlite.run(
        "INSERT INTO shops (id, public_id, name, latitude, longitude, radius_meters, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["shop_uuid_2", "tokyo-hub", "Tokyo Hub", 35.67, 139.65, 80, "user_1"],
      );

      const app = new Hono<AppBindings>();
      app.use("/api/v1/shops/:shopCode/*", tenantMiddleware);
      app.get("/api/v1/shops/:shopCode/test", (c) => {
        const shop = getShop(c);
        return c.json({ shopId: shop.id });
      });

      const res = await app.fetch(
        new Request("https://prism.test/api/v1/shops/shop_uuid_2/test"),
        env,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.shopId).toBe("shop_uuid_2");
    });

    it("returns 404 for non-existent shop", async () => {
      const { env } = createTestContext();
      const app = new Hono<AppBindings>();
      app.use("/api/v1/shops/:shopCode/*", tenantMiddleware);
      app.get("/api/v1/shops/:shopCode/test", (c) => c.json({ ok: true }));

      const res = await app.fetch(
        new Request("https://prism.test/api/v1/shops/nonexistent-shop/test"),
        env,
      );
      expect(res.status).toBe(404);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBeDefined();
    });

    it("invalidates cached application dependencies when tenant settings change", async () => {
      const { sqlite, db } = createTestContext();
      sqlite.run(
        "INSERT INTO shops (id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('cache-updated','cache-updated','First',0,0,50,'u')",
      );
      const shop = {
        id: "cache-updated", public_id: "cache-updated", name: "First",
        latitude: 0, longitude: 0, radius_meters: 50,
        billing_enabled: 1, cashier_enabled: 0, auto_register: 0,
        identity_binding_required: 1, checkin_geo: 0, checkout_geo: 0, machine_geo: 0,
        bot_contact: "", time_zone: "Asia/Shanghai", hero_url: null,
      };
      const before = getOrCreateShopDependencies(db, shop);
      expect(getOrCreateShopDependencies(db, shop)).toBe(before);
      const after = getOrCreateShopDependencies(db, {
        ...shop, auto_register: 1, time_zone: "Asia/Tokyo",
      });
      expect(after).not.toBe(before);
    });

    it("reuses cached dependencies across requests for same shop", async () => {
      const { sqlite, env } = createTestContext();
      sqlite.run(
        "INSERT INTO shops (id, public_id, name, latitude, longitude, radius_meters, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["shop_cached", "cached-shop", "Cached Shop", 0, 0, 50, "user_1"],
      );

      let firstDeps: unknown;
      let secondDeps: unknown;

      const app = new Hono<AppBindings>();
      app.use("/api/v1/shops/:shopCode/*", tenantMiddleware);
      app.get("/api/v1/shops/:shopCode/first", (c) => {
        firstDeps = getShopDeps(c);
        return c.json({ ok: true });
      });
      app.get("/api/v1/shops/:shopCode/second", (c) => {
        secondDeps = getShopDeps(c);
        return c.json({ ok: true });
      });

      await app.fetch(new Request("https://prism.test/api/v1/shops/cached-shop/first"), env);
      await app.fetch(new Request("https://prism.test/api/v1/shops/cached-shop/second"), env);

      expect(firstDeps).toBeDefined();
      expect(secondDeps).toBeDefined();
      expect(firstDeps).toBe(secondDeps);
    });
  });

  describe("Response Time Projection Middleware", () => {
    it("intercepts JSON responses and projects UTC instants into shop local time", async () => {
      const app = new Hono<AppBindings>();
      app.use("/api/v1/*", responseTimeMiddleware);
      app.get("/api/v1/test", (c) => {
        c.set("responseTimeZone", "Asia/Shanghai");
        return c.json({
          startedAt: "2026-10-03T02:08:00.123Z",
          expires_at: "2026-10-03T02:08:00.123Z",
          name: "Test Event",
        });
      });

      const res = await app.fetch(new Request("https://prism.test/api/v1/test"));
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { startedAt: string; expires_at: string; name: string } };
      expect(body.data.startedAt).toBe("2026-10-03T10:08:00.123+08:00");
      expect(body.data.expires_at).toBe("2026-10-03T10:08:00.123+08:00");
      expect(body.data.name).toBe("Test Event");
    });

    it("preserves rule definitions and metadata without transforming them", async () => {
      const at = "2026-10-03T02:08:00.123Z";
      const payload = {
        startedAt: at,
        provider: {
          timeZone: "UTC",
          rules: [{ dateTimeRange: { start: at, end: at } }],
        },
        metadata: { originalAt: at },
      };

      const projected = projectApiTimes(payload, "Asia/Shanghai") as typeof payload;
      expect(projected.startedAt).toBe("2026-10-03T10:08:00.123+08:00");
      expect(projected.provider.rules[0]?.dateTimeRange.start).toBe(at);
      expect(projected.metadata.originalAt).toBe(at);
    });

    it("bypasses non-JSON and attachments", async () => {
      const content = JSON.stringify({ format: "prism-backup", startedAt: "2026-10-03T02:08:00Z" });
      const rawResponse = new Response(content, {
        headers: {
          "content-type": "application/json",
          "content-disposition": 'attachment; filename="backup.json"',
        },
      });

      const wrapped = await wrapApiResponse(rawResponse, "Asia/Shanghai");
      expect(await wrapped.text()).toBe(content);
    });
  });

  describe("CORS Security Middleware", () => {
    it("allows configured APP_ORIGIN with credentials", async () => {
      const { env } = createTestContext();
      const app = new Hono<AppBindings>();
      app.use("*", corsMiddleware);
      app.get("/test", (c) => c.json({ ok: true }));

      const res = await app.fetch(
        new Request("https://prism.test/test", {
          headers: { origin: "https://prism.test" },
        }),
        env,
      );

      expect(res.headers.get("access-control-allow-origin")).toBe("https://prism.test");
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    });

    it("allows extra configured origins from EXTRA_ALLOWED_ORIGINS", async () => {
      const { env } = createTestContext();
      const app = new Hono<AppBindings>();
      app.use("*", corsMiddleware);
      app.get("/test", (c) => c.json({ ok: true }));

      const res = await app.fetch(
        new Request("https://prism.test/test", {
          headers: { origin: "https://player.prism.test" },
        }),
        env,
      );

      expect(res.headers.get("access-control-allow-origin")).toBe("https://player.prism.test");
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    });

    it("does not reflect arbitrary origins", async () => {
      const { env } = createTestContext();
      const app = new Hono<AppBindings>();
      app.use("*", corsMiddleware);
      app.get("/test", (c) => c.json({ ok: true }));

      const res = await app.fetch(
        new Request("https://prism.test/test", {
          headers: { origin: "https://evil-attacker.com" },
        }),
        env,
      );

      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("blocks mutations from untrusted origins with 403", async () => {
      const { env } = createTestContext();
      const app = new Hono<AppBindings>();
      app.use("*", corsMiddleware);
      app.post("/test", (c) => c.json({ ok: true }));

      const res = await app.fetch(
        new Request("https://prism.test/test", {
          method: "POST",
          headers: {
            origin: "https://evil-attacker.com",
            "content-type": "application/json",
          },
          body: JSON.stringify({ data: "payload" }),
        }),
        env,
      );

      expect(res.status).toBe(403);
    });

    it("handles preflight OPTIONS request correctly", async () => {
      const { env } = createTestContext();
      const app = new Hono<AppBindings>();
      app.use("*", corsMiddleware);
      app.post("/test", (c) => c.json({ ok: true }));

      const res = await app.fetch(
        new Request("https://prism.test/test", {
          method: "OPTIONS",
          headers: {
            origin: "https://prism.test",
            "access-control-request-method": "POST",
          },
        }),
        env,
      );

      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://prism.test");
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    });
  });

  describe("Authentication Middleware", () => {
    it("attaches user from valid cookie session", async () => {
      const { sqlite, env } = createTestContext();
      const userId = "user_auth_1";
      sqlite.run("INSERT INTO users (id, role) VALUES (?, 'user')", [userId]);
      sqlite.run(
        "INSERT INTO auth_identities (id, user_id, provider, provider_subject, username, display_name) VALUES (?, ?, 'munet', 'subj1', 'player1', 'Player One')",
        ["id_1", userId],
      );

      const rawToken = "session_token_xyz_123";
      const tokenHash = await sha256(rawToken);
      const expiresAt = new Date(Date.now() + 86400000).toISOString();
      sqlite.run(
        "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
        ["session_1", userId, tokenHash, expiresAt],
      );

      const app = new Hono<AppBindings>();
      app.use("*", attachUser);
      app.get("/me", (c) => {
        const user = requireUser(c);
        return c.json({ id: user.id, username: user.username, role: user.role });
      });

      const res = await app.fetch(
        new Request("https://prism.test/me", {
          headers: { cookie: `arcadelink_session=${rawToken}` },
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.id).toBe(userId);
      expect(data.username).toBe("player1");
      expect(data.role).toBe("user");
    });

    it("attaches user from Authorization Bearer token", async () => {
      const { sqlite, env } = createTestContext();
      const userId = "user_bearer_1";
      sqlite.run("INSERT INTO users (id, role) VALUES (?, 'admin')", [userId]);
      sqlite.run(
        "INSERT INTO auth_identities (id, user_id, provider, provider_subject, username, display_name) VALUES (?, ?, 'munet', 'subj2', 'admin1', 'Admin One')",
        ["id_2", userId],
      );

      const rawToken = "bearer_token_abc_789";
      const tokenHash = await sha256(rawToken);
      const expiresAt = new Date(Date.now() + 86400000).toISOString();
      sqlite.run(
        "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
        ["session_2", userId, tokenHash, expiresAt],
      );

      const app = new Hono<AppBindings>();
      app.use("*", attachUser);
      app.get("/admin", (c) => {
        const user = requireAdmin(c);
        return c.json({ id: user.id, role: user.role });
      });

      const res = await app.fetch(
        new Request("https://prism.test/admin", {
          headers: { authorization: `Bearer ${rawToken}` },
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.id).toBe(userId);
      expect(data.role).toBe("admin");
    });

    it("rejects unauthenticated requests in requireUser with 401", async () => {
      const { env } = createTestContext();
      const app = new Hono<AppBindings>();
      app.use("*", attachUser);
      app.get("/protected", (c) => {
        requireUser(c);
        return c.json({ ok: true });
      });

      const res = await app.fetch(new Request("https://prism.test/protected"), env);
      expect(res.status).toBe(401);
    });

    it("rejects banned user with 403", async () => {
      const { sqlite, env } = createTestContext();
      const userId = "banned_user";
      sqlite.run(
        "INSERT INTO users (id, role, banned_at) VALUES (?, 'user', ?)",
        [userId, new Date().toISOString()],
      );
      sqlite.run(
        "INSERT INTO auth_identities (id, user_id, provider, provider_subject, username, display_name) VALUES (?, ?, 'munet', 'banned', 'banned1', 'Banned')",
        ["id_banned", userId],
      );

      const rawToken = "banned_token";
      const tokenHash = await sha256(rawToken);
      sqlite.run(
        "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
        ["session_banned", userId, tokenHash, new Date(Date.now() + 86400000).toISOString()],
      );

      const app = new Hono<AppBindings>();
      app.use("*", attachUser);
      app.get("/protected", (c) => {
        requireUser(c);
        return c.json({ ok: true });
      });

      const res = await app.fetch(
        new Request("https://prism.test/protected", {
          headers: { authorization: `Bearer ${rawToken}` },
        }),
        env,
      );
      expect(res.status).toBe(403);
    });

    it("resolves staff principal for shop member/staff", async () => {
      const { sqlite, env } = createTestContext();
      const userId = "owner_user";
      sqlite.run("INSERT INTO users (id, role) VALUES (?, 'user')", [userId]);
      sqlite.run(
        "INSERT INTO auth_identities (id, user_id, provider, provider_subject, username, display_name) VALUES (?, ?, 'munet', 'owner', 'owner1', 'Owner One')",
        ["id_owner", userId],
      );

      const shopId = "shop_member_test";
      sqlite.run(
        "INSERT INTO shops (id, public_id, name, latitude, longitude, radius_meters, created_by) VALUES (?, ?, ?, 0, 0, 80, ?)",
        [shopId, "owner-shop", "Owner Shop", userId],
      );
      sqlite.run("INSERT INTO shop_members (id, shop_id, user_id, role) VALUES ('mem_1', ?, ?, 'owner')", [shopId, userId]);

      const rawToken = "owner_token";
      const tokenHash = await sha256(rawToken);
      sqlite.run(
        "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES ('sess_owner', ?, ?, ?)",
        [userId, tokenHash, new Date(Date.now() + 86400000).toISOString()],
      );

      const app = new Hono<AppBindings>();
      app.use("*", attachUser);
      app.get("/staff-check", async (c) => {
        const principal = await staffPrincipal(c, {
          id: shopId,
          public_id: "owner-shop",
          name: "Owner Shop",
          latitude: 0,
          longitude: 0,
          radius_meters: 80,
          cashier_enabled: 0,
         
          auto_register: 1,
          identity_binding_required: 1,
          checkin_geo: 0,
          checkout_geo: 0,
          machine_geo: 0,
          bot_contact: "",
          time_zone: "Asia/Shanghai",
          hero_url: null,
        });
        return c.json(principal);
      });

      const res = await app.fetch(
        new Request("https://prism.test/staff-check", {
          headers: { authorization: `Bearer ${rawToken}` },
        }),
        env,
      );

      expect(res.status).toBe(200);
      const principal = await res.json() as Record<string, unknown>;
      expect(principal.role).toBe("staff");
      expect(principal.staffRole).toBe("owner");
    });
  });

  describe("Rate Limiting & Geo Middleware", () => {
    it("enforces in-memory rate limiting when Cloudflare binding is absent", async () => {
      const { env } = createTestContext();
      const app = new Hono<AppBindings>();
      app.get("/limited", async (c) => {
        await enforceRateLimits(c, [{ key: "test-client", limit: 3, windowSeconds: 60 }]);
        return c.json({ ok: true });
      });

      expect((await app.fetch(new Request("https://prism.test/limited"), env)).status).toBe(200);
      expect((await app.fetch(new Request("https://prism.test/limited"), env)).status).toBe(200);
      expect((await app.fetch(new Request("https://prism.test/limited"), env)).status).toBe(200);
      expect((await app.fetch(new Request("https://prism.test/limited"), env)).status).toBe(429);
    });

    it("calculates geo distances and verifies location within shop bounds", () => {
      const distance = haversineMeters(31.2304, 121.4737, 31.2305, 121.4738);
      expect(distance).toBeGreaterThan(0);
      expect(distance).toBeLessThan(50);

      const insideCheck = checkLocation({
        userLat: 31.2304,
        userLng: 121.4737,
        accuracy: 10,
        shopLat: 31.2304,
        shopLng: 121.4737,
        radiusMeters: 80,
      });
      expect(insideCheck.allowed).toBe(true);
      expect(insideCheck.reason).toBe("ok");

      const outsideCheck = checkLocation({
        userLat: 31.3000,
        userLng: 121.5000,
        accuracy: 10,
        shopLat: 31.2304,
        shopLng: 121.4737,
        radiusMeters: 80,
      });
      expect(outsideCheck.allowed).toBe(false);
      expect(outsideCheck.reason).toBe("out_of_range");

      const lowAccuracyCheck = checkLocation({
        userLat: 31.2304,
        userLng: 121.4737,
        accuracy: 300,
        shopLat: 31.2304,
        shopLng: 121.4737,
        radiusMeters: 80,
      });
      expect(lowAccuracyCheck.allowed).toBe(false);
      expect(lowAccuracyCheck.reason).toBe("low_accuracy");
    });
  });
});


describe("independent geofence flags", () => {
  const base = {
    id:"shop",public_id:"shop",name:"shop",latitude:35,longitude:139,radius_meters:80,
    billing_enabled:1,cashier_enabled:0,auto_register:0,identity_binding_required:0,
    checkin_geo:0,checkout_geo:0,machine_geo:0,bot_contact:"",
    time_zone:"Asia/Tokyo",hero_url:null
  };
  it("only enforces the requested operation's flag", () => {
    const shop = { ...base, checkin_geo:1, checkout_geo:0, machine_geo:0 };
    expect(() => checkShopLocation(shop, "checkout", null)).not.toThrow();
    expect(() => checkShopLocation(shop, "machine", null)).not.toThrow();
    expect(() => checkShopLocation(shop, "checkin", null)).toThrow();
  });
  it("independently protects checkout and machine actions", () => {
    const shop = { ...base, checkin_geo:0, checkout_geo:1, machine_geo:1 };
    expect(() => checkShopLocation(shop, "checkin", null)).not.toThrow();
    expect(() => checkShopLocation(shop, "checkout", null)).toThrow();
    expect(() => checkShopLocation(shop, "machine", null)).toThrow();
  });
});
