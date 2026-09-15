import { centsOf, yuanOf } from "@prism/core";
import { readdirSync, readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createSqlReadModels, sqliteSchema } from "@prism/storage-sql";
import { createBunSqliteExecutor, createSqliteRepositories } from "../src";

test("shops isolate colliding identities, wallets, reports, updates and leases", async () => {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  for (const sql of sqliteSchema) db.run(sql);
  const now = () => new Date("2026-09-11T00:00:00Z");
  const repo = (shopId: string) =>
    createSqliteRepositories({
      db,
      shopId,
      now,
      id: () => crypto.randomUUID(),
    });
  const a = repo("shop-a");
  const b = repo("shop-b");
  for (const [r, name, quantity] of [
    [a, "A", 100],
    [b, "B", 200],
  ] as const) {
    await r.players.save({
      id: "same-player",
      displayName: name,
      status: "active",
      createdAt: now(),
    });
    await r.playerIdentities.save({
      playerId: "same-player",
      provider: "qq",
      subject: "12345",
      createdAt: now(),
    });
    await r.assetDefinitions.save({
      type: "currency",
      code: "balance",
      name: "Balance",
      stackable: true,
      metadata: null,
    });
    await r.assets.commitAssetTransaction({
      transaction: {
        id: "same-transaction",
        playerId: "same-player",
        kind: "adjustment",
        refId: "seed",
        metadata: null,
        createdAt: now(),
      },
      holdingChanges: {
        upserts: [
          {
            id: "same-holding",
            assetType: "currency",
            assetCode: "balance",
            quantity: centsOf(quantity),
          },
        ],
        deleteIds: [],
      },
      assetLedgerEntries: [],
    });
    await r.system.setAppSetting("venue.name", name);
    expect(
      await r.operationLocks.acquire(
        "checkout",
        "same-player",
        "lock",
        now(),
        new Date(now().getTime() + 30000),
      ),
    ).toBe(true);
  }
  expect(
    (await a.playerIdentities.findPlayerByIdentity("qq", "12345"))?.displayName,
  ).toBe("A");
  expect(yuanOf((await b.assets.listAssetHoldings("same-player"))[0]!.quantity)).toBe(
    200,
  );
  await a.players.updateStatus("same-player", "banned");
  expect((await b.players.findById("same-player"))?.status).toBe("active");
  expect(await b.system.getAppSetting<string>("venue.name")).toBe("B");
  const queries = createSqlReadModels({
    executor: createBunSqliteExecutor(db, "shop-b"),
    now,
  });
  expect(await queries.staffQueries.listPlayers()).toHaveLength(1);
  expect(
    (await queries.playerQueries.getPlayerSummary("same-player")).wallet,
  ).toEqual([{ assetCode: "balance", quantity: centsOf(200) }]);
  await a.players.save({
    id: "only-a",
    displayName: "Only A",
    status: "active",
    createdAt: now(),
  });
  await expect(
    b.playerIdentities.save({
      playerId: "only-a",
      provider: "qq",
      subject: "999",
      createdAt: now(),
    }),
  ).rejects.toThrow();
  await expect(
    a.playerIdentities.save({
      playerId: "only-a",
      provider: "qq",
      subject: "12345",
      createdAt: now(),
    }),
  ).rejects.toThrow("already bound");
  expect(
    (await a.playerIdentities.findPlayerByIdentity("qq", "12345"))?.id,
  ).toBe("same-player");
  db.close();
});

test("legacy SQLite migration preserves referenced balances and rolls back on interruption", () => {
  const db = new Database(":memory:");
  const dir = new URL("../../../migrations/", import.meta.url);
  for (const name of readdirSync(dir)
    .filter((name) => name.endsWith(".sql") && name < "0016")
    .sort())
    db.exec(readFileSync(new URL(name, dir), "utf8"));
  db.exec(
    "INSERT INTO players(id,display_name,status,created_at) VALUES ('p','Test','active','2026-01-01'); INSERT INTO asset_definitions(type,code,name,stackable) VALUES ('currency','paid','Paid',1); INSERT INTO asset_holdings(id,player_id,asset_type,asset_code,quantity) VALUES ('h','p','currency','paid',12.34); INSERT INTO player_identities(player_id,provider,subject,created_at) VALUES ('p','qq','123456','2026-01-01');",
  );
  db.exec("PRAGMA foreign_keys=ON");
  const migration = readFileSync(
    new URL("0016_shop_scoped_billing.sql", dir),
    "utf8",
  );
  expect(() =>
    db.transaction(() => {
      db.exec(migration);
      throw new Error("interruption");
    })(),
  ).toThrow("interruption");
  expect(db.query("SELECT quantity FROM asset_holdings").get()).toEqual({
    quantity: 12.34,
  });
  expect(
    (db.query("PRAGMA table_info(players)").all() as { name: string }[]).some(
      (column) => column.name === "shop_id",
    ),
  ).toBe(false);
  db.transaction(() => db.exec(migration))();
  expect(db.query("SELECT shop_id,quantity FROM asset_holdings").get()).toEqual(
    { shop_id: "legacy", quantity: 12.34 },
  );
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});
