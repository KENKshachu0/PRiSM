-- Who occupies a resource, and how many it holds.
--
-- `capacity` is how many people can use a resource at once: 0 for one nobody
-- occupies (an air conditioner, a door, a bot), 1 for a cabinet, 2 for a game
-- two play from one entrance, a mahjong table’s size.
-- `occupancy_minutes` is how long someone is taken to stay after the last sign
-- of them, set per game.
ALTER TABLE machines ADD COLUMN capacity INTEGER NOT NULL DEFAULT 0 CHECK (capacity BETWEEN 0 AND 16);
ALTER TABLE machines ADD COLUMN occupancy_minutes INTEGER NOT NULL DEFAULT 15 CHECK (occupancy_minutes BETWEEN 1 AND 1440);

UPDATE machines SET capacity = 1
WHERE EXISTS (
  SELECT 1 FROM device_capabilities c
  WHERE c.shop_id = machines.shop_id AND c.device_id = machines.id AND c.capability = 'hinata_io'
);

-- A mahjong table seats its table size, which used to be kept in the mahjong
-- capability.
UPDATE machines SET capacity = (
  SELECT json_extract(c.config_json, '$.capacity') FROM device_capabilities c
  WHERE c.shop_id = machines.shop_id AND c.device_id = machines.id AND c.capability = 'mahjong'
)
WHERE EXISTS (
  SELECT 1 FROM device_capabilities c
  WHERE c.shop_id = machines.shop_id AND c.device_id = machines.id AND c.capability = 'mahjong'
    AND json_type(c.config_json, '$.capacity') = 'integer'
);

-- One stretch of a player occupying a resource. Only known players occupy:
-- a card nobody bound here tells nothing. An open row with `expires_at` in the
-- past ended then, by timeout.
CREATE TABLE IF NOT EXISTS resource_occupancies (
  shop_id TEXT NOT NULL,
  id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  -- The capability that reported it, e.g. hinata_io or mahjong.
  source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  -- Null while its source ends it explicitly (a mahjong seat).
  expires_at TEXT,
  ended_at TEXT,
  -- timeout, replaced, left or billing_ended.
  end_reason TEXT,
  -- Sessions a seat depends on, to date its end when billing closes them.
  session_ids_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (shop_id, id)
);
CREATE INDEX IF NOT EXISTS resource_occupancies_open ON resource_occupancies(shop_id, resource_id, ended_at);
CREATE INDEX IF NOT EXISTS resource_occupancies_history ON resource_occupancies(shop_id, resource_id, started_at);
CREATE INDEX IF NOT EXISTS resource_occupancies_player ON resource_occupancies(shop_id, player_id, ended_at);

-- Whether the seat’s waiting session (the table’s own plan) was started for
-- this table, on its page or by sitting down. Getting up ends that session only
-- then, a plan the player was already billing elsewhere keeps running.
ALTER TABLE mahjong_seats ADD COLUMN entry_owned INTEGER NOT NULL DEFAULT 0;
