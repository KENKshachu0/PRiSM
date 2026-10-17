import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { sha256, sha256Hex } from "../src/crypto.js";
import {
  createD1DatabaseFromSqlite,
  createLocalServer,
  initializeLocalDatabase,
  initializeSqliteSchema,
  type LocalServer,
} from "../src/local-server.js";

describe("Local Server Entrypoint & Runtime", () => {
  let server: LocalServer | undefined;

  afterEach(() => {
    if (server) {
      server.stop(true);
      server = undefined;
    }
  });

  describe("createD1DatabaseFromSqlite", () => {
    it("wraps Bun SQLite database into D1DatabaseLike adapter", async () => {
      const db = new Database(":memory:");
      db.run("CREATE TABLE test_items (id TEXT PRIMARY KEY, value INTEGER);");

      const d1 = createD1DatabaseFromSqlite(db);

      await d1.prepare("INSERT INTO test_items (id, value) VALUES (?, ?);").bind("item-1", 42).run();

      const single = await d1.prepare("SELECT * FROM test_items WHERE id = ?;").bind("item-1").first<{ id: string; value: number }>();
      expect(single).toEqual({ id: "item-1", value: 42 });

      const unbound = await d1.prepare("SELECT COUNT(*) AS total FROM test_items;").bind().first<{ total: number }>();
      expect(unbound?.total).toBe(1);

      const all = await d1.prepare("SELECT * FROM test_items;").bind().all<{ id: string; value: number }>();
      expect(all.results).toHaveLength(1);
      expect(all.results[0]).toEqual({ id: "item-1", value: 42 });

      await d1.batch([
        d1.prepare("INSERT INTO test_items (id, value) VALUES (?, ?);").bind("item-2", 100),
        d1.prepare("INSERT INTO test_items (id, value) VALUES (?, ?);").bind("item-3", 200),
      ]);

      const totalAfterBatch = await d1.prepare("SELECT COUNT(*) AS total FROM test_items;").bind().first<{ total: number }>();
      expect(totalAfterBatch?.total).toBe(3);
    });

    it("preserves D1 batch SELECT results, affected-row metadata and atomic rollback", async () => {
      const sqlite = new Database(":memory:");
      sqlite.run("CREATE TABLE entries (id TEXT PRIMARY KEY, amount INTEGER NOT NULL)");
      const d1 = createD1DatabaseFromSqlite(sqlite);
      const inserted = (await d1.prepare("INSERT INTO entries VALUES (?, ?)").bind("one", 12).run()) as { meta: { changes: number } };
      expect(inserted.meta.changes).toBe(1);
      const results = await d1.batch([
        d1.prepare("INSERT INTO entries VALUES (?, ?)").bind("two", 34),
        d1.prepare("SELECT id, amount FROM entries ORDER BY id").bind(),
        d1.prepare("UPDATE entries SET amount=amount+1 WHERE id=?").bind("one"),
      ]) as Array<{ results: Array<{ id: string; amount: number }>; meta: { changes: number } }>;
      expect(results[0]?.meta.changes).toBe(1);
      expect(results[1]?.results).toEqual([
        { id: "one", amount: 12 }, { id: "two", amount: 34 },
      ]);
      expect(results[2]?.meta.changes).toBe(1);
      await expect(d1.batch([
        d1.prepare("INSERT INTO entries VALUES (?, ?)").bind("rollback", 0),
        d1.prepare("INSERT INTO entries VALUES (?, ?)").bind("one", 0),
      ])).rejects.toThrow();
      expect(sqlite.query("SELECT id FROM entries WHERE id='rollback'").get()).toBeNull();
      sqlite.close();
    });
  });

  describe("initializeLocalDatabase", () => {
    it("initializes SQLite schema and provisions admin user and default shop idempotently", () => {
      const db = new Database(":memory:");

      initializeLocalDatabase(db, "test-shop");

      // Verify schema tables exist
      const playersTable = db.query("PRAGMA table_info(players);").all();
      expect(playersTable.length).toBeGreaterThan(0);

      const shopsTable = db.query("PRAGMA table_info(shops);").all();
      expect(shopsTable.length).toBeGreaterThan(0);

      const billingTable = db.query("PRAGMA table_info(shop_billing_settings);").all();
      expect(billingTable.length).toBeGreaterThan(0);

      // Verify default admin exists
      const adminUser = db.query<{ id: string; role: string }, []>(
        "SELECT id, role FROM users WHERE role = 'admin' LIMIT 1;",
      ).get();
      expect(adminUser).toBeDefined();
      expect(adminUser?.role).toBe("admin");

      // Verify default shop exists
      const shop = db.query<{ id: string; public_id: string; name: string }, [string]>(
        "SELECT id, public_id, name FROM shops WHERE public_id = ? LIMIT 1;",
      ).get("test-shop");
      expect(shop).toBeDefined();
      expect(shop?.public_id).toBe("test-shop");

      // Verify billing settings exist
      const billing = db.query<{ shop_id: string; billing_enabled: number }, [string]>(
        "SELECT shop_id, billing_enabled FROM shop_billing_settings WHERE shop_id = ? LIMIT 1;",
      ).get("test-shop");
      expect(billing).toBeDefined();
      expect(billing?.billing_enabled).toBe(1);

      // Verify idempotency on second run
      expect(() => initializeLocalDatabase(db, "test-shop")).not.toThrow();
      const shopCount = db.query<{ total: number }, []>(
        "SELECT COUNT(*) AS total FROM shops WHERE public_id = 'test-shop';",
      ).get();
      expect(shopCount?.total).toBe(1);
    });

    it("exports initializeSqliteSchema as an alias for initializeLocalDatabase", () => {
      expect(initializeSqliteSchema).toBe(initializeLocalDatabase);
      const db = new Database(":memory:");
      initializeSqliteSchema(db);
      const usersTable = db.query("PRAGMA table_info(users);").all();
      expect(usersTable.length).toBeGreaterThan(0);
    });
  });

  describe("createLocalServer", () => {
    it("boots with in-memory SQLite database and responds to HTTP requests", async () => {
      server = createLocalServer({
        db: new Database(":memory:"),
        port: 0,
        defaultShopCode: "default",
      });

      expect(server).toBeDefined();
      expect(server.port).toBeGreaterThan(0);

      // 1. Health check endpoint
      const healthRes = await server.fetch(new Request(`http://localhost:${server.port}/health`));
      expect(healthRes.status).toBe(200);
      const healthJson = await healthRes.json() as { ok: boolean; status: string };
      expect(healthJson.ok).toBe(true);
      expect(healthJson.status).toBe("healthy");

      // 2. Unauthenticated player me request
      const unauthLegacy = await server.fetch(new Request(`http://localhost:${server.port}/api/v1/player/me`));
      expect(unauthLegacy.status).toBe(401);

      const unauthShop = await server.fetch(new Request(`http://localhost:${server.port}/api/v1/shops/default/player/me`));
      expect(unauthShop.status).toBe(401);

      // 3. Authenticated player request
      const userId = "usr-test-player-1";
      const sessionToken = "session-test-token-xyz";
      const tokenHash = await sha256(sessionToken);
      const expiresAt = new Date(Date.now() + 86400000).toISOString();

      server.db.run(
        "INSERT INTO users (id, role, created_at, updated_at) VALUES (?, 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        [userId],
      );
      server.db.run(
        "INSERT INTO auth_identities (id, user_id, provider, provider_subject, username, display_name, created_at, updated_at) VALUES ('id-1', ?, 'local', 'player1', 'player1', 'Player One', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        [userId],
      );
      server.db.run(
        "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('sess-1', ?, ?, ?, CURRENT_TIMESTAMP)",
        [userId, tokenHash, expiresAt],
      );

      const authShopRes = await server.fetch(
        new Request(`http://localhost:${server.port}/api/v1/shops/default/player/me`, {
          headers: { Authorization: `Bearer ${sessionToken}` },
        }),
      );
      expect(authShopRes.status).toBe(200);
      const authShopJson = await authShopRes.json() as { data: { player: { id: string } } };
      expect(authShopJson.data.player).toBeDefined();
      expect(authShopJson.data.player.id).toBeDefined();

      const authLegacyRes = await server.fetch(
        new Request(`http://localhost:${server.port}/api/v1/player/me`, {
          headers: { Authorization: `Bearer ${sessionToken}` },
        }),
      );
      expect(authLegacyRes.status).toBe(200);
      const authLegacyJson = await authLegacyRes.json() as { data: { player: { id: string } } };
      expect(authLegacyJson.data.player.id).toBe(authShopJson.data.player.id);
    });

  });
});
