import { z } from "zod";
import { sqliteSchema, toPricingConfig, type PricingConfigRow } from "@prism/storage-sql";
import { validatePricingConfig } from "@prism/core";

export const configurationTables = [
  "pricing_effects", "asset_definitions", "pricing_configs", "presents", "business_items",
] as const;
// Dependency order is also the insertion order. Credentials and live hardware state are excluded.
export const businessTables = [
  ...configurationTables, "pricing_config_versions", "pricing_releases", "pricing_release_heads",
  "players", "player_identities", "cashier_profiles", "sessions", "session_pricing_releases",
  "asset_holdings", "asset_transactions", "asset_ledger_entries", "redeem_codes", "redeem_records",
  "player_checkouts", "checkout_timelines", "settlements", "settlement_charge_items",
  "settlement_adjustments", "pricing_history_entries", "pricing_cap_history_entries",
  "business_item_orders", "cashier_payments",
] as const;
export type TableName = typeof businessTables[number];
export type DataRow = Record<string, string | number | null>;
export const maxFileBytes = 10 * 1024 * 1024;
export const maxChunkBytes = 128 * 1024;
export const scopeSchema = z.enum(["configuration", "business"]);
const primitive = z.union([z.string(), z.number().finite(), z.null()]);
export const backupSchema = z.object({
  format: z.literal("prism-shop-data"), version: z.literal(1), scope: scopeSchema,
  exportedAt: z.string().datetime(),
  source: z.object({ publicId: z.string().min(1), name: z.string(), timeZone: z.string(), origin: z.string().url().optional(),
    location: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), radiusMeters: z.number().positive() }).strict().optional(),
  }).strict(),
  storage: z.object({ timeZone: z.literal("UTC"), money: z.literal("minor-units") }).strict(),
  settings: z.object({
    /**
     * Retired: files from before billing moved onto resources. `false` means the
     * shop did not bill, so importing it clears every plan assignment.
     */
    billingEnabled: z.boolean().optional(),
    cashierEnabled: z.boolean(), autoRegister: z.boolean(),
    identityBindingRequired: z.boolean(), checkinGeo: z.boolean(), checkoutGeo: z.boolean(), machineGeo: z.boolean(),
    /** Older files: the default group's plan, from when it was the shop's default plan. */
    entryPricingIds: z.array(z.string().min(1)).max(30).optional(), botContact: z.string().max(500),
    coinCooldownMs: z.number().int().nonnegative(), defaultPresentId: z.string().min(1).nullable(),
  }).strict(),
  tables: z.record(z.array(z.record(primitive))),
}).strict();
export type ShopBackup = z.infer<typeof backupSchema>;
export const tablesFor = (scope: ShopBackup["scope"]): readonly TableName[] =>
  scope === "business" ? businessTables : configurationTables;

// Read only trusted, checked-in SQL. Imported table/column names never become SQL identifiers.
export const tableSchemas = Object.fromEntries(businessTables.map(table => {
  const sql = sqliteSchema.find(sql => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`));
  if (!sql) throw new Error(`Missing backup schema: ${table}`);
  const columns = [...sql.matchAll(/\b([a-z_]+)\s+(TEXT|INTEGER|REAL)\b(\s+NOT NULL)?/g)]
    .filter(match => match[1] !== "shop_id")
    .map(match => ({ name: match[1]!, type: match[2]!, required: !!match[3] }));
  const keys = [...sql.matchAll(/(?:PRIMARY KEY|UNIQUE)\s*\(([^)]+)\)/g)]
    .map(match => match[1]!.split(",").map(column => column.trim()).filter(column => column !== "shop_id"));
  const foreignKeys = [...sql.matchAll(/FOREIGN KEY\s*\(([^)]+)\)\s*REFERENCES\s*(\w+)\s*\(([^)]+)\)/g)]
    .map(match => ({ table: match[2]!, columns: match[1]!.split(",").map(s => s.trim()).filter(s => s !== "shop_id"),
      referenced: match[3]!.split(",").map(s => s.trim()).filter(s => s !== "shop_id") }));
  const enums = [...sql.matchAll(/CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]+)\)\)/g)]
    .map(match => ({ column: match[1]!, values: match[2]!.split(",").map(value => {
      const trimmed = value.trim(); return trimmed.startsWith("'") ? trimmed.slice(1, -1) : Number(trimmed);
    }) }));
  return [table, { columns, keys, foreignKeys, enums }];
})) as Record<TableName, {
  columns: { name: string; type: string; required: boolean }[];
  keys: string[][];
  foreignKeys: { table: string; columns: string[]; referenced: string[] }[];
  enums: { column: string; values: (string | number)[] }[];
}>;

export function validateBackup(backup: ShopBackup): string[] {
  const errors: string[] = [];
  const tables = tablesFor(backup.scope);
  const expected = [...tables].sort().join(",");
  if (Object.keys(backup.tables).sort().join(",") !== expected) return ["文件的数据表与所选备份范围不符"];
  const add = (message: string) => { if (errors.length < 30) errors.push(message); };
  for (const table of tables) {
    const rows = backup.tables[table]!;
    const schema = tableSchemas[table];
    const columns = schema.columns.map(column => column.name).sort().join(",");
    const unique = schema.keys.map(() => new Set<string>());
    for (const [index, row] of rows.entries()) {
      const label = `${table} 第 ${index + 1} 行`;
      if (new TextEncoder().encode(JSON.stringify(row)).length + 3 > maxChunkBytes) add(`${label} 超出单条 128 KiB 限制`);
      if (Object.keys(row).sort().join(",") !== columns) { add(`${label} 字段不完整或包含未知字段`); continue; }
      for (const column of schema.columns) {
        const value = row[column.name];
        if (value === null && !column.required) continue;
        if ((column.type === "TEXT" && typeof value !== "string") ||
          (column.type === "INTEGER" && (typeof value !== "number" || !Number.isSafeInteger(value))) ||
          (column.type === "REAL" && typeof value !== "number")) add(`${label} 的 ${column.name} 类型不正确`);
        if (column.name.endsWith("_at") && typeof value === "string" && !Number.isFinite(Date.parse(value))) add(`${label} 的 ${column.name} 时间无效`);
        if (column.name.endsWith("_json") && typeof value === "string") {
          try { JSON.parse(value); } catch { add(`${label} 的 ${column.name} 不是有效 JSON`); }
        }
      }
      for (const rule of schema.enums) if (!rule.values.includes(row[rule.column] as string | number)) add(`${label} 的 ${rule.column} 值无效`);
      schema.keys.forEach((key, keyIndex) => {
        if (key.some(column => row[column] === null)) return;
        const value = JSON.stringify(key.map(column => row[column]));
        if (unique[keyIndex]!.has(value)) add(`${label} 的唯一标识重复`);
        unique[keyIndex]!.add(value);
      });
      if (table === "pricing_configs" || table === "pricing_config_versions") {
        try {
          validatePricingConfig(toPricingConfig({ ...row, id: row.id ?? row.config_id } as unknown as PricingConfigRow));
        } catch { add(`${label} 计费方案内容无效`); }
      }
      if (table === "player_identities" && row.provider === "web-account") add(`${label} 不允许导入网页账号身份`);
      if (table === "pricing_configs" && row.kind !== "charge.fixed") {
        try { if (JSON.parse(String(row.provider_json)).timeZone !== "UTC") add(`${label} 计费规则必须使用 UTC`); } catch { /* JSON error above */ }
      }
    }
  }
  if (errors.length) return errors;
  // Reference checks avoid partially imported balances, bills and promotion records.
  for (const table of tables) {
    for (const fk of tableSchemas[table].foreignKeys) {
      const target = backup.tables[fk.table];
      if (!target) { add(`${table} 缺少关联表 ${fk.table}`); continue; }
      const keys = new Set(target.map(row => JSON.stringify(fk.referenced.map(column => row[column]))));
      for (const row of backup.tables[table]!) {
        if (fk.columns.some(column => row[column] === null)) continue;
        if (!keys.has(JSON.stringify(fk.columns.map(column => row[column])))) add(`${table} 存在失效的 ${fk.table} 关联`);
      }
    }
  }
  const configs = new Map(backup.tables.pricing_configs!.map(row => [row.id, row]));
  const entryPricingIds = backup.settings.entryPricingIds ?? [];
  if (entryPricingIds.some(id => !configs.has(id))) add("入场规则引用了不存在的计费方案");
  // It becomes the default group's plan; a retired non-billing file drops it on import.
  if (backup.settings.billingEnabled !== false && entryPricingIds.length) {
    const assets = backup.tables.asset_definitions!;
    if (["paid", "free"].some(code => !assets.some(row => row.type === "currency" && row.code === code && row.status === "active"))) add("默认计费方案需要有效余额资产");
    if (entryPricingIds.some(id => {
      const row = configs.get(id); return !row || row.enabled !== 1 || row.status !== "active" || row.kind === "time.cap";
    })) add("默认计费方案不可用");
  }
  if (backup.settings.defaultPresentId && !backup.tables.presents!.some(row => row.id === backup.settings.defaultPresentId)) add("新玩家礼物不存在");
  if (backup.scope === "business") {
    const versions = new Set(backup.tables.pricing_config_versions!.map(row => row.version_id));
    for (const row of backup.tables.pricing_releases!) {
      const ids: unknown = JSON.parse(String(row.version_ids_json));
      if (!Array.isArray(ids) || ids.some(id => !versions.has(id))) add("计费发布版本引用了不存在的规则版本");
      // Historical versions keep the exact zone stored at the time; do not re-convert them.
      try { new Intl.DateTimeFormat("en", { timeZone: String(row.time_zone) }); } catch { add("历史计费发布版本的时区无效"); }
    }
    if (configs.size && backup.tables.pricing_release_heads!.length !== 1) add("缺少唯一的当前计费发布版本");
    const bound = new Set(backup.tables.session_pricing_releases!.map(row => row.session_id));
    if (backup.tables.sessions!.some(row => row.payment_status === "unpaid" && !bound.has(row.id))) add("未结会话缺少计费版本绑定");
    const cashierPlayers = new Set(backup.tables.cashier_profiles!.map(row => row.player_id));
    if (backup.tables.asset_holdings!.some(row => cashierPlayers.has(row.player_id))) add("前台玩家不可拥有余额资产");
  }
  return errors;
}

/** Keep every D1 bind below its size limit without limiting the total size of one table. */
export function rowChunks(rows: DataRow[]): string[] {
  const result: string[] = [];
  let chunk: string[] = [], size = 2;
  for (const row of rows) {
    const json = JSON.stringify(row);
    const bytes = new TextEncoder().encode(json).length + 1;
    if (bytes > maxChunkBytes) throw new Error("单条数据超过 128 KiB 限制");
    if (chunk.length && size + bytes > maxChunkBytes) {
      result.push(`[${chunk.join(",")}]`); chunk = []; size = 2;
    }
    chunk.push(json); size += bytes;
  }
  if (chunk.length) result.push(`[${chunk.join(",")}]`);
  return result;
}
