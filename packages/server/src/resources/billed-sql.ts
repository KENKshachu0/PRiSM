import { DEFAULT_RESOURCE_GROUP_ID } from "./billing.js";

/**
 * Where a shop bills, for queries that load resources in one statement. They
 * follow `resolveResourcePlanId`: a resource's own override, otherwise its
 * group's plan; a resource without a group is in the default group. There is
 * no stored billing switch and no default plan.
 */

/** Whether the machine row `m` bills: true when it resolves to a plan. */
export const resourceBilledSql = (m = "m") => `(COALESCE(${m}.pricing_config_override_id,
  (SELECT g.default_pricing_config_id FROM resource_groups g
   WHERE g.shop_id=${m}.shop_id AND g.id=COALESCE(${m}.resource_group_id,'${DEFAULT_RESOURCE_GROUP_ID}'))) IS NOT NULL)`;

/**
 * Whether any resource of the shop `shopId` (an SQL expression) bills. Only the
 * retired `billingEnabled` field still answers this, for released App Clips
 * that require it; nothing on the platform decides by it.
 */
export const shopBillsSql = (shopId: string) => `EXISTS(SELECT 1 FROM machines m
  WHERE m.shop_id=${shopId} AND ${resourceBilledSql("m")})`;

/**
 * Makes every resource of a shop free: no group plans (the default group's
 * included), no overrides. Restoring a backup from a shop that did not bill (the retired
 * `billingEnabled: false`) runs these so it stays free.
 */
export function freeShopStatements<T>(db: { prepare(sql: string): { bind(...values: unknown[]): T } }, shopId: string): T[] {
  return [
    db.prepare("UPDATE resource_groups SET default_pricing_config_id=NULL WHERE shop_id=?").bind(shopId),
    db.prepare("UPDATE machines SET pricing_config_override_id=NULL WHERE shop_id=?").bind(shopId),
  ];
}
