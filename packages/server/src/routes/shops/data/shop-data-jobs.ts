import { HA_CONNECTION_PREFIX, HA_CONNECTION_SECRETS } from "../../../resources/capabilities/ha-connections.js";
import type { LegacyD1Database as D1Database, LegacyD1PreparedStatement as D1PreparedStatement } from "./compat.js";
import type { LegacyD1Database } from "./compat.js";
import { registerShopExportRoutes, sourceColumns, importAttemptStatement, shopExportError } from "./shop-data-export.js";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { validatePricingConfig, resolveLocationTimeZone } from "@prism/core";
import { toPricingConfig, type PricingConfigRow } from "@prism/storage-sql";
import { createD1Repositories } from "@prism/adapter-d1";
import { withOperationLease } from "@prism/application";
import { requireUser } from "../../../middleware/auth.js";
import { type BillingShop } from "./compat.js";
import { freeShopStatements } from "../../../resources/billed-sql.js";
import { ensureDefaultGroupStatement } from "../../../resources/repository.js";
import { DEFAULT_RESOURCE_GROUP_ID } from "../../../resources/billing.js";
import { missingFrontDeskStatements } from "../../platform/shops.js";
import { notifyBotsChangedAfter } from "../../../durable-objects/shop-hub-client.js";
import { encryptSecret, sha256 } from "../../../crypto.js";
import { jsonError } from "../../../http.js";
import { owner, targetState, snapshotSql, snapshotBindings, snapshotKey } from "./shop-data.js";
import {
  fullHeaderSchema,
  fullTables,
  schemasFor,
  uploadBytes,
  validateRows,
  type FullHeader,
  type FullTable,
} from "./shop-data-v2-format.js";
import type { DataRow } from "./shop-data-format.js";
import { restoreTriggerNames, replaceBusinessStatements, configurationConflict } from "./shop-data-replace.js";
import type { AppBindings } from "./compat.js";

type C = Context<AppBindings, any, any>;
type Job = {
  id: string;
  kind: string;
  status: string;
  header_json: string;
  target_state: string | null;
  fingerprint: string | null;
  result_json: string | null;
  operation_id: string | null;
};
const base = "";
const primitive = z.union([z.string(), z.number().finite(), z.null()]);
const q = (key: string) => `json_extract(value,'$.${key}')`;
const expiry = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
async function body(c: C): Promise<unknown> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) jsonError(400, "传输失败，请重试", "INVALID_BACKUP");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.length;
    if (bytes > uploadBytes + 8192) {
      await reader.cancel();
      jsonError(413, "单次传输分片过大，请缩小分片后重试", "TRANSFER_PART_TOO_LARGE");
    }
    chunks.push(next.value);
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(all));
  } catch {
    // A mangled request body is a transport failure, not a file problem; the
    // client replays the same part id for free.
    jsonError(400, "传输失败，请重试", "INVALID_BACKUP");
  }
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) jsonError(400, "备份格式或版本不受支持", "INVALID_BACKUP", r.error.flatten());
  return r.data;
}
async function getJob(c: C, kind?: string) {
  const shop = await owner(c, false),
    user = requireUser(c);
  const job = await (c.env.DB as LegacyD1Database).prepare(
    "SELECT * FROM shop_data_jobs WHERE id=? AND shop_id=? AND user_id=? AND expires_at>?",
  )
    .bind(c.req.param("jobId"), shop.id, user.id, new Date().toISOString())
    .first<Job>();
  if (!job || (kind && job.kind !== kind)) jsonError(404, "备份任务不存在或已过期", "TRANSFER_NOT_FOUND");
  return { shop, job, header: parse(fullHeaderSchema, JSON.parse(job.header_json)) };
}
const counts = async (db: D1Database, id: string, tables: readonly FullTable[]) => {
  const rows = (
    await db
      .prepare("SELECT table_name,COUNT(*) AS n FROM shop_data_rows WHERE job_id=? GROUP BY table_name")
      .bind(id)
      .all<{ table_name: string; n: number }>()
  ).results;
  return Object.fromEntries(tables.map((table) => [table, rows.find((r) => r.table_name === table)?.n ?? 0]));
};
async function cleanup(db: D1Database) {
  await db.prepare("DELETE FROM shop_data_jobs WHERE expires_at<?").bind(new Date().toISOString()).run();
}

async function stage(
  c: C,
  job: Job,
  header: FullHeader,
  input: { table: string; part: number; rows: DataRow[] },
) {
  const table = input.table as FullTable;
  if (!fullTables(header).includes(table)) jsonError(400, "备份包含不支持的数据表", "INVALID_BACKUP");
  const hash = await sha256(JSON.stringify(input)),
    previous = await (c.env.DB as LegacyD1Database).prepare("SELECT request_hash FROM shop_data_parts WHERE job_id=? AND part=?")
      .bind(job.id, input.part)
      .first<{ request_hash: string }>();
  if (previous) {
    if (previous.request_hash !== hash) jsonError(409, "分片编号对应的数据已变化", "OPERATION_CONFLICT");
    return;
  }
  if (job.status !== "uploading") jsonError(409, "文件已上传完成，不能继续修改", "TRANSFER_LOCKED");
  const errors = validateRows(table, input.rows, header.version);
  if (
    header.version === 1 &&
    table === "player_identities" &&
    input.rows.some((row) => row.provider === "web-account")
  )
    errors.push("旧版本备份不支持网页登录账号身份");
  if (table === "pricing_configs" || table === "pricing_config_versions")
    for (const row of input.rows) {
      try {
        validatePricingConfig(
          toPricingConfig({ ...row, id: row.id ?? row.config_id } as unknown as PricingConfigRow),
        );
        if (
          table === "pricing_configs" &&
          row.kind !== "charge.fixed" &&
          JSON.parse(String(row.provider_json)).timeZone !== "UTC"
        )
          errors.push("计费方案必须使用 UTC");
      } catch {
        errors.push("计费方案内容无效");
      }
    }
  if (table === "pricing_releases" && input.rows.some((row) => row.time_zone !== "UTC"))
    errors.push("计费发布版本必须使用 UTC");
  if (errors.length) jsonError(400, "分片数据校验失败", "INVALID_BACKUP", { errors });
  // Store portable connections under the destination key before writing any real device record.
  const seal = (value: unknown) => {
    if (!c.env.URL_ENCRYPTION_KEY) jsonError(503, "设备密钥未配置", "DEVICE_ENCRYPTION_UNAVAILABLE");
    return encryptSecret(String(value), c.env.URL_ENCRYPTION_KEY);
  };
  if (table === "machines" && header.version === 2)
    for (const row of input.rows)
      for (const key of ["hinata_url", "hinata_password", "ha_binding_json"])
        if (row[key]) row[key] = await seal(row[key]);
  if (table === "device_capabilities")
    for (const row of input.rows) {
      const secrets = JSON.parse(String(row.secret_json)) as Record<string, unknown>;
      for (const [name, value] of Object.entries(secrets))
        if (typeof value === "string" && value) secrets[name] = await seal(value);
        else delete secrets[name];
      row.secret_json = JSON.stringify(secrets);
    }
  if (table === "app_settings")
    for (const row of input.rows) {
      if (!String(row.key).startsWith(HA_CONNECTION_PREFIX)) continue;
      const connection = JSON.parse(String(row.value_json)) as Record<string, unknown>;
      for (const name of HA_CONNECTION_SECRETS)
        if (typeof connection[name] === "string" && connection[name]) connection[name] = await seal(connection[name]);
      row.value_json = JSON.stringify(connection);
    }
  const json = JSON.stringify(input.rows),
    schema = schemasFor(header.version)[table],
    seq = input.part * 100000;
  const statements = [
    (c.env.DB as LegacyD1Database).prepare(
      `INSERT INTO shop_data_parts(job_id,part,request_hash)
    SELECT CASE WHEN status='uploading' THEN id ELSE NULL END,?,? FROM shop_data_jobs WHERE id=?`,
    ).bind(input.part, hash, job.id),
    (c.env.DB as LegacyD1Database).prepare(
      `INSERT INTO shop_data_rows(job_id,seq,table_name,payload_json)
      SELECT ?,?+CAST(key AS INTEGER)+1,?,value FROM json_each(?)`,
    ).bind(job.id, seq, table, json),
  ];
  schema.keys.forEach((key, index) =>
    statements.push(
      (c.env.DB as LegacyD1Database).prepare(
        `INSERT INTO shop_data_keys(job_id,table_name,key_kind,key_json)
    SELECT ?,?,?,json_array(${key.map(q).join(",")}) FROM json_each(?) ${key.length ? `WHERE ${key.map((k) => `${q(k)} IS NOT NULL`).join(" AND ")}` : ""}`,
      ).bind(job.id, table, index, json),
    ),
  );
  try {
    await (c.env.DB as LegacyD1Database).batch(statements);
  } catch (error) {
    if (String(error).includes("constraint failed"))
      jsonError(409, "备份中存在重复标识或分片状态发生变化", "INVALID_BACKUP");
    throw error;
  }
}

async function previewJob(
  c: C,
  shop: BillingShop,
  job: Job,
  header: FullHeader,
  manifest: { counts: Record<string, number>; parts: number },
) {
  if (!["uploading", "ready", "stale"].includes(job.status)) jsonError(409, "任务状态不允许重新检查文件", "TRANSFER_LOCKED");
  const errors: string[] = [],
    tables = fullTables(header),
    actual = await counts(c.env.DB as LegacyD1Database, job.id, tables);
  // v2 backups created before report archiving have no metadata table.
  // Only an absent, empty new table is compatible; never ignore uploaded rows.
  if (header.version === 2 && header.scope === "business" &&
      !Object.hasOwn(manifest.counts, "checkout_report_states") && actual.checkout_report_states === 0) {
    manifest = { ...manifest, counts: { ...manifest.counts, checkout_report_states: 0 } };
  }
  if (
    Object.keys(manifest.counts).sort().join(",") !== [...tables].sort().join(",") ||
    tables.some((t) => manifest.counts[t] !== actual[t])
  )
    errors.push("备份文件未完整上传或数据表不完整");
  const partState = await (c.env.DB as LegacyD1Database).prepare(
    "SELECT COUNT(*) AS n,MAX(part) AS last FROM shop_data_parts WHERE job_id=?",
  )
    .bind(job.id)
    .first<{ n: number; last: number | null }>();
  if (partState?.n !== manifest.parts || (manifest.parts && partState.last !== manifest.parts - 1))
    errors.push("备份分片不完整");
  if (header.version === 2 && actual.shop_billing_settings! > 1) errors.push("计费设置记录重复");
  // Indexed staged keys validate relationships without loading the backup into Worker memory.
  const checks: string[] = [],
    messages: string[] = [];
  const schemas = schemasFor(header.version);
  for (const table of tables)
    for (const fk of schemas[table].foreignKeys) {
      if (!tables.includes(fk.table as FullTable)) {
        errors.push(`${table} 缺少关联表 ${fk.table}`);
        continue;
      }
      const target = schemas[fk.table as FullTable],
        kind = target.keys.findIndex((key) => key.join(",") === fk.referenced.join(","));
      if (kind < 0) throw new Error("Backup reference has no unique key");
      if (!actual[table]) continue;
      checks.push(`SELECT ${messages.length} AS check_index WHERE EXISTS(SELECT 1 FROM shop_data_rows r
        WHERE r.job_id=(SELECT id FROM job) AND r.table_name='${table}'
        AND ${fk.columns.map((k) => `json_extract(r.payload_json,'$.${k}') IS NOT NULL`).join(" AND ")}
        AND NOT EXISTS(SELECT 1 FROM shop_data_keys k WHERE k.job_id=r.job_id AND k.table_name='${fk.table}' AND k.key_kind=${kind}
          AND k.key_json=json_array(${fk.columns.map((k) => `json_extract(r.payload_json,'$.${k}')`).join(",")})))`);
      messages.push(`${table} 存在失效的 ${fk.table} 关联`);
    }
  if (checks.length) {
    const statements: D1PreparedStatement[] = [];
    for (let offset = 0; offset < checks.length; offset += 5)
      statements.push(
        (c.env.DB as LegacyD1Database).prepare(
          `WITH job(id) AS(SELECT ?) ${checks.slice(offset, offset + 5).join(" UNION ALL ")}`,
        ).bind(job.id),
      );
    const results = await (c.env.DB as LegacyD1Database).batch<{ check_index: number }>(statements);
    for (const result of results) for (const row of result.results) errors.push(messages[row.check_index]!);
  }
  // Check all release version IDs and unpaid session bindings in SQL as well.
  if (header.scope === "business") {
    const result = await (c.env.DB as LegacyD1Database).batch([
      (c.env.DB as LegacyD1Database).prepare(
        `SELECT 1 FROM shop_data_rows r JOIN json_each(json_extract(r.payload_json,'$.version_ids_json')) v
        WHERE r.job_id=? AND r.table_name='pricing_releases' AND NOT EXISTS(
        SELECT 1 FROM shop_data_keys k WHERE k.job_id=r.job_id AND k.table_name='pricing_config_versions' AND k.key_kind=0 AND k.key_json=json_array(v.value)) LIMIT 1`,
      ).bind(job.id),
      (c.env.DB as LegacyD1Database).prepare(
        `SELECT 1 FROM shop_data_rows r WHERE r.job_id=? AND r.table_name='sessions' AND json_extract(r.payload_json,'$.payment_status')='unpaid'
        AND NOT EXISTS(SELECT 1 FROM shop_data_keys k WHERE k.job_id=r.job_id AND k.table_name='session_pricing_releases' AND k.key_kind=0
        AND k.key_json=json_array(json_extract(r.payload_json,'$.id'))) LIMIT 1`,
      ).bind(job.id),
    ]);
    if (result[0]!.results.length) errors.push("计费发布版本引用了不存在的规则版本");
    if (result[1]!.results.length) errors.push("未结会话缺少计费版本绑定");
  }
  const configRows = (
    await (c.env.DB as LegacyD1Database).prepare(
      `SELECT json_extract(payload_json,'$.id') AS id,json_extract(payload_json,'$.kind') AS kind,
    json_extract(payload_json,'$.enabled') AS enabled,json_extract(payload_json,'$.status') AS status
    FROM shop_data_rows WHERE job_id=? AND table_name='pricing_configs'
    AND json_extract(payload_json,'$.id') IN (SELECT value FROM json_each(?))`,
    )
      .bind(job.id, JSON.stringify(header.settings.entryPricingIds ?? []))
      .all<DataRow>()
  ).results;
  const configs = new Map(configRows.map((r) => [r.id, r] as const));
  const settings = header.settings;
  // Older files name the default group's plan here; newer ones store the group.
  const entryPricingIds = settings.entryPricingIds ?? [];
  if (entryPricingIds.some((id) => !configs.has(id))) errors.push("入场规则引用了不存在的计费方案");
  // A retired non-billing file drops the plan on import, so it is not checked.
  if (settings.billingEnabled !== false && entryPricingIds.length) {
    const assets = (
      await (c.env.DB as LegacyD1Database).prepare(
        `SELECT json_extract(payload_json,'$.type') AS type,json_extract(payload_json,'$.code') AS code,json_extract(payload_json,'$.status') AS status
      FROM shop_data_rows WHERE job_id=? AND table_name='asset_definitions' AND json_extract(payload_json,'$.code') IN ('paid','free')`,
      )
        .bind(job.id)
        .all<DataRow>()
    ).results;
    if (
      ["paid", "free"].some(
        (code) => !assets.some((a) => a.type === "currency" && a.code === code && a.status === "active"),
      )
    )
      errors.push("默认计费方案需要有效余额资产");
    if (
      entryPricingIds.some((id) => {
        const row = configs.get(id);
        return !row || row.enabled !== 1 || row.status !== "active" || row.kind === "time.cap";
      })
    )
      errors.push("默认计费方案不可用");
  }
  if (
    settings.defaultPresentId &&
    !(await (c.env.DB as LegacyD1Database).prepare(
      "SELECT 1 FROM shop_data_keys WHERE job_id=? AND table_name='presents' AND key_kind=0 AND key_json=json_array(?)",
    )
      .bind(job.id, settings.defaultPresentId)
      .first())
  )
    errors.push("新玩家礼物不存在");
  if (header.scope === "business") {
    if (actual.pricing_configs && actual.pricing_release_heads !== 1)
      errors.push("缺少唯一的当前计费发布版本");
    if (
      await (c.env.DB as LegacyD1Database).prepare(
        `SELECT 1 FROM shop_data_rows c JOIN shop_data_rows r ON r.job_id=c.job_id
      AND r.table_name='asset_holdings' AND json_extract(r.payload_json,'$.player_id')=json_extract(c.payload_json,'$.player_id')
      WHERE c.job_id=? AND c.table_name='cashier_profiles' LIMIT 1`,
      )
        .bind(job.id)
        .first()
    )
      errors.push("前台玩家不可拥有余额资产");
  }
  if (header.version === 2) {
    const billing = await (c.env.DB as LegacyD1Database).prepare(
      "SELECT payload_json FROM shop_data_rows WHERE job_id=? AND table_name='shop_billing_settings'",
    )
      .bind(job.id)
      .first<{ payload_json: string }>();
    const raw = billing ? (JSON.parse(billing.payload_json) as DataRow) : {};
    const settingRows = (
      await (c.env.DB as LegacyD1Database).prepare(
        `SELECT json_extract(payload_json,'$.key') AS key,
      json_extract(json_extract(payload_json,'$.value_json'),'$.enabled') AS enabled,
      json_extract(json_extract(payload_json,'$.value_json'),'$.coinCooldownMs') AS cooldown,
      json_extract(json_extract(payload_json,'$.value_json'),'$.defaultPresentId') AS present
      FROM shop_data_rows WHERE job_id=? AND table_name='app_settings'
      AND json_extract(payload_json,'$.key') IN ('cashier.settings','venue.operations','player.registration')`,
      )
        .bind(job.id)
        .all<DataRow>()
    ).results;
    // The retired billing switch is not compared, and the default group's plan
    // only when the file names it: either may be missing.
    const expected = {
      autoRegister: !!raw.auto_register,
      identityBindingRequired:
        raw.identity_binding_required === undefined ? true : !!raw.identity_binding_required,
      checkinGeo: !!raw.checkin_geo,
      checkoutGeo: !!raw.checkout_geo,
      machineGeo: !!raw.machine_geo,
      ...(settings.entryPricingIds === undefined
        ? {}
        : { entryPricingIds: JSON.parse(String(raw.entry_pricing_ids_json ?? "[]")) as string[] }),
      botContact: raw.bot_contact ?? "",
      cashierEnabled: !!settingRows.find((r) => r.key === "cashier.settings")?.enabled,
      coinCooldownMs: settingRows.find((r) => r.key === "venue.operations")?.cooldown ?? 60000,
      defaultPresentId: settingRows.find((r) => r.key === "player.registration")?.present ?? null,
    };
    if (
      Object.entries(expected).some(
        ([key, value]) => JSON.stringify(value) !== JSON.stringify(settings[key as keyof typeof settings]),
      )
    )
      errors.push("计费设置与文件摘要不一致");
    if (tables.includes("account_links")) {
      if (
        await (c.env.DB as LegacyD1Database).prepare(
          `SELECT 1 FROM shop_data_rows i WHERE i.job_id=? AND i.table_name='player_identities'
        AND json_extract(i.payload_json,'$.provider')='web-account' AND NOT EXISTS(SELECT 1 FROM shop_data_rows a WHERE a.job_id=i.job_id AND a.table_name='account_links'
        AND json_extract(a.payload_json,'$.source_user_id')=json_extract(i.payload_json,'$.subject') AND json_extract(a.payload_json,'$.player_id')=json_extract(i.payload_json,'$.player_id')) LIMIT 1`,
        )
          .bind(job.id)
          .first()
      )
        errors.push("网页登录身份缺少对应的账号关联");
      if (
        await (c.env.DB as LegacyD1Database).prepare(
          `SELECT 1 FROM shop_data_rows r JOIN json_each(json_extract(r.payload_json,'$.identities_json')) i
        WHERE r.job_id=? AND r.table_name='account_links'
        GROUP BY json_extract(i.value,'$.provider'),json_extract(i.value,'$.subject') HAVING COUNT(*)>1 LIMIT 1`,
        )
          .bind(job.id)
          .first()
      )
        errors.push("多个账号关联使用了同一登录身份");
      if (
        await (c.env.DB as LegacyD1Database).prepare(
          `SELECT 1 FROM shop_data_rows r JOIN json_each(json_extract(r.payload_json,'$.platform_bindings_json')) b
        WHERE r.job_id=? AND r.table_name='account_links' AND NOT EXISTS(SELECT 1 FROM shop_data_rows i WHERE i.job_id=r.job_id AND i.table_name='player_identities'
          AND json_extract(i.payload_json,'$.player_id')=json_extract(r.payload_json,'$.player_id') AND json_extract(i.payload_json,'$.provider')=json_extract(b.value,'$.provider')
          AND json_extract(i.payload_json,'$.subject')=json_extract(b.value,'$.subject')) LIMIT 1`,
        )
          .bind(job.id)
          .first()
      )
        errors.push("平台绑定与玩家身份不一致");
    }
  }
  const installed = await (c.env.DB as LegacyD1Database).prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='shop_import_target_players_update'").first();
  if (!installed) errors.push("请先完成覆盖导入数据库迁移");
  const state = await targetState(c, shop.id);

  const parts = (
    await (c.env.DB as LegacyD1Database).prepare("SELECT part,request_hash FROM shop_data_parts WHERE job_id=? ORDER BY part")
      .bind(job.id)
      .all()
  ).results;
  const fingerprint = await sha256(JSON.stringify({ jobId: job.id, header, parts, state, revision: crypto.randomUUID() }));
  if (!errors.length) {
    const statements = [
      (c.env.DB as LegacyD1Database).prepare(
        `UPDATE shop_data_jobs SET status=CASE WHEN
      (SELECT COUNT(*) FROM shop_data_parts WHERE job_id=shop_data_jobs.id)=? AND
      (SELECT COUNT(*) FROM shop_data_rows WHERE job_id=shop_data_jobs.id)=? THEN 'ready' ELSE NULL END,
      target_state=?,fingerprint=? WHERE id=? AND status IN ('uploading','ready','stale')`,
      ).bind(
        manifest.parts,
        Object.values(actual).reduce((a, b) => a + b, 0),
        snapshotKey(state),
        fingerprint,
        job.id,
      ),
      (c.env.DB as LegacyD1Database).prepare("DELETE FROM shop_data_device_ids WHERE job_id=?").bind(job.id),
      (c.env.DB as LegacyD1Database).prepare(
        `INSERT INTO shop_data_device_ids(job_id,source_id,id,public_id)
        SELECT ?,json_extract(r.payload_json,'$.id'),
        CASE WHEN EXISTS(SELECT 1 FROM machines m WHERE m.shop_id!=? AND (m.id=json_extract(r.payload_json,'$.id') OR m.public_id=json_extract(r.payload_json,'$.public_id')))
          THEN lower(hex(randomblob(16))) ELSE json_extract(r.payload_json,'$.id') END,
        CASE WHEN EXISTS(SELECT 1 FROM machines m WHERE m.shop_id!=? AND (m.id=json_extract(r.payload_json,'$.id') OR m.public_id=json_extract(r.payload_json,'$.public_id')))
          THEN lower(hex(randomblob(16))) ELSE json_extract(r.payload_json,'$.public_id') END
        FROM shop_data_rows r WHERE r.job_id=? AND r.table_name='machines'`,
      ).bind(job.id, shop.id, shop.id, job.id),
    ];
    try {
      await (c.env.DB as LegacyD1Database).batch(statements);
    } catch (error) {
      if (String(error).includes("constraint failed"))
        jsonError(409, "文件检查时上传状态发生变化，请重试", "TRANSFER_CHANGED");
      throw error;
    }
  }
  return {
    canImport: !errors.length,
    errors: errors.slice(0, 30),
    fingerprint,
    scope: header.scope,
    source: header.source,
    counts: actual,
    target: { records: state.rows, mode: header.scope === "business" ? "replace" : "merge" },
    warnings: [
      header.scope === "business"
        ? "业务备份将替换目标店铺现有玩家、余额、账单和计费配置；此操作不能撤销，请先保留原店铺备份。"
        : "仅配置导入会覆盖同编号配置并新增文件中的配置和资源，保留玩家、余额、账单及其他配置。",
      header.version >= 2
        ? header.scope === "business"
          ? "将恢复完整店铺资料、设置、设备连接及业务记录。目标店铺编号和当前管理员保留。"
          : "将恢复店铺资料和设置，并覆盖或新增配置及资源；目标店铺编号和当前管理员保留。"
        : "此为 v1 备份，仅恢复文件已有内容，目标店铺资料保留。",
      "备份包含连接密钥、平台身份、卡片和财务数据，请妥善保管。",
      "账号按同一账号 ID 或已验证登录身份恢复关联；无法匹配的关联保留，需重新绑定。",
    ],
  };
}

/**
 * A v2 file keeps connections as machine columns and history in the retired
 * command/state tables. Turn them into capabilities, operations and events the
 * same way migration 0037 did for live data, after the machines exist.
 */
function v2DeviceStatements(db: D1Database, shopId: string, jobId: string, merge: boolean) {
  const machine = (column: string) => `json_extract(r.payload_json,'$.${column}')`;
  const rows = `FROM shop_data_rows r JOIN shop_data_device_ids d ON d.job_id=r.job_id AND d.source_id=${machine("id")}
    WHERE r.job_id=? AND r.table_name='machines'`;
  const upsert = merge
    ? " ON CONFLICT(shop_id,device_id,capability) DO UPDATE SET config_json=excluded.config_json,secret_json=excluded.secret_json,updated_at=excluded.updated_at"
    : "";
  const capability = (name: string, config: string, secrets: string, where: string) =>
    db.prepare(
      `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
       SELECT ?,d.id,'${name}',${config},${secrets},${machine("created_at")},${machine("updated_at")} ${rows} AND ${where}${upsert}`,
    ).bind(shopId, jobId);
  const mapped = (column: string) =>
    `COALESCE((SELECT id FROM shop_data_device_ids d WHERE d.job_id=r.job_id AND d.source_id=json_extract(r.payload_json,'$.${column}')),json_extract(r.payload_json,'$.${column}'))`;
  const command = (column: string) => `json_extract(r.payload_json,'$.${column}')`;
  const payload = `CASE WHEN json_valid(${command("payload_json")}) THEN ${command("payload_json")} ELSE '{}' END`;
  const type = command("type");
  const capabilities = [
    capability("power", "'{}'", `json_object('binding',${machine("ha_binding_json")})`,
      `COALESCE(${machine("ha_binding_json")},'')!=''`),
    capability("hinata_io",
      `json_object('transport','external','coinKey',${machine("coin_key")},'coinAfterSwipe',json(CASE WHEN ${machine("coin_after_swipe")}=1 THEN 'true' ELSE 'false' END))`,
      `json_patch('{}',json_object('url',${machine("hinata_url")},'password',${machine("hinata_password")}))`,
      `COALESCE(${machine("hinata_url")},'')!=''`),
    capability("door", `json_object('lockId',${machine("ttlock_lock_id")})`, "'{}'", `${machine("ttlock_lock_id")} IS NOT NULL`),
    capability("mahjong", machine("mahjong_config_json"), "'{}'", `json_valid(${machine("mahjong_config_json")})`),
  ];
  const history = [
    // A historic pending stays pending: billing has always counted it as use.
    db.prepare(
      `INSERT INTO device_operations(shop_id,id,device_id,capability,action,parent_id,player_id,staff_id,
        status,counts_as_play,failure,payload_json,requested_at,settled_at)
       SELECT ?,${command("id")},${mapped("device_id")},
        CASE WHEN ${type}='door.open' THEN 'door' WHEN ${type} IN ('power.on','power.off','ac.set_temperature') THEN 'power' ELSE 'hinata_io' END,
        ${type},json_extract(${payload},'$.parentOperationId'),${command("player_id")},${command("staff_id")},
        CASE ${command("status")} WHEN 'acked' THEN 'succeeded' WHEN 'pending' THEN 'pending' ELSE 'failed' END,
        CASE WHEN ${type}='door.open' THEN 0 ELSE 1 END,
        json_extract(${payload},'$.executorFailure.message'),
        json_set(${payload},'$.legacyExecutor',${command("executor_kind")},'$.legacyTargetKind',${command("target_kind")}),
        ${command("requested_at")},COALESCE(${command("acked_at")},${command("expired_at")})
       FROM shop_data_rows r WHERE r.job_id=? AND r.table_name='device_commands'`,
    ).bind(shopId, jobId),
    db.prepare(
      `INSERT INTO device_events(shop_id,id,device_id,capability,kind,name,operation_id,parent_operation_id,origin,player_id,staff_id,payload_json,occurred_at)
       SELECT o.shop_id,o.id||'.request',o.device_id,o.capability,'request',o.action,o.id,o.parent_id,'platform',o.player_id,o.staff_id,o.payload_json,o.requested_at
       FROM device_operations o JOIN shop_data_rows r ON r.job_id=? AND r.table_name='device_commands' AND ${command("id")}=o.id
       WHERE o.shop_id=?`,
    ).bind(jobId, shopId),
    db.prepare(
      `INSERT INTO device_events(shop_id,id,device_id,capability,kind,name,operation_id,parent_operation_id,origin,player_id,staff_id,payload_json,occurred_at)
       SELECT o.shop_id,o.id||'.result',o.device_id,o.capability,'result',o.action,o.id,o.parent_id,'platform',o.player_id,o.staff_id,
         json_object('outcome',CASE WHEN o.status='succeeded' THEN 'ok' ELSE 'failed' END,'message',o.failure),COALESCE(o.settled_at,o.requested_at)
       FROM device_operations o JOIN shop_data_rows r ON r.job_id=? AND r.table_name='device_commands' AND ${command("id")}=o.id
       WHERE o.shop_id=? AND o.status!='pending'`,
    ).bind(jobId, shopId),
    db.prepare(
      `INSERT OR IGNORE INTO device_state(shop_id,device_id,capability,key,value_json,authority,changed_at)
       SELECT ?,c.device_id,'power','power',json_quote(${command("state")}),'observed',${command("reported_at")}
       FROM shop_data_rows r JOIN device_capabilities c ON c.shop_id=? AND c.capability='power' AND c.device_id=${mapped("device_id")}
       WHERE r.job_id=? AND r.table_name='device_states' AND ${command("state")} IN ('on','off')`,
    ).bind(shopId, shopId, jobId),
  ];
  return { capabilities, history };
}

/**
 * A partial import replaced the shop's plans but kept its resource groups and
 * resources, so their plan references may point at plans that are gone: those
 * become free. The file's own plan, if it names one, bills the default group,
 * as the shop it came from billed every visit by it.
 */
function partialPricingStatements(db: D1Database, shopId: string, planId: string | null) {
  const gone = (column: string) =>
    `${column} IS NOT NULL AND ${column} NOT IN (SELECT id FROM pricing_configs WHERE shop_id=?)`;
  return [
    db.prepare(`UPDATE resource_groups SET default_pricing_config_id=NULL WHERE shop_id=? AND ${gone("default_pricing_config_id")}`)
      .bind(shopId, shopId),
    db.prepare(`UPDATE machines SET pricing_config_override_id=NULL WHERE shop_id=? AND ${gone("pricing_config_override_id")}`)
      .bind(shopId, shopId),
    ...(planId
      ? [db.prepare("UPDATE resource_groups SET default_pricing_config_id=?,updated_at=? WHERE shop_id=? AND id=?")
          .bind(planId, new Date().toISOString(), shopId, DEFAULT_RESOURCE_GROUP_ID)]
      : []),
  ];
}

async function applyJob(
  c: C,
  shop: BillingShop,
  job: Job,
  header: FullHeader,
  fingerprint: string,
  operationId: string,
  overwrite: boolean,
) {
  if (job.result_json) {
    if (job.fingerprint !== fingerprint || job.operation_id !== operationId)
      jsonError(409, "请求编号已用于其他操作", "OPERATION_CONFLICT");
    return JSON.parse(job.result_json);
  }
  const previous = await (c.env.DB as LegacyD1Database).prepare(
    "SELECT 1 FROM player_operations WHERE shop_id=? AND user_id=? AND id=?",
  )
    .bind(shop.id, requireUser(c).id, operationId)
    .first();
  if (previous) jsonError(409, "请求编号已用于其他操作", "OPERATION_CONFLICT");
  if (job.status === "stale") jsonError(409, "店铺数据或文件已变化，请重新导入", "IMPORT_TARGET_CHANGED");
  if (job.status !== "ready" || fingerprint !== job.fingerprint)
    jsonError(409, "文件尚未上传完成", "IMPORT_NOT_READY");
  const state = await targetState(c, shop.id);
  if (snapshotKey(state) !== job.target_state)
    jsonError(409, "店铺数据或文件已变化，请重新导入", "IMPORT_TARGET_CHANGED");
  if (header.scope === "business" && state.rows && !overwrite)
    jsonError(409, "请确认覆盖目标店铺现有数据", "IMPORT_OVERWRITE_REQUIRED");
  const db = c.env.DB as LegacyD1Database,
    tables = fullTables(header),
    now = new Date().toISOString();
  const rowsCount = await counts(db, job.id, tables),
    result = { imported: true, scope: header.scope, counts: rowsCount };
  const statements = [
    db
      .prepare(
        `INSERT INTO player_operations(shop_id,user_id,id,kind,status,request_hash,result_json,created_at)
    SELECT ?,?,CASE WHEN json_array(rows,settings,billing)=? AND EXISTS(SELECT 1 FROM shop_data_jobs WHERE id=? AND status='ready' AND fingerprint=?) THEN ? ELSE NULL END,'data/import','completed',?,?,?
    FROM (${snapshotSql})`,
      )
      .bind(
        shop.id,
        requireUser(c).id,
        job.target_state,
        job.id,
        fingerprint,
        operationId,
        fingerprint,
        JSON.stringify(result),
        now,
        ...snapshotBindings(shop.id),
      ),
  ];
  const triggers =
    header.scope === "business"
      ? (
          await db
            .prepare(
              `SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN (${restoreTriggerNames.map(() => "?").join(",")})`,
            )
            .bind(...restoreTriggerNames)
            .all<{ name: string; sql: string }>()
        ).results
      : [];
  if (header.scope === "business" && triggers.length !== restoreTriggerNames.length)
    jsonError(409, "计费数据库结构不完整，无法恢复历史版本", "IMPORT_SCHEMA_MISMATCH");
  statements.push(...triggers.map((t) => db.prepare(`DROP TRIGGER ${t.name}`)));
  // A partial file replaces business data only; a full one restores the whole shop.
  const partial = header.partial === true;
  if (header.scope === "business") statements.push(...replaceBusinessStatements(db, shop.id, requireUser(c).id, header.version >= 2 && !partial));
  // Machines have global IDs. The preflight stores collision mappings in D1, not Worker memory.
  if (rowsCount.machines) {
    const cols = sourceColumns("machines"),
      expressions = cols.map((col) =>
        col === "id"
          ? "d.id"
          : col === "public_id"
            ? "d.public_id"
            // A file written before these existed restores the defaults.
            : col === "capacity" || col === "occupancy_minutes"
              ? `COALESCE(json_extract(r.payload_json,'$.${col}'),${col === "capacity" ? 0 : 15})`
              : `json_extract(r.payload_json,'$.${col}')`,
      );
    statements.push(
      db
        .prepare(
          `INSERT INTO machines(shop_id,${cols.join(",")},hinata_url_encrypted) SELECT ?,${expressions.join(",")},''
      FROM shop_data_rows r JOIN shop_data_device_ids d ON d.job_id=r.job_id AND d.source_id=json_extract(r.payload_json,'$.id')
      WHERE r.job_id=? AND r.table_name='machines'${header.scope === "configuration" ? configurationConflict("machines", cols) : ""}`,
        )
        .bind(shop.id, job.id),
    );
  }
  // Converted v2 history references players, so it is written after every table.
  const v2Devices = header.version === 2 && rowsCount.machines
    ? v2DeviceStatements(db, shop.id, job.id, header.scope === "configuration")
    : null;
  if (v2Devices) statements.push(...v2Devices.capabilities);
  const schemas = schemasFor(header.version);
  for (const table of tables) {
    if (table === "machines" || table === "account_links" || !rowsCount[table]) continue;
    // v2 history tables are converted with the machines above; their devices must exist first.
    if (table === "device_commands" || table === "device_states" || table === "machine_connections") continue;
    const cols = schemas[table].columns.map((c) => c.name),
      expressions = cols.map((col) => `json_extract(payload_json,'$.${col}')`);
    let filter = "";
    if (table === "player_identities") filter = " AND json_extract(payload_json,'$.provider')!='web-account'";
    if (table === "staff_users")
      filter +=
        " AND NOT EXISTS(SELECT 1 FROM staff_users s WHERE s.shop_id=? AND s.id=json_extract(payload_json,'$.id'))";
    if (table === "app_settings")
      filter += " AND json_extract(payload_json,'$.key')!='backup.importedAccounts'";
    const deviceCol =
      table === "mahjong_seats"
        ? "machine_id"
        : table === "device_capabilities" || table === "device_operations" || table === "device_events" || table === "device_state"
          ? "device_id"
          : null;
    if (deviceCol)
      expressions[cols.indexOf(deviceCol)] =
        `COALESCE((SELECT id FROM shop_data_device_ids d WHERE d.job_id=shop_data_rows.job_id
      AND d.source_id=json_extract(payload_json,'$.${deviceCol}')),json_extract(payload_json,'$.${deviceCol}'))`;
    if (table === "sessions")
      expressions[cols.indexOf("metadata_json")] =
        `CASE WHEN EXISTS(SELECT 1 FROM shop_data_device_ids d WHERE d.job_id=shop_data_rows.job_id AND d.source_id=json_extract(json_extract(payload_json,'$.metadata_json'),'$.mahjongDeviceId'))
      THEN json_set(json_extract(payload_json,'$.metadata_json'),'$.mahjongDeviceId',(SELECT id FROM shop_data_device_ids d WHERE d.job_id=shop_data_rows.job_id AND d.source_id=json_extract(json_extract(payload_json,'$.metadata_json'),'$.mahjongDeviceId')))
      ELSE json_extract(payload_json,'$.metadata_json') END`;
    if (table === "device_capabilities") {
      // A relay channel names a Durable Object shared by every shop. Keep it for
      // a restore, but never adopt one another shop's device already uses.
      expressions[cols.indexOf("config_json")] =
        `CASE WHEN json_extract(json_extract(payload_json,'$.config_json'),'$.channel') IS NOT NULL AND EXISTS(SELECT 1 FROM device_capabilities x
          WHERE x.shop_id!=? AND json_extract(x.config_json,'$.channel')=json_extract(json_extract(payload_json,'$.config_json'),'$.channel'))
        THEN json_set(json_extract(payload_json,'$.config_json'),'$.channel','m_'||lower(hex(randomblob(16))))
        ELSE json_extract(payload_json,'$.config_json') END`;
      // Likewise a device token: a copy into another shop must be issued its own.
      expressions[cols.indexOf("credential_hash")] =
        `CASE WHEN EXISTS(SELECT 1 FROM device_capabilities x WHERE x.shop_id!=? AND x.credential_hash=json_extract(payload_json,'$.credential_hash'))
        THEN NULL ELSE json_extract(payload_json,'$.credential_hash') END`;
    }
    // The relay link of a restored device is whatever it is now, not what it was.
    if (table === "device_state")
      expressions[cols.indexOf("value_json")] =
        `CASE WHEN json_extract(payload_json,'$.key')='link' THEN '"offline"' ELSE json_extract(payload_json,'$.value_json') END`;
    let conflict = header.scope === "configuration" ? configurationConflict(table) : "";
    if (table === "app_settings")
      conflict =
        " ON CONFLICT(shop_id,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at";
    if (table === "shop_billing_settings")
      conflict =
        " ON CONFLICT(shop_id) DO UPDATE SET " + cols.map((col) => `${col}=excluded.${col}`).join(",");
    const params: (string | number)[] = table === "device_capabilities" ? [shop.id, shop.id, shop.id, job.id, table] : [shop.id, job.id, table];
    if (table === "staff_users") params.push(shop.id);
    statements.push(
      db
        .prepare(
          `INSERT INTO ${table}(shop_id,${cols.join(",")}) SELECT ?,${expressions.join(",")}
      FROM shop_data_rows WHERE job_id=? AND table_name=?${filter}${conflict}`,
        )
        .bind(...params),
    );
  }
  if (v2Devices) statements.push(...v2Devices.history);
  // A mahjong table's size used to live in its capability; it is the resource's capacity now.
  statements.push(db.prepare(
    `UPDATE machines SET capacity=(SELECT json_extract(c.config_json,'$.capacity') FROM device_capabilities c
       WHERE c.shop_id=machines.shop_id AND c.device_id=machines.id AND c.capability='mahjong')
     WHERE shop_id=? AND EXISTS(SELECT 1 FROM device_capabilities c WHERE c.shop_id=machines.shop_id AND c.device_id=machines.id
       AND c.capability='mahjong' AND json_type(c.config_json,'$.capacity')='integer')`,
  ).bind(shop.id));
  const profile = header.shopProfile;
  const timeZone = profile ? resolveLocationTimeZone(profile.latitude, profile.longitude) : shop.time_zone;
  if (profile)
    statements.push(
      db
        .prepare(
          "UPDATE shops SET name=?,latitude=?,longitude=?,radius_meters=?,hero_data=?,hero_hash=?,updated_at=? WHERE id=?",
        )
        .bind(
          profile.name,
          profile.latitude,
          profile.longitude,
          profile.radiusMeters,
          profile.heroData,
          profile.heroData ? await sha256(profile.heroData) : null,
          now,
          shop.id,
        ),
    );
  if (!partial) statements.push(
    db
      .prepare(
        `INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES (?,'store.profile',?,?)
    ON CONFLICT(shop_id,key) DO UPDATE SET value_json=json_set(app_settings.value_json,'$.name',json_extract(excluded.value_json,'$.name'),'$.timeZone',json_extract(excluded.value_json,'$.timeZone')),updated_at=excluded.updated_at`,
      )
      .bind(shop.id, JSON.stringify({ name: profile?.name ?? shop.name, timeZone }), now),
  );
  // v1 files contain only the original settings subset.
  if (header.version === 1) {
    const s = header.settings;
    statements.push(
      db
        .prepare(
          `INSERT INTO shop_billing_settings(shop_id,auto_register,checkin_geo,checkout_geo,machine_geo,bot_contact,identity_binding_required)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(shop_id) DO UPDATE SET auto_register=excluded.auto_register,checkin_geo=excluded.checkin_geo,
      checkout_geo=excluded.checkout_geo,machine_geo=excluded.machine_geo,bot_contact=excluded.bot_contact,identity_binding_required=excluded.identity_binding_required`,
        )
        .bind(
          shop.id,
          +s.autoRegister,
          +s.checkinGeo,
          +s.checkoutGeo,
          +s.machineGeo,
          s.botContact,
          +s.identityBindingRequired,
        ),
    );
    for (const [key, value] of [
      ["cashier.settings", { enabled: s.cashierEnabled }],
      ["venue.operations", { timeZone: "UTC", coinCooldownMs: s.coinCooldownMs }],
      ["player.registration", { defaultPresentId: s.defaultPresentId }],
    ] as const)
      statements.push(
        db
          .prepare(
            `INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(shop_id,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`,
          )
          .bind(shop.id, key, JSON.stringify(value), now),
      );
  }
  // The default group: stored by newer files, otherwise made here with the plan
  // older files kept as the shop's default plan.
  statements.push(ensureDefaultGroupStatement(db, shop.id, header.settings.entryPricingIds?.[0] ?? null));
  if (partial) statements.push(...partialPricingStatements(db, shop.id, header.settings.entryPricingIds?.[0] ?? null));
  statements.push(...missingFrontDeskStatements(db, shop.id));
  if (header.settings.billingEnabled === false) statements.push(...freeShopStatements(db, shop.id));
  if (rowsCount.account_links) {
    const cols = schemas.account_links.columns.map((c) => c.name);
    statements.push(
      db
        .prepare(
          `INSERT INTO shop_imported_accounts(shop_id,${cols.join(",")}) SELECT ?,${cols.map((col) => `json_extract(payload_json,'$.${col}')`).join(",")}
      FROM shop_data_rows WHERE job_id=? AND table_name='account_links'`,
        )
        .bind(shop.id, job.id),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO app_settings(shop_id,key,value_json,updated_at) SELECT ?,'backup.importedAccounts','true',?
      WHERE EXISTS(SELECT 1 FROM shop_data_rows WHERE job_id=? AND table_name='account_links') ON CONFLICT(shop_id,key) DO NOTHING`,
        )
        .bind(shop.id, now, job.id),
    );
  }
  statements.push(...triggers.map((t) => db.prepare(t.sql)));
  statements.push(
    db
      .prepare("UPDATE shop_data_jobs SET status='completed',result_json=?,operation_id=? WHERE id=?")
      .bind(JSON.stringify(result), operationId, job.id),
  );
  for (const table of ["shop_data_rows", "shop_data_parts", "shop_data_keys", "shop_data_device_ids"])
    statements.push(db.prepare(`DELETE FROM ${table} WHERE job_id=?`).bind(job.id));
  try {
    await db.batch(statements);
  } catch (error) {
    if (String(error).includes("NOT NULL constraint failed: player_operations.id"))
      jsonError(409, "店铺数据或文件已变化，请重新导入", "IMPORT_TARGET_CHANGED");
    if (String(error).includes("constraint failed") || String(error).includes("CASHIER_PROFILE_RESTRICTED"))
      jsonError(409, "数据校验失败，导入已全部回滚，请重试", "IMPORT_CONSTRAINT_FAILED");
    throw error;
  }
  // Restored resources, groups and plans change what entering through each bot starts.
  notifyBotsChangedAfter(c, shop.id);
  return result;
}

export function registerShopDataJobRoutes(app: Hono<AppBindings>) {
  registerShopExportRoutes(app);
  app.delete(base + "/imports/:jobId", async (c) => {
    const { job } = await getJob(c, "import");
    if (job.status === "completed") jsonError(409, "已完成导入不能撤销", "TRANSFER_LOCKED");
    await (c.env.DB as LegacyD1Database).prepare("DELETE FROM shop_data_jobs WHERE id=? AND status IN ('uploading','ready','stale')")
      .bind(job.id)
      .run();
    return c.json({ deleted: true });
  });
  app.post(base + "/imports", async (c) => {
    const shop = await owner(c);
    await cleanup(c.env.DB as LegacyD1Database);
    const header = parse(fullHeaderSchema, await body(c));
    const id = crypto.randomUUID();
    try {
      await (c.env.DB as LegacyD1Database).batch([
        importAttemptStatement(c, shop, id),
        (c.env.DB as LegacyD1Database).prepare(
          "INSERT INTO shop_data_jobs(id,shop_id,user_id,kind,status,header_json,created_at,expires_at) VALUES (?,?,?,'import','uploading',?,?,?)",
        ).bind(id, shop.id, requireUser(c).id, JSON.stringify(header), new Date().toISOString(), expiry()),
      ]);
    } catch (error) { shopExportError(error); }
    return c.json({ jobId: id, tables: fullTables(header) });
  });
  app.post(base + "/imports/:jobId/parts", async (c) => {
    const { job, header } = await getJob(c, "import");
    const input = parse(
      z
        .object({
          table: z.string(),
          part: z.number().int().nonnegative().max(10000000),
          rows: z.array(z.record(primitive)).max(1000),
        })
        .strict(),
      await body(c),
    );
    await stage(c, job, header, input);
    return c.json({ accepted: true, part: input.part });
  });
  app.post(base + "/imports/:jobId/preview", async (c) => {
    const { shop, job, header } = await getJob(c, "import");
    const manifest = parse(
      z
        .object({ counts: z.record(z.number().int().nonnegative()), parts: z.number().int().nonnegative() })
        .strict(),
      await body(c),
    );
    return c.json(await previewJob(c, shop, job, header, manifest));
  });
  app.post(base + "/imports/:jobId/apply", async (c) => {
    const { shop, job, header } = await getJob(c, "import");
    const input = parse(
      z.object({ fingerprint: z.string(), operationId: z.string().uuid(), overwrite: z.boolean().optional().default(false) }).strict(),
      await body(c),
    );
    const repos = createD1Repositories({
      db: c.env.DB,
      shopId: shop.id,
      id: crypto.randomUUID,
      now: () => new Date(),
    });
    return withOperationLease(
      { repository: repos.operationLocks, scope: "shop.cashier", resourceId: shop.id, now: () => new Date() },
      async () => c.json(await applyJob(c, shop, job, header, input.fingerprint, input.operationId, input.overwrite ?? false)),
    );
  });
}
