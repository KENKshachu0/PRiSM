-- Billing is decided per resource; the shop-wide switch is retired.
--
-- A resource bills when it resolves to a plan (its own override, otherwise its
-- group's plan, otherwise the shop's default plan for the default group) and is
-- free otherwise. `shop_billing_settings.billing_enabled` is no longer read or
-- written; the column stays because D1 schema changes run before data
-- conversions in deploy:beta (see docs/pricing-time-zone-audit.md).
--
-- A shop that did not bill could still hold plan assignments the switch used to
-- ignore (a default plan picked before billing was turned on, or legacy prism-neo
-- rules imported disabled). Those would start billing now, so every shop without
-- the switch on keeps its resources free by dropping its assignments.
UPDATE shop_billing_settings SET entry_pricing_ids_json = '[]'
WHERE billing_enabled = 0 AND entry_pricing_ids_json <> '[]';

UPDATE resource_groups SET default_pricing_config_id = NULL
WHERE default_pricing_config_id IS NOT NULL
  AND shop_id NOT IN (SELECT shop_id FROM shop_billing_settings WHERE billing_enabled = 1);

UPDATE machines SET pricing_config_override_id = NULL
WHERE pricing_config_override_id IS NOT NULL
  AND shop_id NOT IN (SELECT shop_id FROM shop_billing_settings WHERE billing_enabled = 1);
