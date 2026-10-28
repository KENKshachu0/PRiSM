import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createApp } from "../src/app.js";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { clearShopDependenciesCache } from "../src/middleware/tenant.js";
import { sha256, sha256Hex } from "../src/crypto.js";
import type { Env } from "../src/bindings.js";

const NOW = new Date().toISOString();
const OWNER = "owner-token";

/**
 * A bot credential names its shop: Koishi is configured with an address and a
 * token, never a shop code. Rotating a credential keeps the resource it belongs
 * to, and a credential from before bots were resources gets one on first use.
 */
async function fixture() {
  const sqlite = new Database(":memory:");
  const migrations = resolve(import.meta.dir, "../../../migrations");
  for (const name of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort())
    for (const sql of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) sqlite.run(sql);
  sqlite.run("INSERT INTO users(id,role,created_at,updated_at) VALUES ('owner-user','user',?,?)", [NOW, NOW]);
  sqlite.run("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ('auth','owner-user',?,?)",
    [await sha256(OWNER), new Date(Date.now() + 86_400_000).toISOString()]);
  sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('shop','shop-code','Arcade',0,0,80,'owner-user')");
  sqlite.run("INSERT INTO shop_members(id,shop_id,user_id,role) VALUES ('m1','shop','owner-user','owner')");
  const env = { DB: createD1DatabaseFromSqlite(sqlite), SESSION_SECRET: "session-secret", URL_ENCRYPTION_KEY: "unit-test-key" } as unknown as Env;
  const app = createApp();
  const call = async (method: string, path: string, body?: unknown, token = OWNER) => {
    const response = await app.fetch(new Request(`https://prism.test${path}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
    return { status: response.status, body: (await response.json() as any)?.data };
  };
  const machines = () => (sqlite.query("SELECT id FROM machines WHERE shop_id='shop'").all() as { id: string }[]);
  /**
   * What a bot reads over its connection. The connection is the entry point:
   * the credential alone names the shop, and the hub then runs the read through
   * the shop's own routes with that credential (here against the same app).
   */
  const readBot = async (token: string) => {
    const bot = await call("GET", "/api/v1/shops/shop-code/integration/bot", undefined, token);
    return { status: bot.status, body: bot.body };
  };
  return { sqlite, call, machines, readBot };
}

describe("a bot credential names its shop", () => {
  beforeEach(() => clearShopDependenciesCache());
  afterEach(() => clearShopDependenciesCache());

  it("reads the shop and the bot's settings by credential alone", async () => {
    const { call, readBot } = await fixture();
    const created = await call("POST", "/api/v1/merchant/machines", { shopId: "shop", name: "店铺 Bot", bot: {} });
    const boot = await readBot(created.body.botToken);
    expect(boot.status).toBe(200);
    expect(boot.body.shop).toEqual({ code: "shop-code", name: "Arcade" });
    expect(boot.body.bot.id).toBe(created.body.machine.id);
    expect((await readBot("not-a-token")).status).toBe(403);
  });

  it("keeps one resource when its credential is rotated, and retires the old one", async () => {
    const { call, machines, readBot } = await fixture();
    const created = await call("POST", "/api/v1/merchant/machines", { shopId: "shop", name: "店铺 Bot", bot: {} });
    const id = created.body.machine.id;
    expect(machines()).toHaveLength(1);
    // Exactly what the bot panel's rotate submit sends.
    const rotated = await call("PATCH", `/api/v1/merchant/machines/${id}`, { shopId: "shop", name: "店铺 Bot", bot: created.body.machine.bot, rotateBotToken: true });
    expect(rotated.status).toBe(200);
    expect(rotated.body.machine.id).toBe(id);
    expect(rotated.body.botToken).toMatch(/^prism_integration_/);
    // The announcement settings round-trip like the rest.
    const announcing = await call("PATCH", `/api/v1/merchant/machines/${id}`, {
      shopId: "shop", name: "店铺 Bot",
      bot: { ...rotated.body.machine.bot, announceChannelIds: ["onebot:42"], announceStarts: true, doorPasswordOnEntry: true },
    });
    expect(announcing.status).toBe(200);
    expect(announcing.body.machine.bot).toMatchObject({
      announceChannelIds: ["onebot:42"], announceStarts: true, announcePower: false, doorPasswordOnEntry: true,
    });
    // The bot is told to hand out a door code on entry, and only when the shop says so.
    expect((await readBot(rotated.body.botToken)).body.settings.doorPasswordOnEntry).toBe(true);
    expect(machines()).toHaveLength(1);
    expect((await readBot(rotated.body.botToken)).body.bot.id).toBe(id);
    expect((await readBot(created.body.botToken)).status).toBe(403);
  });

  it("gives a credential from before bots were resources its own, in the default group", async () => {
    const { sqlite, call, readBot } = await fixture();
    sqlite.run("INSERT INTO api_tokens(shop_id,id,label,role,token_prefix,token_hash,status,created_at) VALUES ('shop','old','旧 Bot','integration','prism_integration',?, 'active',?)",
      [await sha256Hex("legacy-token"), NOW]);
    const boot = await readBot("legacy-token");
    expect(boot.status).toBe(200);
    expect(boot.body.bot.name).toBe("旧 Bot");
    const row = sqlite.query("SELECT resource_group_id AS grp FROM machines WHERE id=?").get(boot.body.bot.id) as { grp: string | null };
    expect(row.grp).toBeNull();
  });

  it("carries every live integration credential into a bot resource when the migration runs", async () => {
    const { sqlite, call, machines, readBot } = await fixture();
    sqlite.run("INSERT INTO api_tokens(shop_id,id,label,role,token_prefix,token_hash,status,created_at) VALUES ('shop','live','店铺 Bot','integration','prism_integration',?,'active',?)", [await sha256Hex("live-token"), NOW]);
    sqlite.run("INSERT INTO api_tokens(shop_id,id,label,role,token_prefix,token_hash,status,created_at) VALUES ('shop','gone','旧凭据','integration','prism_integration',?,'revoked',?)", [await sha256Hex("gone-token"), NOW]);
    const migration = resolve(import.meta.dir, "../../../migrations/0043_legacy_bot_resources.sql");
    for (const sql of splitD1MigrationStatements(readFileSync(migration, "utf8"))) sqlite.run(sql);
    expect(machines()).toHaveLength(1);
    const bot = sqlite.query("SELECT m.id, m.name FROM machines m").get() as { id: string; name: string };
    expect(bot.name).toBe("店铺 Bot");
    const boot = await readBot("live-token");
    expect(boot.body.bot.id).toBe(bot.id);
    // Running it again adds nothing.
    for (const sql of splitD1MigrationStatements(readFileSync(migration, "utf8"))) sqlite.run(sql);
    expect(machines()).toHaveLength(1);
  });
});
