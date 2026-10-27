import type { LegacyD1Database } from "./compat.js";
import type { D1BoundStatementLike as D1PreparedStatement } from "@prism/adapter-d1";
import { registerShopDataJobRoutes } from "./shop-data-jobs.js";
import { startShopExport, finishShopExport, importAttemptStatement } from "./shop-data-export.js";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { createD1Repositories } from "@prism/adapter-d1";
import { withOperationLease } from "@prism/application";
import { requireUser } from "../../../middleware/auth.js";
import { getBillingShop, staffPrincipal, type BillingShop } from "./compat.js";
import { sha256 } from "../../../crypto.js";
import { freeShopStatements } from "../../../resources/billed-sql.js";
import { DEFAULT_RESOURCE_GROUP_ID } from "../../../resources/billing.js";
import { missingFrontDeskStatements } from "../../platform/shops.js";
import { notifyBotsChangedAfter } from "../../../durable-objects/shop-hub-client.js";
import { jsonError } from "../../../http.js";
import { enforceRateLimits } from "./compat.js";
import type { AppBindings } from "./compat.js";
import {
  backupSchema, businessTables, maxFileBytes, maxChunkBytes, rowChunks, scopeSchema,
  tableSchemas, tablesFor, validateBackup, type DataRow, type ShopBackup,
} from "./shop-data-format.js";

type C = Context<AppBindings, any, any>;
const limits = { fileBytes: maxFileBytes, rowBytes: maxChunkBytes };
const warnings = [
  "仅导入空店铺，保留目标店铺的名称、位置、时区、封面和管理员。",
  "不包含网页登录账号关联、登录凭据、Bot 凭据、玩家卡片或设备连接；导入后需要重新绑定账号并配置硬件连接，玩家再次刷卡时卡片重新绑定。",
  "业务备份包含玩家平台身份、卡片标识及财务数据，请妥善保管文件。",
];
const settingsState = `(SELECT json_array(
  (SELECT COALESCE(json_group_array(json_array(key,value_json,updated_at)),'[]')
    FROM (SELECT key,value_json,updated_at FROM app_settings WHERE shop_id=s.id ORDER BY key)),
  json_array(s.name,s.latitude,s.longitude,s.radius_meters,s.hero_data,s.hero_hash,s.updated_at)) FROM shops s WHERE s.id=?)`;
const billingState = `(SELECT COALESCE(json_group_array(json_array(billing_enabled,auto_register,checkin_geo,checkout_geo,
  machine_geo,entry_pricing_ids_json,bot_contact,identity_binding_required)),'[]') FROM shop_billing_settings WHERE shop_id=?)`;
const emptyTables = [...businessTables, "api_tokens", "machines", "resource_groups", "shop_player_accounts", "shop_platform_bindings", "mahjong_seats", "device_capabilities", "device_operations", "device_events", "device_state", "player_cards", "resource_occupancies"];
// One statement captures all target state and is reused as the atomic apply condition.
export const snapshotSql = `SELECT (${emptyTables.map(table => `(SELECT COUNT(*) FROM ${table} WHERE shop_id=?)`).join("+")})
  +(SELECT COUNT(*) FROM staff_users WHERE shop_id=? AND id NOT LIKE 'account:%')
  +(SELECT MAX(COUNT(*)-1,0) FROM shop_staff_accounts WHERE shop_id=?) AS rows,
  ${settingsState} AS settings, ${billingState} AS billing`;
export const snapshotBindings = (shopId: string) => Array(emptyTables.length + 4).fill(shopId) as string[];
type Snapshot = { rows: number; settings: string; billing: string };
export const snapshotKey = (state: Snapshot) => JSON.stringify([state.rows, state.settings, state.billing]);
export async function targetState(c: C, shopId: string) {
  const state = await (c.env.DB as LegacyD1Database).prepare(snapshotSql).bind(...snapshotBindings(shopId)).first<Snapshot>();
  if (!state) throw new Error("Missing shop data snapshot");
  return state;
}
export async function owner(c: C, rate = true) {
  const shop = await getBillingShop(c, c.req.param("shopCode")!);
  const principal = await staffPrincipal(c, shop, true);
  if (principal.staffRole !== "owner") jsonError(403, "只有店铺负责人可以导入和导出数据", "FORBIDDEN");
  if (rate) await enforceRateLimits(c, [{ key: `shop-data:${shop.id}:${requireUser(c).id}`, limit: 10, windowSeconds: 60 }]);
  return shop;
}
async function readBody(c: C) {
  // Enforce the real streamed byte count, not only the untrusted Content-Length header.
  const reader = c.req.raw.body?.getReader();
  if (!reader) jsonError(400, "请选择有效的 JSON 备份文件", "INVALID_BACKUP");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > maxFileBytes + 1024) { await reader.cancel(); jsonError(413, "备份文件超过 10 MiB 限制", "BACKUP_TOO_LARGE"); }
    chunks.push(part.value);
  }
  const buffer = new Uint8Array(bytes);
  let position = 0;
  for (const chunk of chunks) { buffer.set(chunk, position); position += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(buffer)) as unknown; }
  catch { jsonError(400, "请选择有效的 JSON 备份文件", "INVALID_BACKUP"); }
}
const previewBody = z.object({ backup: backupSchema }).strict();
const applyBody = previewBody.extend({ fingerprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/), operationId: z.string().uuid() });
function parseBody<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) jsonError(400, "备份格式或版本不受支持", "INVALID_BACKUP", result.error.flatten());
  return result.data;
}
async function inspect(c: C, shop: BillingShop, backup: ShopBackup) {
  const errors = validateBackup(backup);
  const state = await targetState(c, shop.id);
  if (state.rows) errors.push("目标店铺已有玩家、账单、配置或资源，请选择空店铺导入");
  const fingerprint = await sha256(JSON.stringify({ shopId: shop.id, backup, state }));
  return { canImport: errors.length === 0, errors, fingerprint, warnings, limits,
    scope: backup.scope, source: backup.source,
    counts: Object.fromEntries(tablesFor(backup.scope).map(table => [table, backup.tables[table]!.length])) };
}
async function exportBackup(c: C, shop: BillingShop, scope: ShopBackup["scope"]): Promise<ShopBackup> {
  const tables = tablesFor(scope);
  const result = await (c.env.DB as LegacyD1Database).batch<DataRow>([
    ...tables.map(table => (c.env.DB as LegacyD1Database).prepare(`SELECT ${tableSchemas[table].columns.map(column => column.name).join(",")} FROM ${table}
      WHERE shop_id=? ${table === "player_identities" ? "AND provider NOT IN ('web-account','aime')" : ""} ORDER BY rowid`).bind(shop.id)),
    (c.env.DB as LegacyD1Database).prepare("SELECT key,value_json FROM app_settings WHERE shop_id=? AND key IN ('venue.operations','player.registration','cashier.settings')").bind(shop.id),
    (c.env.DB as LegacyD1Database).prepare("SELECT * FROM shop_billing_settings WHERE shop_id=?").bind(shop.id),
  ]);
  const settings = new Map(result[tables.length]!.results.map(row => [row.key, JSON.parse(String(row.value_json))]));
  const billing = result[tables.length + 1]!.results[0];
  const flag = (key: string, fallback: boolean) => billing ? !!billing[key] : fallback;
  const defaultGroupPlan = (await (c.env.DB as LegacyD1Database).prepare(
    "SELECT default_pricing_config_id AS plan FROM resource_groups WHERE shop_id=? AND id=?",
  ).bind(shop.id, DEFAULT_RESOURCE_GROUP_ID).first<{ plan: string | null }>())?.plan ?? null;
  const backup: ShopBackup = {
    format: "prism-shop-data", version: 1, scope, exportedAt: new Date().toISOString(),
    source: { publicId: shop.public_id, name: shop.name, timeZone: shop.time_zone, origin: new URL(c.req.url).origin,
      location: { latitude: shop.latitude, longitude: shop.longitude, radiusMeters: shop.radius_meters } },
    storage: { timeZone: "UTC", money: "minor-units" },
    settings: {
      cashierEnabled: !!settings.get("cashier.settings")?.enabled,
      autoRegister: flag("auto_register", false), identityBindingRequired: flag("identity_binding_required", true),
      checkinGeo: flag("checkin_geo", false), checkoutGeo: flag("checkout_geo", false), machineGeo: flag("machine_geo", false),
      // v1 files have no resource groups: the default group's plan travels here, as it always did.
      entryPricingIds: defaultGroupPlan ? [defaultGroupPlan] : [], botContact: String(billing?.bot_contact ?? ""),
      coinCooldownMs: settings.get("venue.operations")?.coinCooldownMs ?? 60_000,
      defaultPresentId: settings.get("player.registration")?.defaultPresentId ?? null,
    },
    tables: Object.fromEntries(tables.map((table, index) => [table, result[index]!.results])),
  };
  if (tables.some(table => backup.tables[table]!.some(row => new TextEncoder().encode(JSON.stringify(row)).length + 3 > maxChunkBytes)) ||
    new TextEncoder().encode(JSON.stringify(backup, null, 2)).length > maxFileBytes)
    jsonError(413, "数据超过当前导入导出容量限制，请联系管理员进行数据库备份", "BACKUP_TOO_LARGE");
  return backup;
}

export function registerShopDataRoutes(app: Hono<AppBindings>) {
  registerShopDataJobRoutes(app);
  app.get("/export", async c => {
    const shop = await owner(c);
    const scope = parseBody(scopeSchema, c.req.query("scope") ?? "business");
    const job = await startShopExport(c, shop, scope);
    let backup: ShopBackup;
    try { backup = await exportBackup(c, shop, scope); }
    catch (error) { await finishShopExport(c.env.DB as LegacyD1Database, job.id, "failed"); throw error; }
    await finishShopExport(c.env.DB as LegacyD1Database, job.id, "completed");
    const file = `prism-${shop.public_id}-${scope}-${backup.exportedAt.slice(0, 10)}.json`;
    return c.body(JSON.stringify(backup, null, 2), 200, {
      "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${file}"`,
      "cache-control": "no-store", "x-content-type-options": "nosniff",
    });
  });
  app.post("/import/preview", async c => {
    const shop = await owner(c);
    const { backup } = parseBody(previewBody, await readBody(c));
    return c.json(await inspect(c, shop, backup));
  });
  app.post("/import/apply", async c => {
    const shop = await owner(c);
    const { backup, fingerprint, operationId } = parseBody(applyBody, await readBody(c));
    const user = requireUser(c);
    const hash = await sha256(JSON.stringify(backup));
    const repos = createD1Repositories({ db: c.env.DB, shopId: shop.id, id: crypto.randomUUID, now: () => new Date() });
    return withOperationLease({ repository: repos.operationLocks, scope: "shop.cashier", resourceId: shop.id, now: () => new Date() }, async () => {
      const previous = await (c.env.DB as LegacyD1Database).prepare("SELECT kind,request_hash,result_json FROM player_operations WHERE shop_id=? AND user_id=? AND id=?")
        .bind(shop.id, user.id, operationId).first<{ kind: string; request_hash: string; result_json: string | null }>();
      if (previous) {
        if (previous.kind !== "data/import" || previous.request_hash !== hash) jsonError(409, "请求编号已用于其他操作", "OPERATION_CONFLICT");
        if (previous.result_json) return c.json(JSON.parse(previous.result_json));
        jsonError(409, "导入操作尚未完成", "OPERATION_PENDING");
      }
      const preview = await inspect(c, shop, backup);
      if (!preview.canImport) jsonError(409, "文件检查未通过", "IMPORT_NOT_READY", preview);
      if (preview.fingerprint !== fingerprint) jsonError(409, "店铺数据或文件已变化，请重新导入", "IMPORT_TARGET_CHANGED");
      const state = await targetState(c, shop.id);
      // Recheck the fingerprint for this exact state, including races between the two reads.
      if (await sha256(JSON.stringify({ shopId: shop.id, backup, state })) !== fingerprint)
        jsonError(409, "店铺数据或文件已变化，请重新导入", "IMPORT_TARGET_CHANGED");
      const now = new Date().toISOString();
      const result = { imported: true, scope: backup.scope, counts: preview.counts };
      const statements: D1PreparedStatement[] = [
        importAttemptStatement(c, shop, operationId),
        // A NOT NULL failure aborts the entire batch if an ordinary writer changed the target.
        (c.env.DB as LegacyD1Database).prepare(`INSERT INTO player_operations(shop_id,user_id,id,kind,status,request_hash,result_json,created_at)
          SELECT ?,?,CASE WHEN json_array(rows,settings,billing)=? THEN ? ELSE NULL END,'data/import','completed',?,?,?
          FROM (${snapshotSql})`).bind(shop.id, user.id, snapshotKey(state), operationId, hash, JSON.stringify(result), now, ...snapshotBindings(shop.id)),
      ];
      // Disable only automatic publication/binding in the same transaction as the import.
      // Immutable history, UTC guards and deployment fences stay installed throughout.
      const triggers = backup.scope === "business"
        ? (await (c.env.DB as LegacyD1Database).prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('pricing_config_version_insert','session_pricing_bind') ORDER BY name")
          .all<{ name: string; sql: string }>()).results : [];
      if (backup.scope === "business" && triggers.length !== 2) jsonError(409, "计费数据库结构不完整，无法恢复历史版本", "IMPORT_SCHEMA_MISMATCH");
      statements.push(...triggers.map(trigger => (c.env.DB as LegacyD1Database).prepare(`DROP TRIGGER ${trigger.name}`)));
      for (const table of tablesFor(backup.scope)) {
        const rows = backup.tables[table]!;
        if (!rows.length) continue;
        const columns = tableSchemas[table].columns.map(column => column.name);
        for (const chunk of rowChunks(rows)) statements.push((c.env.DB as LegacyD1Database).prepare(`INSERT INTO ${table}(shop_id,${columns.join(",")})
          SELECT ?,${columns.map(column => `json_extract(value,'$.${column}')`).join(",")} FROM json_each(?)`)
          .bind(shop.id, chunk));
      }
      statements.push(...triggers.map(trigger => (c.env.DB as LegacyD1Database).prepare(trigger.sql)));
      const s = backup.settings;
      statements.push((c.env.DB as LegacyD1Database).prepare(`INSERT INTO shop_billing_settings(shop_id,auto_register,checkin_geo,checkout_geo,machine_geo,bot_contact,identity_binding_required)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(shop_id) DO UPDATE SET auto_register=excluded.auto_register,
        checkin_geo=excluded.checkin_geo,checkout_geo=excluded.checkout_geo,machine_geo=excluded.machine_geo,
        bot_contact=excluded.bot_contact,identity_binding_required=excluded.identity_binding_required`)
        .bind(shop.id, +s.autoRegister, +s.checkinGeo, +s.checkoutGeo, +s.machineGeo, s.botContact, +s.identityBindingRequired));
      // v1 files carry the default group's plan as the shop's default plan.
      statements.push((c.env.DB as LegacyD1Database).prepare(`INSERT INTO resource_groups(shop_id,id,name,enabled,default_pricing_config_id,created_at,updated_at)
        VALUES (?,?,'默认资源组',1,?,?,?) ON CONFLICT(shop_id,id) DO UPDATE SET default_pricing_config_id=excluded.default_pricing_config_id`)
        .bind(shop.id, DEFAULT_RESOURCE_GROUP_ID, s.entryPricingIds?.[0] ?? null, now, now));
      if (s.billingEnabled === false) statements.push(...freeShopStatements(c.env.DB as LegacyD1Database, shop.id));
      for (const [key, value] of [
        ["venue.operations", { timeZone: "UTC", coinCooldownMs: s.coinCooldownMs }],
        ["player.registration", { defaultPresentId: s.defaultPresentId }], ["cashier.settings", { enabled: s.cashierEnabled }],
      ] as const) statements.push((c.env.DB as LegacyD1Database).prepare(`INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(shop_id,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).bind(shop.id, key, JSON.stringify(value), now));
      statements.push(...missingFrontDeskStatements(c.env.DB as LegacyD1Database, shop.id));
      try { await (c.env.DB as LegacyD1Database).batch(statements); }
      catch (error) {
        const message = String(error);
        if (message.includes("NOT NULL constraint failed: player_operations.id")) jsonError(409, "店铺数据或文件已变化，请重新导入", "IMPORT_TARGET_CHANGED");
        // Fence failures remain errors; rollback also restores both triggers and the operation ID.
        if (message.includes("constraint failed") || message.includes("CASHIER_PROFILE_RESTRICTED"))
          jsonError(409, "数据关联或约束校验失败，导入已全部回滚", "IMPORT_CONSTRAINT_FAILED");
        throw error;
      }
      notifyBotsChangedAfter(c, shop.id);
      return c.json(result);
    });
  });
}
