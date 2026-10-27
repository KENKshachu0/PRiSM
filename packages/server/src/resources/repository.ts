import type { D1DatabaseLike } from "@prism/adapter-d1";
import { DEFAULT_RESOURCE_GROUP_ID, type BillableResource, type ResourceGroup } from "./billing.js";

type GroupRow = {
  shop_id: string;
  id: string;
  name: string;
  enabled: number;
  default_pricing_config_id: string | null;
};

function toGroup(row: GroupRow): ResourceGroup {
  return {
    id: row.id,
    shopId: row.shop_id,
    name: row.name,
    enabled: row.enabled === 1,
    defaultPricingConfigId: row.default_pricing_config_id,
    isDefault: row.id === DEFAULT_RESOURCE_GROUP_ID,
  };
}

/**
 * The shop's default group as it is before anyone priced it. Every shop has it
 * stored (migration 0045, shop creation, imports); a shop that somehow lacks the
 * row still gets a free, enabled default group rather than failing every scan.
 */
export function unstoredDefaultGroup(shopId: string): ResourceGroup {
  return {
    id: DEFAULT_RESOURCE_GROUP_ID,
    shopId,
    name: "默认资源组",
    enabled: true,
    defaultPricingConfigId: null,
    isDefault: true,
  };
}

/** Stores the shop's default group if it is not there yet: free and enabled. */
export function ensureDefaultGroupStatement<T>(db: { prepare(sql: string): { bind(...values: unknown[]): T } }, shopId: string, planId: string | null = null): T {
  const now = new Date().toISOString();
  return db.prepare(
    `INSERT INTO resource_groups(shop_id, id, name, enabled, default_pricing_config_id, created_at, updated_at)
     VALUES (?, ?, '默认资源组', 1, ?, ?, ?) ON CONFLICT(shop_id, id) DO NOTHING`,
  ).bind(shopId, DEFAULT_RESOURCE_GROUP_ID, planId, now, now);
}

/** The shop's groups, the default group first. */
export async function listResourceGroups(db: D1DatabaseLike, shopId: string): Promise<ResourceGroup[]> {
  const rows = await db
    .prepare(
      `SELECT shop_id, id, name, enabled, default_pricing_config_id FROM resource_groups WHERE shop_id = ?
       ORDER BY id <> ?, created_at, id`,
    )
    .bind(shopId, DEFAULT_RESOURCE_GROUP_ID)
    .all<GroupRow>();
  const groups = rows.results.map(toGroup);
  return groups.some((group) => group.isDefault) ? groups : [unstoredDefaultGroup(shopId), ...groups];
}

export async function findResourceGroup(db: D1DatabaseLike, shopId: string, groupId: string): Promise<ResourceGroup | null> {
  const row = await db
    .prepare("SELECT shop_id, id, name, enabled, default_pricing_config_id FROM resource_groups WHERE shop_id = ? AND id = ?")
    .bind(shopId, groupId)
    .first<GroupRow>();
  return row ? toGroup(row) : groupId === DEFAULT_RESOURCE_GROUP_ID ? unstoredDefaultGroup(shopId) : null;
}

/** A resource's identity and billing binding, without its capabilities. */
export async function findBillableResource(db: D1DatabaseLike, shopId: string, resourceId: string): Promise<BillableResource | null> {
  const row = await db
    .prepare("SELECT id, name, resource_group_id, pricing_config_override_id FROM machines WHERE shop_id = ? AND id = ?")
    .bind(shopId, resourceId)
    .first<{ id: string; name: string; resource_group_id: string | null; pricing_config_override_id: string | null }>();
  return row
    ? { id: row.id, name: row.name, groupId: row.resource_group_id, pricingConfigOverrideId: row.pricing_config_override_id }
    : null;
}

/** Everything that bills through `planId`, by display name, for refusing to archive it. */
export async function resourcePlanUsers(db: D1DatabaseLike, shopId: string, planId: string): Promise<string[]> {
  const [groups, resources, tables] = await Promise.all([
    db.prepare("SELECT name FROM resource_groups WHERE shop_id = ? AND default_pricing_config_id = ? ORDER BY name")
      .bind(shopId, planId).all<{ name: string }>(),
    db.prepare("SELECT name FROM machines WHERE shop_id = ? AND pricing_config_override_id = ? ORDER BY name")
      .bind(shopId, planId).all<{ name: string }>(),
    db.prepare(
      `SELECT m.name FROM device_capabilities c JOIN machines m ON m.shop_id = c.shop_id AND m.id = c.device_id
       WHERE c.shop_id = ? AND c.capability = 'mahjong'
       AND EXISTS (SELECT 1 FROM json_each(json_extract(c.config_json, '$.pricingConfigIds')) WHERE value = ?)
       ORDER BY m.name`,
    ).bind(shopId, planId).all<{ name: string }>(),
  ]);
  return [
    ...groups.results.map((row) => `资源组「${row.name}」`),
    ...resources.results.map((row) => `资源「${row.name}」`),
    ...tables.results.map((row) => `麻将桌「${row.name}」`),
  ];
}
