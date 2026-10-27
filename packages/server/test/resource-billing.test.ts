import { describe, expect, it } from "bun:test";
import type { PricingConfig } from "@prism/core";
import { defaultGroupPlanId, resolveResourcePlanId, shopDefaultPlanId, type ResourceGroup } from "../src/resources/billing.js";

const group = (patch: Partial<ResourceGroup> = {}): ResourceGroup => ({
  id: "g", shopId: "s", name: "g", enabled: true, defaultPricingConfigId: "group-plan", isDefault: false, ...patch,
});
const resource = (groupId: string | null, override: string | null = null) => ({ id: "r", name: "柜", groupId, pricingConfigOverrideId: override });
const timePlan = (id: string, enabled = true) => ({ id, kind: "time.priority", enabled, status: "active" }) as PricingConfig;

describe("resource billing resolution", () => {
  it("prefers the resource's own plan, then its group's, then the shop default for the default group", () => {
    expect(resolveResourcePlanId({ resource: resource("g", "own"), group: group(), defaultPlanId: "shop" })).toBe("own");
    expect(resolveResourcePlanId({ resource: resource("g"), group: group(), defaultPlanId: "shop" })).toBe("group-plan");
    expect(resolveResourcePlanId({ resource: resource(null), group: null, defaultPlanId: "shop" })).toBe("shop");
  });

  it("leaves a resource free when neither it nor its group has a plan, never falling back to the shop default", () => {
    expect(resolveResourcePlanId({ resource: resource("g"), group: group({ defaultPricingConfigId: null }), defaultPlanId: "shop" })).toBeNull();
    expect(resolveResourcePlanId({ resource: resource(null), group: null, defaultPlanId: null })).toBeNull();
  });

  it("takes the default group's plan only from the shop setting", () => {
    expect(defaultGroupPlanId(["set"])).toBe("set");
    expect(defaultGroupPlanId([])).toBeNull();
    expect(() => defaultGroupPlanId(["a", "b"])).toThrow(expect.objectContaining({ code: "DEFAULT_PRICING_AMBIGUOUS" }));
  });

  it("refuses a disabled or missing group even with an override", () => {
    expect(() => resolveResourcePlanId({ resource: resource("g", "own"), group: group({ enabled: false }), defaultPlanId: null }))
      .toThrow(expect.objectContaining({ code: "RESOURCE_GROUP_DISABLED" }));
    expect(() => resolveResourcePlanId({ resource: resource("g"), group: null, defaultPlanId: null }))
      .toThrow(expect.objectContaining({ code: "RESOURCE_GROUP_NOT_FOUND" }));
  });

  it("takes the shop default from its setting, otherwise from its only startable time plan", () => {
    expect(shopDefaultPlanId(["set"], [timePlan("a"), timePlan("b")])).toBe("set");
    expect(shopDefaultPlanId([], [timePlan("a"), timePlan("off", false)])).toBe("a");
    expect(shopDefaultPlanId([], [timePlan("a"), timePlan("b")])).toBeNull();
    expect(() => shopDefaultPlanId(["a", "b"], [])).toThrow(expect.objectContaining({ code: "DEFAULT_PRICING_AMBIGUOUS" }));
  });
});
