import { centsOf as moneyFixture, centsOfInteger as integerFixture } from "@prism/core";
import { centsOf, yuanOf } from "@prism/core";
import { describe, expect, it } from "bun:test";
import {
  calendarDayAt,
  createAssetDefinitionEffectProvider,
  isAssetEffectConfigAvailable,
  resolveAssetDefinitionEffectConfig,
} from "../src/asset-definition-effects";

describe("asset definition effects", () => {
  it("ignores effect-like metadata when no pricing effect is linked", () => {
    expect(resolveAssetDefinitionEffectConfig({
      type: "time",
      code: "legacy-pass",
      name: "旧月卡",
      stackable: false,
      metadata: { settlementEffect: "time.free" },
    }, new Date("2026-07-16T10:00:00.000Z"))).toBeNull();
  });

  it("uses the configured time zone for date and weekday availability", () => {
    const at = new Date("2026-07-16T15:30:00.000Z");
    expect(calendarDayAt(at, "Asia/Tokyo")).toBe("2026-07-17");
    expect(isAssetEffectConfigAvailable({
      type: "discount",
      startDate: "2026-07-17",
      endDate: "2026-07-17",
      daysOfWeek: [5],
    }, at, "Asia/Tokyo")).toBeTrue();
  });

  it("applies one session effect through the shared provider", async () => {
    const provider = createAssetDefinitionEffectProvider({
      async listAll() {
        return [{
          type: "coupon",
          code: "three-off",
          name: "减三元",
          stackable: true,
          status: "active",
          pricingEffect: {
            id: "effect-three-off",
            name: "减三元",
            type: "discount",
            scope: "session",
            value: 3,
            consumable: false,
            limitPerDay: null,
            status: "active",
            config: {
              applicableSessionLabels: ["音游"],
            },
          },
        }];
      },
    } as any);

    await expect(provider.apply({
      session: {
        id: "session-1",
        playerId: "player-1",
        startedAt: new Date("2026-07-16T10:00:00.000Z"),
        status: "active",
        paymentStatus: "unpaid",
        label: "音游",
      },
      subtotal: centsOf(10),
      chargeItems: [],
      assetHoldings: [{ assetType: "coupon", assetCode: "three-off", quantity: integerFixture(1) }],
      timeZone: "Asia/Tokyo",
      now: new Date("2026-07-16T10:00:00.000Z"),
    })).resolves.toEqual([{
      id: "session-1:asset-definition:coupon:three-off:discount",
      source: "coupon.three-off",
      label: "减三元",
      amount: moneyFixture(-3),
    }]);
  });
});
