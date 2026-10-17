/**
 * Device capability, event, operation and state tables.
 *
 * Mirrors migration 0037 except for the `machines` foreign keys: this schema is
 * also used without the platform `machines` table (adapter-sqlite, backup
 * format inference), so the reference is enforced by the D1 migration only.
 * Capability names, event kinds and action names are validated by the
 * capability catalog in code, never by CHECK constraints.
 */
export const deviceEventSchema = [
  `CREATE TABLE IF NOT EXISTS device_capabilities (
    shop_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    secret_json TEXT NOT NULL DEFAULT '{}',
    credential_hash TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (shop_id, device_id, capability)
  )`,
  `CREATE TABLE IF NOT EXISTS device_events (
    shop_id TEXT NOT NULL,
    id TEXT NOT NULL,
    device_id TEXT,
    capability TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    operation_id TEXT,
    parent_operation_id TEXT,
    origin TEXT NOT NULL,
    player_id TEXT,
    staff_id TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    occurred_at TEXT NOT NULL,
    PRIMARY KEY (shop_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS device_operations (
    shop_id TEXT NOT NULL,
    id TEXT NOT NULL,
    device_id TEXT,
    capability TEXT NOT NULL,
    action TEXT NOT NULL,
    parent_id TEXT,
    player_id TEXT,
    staff_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed')),
    counts_as_play INTEGER NOT NULL DEFAULT 0 CHECK (counts_as_play IN (0,1)),
    failure TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    requested_at TEXT NOT NULL,
    settled_at TEXT,
    confirmed_at TEXT,
    PRIMARY KEY (shop_id, id),
    FOREIGN KEY (shop_id, player_id) REFERENCES players(shop_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS device_state (
    shop_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    authority TEXT NOT NULL CHECK (authority IN ('owned','observed','derived')),
    event_id TEXT,
    changed_at TEXT NOT NULL,
    PRIMARY KEY (shop_id, device_id, capability, key)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS device_capabilities_credential ON device_capabilities(credential_hash) WHERE credential_hash IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS device_events_device ON device_events(shop_id, device_id, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS device_events_operation ON device_events(shop_id, operation_id)`,
  `CREATE INDEX IF NOT EXISTS device_operations_player ON device_operations(shop_id, player_id, requested_at)`,
  `CREATE INDEX IF NOT EXISTS device_operations_device ON device_operations(shop_id, device_id, requested_at)`,
  `CREATE INDEX IF NOT EXISTS device_operations_action ON device_operations(shop_id, action, requested_at)`,
] as const;
