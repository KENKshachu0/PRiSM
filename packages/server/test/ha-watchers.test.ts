import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { D1BoundStatementLike, D1DatabaseLike, SqlValue } from "@prism/adapter-d1";
import type { AppBindings, Env } from "../src/bindings.js";
import { merchantHaRouter } from "../src/routes/platform/merchant-ha.js";
import { errorResponse } from "../src/http-errors.js";
import { DEFAULT_WATCHERS, MAX_WATCHERS, readWatcherLimit } from "../src/resources/capabilities/ha-watchers.js";

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
    CREATE TABLE shops(id TEXT PRIMARY KEY, public_id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE app_settings(shop_id TEXT,key TEXT,value_json TEXT,updated_at TEXT,PRIMARY KEY(shop_id,key));
    CREATE TABLE shop_members(shop_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(shop_id,user_id));
    INSERT INTO shops VALUES ('shop-1','code-1','One'),('shop-2','code-2','Two');
    INSERT INTO shop_members VALUES ('shop-1','owner-1','owner');
  `);
  const db = new SqliteD1(sqlite);
  const env = { DB: db, SESSION_SECRET: "s" } as unknown as Env;
  const app = new Hono<AppBindings>();
  // The platform's own error handler, which turns a bad body into a 422.
  app.onError((err, c) => errorResponse(c, err, "test"));
  app.use("*", async (c, next) => {
    const role = c.req.header("x-test-role");
    if (role) c.set("user", { id: role === "admin" ? "admin-1" : "owner-1", role: role as "admin" | "user", username: role, displayName: role, bannedAt: null });
    await next();
  });
  app.route("/api/v1/merchant", merchantHaRouter);
  const put = (shopId: string | null, body: unknown, role: string | null = "admin") =>
    app.fetch(new Request(`https://prism.test/api/v1/merchant/ha-watchers${shopId === null ? "" : `?shopId=${shopId}`}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(role ? { "x-test-role": role } : {}) },
      body: JSON.stringify(body),
    }), env);
  return { db, put };
}

describe("a shop's number of Home Assistant watchers", () => {
  it("defaults to two", async () => {
    const { db } = fixture();
    expect(await readWatcherLimit(db, "shop-1")).toBe(DEFAULT_WATCHERS);
    expect(DEFAULT_WATCHERS).toBe(2);
  });

  it("is changed by the platform administrator, for the one shop named", async () => {
    const { db, put } = fixture();
    const response = await put("shop-1", { count: 3 });
    expect(response.status).toBe(200);
    expect((await response.json()) as { count: number }).toEqual({ count: 3 });
    expect(await readWatcherLimit(db, "shop-1")).toBe(3);
    expect(await readWatcherLimit(db, "shop-2")).toBe(DEFAULT_WATCHERS);
    // A shop the administrator is not a member of is still theirs to set.
    expect((await put("shop-2", { count: 1 })).status).toBe(200);
    expect(await readWatcherLimit(db, "shop-2")).toBe(1);
  });

  it("is not the shop owner's to change, even for their own shop", async () => {
    const { db, put } = fixture();
    const response = await put("shop-1", { count: 4 }, "user");
    expect(response.status).toBe(403);
    expect(await readWatcherLimit(db, "shop-1")).toBe(DEFAULT_WATCHERS);
  });

  it("needs someone signed in", async () => {
    const { put } = fixture();
    expect((await put("shop-1", { count: 3 }, null)).status).toBe(401);
  });

  it("refuses a number out of range, one that is not a whole number, and a shop that does not exist", async () => {
    const { db, put } = fixture();
    for (const count of [0, -1, MAX_WATCHERS + 1, 1.5, "2", null]) {
      expect((await put("shop-1", { count })).status).toBe(422);
    }
    expect((await put("nope", { count: 2 })).status).toBe(404);
    expect((await put(null, { count: 2 })).status).toBe(400);
    expect(await readWatcherLimit(db, "shop-1")).toBe(DEFAULT_WATCHERS);
  });

  it("falls back to the default for a stored value that is not a valid number", async () => {
    const { db } = fixture();
    await db.prepare("INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES (?,?,?,?)")
      .bind("shop-1", "devices.ha_watcher_limit", JSON.stringify({ count: 99 }), "2026-01-01").run();
    expect(await readWatcherLimit(db, "shop-1")).toBe(DEFAULT_WATCHERS);
  });
});
