import { centsOf } from "@prism/core";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createBunSqliteExecutor } from "@prism/adapter-sqlite";
import { sqliteSchema, type SqlExecutor } from "@prism/storage-sql";
import { createRuntimeQueries } from "../src";

test("runtime read models execute one SQL statement each", async () => {
  const db = new Database(":memory:");
  for (const statement of sqliteSchema) db.run(statement);
  const now = new Date("2026-07-14T00:00:00.000Z");
  db.run("INSERT INTO players (id, display_name, status, created_at) VALUES (?, ?, ?, ?)", [
    "player-1", "Player", "active", now.toISOString(),
  ]);
  db.run("INSERT INTO player_identities (player_id, provider, subject, created_at) VALUES (?, ?, ?, ?)", [
    "player-1", "qq", "10001", now.toISOString(),
  ]);
  db.run("INSERT INTO asset_definitions (type, code, name, stackable, status) VALUES (?, ?, ?, ?, ?)", [
    "currency", "paid", "余额", 1, "active",
  ]);
  db.run("INSERT INTO asset_definitions (type, code, name, stackable, status) VALUES (?, ?, ?, ?, ?)", [
    "currency", "legacy", "旧余额", 1, "archived",
  ]);
  db.run("INSERT INTO asset_holdings (id, player_id, asset_type, asset_code, quantity) VALUES (?, ?, ?, ?, ?)", [
    "holding-1", "player-1", "currency", "paid", 1000,
  ]);
  db.run("INSERT INTO asset_holdings (id, player_id, asset_type, asset_code, quantity) VALUES (?, ?, ?, ?, ?)", [
    "holding-2", "player-1", "currency", "legacy", 9900,
  ]);
  db.run("INSERT INTO asset_ledger_entries (id, player_id, asset_type, asset_code, delta, reason, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    "ledger-1", "player-1", "currency", "paid", 1000, "test", "ref-1", now.toISOString(),
  ]);
  db.run("INSERT INTO sessions (id, player_id, started_at, ended_at, status, payment_status) VALUES (?, ?, ?, ?, ?, ?)", [
    "session-1", "player-1", now.toISOString(), null, "active", "unpaid",
  ]);
  db.run("INSERT INTO settlements (id, session_id, subtotal, total, status, settled_at) VALUES (?, ?, ?, ?, ?, ?)", [
    "settlement-1", "session-1", 10, 10, "settled", now.toISOString(),
  ]);
  db.run("INSERT INTO settlement_charge_items (id, session_id, item_order, source, label, amount) VALUES (?, ?, ?, ?, ?, ?)", [
    "charge-1", "session-1", 0, "test", "Test", 10,
  ]);

  const statements: string[] = [];
  const executor = countingExecutor(createBunSqliteExecutor(db), statements);
  const queries = createRuntimeQueries({ executor, now: () => now });
  const expectOneStatement = async (action: () => Promise<unknown>) => {
    statements.length = 0;
    await action();
    expect(statements).toHaveLength(1);
  };

  await expectOneStatement(() => queries.playerQueries.getPlayerSummary("player-1"));
  await expectOneStatement(() => queries.playerQueries.listPlayerAssets!("player-1"));
  await expectOneStatement(() => queries.staffQueries.getPlayerAssets!("player-1"));
  await expectOneStatement(() => queries.staffQueries.listPlayers!());
  await expectOneStatement(() => queries.staffQueries.listPlayers({playerIds: ['player-1']}));
  expect(await queries.staffQueries.listPlayers({playerIds: ['missing']})).toEqual([]);
  statements.length = 0;
  expect(await queries.staffQueries.listPlayers({playerIds: []})).toEqual([]);
  expect(statements).toHaveLength(0);
  await expectOneStatement(() => queries.staffQueries.listActiveSessions!());
  await expectOneStatement(() => queries.playerQueries.getPlayerSessionHistoryDetail!("player-1", "session-1"));
  await expectOneStatement(() => queries.staffQueries.getReportsSummary!({
    from: new Date("2026-07-01T00:00:00.000Z"),
    to: new Date("2026-08-01T00:00:00.000Z"),
  }));
  await expectOneStatement(() => queries.staffQueries.listReportPlayers!({
    from: new Date("2026-07-01T00:00:00.000Z"),
    to: new Date("2026-08-01T00:00:00.000Z"),
    limit: 10,
  }));

  const summary = await queries.playerQueries.getPlayerSummary("player-1");
  expect(summary.wallet).toEqual([{ assetCode: "paid", quantity: 10 }]);
  await expect(queries.staffQueries.listPlayers()).resolves.toEqual([
    expect.objectContaining({ id: "player-1", walletTotal: centsOf(10) }),
  ]);
  const playerAssets = await queries.playerQueries.listPlayerAssets!("player-1");
  expect(playerAssets.holdings.map((holding) => holding.assetName)).toEqual(["余额"]);
  const staffAssets = await queries.staffQueries.getPlayerAssets!("player-1");
  expect(staffAssets.holdings.find((holding) => holding.assetCode === "legacy")).toMatchObject({
    assetName: "旧余额",
    availability: "unavailable",
    unavailableReasons: ["definition_archived"],
  });
});

test("reports use persisted unified checkout totals instead of inferring batches from timestamps", async () => {
  const db = new Database(":memory:");
  for (const statement of sqliteSchema) db.run(statement);
  db.run("INSERT INTO players (id, display_name, status, created_at) VALUES (?, ?, ?, ?)", [
    "player-1", "Player", "active", "2026-07-14T00:00:00.000Z",
  ]);
  for (const [sessionId, settledAt, total] of [
    ["session-charge", "2026-07-14T10:00:00.000Z", 10],
    ["session-discount", "2026-07-14T10:00:00.000Z", -3],
    ["session-only-discount", "2026-07-14T11:00:00.000Z", -4],
  ] as const) {
    db.run(
      "INSERT INTO sessions (id, player_id, started_at, ended_at, status, payment_status) VALUES (?, ?, ?, ?, ?, ?)",
      [sessionId, "player-1", "2026-07-14T09:00:00.000Z", settledAt, "closed", "paid"],
    );
    db.run(
      "INSERT INTO settlements (id, session_id, subtotal, total, status, settled_at) VALUES (?, ?, ?, ?, ?, ?)",
      [`settlement-${sessionId}`, sessionId, total, total, "settled", settledAt],
    );
  }
  db.run(
    "INSERT INTO player_checkouts (id, player_id, subtotal, total, status, settled_at) VALUES (?, ?, ?, ?, ?, ?)",
    ["checkout-main", "player-1", 7, 7, "settled", "2026-07-14T10:00:00.000Z"],
  );
  db.run(
    "INSERT INTO player_checkouts (id, player_id, subtotal, total, status, settled_at) VALUES (?, ?, ?, ?, ?, ?)",
    ["checkout-zero", "player-1", -4, 0, "settled", "2026-07-14T11:00:00.000Z"],
  );
  db.run(
    "UPDATE settlements SET checkout_id = ? WHERE session_id IN (?, ?)",
    ["checkout-main", "session-charge", "session-discount"],
  );
  db.run(
    "UPDATE settlements SET checkout_id = ? WHERE session_id = ?",
    ["checkout-zero", "session-only-discount"],
  );

  const queries = createRuntimeQueries({
    executor: createBunSqliteExecutor(db),
    now: () => new Date("2026-07-14T12:00:00.000Z"),
  });
  const range = {
    from: new Date("2026-07-14T00:00:00.000Z"),
    to: new Date("2026-07-15T00:00:00.000Z"),
  };

  await expect(queries.staffQueries.getReportsSummary!(range)).resolves.toMatchObject({
    revenueTotal: 7,
    sessionCount: 3,
  });
  await expect(queries.staffQueries.listReportPlayers!({
    ...range,
    limit: 10,
  })).resolves.toEqual([expect.objectContaining({
    playerId: "player-1",
    revenueTotal: 7,
    settlementCount: 3,
  })]);
});

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
