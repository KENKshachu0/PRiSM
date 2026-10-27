import { Database } from "bun:sqlite";
import type {
  D1BoundStatementLike,
  D1DatabaseLike,
  D1PreparedStatementLike,
  SqlValue,
} from "@prism/adapter-d1";
import {
  serializePricingProviderConfig,
  sqliteSchema,
} from "@prism/storage-sql";
import type { AppBindings, Env, TenantShop } from "./bindings.js";
import app from "./app.js";

export const SHOP_QUERY = `SELECT s.id, s.public_id, s.name, s.latitude, s.longitude, s.radius_meters,
  COALESCE(b.auto_register, 0) AS auto_register,
  COALESCE(b.identity_binding_required, 1) AS identity_binding_required,
  COALESCE((SELECT json_extract(value_json, '$.enabled') FROM app_settings WHERE shop_id = s.id AND key = 'cashier.settings'), 0) AS cashier_enabled,
  COALESCE(b.checkin_geo, 0) AS checkin_geo,
  COALESCE(b.checkout_geo, 0) AS checkout_geo,
  COALESCE(b.machine_geo, 0) AS machine_geo,
  COALESCE(b.bot_contact, '') AS bot_contact,
  CASE WHEN s.hero_data IS NULL OR s.hero_data = '' THEN NULL ELSE '/api/v1/shops/' || s.public_id || '/hero?v=' || COALESCE(s.hero_hash, 'original') END AS hero_url,
  COALESCE((SELECT json_extract(value_json, '$.timeZone') FROM app_settings WHERE shop_id = s.id AND key = 'store.profile'), 'Asia/Shanghai') AS time_zone
FROM shops s
LEFT JOIN shop_billing_settings b ON b.shop_id = s.id`;

export const platformSchema = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL DEFAULT 'user',
    banned_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS auth_identities (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_subject TEXT NOT NULL,
    username TEXT,
    display_name TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TEXT,
    UNIQUE(provider, provider_subject),
    UNIQUE(user_id, provider)
  )`,
  `CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS auth_challenges (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    purpose TEXT NOT NULL,
    challenge TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS passkeys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    device_type TEXT NOT NULL DEFAULT 'platform',
    backed_up INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT 'Passkey',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TEXT,
    aaguid TEXT,
    provider_name TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS shops (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    radius_meters INTEGER NOT NULL DEFAULT 80,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    public_id TEXT UNIQUE,
    hero_data TEXT,
    hero_hash TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS shop_members (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'owner',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(shop_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS shop_billing_settings (
    shop_id TEXT PRIMARY KEY REFERENCES shops(id),
    billing_enabled INTEGER NOT NULL DEFAULT 0 CHECK(billing_enabled IN (0,1)),
    auto_register INTEGER NOT NULL DEFAULT 0 CHECK(auto_register IN (0,1)),
    identity_binding_required INTEGER NOT NULL DEFAULT 1 CHECK(identity_binding_required IN (0,1)),
    checkin_geo INTEGER NOT NULL DEFAULT 0 CHECK(checkin_geo IN (0,1)),
    checkout_geo INTEGER NOT NULL DEFAULT 0 CHECK(checkout_geo IN (0,1)),
    machine_geo INTEGER NOT NULL DEFAULT 0 CHECK(machine_geo IN (0,1)),
    entry_pricing_ids_json TEXT NOT NULL DEFAULT '[]',
    bot_contact TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS shop_staff_accounts (
    shop_id TEXT NOT NULL REFERENCES shops(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    staff_id TEXT NOT NULL,
    PRIMARY KEY(shop_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS shop_player_accounts (
    shop_id TEXT NOT NULL REFERENCES shops(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    player_id TEXT NOT NULL,
    verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(shop_id, user_id),
    UNIQUE(shop_id, player_id)
  )`,
  `CREATE TABLE IF NOT EXISTS shop_platform_bindings (
    shop_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(shop_id, provider, subject),
    UNIQUE(shop_id, user_id, provider)
  )`,
  `CREATE TABLE IF NOT EXISTS platform_binding_codes (
    shop_id TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    user_id TEXT,
    code_hash TEXT,
    expires_at TEXT,
    created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    hinata_url_encrypted TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    kind TEXT NOT NULL DEFAULT 'machine',
    aliases_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    hinata_password_encrypted TEXT,
    resource_group_id TEXT,
    pricing_config_override_id TEXT,
    capacity INTEGER NOT NULL DEFAULT 0,
    occupancy_minutes INTEGER NOT NULL DEFAULT 15
  )`,
  `CREATE TABLE IF NOT EXISTS mahjong_seats (
    shop_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    entry_session_id TEXT,
    entry_owned INTEGER NOT NULL DEFAULT 0,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (shop_id, player_id),
    UNIQUE (shop_id, session_id)
  )`,
  `CREATE TABLE IF NOT EXISTS resource_groups (
    shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    default_pricing_config_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (shop_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS machine_tickets (
    id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL,
    expires_at TEXT,
    claimed_by TEXT,
    claimed_at TEXT,
    operation_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS machine_login_events (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    card_id TEXT,
    machine_id TEXT,
    ip TEXT,
    latitude REAL,
    longitude REAL,
    accuracy REAL,
    distance_meters REAL,
    risk_result TEXT NOT NULL DEFAULT 'allow',
    result TEXT NOT NULL DEFAULT 'success',
    response_code INTEGER,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS bans (
    id TEXT PRIMARY KEY,
    subject_type TEXT NOT NULL,
    subject_value TEXT NOT NULL,
    reason TEXT NOT NULL,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    card_type TEXT NOT NULL DEFAULT 'aime',
    access_code TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    disabled_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, access_code)
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_credentials (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS player_operations (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS qq_binding_codes (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS prism_deployment_gate (
    id TEXT PRIMARY KEY CHECK(id='global'),
    owner_hash TEXT NOT NULL,
    maintenance INTEGER NOT NULL CHECK(maintenance IN (0,1)),
    permit INTEGER NOT NULL DEFAULT 0 CHECK(permit IN (0,1)),
    checked INTEGER NOT NULL DEFAULT 0 CHECK(checked IN (0,1)),
    updated_at INTEGER NOT NULL
  )`,
] as const;

export type SqliteD1PreparedStatement = D1PreparedStatementLike & D1BoundStatementLike;
export type SqliteD1Database = D1DatabaseLike & {
  prepare(sql: string): SqliteD1PreparedStatement;
};

export function createD1DatabaseFromSqlite(db: Database): SqliteD1Database {
  return {
    prepare(sql: string): SqliteD1PreparedStatement {
      type LocalBatchResult = {
        results: unknown[];
        success: true;
        meta: { changes: number };
      };
      type LocalBoundStatement = D1BoundStatementLike & {
        executeBatch(): Promise<LocalBatchResult>;
      };
      const createStatement = (...values: SqlValue[]): LocalBoundStatement => ({
        async first<T = unknown>() {
          return (db.query(sql).get(...values) as T | null) ?? null;
        },
        async all<T = unknown>() {
          return { results: db.query(sql).all(...values) as T[] };
        },
        async run() {
          const result = db.query(sql).run(...values);
          return { success: true, meta: { changes: result.changes } };
        },
        async executeBatch() {
          // Cloudflare D1 returns rows for SELECT/RETURNING statements inside a batch;
          // a plain .run() silently discards those rows and breaks shop-data exports.
          const returnsRows = /^(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql.trim())
            || /\bRETURNING\b/i.test(sql);
          if (returnsRows) {
            const results = db.query(sql).all(...values) as unknown[];
            const changed = /\bRETURNING\b/i.test(sql)
              ? (db.query("SELECT changes() AS changes").get() as { changes: number } | null)?.changes ?? 0
              : 0;
            return { results, success: true as const, meta: { changes: changed } };
          }
          const result = db.query(sql).run(...values);
          return { results: [], success: true as const, meta: { changes: result.changes } };
        },
      });

      return {
        ...createStatement(),
        bind(...values: SqlValue[]) {
          return createStatement(...values);
        },
      };
    },

    async batch(statements: readonly D1BoundStatementLike[]) {
      if (statements.length === 0) return [];
      const needsTransaction = !db.inTransaction;
      if (needsTransaction) {
        db.run("BEGIN");
      }
      try {
        const results: unknown[] = [];
        for (const statement of statements) {
          const local = statement as D1BoundStatementLike & {
            executeBatch?: () => Promise<unknown>;
          };
          results.push(local.executeBatch ? await local.executeBatch() : await statement.run());
        }
        if (needsTransaction) {
          db.run("COMMIT");
        }
        return results;
      } catch (error) {
        if (needsTransaction) {
          try {
            db.run("ROLLBACK");
          } catch {}
        }
        throw error;
      }
    },
  };
}

export function initializeLocalDatabase(
  db: Database,
  defaultShopCode = "default",
): void {
  db.run("PRAGMA foreign_keys = OFF;");

  for (const statement of sqliteSchema) {
    db.run(statement);
  }

  for (const statement of platformSchema) {
    db.run(statement);
  }
  const seatOwned = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('mahjong_seats') WHERE name = 'entry_owned'").get();
  if (!seatOwned) db.run("ALTER TABLE mahjong_seats ADD COLUMN entry_owned INTEGER NOT NULL DEFAULT 0");
  // A local database created before resource groups or occupancy lacks their columns.
  for (const [column, type] of [
    ["resource_group_id", "TEXT"],
    ["pricing_config_override_id", "TEXT"],
    ["capacity", "INTEGER NOT NULL DEFAULT 0"],
    ["occupancy_minutes", "INTEGER NOT NULL DEFAULT 15"],
  ] as const) {
    const exists = db
      .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info('machines') WHERE name = ?")
      .get(column);
    if (!exists) db.run(`ALTER TABLE machines ADD COLUMN ${column} ${type}`);
  }

  db.run("PRAGMA foreign_keys = ON;");

  const now = new Date().toISOString();

  // 1. Ensure default platform admin user
  const adminRow = db
    .query<{ id: string }, []>(
      "SELECT id FROM users WHERE role = 'admin' LIMIT 1;",
    )
    .get();
  let adminId = adminRow?.id;

  if (!adminId) {
    adminId = "admin";
    db.run(
      "INSERT INTO users (id, role, created_at, updated_at) VALUES (?, 'admin', ?, ?) ON CONFLICT(id) DO NOTHING;",
      [adminId, now, now],
    );
    // Internal bootstrap record, not a login identity. No local platform identity
    // is provisioned; user-facing admin authentication requires MuNET / Passkey.
  }

  // 2. Ensure default shop
  const shopRow = db
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM shops WHERE public_id = ? OR id = ? LIMIT 1;",
    )
    .get(defaultShopCode, defaultShopCode);

  if (!shopRow) {
    const shopId = defaultShopCode;
    db.run(
      "INSERT INTO shops (id, public_id, name, latitude, longitude, radius_meters, created_by, created_at, updated_at) VALUES (?, ?, 'Default Shop', 31.23, 121.47, 100, ?, ?, ?);",
      [shopId, defaultShopCode, adminId, now, now],
    );
    db.run(
      "INSERT INTO shop_members (id, shop_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?) ON CONFLICT(id) DO NOTHING;",
      [crypto.randomUUID(), shopId, adminId, now],
    );
    db.run(
      "INSERT INTO staff_users (shop_id, id, username, display_name, password_hash, password_salt, role, status, created_at, updated_at) VALUES (?, 'admin', 'admin', 'Administrator', '', '', 'owner', 'active', ?, ?) ON CONFLICT(shop_id, id) DO NOTHING;",
      [shopId, now, now],
    );
    db.run(
      "INSERT INTO shop_staff_accounts (shop_id, user_id, staff_id) VALUES (?, ?, 'admin') ON CONFLICT(shop_id, user_id) DO NOTHING;",
      [shopId, adminId],
    );

    // 3. Billing setup for default shop
    const ruleId = crypto.randomUUID();
    db.run(
      "INSERT INTO asset_definitions(shop_id, type, code, name, stackable, status) VALUES (?, 'currency', 'paid', '默认充值余额', 1, 'active') ON CONFLICT(shop_id, type, code) DO NOTHING;",
      [shopId],
    );
    db.run(
      "INSERT INTO asset_definitions(shop_id, type, code, name, stackable, status) VALUES (?, 'currency', 'free', '默认赠送余额', 1, 'active') ON CONFLICT(shop_id, type, code) DO NOTHING;",
      [shopId],
    );
    db.run(
      "INSERT INTO pricing_configs(shop_id, id, kind, name, enabled, status, provider_json, created_at, updated_at) VALUES (?, ?, 'time.priority', '标准入场', 1, 'active', ?, ?, ?);",
      [
        shopId,
        ruleId,
        JSON.stringify(
          serializePricingProviderConfig({
            id: ruleId,
            rules: [
              {
                id: crypto.randomUUID(),
                label: "全天",
                priority: 0,
                timeRange: { start: "00:00", end: "00:00" },
                pricing: {
                  unitMinutes: 60,
                  unitPrice: 3000,
                  roundGraceMinutes: 5,
                  priceCap: 18000,
                },
              },
            ],
          }),
        ),
        now,
        now,
      ],
    );
    db.run(
      `INSERT INTO shop_billing_settings(shop_id, auto_register, identity_binding_required, checkin_geo, checkout_geo, machine_geo, bot_contact)
       VALUES (?, 1, 0, 0, 0, 0, '')
       ON CONFLICT(shop_id) DO UPDATE SET auto_register = excluded.auto_register;`,
      [shopId],
    );
    // The seeded plan bills the default group, where every resource starts out.
    db.run(
      `INSERT INTO resource_groups(shop_id, id, name, enabled, default_pricing_config_id, created_at, updated_at)
       VALUES (?, 'default', '默认资源组', 1, ?, ?, ?)
       ON CONFLICT(shop_id, id) DO UPDATE SET default_pricing_config_id = excluded.default_pricing_config_id;`,
      [shopId, ruleId, now, now],
    );
    db.run(
      `INSERT INTO app_settings(shop_id, key, value_json, updated_at)
       VALUES (?, 'store.profile', ?, ?)
       ON CONFLICT(shop_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at;`,
      [
        shopId,
        JSON.stringify({ name: "Default Shop", timeZone: "Asia/Shanghai" }),
        now,
      ],
    );
  }
}

export const initializeSqliteSchema = initializeLocalDatabase;

export type CreateLocalServerOptions = {
  db?: Database;
  databasePath?: string;
  port?: number;
  hostname?: string;
  defaultShopCode?: string;
  env?: Partial<Env>;
};

export type LocalServer = ReturnType<typeof Bun.serve<undefined>> & {
  db: Database;
  env: Env;
};

export function createLocalServer(
  options: CreateLocalServerOptions = {},
): LocalServer {
  const databasePath =
    options.databasePath ?? process.env.PRISM_SQLITE_PATH ?? "./prism.sqlite";
  const db = options.db ?? new Database(databasePath);
  const defaultShopCode = options.defaultShopCode ?? "default";

  initializeLocalDatabase(db, defaultShopCode);

  const d1 = createD1DatabaseFromSqlite(db);
  const port =
    options.port !== undefined
      ? options.port
      : Number.parseInt(process.env.PORT ?? "8787", 10);
  const appOrigin = options.env?.APP_ORIGIN ?? `http://localhost:${port}`;

  const env: Env = {
    DB: d1,
    APP_ORIGIN: appOrigin,
    PRISM_SQLITE_PATH: databasePath,
    ...options.env,
  };

  // Device software connects through the embedded relay on the Worker; this
  // local runtime only serves the HTTP API.
  const server = Bun.serve({
    port,
    hostname: options.hostname,
    fetch(request) {
      return app.fetch(request, env);
    },
  });

  return Object.assign(server, { db, env });
}
