import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { migrateLegacyPricingToUtc, normalizeImportedReleaseTimeZones, sqliteSchema } from "@prism/storage-sql";
import { utcPricingSchema } from "../../storage-sql/src/utc-pricing-schema";
import { createD1Executor } from "../src";

test("real D1 migrates IANA rules, preserves bindings and restores immutable guards in one batch", async () => {
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", compatibilityDate: "2026-06-07", d1Databases: ["DB"] });
  try {
    const db = await mf.getD1Database("DB");
    for (const sql of sqliteSchema.filter(sql => !(utcPricingSchema as readonly string[]).includes(sql))) await db.prepare(sql).run();
    await db.prepare("INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES('shop','store.profile','{\"timeZone\":\"Asia/Shanghai\"}','2026-10-02T02:00:00Z')").run();
    const provider = { id: "provider", rules: [{ id: "base", label: "Base", priority: 1, timeRange: { start: "10:00", end: "03:00" }, pricing: { unitMinutes: 60, unitPrice: 1800, roundGraceMinutes: 10, priceCap: 9000 } }] };
    await db.prepare("INSERT INTO pricing_configs(shop_id,id,kind,name,enabled,status,provider_json,created_at,updated_at) VALUES('shop','rate','time.priority','Rate',1,'active',?,'2026-10-02T02:00:00Z','2026-10-02T02:00:00Z')").bind(JSON.stringify(provider)).run();
    await db.prepare("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES('shop','p','P','active','2026-10-02T02:00:00Z')").run();
    await db.prepare("INSERT INTO sessions(shop_id,id,player_id,started_at,status,payment_status,pricing_config_ids_json) VALUES('shop','s','p','2026-10-02T02:08:00Z','active','unpaid','[\"rate\"]')").run();
    const binding = await db.prepare("SELECT * FROM session_pricing_releases").all();
    for (const sql of utcPricingSchema) await db.prepare(sql).run();
    const input = { executor: createD1Executor(db), now: new Date("2026-10-02T03:54:00Z"), id: () => crypto.randomUUID() };
    expect((await migrateLegacyPricingToUtc(input)).applied).toBe(true);
    expect((await db.prepare("SELECT * FROM session_pricing_releases").all()).results).toEqual(binding.results);
    const current = await db.prepare("SELECT provider_json FROM pricing_configs").first<{ provider_json: string }>();
    expect(JSON.parse(current!.provider_json)).toMatchObject({ timeZone: "UTC", rules: [{ timeRange: { start: "02:00", end: "19:00" }, pricing: { unitPrice: 1800, priceCap: 9000 } }] });
    expect((await db.prepare("SELECT time_zone FROM pricing_releases WHERE time_zone!='UTC'").all()).results).toEqual([]);
    const once = (await db.prepare("SELECT * FROM pricing_config_versions ORDER BY version").all()).results;
    expect((await migrateLegacyPricingToUtc(input)).applied).toBe(false);
    expect((await db.prepare("SELECT * FROM pricing_config_versions ORDER BY version").all()).results).toEqual(once);
    await expect(db.prepare("UPDATE pricing_releases SET time_zone='Asia/Shanghai'").run()).rejects.toThrow("immutable");
  } finally {
    await mf.dispose();
  }
}, 30000);

test("normalizes imported non-UTC release zones once and restores the immutable guard", async () => {
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", compatibilityDate: "2026-06-07", d1Databases: ["DB"] });
  try {
    const db = await mf.getD1Database("DB");
    for (const sql of sqliteSchema) await db.prepare(sql).run();
    await db.prepare("INSERT INTO pricing_releases(shop_id,id,version_ids_json,time_zone,created_at) VALUES('shop','legacy-release','[]','Asia/Shanghai','2026-10-02T02:00:00Z')").run();
    const input = { executor: createD1Executor(db), now: new Date("2026-10-02T03:54:00Z") };
    expect(await normalizeImportedReleaseTimeZones(input)).toEqual({ applied: true, releases: 1 });
    expect(await db.prepare("SELECT time_zone FROM pricing_releases WHERE id='legacy-release'").first<{ time_zone: string }>()).toEqual({ time_zone: "UTC" });
    // The marker makes the repair one-shot.
    expect(await normalizeImportedReleaseTimeZones(input)).toEqual({ applied: false, releases: 0 });
    // The immutability guard is back in place.
    await expect(db.prepare("UPDATE pricing_releases SET time_zone='Asia/Shanghai'").run()).rejects.toThrow("immutable");
  } finally {
    await mf.dispose();
  }
}, 30000);
