/**
 * Where a shop bills, for queries that list or load resources in one statement.
 * They follow `resolveResourcePlanId`: a resource's own override, otherwise its
 * group's plan, otherwise (in the default group) the shop's default plan. There
 * is no stored billing switch; these are the only shop-wide answers.
 */

/**
 * Whether the machine row `m` bills: true when it resolves to a plan. `b` is
 * the shop's `shop_billing_settings` row, joined by the caller (it may be null).
 */
export const resourceBilledSql = (m = "m", b = "b") => `(COALESCE(${m}.pricing_config_override_id,
  CASE WHEN ${m}.resource_group_id IS NOT NULL
    THEN (SELECT g.default_pricing_config_id FROM resource_groups g WHERE g.shop_id=${m}.shop_id AND g.id=${m}.resource_group_id)
    ELSE json_extract(COALESCE(${b}.entry_pricing_ids_json,'[]'),'$[0]') END) IS NOT NULL)`;

/** Whether any resource of the shop `shopId` (an SQL expression) bills. */
export const shopBillsSql = (shopId: string) => `EXISTS(SELECT 1 FROM machines m
  LEFT JOIN shop_billing_settings b ON b.shop_id=m.shop_id
  WHERE m.shop_id=${shopId} AND ${resourceBilledSql("m", "b")})`;

/**
 * Makes every resource of a shop free: no default plan, no group plans, no
 * overrides. Restoring a backup from a shop that did not bill (the retired
 * `billingEnabled: false`) runs these so it stays free.
 */
export function freeShopStatements<T>(db: { prepare(sql: string): { bind(...values: unknown[]): T } }, shopId: string): T[] {
  return [
    db.prepare("UPDATE shop_billing_settings SET entry_pricing_ids_json='[]' WHERE shop_id=?").bind(shopId),
    db.prepare("UPDATE resource_groups SET default_pricing_config_id=NULL WHERE shop_id=?").bind(shopId),
    db.prepare("UPDATE machines SET pricing_config_override_id=NULL WHERE shop_id=?").bind(shopId),
  ];
}
