import { Database } from "bun:sqlite";
import { createBunSqliteExecutor } from "@prism/adapter-sqlite";
import { initializeSqliteSchema } from "@prism/server";
import {
  optionalBoolean,
  optionalJson,
  optionalNumber,
  optionalString,
  requiredBoolean,
  requiredJson,
  requiredNumber,
  requiredString,
  requiredValue,
  toNumber,
  type LegacyRow,
} from "./legacy-row";
import {
  createPrismNeoMigrationPlan,
  importPrismNeoMigrationPlan,
  exportPrismNeoPostgresSnapshot,
  type CreatePrismNeoMigrationPlanInput,
  type PrismNeoAssetDefinition,
  type PrismNeoBillingRecord,
  type PrismNeoBillingRule,
  type PrismNeoBind,
  type PrismNeoCoinRecord,
  type PrismNeoPresent,
  type PrismNeoRedeem,
  type PrismNeoRedeemRecord,
  type PrismNeoSession,
  type PrismNeoUser,
  type PrismNeoUserAsset,
  type PrismNeoUserAssetLog,
  type PrismNeoMigrationPlan,
} from "./index";

type CliOptions = {
  command: string;
  input?: string;
  output?: string;
  sqlite?: string;
  url?: string;
};

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);

  if (options.command === "export-sqlite") {
    if (!options.sqlite) throw new Error("--sqlite is required.");
    if (!options.output) throw new Error("--output is required.");

    const snapshot = await exportSqliteSnapshot(options.sqlite);
    await Bun.write(options.output, `${JSON.stringify(snapshot, null, 2)}\n`);
    printExportSummary(snapshot, options.sqlite, options.output);
    return;
  }

  if (options.command === "export-postgres") {
    if (!options.url) throw new Error("--url is required.");
    if (!options.output) throw new Error("--output is required.");

    const snapshot = await exportPostgresSnapshot(options.url);
    await Bun.write(options.output, `${JSON.stringify(snapshot, null, 2)}\n`);
    printPostgresExportSummary(snapshot, options.url, options.output);
    return;
  }

  if (options.command === "export-postgres-dump") {
    if (!options.input) throw new Error("--input is required.");
    if (!options.output) throw new Error("--output is required.");

    const snapshot = await exportPostgresDumpSnapshot(options.input);
    await Bun.write(options.output, `${JSON.stringify(snapshot, null, 2)}\n`);
    printPostgresDumpExportSummary(snapshot, options.input, options.output);
    return;
  }

  if (options.command !== "import-json") {
    printUsage();
    throw new Error("Unknown migration command.");
  }

  if (!options.input) throw new Error("--input is required.");
  if (!options.sqlite) throw new Error("--sqlite is required.");

  const snapshot = await readJsonSnapshot(options.input);
  const plan = createPrismNeoMigrationPlan(snapshot);
  const db = new Database(options.sqlite);
  try {
    initializeSqliteSchema(db);
    await importPrismNeoMigrationPlan({
      executor: createBunSqliteExecutor(db),
      plan,
    });
  } finally {
    db.close();
  }

  printSummary(plan, options.sqlite);
}

function parseArgs(argv: string[]): CliOptions {
  const [command = ""] = argv;
  const options: CliOptions = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--input") {
      options.input = next;
      index += 1;
    } else if (arg === "--output") {
      options.output = next;
      index += 1;
    } else if (arg === "--sqlite") {
      options.sqlite = next;
      index += 1;
    } else if (arg === "--url") {
      options.url = next;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function exportSqliteSnapshot(path: string): Promise<CreatePrismNeoMigrationPlanInput> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`SQLite database not found: ${path}`);
  }

  const db = new Database(path);
  try {
    return {
      exportedAt: new Date(),
      users: readLegacyUsers(db),
      binds: readLegacyBinds(db),
      assetDefinitions: readLegacyAssetDefinitions(db),
      userAssets: readLegacyUserAssets(db),
      userAssetLogs: readLegacyUserAssetLogs(db),
      sessions: readLegacySessions(db),
      billingRules: readLegacyBillingRules(db),
      billingRecords: readLegacyBillingRecords(db),
      presents: readLegacyPresents(db),
      redeems: readLegacyRedeems(db),
      redeemRecords: readLegacyRedeemRecords(db),
      coinRecords: readLegacyCoinRecords(db),
    };
  } finally {
    db.close();
  }
}

async function exportPostgresSnapshot(url: string): Promise<CreatePrismNeoMigrationPlanInput> {
  const sql = new Bun.SQL(url);
  try {
    return await exportPrismNeoPostgresSnapshot({ sql });
  } finally {
    if (typeof sql.close === "function") {
      await sql.close();
    } else if (typeof sql.end === "function") {
      await sql.end();
    }
  }
}

async function exportPostgresDumpSnapshot(path: string): Promise<CreatePrismNeoMigrationPlanInput> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Postgres dump not found: ${path}`);
  }

  const tables = parsePostgresTextCopyDump(await file.text());
  return {
    exportedAt: new Date(),
    users: readLegacyDumpUsers(tables),
    binds: readLegacyDumpBinds(tables),
    assetDefinitions: readLegacyDumpAssetDefinitions(tables),
    userAssets: readLegacyDumpUserAssets(tables),
    userAssetLogs: readLegacyDumpUserAssetLogs(tables),
    sessions: readLegacyDumpSessions(tables),
    billingRules: readLegacyDumpBillingRules(tables),
    billingRecords: readLegacyDumpBillingRecords(tables),
    presents: readLegacyDumpPresents(tables),
    redeems: readLegacyDumpRedeems(tables),
    redeemRecords: readLegacyDumpRedeemRecords(tables),
    coinRecords: readLegacyDumpCoinRecords(tables),
  };
}

async function readJsonSnapshot(path: string): Promise<CreatePrismNeoMigrationPlanInput> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Input file not found: ${path}`);
  }
  return reviveDates(JSON.parse(await file.text())) as CreatePrismNeoMigrationPlanInput;
}

function reviveDates(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveDates);
  if (typeof value === "string" && isIsoDateTime(value)) return new Date(value);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, reviveDates(entry)]),
  );
}

function isIsoDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);
}

type LegacyDumpTables = Map<string, LegacyRow[]>;

function readLegacyUsers(db: Database): PrismNeoUser[] {
  return readLegacyTable(db, "User", ["id", "createdAt", "isBanned"], (row) => ({
    id: requiredNumber(row, "id"),
    createdAt: requiredDate(row, "createdAt"),
    isBanned: requiredBoolean(row, "isBanned"),
  }));
}

function readLegacyBinds(db: Database): PrismNeoBind[] {
  return readLegacyTable(db, "Bind", ["id", "userId", "type", "bid"], (row) => ({
    id: requiredNumber(row, "id"),
    userId: requiredNumber(row, "userId"),
    type: requiredString(row, "type"),
    bid: requiredString(row, "bid"),
  }));
}

function readLegacyAssetDefinitions(db: Database): PrismNeoAssetDefinition[] {
  return readLegacyTable(
    db,
    "Asset",
    ["id", "assetId", "type", "name", "description", "valid", "activeAt", "expireAt", "billingEffect"],
    (row) => ({
      id: requiredNumber(row, "id"),
      assetId: requiredNumber(row, "assetId"),
      type: requiredString(row, "type"),
      name: requiredString(row, "name"),
      description: optionalString(row, "description"),
      valid: requiredBoolean(row, "valid"),
      activeAt: optionalDate(row, "activeAt"),
      expireAt: optionalDate(row, "expireAt"),
      billingEffect: optionalJson(row, "billingEffect"),
    }),
  );
}

function readLegacyUserAssets(db: Database): PrismNeoUserAsset[] {
  return readLegacyTable(
    db,
    "UserAsset",
    ["id", "userId", "assetDefId", "assetType", "count", "activeAt", "expireAt", "hide"],
    (row) => ({
      id: requiredNumber(row, "id"),
      userId: requiredNumber(row, "userId"),
      assetDefId: requiredNumber(row, "assetDefId"),
      assetType: requiredString(row, "assetType"),
      count: requiredNumber(row, "count"),
      activeAt: optionalDate(row, "activeAt"),
      expireAt: optionalDate(row, "expireAt"),
      hide: optionalBoolean(row, "hide") ?? false,
    }),
  );
}

function readLegacyUserAssetLogs(db: Database): PrismNeoUserAssetLog[] {
  return readLegacyTable(
    db,
    "UserAssetLog",
    ["id", "userId", "userAssetId", "assetId", "assetType", "changeAmount", "action", "comment", "createdAt"],
    (row) => ({
      id: requiredNumber(row, "id"),
      userId: requiredNumber(row, "userId"),
      userAssetId: optionalNumber(row, "userAssetId"),
      assetId: requiredNumber(row, "assetId"),
      assetType: requiredString(row, "assetType"),
      changeAmount: requiredNumber(row, "changeAmount"),
      action: requiredString(row, "action"),
      comment: optionalString(row, "comment"),
      createdAt: optionalDate(row, "createdAt") ?? undefined,
    }),
  );
}

function readLegacySessions(db: Database): PrismNeoSession[] {
  return readLegacyTable(
    db,
    "Session",
    ["id", "userId", "createdAt", "closedAt", "isActive", "billingCost", "finalCost", "costOverwrite"],
    (row) => ({
      id: requiredNumber(row, "id"),
      userId: requiredNumber(row, "userId"),
      createdAt: requiredDate(row, "createdAt"),
      closedAt: optionalDate(row, "closedAt"),
      isActive: optionalBoolean(row, "isActive"),
      billingCost: optionalNumber(row, "billingCost"),
      finalCost: optionalNumber(row, "finalCost"),
      costOverwrite: optionalNumber(row, "costOverwrite"),
    }),
  );
}

function readLegacyBillingRules(db: Database): PrismNeoBillingRule[] {
  return readLegacyTable(
    db,
    "BillingRule",
    ["id", "name", "available", "priority", "matchDate", "timeRange", "pricing"],
    (row) => ({
      id: requiredNumber(row, "id"),
      name: requiredString(row, "name"),
      available: requiredBoolean(row, "available"),
      priority: requiredNumber(row, "priority"),
      matchDate: optionalJson(row, "matchDate") as PrismNeoBillingRule["matchDate"],
      timeRange: requiredJson(row, "timeRange") as PrismNeoBillingRule["timeRange"],
      pricing: requiredJson(row, "pricing") as PrismNeoBillingRule["pricing"],
    }),
  );
}

function readLegacyBillingRecords(db: Database): PrismNeoBillingRecord[] {
  return readLegacyTable(
    db,
    "BillingRecord",
    ["id", "userId", "ruleId", "ruleStartTimeStamp", "cost", "billingStart", "billingEnd", "durationMin"],
    (row) => ({
      id: requiredNumber(row, "id"),
      userId: requiredNumber(row, "userId"),
      ruleId: requiredNumber(row, "ruleId"),
      ruleStartTimeStamp: requiredNumber(row, "ruleStartTimeStamp"),
      cost: requiredNumber(row, "cost"),
      billingStart: requiredDate(row, "billingStart"),
      billingEnd: requiredDate(row, "billingEnd"),
      durationMin: requiredNumber(row, "durationMin"),
    }),
  );
}

function readLegacyPresents(db: Database): PrismNeoPresent[] {
  return readLegacyTable(db, "Present", ["id", "name", "oncePerUser", "body"], (row) => ({
    id: requiredNumber(row, "id"),
    name: requiredString(row, "name"),
    oncePerUser: requiredBoolean(row, "oncePerUser"),
    body: requiredJson(row, "body") as PrismNeoPresent["body"],
  }));
}

function readLegacyRedeems(db: Database): PrismNeoRedeem[] {
  return readLegacyTable(
    db,
    "Redeem",
    ["id", "code", "presentId", "activeAt", "expireAt", "maxUseCount"],
    (row) => ({
      id: requiredNumber(row, "id"),
      code: requiredString(row, "code"),
      presentId: requiredNumber(row, "presentId"),
      activeAt: optionalDate(row, "activeAt"),
      expireAt: optionalDate(row, "expireAt"),
      maxUseCount: requiredNumber(row, "maxUseCount"),
    }),
  );
}

function readLegacyRedeemRecords(db: Database): PrismNeoRedeemRecord[] {
  return readLegacyTable(db, "RedeemRecord", ["id", "userId", "redeemId", "presentId", "date"], (row) => ({
    id: requiredNumber(row, "id"),
    userId: requiredNumber(row, "userId"),
    redeemId: requiredNumber(row, "redeemId"),
    presentId: requiredNumber(row, "presentId"),
    date: requiredDate(row, "date"),
  }));
}

function readLegacyCoinRecords(db: Database): PrismNeoCoinRecord[] {
  return readLegacyTable(db, "CoinRecord", ["id", "userId", "machineName", "count", "createAt"], (row) => ({
    id: requiredNumber(row, "id"),
    userId: requiredNumber(row, "userId"),
    machineName: requiredString(row, "machineName"),
    count: requiredNumber(row, "count"),
    createAt: requiredDate(row, "createAt"),
  }));
}

function readLegacyDumpUsers(tables: LegacyDumpTables): PrismNeoUser[] {
  return readLegacyDumpTable(tables, "User", (row) => ({
    id: requiredNumber(row, "id"),
    createdAt: requiredDate(row, "createdAt"),
    isBanned: requiredBoolean(row, "isBanned"),
  }));
}

function readLegacyDumpBinds(tables: LegacyDumpTables): PrismNeoBind[] {
  return readLegacyDumpTable(tables, "Bind", (row) => ({
    id: requiredNumber(row, "id"),
    userId: requiredNumber(row, "userId"),
    type: requiredString(row, "type"),
    bid: requiredString(row, "bid"),
  }));
}

function readLegacyDumpAssetDefinitions(tables: LegacyDumpTables): PrismNeoAssetDefinition[] {
  return readLegacyDumpTable(tables, "Asset", (row) => ({
    id: requiredNumber(row, "id"),
    assetId: requiredNumber(row, "assetId"),
    type: requiredString(row, "type"),
    name: requiredString(row, "name"),
    description: optionalString(row, "description"),
    valid: requiredBoolean(row, "valid"),
    activeAt: optionalDate(row, "activeAt"),
    expireAt: optionalDate(row, "expireAt"),
    billingEffect: optionalJson(row, "billingEffect"),
  }));
}

function readLegacyDumpUserAssets(tables: LegacyDumpTables): PrismNeoUserAsset[] {
  return readLegacyDumpTable(tables, "UserAsset", (row) => ({
    id: requiredNumber(row, "id"),
    userId: requiredNumber(row, "userId"),
    assetDefId: requiredNumber(row, "assetDefId"),
    assetType: requiredString(row, "assetType"),
    count: requiredNumber(row, "count"),
    activeAt: optionalDate(row, "activeAt"),
    expireAt: optionalDate(row, "expireAt"),
    hide: optionalBoolean(row, "hide") ?? false,
  }));
}

function readLegacyDumpUserAssetLogs(tables: LegacyDumpTables): PrismNeoUserAssetLog[] {
  return readLegacyDumpTable(tables, "UserAssetLog", (row) => ({
    id: requiredNumber(row, "id"),
    userId: requiredNumber(row, "userId"),
    userAssetId: optionalNumber(row, "userAssetId"),
    assetId: requiredNumber(row, "assetId"),
    assetType: requiredString(row, "assetType"),
    changeAmount: requiredNumber(row, "changeAmount"),
    action: requiredString(row, "action"),
    comment: optionalString(row, "comment"),
    createdAt: optionalDate(row, "createdAt") ?? undefined,
  }));
}

function readLegacyDumpSessions(tables: LegacyDumpTables): PrismNeoSession[] {
  return readLegacyDumpTable(tables, "Session", (row) => ({
    id: requiredNumber(row, "id"),
    userId: requiredNumber(row, "userId"),
    createdAt: requiredDate(row, "createdAt"),
    closedAt: optionalDate(row, "closedAt"),
    isActive: optionalBoolean(row, "isActive"),
    billingCost: optionalNumber(row, "billingCost"),
    finalCost: optionalNumber(row, "finalCost"),
    costOverwrite: optionalNumber(row, "costOverwrite"),
  }));
}

function readLegacyDumpBillingRules(tables: LegacyDumpTables): PrismNeoBillingRule[] {
  return readLegacyDumpTable(tables, "BillingRule", (row) => ({
    id: requiredNumber(row, "id"),
    name: requiredString(row, "name"),
    available: requiredBoolean(row, "available"),
    priority: requiredNumber(row, "priority"),
    matchDate: optionalJson(row, "matchDate") as PrismNeoBillingRule["matchDate"],
    timeRange: requiredJson(row, "timeRange") as PrismNeoBillingRule["timeRange"],
    pricing: requiredJson(row, "pricing") as PrismNeoBillingRule["pricing"],
  }));
}

function readLegacyDumpBillingRecords(tables: LegacyDumpTables): PrismNeoBillingRecord[] {
  return readLegacyDumpTable(tables, "BillingRecord", (row) => ({
    id: requiredNumber(row, "id"),
    userId: requiredNumber(row, "userId"),
    ruleId: requiredNumber(row, "ruleId"),
    ruleStartTimeStamp: requiredNumber(row, "ruleStartTimeStamp"),
    cost: requiredNumber(row, "cost"),
    billingStart: requiredDate(row, "billingStart"),
    billingEnd: requiredDate(row, "billingEnd"),
    durationMin: requiredNumber(row, "durationMin"),
  }));
}

function readLegacyDumpPresents(tables: LegacyDumpTables): PrismNeoPresent[] {
  return readLegacyDumpTable(tables, "Present", (row) => ({
    id: requiredNumber(row, "id"),
    name: requiredString(row, "name"),
    oncePerUser: requiredBoolean(row, "oncePerUser"),
    body: requiredJson(row, "body") as PrismNeoPresent["body"],
  }));
}

function readLegacyDumpRedeems(tables: LegacyDumpTables): PrismNeoRedeem[] {
  return readLegacyDumpTable(tables, "Redeem", (row) => ({
    id: requiredNumber(row, "id"),
    code: requiredString(row, "code"),
    presentId: requiredNumber(row, "presentId"),
    activeAt: optionalDate(row, "activeAt"),
    expireAt: optionalDate(row, "expireAt"),
    maxUseCount: requiredNumber(row, "maxUseCount"),
  }));
}

function readLegacyDumpRedeemRecords(tables: LegacyDumpTables): PrismNeoRedeemRecord[] {
  return readLegacyDumpTable(tables, "RedeemRecord", (row) => ({
    id: requiredNumber(row, "id"),
    userId: requiredNumber(row, "userId"),
    redeemId: requiredNumber(row, "redeemId"),
    presentId: requiredNumber(row, "presentId"),
    date: requiredDate(row, "date"),
  }));
}

function readLegacyDumpCoinRecords(tables: LegacyDumpTables): PrismNeoCoinRecord[] {
  return readLegacyDumpTable(tables, "CoinRecord", (row) => ({
    id: requiredNumber(row, "id"),
    userId: requiredNumber(row, "userId"),
    machineName: requiredString(row, "machineName"),
    count: requiredNumber(row, "count"),
    createAt: requiredDate(row, "createAt"),
  }));
}

function readLegacyDumpTable<T>(
  tables: LegacyDumpTables,
  tableName: string,
  mapper: (row: LegacyRow) => T,
): T[] {
  const rows = tables.get(tableName);
  if (!rows) return [];
  return rows.sort(compareLegacyRowsById).map(mapper);
}

function compareLegacyRowsById(left: LegacyRow, right: LegacyRow): number {
  return toNumber(left.id) - toNumber(right.id);
}

function parsePostgresTextCopyDump(sql: string): LegacyDumpTables {
  const tables: LegacyDumpTables = new Map();
  const lines = sql.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const copy = parseCopyHeader(lines[index]);
    if (!copy) continue;

    const rows: LegacyRow[] = [];
    index += 1;
    for (; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === "\\.") break;
      rows.push(toLegacyDumpRow(copy.columns, line));
    }
    tables.set(copy.tableName, rows);
  }

  return tables;
}

function parseCopyHeader(line: string): { tableName: string; columns: string[] } | null {
  const match = /^COPY public\."([^"]+)" \((.*)\) FROM stdin;$/.exec(line);
  if (!match) return null;
  return {
    tableName: match[1],
    columns: splitPostgresIdentifierList(match[2]),
  };
}

function splitPostgresIdentifierList(input: string): string[] {
  const columns: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      columns.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim()) columns.push(current.trim());
  return columns;
}

function toLegacyDumpRow(columns: readonly string[], line: string): LegacyRow {
  const fields = line.split("\t");
  if (fields.length !== columns.length) {
    throw new Error(`Postgres dump COPY row has ${fields.length} fields, expected ${columns.length}.`);
  }
  return Object.fromEntries(columns.map((column, index) => [column, decodePostgresCopyField(fields[index])]));
}

function decodePostgresCopyField(field: string): string | null {
  if (field === "\\N") return null;

  let decoded = "";
  for (let index = 0; index < field.length; index += 1) {
    const char = field[index];
    if (char !== "\\") {
      decoded += char;
      continue;
    }

    const next = field[index + 1];
    if (next === undefined) {
      decoded += "\\";
      continue;
    }
    index += 1;
    if (next === "b") decoded += "\b";
    else if (next === "f") decoded += "\f";
    else if (next === "n") decoded += "\n";
    else if (next === "r") decoded += "\r";
    else if (next === "t") decoded += "\t";
    else if (isOctalDigit(next)) {
      const octal = readPostgresCopyOctal(field, index);
      decoded += String.fromCharCode(Number.parseInt(octal.value, 8));
      index = octal.endIndex;
    } else {
      decoded += next;
    }
  }

  return decoded;
}

function readPostgresCopyOctal(field: string, startIndex: number): { value: string; endIndex: number } {
  let value = field[startIndex];
  let endIndex = startIndex;
  for (let offset = 1; offset < 3; offset += 1) {
    const char = field[startIndex + offset];
    if (!isOctalDigit(char)) break;
    value += char;
    endIndex = startIndex + offset;
  }
  return { value, endIndex };
}

function isOctalDigit(char: string | undefined): boolean {
  return char !== undefined && /^[0-7]$/.test(char);
}

function readLegacyTable<T>(
  db: Database,
  tableName: string,
  columns: readonly string[],
  mapper: (row: LegacyRow) => T,
): T[] {
  if (!legacyTableExists(db, tableName)) return [];

  const columnList = columns.map(quoteIdentifier).join(", ");
  const rows = db.query(`SELECT ${columnList} FROM ${quoteIdentifier(tableName)} ORDER BY "id"`).all() as LegacyRow[];
  return rows.map(mapper);
}

function legacyTableExists(db: Database, tableName: string): boolean {
  const row = db
    .query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { count?: number | bigint } | null;
  return Number(row?.count ?? 0) > 0;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function requiredDate(row: LegacyRow, key: string): Date {
  const date = toDate(requiredValue(row, key), key);
  if (!date) throw new Error(`Legacy column ${key} is required.`);
  return date;
}

function optionalDate(row: LegacyRow, key: string): Date | null {
  return toDate(row[key], key);
}

function toDate(value: unknown, key: string): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value;

  // Legacy PostgreSQL dumps use timestamp without time zone, which stores
  // server-local time (Asia/Shanghai, UTC+8). JavaScript's new Date(str)
  // parses timezone-less strings using the host timezone, so a migration
  // run on a UTC machine would shift every timestamp by 8 hours. Parse the
  // string as an explicit UTC+8 offset instead.
  const date =
    typeof value === "number" || typeof value === "bigint"
      ? new Date(Number(value))
      : typeof value === "string"
        ? parseLegacyTimestamp(value)
        : null;
  if (!date || Number.isNaN(date.getTime())) throw new Error(`Legacy column ${key} must be a date-like value.`);
  return date;
}

function parseLegacyTimestamp(value: string): Date {
  const trimmed = value.trim();
  // Already has timezone info (Z, +HH:MM, -HH:MM) - respect it.
  if (/[zZ]$/.test(trimmed) || /[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    return new Date(trimmed);
  }
  // timestamp without time zone from the legacy PostgreSQL dump stores
  // UTC time. Append Z so the Date is parsed correctly as UTC on any host timezone.
  return new Date(trimmed.replace(" ", "T") + "Z");
}

function printSummary(plan: PrismNeoMigrationPlan, sqlitePath: string): void {
  const lines = [
    "Imported prism-neo snapshot",
    `sqlite: ${sqlitePath}`,
    `players: ${plan.players.length}`,
    `playerIdentities: ${plan.playerIdentities.length}`,
    `assetDefinitions: ${plan.assetDefinitions.length}`,
    `assetHoldings: ${plan.assetHoldings.length}`,
    `assetLedgerEntries: ${plan.assetLedgerEntries.length}`,
    `sessions: ${plan.sessions.length}`,
    `settlements: ${plan.settlements.length}`,
    `pricingConfigs: ${plan.pricingConfigs.length}`,
    `pricingHistoryEntries: ${plan.pricingHistoryEntries.length}`,
    `presents: ${plan.presents.length}`,
    `redeemCodes: ${plan.redeemCodes.length}`,
    `redeemRecords: ${plan.redeemRecords.length}`,
    `deviceOperations: ${plan.deviceOperations.length}`,
  ];
  console.log(lines.join("\n"));
}

function printExportSummary(snapshot: CreatePrismNeoMigrationPlanInput, sqlitePath: string, outputPath: string): void {
  const lines = [
    "Exported prism-neo snapshot",
    `sqlite: ${sqlitePath}`,
    `output: ${outputPath}`,
    `users: ${snapshot.users?.length ?? 0}`,
    `binds: ${snapshot.binds?.length ?? 0}`,
    `assetDefinitions: ${snapshot.assetDefinitions?.length ?? 0}`,
    `userAssets: ${snapshot.userAssets?.length ?? 0}`,
    `userAssetLogs: ${snapshot.userAssetLogs?.length ?? 0}`,
    `sessions: ${snapshot.sessions?.length ?? 0}`,
    `billingRules: ${snapshot.billingRules?.length ?? 0}`,
    `billingRecords: ${snapshot.billingRecords?.length ?? 0}`,
    `presents: ${snapshot.presents?.length ?? 0}`,
    `redeems: ${snapshot.redeems?.length ?? 0}`,
    `redeemRecords: ${snapshot.redeemRecords?.length ?? 0}`,
    `coinRecords: ${snapshot.coinRecords?.length ?? 0}`,
  ];
  console.log(lines.join("\n"));
}

function printPostgresExportSummary(snapshot: CreatePrismNeoMigrationPlanInput, url: string, outputPath: string): void {
  const safeUrl = redactPostgresUrl(url);
  const lines = [
    "Exported prism-neo Postgres snapshot",
    `url: ${safeUrl}`,
    `output: ${outputPath}`,
    `users: ${snapshot.users?.length ?? 0}`,
    `binds: ${snapshot.binds?.length ?? 0}`,
    `assetDefinitions: ${snapshot.assetDefinitions?.length ?? 0}`,
    `userAssets: ${snapshot.userAssets?.length ?? 0}`,
    `userAssetLogs: ${snapshot.userAssetLogs?.length ?? 0}`,
    `sessions: ${snapshot.sessions?.length ?? 0}`,
    `billingRules: ${snapshot.billingRules?.length ?? 0}`,
    `billingRecords: ${snapshot.billingRecords?.length ?? 0}`,
    `presents: ${snapshot.presents?.length ?? 0}`,
    `redeems: ${snapshot.redeems?.length ?? 0}`,
    `redeemRecords: ${snapshot.redeemRecords?.length ?? 0}`,
    `coinRecords: ${snapshot.coinRecords?.length ?? 0}`,
  ];
  console.log(lines.join("\n"));
}

function printPostgresDumpExportSummary(
  snapshot: CreatePrismNeoMigrationPlanInput,
  inputPath: string,
  outputPath: string,
): void {
  const lines = [
    "Exported prism-neo Postgres dump snapshot",
    `input: ${inputPath}`,
    `output: ${outputPath}`,
    `users: ${snapshot.users?.length ?? 0}`,
    `binds: ${snapshot.binds?.length ?? 0}`,
    `assetDefinitions: ${snapshot.assetDefinitions?.length ?? 0}`,
    `userAssets: ${snapshot.userAssets?.length ?? 0}`,
    `userAssetLogs: ${snapshot.userAssetLogs?.length ?? 0}`,
    `sessions: ${snapshot.sessions?.length ?? 0}`,
    `billingRules: ${snapshot.billingRules?.length ?? 0}`,
    `billingRecords: ${snapshot.billingRecords?.length ?? 0}`,
    `presents: ${snapshot.presents?.length ?? 0}`,
    `redeems: ${snapshot.redeems?.length ?? 0}`,
    `redeemRecords: ${snapshot.redeemRecords?.length ?? 0}`,
    `coinRecords: ${snapshot.coinRecords?.length ?? 0}`,
  ];
  console.log(lines.join("\n"));
}

function redactPostgresUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "****";
    return parsed.toString();
  } catch (_error) {
    return "<redacted>";
  }
}

function printUsage(): void {
  console.error(
    [
      "Usage:",
      "  bun run packages/migration/src/cli.ts export-sqlite --sqlite prism-neo.sqlite --output prism-neo-export.json",
      "  bun run packages/migration/src/cli.ts export-postgres --url postgres://user:pass@host:5432/db --output prism-neo-export.json",
      "  bun run packages/migration/src/cli.ts export-postgres-dump --input prism-neo.sql --output prism-neo-export.json",
      "  bun run packages/migration/src/cli.ts import-json --input prism-neo-export.json --sqlite prism.sqlite",
    ].join("\n"),
  );
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
