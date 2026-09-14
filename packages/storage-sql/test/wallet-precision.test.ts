import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { centsOfInteger, yuanOf } from "@prism/core";
import { createSqlReadModels, sqliteSchema, type SqlExecutor, type SqlValue } from "../src";

const NOW = new Date("2026-09-15T00:00:00.000Z");

function setup(playerId: string) {
  const db = new Database(":memory:");
  for (const statement of sqliteSchema) db.run(statement);
  db.run("INSERT INTO players (id, display_name, status, created_at) VALUES (?, ?, ?, ?)", [
    playerId, "Player", "active", NOW.toISOString(),
  ]);
  db.run(
    "INSERT INTO asset_definitions (type, code, name, stackable, status) VALUES ('currency', 'free', 'Free', 1, 'active')",
  );
  db.run(
    "INSERT INTO asset_definitions (type, code, name, stackable, status) VALUES ('currency', 'paid', 'Paid', 1, 'active')",
  );

  let id = 0;
  const addHolding = (assetCode: string, quantity: number) => {
    db.run(
      "INSERT INTO asset_holdings (id, player_id, asset_type, asset_code, quantity, active_at, expires_at) VALUES (?, ?, 'currency', ?, ?, NULL, NULL)",
      ["holding-" + (++id), playerId, assetCode, quantity],
    );
  };

  const queries = createSqlReadModels({ executor: sqliteExecutor(db), now: () => NOW });
  return { addHolding, queries };
}

function walletQuantity(wallet: Array<{ assetCode: string; quantity: number }>, code: string): number {
  const found = wallet.find((entry) => entry.assetCode === code);
  if (!found) throw new Error("wallet has no entry for " + code + ": " + JSON.stringify(wallet));
  return found.quantity;
}

test("a wallet spread over several rows of the same code does not drift", () => {
  const { addHolding, queries } = setup("player-drift");
  // 1 fen + 5 fen: naive float accumulation yields 0.060000000000000005.
  addHolding("free", 1);
  addHolding("free", 5);

  return queries.playerQueries.getPlayerSummary("player-drift").then((summary) => {
    expect(yuanOf(walletQuantity(summary.wallet, "free"))).toBe(0.06);
  });
});

test("a nine-row production-shaped wallet stays exact", () => {
  const { addHolding, queries } = setup("player-nine");
  // Mirrors the multi-row holding actually found in beta: nine rows, one code.
  // Six yuan per row = 600 fen.
  for (let index = 0; index < 9; index++) addHolding("paid", 600);

  return queries.playerQueries.getPlayerSummary("player-nine").then((summary) => {
    expect(yuanOf(walletQuantity(summary.wallet, "paid"))).toBe(54);
  });
});

test("sub-cent residue already in a column is absorbed on read", () => {
  const { addHolding, queries } = setup("player-residue");
  // Sub-cent residue cannot exist once quantities are integer fen.
  addHolding("free", 0);

  return queries.playerQueries.getPlayerSummary("player-residue").then((summary) => {
    expect(summary.wallet.find((entry) => entry.assetCode === "free")).toBeUndefined();
  });
});

test("zero-quantity rows are not reported as balance", () => {
  const { addHolding, queries } = setup("player-empty");
  addHolding("free", 0);

  return queries.playerQueries.getPlayerSummary("player-empty").then((summary) => {
    expect(summary.wallet.find((entry) => entry.assetCode === "free")).toBeUndefined();
  });
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
