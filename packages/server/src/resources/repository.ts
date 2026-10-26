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
    isDefault: false,
  };
}

/** The shop's default group, built from its default plan setting. */
export function defaultResourceGroup(shopId: string, entryPricingIdsJson: string): ResourceGroup {
  let ids: unknown = [];
  try {
    ids = JSON.parse(entryPricingIdsJson);
  } catch {
    ids = [];
  }
  const [planId] = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  return {
    id: DEFAULT_RESOURCE_GROUP_ID,
    shopId,
    name: "默认资源组",
    enabled: true,
    defaultPricingConfigId: planId ?? null,
    isDefault: true,
  };
}

export async function listResourceGroups(db: D1DatabaseLike, shopId: string): Promise<ResourceGroup[]> {
  const rows = await db
    .prepare("SELECT shop_id, id, name, enabled, default_pricing_config_id FROM resource_groups WHERE shop_id = ? ORDER BY created_at, id")
    .bind(shopId)
    .all<GroupRow>();
  return rows.results.map(toGroup);
}

export async function findResourceGroup(db: D1DatabaseLike, shopId: string, groupId: string): Promise<ResourceGroup | null> {
  const row = await db
    .prepare("SELECT shop_id, id, name, enabled, default_pricing_config_id FROM resource_groups WHERE shop_id = ? AND id = ?")
    .bind(shopId, groupId)
    .first<GroupRow>();
  return row ? toGroup(row) : null;
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
export async function resourcePlanUsers(
  db: D1DatabaseLike,
  shopId: string,
  defaultPlanIds: readonly string[],
  planId: string,
): Promise<string[]> {
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
    ...(defaultPlanIds.includes(planId) ? ["默认资源组"] : []),
    ...groups.results.map((row) => `资源组「${row.name}」`),
    ...resources.results.map((row) => `资源「${row.name}」`),
    ...tables.results.map((row) => `麻将桌「${row.name}」`),
  ];
}
