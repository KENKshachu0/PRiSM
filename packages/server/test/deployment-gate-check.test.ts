import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import {
  deploymentControl,
  deploymentGateSchema,
} from "../src/deployment-gate.js";
import { sha256 } from "../src/crypto.js";
import { utcPricingMigrationId } from "@prism/storage-sql";
import { shopLocationTimeZoneMigrationId } from "../src/migrations/shop-time-zone-migration.js";
import type { Env } from "../src/bindings.js";

async function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.run(deploymentGateSchema);
  sqlite.run("CREATE TABLE prism_data_migrations (id TEXT PRIMARY KEY)");
  sqlite.run("CREATE TABLE pricing_configs (kind TEXT NOT NULL, provider_json TEXT NOT NULL)");
  sqlite.run("CREATE TABLE pricing_config_versions (kind TEXT NOT NULL, provider_json TEXT NOT NULL)");
  sqlite.run("CREATE TABLE pricing_releases (time_zone TEXT NOT NULL)");
  const token = "A".repeat(48);
  const owner = await sha256(token);
  sqlite.query(
    "INSERT INTO prism_deployment_gate(id,owner_hash,maintenance,permit,checked,updated_at) VALUES ('global',?,1,0,0,?)",
  ).run(owner, new Date().toISOString());
  sqlite.query("INSERT INTO prism_data_migrations(id) VALUES (?)").run(utcPricingMigrationId);
  sqlite.query("INSERT INTO prism_data_migrations(id) VALUES (?)").run(shopLocationTimeZoneMigrationId);
  const env = {
    DB: createD1DatabaseFromSqlite(sqlite),
    PRISM_DEPLOY_PHASE: "verify",
    PRISM_DEPLOY_GUARD: "1",
    PRISM_DEPLOY_TOKEN_HASH: owner,
    PRISM_DEPLOY_REVISION: "a".repeat(40),
  } as unknown as Env;
  const request = () => new Request("https://example.test/__prism_deploy", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ action: "check" }),
  });
  return { sqlite, env, request };
}

describe("deployment check with D1 first-row semantics", () => {
  it("accepts zero invalid UTC prices and marks the gate checked without lifting maintenance", async () => {
    const { sqlite, env, request } = await fixture();
    try {
      let healthCalls = 0;
      const response = await deploymentControl(request(), env, async () => {
        healthCalls++;
        return Response.json({ data: { ok: true } });
      });
      expect(response?.status).toBe(200);
      expect(await response?.json()).toMatchObject({ ok: true, checked: true, phase: "verify" });
      expect(healthCalls).toBe(1);
      expect(sqlite.query(
        "SELECT maintenance,permit,checked FROM prism_deployment_gate WHERE id='global'",
      ).get()).toEqual({ maintenance: 1, permit: 0, checked: 1 });
    } finally {
      sqlite.close();
    }
  });

  it("rejects non-UTC pricing and keeps the deployment fenced", async () => {
    const { sqlite, env, request } = await fixture();
    try {
      sqlite.run("INSERT INTO pricing_configs(kind,provider_json) VALUES ('time.priority','{\"timeZone\":\"Asia/Shanghai\"}')");
      let healthCalled = false;
      const response = await deploymentControl(request(), env, async () => {
        healthCalled = true;
        return Response.json({ ok: true });
      });
      expect(response?.status).toBe(500);
      const body = (await response?.json()) as { error?: string };
      expect(body.error).toContain("UTC pricing verification failed");
      expect(healthCalled).toBe(false);
      expect(sqlite.query(
        "SELECT maintenance,permit,checked FROM prism_deployment_gate WHERE id='global'",
      ).get()).toEqual({ maintenance: 1, permit: 0, checked: 0 });
    } finally {
      sqlite.close();
    }
  });
});
