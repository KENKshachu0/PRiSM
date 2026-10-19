import { convertPricingRuleClock, formatLocalDate, migrateCurrentPricingRules, migrateHistoricalPricingRules, type PriorityTimePricingRule, type TimeCapPricingRule } from "@prism/core";
import type { SqlExecutor, SqlStatement } from "./repositories";
import { pricingVersionSchema } from "./pricing-version-schema";
import { utcPricingSchema } from "./utc-pricing-schema";

export const utcPricingMigrationId = "utc-pricing-data-v1";
type Version = { shop_id: string; version_id: string; config_id: string; version: number; kind: string; name: string; enabled: number; status: string; provider_json: string; created_at: string; updated_at: string };
type Config = Omit<Version, "version_id" | "version" | "config_id"> & { id: string };
type Release = { shop_id: string; id: string; version_ids_json: string; time_zone: string; created_at: string };
type Provider = { id: string; timeZone?: string; historyProviderId?: string; rules?: (PriorityTimePricingRule | TimeCapPricingRule)[] } & Record<string, unknown>;
type Summary = { applied: boolean; versions: number; releases: number; snapshots: number };
const key = (shop: string, id: string) => JSON.stringify([shop, id]);

function providerOf(json: string): Provider {
  const provider = JSON.parse(json) as Provider;
  provider.rules = provider.rules?.map(rule => ({ ...rule,
    ...(rule.anchorAt ? { anchorAt: new Date(rule.anchorAt) } : {}),
    ...(rule.dateTimeRange ? { dateTimeRange: { start: new Date(rule.dateTimeRange.start), end: new Date(rule.dateTimeRange.end) } } : {}),
  }));
  return provider;
}

/** One atomic batch; the completion marker and all data changes commit together. */
export async function migrateLegacyPricingToUtc(input: { executor: SqlExecutor; now: Date; id: () => string }): Promise<Summary> {
  const { executor, now, id } = input;
  await executor.run(utcPricingSchema.at(-1)!);
  if (await executor.first("SELECT id FROM prism_data_migrations WHERE id=?", [utcPricingMigrationId])) {
    return { applied: false, versions: 0, releases: 0, snapshots: 0 };
  }
  const [versions, configs, releases, heads, settings, sessions] = await Promise.all([
    executor.all<Version>("SELECT * FROM pricing_config_versions ORDER BY shop_id,config_id,version"),
    executor.all<Config>("SELECT * FROM pricing_configs"),
    executor.all<Release>("SELECT * FROM pricing_releases ORDER BY rowid"),
    executor.all<{ shop_id: string; release_id: string }>("SELECT * FROM pricing_release_heads"),
    executor.all<{ shop_id: string; key: string; value_json: string }>("SELECT * FROM app_settings WHERE key IN ('store.profile','venue.operations')"),
    executor.all<{ shop_id: string; release_id: string; started_at: string }>("SELECT b.shop_id,b.release_id,s.started_at FROM session_pricing_releases b JOIN sessions s ON s.shop_id=b.shop_id AND s.id=b.session_id"),
  ]);
  const operations = new Map<string, string>(), profiles = new Map<string, string>();
  for (const setting of settings) {
    const zone = JSON.parse(setting.value_json).timeZone;
    if (typeof zone === "string" && zone.trim()) (setting.key === "venue.operations" ? operations : profiles).set(setting.shop_id, zone);
  }
  const defaults = (shop: string) => operations.get(shop) ?? profiles.get(shop) ?? "UTC";
  const byVersion = new Map(versions.map(row => [key(row.shop_id, row.version_id), row]));
  const byRelease = new Map(releases.map(row => [key(row.shop_id, row.id), row]));
  const maxVersion = new Map<string, number>(), latest = new Map<string, Version>();
  for (const row of versions) {
    maxVersion.set(key(row.shop_id, row.config_id), row.version);
    latest.set(key(row.shop_id, row.config_id), row);
  }
  const nextVersion = (row: Version) => {
    const k = key(row.shop_id, row.config_id), version = (maxVersion.get(k) ?? 0) + 1;
    maxVersion.set(k, version);
    return version;
  };
  const starts = new Map<string, number>();
  for (const session of sessions) {
    const k = key(session.shop_id, session.release_id);
    starts.set(k, Math.min(starts.get(k) ?? Infinity, Date.parse(session.started_at)));
  }
  // A version can be shared by releases whose implicit timezones differ.
  const contexts = new Map<string, Map<string, number>>();
  for (const release of releases) for (const versionId of JSON.parse(release.version_ids_json) as string[]) {
    const k = key(release.shop_id, versionId), row = byVersion.get(k);
    if (!row) throw new Error(`Missing pricing version ${versionId}`);
    const provider = providerOf(row.provider_json), zone = row.kind === "charge.fixed" ? "UTC" : provider.timeZone ?? release.time_zone;
    const groups = contexts.get(k) ?? new Map<string, number>();
    groups.set(zone, Math.min(groups.get(zone) ?? Infinity, starts.get(key(release.shop_id, release.id)) ?? Date.parse(row.created_at), Date.parse(row.created_at)));
    contexts.set(k, groups);
  }
  const statements: SqlStatement[] = [{ sql: "INSERT INTO prism_data_migrations(id,applied_at) VALUES(?,?)", params: [utcPricingMigrationId, now.toISOString()] }];
  // Abort the whole batch if publication changed while the conversion plan was built.
  statements.push({ sql: "INSERT INTO prism_data_migrations(id,applied_at) SELECT ?,? WHERE (SELECT COUNT(*) FROM pricing_config_versions)!=? OR (SELECT COUNT(*) FROM pricing_releases)!=? OR (SELECT COUNT(*) FROM session_pricing_releases)!=?",
    params: [utcPricingMigrationId, now.toISOString(), versions.length, releases.length, sessions.length] });
  for (const trigger of ["pricing_config_version_insert", "pricing_config_version_update", "pricing_config_version_delete", "pricing_config_versions_immutable_update", "pricing_releases_immutable_update"]) {
    statements.push({ sql: `DROP TRIGGER IF EXISTS ${trigger}` });
  }
  const mapped = new Map<string, string>();
  let changedVersions = 0, changedReleases = 0, snapshots = 0;
  const changedShops = new Set<string>();
  const insertVersion = (row: Version, versionId: string, version: number, provider: Provider) => statements.push({
    sql: "INSERT INTO pricing_config_versions(shop_id,version_id,config_id,version,kind,name,enabled,status,provider_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    params: [row.shop_id, versionId, row.config_id, version, row.kind, row.name, row.enabled, row.status, JSON.stringify(provider), row.created_at, row.updated_at],
  });
  for (const row of versions) {
    const k = key(row.shop_id, row.version_id), original = providerOf(row.provider_json);
    const groups = contexts.get(k) ?? new Map([[row.kind === "charge.fixed" ? "UTC" : original.timeZone ?? defaults(row.shop_id), Date.parse(row.created_at)]]);
    let first = true;
    for (const [zone, from] of groups) {
      const provider = { ...original };
      if (row.kind !== "charge.fixed") {
        provider.timeZone = "UTC";
        if (zone !== "UTC") {
          provider.rules = migrateHistoricalPricingRules(original.rules ?? [], zone, new Date(from), now);
          if (row.kind === "time.priority") provider.historyProviderId = original.historyProviderId ?? (row.version === 1 ? original.id : row.version_id);
          changedShops.add(row.shop_id);
        }
      }
      if (!first && row.kind === "time.priority") provider.historyProviderId = original.historyProviderId ?? (row.version === 1 ? original.id : row.version_id);
      const versionId = first ? row.version_id : id();
      mapped.set(key(k, zone), versionId);
      if (first) {
        if (JSON.stringify(provider) !== row.provider_json) {
          statements.push({ sql: "UPDATE pricing_config_versions SET provider_json=? WHERE shop_id=? AND version_id=?", params: [JSON.stringify(provider), row.shop_id, row.version_id] });
          changedVersions++;
        }
      } else {
        insertVersion(row, versionId, nextVersion(row), provider);
        changedVersions++;
      }
      first = false;
    }
  }
  for (const release of releases) {
    const ids = (JSON.parse(release.version_ids_json) as string[]).map(versionId => {
      const k = key(release.shop_id, versionId), row = byVersion.get(k)!;
      const zone = row.kind === "charge.fixed" ? "UTC" : providerOf(row.provider_json).timeZone ?? release.time_zone;
      return mapped.get(key(k, zone))!;
    });
    if (release.time_zone !== "UTC" || JSON.stringify(ids) !== release.version_ids_json) {
      statements.push({ sql: "UPDATE pricing_releases SET version_ids_json=?,time_zone='UTC' WHERE shop_id=? AND id=?", params: [JSON.stringify(ids), release.shop_id, release.id] });
      changedReleases++;
    }
  }
  const currentIds = new Map<string, string[]>();
  for (const config of configs) {
    const row = latest.get(key(config.shop_id, config.id));
    if (!row) throw new Error(`Missing current pricing version ${config.id}`);
    const head = heads.find(head => head.shop_id === config.shop_id);
    const sourceZone = providerOf(config.provider_json).timeZone ?? (head && byRelease.get(key(config.shop_id, head.release_id))?.time_zone) ?? defaults(config.shop_id);
    const provider = providerOf(config.provider_json);
    if (config.kind !== "charge.fixed") {
      provider.timeZone = "UTC";
      if (config.kind === "time.priority" && changedShops.has(config.shop_id)) {
        const original = providerOf(row.provider_json);
        provider.historyProviderId = original.historyProviderId ?? (row.version === 1 ? original.id : row.version_id);
      }
      provider.rules = migrateCurrentPricingRules(provider.rules ?? [], sourceZone, now);
    }
    if (JSON.stringify(provider) !== config.provider_json) statements.push({ sql: "UPDATE pricing_configs SET provider_json=? WHERE shop_id=? AND id=?", params: [JSON.stringify(provider), config.shop_id, config.id] });
    let versionId = row.version_id;
    if (changedShops.has(config.shop_id) && config.kind !== "charge.fixed") {
      versionId = id();
      insertVersion(row, versionId, nextVersion(row), provider);
      changedVersions++;
    }
    currentIds.set(config.shop_id, [...(currentIds.get(config.shop_id) ?? []), versionId]);
  }
  // Old release IDs and session bindings remain stable. New admissions see compact UTC rules.
  for (const shop of changedShops) {
    const releaseId = id();
    statements.push({ sql: "INSERT INTO pricing_releases(shop_id,id,version_ids_json,time_zone,created_at) VALUES(?,?,?,'UTC',?)", params: [shop, releaseId, JSON.stringify(currentIds.get(shop) ?? []), now.toISOString()] });
    statements.push({ sql: "INSERT INTO pricing_release_heads(shop_id,release_id) VALUES(?,?) ON CONFLICT(shop_id) DO UPDATE SET release_id=excluded.release_id", params: [shop, releaseId] });
    changedReleases++;
  }
  for (const setting of settings.filter(row => row.key === "venue.operations")) {
    const value = JSON.parse(setting.value_json) as Record<string, unknown>;
    if (typeof value.timeZone === "string" && value.timeZone !== "UTC") {
      statements.push({ sql: "UPDATE app_settings SET value_json=? WHERE shop_id=? AND key='venue.operations'", params: [JSON.stringify({ ...value, timeZone: "UTC" }), setting.shop_id] });
    }
  }
  for (const [table, idColumn, jsonColumn] of [
    ["checkout_timelines", "checkout_id", "timeline_json"],
    ["pricing_history_entries", "id", "metadata_json"],
    ["pricing_cap_history_entries", "id", "metadata_json"],
  ] as const) {
    const rows = await executor.all<{ shop_id: string; row_id: string; data: string }>(`SELECT shop_id,${idColumn} AS row_id,${jsonColumn} AS data FROM ${table} WHERE ${jsonColumn} IS NOT NULL`);
    for (const row of rows) {
      const converted = JSON.stringify(utcSnapshot(JSON.parse(row.data)));
      if (converted === row.data) continue;
      statements.push({ sql: `UPDATE ${table} SET ${jsonColumn}=? WHERE shop_id=? AND ${idColumn}=?`, params: [converted, row.shop_id, row.row_id] });
      snapshots++;
    }
  }
  for (const sql of utcPricingSchema.filter(sql => sql.startsWith("CREATE TRIGGER"))) statements.push({ sql });
  for (const sql of pricingVersionSchema.filter(sql => sql.startsWith("CREATE TRIGGER IF NOT EXISTS pricing_config_versions_immutable_update") || sql.startsWith("CREATE TRIGGER IF NOT EXISTS pricing_releases_immutable_update"))) statements.push({ sql });
  try {
    await executor.batch(statements);
  } catch (error) {
    // Another worker can win the one-time transaction; never rerun its conversion.
    if (await executor.first("SELECT id FROM prism_data_migrations WHERE id=?", [utcPricingMigrationId])) return { applied: false, versions: 0, releases: 0, snapshots: 0 };
    throw error;
  }
  return { applied: true, versions: changedVersions, releases: changedReleases, snapshots };
}

export const importedReleaseUtcMigrationId = "imported-release-utc-v1";

/**
 * Backups imported before the converter fix could carry a shop time zone on
 * `pricing_releases`. The storage contract requires UTC (the deployment check
 * rejects anything else), so normalize stray rows once, before the check.
 * Provider rules keep their own explicit `timeZone`, so this does not shift
 * any clock.
 */
export async function normalizeImportedReleaseTimeZones(input: {
  executor: SqlExecutor;
  now: Date;
}): Promise<{ applied: boolean; releases: number }> {
  const { executor, now } = input;
  await executor.run(utcPricingSchema.at(-1)!);
  if (await executor.first("SELECT id FROM prism_data_migrations WHERE id=?", [importedReleaseUtcMigrationId])) {
    return { applied: false, releases: 0 };
  }
  const rows = await executor.all<{ shop_id: string; id: string }>("SELECT shop_id,id FROM pricing_releases WHERE time_zone!='UTC'");
  const statements: SqlStatement[] = [
    { sql: "INSERT OR IGNORE INTO prism_data_migrations(id,applied_at) VALUES(?,?)", params: [importedReleaseUtcMigrationId, now.toISOString()] },
    { sql: "DROP TRIGGER IF EXISTS pricing_releases_immutable_update" },
    { sql: "UPDATE pricing_releases SET time_zone='UTC' WHERE time_zone!='UTC'" },
  ];
  for (const sql of pricingVersionSchema.filter(sql => sql.startsWith("CREATE TRIGGER IF NOT EXISTS pricing_releases_immutable_update"))) statements.push({ sql });
  await executor.batch(statements);
  return { applied: true, releases: rows.length };
}

function utcSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(utcSnapshot);
  if (!value || typeof value !== "object") return value;
  const original = value as Record<string, unknown>;
  const row = Object.fromEntries(Object.entries(original).map(([k, v]) => [k, utcSnapshot(v)]));
  for (const timestamp of ["at", "startedAt", "endedAt", "settledAt", "createdAt", "ruleAnchorAt", "capAnchorAt", "windowStartedAt", "windowEndedAt", "start", "end"]) {
    const value = original[timestamp];
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) row[timestamp] = new Date(value).toISOString();
  }
  if (typeof original.timeZone === "string") row.timeZone = "UTC";
  if (original.ruleTimeRange && typeof original.timeZone === "string") {
    const period = original.period as { startedAt?: string } | undefined;
    if (period?.startedAt) row.ruleTimeRange = convertPricingRuleClock({ timeRange: original.ruleTimeRange as { start: string; end: string } }, original.timeZone, "UTC", formatLocalDate(new Date(period.startedAt), original.timeZone)).timeRange;
  }
  if (typeof original.at === "string" && Array.isArray(original.entries)) {
    const at = new Date(original.at).toISOString();
    row.at = at; row.date = at.slice(0, 10); row.time = at.slice(11, 16);
  }
  if (typeof original.startedAt === "string" && typeof original.endedAt === "string" && typeof original.periodLabel === "string") {
    const start = new Date(original.startedAt).toISOString(), end = new Date(original.endedAt).toISOString();
    row.periodLabel = start.slice(0, 10) === end.slice(0, 10) ? `${start.slice(11, 16)} – ${end.slice(11, 16)}` : `${start.slice(0, 16).replace("T", " ")} – ${end.slice(0, 16).replace("T", " ")}`;
  }
  return row;
}
