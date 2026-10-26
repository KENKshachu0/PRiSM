/**
 * Which plan a resource bills.
 *
 * The rule is small and total: a resource's own override wins, otherwise its
 * group's default plan applies. A resource without a group belongs to the
 * shop's default group, whose plan is the shop's default plan. An override
 * replaces the group's plan rather than adding to it: whether two plans run
 * together is a question for the plans' `requires`, not for the grouping.
 */
import { isStartablePlan, PrismDomainError, type PricingConfig } from "@prism/core";

/** The id the shop's default group answers to. It is never stored. */
export const DEFAULT_RESOURCE_GROUP_ID = "default";

export type ResourceGroup = {
  id: string;
  shopId: string;
  name: string;
  enabled: boolean;
  /** Null for a group the shop has not priced yet. */
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

/**
 * The shop's default plan: the one it configured, otherwise its only startable
 * time plan. Null when neither picks exactly one plan.
 */
export function shopDefaultPlanId(configured: readonly string[], catalog: readonly PricingConfig[]): string | null {
  if (configured.length > 1) {
    throw new PrismDomainError("默认计费方案只能有一个，请店家重新设置", "DEFAULT_PRICING_AMBIGUOUS");
  }
  if (configured[0]) return configured[0];
  const startable = catalog.filter((config) => config.kind === "time.priority" && isStartablePlan(config));
  return startable.length === 1 ? startable[0]!.id : null;
}

export function resolveResourcePlanId(input: {
  resource: BillableResource;
  /** The resource's own group; ignored for a resource in the default group. */
  group: ResourceGroup | null;
  defaultPlanId: string | null;
}): string {
  const { resource, group } = input;
  if (resource.groupId) {
    if (!group) throw new PrismDomainError("所属的资源组不存在，请联系店员", "RESOURCE_GROUP_NOT_FOUND");
    if (!group.enabled) throw new PrismDomainError("该区域暂停使用，请联系店员", "RESOURCE_GROUP_DISABLED");
  }
  const planId = resource.pricingConfigOverrideId ?? (resource.groupId ? group!.defaultPricingConfigId : input.defaultPlanId);
  if (planId) return planId;
  throw new PrismDomainError(`「${resource.name}」还没有设置计费方案，请联系店员`, "RESOURCE_PRICING_NOT_CONFIGURED");
}
