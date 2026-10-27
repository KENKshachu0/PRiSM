import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import type { AppBindings, Env } from "../src/bindings.js";
import { resourceSessionRouter } from "../src/routes/platform/resource-session.js";
import { clearShopDependenciesCache, getOrCreateShopDependencies } from "../src/middleware/tenant.js";
import { findLegacyShopByCode } from "../src/legacy/tenant-resolver.js";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { mintResourceTicket } from "../src/routes/platform/resource-ticket.js";
import { attachUser } from "../src/middleware/auth.js";
import { sha256 } from "../src/crypto.js";
import { errorResponse } from "../src/http-errors.js";

const NOW = new Date("2026-10-20T04:00:00.000Z").toISOString();

function plan(sqlite: Database, id: string, unitPriceCents: number, relations?: { requires?: string[]; conflicts?: string[] }, enabled = 1) {
  sqlite.run(
    `INSERT INTO pricing_configs(shop_id,id,kind,name,enabled,status,provider_json,created_at,updated_at)
     VALUES ('shop-1',?,'time.priority',?,?,'active',?,?,?)`,
    [id, id, enabled, JSON.stringify({
      id, timeZone: "UTC",
      rules: [{ id: `${id}-rule`, label: "全天", priority: 0, timeRange: { start: "00:00", end: "00:00" },
        pricing: { unitMinutes: 60, unitPrice: unitPriceCents, roundGraceMinutes: 0, priceCap: 100000 } }],
      ...(relations ? { relations: { requires: relations.requires ?? [], conflicts: relations.conflicts ?? [] } } : {}),
    }), NOW, NOW],
  );
}

async function fixture(tablePlan = "mahjong-eight", waitingPlan?: string) {
  const sqlite = new Database(":memory:");
  const migrations = resolve(import.meta.dir, "../../../migrations");
  for (const name of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort())
    for (const statement of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) sqlite.run(statement);

  sqlite.run("INSERT INTO users(id,role,created_at,updated_at) VALUES ('owner','user',?,?)", [NOW, NOW]);
  sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('shop-1','shop-code','Arcade',0,0,80,'owner')");
  sqlite.run(`INSERT INTO shop_billing_settings(shop_id,billing_enabled,auto_register,identity_binding_required)
    VALUES ('shop-1',1,1,0)`);
  // Every resource without a group of its own bills through the default group.
  sqlite.run("INSERT INTO resource_groups(shop_id,id,name,enabled,default_pricing_config_id,created_at,updated_at) VALUES ('shop-1','default','默认资源组',1,'normal-play',?,?)", [NOW, NOW]);
  plan(sqlite, "normal-play", 1300);
  plan(sqlite, "mahjong-four", -200, { requires: ["normal-play"] });
  plan(sqlite, "mahjong-eight", 200, { requires: ["normal-play"], conflicts: ["mahjong-four"] });
  plan(sqlite, "switched-off", 100, {}, 0);
  plan(sqlite, "mahjong-broken", 200, { requires: ["switched-off"] });
  // Waiting for a table is free; playing bills on top of base play and ends the wait.
  plan(sqlite, "mahjong-wait", 0);
  plan(sqlite, "mahjong-play", 200, { requires: ["normal-play"], conflicts: ["mahjong-wait"] });
  // A table can also bill a fixed charge, once per game.
  sqlite.run(
    `INSERT INTO pricing_configs(shop_id,id,kind,name,enabled,status,provider_json,created_at,updated_at)
     VALUES ('shop-1','mahjong-ticket','charge.fixed','mahjong-ticket',1,'active',?,?,?)`,
    [JSON.stringify({ id: "mahjong-ticket", label: "一局", amount: 15 }), NOW, NOW],
  );
  sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted,capacity) VALUES ('table-1','t1','shop-1','麻将 A 桌','',2)");
  sqlite.run(
    `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
     VALUES ('shop-1','table-1','mahjong',?,'{}',?,?)`,
    [JSON.stringify({ pricingConfigIds: [tablePlan] }), NOW, NOW],
  );
  // The table's own plan is what a seat bills while the table waits to fill.
  if (waitingPlan) sqlite.run("UPDATE machines SET pricing_config_override_id=? WHERE id='table-1'", [waitingPlan]);

  for (const n of [1, 2, 3]) {
    sqlite.run("INSERT INTO users(id,role,created_at,updated_at) VALUES (?,'user',?,?)", [`user-${n}`, NOW, NOW]);
    sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('shop-1',?,?,'active',?)", [`p${n}`, `P${n}`, NOW]);
    sqlite.run("INSERT INTO shop_player_accounts(shop_id,user_id,player_id,verified_at) VALUES ('shop-1',?,?,?)", [`user-${n}`, `p${n}`, NOW]);
    sqlite.run("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,?)",
      [`auth-${n}`, `user-${n}`, await sha256(`token-${n}`), new Date(Date.now() + 86_400_000).toISOString()]);
  }

  const env = { DB: createD1DatabaseFromSqlite(sqlite), SESSION_SECRET: "session-secret", URL_ENCRYPTION_KEY: "unit-test-key" } as unknown as Env;
  const app = new Hono<AppBindings>();
  app.onError((err, c) => errorResponse(c, err, "test"));
  app.use("*", attachUser);
  app.route("/api/v1/devices", resourceSessionRouter);
  const { ticket } = await mintResourceTicket(env.SESSION_SECRET, "shop-code", "t1");

  const shop = (await findLegacyShopByCode(env.DB, "shop-code"))!;
  const deps = () => getOrCreateShopDependencies(env.DB, shop, env.URL_ENCRYPTION_KEY, env);
  // Entry names its plan, as a staff start does; there is no default plan.
  const enter = (playerId: string) => deps().playerCommands.startSession({ playerId, pricingConfigIds: ["normal-play"] });
  /** What confirming on the table's page does. */
  const confirmTable = (playerId: string) => deps().resourceBilling.activate({ resourceId: "table-1", playerId });
  const gate = async (player: number) => {
    const response = await app.fetch(new Request(`https://prism.test/api/v1/devices/session/state?ticket=${encodeURIComponent(ticket)}&includePower=0&includeClimate=0`, {
      headers: { authorization: `Bearer token-${player}` },
    }), env);
    return (await response.json() as { gate: string }).gate;
  };
  const act = async (action: string, player: number) => {
    const response = await app.fetch(new Request("https://prism.test/api/v1/devices/session/actions", {
      method: "POST",
      headers: { authorization: `Bearer token-${player}`, "content-type": "application/json" },
      body: JSON.stringify({ ticket, action, operationId: crypto.randomUUID() }),
    }), env);
    return { status: response.status, body: await response.json() as any };
  };
  const active = (playerId: string) => (sqlite.query(
    "SELECT json_extract(pricing_config_ids_json,'$[0]') AS plan, started_at AS startedAt FROM sessions WHERE player_id=? AND status='active' ORDER BY plan",
  ).all(playerId) as { plan: string; startedAt: string }[]);
  const seats = () => (sqlite.query("SELECT player_id AS player FROM mahjong_seats ORDER BY player_id").all() as { player: string }[]).map((row) => row.player);
  const preview = (playerId: string) => deps().playerCheckoutCommands.previewCheckout({ playerId });
  return { sqlite, enter, confirmTable, gate, act, active, seats, preview };
}

describe("mahjong seating through the pricing session orchestrator", () => {
  beforeEach(() => clearShopDependenciesCache());
  afterEach(() => clearShopDependenciesCache());

  it("bills the table plan for everyone once the table fills, on top of their running base play", async () => {
    const { enter, act, active } = await fixture();
    await enter("p1");
    await enter("p2");
    const baseStarted = active("p1")[0]!.startedAt;

    expect((await act("mahjong.join", 1)).status).toBe(200);
    expect(active("p1").map((s) => s.plan)).toEqual(["normal-play"]);

    expect((await act("mahjong.join", 2)).status).toBe(200);
    expect(active("p1").map((s) => s.plan)).toEqual(["mahjong-eight", "normal-play"]);
    expect(active("p2").map((s) => s.plan)).toEqual(["mahjong-eight", "normal-play"]);
    expect(active("p1").find((s) => s.plan === "normal-play")!.startedAt).toBe(baseStarted);
    expect(active("p1").find((s) => s.plan === "mahjong-eight")!.startedAt)
      .toBe(active("p2").find((s) => s.plan === "mahjong-eight")!.startedAt);
  });

  it("bills a table whose plan is a fixed charge once for each player", async () => {
    const { enter, act, active, preview } = await fixture("mahjong-ticket");
    await enter("p1");
    await enter("p2");
    expect((await act("mahjong.join", 1)).status).toBe(200);
    expect((await act("mahjong.join", 2)).status).toBe(200);
    expect(active("p1").map((s) => s.plan)).toEqual(["mahjong-ticket", "normal-play"]);
    expect(active("p2").map((s) => s.plan)).toEqual(["mahjong-ticket", "normal-play"]);
    const charges = (await preview("p1")).chargeItems.filter((item) => item.source === "mahjong-ticket");
    expect(charges.map((item) => item.label)).toEqual(["一局"]);
    expect(Number(charges[0]!.amount)).toBeGreaterThan(0);
  });

  it("stops only the leaver's table plan and keeps base play running", async () => {
    const { sqlite, enter, act, active, seats } = await fixture();
    await enter("p1");
    await enter("p2");
    await act("mahjong.join", 1);
    await act("mahjong.join", 2);

    expect((await act("mahjong.leave", 1)).status).toBe(200);
    expect(active("p1").map((s) => s.plan)).toEqual(["normal-play"]);
    expect(active("p2").map((s) => s.plan)).toEqual(["mahjong-eight", "normal-play"]);
    expect(seats()).toEqual(["p2"]);
    expect(sqlite.query("SELECT payment_status AS paid FROM sessions WHERE player_id='p1' AND status='closed'").all())
      .toEqual([{ paid: "unpaid" }]);

  });

  it("starts a later joiner at once while the table is already playing", async () => {
    const { enter, act, active } = await fixture();
    for (const p of ["p1", "p2", "p3"]) await enter(p);
    await act("mahjong.join", 1);
    await act("mahjong.join", 2);
    await act("mahjong.leave", 2);

    expect((await act("mahjong.join", 3)).status).toBe(200);
    expect(active("p3").map((s) => s.plan)).toEqual(["mahjong-eight", "normal-play"]);
  });

  it("frees the seat when a switch ends the table plan", async () => {
    const { sqlite, enter, act, active, seats } = await fixture();
    await enter("p1");
    await enter("p2");
    await act("mahjong.join", 1);
    await act("mahjong.join", 2);
    // mahjong-four conflicts with the table's mahjong-eight.
    const db = createD1DatabaseFromSqlite(sqlite);
    const shop = (await findLegacyShopByCode(db, "shop-code"))!;
    await getOrCreateShopDependencies(db, shop).pricingSessions.activate({ playerId: "p1", pricingConfigId: "mahjong-four" });

    expect(active("p1").map((s) => s.plan)).toEqual(["mahjong-four", "normal-play"]);
    expect(seats()).toEqual(["p2"]);
  });

  it("still requires an entry before seating", async () => {
    const { act, seats } = await fixture();
    const refused = await act("mahjong.join", 1);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("CHECKIN_REQUIRED");
    expect(seats()).toEqual([]);
  });

  it("does not seat a newcomer when the table cannot bill everyone", async () => {
    const { enter, act, active, seats } = await fixture("mahjong-broken");
    await enter("p1");
    await enter("p2");
    await act("mahjong.join", 1);

    const refused = await act("mahjong.join", 2);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.error.code).toBe("PRICING_REQUIREMENT_UNAVAILABLE");
    expect(seats()).toEqual(["p1"]);
    expect(active("p1").map((s) => s.plan)).toEqual(["normal-play"]);
    expect(active("p2").map((s) => s.plan)).toEqual(["normal-play"]);
  });
});

describe("a mahjong seat that waits on its own plan", () => {
  beforeEach(() => clearShopDependenciesCache());
  afterEach(() => clearShopDependenciesCache());

  it("switches everyone from waiting to playing when the table fills, keeping the seat and anyone's running base play", async () => {
    const { enter, confirmTable, gate, act, active, seats } = await fixture("mahjong-play", "mahjong-wait");
    // P1 only waits; P2 plays music meanwhile.
    await confirmTable("p1");
    await enter("p2");
    await confirmTable("p2");
    const baseStarted = active("p2").find((s) => s.plan === "normal-play")!.startedAt;
    expect((await act("mahjong.join", 1)).status).toBe(200);
    expect(active("p1").map((s) => s.plan)).toEqual(["mahjong-wait"]);

    expect((await act("mahjong.join", 2)).status).toBe(200);
    expect(active("p1").map((s) => s.plan)).toEqual(["mahjong-play", "normal-play"]);
    expect(active("p2").map((s) => s.plan)).toEqual(["mahjong-play", "normal-play"]);
    expect(active("p2").find((s) => s.plan === "normal-play")!.startedAt).toBe(baseStarted);
    // The waiting session ended with the switch, but the seats follow the table plan.
    expect(seats()).toEqual(["p1", "p2"]);
    // Sitting at a playing table counts as using it: no confirmation that would switch back.
    expect(await gate(1)).toBe("ready");

    // Getting up ends the table plan only; base play keeps billing until checkout.
    const left = await act("mahjong.leave", 1);
    expect(left.status).toBe(200);
    expect(left.body.billing).toEqual({ remaining: ["normal-play"] });
    expect(active("p1").map((s) => s.plan)).toEqual(["normal-play"]);
    expect(seats()).toEqual(["p2"]);
  });

  it("ends the waiting session started for the table when its player gets up before the table fills", async () => {
    const { confirmTable, act, active, seats } = await fixture("mahjong-play", "mahjong-wait");
    await confirmTable("p1");
    await act("mahjong.join", 1);
    expect((await act("mahjong.leave", 1)).status).toBe(200);
    expect(active("p1")).toEqual([]);
    expect(seats()).toEqual([]);
  });

  it("keeps a plan the player was already billing elsewhere when they get up from a waiting table", async () => {
    const { enter, act, active } = await fixture();
    await enter("p1");
    await act("mahjong.join", 1);
    expect((await act("mahjong.leave", 1)).status).toBe(200);
    expect(active("p1").map((s) => s.plan)).toEqual(["normal-play"]);
  });
});

