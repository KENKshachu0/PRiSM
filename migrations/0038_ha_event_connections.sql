-- Which Home Assistant connections are watched right now.
--
-- A row means a HINATA IO is subscribed to that connection, has delivered its
-- full state and is still alive, so `device_state` for the devices bound to it
-- is current and may be read without asking Home Assistant. No row means
-- nothing is watching: the device has no known state and a reader asks Home
-- Assistant itself. Only the shop hub writes this table, and only when a
-- connection starts or stops being watched.
CREATE TABLE IF NOT EXISTS ha_event_connections (
  shop_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  since TEXT NOT NULL,
  PRIMARY KEY (shop_id, connection_id)
);
