-- One session, one plan.
--
-- A session is started, stopped and deduplicated by the single plan it bills.
-- New sessions are refused unless `pricing_config_ids_json` names exactly one
-- plan, so its first entry is the session's plan. The column itself is kept
-- unchanged: the pricing engine reads it, shop backups carry it, and the few
-- historical rows that billed several plans keep their full list.
--
-- Production stable and beta were checked read-only on 2026-10-24: no active or
-- unpaid session billed more than one plan, and no two active sessions of one
-- player shared a plan. The guard refuses to migrate if an open multi-plan
-- session appears before this runs, instead of letting it escape the index.
CREATE TABLE migration_0039_guard (
  open_multi_plan_sessions INTEGER NOT NULL CHECK (open_multi_plan_sessions = 0)
);
INSERT INTO migration_0039_guard(open_multi_plan_sessions)
SELECT count(*) FROM sessions
WHERE json_array_length(pricing_config_ids_json) > 1
  AND (status = 'active' OR payment_status = 'unpaid');
DROP TABLE migration_0039_guard;

-- At most one active session per player and plan. The unpriced placeholder
-- (`["default"]`) and historical multi-plan rows take no part.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_active_plan
ON sessions(shop_id, player_id, json_extract(pricing_config_ids_json, '$[0]'))
WHERE status = 'active'
  AND json_array_length(pricing_config_ids_json) = 1
  AND pricing_config_ids_json != '["default"]';
