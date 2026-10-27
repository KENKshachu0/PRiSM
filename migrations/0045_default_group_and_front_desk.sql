-- Billing always follows a resource group; there is no default plan.
--
-- Until now the shop's default resource group was not stored: its plan lived in
-- shop_billing_settings.entry_pricing_ids_json as "the shop's default plan",
-- which also started front-desk check-ins and other admissions without a
-- resource. The default group becomes a stored group like any other, keeping
-- that plan. Resources without a group (resource_group_id NULL) belong to it.
-- entry_pricing_ids_json is no longer read; it is cleared so nothing can
-- mistake it for a live setting.
INSERT INTO resource_groups(shop_id, id, name, enabled, default_pricing_config_id, created_at, updated_at)
SELECT
  s.id,
  'default',
  '默认资源组',
  1,
  (SELECT json_extract(b.entry_pricing_ids_json, '$[0]') FROM shop_billing_settings b WHERE b.shop_id = s.id),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM shops s
WHERE NOT EXISTS (SELECT 1 FROM resource_groups g WHERE g.shop_id = s.id AND g.id = 'default');

-- A front-desk check-in bills like any resource: the desk is one, in the default
-- group, so shops with the cashier on keep billing what their default plan did.
INSERT INTO machines(id, public_id, shop_id, name, enabled, kind, aliases_json, hinata_url_encrypted)
SELECT
  'desk-' || a.shop_id,
  lower(hex(randomblob(6))),
  a.shop_id,
  '前台',
  1, 'machine', '[]', ''
FROM app_settings a
WHERE a.key = 'cashier.settings' AND json_extract(a.value_json, '$.enabled')
  AND json_extract(a.value_json, '$.resourceId') IS NULL
  AND NOT EXISTS (SELECT 1 FROM machines m WHERE m.id = 'desk-' || a.shop_id);

UPDATE app_settings
SET value_json = json_set(value_json, '$.resourceId', 'desk-' || shop_id)
WHERE key = 'cashier.settings' AND json_extract(value_json, '$.enabled')
  AND json_extract(value_json, '$.resourceId') IS NULL
  AND EXISTS (SELECT 1 FROM machines m WHERE m.id = 'desk-' || app_settings.shop_id);

UPDATE shop_billing_settings SET entry_pricing_ids_json = '[]' WHERE entry_pricing_ids_json <> '[]';
