import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createApp } from "../src/app.js";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { clearShopDependenciesCache } from "../src/middleware/tenant.js";
import { sha256 } from "../src/crypto.js";
import { mintResourceTicket } from "../src/routes/platform/resource-ticket.js";
import type { Env } from "../src/bindings.js";

const NOW = new Date().toISOString();
const PLAYER = "player-token";
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

async function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=OFF");
  const migrations = resolve(import.meta.dir, "../../../migrations");
  for (const name of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort())
    for (const sql of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) sqlite.run(sql);

  for (const [user, token] of [["player-user", PLAYER], ["owner-user", OWNER]] as const) {
    sqlite.run("INSERT INTO users(id,role,created_at,updated_at) VALUES (?,'user',?,?)", [user, NOW, NOW]);
    sqlite.run("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,?)",
      [`auth-${user}`, user, await sha256(token), new Date(Date.now() + 86_400_000).toISOString()]);
  }
  sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('shop','shop-code','Arcade',0,0,80,'owner-user')");
  sqlite.run("INSERT INTO shop_members(id,shop_id,user_id,role) VALUES ('m1','shop','owner-user','owner')");
  sqlite.run(`INSERT INTO shop_billing_settings(shop_id,auto_register,identity_binding_required)
    VALUES ('shop',1,0)`);
  // Every resource without a group of its own bills through the default group.
  sqlite.run("INSERT INTO resource_groups(shop_id,id,name,enabled,default_pricing_config_id,created_at,updated_at) VALUES ('shop','default','默认资源组',1,'base',?,?)", [NOW, NOW]);
  sqlite.run("INSERT INTO asset_definitions(shop_id,type,code,name,stackable,status) VALUES ('shop','currency','paid','余额',1,'active')");
  sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('shop','p1','P1','active',?)", [NOW]);
  sqlite.run("INSERT INTO shop_player_accounts(shop_id,user_id,player_id,verified_at) VALUES ('shop','player-user','p1',?)", [NOW]);

  // The design's game area and rest area: both stack on base play and exclude each other.
  plan(sqlite, "base");
  plan(sqlite, "play", { requires: ["base"], conflicts: ["rest"] });
  plan(sqlite, "rest", { requires: ["base"] });
  plan(sqlite, "special", { requires: ["base"] });

  const resource = (id: string, group: string | null, override: string | null = null) =>
    sqlite.run(
      "INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted,resource_group_id,pricing_config_override_id) VALUES (?,?,'shop',?,'',?,?)",
      [id, id, id, group, override],
    );
  const group = (id: string, planId: string | null) =>
    sqlite.run("INSERT INTO resource_groups(shop_id,id,name,default_pricing_config_id,created_at,updated_at) VALUES ('shop',?,?,?,?,?)",
      [id, id, planId, NOW, NOW]);
  group("game", "play");
  group("rest-area", "rest");
  group("unpriced", null);
  resource("cabinet", "game");
  resource("rest-entrance", "rest-area");
  resource("special-cabinet", "game", "special");
  resource("front-desk", null);
  resource("loose", "unpriced");

  const env = { DB: createD1DatabaseFromSqlite(sqlite), SESSION_SECRET: "session-secret", URL_ENCRYPTION_KEY: "unit-test-key" } as unknown as Env;
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
  const scan = async (publicId: string) => {
    const { ticket } = await mintResourceTicket(env.SESSION_SECRET, "shop-code", publicId);
    const bootstrap = await call("GET", `/api/v1/devices/session/bootstrap?ticket=${encodeURIComponent(ticket)}`, PLAYER);
    const confirm = (extra: Record<string, unknown> = {}) =>
      call("POST", "/api/v1/shops/shop-code/player/session/start", PLAYER, { ticket, consent: true, operationId: crypto.randomUUID(), ...extra });
    return { state: bootstrap.body.state, machine: bootstrap.body.machine, confirm };
  };
  const active = () => (sqlite.query(
    "SELECT json_extract(pricing_config_ids_json,'$[0]') AS plan, started_at AS startedAt FROM sessions WHERE status='active' ORDER BY plan",
  ).all() as { plan: string; startedAt: string }[]);
  return { sqlite, call, scan, active, app, env };
}

describe("scanning a resource", () => {
  beforeEach(() => clearShopDependenciesCache());
  afterEach(() => clearShopDependenciesCache());

  it("bills through the group's plan, previews first and starts nothing on read", async () => {
    const { scan, active } = await fixture();
    const { state, confirm } = await scan("cabinet");

    expect(state.gate).toBe("entry");
    expect(state.billing.preview).toMatchObject({ pricingConfigId: "play", changed: true });
    expect(state.billing.preview.started.map((item: { planId: string }) => item.planId)).toEqual(["base", "play"]);
    expect(active()).toEqual([]);

    const confirmed = await confirm({ expectedRevision: state.billing.preview.revision });
    expect(confirmed.status).toBe(200);
    expect(active().map((s) => s.plan)).toEqual(["base", "play"]);
    expect((await scan("cabinet")).state.gate).toBe("ready");
  });

  it("switches play to rest through another group's resource, keeping base running", async () => {
    const { scan, active } = await fixture();
    await (await scan("cabinet")).confirm();
    const baseStarted = active().find((s) => s.plan === "base")!.startedAt;

    const { state, confirm } = await scan("rest-entrance");
    expect(state.billing.preview).toMatchObject({ pricingConfigId: "rest" });
    expect(state.billing.preview.stopped.map((item: { planId: string }) => item.planId)).toEqual(["play"]);
    expect(state.billing.preview.kept.map((item: { planId: string }) => item.planId)).toEqual(["base"]);

    expect((await confirm({ expectedRevision: state.billing.preview.revision })).status).toBe(200);
    expect(active().map((s) => s.plan)).toEqual(["base", "rest"]);
    expect(active().find((s) => s.plan === "base")!.startedAt).toBe(baseStarted);
  });

  it("refuses a confirmation previewed against a state that has since changed", async () => {
    const { scan, active } = await fixture();
    const stale = await scan("rest-entrance");
    await (await scan("cabinet")).confirm();

    const refused = await stale.confirm({ expectedRevision: stale.state.billing.preview.revision });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.error.code).toBe("PRICING_STATE_REVISION_MISMATCH");
    expect(active().map((s) => s.plan)).toEqual(["base", "play"]);
  });

  it("bills a resource's own plan instead of its group's", async () => {
    const { scan, active } = await fixture();
    await (await scan("special-cabinet")).confirm();
    expect(active().map((s) => s.plan)).toEqual(["base", "special"]);
  });

  it("describes the plans a resource bills: its own first, then what it requires", async () => {
    const { scan } = await fixture();
    const own = (await scan("special-cabinet")).state.billing.rules;
    expect(own.source).toEqual({ kind: "resource" });
    expect(own.plans.map((plan: { config: { id: string }; role: string; requiredBy?: string }) => [plan.config.id, plan.role, plan.requiredBy ?? null]))
      .toEqual([["special", "resource", null], ["base", "required", "special"]]);
    expect(own.plans[0].config.provider.rules[0].pricing.unitPrice).toBeDefined();

    const grouped = (await scan("rest-entrance")).state.billing.rules;
    expect(grouped.source).toEqual({ kind: "group", groupName: "rest-area" });
    expect(grouped.plans.map((plan: { config: { id: string } }) => plan.config.id)).toEqual(["rest", "base"]);
  });

  it("states each cap over the plans and what was charged in its window before now", async () => {
    const { scan, sqlite } = await fixture();
    const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`).toISOString();
    sqlite.run(
      `INSERT INTO pricing_configs(shop_id,id,kind,name,enabled,status,provider_json,created_at,updated_at)
       VALUES ('shop','daily','time.cap','每日封顶',1,'active',?,?,?)`,
      [JSON.stringify({ id: "daily", timeZone: "UTC", includedPricingConfigIds: ["base", "play"],
        rules: [{ id: "day", label: "每日", priority: 0, timeRange: { start: "00:00", end: "00:00" }, priceCap: 300 }] }), NOW, NOW],
    );
    // An earlier visit today, already settled: 1.50 on base, 2.00 against the 3.00 daily cap.
    sqlite.run(
      `INSERT INTO pricing_history_entries(shop_id,id,player_id,pricing_config_id,provider_id,rule_id,rule_anchor_at,session_id,amount,created_at)
       VALUES ('shop','h1','p1','base','base','base-rule',?,'old',150,?)`,
      [today, NOW],
    );
    sqlite.run(
      `INSERT INTO pricing_cap_history_entries(shop_id,id,player_id,cap_config_id,cap_rule_id,cap_anchor_at,included_pricing_config_ids_json,session_ids_json,amount,created_at)
       VALUES ('shop','c1','p1','daily','day',?,'["base","play"]','["old"]',200,?)`,
      [today, NOW],
    );

    const caps = (await scan("cabinet")).state.billing.rules.caps;
    expect(caps.plans.map((cap: { pricingConfigId: string; ruleLabel: string; priceCap: number; paidBefore: number }) =>
      [cap.pricingConfigId, cap.ruleLabel, cap.priceCap, cap.paidBefore]).sort()).toEqual([["base", "全天", 1000, 1.5], ["play", "全天", 1000, 0]]);
    expect(caps.shared).toMatchObject([{ pricingConfigId: "daily", name: "每日封顶", ruleLabel: "每日", priceCap: 3, paidBefore: 2, includedPricingConfigIds: ["base", "play", "rest", "special"] }]);

    // Base has been running since earlier today: what it charged so far counts too.
    await (await scan("rest-entrance")).confirm();
    const since = new Date(Math.max(Date.parse(today), Date.now() - 30 * 60_000) - 1000).toISOString();
    sqlite.run("UPDATE sessions SET started_at=? WHERE status='active'", [since]);
    const later = (await scan("cabinet")).state.billing.rules.caps;
    expect(later.plans.find((cap: { pricingConfigId: string }) => cap.pricingConfigId === "base").paidBefore).toBe(2.5);
    // Base and rest charged 1.00 each, but only 1.00 was left under the daily cap: it is full.
    expect(later.shared[0].paidBefore).toBe(3);
  });

  it("bills a resource without a group of its own through the default group's plan", async () => {
    const { scan, active } = await fixture();
    const { state, confirm } = await scan("front-desk");
    expect(state.billing.preview.pricingConfigId).toBe("base");
    await confirm();
    expect(active().map((s) => s.plan)).toEqual(["base"]);
  });

  it("lets a player use a resource of a group without a plan for free, with nothing to confirm or start", async () => {
    const { scan, active } = await fixture();
    const { state, confirm } = await scan("loose");
    expect(state.gate).toBe("ready");
    expect(state.billing).toBeNull();
    expect((await confirm()).body.error.code).toBe("RESOURCE_NOT_BILLED");
    expect(active()).toEqual([]);
  });

  it("still answers billingEnabled for released App Clips, derived from the plans", async () => {
    const { scan, call, sqlite } = await fixture();
    // The App Clip decodes the shop overview's billingEnabled as a required field.
    const overview = async () => (await call("GET", "/api/v1/shops/shop-code?pricing=raw", PLAYER)).body.shop.billingEnabled;
    expect(await overview()).toBe(true);
    // On a scanned resource it answers for that resource.
    expect((await scan("cabinet")).machine).toMatchObject({ billed: true, shop: { billingEnabled: true } });
    expect((await scan("loose")).machine).toMatchObject({ billed: false, shop: { billingEnabled: false } });
    sqlite.run("UPDATE resource_groups SET default_pricing_config_id=NULL WHERE id='default'");
    sqlite.run("UPDATE resource_groups SET default_pricing_config_id=NULL");
    sqlite.run("UPDATE machines SET pricing_config_override_id=NULL");
    expect(await overview()).toBe(false);
  });

  it("leaves the default group free once its plan is cleared", async () => {
    const { scan, sqlite } = await fixture();
    sqlite.run("UPDATE resource_groups SET default_pricing_config_id=NULL WHERE id='default'");
    expect((await scan("front-desk")).state.gate).toBe("ready");
    // Other groups keep billing by their own plans.
    expect((await scan("cabinet")).state.gate).toBe("entry");
  });

  it("tells the player, in their words, when a plan this resource needs is disabled", async () => {
    const { scan, sqlite } = await fixture();
    sqlite.run("UPDATE pricing_configs SET enabled=0 WHERE id='base'");
    const { state } = await scan("special-cabinet");
    expect(state.billing.error).toEqual({ code: "PRICING_REQUIREMENT_UNAVAILABLE", message: "这里依赖的计费方案已停用，请联系店员" });
  });
});

describe("resource groups", () => {
  beforeEach(() => clearShopDependenciesCache());
  afterEach(() => clearShopDependenciesCache());

  it("tells connected bots to reread their settings when a group's or the default plan changes", async () => {
    const { app, env } = await fixture();
    let told = 0;
    (env as unknown as Record<string, unknown>).SHOP_HUB = { getByName: () => ({ botsChanged: async () => { told++; } }) };
    const pending: Promise<unknown>[] = [];
    const patch = async (path: string, body: unknown) => {
      await app.fetch(new Request(`https://prism.test${path}`, {
        method: "PATCH", headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json" }, body: JSON.stringify(body),
      }), env, { waitUntil: (promise: Promise<unknown>) => pending.push(promise), passThroughOnException() {} } as never);
      await Promise.all(pending.splice(0));
    };
    await patch("/api/v1/merchant/resource-groups/game", { shopId: "shop", defaultPricingConfigId: null });
    await patch("/api/v1/merchant/resource-groups/default", { shopId: "shop", defaultPricingConfigId: "special" });
    // A bot's cached billingEnabled would otherwise keep refusing or admitting entry.
    expect(told).toBe(2);
  });

  it("edits the default group like any other, except that it cannot be deleted", async () => {
    const { call, sqlite, scan } = await fixture();
    const listed = await call("GET", "/api/v1/merchant/resource-groups?shopId=shop", OWNER);
    expect(listed.body.resourceGroups[0]).toMatchObject({ id: "default", isDefault: true, defaultPricingConfigId: "base", resourceCount: 1 });

    const renamed = await call("PATCH", "/api/v1/merchant/resource-groups/default", OWNER, { shopId: "shop", name: "大厅", defaultPricingConfigId: "special" });
    expect(renamed.body.resourceGroup).toMatchObject({ id: "default", name: "大厅", defaultPricingConfigId: "special" });
    expect(sqlite.query("SELECT default_pricing_config_id AS plan FROM resource_groups WHERE id='default'").get()).toEqual({ plan: "special" });
    // Pausing it pauses the resources that have no group of their own.
    await call("PATCH", "/api/v1/merchant/resource-groups/default", OWNER, { shopId: "shop", enabled: false });
    expect((await scan("front-desk")).state.billing.error.code).toBe("RESOURCE_GROUP_DISABLED");
    expect((await call("DELETE", "/api/v1/merchant/resource-groups/default?shopId=shop", OWNER)).status).toBe(400);
  });

  it("treats a shop without a stored default group as a free one", async () => {
    const { scan, sqlite } = await fixture();
    sqlite.run("DELETE FROM resource_groups WHERE id='default'");
    expect((await scan("front-desk")).state.gate).toBe("ready");
  });

  it("creates a group, moves a resource into it and refuses to delete it while used", async () => {
    const { call, scan, active } = await fixture();
    const created = await call("POST", "/api/v1/merchant/resource-groups", OWNER, { shopId: "shop", name: "包间", defaultPricingConfigId: "special" });
    expect(created.status).toBe(201);
    const groupId = created.body.resourceGroup.id;

    const moved = await call("PATCH", "/api/v1/merchant/machines/front-desk", OWNER, { resourceGroupId: groupId });
    expect(moved.body.machine).toMatchObject({ resourceGroupId: groupId, pricingConfigOverrideId: null });
    await (await scan("front-desk")).confirm();
    expect(active().map((s) => s.plan)).toEqual(["base", "special"]);

    expect((await call("DELETE", `/api/v1/merchant/resource-groups/${groupId}?shopId=shop`, OWNER)).body.error.code).toBe("RESOURCE_GROUP_IN_USE");
    await call("PATCH", "/api/v1/merchant/machines/front-desk", OWNER, { resourceGroupId: "default" });
    expect((await call("DELETE", `/api/v1/merchant/resource-groups/${groupId}?shopId=shop`, OWNER)).status).toBe(200);
  });

  it("refuses archiving a plan a group, the default group or a resource bills through", async () => {
    const { call } = await fixture();
    const archive = (id: string) => call("POST", `/api/v1/shops/shop-code/staff/pricing-configs/${id}/archive`, OWNER);
    const refused = await archive("special");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: "PRICING_CONFIG_IN_USE" });
    expect(refused.body.error.message).toContain("资源「special-cabinet」");
    expect((await archive("base")).body.error.message).toContain("默认资源组");
  });

  it("refuses a plan that is not a time plan of the shop", async () => {
    const { call } = await fixture();
    const refused = await call("POST", "/api/v1/merchant/resource-groups", OWNER, { shopId: "shop", name: "X", defaultPricingConfigId: "missing" });
    expect(refused.body.error.code).toBe("RESOURCE_PRICING_INVALID");
    const override = await call("PATCH", "/api/v1/merchant/machines/cabinet", OWNER, { pricingConfigOverrideId: "missing" });
    expect(override.body.error.code).toBe("RESOURCE_PRICING_INVALID");
  });
});
