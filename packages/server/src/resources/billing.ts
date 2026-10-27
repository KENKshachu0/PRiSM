/**
 * Which plan a resource bills, if any.
 *
 * The rule is small and total: a resource's own override wins, otherwise its
 * group's plan applies. Every resource is in a group; one without a group of
 * its own is in the shop's default group, which is stored and priced like any
 * other. An override replaces the group's plan rather than adding to it:
 * whether two plans run together is a question for the plans' `requires`, not
 * for the grouping. A resource that ends up with no plan is free: players use
 * it without confirming anything, and nothing bills. There is no shop-wide
 * billing switch and no default plan; a shop bills exactly where it assigned
 * plans.
 */
import { PrismDomainError } from "@prism/core";

/** The id of the group every resource without one belongs to. */
export const DEFAULT_RESOURCE_GROUP_ID = "default";

export type ResourceGroup = {
  id: string;
  shopId: string;
  name: string;
  enabled: boolean;
  /** Null for a group whose resources are free. */
  defaultPricingConfigId: string | null;
  isDefault: boolean;
};

export type BillableResource = {
  id: string;
  name: string;
  /** Null when the resource belongs to the shop's default group. */
  groupId: string | null;
  pricingConfigOverrideId: string | null;
};

/** The group a resource belongs to: its own, otherwise the shop's default group. */
export const resourceGroupIdOf = (resource: Pick<BillableResource, "groupId">) =>
  resource.groupId ?? DEFAULT_RESOURCE_GROUP_ID;

/** The resource's plan, or null when the resource is free. */
export function resolveResourcePlanId(input: {
  resource: BillableResource;
  /** The resource's group, as `resourceGroupIdOf` names it; null when it is gone. */
  group: ResourceGroup | null;
}): string | null {
  const { resource, group } = input;
  if (!group) throw new PrismDomainError("所属的资源组不存在，请联系店员", "RESOURCE_GROUP_NOT_FOUND");
  if (!group.enabled) throw new PrismDomainError("该区域暂停使用，请联系店员", "RESOURCE_GROUP_DISABLED");
  return resource.pricingConfigOverrideId ?? group.defaultPricingConfigId;
}
