import { describe, expect, it } from "bun:test";
import { resolveResourcePlanId, type BillableResource, type ResourceGroup } from "../src/resources/billing.js";
import { memberPlanForResource } from "../src/resources/member-plans.js";

const group: ResourceGroup = {
  id: "default",
  shopId: "shop",
  name: "默认资源组",
  enabled: true,
  defaultPricingConfigId: "normal-group",
  isDefault: true,
};
const resource: BillableResource = {
  id: "resource-1",
  name: "机台",
  groupId: "default",
  pricingConfigOverrideId: "normal-resource",
};

describe("member resource plans", () => {
  it("lets a member plan replace the normal plan", () => {
    expect(resolveResourcePlanId({ resource, group, memberPlanId: "member-plan" })).toBe("member-plan");
    expect(resolveResourcePlanId({ resource, group })).toBe("normal-resource");
  });

  it("resolves a resource mapping before the group mapping", () => {
    expect(memberPlanForResource({
      groups: { default: "group-member" },
      resources: { "resource-1": "resource-member" },
    }, resource)).toBe("resource-member");
    expect(memberPlanForResource({
      groups: { default: "group-member" },
      resources: {},
    }, resource)).toBe("group-member");
    expect(memberPlanForResource({ groups: {}, resources: {} }, resource)).toBeNull();
  });
});
