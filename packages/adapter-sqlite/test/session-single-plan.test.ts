import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { closeSession, startSession, type PricingConfig, type Session, type SessionTransitionWrite } from "@prism/core";
import { splitD1MigrationStatements, sqliteSchema } from "@prism/storage-sql";
import { createSqliteRepositories } from "../src/index";

const at = new Date("2026-10-24T10:00:00.000Z");

function createDb() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  for (const statement of sqliteSchema) db.run(statement);
  db.run("INSERT INTO players (id, display_name, status, created_at) VALUES ('player-1', 'Neri', 'active', ?)", [at.toISOString()]);
  return db;
}

function repositoriesOf(db: Database) {
  return createSqliteRepositories({ db, id: () => crypto.randomUUID(), now: () => at });
}

const session = (id: string, plan: string): Session & { status: "active" } =>
  startSession({ playerId: "player-1", now: at, id, pricingConfigId: plan });

function transition(close: Session[], create: Session[]): SessionTransitionWrite {
  return { close, create };
}

describe("single-plan sessions in SQL", () => {
  it("reads a single-plan row back with its plan, and a placeholder without one", async () => {
    const repositories = repositoriesOf(createDb());
    await repositories.sessions.save(session("s-1", "play"));
    await repositories.sessions.save(startSession({ playerId: "player-1", now: at, id: "s-2", pricingConfigIds: ["default"] }));

    expect((await repositories.sessions.findById("s-1"))?.pricingConfigId).toBe("play");
    expect((await repositories.sessions.findById("s-2"))?.pricingConfigId).toBeUndefined();
  });

  it("refuses a second active session of the same plan for one player", async () => {
    const repositories = repositoriesOf(createDb());
    await repositories.sessions.save(session("s-1", "play"));
    await expect(repositories.sessions.save(session("s-2", "play"))).rejects.toMatchObject({ code: "PRICING_PLAN_ALREADY_ACTIVE" });

    await repositories.sessions.save(closeSession({ session: session("s-1", "play"), now: at }));
    await repositories.sessions.save(session("s-3", "play"));
    expect((await repositories.sessions.findActiveByPlayerId("player-1")).map((s) => s.id)).toEqual(["s-3"]);
  });

  it("switches plans atomically at one instant", async () => {
    const repositories = repositoriesOf(createDb());
    const base = session("base", "base");
    const eight = session("eight", "eight");
    await repositories.sessions.applyTransition!(transition([], [base, eight]));

    const later = new Date(at.getTime() + 60_000);
    await repositories.sessions.applyTransition!(
      transition([closeSession({ session: eight, now: later })], [startSession({ playerId: "player-1", now: later, id: "four", pricingConfigId: "four" })]),
    );

    const active = await repositories.sessions.findActiveByPlayerId("player-1");
    expect(active.map((s) => s.pricingConfigId).sort()).toEqual(["base", "four"]);
    expect(active.find((s) => s.id === "base")?.startedAt).toEqual(at);
    const closed = await repositories.sessions.findById("eight");
    expect(closed).toMatchObject({ status: "closed", paymentStatus: "unpaid", endedAt: later });
    expect((await repositories.sessions.findById("four"))?.startedAt).toEqual(later);
  });

  it("commits nothing when one part of a transition is refused", async () => {
    const repositories = repositoriesOf(createDb());
    const base = session("base", "base");
    const eight = session("eight", "eight");
    await repositories.sessions.applyTransition!(transition([], [base, eight]));

    const later = new Date(at.getTime() + 60_000);
    await expect(
      repositories.sessions.applyTransition!(
        transition([closeSession({ session: eight, now: later })], [startSession({ playerId: "player-1", now: later, id: "base-2", pricingConfigId: "base" })]),
      ),
    ).rejects.toMatchObject({ code: "PRICING_PLAN_ALREADY_ACTIVE" });

    expect((await repositories.sessions.findById("eight"))?.status).toBe("active");
    expect(await repositories.sessions.findById("base-2")).toBeNull();
  });
});

describe("migration 0039", () => {
  const dir = new URL("../../../migrations/", import.meta.url);
  const migrate = (db: Database, before: boolean) => {
    for (const name of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
      if (before ? name >= "0039" : name < "0039") continue;
      // Statement by statement, as D1 applies them: bun's multi-statement exec
      // does not surface an error raised before the last statement.
      for (const statement of splitD1MigrationStatements(readFileSync(new URL(name, dir), "utf8"))) db.run(statement);
    }
  };
  const seed = (db: Database, rows: [string, string, string, string][]) => {
    // Only the session rows matter here; the platform rows they hang off are not modelled.
    db.run("PRAGMA foreign_keys = OFF");
    db.run("INSERT INTO shops (id, public_id, name, latitude, longitude, radius_meters, created_by) VALUES ('shop', 'shop-code', 'Shop', 0, 0, 80, 'owner')");
    db.run("INSERT INTO players (shop_id, id, display_name, status, created_at) VALUES ('shop', 'p', 'P', 'active', '2026-01-01')");
    for (const [id, status, payment, plans] of rows)
      db.run(
        "INSERT INTO sessions (shop_id, id, player_id, started_at, status, payment_status, pricing_config_ids_json) VALUES ('shop', ?, 'p', '2026-01-01T00:00:00.000Z', ?, ?, ?)",
        [id, status, payment, plans],
      );
  };

  it("keeps settled multi-plan history and indexes only single-plan active rows", () => {
    const db = new Database(":memory:");
    migrate(db, true);
    seed(db, [
      ["paid-multi", "closed", "paid", '["a","b"]'],
      ["placeholder", "active", "unpaid", '["default"]'],
      ["play", "active", "unpaid", '["a"]'],
    ]);
    migrate(db, false);

    expect(db.query("SELECT pricing_config_ids_json AS ids FROM sessions WHERE id = 'paid-multi'").get()).toEqual({ ids: '["a","b"]' });
    expect(() =>
      db.run("INSERT INTO sessions (shop_id, id, player_id, started_at, status, pricing_config_ids_json) VALUES ('shop', 'dup', 'p', '2026-01-02', 'active', '[\"a\"]')"),
    ).toThrow("idx_sessions_active_plan");
    db.run("INSERT INTO sessions (shop_id, id, player_id, started_at, status, pricing_config_ids_json) VALUES ('shop', 'placeholder-2', 'p', '2026-01-02', 'active', '[\"default\"]')");
  });

  it("refuses to run while a multi-plan session is still open", () => {
    const db = new Database(":memory:");
    migrate(db, true);
    seed(db, [["open-multi", "closed", "unpaid", '["a","b"]']]);
    expect(() => migrate(db, false)).toThrow("CHECK constraint failed");
  });
});

describe("pricing relations in SQL", () => {
  const plan = (id: string, relations?: { requires: string[]; conflicts: string[] }): PricingConfig => ({
    id,
    kind: "time.priority",
    name: id,
    enabled: true,
    status: "active",
    provider: {
      id: `time.${id}`,
      rules: [{
        id: "all-day",
        label: "All day",
        priority: 0,
        timeRange: { start: "00:00", end: "00:00" },
        pricing: { unitMinutes: 60, unitPrice: 2, roundGraceMinutes: 0, priceCap: 100 },
      }],
    },
    ...(relations ? { relations } : {}),
    createdAt: at,
    updatedAt: at,
  });

  it("versions relations with the plan and leaves unrelated plans untouched", async () => {
    const repositories = repositoriesOf(createDb());
    await repositories.pricingConfigs.save(plan("base"));
    await repositories.pricingConfigs.save(plan("eight", { requires: ["base"], conflicts: ["four"] }));

    const eight = await repositories.pricingConfigs.findById("eight");
    expect(eight).toMatchObject({ relations: { requires: ["base"], conflicts: ["four"] } });
    expect(eight?.provider).not.toHaveProperty("relations");
    expect(await repositories.pricingConfigs.findById("base")).not.toHaveProperty("relations");

    const baseVersion = (await repositories.pricingConfigs.findById("base"))?.version;
    await repositories.pricingConfigs.save(plan("base", { requires: [], conflicts: [] }));
    expect((await repositories.pricingConfigs.findById("base"))?.version).toBe(baseVersion);

    await repositories.pricingConfigs.save(plan("eight", { requires: ["base"], conflicts: [] }));
    const next = await repositories.pricingConfigs.findById("eight");
    expect(next?.version).toBe((eight?.version ?? 0) + 1);
    expect(next).toMatchObject({ relations: { requires: ["base"], conflicts: [] } });
  });
});
