import { HA_CONNECTION_PREFIX, HA_CONNECTION_SECRETS } from "../../../resources/capabilities/ha-connections.js";
import type { LegacyD1Database } from "./compat.js";
import type { LegacyD1Database as D1Database, LegacyD1PreparedStatement as D1PreparedStatement } from "./compat.js";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { requireAdmin, requireUser } from "../../../middleware/auth.js";
import type { BillingShop } from "./compat.js";
import { decryptSecret } from "../../../crypto.js";
import { jsonError } from "../../../http.js";
import { owner } from "./shop-data.js";
import { schemas, currentTablesFor, type FullTable } from "./shop-data-v2-format.js";
import type { AppBindings } from "./compat.js";

type C = Context<AppBindings, any, any>;
type ExportJob = {
  id: string;
  shop_id: string;
  user_id: string;
  scope: "business" | "configuration";
  month: string;
  status: string;
  cursor: number;
  reading: number;
  row_cursor: string;
  page_rows: number;
  counts_json: string;
  created_at: string;
  expires_at: string;
};
const base = "";
const stride = 1000000000;
const leaseMs = 5 * 60_000;
const maximumMs = 2 * 3600_000;
const exportPageBytes = 1024 * 1024;
const exportPageRows = 4096;
const initialPageRows = 256;
const accountPageRows = 512;
const pageTables = 8;
const rowEncoder = new TextEncoder();
export const sourceColumns = (table: FullTable) => schemas[table].columns.map((c) => c.name);
const objectSql = (table: FullTable, alias = "") =>
  `json_object(${schemas[table].columns.map((c, i) => `'${c.name}',${alias}${sourceColumns(table)[i]}`).join(",")})`;
export function exportMonth(zone: string, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
}
export function shopExportError(error: unknown): never {
  const message = String(error);
  if (message.includes("SHOP_IMPORT_QUOTA"))
    jsonError(
      429,
      "本月导入次数已用完，需要更多次数请联系平台管理员",
      "IMPORT_MONTHLY_LIMIT",
    );
  if (message.includes("SHOP_EXPORT_QUOTA"))
    jsonError(
      429,
      "本月导出次数已用完，需要更多次数请联系平台管理员",
      "EXPORT_MONTHLY_LIMIT",
    );
  if (message.includes("SHOP_EXPORT_LOCKED"))
    jsonError(
      423,
      "店铺正在导出数据，暂时不能进行业务操作，请稍后重试",
      "SHOP_EXPORT_LOCKED",
    );
  if (message.includes("SHOP_EXPORT_BUSY"))
    jsonError(
      409,
      "店铺有正在处理的业务操作，请稍后再导出",
      "SHOP_EXPORT_BUSY",
    );
  throw error;
}
export function importAttemptStatement(c: C, shop: BillingShop, id: string) {
  return (c.env.DB as LegacyD1Database).prepare(
    "INSERT INTO shop_data_import_attempts(id,shop_id,user_id,month,created_at) VALUES (?,?,?,?,?)",
  ).bind(
    id,
    shop.id,
    requireUser(c).id,
    exportMonth(shop.time_zone),
    new Date().toISOString(),
  );
}
export async function finishShopExport(
  db: D1Database,
  id: string,
  status: "completed" | "cancelled" | "failed",
) {
  await db
    .prepare(
      "UPDATE shop_data_exports SET status=?,reading=0 WHERE id=? AND status='active'",
    )
    .bind(status, id)
    .run();
}
export async function startShopExport(
  c: C,
  shop: BillingShop,
  scope: ExportJob["scope"],
) {
  const now = new Date(),
    id = crypto.randomUUID(),
    month = exportMonth(shop.time_zone, now),
    user = requireUser(c);
  try {
    const result = await (c.env.DB as LegacyD1Database).prepare(
      `INSERT INTO shop_data_exports(id,shop_id,user_id,scope,month,status,created_at,expires_at)
      SELECT ?,?,?,?,?,'active',?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND banned_at IS NULL AND
        (role='admin' OR EXISTS(SELECT 1 FROM shop_members WHERE shop_id=? AND user_id=users.id AND role='owner')))`,
    )
      .bind(
        id,
        shop.id,
        user.id,
        scope,
        month,
        now.toISOString(),
        new Date(+now + leaseMs).toISOString(),
        user.id,
        shop.id,
      )
      .run();
    if (!result.meta.changes)
      jsonError(403, "只有店铺负责人可以导入和导出数据", "FORBIDDEN");
  } catch (error) {
    shopExportError(error);
  }
  return {
    id,
    shop_id: shop.id,
    user_id: user.id,
    scope,
    month,
    status: "active",
    cursor: 0,
    reading: 0,
    row_cursor: "[]",
    page_rows: 64,
    counts_json: "{}",
    created_at: now.toISOString(),
    expires_at: new Date(+now + leaseMs).toISOString(),
  } satisfies ExportJob;
}
async function getExport(c: C, cancel = false) {
  const user = requireUser(c),
    code = c.req.param("shopCode")!;
  // Match staffPrincipal's owner rules without fetching billing/settings or doing three serial permission reads.
  const [permission, jobs] = await (c.env.DB as LegacyD1Database).batch<
    ExportJob & { allowed: number }
  >([
    (c.env.DB as LegacyD1Database).prepare(
      `SELECT s.id,
      (m.user_id IS NOT NULL OR ?='admin') AND
      CASE WHEN f.status='active' THEN f.role='owner' ELSE (m.role='owner' OR ?='admin') END AS allowed
      FROM shops s LEFT JOIN shop_members m ON m.shop_id=s.id AND m.user_id=?
      LEFT JOIN shop_staff_accounts a ON a.shop_id=s.id AND a.user_id=?
      LEFT JOIN staff_users f ON f.shop_id=a.shop_id AND f.id=a.staff_id WHERE s.public_id=?`,
    ).bind(user.role, user.role, user.id, user.id, code),
    (c.env.DB as LegacyD1Database).prepare(
      `SELECT * FROM shop_data_exports WHERE id=?
      AND shop_id=(SELECT id FROM shops WHERE public_id=?)${cancel ? "" : " AND user_id=?"}`,
    ).bind(c.req.param("jobId"), code, ...(cancel ? [] : [user.id])),
  ]);
  if (!permission!.results.length)
    jsonError(404, "没有找到这个店铺", "SHOP_NOT_FOUND");
  if (!permission!.results[0]!.allowed)
    jsonError(403, "只有店铺负责人可以导入和导出数据", "FORBIDDEN");
  const job = jobs!.results[0];
  if (!job || (c.req.method === "GET" && job.status !== "active"))
    jsonError(404, "备份任务不存在或已过期", "TRANSFER_NOT_FOUND");
  return { job };
}
// Each UNION branch uses its existing (shop_id, account ID) index. Page only the selected IDs before constructing JSON.
const accountIdsSql = `WITH related AS (
 SELECT user_id FROM shop_player_accounts WHERE shop_id=? UNION SELECT user_id FROM shop_staff_accounts WHERE shop_id=?
 UNION SELECT user_id FROM shop_members WHERE shop_id=? UNION SELECT subject FROM player_identities WHERE shop_id=? AND provider='web-account'
 UNION SELECT source_user_id FROM shop_imported_accounts WHERE shop_id=? AND matched_user_id IS NULL
)`;
const accountSources = [
  ["shop_player_accounts", "user_id", ""],
  ["shop_staff_accounts", "user_id", ""],
  ["shop_members", "user_id", ""],
  ["player_identities", "subject", " AND provider='web-account'"],
  ["shop_imported_accounts", "source_user_id", " AND matched_user_id IS NULL"],
] as const;
const accountSql = `WITH related AS (${accountSources
  .map(
    ([table, key, filter]) =>
      `SELECT user_id FROM (SELECT ${key} AS user_id FROM ${table} WHERE shop_id=? AND ${key}>?${filter} ORDER BY ${key} LIMIT ?)`,
  )
  .join(" UNION ")}), selected AS (
 SELECT user_id FROM related ORDER BY user_id LIMIT ?
), links AS (
 SELECT r.user_id AS source_user_id,COALESCE(a.player_id,h.player_id,w.player_id) AS player_id,
 COALESCE(f.staff_id,h.staff_id) AS staff_id,COALESCE(m.role,h.member_role) AS member_role,
 COALESCE(a.verified_at,h.verified_at,w.created_at) AS verified_at,
 CASE WHEN u.id IS NOT NULL AND (a.user_id IS NOT NULL OR f.user_id IS NOT NULL OR m.user_id IS NOT NULL OR w.subject IS NOT NULL)
 THEN (SELECT json_group_array(json_object('provider',i.provider,'subject',i.provider_subject)) FROM auth_identities i WHERE i.user_id=u.id)||''
 ELSE COALESCE(h.identities_json,'[]') END AS identities_json,
 COALESCE(NULLIF((SELECT json_group_array(json_object('provider',b.provider,'subject',b.subject,'verified_at',b.verified_at))
 FROM shop_platform_bindings b WHERE b.shop_id=? AND b.user_id=u.id)||'','[]'),h.platform_bindings_json,'[]') AS platform_bindings_json
 FROM selected r LEFT JOIN users u ON u.id=r.user_id
 LEFT JOIN shop_player_accounts a ON a.user_id=r.user_id AND a.shop_id=? LEFT JOIN shop_staff_accounts f ON f.user_id=r.user_id AND f.shop_id=?
 LEFT JOIN shop_members m ON m.user_id=r.user_id AND m.shop_id=? LEFT JOIN player_identities w ON w.subject=r.user_id AND w.provider='web-account' AND w.shop_id=?
 LEFT JOIN shop_imported_accounts h ON h.source_user_id=r.user_id AND h.shop_id=? AND h.matched_user_id IS NULL
)`;
const accountBindings = (shopId: string) => Array(5).fill(shopId) as string[];
const validJobSql =
  "SELECT 1 AS valid FROM shop_data_exports WHERE id=? AND status='active' AND expires_at>? AND cursor=?";
async function metadata(c: C, shop: BillingShop, job: ExportJob) {
  const tables = currentTablesFor(job.scope);
  const result = await (c.env.DB as LegacyD1Database).batch<Record<string, string | number>>([
    (c.env.DB as LegacyD1Database).prepare(
      `SELECT json_object('format','prism-shop-data','version',4,'scope',?,'exportedAt',?,
      'source',json_object('publicId',s.public_id,'name',s.name,'timeZone',?,'origin',?,'location',json_object('latitude',s.latitude,'longitude',s.longitude,'radiusMeters',s.radius_meters)),
      'storage',json_object('timeZone','UTC','money','minor-units'),
      'shopProfile',json_object('name',s.name,'latitude',s.latitude,'longitude',s.longitude,'radiusMeters',s.radius_meters,'heroData',s.hero_data),
      'settings',json_object('autoRegister',json(CASE WHEN COALESCE(b.auto_register,0) THEN 'true' ELSE 'false' END),
      'identityBindingRequired',json(CASE WHEN COALESCE(b.identity_binding_required,1) THEN 'true' ELSE 'false' END),
      'checkinGeo',json(CASE WHEN COALESCE(b.checkin_geo,0) THEN 'true' ELSE 'false' END),
      'checkoutGeo',json(CASE WHEN COALESCE(b.checkout_geo,0) THEN 'true' ELSE 'false' END),
      'machineGeo',json(CASE WHEN COALESCE(b.machine_geo,0) THEN 'true' ELSE 'false' END),
      'botContact',COALESCE(b.bot_contact,''),
      'cashierEnabled',json(CASE WHEN COALESCE((SELECT json_extract(value_json,'$.enabled') FROM app_settings WHERE shop_id=s.id AND key='cashier.settings'),0) THEN 'true' ELSE 'false' END),
      'coinCooldownMs',COALESCE((SELECT json_extract(value_json,'$.coinCooldownMs') FROM app_settings WHERE shop_id=s.id AND key='venue.operations'),60000),
      'defaultPresentId',(SELECT json_extract(value_json,'$.defaultPresentId') FROM app_settings WHERE shop_id=s.id AND key='player.registration'))) AS header_json
      FROM shops s LEFT JOIN shop_billing_settings b ON b.shop_id=s.id WHERE s.id=?`,
    ).bind(
      job.scope,
      job.created_at,
      shop.time_zone,
      new URL(c.req.url).origin,
      shop.id,
    ),
    ...tables.map((table) =>
      table === "account_links"
        ? (c.env.DB as LegacyD1Database).prepare(
            accountIdsSql + " SELECT COUNT(*) AS n FROM related",
          ).bind(...accountBindings(shop.id))
        : (c.env.DB as LegacyD1Database).prepare(
            `SELECT COUNT(*) AS n FROM ${table} WHERE shop_id=?`,
          ).bind(shop.id),
    ),
    (c.env.DB as LegacyD1Database).prepare(validJobSql).bind(job.id, new Date().toISOString(), 0),
  ]);
  if (!result.at(-1)!.results.length)
    jsonError(410, "导出锁已过期，请联系平台管理员重试", "EXPORT_EXPIRED");
  return {
    jobId: job.id,
    headerJson: String(result[0]!.results[0]!.header_json),
    tables,
    counts: Object.fromEntries(
      tables.map((table, i) => [table, Number(result[i + 1]!.results[0]!.n)]),
    ),
    filename: `prism-${shop.public_id}-${job.scope}-${job.created_at.slice(0, 10)}.json`,
  };
}
async function createExport(
  c: C,
  shop: BillingShop,
  scope: ExportJob["scope"],
) {
  const job = await startShopExport(c, shop, scope);
  try {
    const info = await metadata(c, shop, job);
    const saved = await (c.env.DB as LegacyD1Database).prepare(
      "UPDATE shop_data_exports SET counts_json=? WHERE id=? AND status='active' AND expires_at>?",
    )
      .bind(JSON.stringify(info.counts), job.id, new Date().toISOString())
      .run();
    if (!saved.meta.changes)
      jsonError(410, "导出锁已过期，请联系平台管理员重试", "EXPORT_EXPIRED");
    return info;
  } catch (error) {
    await finishShopExport(c.env.DB as LegacyD1Database, job.id, "failed");
    throw error;
  }
}
async function page(c: C, job: ExportJob, after: number) {
  if (after !== job.cursor)
    jsonError(
      409,
      "导出进度不匹配，请勿重复或跳过分页",
      "EXPORT_CURSOR_CHANGED",
    );
  const now = new Date(),
    expires = new Date(
      Math.min(+now + leaseMs, Date.parse(job.created_at) + maximumMs),
    ).toISOString();
  const renewed = await (c.env.DB as LegacyD1Database).prepare(
    "UPDATE shop_data_exports SET expires_at=?,reading=1 WHERE id=? AND status='active' AND expires_at>? AND cursor=? AND reading=0",
  )
    .bind(expires, job.id, now.toISOString(), after)
    .run();
  if (job.expires_at <= now.toISOString() || expires <= now.toISOString())
    jsonError(410, "导出锁已过期，请联系平台管理员重试", "EXPORT_EXPIRED");
  if (!renewed.meta.changes)
    jsonError(
      409,
      "导出进度不匹配，请勿重复或跳过分页",
      "EXPORT_CURSOR_CHANGED",
    );
  try {
    return await readPage(c, job, after);
  } catch (error) {
    // A failed page must not leave reading=1 and fence the shop until the lease expires.
    await finishShopExport(c.env.DB as LegacyD1Database, job.id, "failed");
    throw error;
  }
}
async function readPage(c: C, job: ExportJob, after: number) {
  const tables = currentTablesFor(job.scope),
    rows: { seq: number; table_name: FullTable; payload_json: string }[] = [];
  const counts = JSON.parse(job.counts_json) as Record<string, number>;
  let rowCursor = job.row_cursor,
    nextPageRows = job.page_rows,
    bytes = 0,
    reads = 0;
  for (let i = Math.floor(after / stride); i < tables.length; i++) {
    const table = tables[i]!,
      offset = i === Math.floor(after / stride) ? after % stride : 0;
    if (offset >= (counts[table] ?? 0)) continue;
    const keys =
      table === "account_links"
        ? ["source_user_id"]
        : (schemas[table].keys[0] ?? []);
    const previous =
      i === Math.floor(after / stride)
        ? (JSON.parse(job.row_cursor) as (string | number)[])
        : [];
    const order = keys.length ? keys.join(",") : "shop_id";
    const keyColumns = keys.length
      ? keys.map((key, n) => `${key} AS k${n}`).join(",")
      : "0 AS k0";
    const windowOrder = keys.length
      ? keys.map((_, n) => `k${n}`).join(",")
      : "k0";
    const keyFilter = previous.length
      ? ` AND (${keys.join(",")})>(${keys.map(() => "?").join(",")})`
      : "";
    const remainingBytes = Math.max(1, exportPageBytes - bytes);
    const limit = Math.max(
      1,
      Math.min(
        exportPageRows - rows.length,
        table === "account_links" ? accountPageRows : exportPageRows,
        i === Math.floor(after / stride) ? job.page_rows : initialPageRows,
      ),
    );
    // Bound by raw column bytes before JSON serialization: a small-row page followed by huge invoices
    // must not serialize thousands of invoices merely to discard almost all of them.
    const rawBytes = sourceColumns(table)
      .map((column) => `COALESCE(length(CAST(${column} AS BLOB)),4)`)
      .join("+");
    const candidates =
      table === "account_links"
        ? `SELECT json_array(source_user_id) AS row_key,source_user_id AS k0,${objectSql(table)} AS payload_json FROM links ORDER BY source_user_id`
        : `SELECT json_array(${keys.join(",")}) AS row_key,${keyColumns},(${rawBytes}) AS raw_bytes
          FROM ${table} WHERE shop_id=?${keyFilter} ORDER BY ${order} LIMIT ?`;
    const boundedPayloads =
      table === "account_links"
        ? ""
        : `,
      raw_sized AS (SELECT *,ROW_NUMBER() OVER(ORDER BY ${windowOrder}) AS item_index,
        SUM(raw_bytes) OVER(ORDER BY ${windowOrder}) AS bytes FROM candidates),
      bounded AS MATERIALIZED (SELECT * FROM raw_sized WHERE bytes<=? OR item_index=1),
      payloads AS MATERIALIZED (SELECT b.row_key,${keys.length ? keys.map((_, n) => `b.k${n}`).join(",") : "b.k0"},${objectSql(table, "s.")} AS payload_json
        FROM bounded b CROSS JOIN ${table} s WHERE s.shop_id=?${keys.map((key, n) => ` AND s.${key}=b.k${n}`).join("")})`;
    const sql =
      (table === "account_links" ? accountSql + "," : "WITH ") +
      `candidates AS MATERIALIZED (${candidates})${boundedPayloads},
      sized AS (SELECT *,ROW_NUMBER() OVER(ORDER BY ${windowOrder}) AS item_index,
        SUM(length(CAST(payload_json AS BLOB))) OVER(ORDER BY ${windowOrder}) AS bytes FROM ${table === "account_links" ? "candidates" : "payloads"})
      SELECT row_key,payload_json FROM sized WHERE bytes<=? OR item_index=1 ORDER BY item_index`;
    const query =
      table === "account_links"
        ? (c.env.DB as LegacyD1Database).prepare(sql).bind(
            ...accountSources.flatMap(() => [
              job.shop_id,
              previous[0] ?? "",
              limit,
            ]),
            limit,
            ...Array(6).fill(job.shop_id),
            remainingBytes,
          )
        : (c.env.DB as LegacyD1Database).prepare(sql).bind(
            job.shop_id,
            ...previous,
            limit,
            remainingBytes,
            job.shop_id,
            remainingBytes,
          );
    // Lock validity and each source read share a transaction; the final CAS also rejects in-flight cancellation.
    const [check, data] = await (c.env.DB as LegacyD1Database).batch<Record<string, string | number>>(
      [
        (c.env.DB as LegacyD1Database).prepare(validJobSql).bind(
          job.id,
          new Date().toISOString(),
          after,
        ),
        query,
      ],
    );
    if (!check!.results.length)
      jsonError(410, "导出锁已过期，请联系平台管理员重试", "EXPORT_EXPIRED");
    reads++;
    let tableRows = 0,
      tableBytes = 0;
    for (const raw of data!.results) {
      let payload = String(raw.payload_json);
      // Secrets travel in the clear inside the file and are re-encrypted with
      // the destination's key on import.
      if (table === "device_capabilities") {
        const value = JSON.parse(payload) as Record<string, unknown>;
        const secrets = JSON.parse(String(value.secret_json)) as Record<string, unknown>;
        for (const [name, sealed] of Object.entries(secrets))
          if (typeof sealed === "string" && sealed)
            secrets[name] = await decryptSecret(sealed, c.env.URL_ENCRYPTION_KEY!);
        value.secret_json = JSON.stringify(secrets);
        payload = JSON.stringify(value);
      }
      if (table === "app_settings") {
        const value = JSON.parse(payload) as Record<string, unknown>;
        if (String(value.key).startsWith(HA_CONNECTION_PREFIX)) {
          const connection = JSON.parse(String(value.value_json)) as Record<string, unknown>;
          for (const name of HA_CONNECTION_SECRETS)
            if (typeof connection[name] === "string" && connection[name])
              connection[name] = await decryptSecret(String(connection[name]), c.env.URL_ENCRYPTION_KEY!);
          value.value_json = JSON.stringify(connection);
          payload = JSON.stringify(value);
        }
      }
      const size = rowEncoder.encode(payload).length;
      if (rows.length && bytes + size > exportPageBytes) break;
      tableRows++;
      rows.push({
        seq: i * stride + offset + tableRows,
        table_name: table,
        payload_json: payload,
      });
      rowCursor = String(raw.row_key);
      bytes += size;
      tableBytes += size;
    }
    if (tableRows)
      nextPageRows = Math.max(
        1,
        Math.min(
          exportPageRows,
          Math.floor((exportPageBytes * tableRows) / Math.max(1, tableBytes)),
        ),
      );
    if (
      offset + tableRows < counts[table]! ||
      bytes >= exportPageBytes ||
      rows.length >= exportPageRows ||
      reads >= pageTables
    )
      break;
  }
  const cursor = rows.at(-1)?.seq ?? after,
    done = rows.length === 0;
  const saved = await (c.env.DB as LegacyD1Database).prepare(
    `UPDATE shop_data_exports SET cursor=?,row_cursor=?,page_rows=?,status=?,reading=0
    WHERE id=? AND status='active' AND cursor=? AND expires_at>?`,
  )
    .bind(
      cursor,
      rowCursor,
      nextPageRows,
      done ? "completed" : "active",
      job.id,
      after,
      new Date().toISOString(),
    )
    .run();
  if (!saved.meta.changes)
    jsonError(
      409,
      "导出进度或店铺锁已变化，请联系平台管理员重试",
      "EXPORT_CURSOR_CHANGED",
    );
  return { rows, cursor, done, rowCursor, pageRows: nextPageRows };
}
async function allowance(c: C, shopId: string, zone: string) {
  const month = exportMonth(zone);
  const now = new Date().toISOString();
  const row = await (c.env.DB as LegacyD1Database).prepare(
    `SELECT
    1+COALESCE((SELECT extra FROM shop_data_export_allowances WHERE shop_id=? AND month=?),0) AS allowance,
    (SELECT COUNT(*) FROM shop_data_exports WHERE shop_id=? AND month=?) AS used,
    EXISTS(SELECT 1 FROM shop_data_exports WHERE shop_id=? AND status='active' AND expires_at>?) AS locked,
    (SELECT json_object('jobId',id,'scope',scope,'expiresAt',expires_at) FROM shop_data_exports
      WHERE shop_id=? AND status='active' AND expires_at>? ORDER BY created_at DESC LIMIT 1) AS active_export,
    1+COALESCE((SELECT import_extra FROM shop_data_export_allowances WHERE shop_id=? AND month=?),0) AS import_allowance,
    (SELECT COUNT(*) FROM shop_data_import_attempts WHERE shop_id=? AND month=?) AS import_used`,
  )
    .bind(
      shopId,
      month,
      shopId,
      month,
      shopId,
      now,
      shopId,
      now,
      shopId,
      month,
      shopId,
      month,
    )
    .first<{
      allowance: number;
      used: number;
      locked: number;
      active_export: string | null;
      import_allowance: number;
      import_used: number;
    }>();
  return {
    month,
    timeZone: zone,
    allowance: row!.allowance,
    used: row!.used,
    remaining: Math.max(0, row!.allowance - row!.used),
    locked: !!row!.locked,
    activeExport: row!.active_export ? JSON.parse(row!.active_export) : null,
    importAllowance: row!.import_allowance,
    importUsed: row!.import_used,
    importRemaining: Math.max(0, row!.import_allowance - row!.import_used),
  };
}
export function registerShopExportRoutes(app: Hono<AppBindings>) {
  app.get(base + "/export-status", async (c) => {
    const shop = await owner(c, false);
    return c.json(await allowance(c, shop.id, shop.time_zone));
  });
  app.post(base + "/exports", async (c) => {
    const shop = await owner(c);
    const parsed = z
      .object({
        scope: z.enum(["business", "configuration"]).default("business"),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!parsed.success)
      jsonError(400, "备份格式或版本不受支持", "INVALID_BACKUP");
    return c.json(await createExport(c, shop, parsed.data.scope));
  });
  app.get(base + "/exports/:jobId/page", async (c) => {
    const { job } = await getExport(c),
      parsed = z.coerce
        .number()
        .int()
        .nonnegative()
        .safeParse(c.req.query("after") ?? 0);
    if (!parsed.success) jsonError(400, "导出进度无效", "INVALID_REQUEST");
    return c.json(await page(c, job, parsed.data));
  });
  async function cancelExport(c: C) {
    // Any current shop owner can recover an interrupted export; page contents stay private to its creator.
    const { job } = await getExport(c, true);
    await finishShopExport(c.env.DB as LegacyD1Database, job.id, "cancelled");
    return c.json({ deleted: true });
  }
  app.delete(base + "/exports/:jobId", cancelExport);
  app.post(base + "/exports/:jobId/cancel", cancelExport);
  app.get(base + "/export", async (c, next) => {
    if (c.req.query("version") === "1") return next();
    const shop = await owner(c),
      parsed = z
        .enum(["business", "configuration"])
        .safeParse(c.req.query("scope") ?? "business");
    if (!parsed.success)
      jsonError(400, "备份格式或版本不受支持", "INVALID_BACKUP");
    const info = await createExport(c, shop, parsed.data);
    let current = (await (c.env.DB as LegacyD1Database).prepare(
      "SELECT * FROM shop_data_exports WHERE id=?",
    )
      .bind(info.jobId)
      .first<ExportJob>())!;
    async function* pieces() {
      yield info.headerJson.slice(0, -1) + ',"tables":{';
      let index = 0,
        open = false,
        hasRows = false,
        count = 0;
      for (;;) {
        const result = await page(c, current, current.cursor);
        if (result.done) break;
        current = {
          ...current,
          cursor: result.cursor,
          row_cursor: result.rowCursor,
          page_rows: result.pageRows,
        };
        for (const row of result.rows) {
          while (info.tables[index] !== row.table_name) {
            yield (open ? "]" : `${JSON.stringify(info.tables[index])}:[]`) +
              ",";
            index++;
            open = false;
            hasRows = false;
          }
          if (!open) {
            yield `${JSON.stringify(row.table_name)}:[`;
            open = true;
          }
          yield (hasRows ? "," : "") + row.payload_json;
          hasRows = true;
          count++;
        }
      }
      if (count !== Object.values(info.counts).reduce((a, b) => a + b, 0))
        throw new Error("EXPORT_COUNT_CHANGED");
      if (open) {
        yield "]";
        index++;
      }
      while (index < info.tables.length) {
        yield (index ? "," : "") + `${JSON.stringify(info.tables[index++])}:[]`;
      }
      yield "}}";
    }
    const iterator = pieces(),
      encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await iterator.next();
            if (result.done) controller.close();
            else controller.enqueue(encoder.encode(result.value));
          } catch (error) {
            await finishShopExport(c.env.DB as LegacyD1Database, current.id, "failed");
            controller.error(error);
          }
        },
        async cancel() {
          await iterator.return(undefined);
          await finishShopExport(c.env.DB as LegacyD1Database, current.id, "cancelled");
        },
      }),
      {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${info.filename}"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      },
    );
  });
}

export function registerShopTransferAllowanceRoutes(app: Hono<AppBindings>) {
  const adminPath = "/shops/:shopCode/transfer-allowance";
  async function adminShop(c: C) {
    requireAdmin(c);
    const shop = await (c.env.DB as LegacyD1Database).prepare(
      `SELECT s.id,COALESCE((SELECT json_extract(value_json,'$.timeZone')
      FROM app_settings WHERE shop_id=s.id AND key='store.profile'),'Asia/Shanghai') AS time_zone FROM shops s WHERE public_id=?`,
    )
      .bind(c.req.param("shopCode"))
      .first<{ id: string; time_zone: string }>();
    if (!shop) jsonError(404, "没有找到这个店铺", "SHOP_NOT_FOUND");
    return shop;
  }
  app.get(adminPath, async (c) => {
    const shop = await adminShop(c);
    return c.json(await allowance(c, shop.id, shop.time_zone));
  });
  app.put(adminPath, async (c) => {
    const shop = await adminShop(c),
      parsed = z
        .object({
          extra: z.number().int().min(0).max(100),
          importExtra: z.number().int().min(0).max(100),
        })
        .strict()
        .safeParse(await c.req.json());
    if (!parsed.success)
      jsonError(400, "额外次数必须是 0 到 100 的整数", "INVALID_REQUEST");
    await (c.env.DB as LegacyD1Database).prepare(
      `INSERT INTO shop_data_export_allowances(shop_id,month,extra,import_extra,updated_by,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(shop_id,month) DO UPDATE SET extra=excluded.extra,import_extra=excluded.import_extra,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
    )
      .bind(
        shop.id,
        exportMonth(shop.time_zone),
        parsed.data.extra,
        parsed.data.importExtra,
        requireAdmin(c).id,
        new Date().toISOString(),
      )
      .run();
    return c.json(await allowance(c, shop.id, shop.time_zone));
  });
}
