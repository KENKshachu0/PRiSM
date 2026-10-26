-- A player’s cards at one shop. A card is kept only as a keyed hash, to
-- recognise it when a machine reports it, and encrypted, to send it to a
-- machine for the player. Neither reveals the card number to the shop: the key
-- is the platform’s. A card is added here when the player swipes it through a
-- shop’s QR page or adds it at one of the shop’s readers.
CREATE TABLE IF NOT EXISTS player_cards (
  shop_id TEXT NOT NULL,
  id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  card_hash TEXT NOT NULL,
  card_encrypted TEXT NOT NULL,
  card_type TEXT NOT NULL,
  -- scan: swiped through a QR page, reader: added at a reader, legacy: an old plaintext identity.
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, card_hash)
);
CREATE INDEX IF NOT EXISTS player_cards_player ON player_cards(shop_id, player_id, last_used_at);

-- Card numbers never belong in the device log. Card reports used to be stored
-- as the IO sent them.
UPDATE device_events
SET payload_json = json_remove(payload_json, '$.card.card', '$.previous_card.card')
WHERE name IN ('card.state', 'card.consumed') AND json_valid(payload_json);

-- Replacing a shop from an import clears its card bindings, so a card bound
-- after an import was staged makes that import stale and needs confirming again.
CREATE TRIGGER IF NOT EXISTS shop_import_target_player_cards_insert
AFTER INSERT ON player_cards BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_player_cards_update
AFTER UPDATE ON player_cards BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_player_cards_delete
AFTER DELETE ON player_cards BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
