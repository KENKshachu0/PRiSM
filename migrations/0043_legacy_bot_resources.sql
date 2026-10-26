-- Legacy bot integrations become bot resources in their shop's default group.
--
-- Before bots were resources, a shop's bot credential was a row in `api_tokens`
-- with no resource behind it; the platform then made one the first time the bot
-- connected. That made a bot appear only after it had connected, and left a
-- rotation able to attach to a different resource than the shop saw. Each active
-- integration credential now gets its bot resource up front, in the default
-- resource group, keeping the credential (so a running bot does not disconnect).
--
-- The id is derived from the credential so re-running cannot duplicate it, and
-- the insert leaves any shop that already has bot resources alone unless the
-- credential is not the one a bot resource names.
INSERT INTO machines(id, public_id, shop_id, name, enabled, kind, aliases_json, hinata_url_encrypted)
SELECT
  'bot-' || t.id,
  lower(hex(randomblob(6))),
  t.shop_id,
  CASE WHEN t.label IS NULL OR trim(t.label) = '' THEN 'Bot' ELSE t.label END,
  1, 'machine', '[]', ''
FROM api_tokens t
WHERE t.role = 'integration' AND t.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM device_capabilities c
    WHERE c.shop_id = t.shop_id AND c.capability = 'bot'
      AND json_extract(c.config_json, '$.tokenId') = t.id
  );

INSERT INTO device_capabilities(shop_id, device_id, capability, config_json, secret_json, created_at, updated_at)
SELECT
  t.shop_id,
  'bot-' || t.id,
  'bot',
  json_object('tokenId', t.id),
  '{}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM api_tokens t
WHERE t.role = 'integration' AND t.status = 'active'
  AND EXISTS (SELECT 1 FROM machines m WHERE m.id = 'bot-' || t.id AND m.shop_id = t.shop_id)
  AND NOT EXISTS (
    SELECT 1 FROM device_capabilities c
    WHERE c.shop_id = t.shop_id AND c.capability = 'bot'
      AND json_extract(c.config_json, '$.tokenId') = t.id
  );
