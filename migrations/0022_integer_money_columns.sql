-- D1 keeps foreign keys enabled. Defer checks until every replacement table exists.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE asset_holdings_int (
  shop_id TEXT NOT NULL DEFAULT 'legacy',
  id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  asset_code TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer'),
  active_at TEXT,
  expires_at TEXT,
  FOREIGN KEY (shop_id, player_id) REFERENCES players(shop_id, id),
  FOREIGN KEY (shop_id, asset_type, asset_code) REFERENCES asset_definitions(shop_id, type, code),
  PRIMARY KEY (shop_id, id)
);

INSERT INTO asset_holdings_int (shop_id, id, player_id, asset_type, asset_code, quantity, active_at, expires_at)
  SELECT shop_id,
       id,
       player_id,
       asset_type,
       asset_code,
       CASE WHEN asset_type = 'currency' THEN ROUND(quantity * 100) ELSE ROUND(quantity) END,
       active_at,
       expires_at
  FROM asset_holdings;

DROP TABLE asset_holdings;

ALTER TABLE asset_holdings_int RENAME TO asset_holdings;

CREATE TABLE asset_ledger_entries_int (
  shop_id TEXT NOT NULL DEFAULT 'legacy',
  id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  transaction_id TEXT,
  asset_type TEXT NOT NULL,
  asset_code TEXT NOT NULL,
  delta INTEGER NOT NULL CHECK (typeof(delta) = 'integer'),
  reason TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (shop_id, player_id) REFERENCES players(shop_id, id),
  FOREIGN KEY (shop_id, transaction_id) REFERENCES asset_transactions(shop_id, id),
  FOREIGN KEY (shop_id, asset_type, asset_code) REFERENCES asset_definitions(shop_id, type, code),
  PRIMARY KEY (shop_id, id)
);

INSERT INTO asset_ledger_entries_int (shop_id, id, player_id, transaction_id, asset_type, asset_code, delta, reason, ref_id, created_at)
  SELECT shop_id,
       id,
       player_id,
       transaction_id,
       asset_type,
       asset_code,
       CASE WHEN asset_type = 'currency' THEN ROUND(delta * 100) ELSE ROUND(delta) END,
       reason,
       ref_id,
       created_at
  FROM asset_ledger_entries;

DROP TABLE asset_ledger_entries;

ALTER TABLE asset_ledger_entries_int RENAME TO asset_ledger_entries;

CREATE TABLE player_checkouts_int (
  shop_id TEXT NOT NULL DEFAULT 'legacy',
  id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  subtotal INTEGER NOT NULL CHECK (typeof(subtotal) = 'integer'),
  total INTEGER NOT NULL CHECK (typeof(total) = 'integer'),
  status TEXT NOT NULL CHECK (status IN ('settled')),
  settled_at TEXT NOT NULL,
  FOREIGN KEY (shop_id, player_id) REFERENCES players(shop_id, id),
  PRIMARY KEY (shop_id, id)
);

INSERT INTO player_checkouts_int (shop_id, id, player_id, subtotal, total, status, settled_at)
  SELECT shop_id,
       id,
       player_id,
       ROUND(subtotal * 100),
       ROUND(total * 100),
       status,
       settled_at
  FROM player_checkouts;

DROP TABLE player_checkouts;

ALTER TABLE player_checkouts_int RENAME TO player_checkouts;

CREATE TABLE settlements_int (
  shop_id TEXT NOT NULL DEFAULT 'legacy',
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  checkout_id TEXT,
  subtotal INTEGER NOT NULL CHECK (typeof(subtotal) = 'integer'),
  total INTEGER NOT NULL CHECK (typeof(total) = 'integer'),
  status TEXT NOT NULL CHECK (status IN ('settled')),
  settled_at TEXT NOT NULL,
  FOREIGN KEY (shop_id, session_id) REFERENCES sessions(shop_id, id),
  FOREIGN KEY (shop_id, checkout_id) REFERENCES player_checkouts(shop_id, id),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, session_id)
);

INSERT INTO settlements_int (shop_id, id, session_id, checkout_id, subtotal, total, status, settled_at)
  SELECT shop_id,
       id,
       session_id,
       checkout_id,
       ROUND(subtotal * 100),
       ROUND(total * 100),
       status,
       settled_at
  FROM settlements;

DROP TABLE settlements;

ALTER TABLE settlements_int RENAME TO settlements;

CREATE TABLE settlement_charge_items_int (
  shop_id TEXT NOT NULL DEFAULT 'legacy',
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  item_order INTEGER NOT NULL,
  source TEXT NOT NULL,
  label TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer'),
  PRIMARY KEY (shop_id, session_id, id),
  FOREIGN KEY (shop_id, session_id) REFERENCES sessions(shop_id, id)
);

INSERT INTO settlement_charge_items_int (shop_id, id, session_id, item_order, source, label, amount)
  SELECT shop_id,
       id,
       session_id,
       item_order,
       source,
       label,
       ROUND(amount * 100)
  FROM settlement_charge_items;

DROP TABLE settlement_charge_items;

ALTER TABLE settlement_charge_items_int RENAME TO settlement_charge_items;

CREATE TABLE settlement_adjustments_int (
  shop_id TEXT NOT NULL DEFAULT 'legacy',
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  adjustment_order INTEGER NOT NULL,
  source TEXT NOT NULL,
  label TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer'),
  PRIMARY KEY (shop_id, session_id, id),
  FOREIGN KEY (shop_id, session_id) REFERENCES sessions(shop_id, id)
);

INSERT INTO settlement_adjustments_int (shop_id, id, session_id, adjustment_order, source, label, amount)
  SELECT shop_id,
       id,
       session_id,
       adjustment_order,
       source,
       label,
       ROUND(amount * 100)
  FROM settlement_adjustments;

DROP TABLE settlement_adjustments;

ALTER TABLE settlement_adjustments_int RENAME TO settlement_adjustments;

CREATE TABLE pricing_history_entries_int (
  shop_id TEXT NOT NULL DEFAULT 'legacy',
  id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  pricing_config_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rule_anchor_at TEXT NOT NULL,
  session_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer'),
  created_at TEXT NOT NULL,
  metadata_json TEXT,
  FOREIGN KEY (shop_id, player_id) REFERENCES players(shop_id, id),
  PRIMARY KEY (shop_id, id)
);

INSERT INTO pricing_history_entries_int (shop_id, id, player_id, pricing_config_id, provider_id, rule_id, rule_anchor_at, session_id, amount, created_at, metadata_json)
  SELECT shop_id,
       id,
       player_id,
       pricing_config_id,
       provider_id,
       rule_id,
       rule_anchor_at,
       session_id,
       ROUND(amount * 100),
       created_at,
       metadata_json
  FROM pricing_history_entries;

DROP TABLE pricing_history_entries;

ALTER TABLE pricing_history_entries_int RENAME TO pricing_history_entries;

CREATE TABLE pricing_cap_history_entries_int (
  shop_id TEXT NOT NULL DEFAULT 'legacy',
  id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  cap_config_id TEXT NOT NULL,
  cap_rule_id TEXT NOT NULL,
  cap_anchor_at TEXT NOT NULL,
  included_pricing_config_ids_json TEXT NOT NULL,
  session_ids_json TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer'),
  created_at TEXT NOT NULL,
  metadata_json TEXT,
  FOREIGN KEY (shop_id, player_id) REFERENCES players(shop_id, id),
  PRIMARY KEY (shop_id, id)
);

INSERT INTO pricing_cap_history_entries_int (shop_id, id, player_id, cap_config_id, cap_rule_id, cap_anchor_at, included_pricing_config_ids_json, session_ids_json, amount, created_at, metadata_json)
  SELECT shop_id,
       id,
       player_id,
       cap_config_id,
       cap_rule_id,
       cap_anchor_at,
       included_pricing_config_ids_json,
       session_ids_json,
       ROUND(amount * 100),
       created_at,
       metadata_json
  FROM pricing_cap_history_entries;

DROP TABLE pricing_cap_history_entries;

ALTER TABLE pricing_cap_history_entries_int RENAME TO pricing_cap_history_entries;

CREATE TABLE pricing_effects_int (
  shop_id TEXT NOT NULL DEFAULT 'legacy',
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('free', 'discount', 'percentage-discount', 'surcharge')),
  scope TEXT NOT NULL CHECK (scope IN ('session', 'unified')),
  value INTEGER CHECK (value IS NULL OR typeof(value) = 'integer'),
  consumable INTEGER NOT NULL DEFAULT 0 CHECK (consumable IN (0, 1)),
  limit_per_day INTEGER,
  active_at TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  config_json TEXT,
  PRIMARY KEY (shop_id, id)
);

INSERT INTO pricing_effects_int (shop_id, id, name, type, scope, value, consumable, limit_per_day, active_at, expires_at, status, config_json)
  SELECT shop_id,
       id,
       name,
       type,
       scope,
       ROUND(value * 100),
       consumable,
       limit_per_day,
       active_at,
       expires_at,
       status,
       config_json
  FROM pricing_effects;

DROP TABLE pricing_effects;

ALTER TABLE pricing_effects_int RENAME TO pricing_effects;

CREATE TABLE business_items_int (
  shop_id TEXT NOT NULL DEFAULT 'legacy',
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  price INTEGER NOT NULL CHECK (typeof(price) = 'integer'),
  asset_type TEXT,
  asset_code TEXT,
  active_at TEXT,
  expires_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, id)
);

INSERT INTO business_items_int (shop_id, id, kind, name, status, price, asset_type, asset_code, active_at, expires_at, metadata_json, created_at, updated_at)
  SELECT shop_id,
       id,
       kind,
       name,
       status,
       ROUND(price * 100),
       asset_type,
       asset_code,
       active_at,
       expires_at,
       metadata_json,
       created_at,
       updated_at
  FROM business_items;

DROP TABLE business_items;

ALTER TABLE business_items_int RENAME TO business_items;

CREATE TABLE business_item_orders_int (
  shop_id TEXT NOT NULL DEFAULT 'legacy',
  id TEXT NOT NULL,
  business_item_id TEXT NOT NULL,
  business_item_kind TEXT NOT NULL,
  business_item_name TEXT NOT NULL,
  player_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('paid', 'fulfilled', 'cancelled')),
  price INTEGER NOT NULL CHECK (typeof(price) = 'integer'),
  asset_type TEXT,
  asset_code TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  fulfilled_at TEXT,
  cancelled_at TEXT,
  FOREIGN KEY (shop_id, business_item_id) REFERENCES business_items(shop_id, id),
  FOREIGN KEY (shop_id, player_id) REFERENCES players(shop_id, id),
  FOREIGN KEY (shop_id, session_id) REFERENCES sessions(shop_id, id),
  PRIMARY KEY (shop_id, id)
);

INSERT INTO business_item_orders_int (shop_id, id, business_item_id, business_item_kind, business_item_name, player_id, session_id, status, price, asset_type, asset_code, metadata_json, created_at, updated_at, fulfilled_at, cancelled_at)
  SELECT shop_id,
       id,
       business_item_id,
       business_item_kind,
       business_item_name,
       player_id,
       session_id,
       status,
       ROUND(price * 100),
       asset_type,
       asset_code,
       metadata_json,
       created_at,
       updated_at,
       fulfilled_at,
       cancelled_at
  FROM business_item_orders;

DROP TABLE business_item_orders;

ALTER TABLE business_item_orders_int RENAME TO business_item_orders;

-- Configuration money also uses integer fen, percentages use integer basis points.
UPDATE pricing_configs
SET provider_json = json_set(provider_json, '$.amount', CAST(ROUND(json_extract(provider_json, '$.amount') * 100) AS INTEGER))
WHERE kind = 'charge.fixed';

UPDATE pricing_configs
SET provider_json = json_set(provider_json, '$.rules', json((
  SELECT json_group_array(json_set(value,
    '$.pricing.unitPrice', CAST(ROUND(json_extract(value, '$.pricing.unitPrice') * 100) AS INTEGER),
    '$.pricing.priceCap', CAST(ROUND(json_extract(value, '$.pricing.priceCap') * 100) AS INTEGER)))
  FROM json_each(provider_json, '$.rules')
))) WHERE kind = 'time.priority';

UPDATE pricing_configs
SET provider_json = json_set(provider_json, '$.rules', json((
  SELECT json_group_array(json_set(value, '$.priceCap', CAST(ROUND(json_extract(value, '$.priceCap') * 100) AS INTEGER)))
  FROM json_each(provider_json, '$.rules')
))) WHERE kind = 'time.cap';

UPDATE pricing_configs
SET provider_json = json_set(provider_json, '$.paidHistory', json((
  SELECT json_group_object(key, CAST(ROUND(value * 100) AS INTEGER))
  FROM json_each(provider_json, '$.paidHistory')
))) WHERE json_type(provider_json, '$.paidHistory') = 'object';

UPDATE pricing_effects
SET config_json = json_set(config_json, '$.minSubtotal', CAST(ROUND(json_extract(config_json, '$.minSubtotal') * 100) AS INTEGER))
WHERE json_type(config_json, '$.minSubtotal') IN ('integer', 'real');

UPDATE presents SET grants_json = (
  SELECT json_group_array(json_set(value, '$.amount', CAST(ROUND(
    json_extract(value, '$.amount') * CASE WHEN json_extract(value, '$.assetType') = 'currency' THEN 100 ELSE 1 END
  ) AS INTEGER))) FROM json_each(grants_json)
);

CREATE INDEX idx_asset_holdings_player ON asset_holdings(shop_id, player_id);
CREATE INDEX idx_asset_ledger_player_created ON asset_ledger_entries(shop_id, player_id, created_at);
CREATE INDEX idx_player_checkouts_player_settled ON player_checkouts(shop_id, player_id, settled_at);
CREATE INDEX idx_settlements_checkout ON settlements(shop_id, checkout_id);
CREATE INDEX idx_business_items_status_updated ON business_items(shop_id, status, updated_at);
CREATE INDEX idx_business_items_kind_status ON business_items(shop_id, kind, status);
CREATE INDEX idx_business_item_orders_player_created ON business_item_orders(shop_id, player_id, created_at);
CREATE INDEX idx_business_item_orders_item_status ON business_item_orders(shop_id, business_item_id, status);
CREATE INDEX idx_settlement_charge_items_session_order ON settlement_charge_items(shop_id, session_id, item_order);
CREATE INDEX idx_settlement_adjustments_session_order ON settlement_adjustments(shop_id, session_id, adjustment_order);
CREATE INDEX idx_pricing_history_player_rule_anchor ON pricing_history_entries(shop_id, player_id, pricing_config_id, provider_id, rule_id, rule_anchor_at);
CREATE INDEX idx_pricing_history_session ON pricing_history_entries(shop_id, session_id);
CREATE INDEX idx_pricing_cap_history_player_rule_anchor ON pricing_cap_history_entries(shop_id, player_id, cap_config_id, cap_rule_id, cap_anchor_at);

PRAGMA defer_foreign_keys = OFF;
