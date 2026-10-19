import {
  createD1Executor,
  type D1BoundStatementLike,
  type D1DatabaseLike,
} from "@prism/adapter-d1";
import {
  migrateLegacyPricingToUtc,
  normalizeImportedReleaseTimeZones,
  splitD1MigrationStatements,
  utcPricingMigrationId,
} from "@prism/storage-sql";
import type { Env } from "./bindings.js";
import { sha256 } from "./crypto.js";
import {
  migrateShopLocationTimeZones,
  shopLocationTimeZoneMigrationId,
} from "./migrations/shop-time-zone-migration.js";

export const deploymentGateTable = "prism_deployment_gate";
export const deploymentControlPath = "/__prism_deploy";
export const deploymentGateSchema = `CREATE TABLE IF NOT EXISTS prism_deployment_gate (
  id TEXT PRIMARY KEY CHECK(id='global'), owner_hash TEXT NOT NULL,
  maintenance INTEGER NOT NULL CHECK(maintenance IN (0,1)),
  permit INTEGER NOT NULL DEFAULT 0 CHECK(permit IN (0,1)),
  checked INTEGER NOT NULL DEFAULT 0 CHECK(checked IN (0,1)), updated_at TEXT NOT NULL
)`;

const excluded = new Set([
  deploymentGateTable,
  "d1_migrations",
  "prism_data_migrations",
]);

export function sqlIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function writeFenceStatements(tables: Iterable<string>): string[] {
  return [...tables]
    .filter(
      (name) =>
        !excluded.has(name) &&
        !name.startsWith("sqlite_") &&
        !name.startsWith("_cf_"),
    )
    .flatMap((table) => {
      const encoded = [...new TextEncoder().encode(table)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      return ["INSERT", "UPDATE", "DELETE"].map(
        (operation) => `CREATE TRIGGER IF NOT EXISTS ${sqlIdentifier(`prism_maintenance_${encoded}_${operation.toLowerCase()}`)}
      BEFORE ${operation} ON ${sqlIdentifier(table)}
      WHEN EXISTS(SELECT 1 FROM prism_deployment_gate WHERE id='global' AND maintenance=1 AND permit=0)
      BEGIN SELECT RAISE(ABORT,'PRISM_MAINTENANCE'); END`,
      );
    });
}

/** Track table replacements so their fences are restored inside the same migration transaction. */
export function tablesAfterMigration(
  tables: string[],
  statements: readonly string[],
): string[] {
  const names = new Set(tables);
  for (const sql of statements) {
    const create =
      /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/i.exec(
        sql,
      );
    const drop =
      /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/i.exec(sql);
    const rename =
      /^ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+RENAME\s+TO\s+([A-Za-z_][A-Za-z0-9_]*)\b/i.exec(
        sql,
      );
    if (create) names.add(create[1]!);
    if (drop) names.delete(drop[1]!);
    if (rename) {
      names.delete(rename[1]!);
      names.add(rename[2]!);
    }
    if (
      /^(?:CREATE|DROP)\s+TABLE\b|^ALTER\s+TABLE\b.*\bRENAME\s+TO\b/i.test(
        sql,
      ) &&
      !create &&
      !drop &&
      !rename
    ) {
      throw new Error(
        "Unsupported table identifier in migration; refusing an unfenced schema change",
      );
    }
  }
  return [...names];
}

export async function isDeploymentMaintenance(env: Env): Promise<boolean> {
  if (
    env.PRISM_DEPLOY_PHASE === "maintenance" ||
    env.PRISM_DEPLOY_PHASE === "verify"
  ) {
    return true;
  }
  if (env.PRISM_DEPLOY_GUARD !== "1") {
    return false;
  }
  if (!env.DB) {
    return false;
  }
  // Missing control state must fail closed on a production deployment.
  const row = await env.DB.prepare(
    "SELECT maintenance FROM prism_deployment_gate WHERE id='global'",
  )
    .bind()
    .first<{ maintenance: number }>();
  return row?.maintenance !== 0;
}

export function maintenanceResponse(request: Request): Response {
  const headers = {
    "cache-control": "no-store",
    "retry-after": "30",
    "x-prism-maintenance": "1",
  };
  if (request.headers.get("accept")?.includes("text/html")) {
    return new Response(
      '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>正在升级</title><body><main><h1>正在升级，请稍后重试</h1><p>升级完成后刷新页面即可继续。</p></main></body></html>',
      {
        status: 503,
        headers: { ...headers, "content-type": "text/html; charset=utf-8" },
      },
    );
  }
  return Response.json(
    { error: { code: "MAINTENANCE", message: "正在升级，请稍后重试" } },
    { status: 503, headers },
  );
}

/** Only this atomic batch may write while maintenance is active; other D1 requests see permit=0. */
export async function deploymentBatch(
  db: D1DatabaseLike,
  owner: string,
  statements: readonly D1BoundStatementLike[],
) {
  return db.batch([
    db
      .prepare(
        `INSERT INTO prism_deployment_gate(id,owner_hash,maintenance,permit,checked,updated_at)
      SELECT 'global',?,1,0,0,? WHERE NOT EXISTS(
        SELECT 1 FROM prism_deployment_gate WHERE id='global' AND owner_hash=? AND maintenance=1)`,
      )
      .bind(owner, new Date().toISOString(), owner),
    db
      .prepare(
        "UPDATE prism_deployment_gate SET permit=1 WHERE id='global' AND owner_hash=?",
      )
      .bind(owner),
    ...statements,
    db
      .prepare(
        "UPDATE prism_deployment_gate SET permit=0 WHERE id='global' AND owner_hash=?",
      )
      .bind(owner),
  ]);
}

/** An old in-flight worker must never publish a local clock after maintenance is released. */
export const utcWriteGuards = ["INSERT", "UPDATE"].map(
  (operation) => `CREATE TRIGGER IF NOT EXISTS prism_utc_pricing_${operation.toLowerCase()}
  BEFORE ${operation} ON pricing_configs
  WHEN NEW.kind IN ('time.priority','time.cap') AND json_extract(NEW.provider_json,'$.timeZone') IS NOT 'UTC'
  BEGIN SELECT RAISE(ABORT,'UTC_PRICING_REQUIRED'); END`,
);

async function tableNames(db: D1DatabaseLike): Promise<string[]> {
  const rows = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .bind()
    .all<{ name: string }>();
  return rows.results.map((row) => row.name);
}

export async function deploymentControl(
  request: Request,
  env: Env,
  health: () => Promise<Response>,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== deploymentControlPath) {
    return null;
  }
  const token = request.headers
    .get("authorization")
    ?.match(/^Bearer ([A-Za-z0-9_-]{40,200})$/)?.[1];
  const owner = token && (await sha256(token));
  if (
    request.method !== "POST" ||
    !owner ||
    owner !== env.PRISM_DEPLOY_TOKEN_HASH
  ) {
    return Response.json(
      { error: "Not found" },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
  const result = (data: Record<string, unknown>, status = 200) =>
    Response.json(
      {
        ...data,
        revision: env.PRISM_DEPLOY_REVISION,
        phase: env.PRISM_DEPLOY_PHASE,
      },
      { status, headers: { "cache-control": "no-store" } },
    );

  try {
    const input = (await request.json()) as {
      action?: string;
      name?: string;
      sql?: string;
    };
    if (input.action === "probe") {
      return result({ ok: true, phase: env.PRISM_DEPLOY_PHASE });
    }
    if (input.action === "begin" && env.PRISM_DEPLOY_PHASE === "maintenance") {
      await env.DB.prepare(deploymentGateSchema).bind().run();
      const tables = await tableNames(env.DB);
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO prism_deployment_gate(id,owner_hash,maintenance,permit,checked,updated_at)
          VALUES('global',?,1,0,0,?) ON CONFLICT(id) DO UPDATE SET owner_hash=excluded.owner_hash,
          maintenance=1,permit=0,checked=0,updated_at=excluded.updated_at`,
        ).bind(owner, new Date().toISOString()),
        ...writeFenceStatements(tables).map((sql) => env.DB.prepare(sql).bind()),
      ]);
      return result({ ok: true, maintenance: true });
    }
    const gate = await env.DB.prepare(
      "SELECT owner_hash,maintenance,checked FROM prism_deployment_gate WHERE id='global'",
    )
      .bind()
      .first<{ owner_hash: string; maintenance: number; checked: number }>();
    if (!gate || gate.owner_hash !== owner) {
      return result(
        {
          error: "Deployment ownership changed",
          code: "DEPLOYMENT_OWNERSHIP_CHANGED",
        },
        409,
      );
    }
    if (input.action === "status") {
      return result({
        ok: true,
        maintenance: gate.maintenance === 1,
        checked: gate.checked === 1,
      });
    }
    if (input.action === "block") {
      await env.DB.prepare(
        "UPDATE prism_deployment_gate SET maintenance=1,permit=0,checked=0 WHERE id='global' AND owner_hash=?",
      )
        .bind(owner)
        .run();
      return result({ ok: true, maintenance: true });
    }
    if (
      input.action === "resume" &&
      env.PRISM_DEPLOY_PHASE === "live" &&
      !gate.maintenance &&
      gate.checked
    ) {
      return result({ ok: true, maintenance: false });
    }
    if (!gate.maintenance) {
      return result(
        {
          error: "Maintenance must be active",
          code: "DEPLOYMENT_MAINTENANCE_REQUIRED",
        },
        409,
      );
    }
    const guardedDB: D1DatabaseLike = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: (statements: readonly D1BoundStatementLike[]) =>
        deploymentBatch(env.DB, owner, statements),
    };
    if (input.action === "schema" && env.PRISM_DEPLOY_PHASE === "maintenance") {
      if (
        !input.name ||
        !/^\d+_[a-z0-9_-]+\.sql$/.test(input.name) ||
        typeof input.sql !== "string" ||
        input.sql.length > 1_000_000
      ) {
        return result({ error: "Invalid migration" }, 400);
      }
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
      )
        .bind()
        .run();
      if (
        await env.DB.prepare("SELECT name FROM d1_migrations WHERE name=?")
          .bind(input.name)
          .first()
      ) {
        return result({ ok: true, skipped: true });
      }
      const statements = splitD1MigrationStatements(input.sql);
      const tables = tablesAfterMigration(await tableNames(env.DB), statements);
      await deploymentBatch(env.DB, owner, [
        ...statements.map((sql) => env.DB.prepare(sql).bind()),
        ...writeFenceStatements(tables).map((sql) => env.DB.prepare(sql).bind()),
        env.DB.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(
          input.name,
        ),
      ]);
      return result({ ok: true, skipped: false });
    }
    if (input.action === "convert" && env.PRISM_DEPLOY_PHASE === "verify") {
      const pricing = await migrateLegacyPricingToUtc({
        executor: createD1Executor(guardedDB),
        now: new Date(),
        id: () => crypto.randomUUID(),
      });
      const releases = await normalizeImportedReleaseTimeZones({
        executor: createD1Executor(guardedDB),
        now: new Date(),
      });
      const locations = await migrateShopLocationTimeZones(guardedDB);
      await deploymentBatch(
        env.DB,
        owner,
        utcWriteGuards.map((sql) => env.DB.prepare(sql).bind()),
      );
      return result({ ok: true, pricing, releases, locations });
    }
    if (input.action === "check" && env.PRISM_DEPLOY_PHASE === "verify") {
      const markers = (
        await env.DB.prepare(
          "SELECT id FROM prism_data_migrations WHERE id IN (?,?)",
        )
          .bind(utcPricingMigrationId, shopLocationTimeZoneMigrationId)
          .all()
      ).results;
      if (markers.length !== 2) {
        throw new Error("Data migrations are incomplete");
      }
      const invalid = await env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM pricing_configs WHERE kind IN ('time.priority','time.cap') AND json_extract(provider_json,'$.timeZone') IS NOT 'UTC')
        + (SELECT COUNT(*) FROM pricing_config_versions WHERE kind IN ('time.priority','time.cap') AND json_extract(provider_json,'$.timeZone') IS NOT 'UTC')
        + (SELECT COUNT(*) FROM pricing_releases WHERE time_zone!='UTC') AS n`)
        .bind()
        .first<{ n: number }>();
      // D1 .first() returns the first row object unless a column name is supplied.
      // Comparing that object directly to 0 rejects every healthy database.
      if (invalid?.n !== 0) throw new Error("UTC pricing verification failed");
      if (
        (await env.DB.prepare("PRAGMA foreign_key_check").bind().all()).results
          .length
      ) {
        throw new Error("Foreign key check failed");
      }
      const response = await health();
      if (!response.ok) throw new Error("Application health check failed");
      const body = (await response.json()) as {
        ok?: boolean;
        data?: { ok?: boolean };
      };
      if (body.data?.ok !== true && body.ok !== true) {
        throw new Error("Invalid application health response");
      }
      await deploymentBatch(env.DB, owner, [
        env.DB.prepare(
          "UPDATE prism_deployment_gate SET checked=1 WHERE id='global' AND owner_hash=?",
        ).bind(owner),
      ]);
      return result({ ok: true, checked: true });
    }
    if (input.action === "resume" && env.PRISM_DEPLOY_PHASE === "live") {
      if (!gate.checked) {
        return result(
          {
            error: "Health verification is required",
            code: "DEPLOYMENT_VERIFICATION_REQUIRED",
          },
          409,
        );
      }
      await deploymentBatch(env.DB, owner, [
        env.DB.prepare(
          "UPDATE prism_deployment_gate SET maintenance=0 WHERE id='global' AND owner_hash=? AND checked=1",
        ).bind(owner),
      ]);
      return result({ ok: true, maintenance: false });
    }
    return result(
      {
        error: "Invalid deployment phase or action",
        code: "DEPLOYMENT_PHASE_NOT_READY",
      },
      409,
    );
  } catch (error) {
    // The deploy token authenticates this endpoint; returning the specific
    // invariant that failed is what makes a red CI log actionable.
    return result(
      {
        error: error instanceof Error
          ? `Deployment step failed: ${error.message}; maintenance remains active`
          : "Deployment step failed; maintenance remains active",
      },
      500,
    );
  }
}
