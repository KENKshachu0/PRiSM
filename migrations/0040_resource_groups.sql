-- Resources and resource groups.
--
-- A resource is anything a player scans: a machine, an air conditioner, a door,
-- a mahjong table, or a QR code on a wall with no hardware at all. It stays in
-- `machines`, so ids, public ids, printed QR codes and capability rows keep
-- working.
--
-- A resource bills one plan: its own override when set, otherwise its group's
-- default plan. Every shop also has a default group that is not stored here:
-- resources without a group belong to it, and its plan is the shop's default
-- plan (`shop_billing_settings.entry_pricing_ids_json`, at most one id), which
-- front-desk and bot admissions also start. Existing shops therefore bill
-- exactly as before until they create a group.
--
-- A group holds a default plan and nothing else about pricing: what a plan
-- requires or conflicts with stays on the plan.
CREATE TABLE IF NOT EXISTS resource_groups (
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  default_pricing_config_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, id)
);

ALTER TABLE machines ADD COLUMN resource_group_id TEXT;
ALTER TABLE machines ADD COLUMN pricing_config_override_id TEXT;

CREATE INDEX IF NOT EXISTS idx_machines_resource_group ON machines(shop_id, resource_group_id);

-- Resource groups are part of a shop backup: an export in progress holds them
-- still, and a change makes a staged import stale, as for every other table in it.
CREATE TRIGGER shop_export_resource_groups_insert BEFORE INSERT ON resource_groups
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_resource_groups_update BEFORE UPDATE ON resource_groups
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_resource_groups_delete BEFORE DELETE ON resource_groups
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_resource_groups_insert
AFTER INSERT ON resource_groups BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_resource_groups_update
AFTER UPDATE ON resource_groups BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_resource_groups_delete
AFTER DELETE ON resource_groups BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
