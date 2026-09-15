import { centsOf as moneyFixture, centsOfInteger as integerFixture } from "@prism/core";
import { yuanOf } from "@prism/core";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { createBunSqliteExecutor, createSqliteRepositories } from "@prism/adapter-sqlite";
import { createRuntimeQueries } from "@prism/runtime";

const bunExecutable = Bun.which("bun") ?? process.execPath;
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("migration CLI", () => {
  it("exports a prism-neo PostgreSQL dump snapshot and imports it into local SQLite", async () => {
    const tempDir = await createTempDir();
    const legacyDumpPath = `${tempDir}/prism-neo.sql`;
    const exportPath = `${tempDir}/prism-neo-export.json`;
    const targetSqlitePath = `${tempDir}/prism-next.sqlite`;
    await Bun.write(legacyDumpPath, createLegacyPrismNeoPostgresDump());

    const exportProc = Bun.spawn({
      cmd: [
        bunExecutable,
        "run",
        "packages/migration/src/cli.ts",
        "export-postgres-dump",
        "--input",
        legacyDumpPath,
        "--output",
        exportPath,
      ],
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exportStdout, exportStderr, exportExitCode] = await Promise.all([
      new Response(exportProc.stdout).text(),
      new Response(exportProc.stderr).text(),
      exportProc.exited,
    ]);

    expect(exportExitCode).toBe(0);
    expect(exportStderr).toBe("");
    expect(exportStdout).toContain("Exported prism-neo Postgres dump snapshot");
    expect(exportStdout).toContain("users: 1");
    expect(exportStdout).toContain("billingRules: 1");
    expect(exportStdout).toContain("coinRecords: 1");

    const exported = JSON.parse(await Bun.file(exportPath).text());
    expect(exported).toMatchObject({
      users: [{ id: 7, isBanned: false }],
      binds: [{ id: 31, userId: 7, type: "QQ", bid: "123456" }],
      assetDefinitions: [
        {
          id: 1,
          type: "CURRENCY",
          assetId: 10001,
          name: "Paid balance",
          valid: true,
        },
      ],
      billingRecords: [
        {
          id: 401,
          userId: 7,
          ruleId: 2,
          ruleStartTimeStamp: 1767424800000,
          cost: 120,
          durationMin: 90,
        },
      ],
      userAssets: [{ id: 101, userId: 7, assetDefId: 10001, assetType: "CURRENCY", count: 500, hide: false }],
    });

    const importProc = Bun.spawn({
      cmd: [
        bunExecutable,
        "run",
        "packages/migration/src/cli.ts",
        "import-json",
        "--input",
        exportPath,
        "--sqlite",
        targetSqlitePath,
      ],
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [importStdout, importStderr, importExitCode] = await Promise.all([
      new Response(importProc.stdout).text(),
      new Response(importProc.stderr).text(),
      importProc.exited,
    ]);

    expect(importExitCode).toBe(0);
    expect(importStderr).toBe("");
    expect(importStdout).toContain("players: 1");
    expect(importStdout).toContain("pricingConfigs: 1");
    expect(importStdout).toContain("pricingHistoryEntries: 1");

    const db = new Database(targetSqlitePath);
    const repositories = createSqliteRepositories({
      db,
      id: () => "unused",
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    });
    const executor = createBunSqliteExecutor(db);
    const queries = createRuntimeQueries({
      executor,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    });

    const player = await repositories.players.findById("legacy:user:7");
    const summary = await queries.playerQueries.getPlayerSummary("legacy:user:7");
    const detail = await queries.playerQueries.getPlayerSessionHistoryDetail?.("legacy:user:7", "legacy:session:51");
    const commands = await repositories.deviceCommands.listByPlayerId("legacy:user:7");

    expect(player?.displayName).toBe("Player 7");
    expect(summary.wallet).toEqual([{ assetCode: "paid", quantity: moneyFixture(500) }]);
    expect(yuanOf(detail!.total!)).toBe(90);
    expect(commands[0]?.payload).toEqual({ count: 2, legacyCoinRecordId: 91 });
    db.close();
  });

  it("exports a prism-neo SQL database snapshot and imports it into local SQLite", async () => {
    const tempDir = await createTempDir();
    const legacySqlitePath = `${tempDir}/prism-neo.sqlite`;
    const exportPath = `${tempDir}/prism-neo-export.json`;
    const targetSqlitePath = `${tempDir}/prism-next.sqlite`;
    createLegacyPrismNeoSqliteDatabase(legacySqlitePath);

    const exportProc = Bun.spawn({
      cmd: [
        bunExecutable,
        "run",
        "packages/migration/src/cli.ts",
        "export-sqlite",
        "--sqlite",
        legacySqlitePath,
        "--output",
        exportPath,
      ],
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exportStdout, exportStderr, exportExitCode] = await Promise.all([
      new Response(exportProc.stdout).text(),
      new Response(exportProc.stderr).text(),
      exportProc.exited,
    ]);

    expect(exportExitCode).toBe(0);
    expect(exportStderr).toBe("");
    expect(exportStdout).toContain("Exported prism-neo snapshot");
    expect(exportStdout).toContain("users: 1");
    expect(exportStdout).toContain("billingRules: 1");
    expect(exportStdout).toContain("coinRecords: 1");

    const exported = JSON.parse(await Bun.file(exportPath).text());
    expect(exported).toMatchObject({
      users: [{ id: 7, createdAt: "2026-01-01T00:00:00.000Z", isBanned: false }],
      binds: [{ id: 31, userId: 7, type: "QQ", bid: "123456" }],
      assetDefinitions: [
        {
          id: 1,
          type: "CURRENCY",
          assetId: 10001,
          name: "Paid balance",
          valid: true,
          billingEffect: { type: "FIXED_OFF", value: 10, consume: false },
        },
      ],
      billingRules: [
        {
          id: 2,
          name: "Default time",
          available: true,
          priority: 1,
          matchDate: { weekdays: [1, 2, 3, 4, 5] },
          timeRange: { start: "00:00", end: "00:00" },
          pricing: { unitMinutes: 30, unitPrice: 40, priceCap: 160, roundGraceMinutes: 5 },
        },
      ],
      presents: [
        {
          id: 61,
          name: "Recharge pack",
          oncePerUser: true,
          body: [{ assetType: "CURRENCY", assetId: 10001, count: 500, mergeStrategy: "STACK" }],
        },
      ],
    });

    const importProc = Bun.spawn({
      cmd: [
        bunExecutable,
        "run",
        "packages/migration/src/cli.ts",
        "import-json",
        "--input",
        exportPath,
        "--sqlite",
        targetSqlitePath,
      ],
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [importStdout, importStderr, importExitCode] = await Promise.all([
      new Response(importProc.stdout).text(),
      new Response(importProc.stderr).text(),
      importProc.exited,
    ]);

    expect(importExitCode).toBe(0);
    expect(importStderr).toBe("");
    expect(importStdout).toContain("players: 1");
    expect(importStdout).toContain("pricingConfigs: 1");
    expect(importStdout).toContain("pricingHistoryEntries: 1");

    const db = new Database(targetSqlitePath);
    const repositories = createSqliteRepositories({
      db,
      id: () => "unused",
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    });
    const executor = createBunSqliteExecutor(db);
    const queries = createRuntimeQueries({
      executor,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    });

    const player = await repositories.players.findById("legacy:user:7");
    const summary = await queries.playerQueries.getPlayerSummary("legacy:user:7");
    const detail = await queries.playerQueries.getPlayerSessionHistoryDetail?.("legacy:user:7", "legacy:session:51");
    const commands = await repositories.deviceCommands.listByPlayerId("legacy:user:7");

    expect(player?.displayName).toBe("Player 7");
    expect(summary.wallet).toEqual([{ assetCode: "paid", quantity: moneyFixture(500) }]);
    expect(yuanOf(detail!.total!)).toBe(90);
    expect(commands[0]?.payload).toEqual({ count: 2, legacyCoinRecordId: 91 });
    db.close();
  });

  it("imports a prism-neo JSON snapshot into local SQLite and prints a summary", async () => {
    const tempDir = await createTempDir();
    const inputPath = `${tempDir}/prism-neo-export.json`;
    const sqlitePath = `${tempDir}/prism-next.sqlite`;
    await Bun.write(
      inputPath,
      JSON.stringify({
        exportedAt: "2026-06-01T00:00:00.000Z",
        users: [{ id: 7, createdAt: "2026-01-01T00:00:00.000Z", isBanned: false }],
        binds: [{ id: 31, userId: 7, type: "QQ", bid: "123456" }],
        assetDefinitions: [{ id: 1, type: "CURRENCY", assetId: 10001, name: "Paid balance", valid: true }],
        userAssets: [
          {
            id: 101,
            userId: 7,
            assetDefId: 10001,
            assetType: "CURRENCY",
            count: 500,
            activeAt: null,
            expireAt: null,
            hide: false,
          },
        ],
        userAssetLogs: [
          {
            id: 301,
            userId: 7,
            userAssetId: 101,
            assetId: 10001,
            assetType: "CURRENCY",
            changeAmount: 500,
            action: "ADMIN_GRANT",
            comment: "legacy import",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        sessions: [
          {
            id: 51,
            userId: 7,
            createdAt: "2026-01-03T10:00:00.000Z",
            closedAt: "2026-01-03T11:30:00.000Z",
            isActive: null,
            billingCost: 120,
            finalCost: 90,
            costOverwrite: null,
          },
        ],
      }),
    );

    const proc = Bun.spawn({
      cmd: [
        bunExecutable,
        "run",
        "packages/migration/src/cli.ts",
        "import-json",
        "--input",
        inputPath,
        "--sqlite",
        sqlitePath,
      ],
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Imported prism-neo snapshot");
    expect(stdout).toContain("players: 1");
    expect(stdout).toContain("assetHoldings: 1");
    expect(stdout).toContain("settlements: 1");
    expect(stdout).toContain("pricingHistoryEntries: 0");

    const db = new Database(sqlitePath);
    const repositories = createSqliteRepositories({
      db,
      id: () => "unused",
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    });
    const executor = createBunSqliteExecutor(db);
    const queries = createRuntimeQueries({
      executor,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    });

    const player = await repositories.players.findById("legacy:user:7");
    const summary = await queries.playerQueries.getPlayerSummary("legacy:user:7");
    const detail = await queries.playerQueries.getPlayerSessionHistoryDetail?.("legacy:user:7", "legacy:session:51");

    expect(player?.displayName).toBe("Player 7");
    expect(summary.wallet).toEqual([{ assetCode: "paid", quantity: moneyFixture(500) }]);
    expect(yuanOf(detail!.total!)).toBe(90);
    db.close();
  });
});

async function createTempDir(): Promise<string> {
  return await Bun.$`mktemp -d`.text().then((path) => path.trim());
}

function createLegacyPrismNeoPostgresDump(): string {
  return String.raw`--
-- PostgreSQL database dump
--

COPY public."Asset" (id, "assetId", type, name, description, valid, "activeAt", "expireAt", "billingEffect") FROM stdin;
1	10001	CURRENCY	Paid balance	Paid wallet	t	\N	\N	{"type":"FIXED_OFF","value":10,"consume":false}
\.

COPY public."BillingRecord" (id, "userId", "ruleId", "ruleStartTimeStamp", cost, "billingEnd", "billingStart", "durationMin") FROM stdin;
401	7	2	1767424800000	120	2026-01-03 11:30:00	2026-01-03 10:00:00	90
\.

COPY public."BillingRule" (id, name, available, priority, "matchDate", "timeRange", pricing) FROM stdin;
2	Default time	t	1	{"weekdays":[1,2,3,4,5]}	{"start":"00:00","end":"00:00"}	{"unitMinutes":30,"unitPrice":40,"priceCap":160,"roundGraceMinutes":5}
\.

COPY public."Bind" (id, bid, type, "userId") FROM stdin;
31	123456	QQ	7
\.

COPY public."CoinRecord" (id, "userId", "machineName", "createAt", count) FROM stdin;
91	7	mai-1	2026-01-03 10:30:00	2
\.

COPY public."Present" (id, name, "oncePerUser", body) FROM stdin;
61	Recharge pack	t	[{"assetType":"CURRENCY","assetId":10001,"count":500,"mergeStrategy":"STACK"}]
\.

COPY public."Redeem" (id, code, "createdAt", comment, "presentId", "activeAt", "expireAt", "maxUseCount") FROM stdin;
71	PRISM-LEGACY	2026-01-01 00:00:00	\N	61	2026-01-01 00:00:00	\N	1
\.

COPY public."RedeemRecord" (id, "userId", "redeemId", "presentId", date) FROM stdin;
81	7	71	61	2026-01-02 00:00:00
\.

COPY public."Session" (id, "userId", "createdAt", "closedAt", "isActive", "billingCost", "costOverwrite", "finalCost") FROM stdin;
51	7	2026-01-03 10:00:00	2026-01-03 11:30:00	\N	120	\N	90
\.

COPY public."User" (id, "createdAt", "isBanned") FROM stdin;
7	2026-01-01 00:00:00	f
\.

COPY public."UserAsset" (id, "userId", "assetDefId", "assetType", "assetId", "addAt", "activeAt", "expireAt", count, hide) FROM stdin;
101	7	10001	CURRENCY	1	2026-01-01 00:00:00	\N	\N	500	f
\.

COPY public."UserAssetLog" (id, "userId", "userAssetId", "assetId", "assetType", "changeAmount", "countBefore", "countAfter", action, comment, "createdAt", "expireAtAfter", "expireAtBefore") FROM stdin;
301	7	101	10001	CURRENCY	500	0	500	ADMIN_GRANT	legacy import	2026-01-01 00:00:00	\N	\N
\.
`;
}

function createLegacyPrismNeoSqliteDatabase(path: string): void {
  const db = new Database(path);
  db.run(`CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "createdAt" TEXT NOT NULL, "isBanned" INTEGER NOT NULL)`);
  db.run(`CREATE TABLE "Bind" ("id" INTEGER PRIMARY KEY, "bid" TEXT NOT NULL, "type" TEXT NOT NULL, "userId" INTEGER NOT NULL)`);
  db.run(
    `CREATE TABLE "Asset" (
      "id" INTEGER PRIMARY KEY,
      "assetId" INTEGER NOT NULL,
      "type" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "description" TEXT,
      "valid" INTEGER NOT NULL,
      "activeAt" TEXT,
      "expireAt" TEXT,
      "billingEffect" TEXT
    )`,
  );
  db.run(
    `CREATE TABLE "UserAsset" (
      "id" INTEGER PRIMARY KEY,
      "userId" INTEGER NOT NULL,
      "assetDefId" INTEGER NOT NULL,
      "assetType" TEXT NOT NULL,
      "assetId" INTEGER NOT NULL,
      "count" REAL NOT NULL,
      "activeAt" TEXT,
      "expireAt" TEXT,
      "hide" INTEGER NOT NULL
    )`,
  );
  db.run(
    `CREATE TABLE "UserAssetLog" (
      "id" INTEGER PRIMARY KEY,
      "userId" INTEGER NOT NULL,
      "userAssetId" INTEGER,
      "assetId" INTEGER NOT NULL,
      "assetType" TEXT NOT NULL,
      "changeAmount" INTEGER NOT NULL,
      "action" TEXT NOT NULL,
      "comment" TEXT,
      "createdAt" TEXT NOT NULL
    )`,
  );
  db.run(
    `CREATE TABLE "Session" (
      "id" INTEGER PRIMARY KEY,
      "userId" INTEGER NOT NULL,
      "createdAt" TEXT NOT NULL,
      "closedAt" TEXT,
      "isActive" INTEGER,
      "billingCost" INTEGER,
      "finalCost" INTEGER,
      "costOverwrite" INTEGER
    )`,
  );
  db.run(
    `CREATE TABLE "BillingRule" (
      "id" INTEGER PRIMARY KEY,
      "name" TEXT NOT NULL,
      "available" INTEGER NOT NULL,
      "priority" INTEGER NOT NULL,
      "matchDate" TEXT NOT NULL,
      "timeRange" TEXT NOT NULL,
      "pricing" TEXT NOT NULL
    )`,
  );
  db.run(
    `CREATE TABLE "BillingRecord" (
      "id" INTEGER PRIMARY KEY,
      "userId" INTEGER NOT NULL,
      "ruleId" INTEGER NOT NULL,
      "ruleStartTimeStamp" INTEGER NOT NULL,
      "cost" INTEGER NOT NULL,
      "billingStart" TEXT NOT NULL,
      "billingEnd" TEXT NOT NULL,
      "durationMin" INTEGER NOT NULL
    )`,
  );
  db.run(
    `CREATE TABLE "Present" (
      "id" INTEGER PRIMARY KEY,
      "name" TEXT NOT NULL,
      "oncePerUser" INTEGER NOT NULL,
      "body" TEXT NOT NULL
    )`,
  );
  db.run(
    `CREATE TABLE "Redeem" (
      "id" INTEGER PRIMARY KEY,
      "code" TEXT NOT NULL,
      "presentId" INTEGER NOT NULL,
      "activeAt" TEXT,
      "expireAt" TEXT,
      "maxUseCount" INTEGER NOT NULL
    )`,
  );
  db.run(
    `CREATE TABLE "RedeemRecord" (
      "id" INTEGER PRIMARY KEY,
      "userId" INTEGER NOT NULL,
      "redeemId" INTEGER NOT NULL,
      "presentId" INTEGER NOT NULL,
      "date" TEXT NOT NULL
    )`,
  );
  db.run(
    `CREATE TABLE "CoinRecord" (
      "id" INTEGER PRIMARY KEY,
      "userId" INTEGER NOT NULL,
      "machineName" TEXT NOT NULL,
      "count" INTEGER NOT NULL,
      "createAt" TEXT NOT NULL
    )`,
  );

  db.run(`INSERT INTO "User" ("id", "createdAt", "isBanned") VALUES (?, ?, ?)`, [
    7,
    "2026-01-01T00:00:00.000Z",
    0,
  ]);
  db.run(`INSERT INTO "Bind" ("id", "bid", "type", "userId") VALUES (?, ?, ?, ?)`, [31, "123456", "QQ", 7]);
  db.run(
    `INSERT INTO "Asset" ("id", "assetId", "type", "name", "description", "valid", "activeAt", "expireAt", "billingEffect")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      1,
      10001,
      "CURRENCY",
      "Paid balance",
      "Paid wallet",
      1,
      null,
      null,
      JSON.stringify({ type: "FIXED_OFF", value: 10, consume: false }),
    ],
  );
  db.run(
    `INSERT INTO "UserAsset" ("id", "userId", "assetDefId", "assetType", "assetId", "count", "activeAt", "expireAt", "hide")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [101, 7, 10001, "CURRENCY", 1, 500, null, null, 0],
  );
  db.run(
    `INSERT INTO "UserAssetLog" ("id", "userId", "userAssetId", "assetId", "assetType", "changeAmount", "action", "comment", "createdAt")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [301, 7, 101, 10001, "CURRENCY", 500, "ADMIN_GRANT", "legacy import", "2026-01-01T00:00:00.000Z"],
  );
  db.run(
    `INSERT INTO "Session" ("id", "userId", "createdAt", "closedAt", "isActive", "billingCost", "finalCost", "costOverwrite")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [51, 7, "2026-01-03T10:00:00.000Z", "2026-01-03T11:30:00.000Z", null, 120, 90, null],
  );
  db.run(
    `INSERT INTO "BillingRule" ("id", "name", "available", "priority", "matchDate", "timeRange", "pricing")
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      2,
      "Default time",
      1,
      1,
      JSON.stringify({ weekdays: [1, 2, 3, 4, 5] }),
      JSON.stringify({ start: "00:00", end: "00:00" }),
      JSON.stringify({ unitMinutes: 30, unitPrice: 40, priceCap: 160, roundGraceMinutes: 5 }),
    ],
  );
  db.run(
    `INSERT INTO "BillingRecord" ("id", "userId", "ruleId", "ruleStartTimeStamp", "cost", "billingStart", "billingEnd", "durationMin")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [401, 7, 2, 1767424800000, 120, "2026-01-03T10:00:00.000Z", "2026-01-03T11:30:00.000Z", 90],
  );
  db.run(`INSERT INTO "Present" ("id", "name", "oncePerUser", "body") VALUES (?, ?, ?, ?)`, [
    61,
    "Recharge pack",
    1,
    JSON.stringify([{ assetType: "CURRENCY", assetId: 10001, count: 500, mergeStrategy: "STACK" }]),
  ]);
  db.run(
    `INSERT INTO "Redeem" ("id", "code", "presentId", "activeAt", "expireAt", "maxUseCount")
     VALUES (?, ?, ?, ?, ?, ?)`,
    [71, "PRISM-LEGACY", 61, "2026-01-01T00:00:00.000Z", null, 1],
  );
  db.run(`INSERT INTO "RedeemRecord" ("id", "userId", "redeemId", "presentId", "date") VALUES (?, ?, ?, ?, ?)`, [
    81,
    7,
    71,
    61,
    "2026-01-02T00:00:00.000Z",
  ]);
  db.run(`INSERT INTO "CoinRecord" ("id", "userId", "machineName", "count", "createAt") VALUES (?, ?, ?, ?, ?)`, [
    91,
    7,
    "mai-1",
    2,
    "2026-01-03T10:30:00.000Z",
  ]);
  db.close();
}
