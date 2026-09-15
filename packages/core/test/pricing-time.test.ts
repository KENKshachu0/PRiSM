import { centsOf as moneyFixture, centsOfInteger as integerFixture } from "@prism/core";
import { describe, expect, it } from "bun:test";
import {
  createPriorityTimePricingProvider,
  explainTimeCapPricing,
  type ChargeItem,
  type PriorityTimePricingProviderConfig,
} from "../src/index";

describe("time pricing explanations", () => {
  it("records the actual overnight segment and reached interval cap", async () => {
    const config: PriorityTimePricingProviderConfig = {
      id: "time.priority",
      pricingConfigId: "pricing-priority",
      timeZone: "Asia/Shanghai",
      rules: [
        {
          id: "day",
          label: "平日白天",
          priority: 1,
          timeRange: { start: "10:00", end: "22:00" },
          pricing: { unitMinutes: 60, unitPrice: 10, roundGraceMinutes: 0, priceCap: 100 },
        },
        {
          id: "night",
          label: "平日夜场",
          priority: 1,
          timeRange: { start: "22:00", end: "10:00" },
          pricing: { unitMinutes: 60, unitPrice: 10, roundGraceMinutes: 0, priceCap: 100 },
        },
      ],
    };

    const charges = await createPriorityTimePricingProvider(config).quote({
      session: {
        id: "s1",
        playerId: "player-1",
        startedAt: new Date("2026-07-09T13:48:00Z"),
        status: "active",
      },
      now: new Date("2026-07-10T02:00:00Z"),
      assetHoldings: [],
    });

    expect(charges[1]?.pricingExplanation).toMatchObject({
      pricingConfigId: "pricing-priority",
      providerId: "time.priority",
      ruleId: "night",
      ruleLabel: "平日夜场",
      period: { startedAt: new Date("2026-07-09T14:00:00Z") },
      ruleTimeRange: { start: "22:00", end: "10:00" },
      intervalCap: 100,
      intervalCapReached: true,
    });
  });

  it("keeps one global cap window per local rule anchor across multiple sessions", () => {
    const chargeItems: ChargeItem[] = [
      {
        id: "s1:time.base",
        sessionId: "s1",
        source: "time.base",
        label: "基础计费",
        amount: moneyFixture(50),
        period: { startedAt: new Date("2026-07-09T14:00:00Z"), endedAt: new Date("2026-07-09T19:00:00Z") },
        pricingHistory: {
          pricingConfigId: "pricing-base",
          providerId: "time.base",
          ruleId: "night",
          ruleAnchorAt: new Date("2026-07-09T14:00:00Z"),
          amount: moneyFixture(50),
        },
      },
      {
        id: "s2:time.base",
        sessionId: "s2",
        source: "time.base",
        label: "基础计费",
        amount: moneyFixture(50),
        period: { startedAt: new Date("2026-07-09T19:00:00Z"), endedAt: new Date("2026-07-10T02:00:00Z") },
        pricingHistory: {
          pricingConfigId: "pricing-base",
          providerId: "time.base",
          ruleId: "night",
          ruleAnchorAt: new Date("2026-07-09T14:00:00Z"),
          amount: moneyFixture(50),
        },
      },
    ];

    const windows = explainTimeCapPricing({
      config: {
        id: "cap.global",
        pricingConfigId: "cap-pricing",
        includedPricingConfigIds: ["pricing-base"],
        timeZone: "Asia/Shanghai",
        rules: [{ id: "night", label: "夜间", priority: 1, timeRange: { start: "22:00", end: "10:00" }, priceCap: 79 }],
      },
      chargeItems,
      paidHistory: {},
    });

    expect(windows).toEqual([
      expect.objectContaining({
        key: "cap-pricing@night@2026-07-09T14:00:00.000Z",
        ruleLabel: "夜间",
        currentAmount: moneyFixture(100),
        priceCap: moneyFixture(79),
        amountApplied: moneyFixture(79),
        contributions: [
          { sessionId: "s1", pricingConfigId: "pricing-base", amount: moneyFixture(50) },
          { sessionId: "s2", pricingConfigId: "pricing-base", amount: moneyFixture(50) },
        ],
      }),
    ]);
  });

  it("keeps a colon-containing session ID in cap-window contributions", async () => {
    const pricingConfig: PriorityTimePricingProviderConfig = {
      id: "time.base",
      pricingConfigId: "pricing-base",
      rules: [
        {
          id: "all-day",
          label: "基础计费",
          priority: 1,
          dateTimeRange: { start: new Date("2026-07-10T00:00:00Z"), end: new Date("2026-07-10T02:00:00Z") },
          pricing: { unitMinutes: 60, unitPrice: 50, roundGraceMinutes: 0, priceCap: 999 },
        },
      ],
    };
    const chargeItems = await createPriorityTimePricingProvider(pricingConfig).quote({
      session: {
        id: "session:with:colons",
        playerId: "player-1",
        startedAt: new Date("2026-07-10T00:00:00Z"),
        status: "active",
      },
      now: new Date("2026-07-10T01:00:00Z"),
      assetHoldings: [],
    });

    const windows = explainTimeCapPricing({
      config: {
        id: "cap.global",
        pricingConfigId: "cap-pricing",
        includedPricingConfigIds: ["pricing-base"],
        rules: [{
          id: "all-day",
          label: "全日",
          priority: 1,
          dateTimeRange: { start: new Date("2026-07-10T00:00:00Z"), end: new Date("2026-07-10T02:00:00Z") },
          priceCap: 79,
        }],
      },
      chargeItems,
    });

    expect(windows[0]?.contributions).toEqual([
      { sessionId: "session:with:colons", pricingConfigId: "pricing-base", amount: moneyFixture(50) },
    ]);
  });
});
