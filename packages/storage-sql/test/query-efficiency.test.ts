import { centsOf as moneyFixture, centsOfInteger as integerFixture } from "@prism/core";
import { centsOf, yuanOf } from "@prism/core";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createSqlRepositories, sqliteSchema, type SqlExecutor, type SqlValue } from "../src";

test("SQL repositories batch repeated reads and writes", async () => {
  const db = new Database(":memory:");
  for (const statement of sqliteSchema) db.run(statement);
  const now = new Date("2026-07-14T00:00:00.000Z");
  db.run("INSERT INTO players (id, display_name, status, created_at) VALUES (?, ?, ?, ?)", [
    "player-1", "Player", "active", now.toISOString(),
  ]);
  db.run("INSERT INTO sessions (id, player_id, started_at, ended_at, status, payment_status) VALUES (?, ?, ?, ?, ?, ?)", [
    "session-1", "player-1", now.toISOString(), now.toISOString(), "closed", "unpaid",
  ]);

  const statements: string[] = [];
  let id = 0;
  const repositories = createSqlRepositories({
    executor: countingExecutor(sqliteExecutor(db), statements),
    id: () => `generated-${++id}`,
    now: () => now,
  });

  statements.length = 0;
  await repositories.assets.commitAssetTransaction({
    transaction: {
      id: "asset-tx-1",
      playerId: "player-1",
      kind: "test",
      refId: "ref-1",
      createdAt: now,
      metadata: null,
    },
    holdingChanges: {
      upserts: [
        { id: "holding-1", assetType: "currency", assetCode: "paid", quantity: centsOf(10) },
        { id: "holding-2", assetType: "currency", assetCode: "free", quantity: centsOf(5) },
      ],
      deleteIds: [],
    },
    assetLedgerEntries: [
      { assetType: "currency", assetCode: "paid", delta: centsOf(10), reason: "test", refId: "ref-1" },
      { assetType: "currency", assetCode: "free", delta: centsOf(5), reason: "test", refId: "ref-2" },
    ],
  });
  expect(statements).toHaveLength(3);
  expect(statements.some((statement) => statement.includes("DELETE FROM asset_holdings WHERE player_id"))).toBe(false);

  statements.length = 0;
  await repositories.pricingHistory.appendEntries([
    pricingHistoryEntry("history-1", "rule-1", now),
    pricingHistoryEntry("history-2", "rule-2", now),
  ]);
  expect(statements).toHaveLength(1);

  statements.length = 0;
  await repositories.pricingHistory.sumByPlayerAndKeys("player-1", [
    { pricingConfigId: "pricing-1", providerId: "provider-1", ruleId: "rule-1", ruleAnchorAt: now },
    { pricingConfigId: "pricing-1", providerId: "provider-1", ruleId: "rule-2", ruleAnchorAt: now },
  ]);
  expect(statements).toHaveLength(1);

  statements.length = 0;
  await repositories.settlements.saveSettlement({
    settlement: { sessionId: "session-1", subtotal: centsOf(10), total: centsOf(8), status: "settled", settledAt: now },
    chargeItems: [
      { id: "charge-1", source: "pricing", label: "Usage", amount: moneyFixture(10) },
      { id: "charge-2", source: "pricing", label: "Fee", amount: moneyFixture(2) },
    ],
    adjustments: [{ id: "adjustment-1", source: "coupon", label: "Coupon", amount: moneyFixture(-4) }],
  });
  expect(statements).toHaveLength(5);

  statements.length = 0;
  const settlement = await repositories.settlements.findSettlementBySessionId("session-1");
  expect(statements).toHaveLength(1);
  expect(settlement?.chargeItems).toHaveLength(2);
  expect(settlement?.adjustments).toHaveLength(1);
});

function sqliteExecutor(db: Database): SqlExecutor {
  return {
    async first<T>(sql: string, params: readonly SqlValue[] = []) {
      return (db.query(sql).get(...params) as T | null) ?? null;
    },
    async all<T>(sql: string, params: readonly SqlValue[] = []) {
      return db.query(sql).all(...params) as T[];
    },
    async run(sql: string, params: readonly SqlValue[] = []) {
      db.run(sql, [...params]);
    },
    async batch(statements) {
      db.run("BEGIN");
      try {
        for (const statement of statements) db.run(statement.sql, [...(statement.params ?? [])]);
        db.run("COMMIT");
      } catch (error) {
        db.run("ROLLBACK");
        throw error;
      }
    },
  };
}

function pricingHistoryEntry(id: string, ruleId: string, at: Date) {
  return {
    id,
    playerId: "player-1",
    pricingConfigId: "pricing-1",
    providerId: "provider-1",
    ruleId,
    ruleAnchorAt: at,
    sessionId: "session-1",
    amount: centsOf(1),
    createdAt: at,
    metadata: null,
  };
}

function countingExecutor(base: SqlExecutor, statements: string[]): SqlExecutor {
  return {
    first(sql, params) {
      statements.push(sql);
      return base.first(sql, params);
    },
    all(sql, params) {
      statements.push(sql);
      return base.all(sql, params);
    },
    run(sql, params) {
      statements.push(sql);
      return base.run(sql, params);
    },
    batch(batch) {
      statements.push(...batch.map((statement) => statement.sql));
      return base.batch(batch);
    },
  };
}
