import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { sqliteSchema } from "@prism/storage-sql";
import type { D1BoundStatementLike, D1DatabaseLike, SqlValue } from "@prism/adapter-d1";
import type { AppBindings, Env } from "../src/bindings.js";
import { attachUser } from "../src/middleware/auth.js";
import { clearShopDependenciesCache } from "../src/middleware/tenant.js";
import { clearRateLimitMemory } from "../src/middleware/rate-limit.js";
import { shopRouter } from "../src/routes/shops/index.js";
import { createApp } from "../src/app.js";
import { billingSetupStatements } from "../src/routes/platform/shops.js";
import { sha256, sha256Hex } from "../src/crypto.js";
import { mintMachineTicket } from "../src/routes/platform/machine-session.js";
import { LiveBilling } from "../src/durable-objects/live-billing.js";
import { activityBill } from "../src/durable-objects/live-activity-billing.js";

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

  // These platform tables live in D1 migrations rather than the embedded SQL
  // repository schema; command contract fixtures need both.
  sqlite.run(`CREATE TABLE IF NOT EXISTS player_operations (
    shop_id TEXT NOT NULL, user_id TEXT NOT NULL, id TEXT NOT NULL,
    kind TEXT NOT NULL, status TEXT NOT NULL, request_hash TEXT NOT NULL,
    result_json TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY(shop_id,user_id,id))`);

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
    CREATE TABLE IF NOT EXISTS machines (
      shop_id TEXT NOT NULL,
      id TEXT NOT NULL,
      public_id TEXT NOT NULL,
      name TEXT NOT NULL,
      hinata_url TEXT NOT NULL DEFAULT '',
      hinata_password TEXT,
      ha_binding_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      kind TEXT NOT NULL DEFAULT 'machine' CHECK(kind IN ('machine','door')),
      ttlock_lock_id INTEGER,
      coin_key INTEGER NOT NULL DEFAULT 1,
      coin_after_swipe INTEGER NOT NULL DEFAULT 0 CHECK(coin_after_swipe IN (0,1)),
      mahjong_config_json TEXT,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY(shop_id,id),
      UNIQUE(shop_id,public_id)
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

describe("Direct Multi-Tenant Shop Billing Routes Suite", () => {
  beforeEach(() => {
    clearShopDependenciesCache();
    clearRateLimitMemory();
  });

  async function setupShopFixture(db: D1DatabaseLike, sqlite: Database) {
    const shopId = "shop_uuid_shanghai";
    const publicId = "shanghai-hub";
    const staffUserId = "user_staff_1";
    const staffSessionToken = "staff-session-token-xyz";
    const botToken = "bot_token_secret_123";

    // 1. Insert shop and staff user
    sqlite.run(
      "INSERT INTO users (id, role, created_at, updated_at) VALUES (?, 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      [staffUserId],
    );
    sqlite.run(
      "INSERT INTO auth_identities (id, user_id, provider, provider_subject, display_name) VALUES ('ident_1', ?, 'local', 'staff1', 'Staff Alice')",
      [staffUserId],
    );
    const tokenHash = await sha256(staffSessionToken);
    sqlite.run(
      "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES ('sess_1', ?, ?, datetime('now', '+7 days'))",
      [staffUserId, tokenHash],
    );

    sqlite.run(
      "INSERT INTO shops (id, public_id, name, latitude, longitude, radius_meters, created_by) VALUES (?, ?, ?, 31.23, 121.47, 100, ?)",
      [shopId, publicId, "Shanghai Hub", staffUserId],
    );
    sqlite.run(
      "INSERT INTO shop_members (id, shop_id, user_id, role) VALUES ('sm_1', ?, ?, 'owner')",
      [shopId, staffUserId],
    );

    // 2. Setup standard billing definitions & pricing
    const { statements } = billingSetupStatements(db, shopId, {
      paidName: "充值余额",
      freeName: "赠送余额",
      hourlyPrice: 3000,
      graceMinutes: 5,
      dailyCap: 18000,
      botContact: "bot-contact",
      autoRegister: true,
    });
    await db.batch(statements);

    // 3. Enable cashier and bypass identity binding for tests
    sqlite.run(
      "UPDATE shop_billing_settings SET identity_binding_required = 0, checkin_geo = 0, checkout_geo = 0, machine_geo = 0 WHERE shop_id = ?",
      [shopId],
    );
    sqlite.run(
      "INSERT INTO app_settings (shop_id, key, value_json, updated_at) VALUES (?, 'cashier.settings', '{\"enabled\":true}', CURRENT_TIMESTAMP)",
      [shopId],
    );

    // 4. Register bot integration token
    const botTokenHash = await sha256Hex(botToken);
    sqlite.run(
      "INSERT INTO api_tokens (shop_id, id, label, role, token_prefix, token_hash, status, created_at) VALUES (?, 'tok_1', 'bot', 'integration', 'integration', ?, 'active', CURRENT_TIMESTAMP)",
      [shopId, botTokenHash],
    );

    return {
      shopId,
      publicId,
      staffUserId,
      staffSessionToken,
      botToken,
    };
  }

  function createTestApp() {
    const app = new Hono<AppBindings>();
    app.use("*", attachUser);
    app.route("/api/v1/shops/:shopCode", shopRouter);
    return app;
  }

  it("refreshes registered bills after shared asset changes and ignores read-only previews", async () => {
    const { db, sqlite, env } = createTestContext();
    const { shopId, publicId, staffUserId, staffSessionToken } = await setupShopFixture(db, sqlite);
    sqlite.exec(await Bun.file(new URL("../../../migrations/0025_live_activity_push_tokens.sql", import.meta.url)).text());
    sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?,'player','Player','active',CURRENT_TIMESTAMP)", [shopId]);
    sqlite.run("INSERT INTO sessions(shop_id,id,player_id,started_at,status,payment_status,pricing_config_ids_json) VALUES (?,'visit','player',?,'active','unpaid','[]')", [shopId, new Date().toISOString()]);
    sqlite.run("INSERT INTO shop_player_accounts(shop_id,user_id,player_id) VALUES (?,?,'player')", [shopId, staffUserId]);
    sqlite.run(`INSERT INTO live_activity_tokens(id,shop_id,user_id,activity_id,token,environment,bundle_id,session_id,attributes_json,created_at,updated_at)
      VALUES ('activity',?,?,'clip','token','production','moe.neri.hinatago.prism','visit','{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [shopId, staffUserId]);
    const refreshed: string[] = [];
    const priorities: boolean[] = [];
    Object.assign(env, {
      APNS_KEY_ID: "key", APNS_TEAM_ID: "team", APNS_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----test",
      LIVE_BILLING: { getByName(name: string) { return { async refresh(_shop: string, _player: string, _terminal: boolean, urgent: boolean) { refreshed.push(name); priorities.push(urgent); } }; } },
    });
    const tasks: Promise<unknown>[] = [];
    const ctx = { waitUntil(task: Promise<unknown>) { tasks.push(task); } } as ExecutionContext;
    const app = createApp();
    const url = `https://prism.test/api/v1/shops/${publicId}`;
    const headers = { authorization: `Bearer ${staffSessionToken}`, "content-type": "application/json" };
    try {
      for (const path of ["assets/currency/paid", "staff/asset-definitions/currency/paid"]) {
        const response = await app.fetch(new Request(`${url}/${path}`, {
          method: "PUT", headers, body: JSON.stringify({ name: "Updated balance", stackable: true }),
        }), env, ctx);
        expect(response.status).toBe(200);
        await Promise.all(tasks.splice(0));
      }
      expect(refreshed).toEqual([JSON.stringify([shopId, "player"]), JSON.stringify([shopId, "player"])]);
      expect(priorities).toEqual([true, true]);
      const preview = await app.fetch(new Request(`${url}/staff/players/player/checkout/preview`, {
        method: "POST", headers, body: "{}",
      }), env, ctx);
      expect(preview.status).toBe(200);
      await Promise.all(tasks.splice(0));
      expect(refreshed).toHaveLength(2);
      const denied = await app.fetch(new Request(`${url}/assets/currency/paid`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Denied" }),
      }), env, ctx);
      expect(denied.status).toBe(401);
      await Promise.all(tasks.splice(0));
      expect(refreshed).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });

  it("preloads exactly the next two-minute bill without settling or changing balances", async () => {
    const { db, sqlite, env } = createTestContext();
    const { shopId } = await setupShopFixture(db, sqlite);
    const start = new Date("2026-10-15T06:00:00.000Z");
    sqlite.run(`UPDATE pricing_configs SET provider_json=json_set(provider_json,
      '$.rules[0].pricing.unitMinutes',2,'$.rules[0].pricing.unitPrice',200,
      '$.rules[0].pricing.roundGraceMinutes',2) WHERE shop_id=? AND kind='time.priority'`, [shopId]);
    sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?,'forecast','Player','active',?)", [shopId, start.toISOString()]);
    sqlite.run("INSERT INTO sessions(shop_id,id,player_id,started_at,status,payment_status,pricing_config_ids_json) VALUES (?,'forecast-visit','forecast',?,'active','unpaid','[]')", [shopId, start.toISOString()]);
    sqlite.run("INSERT INTO asset_holdings(shop_id,id,player_id,asset_type,asset_code,quantity) VALUES (?,'balance','forecast','currency','paid',100000)", [shopId]);
    try {
      const initial = await activityBill(env, shopId, "forecast", start);
      expect(initial?.bill.amountCents).toBe(0);
      expect(initial?.nextCheckAt).toBe(+start + 120_000);
      expect(initial?.nextBill).toMatchObject({
        amountCents: 200, asOfUnix: (+start + 120_000) / 1000,
        nextEvent: { atUnix: (+start + 240_000) / 1000 },
      });
      const atBoundary = await activityBill(env, shopId, "forecast", new Date(+start + 120_000));
      expect(initial?.nextBill).toEqual(atBoundary?.bill);
      expect(atBoundary?.nextBill?.amountCents).toBe(400);
      let shopReads = 0;
      const failingForecast = { DB: {
        prepare(sql: string) {
          if (sql.includes("FROM shops s") && ++shopReads === 2) throw new Error("Forecast database unavailable");
          return db.prepare(sql);
        },
        batch: db.batch.bind(db),
      } } as Pick<Env, "DB">;
      const fallback = await activityBill(failingForecast, shopId, "forecast", start);
      expect(fallback?.bill).toEqual(initial?.bill);
      expect(fallback?.nextBill).toBeUndefined();
      expect(sqlite.query("SELECT quantity FROM asset_holdings WHERE id='balance'").get()).toEqual({ quantity: 100000 });
      expect(sqlite.query("SELECT status,payment_status,ended_at FROM sessions WHERE id='forecast-visit'").get()).toEqual({ status: "active", payment_status: "unpaid", ended_at: null });
      expect(sqlite.query("SELECT COUNT(*) AS n FROM settlements").get()).toEqual({ n: 0 });
      sqlite.run("UPDATE sessions SET status='closed',ended_at=? WHERE id='forecast-visit'", [new Date(+start + 120_000).toISOString()]);
      expect((await activityBill(env, shopId, "forecast", new Date(+start + 180_000)))?.nextBill).toBeUndefined();
      sqlite.run("UPDATE sessions SET payment_status='paid' WHERE id='forecast-visit'");
      expect(await activityBill(env, shopId, "forecast", new Date(+start + 180_000))).toBeNull();
    } finally { sqlite.close(); }
  });

  for (const checkout of ["player", "staff", "override", "recharge", "bulk", "cashier"] as const) {
    it(`pushes the final App Clip bill promptly after ${checkout} checkout`, async () => {
      const { db, sqlite, env } = createTestContext();
      const { shopId, publicId, staffUserId, staffSessionToken } = await setupShopFixture(db, sqlite);
      sqlite.exec(await Bun.file(new URL("../../../migrations/0025_live_activity_push_tokens.sql", import.meta.url)).text());
      sqlite.exec(await Bun.file(new URL("../../../migrations/0026_live_activity_start_tokens.sql", import.meta.url)).text());
      sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?,'clip-player','Clip Player','active',CURRENT_TIMESTAMP)", [shopId]);
      sqlite.run("INSERT INTO shop_player_accounts(shop_id,user_id,player_id) VALUES (?,?,'clip-player')", [shopId, staffUserId]);
      if (checkout !== "cashier") sqlite.run("INSERT INTO asset_holdings(shop_id,id,player_id,asset_type,asset_code,quantity) VALUES (?,'balance','clip-player','currency','paid',1000000000)", [shopId]);
      const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      const encoded = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey))));
      Object.assign(env, {
        APNS_KEY_ID: "key", APNS_TEAM_ID: "team",
        APNS_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`,
      });
      const state = new Map<string, unknown>();
      let alarm: number | null = null;
      const storage = {
        async get<T>(key: string) { return state.get(key) as T | undefined; },
        async put(key: string, value: unknown) { state.set(key, value); },
        async delete(key: string) { return state.delete(key); },
        async getAlarm() { return alarm; },
        async setAlarm(at: number) { alarm = at; },
        async deleteAlarm() { alarm = null; },
        async deleteAll() { state.clear(); },
      };
      const liveBilling = new LiveBilling({ storage } as any, env);
      env.LIVE_BILLING = { getByName: () => liveBilling } as any;
      const tasks: Promise<unknown>[] = [];
      const execution = { waitUntil(task: Promise<unknown>) { tasks.push(task); }, passThroughOnException() {} } as ExecutionContext;
      const app = createApp();
      const base = `https://prism.test/api/v1/shops/${publicId}`;
      const headers = { authorization: `Bearer ${staffSessionToken}`, "content-type": "application/json" };
      const post = async (path: string, body: Record<string, unknown>) => {
        const response = await app.fetch(new Request(`${base}/${path}`, {
          method: "POST", headers, body: JSON.stringify(body),
        }), env, execution);
        await Promise.all(tasks.splice(0));
        expect({ status: response.status, error: response.ok ? null : await response.clone().json() }).toEqual({ status: 200, error: null });
        return (await response.json() as { data: Record<string, any> }).data;
      };
      // Start through the QR-confirmed native API, then register its per-activity token.
      sqlite.run("INSERT INTO machines(shop_id,id,public_id,name,kind,enabled) VALUES (?,'entry','entry','Entry','machine',1)", [shopId]);
      const { ticket } = await mintMachineTicket(env.SESSION_SECRET, publicId, "entry");
      const started = await post("player/session/start", { ticket, consent: true, operationId: crypto.randomUUID() });
      const sessionId = started.session.id as string;
      sqlite.run("UPDATE sessions SET started_at=? WHERE shop_id=? AND id=?", [new Date(Date.now() - 90 * 60_000).toISOString(), shopId, sessionId]);
      await post("player/live-activity/register", {
        activityId: "clip-activity", token: "a".repeat(64), sessionId,
        environment: "production", bundleId: "moe.neri.hinatago.prism",
      });
      const recovery = await app.fetch(new Request(`${base}/player/live-activity/bill`, { headers }), env, execution);
      expect(recovery.status).toBe(200);
      const recovered = (await recovery.json() as { data: Record<string, any> }).data;
      expect(recovered.nextBill.asOfUnix).toBe(recovered.bill.nextEvent.atUnix);
      await Promise.all(tasks.splice(0));
      const pushes: Array<{ aps: Record<string, any> }> = [];
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url, init) => {
        expect(String(url)).toContain("api.push.apple.com/3/device/");
        expect(new Headers(init?.headers).get("apns-topic")).toBe("moe.neri.hinatago.prism.push-type.liveactivity");
        pushes.push(JSON.parse(String(init?.body)));
        return new Response("", { status: 200 });
      }) as typeof fetch);
      try {
        await liveBilling.alarm();
        expect(pushes[0]?.aps.event).toBe("update");
        expect(pushes[0]?.aps["content-state"].nextBill?.asOfUnix).toBe(
          pushes[0]?.aps["content-state"].bill.nextEvent.atUnix);
        expect(pushes[0]?.aps["stale-date"]).toBeGreaterThanOrEqual(
          pushes[0]?.aps["content-state"].bill.nextEvent.atUnix);
        // Simulate exhausted billing quota and a recent checkout of an earlier visit.
        state.set("alarm-budget", {
          tokens: 0, updatedAt: Date.now(), lastRunAt: Date.now(), lastTerminalBypassAt: Date.now(),
        });
        await liveBilling.refresh(shopId, "clip-player", true);
        await liveBilling.alarm();
        expect(pushes).toHaveLength(1); // An unpaid activity cannot use the final-delivery lane.
        const operationId = crypto.randomUUID();
        const path = checkout === "player" ? "player/checkout/confirm"
          : checkout === "bulk" ? "staff/sessions/active/checkout"
          : checkout === "cashier" ? "cashier/profiles/clip-player/checkout/confirm"
          : `staff/players/clip-player/checkout/${checkout === "staff" ? "confirm" : checkout}`;
        let body: Record<string, unknown> = { operationId };
        if (checkout === "override") body = { ...body, finalTotal: 12.34, reason: "Test override" };
        if (checkout === "recharge") body = { ...body, amount: 10 };
        if (checkout === "cashier") {
          sqlite.run("INSERT INTO cashier_profiles(shop_id,player_id,card_kind,card_uid,created_at) VALUES (?,'clip-player','type-a','12345678',CURRENT_TIMESTAMP)", [shopId]);
          const preview = await post("cashier/profiles/clip-player/checkout/preview", {});
          body = { method: "cash", previewedAt: preview.settlementPreview.previewedAt, expectedTotal: preview.settlementPreview.total, sessionIds: [sessionId] };
        }
        const receipt = await post(path, body);
        expect(alarm).not.toBeNull();
        expect(alarm!).toBeLessThanOrEqual(Date.now() + 1500);
        await liveBilling.alarm();
        expect(pushes).toHaveLength(2);
        expect(pushes[1]?.aps.event).toBe("end");
        expect(pushes[1]?.aps["content-state"].nextBill).toBeUndefined();
        const settled = checkout === "bulk" ? receipt.settlements[0] : receipt;
        const session = sqlite.query("SELECT ended_at FROM sessions WHERE shop_id=? AND id=?").get(shopId, sessionId) as { ended_at: string };
        expect(pushes[1]?.aps["content-state"]).toMatchObject({
          phase: "ended", endedAtUnix: Date.parse(session.ended_at) / 1000,
          bill: { amountCents: Math.round(settled.playerSettlement.total * 100) },
        });
        expect(sqlite.query("SELECT id FROM live_activity_tokens").get()).toBeNull();
        if (checkout !== "cashier") {
          const revision = state.get("visit");
          await post(path, body);
          expect(state.get("visit")).toEqual(revision);
          expect(pushes).toHaveLength(2);
        }
      } finally {
        fetchSpy.mockRestore();
        sqlite.close();
      }
    });
  }

  it("does not disclose standalone device secrets or issue API tokens to a viewer", async () => {
    const { db, sqlite, env } = createTestContext();
    const { shopId, publicId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const viewerToken = "viewer-settings-session";
    sqlite.run("INSERT INTO users(id,role) VALUES ('view-user','user')");
    sqlite.run(
      "INSERT INTO shop_members(id,shop_id,user_id,role) VALUES ('view-member',?,?,'staff')",
      [shopId, "view-user"],
    );
    sqlite.run(
      "INSERT INTO staff_users(shop_id,id,username,display_name,password_hash,password_salt,role,status,created_at,updated_at) VALUES (?,'view-staff','view-staff','Viewer','','','viewer','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
      [shopId],
    );
    sqlite.run(
      "INSERT INTO shop_staff_accounts(shop_id,user_id,staff_id) VALUES (?,'view-user','view-staff')",
      [shopId],
    );
    sqlite.run(
      "INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ('view-session','view-user',?,datetime('now','+7 days'))",
      [await sha256(viewerToken)],
    );
    const app = createTestApp();
    const prefix = `https://prism.test/api/v1/shops/${publicId}/staff`;
    const headers = { authorization: `Bearer ${viewerToken}`, "content-type": "application/json" };
    expect((await app.fetch(new Request(prefix + "/settings", { headers }), env)).status).toBe(403);
    expect((await app.fetch(new Request(prefix + "/settings", {
      method: "PUT", headers, body: JSON.stringify({}),
    }), env)).status).toBe(403);
    expect((await app.fetch(new Request(prefix + "/api-tokens", {
      method: "POST", headers, body: JSON.stringify({ label: "test", role: "integration" }),
    }), env)).status).toBe(403);
    expect((await app.fetch(new Request(prefix + "/settings", {
      headers: { authorization: `Bearer ${staffSessionToken}` },
    }), env)).status).toBe(200);
  });

  it("preserves staff/me role and canWrite for owner, manager, viewer and unauthenticated callers", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, shopId, staffUserId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const app = createApp();
    const uri = `https://prism.test/api/v1/shops/${publicId}/staff/me`;
    const access = async (token?: string) => {
      const response = await app.fetch(new Request(uri, {
        ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      }), env);
      return { status: response.status, body: await response.json() as any };
    };

    const owner = await access(staffSessionToken);
    expect(owner.status).toBe(200);
    expect(owner.body.data.staff).toEqual({
      id: `account:${staffUserId}`,
      displayName: "Staff Alice",
      role: "owner",
      canWrite: true,
    });

    // The authenticated account can also be a mapped shop staff user: only
    // the shop-scoped role, not the internal principal discriminator, controls UI.
    sqlite.run(
      "INSERT INTO staff_users(shop_id,id,username,display_name,password_hash,password_salt,role,status,created_at,updated_at) VALUES (?, 'managed', 'managed', 'Managed', 'hash', 'salt', 'manager', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      [shopId],
    );
    sqlite.run(
      "INSERT INTO shop_staff_accounts(shop_id,user_id,staff_id) VALUES (?, ?, 'managed')",
      [shopId, staffUserId],
    );
    const manager = await access(staffSessionToken);
    expect(manager.body.data.staff).toEqual({
      id: "managed", displayName: "Managed", role: "manager", canWrite: true,
    });

    sqlite.run("UPDATE staff_users SET role='viewer' WHERE shop_id=? AND id='managed'", [shopId]);
    const viewer = await access(staffSessionToken);
    expect(viewer.status).toBe(200);
    expect(viewer.body.data.staff).toEqual({
      id: "managed", displayName: "Managed", role: "viewer", canWrite: false,
    });

    const anonymous = await access();
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe("AUTHENTICATION_REQUIRED");
    sqlite.close();
  });

  it("keeps staff management DTOs public and never exposes password or API token hashes", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const app = createApp();
    const prefix = `https://prism.test/api/v1/shops/${publicId}/staff`;
    const headers = { authorization: `Bearer ${staffSessionToken}` };

    const usersResponse = await app.fetch(new Request(prefix + "/users", { headers }), env);
    expect(usersResponse.status).toBe(200);
    const users = await usersResponse.json() as {
      data: { staffUsers: Array<Record<string, unknown>> };
    };
    expect(users.data.staffUsers.length).toBeGreaterThan(0);
    for (const user of users.data.staffUsers) {
      expect(Object.keys(user).sort()).toEqual(
        ["id", "username", "displayName", "role", "status", "createdAt", "updatedAt"].sort(),
      );
      expect(user).not.toHaveProperty("passwordHash");
      expect(user).not.toHaveProperty("passwordSalt");
    }

    const tokensResponse = await app.fetch(new Request(prefix + "/api-tokens", { headers }), env);
    expect(tokensResponse.status).toBe(200);
    const tokens = await tokensResponse.json() as {
      data: { apiTokens: Array<Record<string, unknown>> };
    };
    expect(tokens.data.apiTokens.length).toBeGreaterThan(0);
    for (const token of tokens.data.apiTokens) {
      expect(Object.keys(token).sort()).toEqual(
        ["id", "label", "role", "tokenPrefix", "status", "createdAt", "lastUsedAt", "revokedAt"].sort(),
      );
      expect(token).not.toHaveProperty("tokenHash");
      expect(token).not.toHaveProperty("token");
    }
    sqlite.close();
  });

  it("preserves createdAt in player management create and status update responses", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const app = createApp();
    const headers = {
      authorization: `Bearer ${staffSessionToken}`,
      "content-type": "application/json",
    };
    const url = `https://prism.test/api/v1/shops/${publicId}/staff/players`;
    const created = await app.fetch(new Request(url, {
      method: "POST", headers, body: JSON.stringify({ displayName: "API 契约测试" }),
    }), env);
    expect(created.status).toBe(201);
    const payload = await created.json() as {
      data: { player: { id: string; displayName: string; status: string; createdAt: string } };
    };
    expect(Object.keys(payload.data.player).sort()).toEqual(
      ["id", "displayName", "status", "createdAt"].sort(),
    );
    expect(payload.data.player.displayName).toBe("API 契约测试");
    expect(Number.isNaN(Date.parse(payload.data.player.createdAt))).toBe(false);

    const updated = await app.fetch(new Request(
      `${url}/${payload.data.player.id}/status`, {
        method: "PATCH", headers, body: JSON.stringify({ status: "disabled" }),
      },
    ), env);
    expect(updated.status).toBe(200);
    const result = await updated.json() as { data: { player: typeof payload.data.player } };
    expect(result.data.player).toEqual({
      ...payload.data.player, status: "disabled",
    });
    sqlite.close();
  });

  it("preserves real wallet balances, identities and session flags in the production player list response", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, shopId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const app = createApp();

    sqlite.run(
      "INSERT INTO players (shop_id, id, display_name, status, created_at) VALUES (?, 'funded', '有余额玩家', 'active', CURRENT_TIMESTAMP), (?, 'empty', '零余额玩家', 'active', CURRENT_TIMESTAMP)",
      [shopId, shopId],
    );
    sqlite.run(
      "INSERT INTO asset_holdings (shop_id, id, player_id, asset_type, asset_code, quantity) VALUES (?, 'paid-1', 'funded', 'currency', 'paid', 12345), (?, 'free-1', 'funded', 'currency', 'free', 250)",
      [shopId, shopId],
    );
    sqlite.run(
      "INSERT INTO player_identities (shop_id, player_id, provider, subject, created_at) VALUES (?, 'funded', 'aime', 'card-1', '2026-10-01T00:00:00Z')",
      [shopId],
    );
    sqlite.run(
      "INSERT INTO sessions (shop_id, id, player_id, started_at, status, payment_status, pricing_config_ids_json) VALUES (?, 'active-funded', 'funded', '2026-10-02T02:08:00Z', 'active', 'unpaid', '[]')",
      [shopId],
    );

    const response = await app.fetch(new Request(
      `https://prism.test/api/v1/shops/${publicId}/staff/players`,
      { headers: { authorization: `Bearer ${staffSessionToken}` } },
    ), env);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      data: { players: Array<{
        id: string; walletTotal: number; activeSessionId: string | null;
        hasUnpaidSession: boolean; identities: Array<{ provider: string; subject: string; createdAt: string }>;
      }> };
    };
    const byId = new Map(body.data.players.map((player) => [player.id, player]));
    expect(byId.get("funded")).toMatchObject({
      walletTotal: 125.95,
      activeSessionId: "active-funded",
      hasUnpaidSession: true,
      identities: [{ provider: "aime", subject: "card-1", createdAt: expect.any(String) }],
    });
    expect(byId.get("empty")).toMatchObject({
      walletTotal: 0,
      activeSessionId: null,
      hasUnpaidSession: false,
      identities: [],
    });
    sqlite.close();
  });

  it("registers and retires an ActivityKit token on the real tenant endpoint", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, staffSessionToken, shopId } = await setupShopFixture(db, sqlite);
    // The lightweight SQL fixture predates the platform's APNs migrations.
    sqlite.run(`CREATE TABLE IF NOT EXISTS live_activity_tokens (
      id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, user_id TEXT NOT NULL,
      activity_id TEXT NOT NULL, token TEXT NOT NULL, environment TEXT NOT NULL,
      bundle_id TEXT NOT NULL, session_id TEXT, attributes_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (shop_id, user_id, activity_id))`);
    const app = createApp();
    const url = `https://prism.test/api/v1/shops/${publicId}/player/live-activity`;
    const headers = { authorization: `Bearer ${staffSessionToken}`, "content-type": "application/json" };
    const registered = await app.fetch(new Request(url + "/register", {
      method: "POST", headers, body: JSON.stringify({
        activityId: "test-live-activity", token: "A".repeat(64),
        environment: "sandbox", bundleId: "moe.neri.hinatago",
      }),
    }), env);
    expect(registered.status).toBe(200);
    const token = sqlite.query("SELECT token, bundle_id FROM live_activity_tokens WHERE shop_id=?")
      .get(shopId) as { token: string; bundle_id: string } | null;
    expect(token).toEqual({ token: "a".repeat(64), bundle_id: "moe.neri.hinatago" });

    const retired = await app.fetch(new Request(url + "/unregister", {
      method: "POST", headers, body: JSON.stringify({ activityId: "test-live-activity" }),
    }), env);
    expect(retired.status).toBe(200);
    const remain = sqlite.query("SELECT COUNT(*) AS count FROM live_activity_tokens WHERE shop_id=?")
      .get(shopId) as { count: number };
    expect(remain.count).toBe(0);
    const denied = await app.fetch(new Request(url + "/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ activityId: "no-user", token: "a".repeat(64), environment: "sandbox", bundleId: "moe.neri.hinatago" }),
    }), env);
    expect(denied.status).toBe(401);
    sqlite.close();
  });

  it("caps Live Activity registration at four distinct activities per account", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, staffSessionToken, shopId } = await setupShopFixture(db, sqlite);
    sqlite.run(`CREATE TABLE IF NOT EXISTS live_activity_tokens (
      id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, user_id TEXT NOT NULL,
      activity_id TEXT NOT NULL, token TEXT NOT NULL, environment TEXT NOT NULL,
      bundle_id TEXT NOT NULL, session_id TEXT, attributes_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(shop_id, user_id, activity_id))`);
    const app = createApp();
    const url = `https://prism.test/api/v1/shops/${publicId}/player/live-activity/register`;
    const headers = { authorization: `Bearer ${staffSessionToken}`, "content-type": "application/json" };
    const register = (id: number) => app.fetch(new Request(url, {
      method: "POST", headers, body: JSON.stringify({
        activityId: `activity-${id}`, token: String(id).repeat(64),
        environment: "sandbox", bundleId: "moe.neri.hinatago",
      }),
    }), env);
    for (let index = 1; index <= 4; index++) {
      expect((await register(index)).status).toBe(200);
    }
    expect((await register(5)).status).toBe(429);
    expect((sqlite.query("SELECT COUNT(*) AS count FROM live_activity_tokens WHERE shop_id=?")
      .get(shopId) as { count: number }).count).toBe(4);
    sqlite.close();
  });

  it("keeps pre-merge API routes and requires a QR ticket to start a player visit", async () => {
    const app = createApp();
    const registered = new Set(app.routes.map((route) => `${route.method} ${route.path}`));
    const scoped = "/api/v1/shops/:shopCode";
    for (const route of [
      "GET /player/live-activity/bill",
      "POST /player/live-activity/register",
      "POST /player/live-activity/unregister",
      "GET /staff/settings",
      "PUT /staff/settings",
      "GET /staff/api-tokens",
      "POST /staff/api-tokens",
      "POST /staff/api-tokens/:tokenId/revoke",
      "GET /staff/users",
      "POST /staff/users",
      "PATCH /staff/users/:staffUserId",
      "POST /staff/users/:staffUserId/password",
      "POST /integration/players/by-identity/checkout/override",
      "POST /integration/players/by-identity/device-actions",
    ]) {
      const [method, endpoint] = route.split(" ");
      expect(registered.has(`${method} ${scoped}${endpoint}`)).toBe(true);
    }
    expect(registered.has("ALL /api/*")).toBe(true);

    const { db, sqlite, env } = createTestContext();
    const { publicId, shopId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const uri = `https://prism.test/api/v1/shops/${publicId}/player/session/start`;
    const start = await app.fetch(new Request(uri, {
      method: "POST",
      headers: { authorization: `Bearer ${staffSessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ consent: true }),
    }), env);
    expect(start.status).toBe(410);
    const result = await start.json() as { error: { code: string } };
    expect(result.error.code).toBe("TICKET_EXPIRED");
    const createdSessions = sqlite.query("SELECT COUNT(*) AS count FROM sessions WHERE shop_id=?").get(shopId) as { count: number };
    expect(createdSessions.count).toBe(0);

    const alias = await app.fetch(new Request("https://prism.test/api/me", {
      headers: { authorization: `Bearer ${staffSessionToken}` },
    }), env);
    expect(alias.status).toBe(200);
    const plain = await alias.json() as Record<string, unknown>;
    expect(plain.user).toBeDefined();
    expect(plain.data).toBeUndefined();
    sqlite.close();
  });

  it("returns a grouped on-site player and real billing inputs for the browser; unauthenticated users are denied", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, shopId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const app = createTestApp();
    sqlite.run(
      "INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?, 'on-site-player', '在店玩家示例', 'active', CURRENT_TIMESTAMP)",
      [shopId],
    );
    sqlite.run(
      "INSERT INTO sessions(shop_id,id,player_id,started_at,status,payment_status,pricing_config_ids_json) VALUES (?, 'active-visit', 'on-site-player', '2026-10-02T02:08:00Z', 'active', 'unpaid', '[]')",
      [shopId],
    );
    const url = `https://prism.test/api/v1/shops/${publicId}/staff/live-players`;
    const anonymous = await app.fetch(new Request(url), env);
    expect([401, 403]).toContain(anonymous.status);
    const response = await app.fetch(new Request(url, {
      headers: { authorization: `Bearer ${staffSessionToken}` },
    }), env);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      players: Array<{
        playerId: string; displayName: string; sessions: Array<{
          id: string; status: string; pricingCharges: unknown[]; pricingSegments: unknown[];
        }>; estimatedTotal: number | null;
      }>;
      billingSnapshot: { version: number; players: Array<{ playerId: string }> };
    };
    expect(body.players).toHaveLength(1);
    expect(body.players[0]).toMatchObject({
      playerId: "on-site-player", displayName: "在店玩家示例",
      estimatedTotal: null,
    });
    expect(body.players[0]?.sessions).toEqual([expect.objectContaining({
      id: "active-visit", status: "active", pricingCharges: [], pricingSegments: [],
    })]);
    expect(body.billingSnapshot.version).toBe(1);
    expect(body.billingSnapshot.players.map((player) => player.playerId)).toContain("on-site-player");
    sqlite.close();
  });

  it("keeps pre-fork shop data transfer owner-only and fails closed without rate limiting", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, shopId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const app = createTestApp();
    const exportUrl=`https://prism.test/api/v1/shops/${publicId}/data/export`;
    const previewUrl=`https://prism.test/api/v1/shops/${publicId}/data/import/preview`;

    const anonymous=await app.fetch(new Request(exportUrl),env);
    expect(anonymous.status).toBe(401);
    const anonymousPreview=await app.fetch(new Request(previewUrl,{
      method:"POST",headers:{"content-type":"application/json"},body:"{}",
    }),env);
    expect(anonymousPreview.status).toBe(401);

    const strangerToken="stranger-transfer-session";
    const strangerId="user_data_stranger";
    sqlite.run("INSERT INTO users(id,role,created_at,updated_at) VALUES (?, 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",[strangerId]);
    sqlite.run("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ('stranger-session',?,?,?)",[
      strangerId,await sha256(strangerToken),new Date(Date.now()+86_400_000).toISOString(),
    ]);
    const stranger=await app.fetch(new Request(exportUrl,{
      headers:{authorization:`Bearer ${strangerToken}`},
    }),env);
    expect(stranger.status).toBe(403);

    // A legitimate owner is still blocked if Cloudflare's distributed limiter is absent.
    // The endpoint must not silently fall back to unbounded import/export operations.
    const owner=await app.fetch(new Request(exportUrl,{
      headers:{authorization:`Bearer ${staffSessionToken}`},
    }),env);
    expect(owner.status).toBe(503);
    expect((await owner.json() as {error:{code:string}}).error.code).toBe("RATE_LIMIT_UNAVAILABLE");
    expect(sqlite.query("SELECT id FROM shops WHERE id=?").get(shopId)).not.toBeNull();
  });

  it("handles player session start, checkout preview, checkout confirm, and history", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, shopId } = await setupShopFixture(db, sqlite);
    const app = createTestApp();

    // Create an active player
    const playerId = "player_alice";
    sqlite.run(
      "INSERT INTO players (shop_id, id, display_name, status, created_at) VALUES (?, ?, 'Alice', 'active', CURRENT_TIMESTAMP)",
      [shopId, playerId],
    );
    // Grant balance to Alice so checkout succeeds
    sqlite.run(
      "INSERT INTO asset_holdings (shop_id, id, player_id, asset_type, asset_code, quantity) VALUES (?, 'hold_1', ?, 'currency', 'paid', 100000)",
      [shopId, playerId],
    );

    // Create Alice's user account and session
    const aliceUserId = "user_alice";
    const aliceToken = "session_token_alice";
    const aliceTokenHash = await sha256(aliceToken);
    const futureExpiry = new Date(Date.now() + 86400000 * 7).toISOString();
    sqlite.run(
      "INSERT INTO users (id, role, created_at, updated_at) VALUES (?, 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      [aliceUserId],
    );
    sqlite.run(
      "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('sess_alice', ?, ?, ?, CURRENT_TIMESTAMP)",
      [aliceUserId, aliceTokenHash, futureExpiry],
    );
    sqlite.run(
      "INSERT INTO shop_player_accounts (shop_id, user_id, player_id, verified_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
      [shopId, aliceUserId, playerId],
    );

    const aliceHeaders = {
      Authorization: `Bearer ${aliceToken}`,
      "Content-Type": "application/json",
    };

    // The real player entry requires a QR-derived, shop-scoped machine ticket
    // and affirmative acknowledgement of the billing terms.
    sqlite.run("INSERT INTO machines(shop_id,id,public_id,name,kind,enabled) VALUES (?, 'entry-machine', 'entry-machine', 'Entry Machine', 'machine', 1)", [shopId]);
    const ticket = (await mintMachineTicket(env.SESSION_SECRET, publicId, "entry-machine")).ticket;
    // 1. Player session start
    const startRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/player/session/start`, {
        method: "POST",
        headers: aliceHeaders,
        body: JSON.stringify({ ticket, consent: true, operationId: crypto.randomUUID() }),
      }),
      env,
    );
    if (!startRes.ok) console.error("QR-confirmed start failed", startRes.status, await startRes.clone().text());
    expect(startRes.status).toBe(200);
    const startData = (await startRes.json()) as any;
    expect(startData.session).toBeDefined();
    expect(startData.session.playerId).toBe(playerId);
    expect(startData.session.status).toBe("active");
    const sessionId = startData.session.id;

    // 2. Player summary / active session verification via GET /player/me
    const meRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/player/me`, {
        headers: aliceHeaders,
      }),
      env,
    );
    expect(meRes.status).toBe(200);
    const meData = (await meRes.json()) as any;
    expect(meData.activeSession).toBeDefined();
    expect(meData.activeSession.id).toBe(sessionId);

    // 3. Checkout Preview
    const previewRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/player/checkout/preview`, {
        method: "POST",
        headers: aliceHeaders,
      }),
      env,
    );
    expect(previewRes.status).toBe(200);
    const previewData = (await previewRes.json()) as any;
    expect(previewData.settlementPreview).toBeDefined();
    expect(previewData.sessionPreviews).toBeDefined();
    expect(previewData.sessionPreviews.length).toBeGreaterThanOrEqual(1);

    // 4. Checkout Confirm
    const confirmRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/player/checkout/confirm`, {
        method: "POST",
        headers: aliceHeaders,
        body: JSON.stringify({ operationId: crypto.randomUUID() }),
      }),
      env,
    );
    expect(confirmRes.status).toBe(200);
    const confirmData = (await confirmRes.json()) as any;
    expect(confirmData.playerSettlement).toBeDefined();
    expect(confirmData.settlements).toBeDefined();
    expect(confirmData.settlements.length).toBeGreaterThanOrEqual(1);

    // 5. Checkout history
    const historyRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/player/checkouts/history`, {
        headers: aliceHeaders,
      }),
      env,
    );
    expect(historyRes.status).toBe(200);
    const historyData = (await historyRes.json()) as any;
    expect(historyData.records).toBeDefined();
    expect(historyData.records.length).toBeGreaterThanOrEqual(1);
  });

  it("enforces authentication and prevents unprivileged X-PRiSM-Player-Id impersonation", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, shopId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const app = createTestApp();

    const victimPlayerId = "player_victim";
    sqlite.run(
      "INSERT INTO players (shop_id, id, display_name, status, created_at) VALUES (?, ?, 'Victim', 'active', CURRENT_TIMESTAMP)",
      [shopId, victimPlayerId],
    );

    // 1. Unauthenticated request with X-PRiSM-Player-Id must be rejected with 401
    const unauthRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/player/me`, {
        headers: { "X-PRiSM-Player-Id": victimPlayerId },
      }),
      env,
    );
    expect(unauthRes.status).toBe(401);

    // 2. Regular non-staff user cannot spoof X-PRiSM-Player-Id (must be rejected with 403)
    const malloryUserId = "user_mallory";
    const malloryToken = "token_mallory";
    const malloryTokenHash = await sha256(malloryToken);
    const futureExpiry = new Date(Date.now() + 86400000 * 7).toISOString();
    sqlite.run(
      "INSERT INTO users (id, role, created_at, updated_at) VALUES (?, 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      [malloryUserId],
    );
    sqlite.run(
      "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('sess_mallory', ?, ?, ?, CURRENT_TIMESTAMP)",
      [malloryUserId, malloryTokenHash, futureExpiry],
    );

    const spoofRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/player/me`, {
        headers: {
          Authorization: `Bearer ${malloryToken}`,
          "X-PRiSM-Player-Id": victimPlayerId,
        },
      }),
      env,
    );
    expect(spoofRes.status).toBe(403);

    // 3. Authorized staff member CAN act on behalf of player with X-PRiSM-Player-Id
    const staffRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/player/me`, {
        headers: {
          Authorization: `Bearer ${staffSessionToken}`,
          "X-PRiSM-Player-Id": victimPlayerId,
        },
      }),
      env,
    );
    expect(staffRes.status).toBe(200);
    const staffData = (await staffRes.json()) as any;
    expect(staffData.player.id).toBe(victimPlayerId);
  });

  it("handles cashier card registration, lookup, entry session, preview, and external settlement", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const app = createTestApp();

    const authHeaders = {
      Authorization: `Bearer ${staffSessionToken}`,
      "Content-Type": "application/json",
    };

    // 1. Register Cashier Card
    const regRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/cashier/register`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          card: {
            kind: "type-a",
            uid: "11223344",
          },
          displayName: "Cashier Player Bob",
        }),
      }),
      env,
    );
    expect(regRes.status).toBe(201);
    const regData = (await regRes.json()) as any;
    expect(regData.profile).toBeDefined();
    expect(regData.profile.displayName).toBe("Cashier Player Bob");
    expect(regData.profile.uid).toBe("11223344");
    const cashierPlayerId = regData.profile.id;

    // 2. Lookup Cashier Card via POST /lookup
    const lookupRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/cashier/lookup`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          kind: "type-a",
          uid: "11223344",
        }),
      }),
      env,
    );
    expect(lookupRes.status).toBe(200);
    const lookupData = (await lookupRes.json()) as any;
    expect(lookupData.profile).toBeDefined();
    expect(lookupData.profile.id).toBe(cashierPlayerId);

    // 3. Start Entry Session via Cashier
    const entryRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/cashier/profiles/${cashierPlayerId}/entry`, {
        method: "POST",
        headers: authHeaders,
      }),
      env,
    );
    expect(entryRes.status).toBe(200);
    const entryData = (await entryRes.json()) as any;
    expect(entryData.session).toBeDefined();
    expect(entryData.session.playerId).toBe(cashierPlayerId);
    const cashierSessionId = entryData.session.id;

    // 4. Cashier Checkout Preview
    const previewRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/cashier/profiles/${cashierPlayerId}/checkout/preview`, {
        method: "POST",
        headers: authHeaders,
      }),
      env,
    );
    expect(previewRes.status).toBe(200);
    const previewData = (await previewRes.json()) as any;
    expect(previewData.settlementPreview).toBeDefined();
    expect(previewData.sessionPreviews).toBeDefined();

    // 5. Cashier Checkout Confirm with external payment (wechat)
    const settleRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/cashier/profiles/${cashierPlayerId}/checkout/confirm`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          method: "wechat",
          previewedAt: previewData.settlementPreview.previewedAt,
          expectedTotal: 0,
          sessionIds: [cashierSessionId],
        }),
      }),
      env,
    );
    expect(settleRes.status).toBe(200);
    const settleData = (await settleRes.json()) as any;
    expect(settleData.playerSettlement).toBeDefined();
    expect(settleData.payment).toBeDefined();
    expect(settleData.payment.method).toBe("wechat");
    expect(settleData.payment.collected).toBe(true);
  });

  it("handles staff queries: players list, player assets, wallet adjustment, and reports summary", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, shopId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const app = createTestApp();

    const authHeaders = {
      Authorization: `Bearer ${staffSessionToken}`,
    };

    // Create players
    sqlite.run(
      "INSERT INTO players (shop_id, id, display_name, status, created_at) VALUES (?, 'p_staff_test', 'Staff Test Player', 'active', CURRENT_TIMESTAMP)",
      [shopId],
    );

    // 1. Staff players list
    const playersRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/staff/players`, {
        headers: authHeaders,
      }),
      env,
    );
    expect(playersRes.status).toBe(200);
    const playersData = (await playersRes.json()) as any;
    expect(playersData.players).toBeDefined();
    expect(playersData.players.length).toBeGreaterThanOrEqual(1);
    expect(playersData.players.some((p: any) => p.id === "p_staff_test")).toBe(true);

    // 2. Staff player assets
    const assetsRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/staff/players/p_staff_test/assets`, {
        headers: authHeaders,
      }),
      env,
    );
    expect(assetsRes.status).toBe(200);
    const assetsData = (await assetsRes.json()) as any;
    expect(assetsData.holdings).toBeDefined();
    expect(assetsData.ledgerEntries).toBeDefined();

    // 3. Staff wallet adjustment; a replay must return the persisted result
    // without applying the financial mutation twice.
    const walletOperationId = crypto.randomUUID();
    const adjustRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/staff/players/p_staff_test/wallet/adjustment`, {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: 5000,
          reason: "staff bonus",
          operationId: walletOperationId,
        }),
      }),
      env,
    );
    expect(adjustRes.status).toBe(200);
    const totalSql = "SELECT COALESCE(SUM(quantity),0) AS total FROM asset_holdings WHERE shop_id=? AND player_id='p_staff_test' AND asset_type='currency'";
    const walletBeforeReplay = sqlite.query(totalSql).get(shopId) as { total: number };
    const repeatRes = await app.fetch(new Request(
      `https://prism.test/api/v1/shops/${publicId}/staff/players/p_staff_test/wallet/adjustment`,
      { method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 5000, reason: "staff bonus", operationId: walletOperationId }) },
    ), env);
    expect(repeatRes.status).toBe(200);
    expect(await repeatRes.json()).toEqual(await adjustRes.json());
    const walletAfterReplay = sqlite.query(totalSql).get(shopId) as { total: number };
    expect(walletAfterReplay.total).toBe(walletBeforeReplay.total);

    // 4. Staff reports summary
    const reportsRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/staff/reports/summary`, {
        headers: authHeaders,
      }),
      env,
    );
    expect(reportsRes.status).toBe(200);
    const reportsData = (await reportsRes.json()) as any;
    expect(reportsData.summary).toBeDefined();
    expect(reportsData.summary.from).toBeDefined();
    expect(reportsData.summary.to).toBeDefined();
  });

  it("handles pricing and asset definition listings", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const app = createTestApp();

    const authHeaders = {
      Authorization: `Bearer ${staffSessionToken}`,
    };

    // 1. Pricing configs
    const pricingRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/pricing`, {
        headers: authHeaders,
      }),
      env,
    );
    expect(pricingRes.status).toBe(200);
    const pricingData = (await pricingRes.json()) as any;
    expect(pricingData.pricingConfigs).toBeDefined();
    expect(pricingData.pricingConfigs.length).toBeGreaterThanOrEqual(1);

    // 2. Asset definitions
    const assetsRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/assets`, {
        headers: authHeaders,
      }),
      env,
    );
    expect(assetsRes.status).toBe(200);
    const assetsData = (await assetsRes.json()) as any;
    expect(assetsData.assetDefinitions).toBeDefined();
    expect(assetsData.assetDefinitions.length).toBeGreaterThanOrEqual(2);
  });

  it("handles bot integration player resolution and wallet query", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, botToken } = await setupShopFixture(db, sqlite);
    const app = createTestApp();

    const botHeaders = {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json",
    };

    // 1. Resolve or register player by bot identity
    const botRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/integration/players/by-identity/register`, {
        method: "POST",
        headers: botHeaders,
        body: JSON.stringify({
          provider: "qq",
          subject: "88889999",
          displayName: "QQ Player",
        }),
      }),
      env,
    );
    expect(botRes.status).toBe(200);
    const botData = (await botRes.json()) as any;
    expect(botData.player).toBeDefined();
    expect(botData.player.displayName).toBe("QQ Player");

    // Contract-level regression: these must reach configured shop-scoped
    // resolvers rather than fail with *_RESOLVER_NOT_CONFIGURED.
    // The shared fixture predates encrypted merchant-machine fields.
    sqlite.run("ALTER TABLE machines ADD COLUMN ha_binding_encrypted TEXT");
    sqlite.run("ALTER TABLE machines ADD COLUMN hinata_url_encrypted TEXT");
    sqlite.run("ALTER TABLE machines ADD COLUMN hinata_password_encrypted TEXT");
    sqlite.run("ALTER TABLE machines ADD COLUMN relay_connection TEXT DEFAULT 'external'");
    sqlite.run("ALTER TABLE machines ADD COLUMN relay_channel TEXT");
    for (const [actionType, target, staffOverride] of [
      ["power.off", { kind: "facility", ref: "missing-power-target" }, true],
      ["coin", { kind: "game_machine", ref: "missing-coin-target" }, false],
    ] as const) {
      const actionResponse = await app.fetch(
        new Request(`https://prism.test/api/v1/shops/${publicId}/integration/players/by-identity/device-actions`, {
          method: "POST",
          headers: botHeaders,
          body: JSON.stringify({
            identity: { provider: "qq", subject: "88889999" },
            target, action: { type: actionType },
            staffOverride,
          }),
        }),
        env,
      );
      expect(actionResponse.status).toBe(400);
      expect(((await actionResponse.json()) as any).error.code).toBe("DEVICE_NOT_FOUND");
    }

    // Koishi sends nested identity envelopes to both register and resolve.
    // This used to throw on undefined provider in normalizeExternalIdentity,
    // turning every Mahjong join/leave into HTTP 500.
    const koishiRegister = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/integration/players/by-identity/register`, {
        method: "POST",
        headers: botHeaders,
        body: JSON.stringify({
          identity: { provider: " QQ ", subject: " 99998888 " },
          autoRegister: true,
          displayName: "Koishi Mahjong Player",
        }),
      }),
      env,
    );
    expect(koishiRegister.status).toBe(200);
    const koishiData = (await koishiRegister.json()) as any;
    expect(koishiData.player.displayName).toBe("Koishi Mahjong Player");

    const koishiResolve = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/integration/players/by-identity/resolve`, {
        method: "POST",
        headers: botHeaders,
        body: JSON.stringify({ identity: { provider: "qq", subject: "99998888" } }),
      }),
      env,
    );
    expect(koishiResolve.status).toBe(200);
    expect(((await koishiResolve.json()) as any).player.id).toBe(koishiData.player.id);

    // Unexpected input is a domain validation error, never a 500.
    const malformed = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/integration/players/by-identity/register`, {
        method: "POST",
        headers: botHeaders,
        body: JSON.stringify({ identity: { subject: "99998888" } }),
      }),
      env,
    );
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as any).error.code).toBe("INVALID_EXTERNAL_IDENTITY");

    // 2. Query wallet by identity
    const walletRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/integration/players/by-identity/wallet`, {
        method: "POST",
        headers: botHeaders,
        body: JSON.stringify({
          provider: "qq",
          subject: "88889999",
        }),
      }),
      env,
    );
    expect(walletRes.status).toBe(200);
    const walletData = (await walletRes.json()) as any;
    expect(walletData.wallet).toBeDefined();
    expect(Array.isArray(walletData.wallet)).toBe(true);
  });

  it("runs Koishi's nested identity flow through real API routes and D1 (entry, table, leave, preview)", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, shopId, botToken } = await setupShopFixture(db, sqlite);
    const app = createTestApp();
    const prefix = `https://prism.test/api/v1/shops/${publicId}/integration`;
    const identity = { provider: "onebot", subject: "mahjong-guest-1" };
    const secondIdentity = { provider: "telegram", subject: "mahjong-guest-2" };
    const headers = { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json" };
    const post = (path: string, body: unknown, auth = headers) =>
      app.fetch(new Request(prefix + path, { method: "POST", headers: auth, body: JSON.stringify(body) }), env);

    try {
      const unauthorized = await post("/players/by-identity/register", { identity }, { ...headers, Authorization: "Bearer wrong-token" });
      expect(unauthorized.status).toBe(403);

      const registered = await post("/players/by-identity/register", {
        identity, displayName: "Koishi Guest", autoRegister: true,
      });
      expect(registered.status).toBe(200);
      const registeredBody = await registered.json() as { player: { id: string; displayName: string } };
      const playerId = registeredBody.player.id;
      expect(registeredBody.player.displayName).toBe("Koishi Guest");

      const entry = await post("/players/by-identity/session/start", {
        identity, label: "音游区间", entry: true,
      });
      expect(entry.status).toBe(200);
      const entryBody = await entry.json() as { session: { id: string; playerId: string } };
      expect(entryBody.session.playerId).toBe(playerId);

      const table = await post("/players/by-identity/session/start", {
        identity, label: "麻将 A 桌", entry: false,
        // Even overlapping admission pricing must not hijack the table session.
        pricingConfigIds: JSON.parse((sqlite.query(
          "SELECT entry_pricing_ids_json AS ids FROM shop_billing_settings WHERE shop_id=?",
        ).get(shopId) as { ids: string }).ids),
      });
      expect(table.status).toBe(200);
      const tableBody = await table.json() as { session: { id: string; playerId: string } };
      expect(tableBody.session.playerId).toBe(playerId);
      expect(tableBody.session.id).not.toBe(entryBody.session.id);

      const active = await app.fetch(new Request(prefix + "/sessions/active", { headers }), env);
      expect(active.status).toBe(200);
      const activeBody = await active.json() as {
        sessions: Array<{ id: string; playerId: string; label?: string; identities?: Array<{ provider: string; subject: string }> }>;
      };
      expect(activeBody.sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: entryBody.session.id, playerId, label: "entry" }),
        expect.objectContaining({ id: tableBody.session.id, playerId, label: "麻将 A 桌" }),
      ]));
      expect(activeBody.sessions.some(s => s.playerId === playerId
        && s.identities?.some(i => i.provider === "onebot" && i.subject === identity.subject))).toBe(true);

      const guest2 = await post("/players/by-identity/register", { identity: secondIdentity, displayName: "Second Guest" });
      expect(guest2.status).toBe(200);
      const forbiddenStop = await post(`/players/by-identity/sessions/${tableBody.session.id}/stop`, { identity: secondIdentity });
      expect([400, 404]).toContain(forbiddenStop.status);
      expect((await forbiddenStop.json() as { error: { code: string } }).error.code).toBe("INTEGRATION_SESSION_NOT_FOUND");
      expect((sqlite.query("SELECT status FROM sessions WHERE shop_id=? AND id=?").get(shopId, tableBody.session.id) as { status: string }).status).toBe("active");

      const leave = await post(`/players/by-identity/sessions/${tableBody.session.id}/stop`, { identity });
      expect(leave.status).toBe(200);
      expect((sqlite.query("SELECT status,payment_status FROM sessions WHERE shop_id=? AND id=?")
        .get(shopId, tableBody.session.id) as { status: string; payment_status: string })).toEqual({
        status: "closed", payment_status: "unpaid",
      });
      expect((sqlite.query("SELECT status FROM sessions WHERE shop_id=? AND id=?")
        .get(shopId, entryBody.session.id) as { status: string }).status).toBe("active");

      sqlite.run("UPDATE shop_billing_settings SET auto_register=0 WHERE shop_id=?", [shopId]);
      const blockedRegistration = await post("/players/by-identity/session/start", {
        identity: { provider: "onebot", subject: "unknown-new-player" },
        autoRegister: true, label: "麻将 A 桌", entry: false,
      });
      expect([400, 404]).toContain(blockedRegistration.status);
      expect((await blockedRegistration.json() as { error: { code: string } }).error.code)
        .toBe("PLAYER_IDENTITY_NOT_FOUND");

      const preview = await post("/players/by-identity/checkout/preview", { identity });
      expect(preview.status).toBe(200);
      const previewBody = await preview.json() as { settlementPreview?: { playerId: string }; sessionPreviews?: unknown[] };
      expect(previewBody.settlementPreview?.playerId).toBe(playerId);
      expect(previewBody.sessionPreviews?.length).toBeGreaterThanOrEqual(2);
    } finally {
      sqlite.close();
    }
  });

  it("handles platform-binding generation and confirmation via staff and integration", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, shopId, staffSessionToken, botToken } = await setupShopFixture(db, sqlite);
    const app = createTestApp();

    // 1. Create a user and player account
    const bobUserId = "user_bob";
    const bobToken = "token_bob";
    const bobTokenHash = await sha256(bobToken);
    const bobPlayerId = "player_bob";
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
      "INSERT INTO players (shop_id, id, display_name, status, created_at) VALUES (?, ?, 'Bob', 'active', CURRENT_TIMESTAMP)",
      [shopId, bobPlayerId],
    );
    sqlite.run(
      "INSERT INTO shop_player_accounts (shop_id, user_id, player_id, verified_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
      [shopId, bobUserId, bobPlayerId],
    );

    // 2. Bob requests a binding code via POST /platform-binding
    const codeRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/platform-binding`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bobToken}`,
        },
      }),
      env,
    );
    expect(codeRes.status).toBe(200);
    const codeData = (await codeRes.json()) as any;
    expect(codeData.code).toBeDefined();
    expect(codeData.code.length).toBe(8);
    const bindingCode = codeData.code;

    // 3. Confirm platform binding via bot integration
    const confirmRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/integration/platform-binding/confirm`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          code: bindingCode,
          provider: "qq",
          subject: "99887766",
        }),
      }),
      env,
    );
    expect(confirmRes.status).toBe(200);
    const confirmData = (await confirmRes.json()) as any;
    expect(confirmData.playerId).toBe(bobPlayerId);
    expect(confirmData.provider).toBe("qq");
    expect(confirmData.subject).toBe("99887766");

    // 4. Verify binding was saved in shop_platform_bindings
    const bindingRow = sqlite.query(
      "SELECT provider, subject FROM shop_platform_bindings WHERE shop_id = ? AND user_id = ?",
    ).get(shopId, bobUserId) as { provider: string; subject: string } | null;
    expect(bindingRow).toBeDefined();
    expect(bindingRow?.provider).toBe("qq");
    expect(bindingRow?.subject).toBe("99887766");
  });

  it("saves the unified location toggle despite stale legacy flags from the settings form", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, shopId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const app = createTestApp();
    const url = `https://prism.test/api/v1/shops/${publicId}/settings`;
    const headers = { Authorization: `Bearer ${staffSessionToken}`, "Content-Type": "application/json" };
    // Imported shops can still contain a mixture of the legacy switches.
    sqlite.run("UPDATE shop_billing_settings SET checkin_geo=1,checkout_geo=0,machine_geo=0 WHERE shop_id=?", [shopId]);
    for (const enabled of [false, true, false]) {
      const current = await (await app.fetch(new Request(url, { headers }), env)).json() as Record<string, unknown>;
      // Match BillingSettings: fetch latest settings, merge only the edited section.
      const response = await app.fetch(new Request(url, {
        method: "PUT", headers, body: JSON.stringify({ ...current, locationEnabled: enabled }),
      }), env);
      expect(response.status).toBe(200);
      const saved = await response.json() as Record<string, unknown>;
      const expected = { locationEnabled: enabled, checkinGeo: enabled, checkoutGeo: enabled, machineGeo: enabled };
      expect(saved).toMatchObject(expected);
      const flags = sqlite.query("SELECT checkin_geo,checkout_geo,machine_geo FROM shop_billing_settings WHERE shop_id=?").get(shopId);
      expect(flags).toEqual({ checkin_geo: +enabled, checkout_geo: +enabled, machine_geo: +enabled });
      const reloaded = await (await app.fetch(new Request(url, { headers }), env)).json();
      expect(reloaded).toMatchObject(expected);
    }
    sqlite.close();
  });

  for (const invalid of ["pricing", "balance"] as const) {
    it(`allows location edits with invalid existing ${invalid} while still validating billing changes`, async () => {
      const { db, sqlite, env } = createTestContext();
      const { publicId, shopId, staffSessionToken } = await setupShopFixture(db, sqlite);
      const app = createTestApp();
      const url = `https://prism.test/api/v1/shops/${publicId}/settings`;
      const headers = { Authorization: `Bearer ${staffSessionToken}`, "Content-Type": "application/json" };
      if (invalid === "pricing") sqlite.run("UPDATE pricing_configs SET enabled=0 WHERE shop_id=?", [shopId]);
      else sqlite.run("UPDATE asset_definitions SET status='archived' WHERE shop_id=? AND type='currency'", [shopId]);
      const current = await (await app.fetch(new Request(url, { headers }), env)).json() as Record<string, unknown>;
      const save = (patch: Record<string, unknown>) => app.fetch(new Request(url, {
        method: "PUT", headers, body: JSON.stringify({ ...current, ...patch }),
      }), env);
      const location = await save({ locationEnabled: false });
      expect(location.status).toBe(200);
      expect(await location.json()).toMatchObject({ locationEnabled: false, billingEnabled: true, billingConfiguration: { ready: false } });
      const changed = await save({ entryPricingIds: ["missing-rule"] });
      expect(changed.status).toBe(409);
      expect(await changed.json()).toMatchObject({ error: { code: "BILLING_CONFIGURATION_REQUIRED" } });
      expect((await save({ billingEnabled: false, cashierEnabled: false })).status).toBe(200);
      const enable = await save({ billingEnabled: true });
      expect(enable.status).toBe(409);
      expect(await enable.json()).toMatchObject({ error: { code: "BILLING_CONFIGURATION_REQUIRED" } });
      // Re-enabling cashier also requires a valid billing configuration.
      sqlite.run("UPDATE shop_billing_settings SET billing_enabled=1 WHERE shop_id=?", [shopId]);
      const cashier = await save({ cashierEnabled: true });
      expect(cashier.status).toBe(409);
      expect(await cashier.json()).toMatchObject({ error: { code: "BILLING_CONFIGURATION_REQUIRED" } });
      sqlite.close();
    });
  }

  it("preserves independent legacy geo gates when the unified toggle is omitted", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, shopId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const app = createTestApp();
    const config = sqlite.query<{ entry_pricing_ids_json: string }, [string]>(
      "SELECT entry_pricing_ids_json FROM shop_billing_settings WHERE shop_id=?",
    ).get(shopId);
    const response = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/settings`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${staffSessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          billingEnabled: true,
          cashierEnabled: true,
          autoRegister: true,
          identityBindingRequired: false,
          checkinGeo: true,
          checkoutGeo: false,
          machineGeo: true,
          entryPricingIds: JSON.parse(config!.entry_pricing_ids_json),
          botContact: "owner@example.test",
        }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    const flags = sqlite.query<{ checkin_geo: number; checkout_geo: number; machine_geo: number }, [string]>(
      "SELECT checkin_geo,checkout_geo,machine_geo FROM shop_billing_settings WHERE shop_id=?",
    ).get(shopId);
    expect(flags?.checkin_geo).toBe(1);
    expect(flags?.checkout_geo).toBe(0);
    expect(flags?.machine_geo).toBe(1);
  });

  it("rejects invalid checkout report ranges and archive filters with stable error codes", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const app = createTestApp();
    const base = `https://prism.test/api/v1/shops/${publicId}/staff/reports/checkouts`;
    const headers = { Authorization: `Bearer ${staffSessionToken}` };
    const invalidRange = await app.fetch(
      new Request(`${base}?from=invalid&to=2026-10-01T00:00:00.000Z`, { headers }), env,
    );
    expect(invalidRange.status).toBe(400);
    const badRange = await invalidRange.json() as { error: { code: string } };
    expect(badRange.error.code).toBe("INVALID_REPORT_RANGE");
    const invalidFilter = await app.fetch(
      new Request(`${base}?from=2026-10-01T00:00:00.000Z&to=2026-10-02T00:00:00.000Z&archive=unknown`, { headers }), env,
    );
    expect(invalidFilter.status).toBe(400);
    const badFilter = await invalidFilter.json() as { error: { code: string } };
    expect(badFilter.error.code).toBe("INVALID_REPORT_FILTER");
  });
});
