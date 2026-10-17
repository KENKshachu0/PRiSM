-- Device capabilities, events, state and operations.
--
-- A device (`machines`) now only carries identity. Each capability it has
-- (power, HINATA IO, door, mahjong) is one row in `device_capabilities`.
-- Everything that happens to a device is an immutable row in `device_events`;
-- `device_operations` (the outcome of each requested action) and `device_state`
-- (the current value of a stateful capability) are derived from those events.
--
-- Event kinds, capability names and action names are validated by the
-- capability catalog in code, not by CHECK constraints, so adding a capability
-- never rebuilds a table. Only closed lifecycles carry a CHECK.
--
-- The old `device_commands`, `device_states` and `machine_connections` tables and
-- the capability columns on `machines` are copied here and then left unwritten
-- for one release, so a rollback still finds them.

CREATE TABLE device_capabilities (
  shop_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  -- Each value is encrypted on its own, so existing ciphertext copies verbatim.
  secret_json TEXT NOT NULL DEFAULT '{}',
  -- Hash of a credential the device presents when it connects inbound.
  credential_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, device_id, capability)
);
CREATE UNIQUE INDEX device_capabilities_credential ON device_capabilities(credential_hash)
  WHERE credential_hash IS NOT NULL;

CREATE TABLE device_events (
  shop_id TEXT NOT NULL,
  id TEXT NOT NULL,
  -- NULL only for one request aimed at every device ("all").
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
);
CREATE INDEX device_events_device ON device_events(shop_id, device_id, occurred_at);
CREATE INDEX device_events_operation ON device_events(shop_id, operation_id);

CREATE TABLE device_operations (
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
);
CREATE INDEX device_operations_player ON device_operations(shop_id, player_id, requested_at);
CREATE INDEX device_operations_device ON device_operations(shop_id, device_id, requested_at);
CREATE INDEX device_operations_action ON device_operations(shop_id, action, requested_at);

CREATE TABLE device_state (
  shop_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  -- owned: the platform is the source of truth. observed: the last value seen
  -- from an external source, history only. derived: computed from events.
  authority TEXT NOT NULL CHECK (authority IN ('owned','observed','derived')),
  event_id TEXT,
  changed_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, device_id, capability, key)
);

-- History: capability columns on machines become capability rows.
INSERT INTO device_capabilities(shop_id, device_id, capability, config_json, secret_json, created_at, updated_at)
SELECT shop_id, id, 'power', '{}', json_object('binding', ha_binding_encrypted), created_at, updated_at
FROM machines WHERE ha_binding_encrypted IS NOT NULL AND ha_binding_encrypted != '';

INSERT INTO device_capabilities(shop_id, device_id, capability, config_json, secret_json, created_at, updated_at)
SELECT shop_id, id, 'hinata_io',
  json_object('transport', 'external', 'coinKey', coin_key,
    'coinAfterSwipe', json(CASE WHEN coin_after_swipe = 1 THEN 'true' ELSE 'false' END)),
  json_object('url', hinata_url_encrypted, 'password', hinata_password_encrypted),
  created_at, updated_at
FROM machines WHERE hinata_url_encrypted IS NOT NULL AND hinata_url_encrypted != '';

INSERT INTO device_capabilities(shop_id, device_id, capability, config_json, secret_json, created_at, updated_at)
SELECT shop_id, id, 'door', json_object('lockId', ttlock_lock_id), '{}', created_at, updated_at
FROM machines WHERE ttlock_lock_id IS NOT NULL;

INSERT INTO device_capabilities(shop_id, device_id, capability, config_json, secret_json, created_at, updated_at)
SELECT shop_id, id, 'mahjong', mahjong_config_json, '{}', created_at, updated_at
FROM machines WHERE mahjong_config_json IS NOT NULL AND json_valid(mahjong_config_json);

-- History: every command becomes an operation. A historic pending stays pending:
-- billing has always counted it as device use, and recalculating an issued bill
-- must give the same answer.
INSERT INTO device_operations(shop_id, id, device_id, capability, action, parent_id, player_id, staff_id,
  status, counts_as_play, failure, payload_json, requested_at, settled_at, confirmed_at)
SELECT shop_id, id, device_id,
  CASE WHEN type = 'door.open' THEN 'door'
       WHEN type IN ('power.on', 'power.off', 'ac.set_temperature') THEN 'power'
       ELSE 'hinata_io' END,
  type,
  CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.parentOperationId') END,
  player_id, staff_id,
  CASE status WHEN 'acked' THEN 'succeeded' WHEN 'pending' THEN 'pending' ELSE 'failed' END,
  CASE WHEN type = 'door.open' THEN 0 ELSE 1 END,
  CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.executorFailure.message') END,
  json_set(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,
    '$.legacyExecutor', executor_kind, '$.legacyTargetKind', target_kind),
  requested_at,
  COALESCE(acked_at, expired_at),
  NULL
FROM device_commands;

INSERT INTO device_events(shop_id, id, device_id, capability, kind, name, operation_id, parent_operation_id,
  origin, player_id, staff_id, payload_json, occurred_at)
SELECT shop_id, id || '.request', device_id, capability, 'request', action, id, parent_id,
  'platform', player_id, staff_id, payload_json, requested_at
FROM device_operations;

INSERT INTO device_events(shop_id, id, device_id, capability, kind, name, operation_id, parent_operation_id,
  origin, player_id, staff_id, payload_json, occurred_at)
SELECT shop_id, id || '.result', device_id, capability, 'result', action, id, parent_id,
  'platform', player_id, staff_id,
  json_object('outcome', CASE WHEN status = 'succeeded' THEN 'ok' ELSE 'failed' END, 'message', failure),
  COALESCE(settled_at, requested_at)
FROM device_operations WHERE status != 'pending';

-- History: power observations survive only for devices that still have power.
INSERT OR IGNORE INTO device_state(shop_id, device_id, capability, key, value_json, authority, event_id, changed_at)
SELECT s.shop_id, s.device_id, 'power', 'power', json_quote(s.state), 'observed', NULL, s.reported_at
FROM device_states s
JOIN device_capabilities c ON c.shop_id = s.shop_id AND c.device_id = s.device_id AND c.capability = 'power'
WHERE s.state IN ('on', 'off');

-- Export lock: no writes while a shop export holds its snapshot.
CREATE TRIGGER shop_export_device_capabilities_insert BEFORE INSERT ON device_capabilities
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_device_capabilities_update BEFORE UPDATE ON device_capabilities
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_device_capabilities_delete BEFORE DELETE ON device_capabilities
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_device_events_insert BEFORE INSERT ON device_events
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_device_events_update BEFORE UPDATE ON device_events
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_device_events_delete BEFORE DELETE ON device_events
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_device_operations_insert BEFORE INSERT ON device_operations
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_device_operations_update BEFORE UPDATE ON device_operations
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_device_operations_delete BEFORE DELETE ON device_operations
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_device_state_insert BEFORE INSERT ON device_state
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_device_state_update BEFORE UPDATE ON device_state
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_device_state_delete BEFORE DELETE ON device_state
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;

-- Staged imports become stale when target data changes. Device events and
-- operations are business history; capability rows are configuration. An
-- external observation that only repeats a known value never reaches here,
-- because the state row is written only when its value changes.
CREATE TRIGGER IF NOT EXISTS shop_import_target_device_capabilities_insert
AFTER INSERT ON device_capabilities BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_device_capabilities_update
AFTER UPDATE ON device_capabilities BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_device_capabilities_delete
AFTER DELETE ON device_capabilities BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_device_events_insert
AFTER INSERT ON device_events BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_device_events_update
AFTER UPDATE ON device_events BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_device_events_delete
AFTER DELETE ON device_events BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_device_operations_insert
AFTER INSERT ON device_operations BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_device_operations_update
AFTER UPDATE ON device_operations BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_device_operations_delete
AFTER DELETE ON device_operations BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_device_state_insert
AFTER INSERT ON device_state BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_device_state_update
AFTER UPDATE ON device_state BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_device_state_delete
AFTER DELETE ON device_state BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
