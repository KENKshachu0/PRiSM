import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createApp } from "../src/app.js";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { clearShopDependenciesCache } from "../src/middleware/tenant.js";
import { sha256 } from "../src/crypto.js";
import type { Env } from "../src/bindings.js";
import { createOccupancy } from "../src/resources/occupancy/service.js";

const NOW = new Date().toISOString();
const OWNER = "owner-token";

function plan(sqlite: Database, id: string, relations?: { requires?: string[]; conflicts?: string[] }) {
  sqlite.run(
    `INSERT INTO pricing_configs(shop_id,id,kind,name,enabled,status,provider_json,created_at,updated_at)
     VALUES ('shop',?,'time.priority',?,1,'active',?,?,?)`,
    [id, id, JSON.stringify({
      id, timeZone: "UTC",
      rules: [{ id: `${id}-rule`, label: "全天", priority: 0, timeRange: { start: "00:00", end: "00:00" },
        pricing: { unitMinutes: 60, unitPrice: 100, roundGraceMinutes: 0, priceCap: 100000 } }],
      ...(relations ? { relations: { requires: relations.requires ?? [], conflicts: relations.conflicts ?? [] } } : {}),
    }), NOW, NOW],
  );
}

async function fixture_() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=OFF");
  const migrations = resolve(import.meta.dir, "../../../migrations");
  for (const name of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort())
    for (const sql of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) sqlite.run(sql);
  sqlite.run("INSERT INTO users(id,role,created_at,updated_at) VALUES ('owner-user','user',?,?)", [NOW, NOW]);
  sqlite.run("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ('auth','owner-user',?,?)",
    [await sha256(OWNER), new Date(Date.now() + 86_400_000).toISOString()]);
  sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('shop','shop-code','Arcade',0,0,80,'owner-user')");
  sqlite.run("INSERT INTO shop_members(id,shop_id,user_id,role) VALUES ('m1','shop','owner-user','owner')");
  sqlite.run(`INSERT INTO shop_billing_settings(shop_id,auto_register,identity_binding_required)
    VALUES ('shop',1,0)`);
  // Every resource without a group of its own bills through the default group.
  sqlite.run("INSERT INTO resource_groups(shop_id,id,name,enabled,default_pricing_config_id,created_at,updated_at) VALUES ('shop','default','默认资源组',1,'base',?,?)", [NOW, NOW]);
  sqlite.run("INSERT INTO asset_definitions(shop_id,type,code,name,stackable,status) VALUES ('shop','currency','paid','余额',1,'active')");
  plan(sqlite, "base");
  plan(sqlite, "rhythm", { requires: ["base"] });
  plan(sqlite, "night", { conflicts: ["base"] });
  sqlite.run("INSERT INTO resource_groups(shop_id,id,name,enabled,default_pricing_config_id,created_at,updated_at) VALUES ('shop','rhythm-zone','音游区',1,'rhythm',?,?)", [NOW, NOW]);
  // A two-player cabinet; Dave plays on it without billing anything.
  sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted,capacity,aliases_json) VALUES ('cab','cab-pub','shop','maimai','',2,'[\"mai\"]')");
  sqlite.run(`INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
    VALUES ('shop','cab','hinata_io','{}','{}',?,?)`, [NOW, NOW]);
  sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('shop','dave','Dave','active',?)", [NOW]);
  // Carol left every plan but has not paid: only her bill remains.
  sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('shop','carol','Carol','active',?)", [NOW]);
  sqlite.run("INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) VALUES ('shop','carol','onebot','303',?)", [NOW]);
  sqlite.run(`INSERT INTO sessions(shop_id,id,player_id,started_at,ended_at,status,pricing_config_ids_json,payment_status,label)
    VALUES ('shop','carol-visit','carol',?,?,'closed','["base"]','unpaid','entry')`, [NOW, NOW]);

  const db = createD1DatabaseFromSqlite(sqlite);
  const env = { DB: db, SESSION_SECRET: "session-secret", URL_ENCRYPTION_KEY: "unit-test-key" } as unknown as Env;
  const app = createApp();
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await app.fetch(new Request(`https://prism.test${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
    const json = await response.json() as any;
    return { status: response.status, body: json?.data ?? json };
  };
  const createBot = async (name: string, resourceGroupId?: string) => {
    const created = await call("POST", "/api/v1/merchant/machines", OWNER, {
      shopId: "shop", name, bot: {}, ...(resourceGroupId ? { resourceGroupId } : {}),
    });
    const token = created.body.botToken as string;
    return {
      id: created.body.machine.id as string,
      get: (path: string) => call("GET", `/api/v1/shops/shop-code/integration/${path}`, token),
      post: (path: string, body: unknown) => call("POST", `/api/v1/shops/shop-code/integration/${path}`, token, body),
    };
  };
  // The shop's bot sits in the default group; the rhythm bot in 音游区.
  const bot = await createBot("店铺 Bot");
  const rhythmBot = await createBot("音游 Bot", "rhythm-zone");
  const staff = {
    get: (path: string) => call("GET", `/api/v1/shops/shop-code/staff/${path}`, OWNER),
    post: (path: string, body: unknown) => call("POST", `/api/v1/shops/shop-code/staff/${path}`, OWNER, body),
  };
  return { sqlite, db, call, bot, rhythmBot, staff };
}

const alice = { identity: { provider: "onebot", subject: "101" }, displayName: "Alice" };
const bob = { identity: { provider: "onebot", subject: "202" }, displayName: "Bob" };

describe("one way to start a plan", () => {
  beforeEach(() => clearShopDependenciesCache());
  afterEach(() => clearShopDependenciesCache());

  it("starts the default plan for the bot once, then reports it as already billing", async () => {
    const { bot } = await fixture_();
    const first = await bot.post("players/by-identity/session/start", alice);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ created: true, planName: "base", billing: { changed: true, started: ["base"], stopped: [] } });

    const again = await bot.post("players/by-identity/session/start", alice);
    expect(again.body).toMatchObject({ created: false, planName: "base", billing: { changed: false, started: [] } });
    expect(again.body.session.id).toBe(first.body.session.id);
  });

  it("starts the plan of the bot's resource group, or the bot's own plan, and ignores a plan the request names", async () => {
    const { call, bot, rhythmBot } = await fixture_();
    expect((await rhythmBot.post("players/by-identity/session/start", alice)).body)
      .toMatchObject({ created: true, planName: "rhythm", billing: { started: expect.arrayContaining(["rhythm", "base"]) } });
    expect((await bot.post("players/by-identity/session/start", { ...bob, pricingConfigId: "rhythm" })).body)
      .toMatchObject({ created: true, planName: "base" });

    // Its own plan replaces its group's; a disabled group admits nobody.
    await call("PATCH", `/api/v1/merchant/machines/${bot.id}`, OWNER, { shopId: "shop", pricingConfigOverrideId: "night" });
    expect((await bot.post("players/by-identity/session/start", alice)).body)
      .toMatchObject({ created: true, planName: "night", billing: { started: ["night"] } });
    await call("PATCH", "/api/v1/merchant/resource-groups/rhythm-zone", OWNER, { shopId: "shop", enabled: false });
    expect((await rhythmBot.post("players/by-identity/session/start", bob)).body.error.code).toBe("RESOURCE_GROUP_DISABLED");
  });

  it("tells each bot whether entering through it bills, by its own resource group", async () => {
    const { call, bot, rhythmBot, sqlite } = await fixture_();
    const flag = async (target: typeof bot) => (await target.get("bot")).body.billingEnabled;
    expect(await flag(bot)).toBe(true);
    expect(await flag(rhythmBot)).toBe(true);
    // The default group turns free: its bot no longer bills, the other group's still does.
    sqlite.run("UPDATE resource_groups SET default_pricing_config_id=NULL WHERE id='default'");
    expect(await flag(bot)).toBe(false);
    expect(await flag(rhythmBot)).toBe(true);
    expect((await bot.post("players/by-identity/session/start", alice)).body.error.code).toBe("RESOURCE_NOT_BILLED");
    // Its own plan bills even in a free group.
    await call("PATCH", `/api/v1/merchant/machines/${bot.id}`, OWNER, { shopId: "shop", pricingConfigOverrideId: "night" });
    expect(await flag(bot)).toBe(true);
  });

  it("lets staff preview what a plan stops, and refuses a start previewed against another state", async () => {
    const { bot, staff } = await fixture_();
    const entered = await bot.post("players/by-identity/session/start", alice);
    const playerId = entered.body.session.playerId as string;

    const preview = await staff.post(`players/${playerId}/session/preview`, { pricingConfigId: "night" });
    expect(preview.body).toMatchObject({ planName: "night", changed: true, started: ["night"], stopped: ["base"] });

    const stale = await staff.post(`players/${playerId}/session/start`, { pricingConfigId: "night", expectedRevision: "stale" });
    expect(stale.status).toBe(409);

    const started = await staff.post(`players/${playerId}/session/start`, { pricingConfigId: "night", expectedRevision: preview.body.revision });
    expect(started.status).toBe(200);
    expect(started.body.billing).toMatchObject({ created: true, started: ["night"], stopped: ["base"] });

    const two = await staff.post(`players/${playerId}/session/start`, { pricingConfigIds: ["base", "night"] });
    expect(two.body.error?.code ?? two.body.code).toBe("PRICING_CONFIG_SINGLE_PLAN_REQUIRED");
  });
});

describe("the roster", () => {
  beforeEach(() => clearShopDependenciesCache());
  afterEach(() => clearShopDependenciesCache());

  async function populated() {
    const fixture = await fixture_();
    const { db, bot, rhythmBot } = fixture;
    await bot.post("players/by-identity/session/start", alice);
    // Bob bills rhythm and the base play it requires.
    await rhythmBot.post("players/by-identity/session/start", bob);
    const occupancy = createOccupancy({ db, shopId: "shop" });
    const at = Date.now();
    await occupancy.observe({ resourceId: "cab", at: new Date(at - 2000), event: { kind: "action", action: "coin", playerId: "dave" } });
    // A card nobody bound here is not anyone.
    await occupancy.observe({ resourceId: "cab", at: new Date(at - 1000), event: { kind: "signal", name: "card.consumed", payload: {}, playerId: null } });
    return fixture;
  }

  it("lists everyone who plays or bills once, at the resource they occupy or their most specific plan", async () => {
    const { bot, staff } = await populated();
    const roster = (await bot.get("roster")).body;
    // Carol only owes a bill: she is not in the shop.
    expect(roster.total).toBe(3);
    expect(roster.groups.map((group: any) => [group.kind, group.name, group.capacity, group.members.map((m: any) => m.displayName)])).toEqual([
      ["plan", "base", undefined, ["Alice"]],
      ["plan", "rhythm", undefined, ["Bob"]],
      ["resource", "maimai", 2, ["Dave"]],
    ]);
    expect((await staff.get("roster")).body).toEqual(roster);
  });

  it("lists one resource by name or alias, or everyone billing one plan", async () => {
    const { bot } = await populated();
    expect((await bot.get("roster?name=mai")).body.groups[0].members.map((m: any) => m.displayName)).toEqual(["Dave"]);
    // Bob is listed under rhythm, but he bills base too.
    expect((await bot.get("roster?name=base")).body.groups[0].members.map((m: any) => m.displayName).sort()).toEqual(["Alice", "Bob"]);
    expect((await bot.get("roster?name=nowhere")).status).toBe(404);
  });

  it("tells whether one player is in the shop, what they bill and what they occupy", async () => {
    const { bot, staff } = await populated();
    expect((await bot.post("players/by-identity/presence", bob)).body).toMatchObject({
      inShop: true, occupying: [], plans: expect.arrayContaining([expect.objectContaining({ planName: "rhythm" }), expect.objectContaining({ planName: "base" })]),
    });
    expect((await bot.post("players/by-identity/presence", { identity: { provider: "onebot", subject: "303" } })).body)
      .toEqual({ inShop: false, plans: [], occupying: [] });
    const live = (await staff.get("live-players")).body;
    expect(live.roster.total).toBe(3);
    // Carol stays on the staff list to be checked out.
    expect(live.players.map((player: any) => player.displayName).sort()).toEqual(["Alice", "Bob", "Carol"]);
  });
});
