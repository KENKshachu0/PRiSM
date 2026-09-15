PRAGMA foreign_keys = OFF;

CREATE TABLE asset_holdings_int (
  shop_id TEXT NOT NULL DEFAULT 'legacy',
  id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  asset_code TEXT NOT NULL,
  quantity INTEGER NOT NULL,
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
       ROUND(quantity * 100),
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
  delta INTEGER NOT NULL,
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
       ROUND(delta * 100),
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
  subtotal INTEGER NOT NULL,
  total INTEGER NOT NULL,
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
  subtotal INTEGER NOT NULL,
  total INTEGER NOT NULL,
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
  amount INTEGER NOT NULL,
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
  amount INTEGER NOT NULL,
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
  amount INTEGER NOT NULL,
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
  amount INTEGER NOT NULL,
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
  value INTEGER,
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
       CASE WHEN type IN ('discount','surcharge') THEN ROUND(value * 100) ELSE value END,
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
  price INTEGER NOT NULL,
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
  price INTEGER NOT NULL,
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

-- Convert every money column from REAL yuan to INTEGER fen.
--
-- Runs after 0013/0016/etc., so the rebuilt tables keep their shop_id column
-- and composite primary keys. Coordinates (shops.*, machine_login_events.*)
-- are deliberately left as REAL. pricing_effects.value is scaled only for the
-- money-typed effects; percentage-discount rows carry a percent, not yuan.


PRAGMA foreign_keys = ON;
