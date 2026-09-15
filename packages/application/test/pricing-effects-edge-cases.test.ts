import { yuanOf } from "@prism/core";
import { describe, expect, it } from "bun:test";
import {
  AssetDefinitionRepository,
  AssetRepository,
  PricingEffect,
  Session,
  SessionRepository,
  SettlementRepository,
  centsOf,
  yuanOf,
} from "@prism/core";
import {
  calculateAssetEffectDiscount,
  createAssetDefinitionEffectProvider,
  createSettlementService,
} from "../src/index";

describe("pricing effects edge cases", () => {
  it("preserves two-decimal precision for percentage discounts", () => {
    const discount = calculateAssetEffectDiscount(15.5, {
      type: "percentage-discount",
      value: 10,
    });
    expect(discount).toBe(1.55);
  });

  it("generates unique adjustment IDs for multiple holdings of the same asset", async () => {
    const provider = createAssetDefinitionEffectProvider({
      async listAll() {
        return [{
          type: "coupon",
          code: "five-off",
          name: "5元立减券",
          stackable: false,
          status: "active",
          pricingEffect: {
            id: "effect-five",
            name: "5元立减",
            type: "discount",
            scope: "session",
            value: 5,
            consumable: true,
            limitPerDay: null,
            status: "active",
            config: null,
          },
        }];
      },
    } as any);

    const adjustments = await provider.apply({
      session: {
        id: "session-1",
        playerId: "p1",
        startedAt: new Date("2026-09-01T10:00:00.000Z"),
        status: "active",
        paymentStatus: "unpaid",
      },
      subtotal: centsOf(30),
      chargeItems: [],
      assetHoldings: [
        { id: "holding-a", assetType: "coupon", assetCode: "five-off", quantity: centsOf(1) },
        { id: "holding-b", assetType: "coupon", assetCode: "five-off", quantity: centsOf(1) },
      ],
      now: new Date("2026-09-01T10:00:00.000Z"),
    });

    expect(adjustments).toHaveLength(2);
    expect(adjustments[0].id).not.toBe(adjustments[1].id);
    expect(adjustments.map((a) => a.amount)).toEqual([-5, -5]);
  });

  it("caps multiple targeted coupons to the eligible charges without spilling into unrelated fees", async () => {
    const provider = createAssetDefinitionEffectProvider({
      async listAll() {
        return [{
          type: "coupon",
          code: "music-ten",
          name: "音游券10元",
          stackable: false,
          status: "active",
          pricingEffect: {
            id: "effect-music-ten",
            name: "音游立减10元",
            type: "discount",
            scope: "session",
            value: 10,
            consumable: true,
            limitPerDay: null,
            status: "active",
            config: {
              applicablePricingConfigIds: ["config-music"],
            },
          },
        }];
      },
    } as any);

    const adjustments = await provider.apply({
      session: {
        id: "session-1",
        playerId: "p1",
        startedAt: new Date("2026-09-01T10:00:00.000Z"),
        status: "active",
        paymentStatus: "unpaid",
      },
      subtotal: centsOf(65),
      chargeItems: [
        {
          id: "charge-music",
          source: "config-music",
          label: "音游机",
          amount: 15,
          pricingHistory: {
            pricingConfigId: "config-music",
            ruleId: "rule-1",
            providerId: "config-music",
            ruleAnchorAt: new Date("2026-09-01T10:00:00.000Z"),
            amount: 15,
          },
        },
        {
          id: "charge-general",
          source: "config-general",
          label: "散台",
          amount: 50,
        },
      ],
      assetHoldings: [
        { id: "holding-1", assetType: "coupon", assetCode: "music-ten", quantity: centsOf(1) },
        { id: "holding-2", assetType: "coupon", assetCode: "music-ten", quantity: centsOf(1) },
      ],
      now: new Date("2026-09-01T10:00:00.000Z"),
    });

    // Total music charge is 15.
    // Coupon 1 can take 10. Coupon 2 must be capped to remaining 5, not 10!
    expect(adjustments).toHaveLength(2);
    expect(adjustments[0].amount).toBe(-10);
    expect(adjustments[1].amount).toBe(-5);
  });

  it("allows coupons active at checkout time even if session started before coupon was active", async () => {
    const provider = createAssetDefinitionEffectProvider({
      async listAll() {
        return [{
          type: "coupon",
          code: "ten-off",
          name: "10元优惠券",
          stackable: true,
          status: "active",
          activeAt: new Date("2026-09-01T11:00:00.000Z"), // Active at 11:00
          pricingEffect: {
            id: "effect-ten",
            name: "10元优惠",
            type: "discount",
            scope: "session",
            value: 10,
            consumable: true,
            limitPerDay: null,
            status: "active",
            config: null,
          },
        }];
      },
    } as any);

    // Session started at 10:00 (before coupon was active)
    // Checkout is at 12:00 (after coupon became active)
    const adjustments = await provider.apply({
      session: {
        id: "session-1",
        playerId: "p1",
        startedAt: new Date("2026-09-01T10:00:00.000Z"),
        status: "active",
        paymentStatus: "unpaid",
      },
      subtotal: centsOf(50),
      chargeItems: [],
      assetHoldings: [
        { id: "holding-1", assetType: "coupon", assetCode: "ten-off", quantity: centsOf(1) },
      ],
      now: new Date("2026-09-01T12:00:00.000Z"),
    });

    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].amount).toBe(-10);
  });

  it("does not reuse a consumed coupon across multiple sessions in unified checkout", async () => {
    const sessions: Session[] = [
      {
        id: "s1",
        playerId: "p1",
        startedAt: new Date("2026-09-01T10:00:00.000Z"),
        endedAt: new Date("2026-09-01T11:00:00.000Z"),
        status: "closed",
        paymentStatus: "unpaid",
      },
      {
        id: "s2",
        playerId: "p1",
        startedAt: new Date("2026-09-01T11:00:00.000Z"),
        endedAt: new Date("2026-09-01T12:00:00.000Z"),
        status: "closed",
        paymentStatus: "unpaid",
      },
    ];

    const assetHoldings = [
      {
        id: "h-currency",
        assetType: "currency",
        assetCode: "paid",
        quantity: centsOf(1000),
        activeAt: null,
        expiresAt: null,
      },
      {
        id: "h-coupon",
        assetType: "coupon",
        assetCode: "ten-off",
        quantity: centsOf(1), // Only 1 coupon!
        activeAt: null,
        expiresAt: null,
      },
    ];

    const definitions = [
      {
        type: "currency",
        code: "paid",
        name: "代币",
        stackable: true,
        status: "active" as const,
        metadata: null,
      },
      {
        type: "coupon",
        code: "ten-off",
        name: "10元优惠券",
        stackable: true,
        status: "active" as const,
        pricingEffect: {
          id: "effect-ten",
          name: "10元优惠",
          type: "discount" as const,
          scope: "session" as const,
          value: 10,
          consumable: true,
          limitPerDay: null,
          status: "active" as const,
          config: null,
        },
        metadata: null,
      },
    ];

    const assetDefinitionsRepo: AssetDefinitionRepository = {
      async listAll() {
        return definitions;
      },
      async findByCode(type, code) {
        return definitions.find((d) => d.type === type && d.code === code) ?? null;
      },
      async save() {},
    };

    const assetRepo: AssetRepository = {
      async listAssetHoldings() {
        return assetHoldings;
      },
      async commitAssetTransaction() {},
    } as any;

    const sessionRepo: SessionRepository = {
      async findActiveByPlayerId() {
        return [];
      },
      async findUnpaidClosedByPlayerId() {
        return sessions;
      },
      async save() {},
    } as any;

    const settlementRepo: SettlementRepository = {
      async save() {},
      async listPastAppliedAdjustmentsByPlayerId() {
        return [];
      },
    } as any;

    const pricingProvider = {
      id: "fixed-pricing",
      async quote(context: any) {
        return [{ id: `${context.session.id}:charge`, source: "fixed", label: "时长费", amount: 30 }];
      },
    };

    const effectProvider = createAssetDefinitionEffectProvider(assetDefinitionsRepo);

    const settlementService = createSettlementService({
      sessions: sessionRepo,
      assets: assetRepo,
      settlements: settlementRepo,
      assetDefinitions: assetDefinitionsRepo,
      pricingProviders: [pricingProvider],
      assetEffectProviders: [effectProvider],
      now: () => new Date("2026-09-01T12:00:00.000Z"),
    });

    const preview = await settlementService.previewCheckout({ playerId: "p1" });

    // s1 subtotal: 30, discount: -10 -> total: 20
    // s2 subtotal: 30, discount: 0 -> total: 30 (because the coupon was consumed by s1!)
    // Overall total should be 50, NOT 40!
    expect(yuanOf(preview.settlementPreview.subtotal)).toBe(60);
    expect(yuanOf(preview.settlementPreview.total)).toBe(50);
    expect(preview.adjustments).toHaveLength(1);
    expect(preview.adjustments[0].amount).toBe(-10);
  });

  it("skips discount when eligible subtotal is below minSubtotal threshold", async () => {
    const provider = createAssetDefinitionEffectProvider({
      async listAll() {
        return [{
          type: "coupon",
          code: "spend-50-minus-10",
          name: "满50减10",
          stackable: false,
          status: "active",
          pricingEffect: {
            id: "effect-spend-50",
            name: "满50减10",
            type: "discount",
            scope: "session",
            value: 10,
            consumable: true,
            limitPerDay: null,
            status: "active",
            config: {
              minSubtotal: 50,
            },
          },
        }];
      },
    } as any);

    // Subtotal 40 < 50 threshold: should NOT apply
    const adjustmentsBelow = await provider.apply({
      session: {
        id: "session-1",
        playerId: "p1",
        startedAt: new Date("2026-09-01T10:00:00.000Z"),
        status: "active",
        paymentStatus: "unpaid",
      },
      subtotal: centsOf(40),
      chargeItems: [],
      assetHoldings: [
        { id: "holding-1", assetType: "coupon", assetCode: "spend-50-minus-10", quantity: centsOf(1) },
      ],
      now: new Date("2026-09-01T10:00:00.000Z"),
    });

    expect(adjustmentsBelow).toHaveLength(0);

    // Subtotal 60 >= 50 threshold: should apply
    const adjustmentsAbove = await provider.apply({
      session: {
        id: "session-2",
        playerId: "p1",
        startedAt: new Date("2026-09-01T10:00:00.000Z"),
        status: "active",
        paymentStatus: "unpaid",
      },
      subtotal: centsOf(60),
      chargeItems: [],
      assetHoldings: [
        { id: "holding-1", assetType: "coupon", assetCode: "spend-50-minus-10", quantity: centsOf(1) },
      ],
      now: new Date("2026-09-01T10:00:00.000Z"),
    });

    expect(adjustmentsAbove).toHaveLength(1);
    expect(adjustmentsAbove[0].amount).toBe(-10);
  });
});
