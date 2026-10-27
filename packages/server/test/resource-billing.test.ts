import { describe, expect, it } from "bun:test";
import { resolveResourcePlanId, resourceGroupIdOf, type ResourceGroup } from "../src/resources/billing.js";

const group = (patch: Partial<ResourceGroup> = {}): ResourceGroup => ({
  id: "g", shopId: "s", name: "g", enabled: true, defaultPricingConfigId: "group-plan", isDefault: false, ...patch,
});
const resource = (groupId: string | null, override: string | null = null) => ({ id: "r", name: "柜", groupId, pricingConfigOverrideId: override });

describe("resource billing resolution", () => {
  it("prefers the resource's own plan, then its group's", () => {
    expect(resolveResourcePlanId({ resource: resource("g", "own"), group: group() })).toBe("own");
    expect(resolveResourcePlanId({ resource: resource("g"), group: group() })).toBe("group-plan");
  });

  it("puts a resource without a group of its own in the default group, priced like any other", () => {
    expect(resourceGroupIdOf(resource(null))).toBe("default");
    expect(resolveResourcePlanId({ resource: resource(null), group: group({ id: "default", isDefault: true, defaultPricingConfigId: "hall" }) }))
      .toBe("hall");
  });

  it("leaves a resource free when neither it nor its group has a plan", () => {
    expect(resolveResourcePlanId({ resource: resource("g"), group: group({ defaultPricingConfigId: null }) })).toBeNull();
    expect(resolveResourcePlanId({ resource: resource(null), group: group({ id: "default", defaultPricingConfigId: null }) })).toBeNull();
  });

  it("refuses a disabled or missing group even with an override", () => {
    expect(() => resolveResourcePlanId({ resource: resource("g", "own"), group: group({ enabled: false }) }))
      .toThrow(expect.objectContaining({ code: "RESOURCE_GROUP_DISABLED" }));
    expect(() => resolveResourcePlanId({ resource: resource("g"), group: null }))
      .toThrow(expect.objectContaining({ code: "RESOURCE_GROUP_NOT_FOUND" }));
  });
});
