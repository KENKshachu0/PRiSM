import { type Cents, yuanOf, centsOf as moneyFixture, centsOfInteger as integerFixture } from "@prism/core";
import { describe, expect, it } from "bun:test";
import {
  applyTimeCapPricing,
  explainTimeCapPricing,
  settleTimeCaps,
  buildTimeCapPricingTimeline,
  buildPriorityTimePricingTimeline,
  createPriorityTimePricingProvider,
  createTimePricingProvider,
} from "../src/index";

function publicChargeItems(items: ReadonlyArray<{ id: string; source: string; label: string; amount: Cents }>) {
  return items.map((item) => ({
    id: item.id,
    source: item.source,
    label: item.label,
    amount: yuanOf(item.amount),
  }));
}

describe("createTimePricingProvider", () => {
  it("preserves decimal unit prices and caps", async () => {
    const provider = createTimePricingProvider({
      id: "time.decimal",
      label: "Decimal time pricing",
      unitMinutes: 30,
      unitPrice: 5.5,
      roundGraceMinutes: 0,
      priceCap: 12.5,
    });

    const chargeItems = await provider.quote({
      session: {
        id: "session-decimal",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T11:30:00.000Z"),
        status: "closed",
      },
      assetHoldings: [],
      now: new Date("2026-06-07T11:30:00.000Z"),
    });

    expect(publicChargeItems(chargeItems)).toEqual([
      {
        id: "session-decimal:time.decimal",
        source: "time.decimal",
        label: "Decimal time pricing",
        amount: 12.5,
      },
    ]);
  });

  it("quotes a session by unit minutes with grace and cap", async () => {
    const provider = createTimePricingProvider({
      id: "time.basic",
      label: "Basic time pricing",
      unitMinutes: 30,
      unitPrice: 5,
      roundGraceMinutes: 5,
      priceCap: 20,
    });

    const chargeItems = await provider.quote({
      session: {
        id: "session-1",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T11:36:00.000Z"),
        status: "closed",
      },
      assetHoldings: [],
      now: new Date("2026-06-07T11:36:00.000Z"),
    });

    expect(publicChargeItems(chargeItems)).toEqual([
      {
        id: "session-1:time.basic",
        source: "time.basic",
        label: "Basic time pricing",
        amount: 20,
      },
    ]);
  });

  it("grants free exit when within grace period without machine operation", async () => {
    const provider = createTimePricingProvider({
      id: "time.basic",
      label: "Basic time pricing",
      unitMinutes: 30,
      unitPrice: 10,
      roundGraceMinutes: 5,
      priceCap: 50,
    });

    const chargeItems = await provider.quote({
      session: {
        id: "session-grace",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:02:00.000Z"),
        status: "closed",
      },
      assetHoldings: [],
      now: new Date("2026-06-07T10:02:00.000Z"),
    });

    expect(chargeItems[0].amount).toBe(moneyFixture(0));
  });

  it("invalidates first grace period when machine was operated", async () => {
    const provider = createTimePricingProvider({
      id: "time.basic",
      label: "Basic time pricing",
      unitMinutes: 30,
      unitPrice: 10,
      roundGraceMinutes: 5,
      priceCap: 50,
    });

    // 2 minutes within 5 min grace, but device was operated
    const chargeItems2m = await provider.quote({
      session: {
        id: "session-operated-2m",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:02:00.000Z"),
        status: "closed",
        metadata: { deviceOperated: true },
      },
      assetHoldings: [],
      now: new Date("2026-06-07T10:02:00.000Z"),
    });

    expect(chargeItems2m[0].amount).toBe(moneyFixture(10));

    // Immediate logout (0 minutes), device was operated
    const chargeItems0m = await provider.quote({
      session: {
        id: "session-operated-0m",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:00:00.000Z"),
        status: "closed",
        metadata: { deviceOperated: true },
      },
      assetHoldings: [],
      now: new Date("2026-06-07T10:00:00.000Z"),
    });

    expect(chargeItems0m[0].amount).toBe(moneyFixture(10));
  });
});

describe("applyTimeCapPricing", () => {
  it("caps only charge items from included pricing configs after their local caps", () => {
    const adjustments = applyTimeCapPricing({
      config: {
        id: "cap.global",
        pricingConfigId: "cap-config",
        includedPricingConfigIds: ["pricing-base", "pricing-discount"],
        rules: [
          {
            id: "day",
            label: "日场全局封顶",
            priority: 1,
            timeRange: { start: "10:00", end: "22:00" },
            priceCap: 69,
          },
        ],
        timeZone: "Asia/Shanghai",
      },
      chargeItems: [
        {
          id: "session-1:base",
          source: "time.base",
          label: "音游",
          amount: moneyFixture(96),
          period: {
            startedAt: new Date("2026-07-09T02:00:00.000Z"),
            endedAt: new Date("2026-07-09T10:00:00.000Z"),
          },
          pricingHistory: {
            pricingConfigId: "pricing-base",
            providerId: "time.base",
            ruleId: "day",
            ruleAnchorAt: new Date("2026-07-09T02:00:00.000Z"),
            amount: moneyFixture(96),
          },
        },
        {
          id: "session-1:discount",
          source: "time.mahjong",
          label: "四口麻将",
          amount: moneyFixture(-24),
          period: {
            startedAt: new Date("2026-07-09T02:00:00.000Z"),
            endedAt: new Date("2026-07-09T10:00:00.000Z"),
          },
          pricingHistory: {
            pricingConfigId: "pricing-discount",
            providerId: "time.mahjong",
            ruleId: "day",
            ruleAnchorAt: new Date("2026-07-09T02:00:00.000Z"),
            amount: moneyFixture(-24),
          },
        },
        {
          id: "session-1:private-room",
          source: "time.private-room",
          label: "包间",
          amount: moneyFixture(20),
          period: {
            startedAt: new Date("2026-07-09T02:00:00.000Z"),
            endedAt: new Date("2026-07-09T10:00:00.000Z"),
          },
          pricingHistory: {
            pricingConfigId: "pricing-private-room",
            providerId: "time.private-room",
            ruleId: "day",
            ruleAnchorAt: new Date("2026-07-09T02:00:00.000Z"),
            amount: moneyFixture(20),
          },
        },
      ],
    });

    expect(adjustments).toEqual([
      {
        id: "time-cap:cap-config:day:2026-07-09T02:00:00.000Z",
        source: "time.cap:cap-config:day",
        label: "日场全局封顶",
        amount: moneyFixture(-3),
        pricingCapHistory: {
          capConfigId: "cap-config",
          capRuleId: "day",
          capAnchorAt: new Date("2026-07-09T02:00:00.000Z"),
          includedPricingConfigIds: ["pricing-base", "pricing-discount"],
          amount: moneyFixture(69),
        },
      },
    ]);
  });

  it("uses cap history to charge only the remaining global cap amount", () => {
    const adjustments = applyTimeCapPricing({
      config: {
        id: "cap.global",
        pricingConfigId: "cap-config",
        includedPricingConfigIds: ["pricing-base"],
        paidHistory: {
          "cap-config@day@2026-07-09T02:00:00.000Z": moneyFixture(60),
        },
        rules: [
          {
            id: "day",
            label: "日场全局封顶",
            priority: 1,
            timeRange: { start: "10:00", end: "22:00" },
            priceCap: 69,
          },
        ],
        timeZone: "Asia/Shanghai",
      },
      chargeItems: [
        {
          id: "session-2:base",
          source: "time.base",
          label: "音游",
          amount: moneyFixture(24),
          period: {
            startedAt: new Date("2026-07-09T06:00:00.000Z"),
            endedAt: new Date("2026-07-09T08:00:00.000Z"),
          },
          pricingHistory: {
            pricingConfigId: "pricing-base",
            providerId: "time.base",
            ruleId: "day",
            ruleAnchorAt: new Date("2026-07-09T02:00:00.000Z"),
            amount: moneyFixture(24),
          },
        },
      ],
    });

    expect(adjustments.map((adjustment) => ({
      amount: adjustment.amount,
      historyAmount: adjustment.pricingCapHistory?.amount,
    }))).toEqual([
      {
        amount: moneyFixture(-15),
        historyAmount: moneyFixture(9),
      },
    ]);
  });
});

describe("createPriorityTimePricingProvider", () => {
  it("allows negative unit prices for additive discount sessions", async () => {
    const provider = createPriorityTimePricingProvider({
      id: "time.mahjong-discount",
      rules: [
        {
          id: "table-b",
          label: "八口麻将抵扣",
          priority: 1,
          timeRange: { start: "00:00", end: "00:00" },
          pricing: {
            unitMinutes: 60,
            unitPrice: -2,
            roundGraceMinutes: 0,
            priceCap: 0,
          },
        },
      ],
    });

    const chargeItems = await provider.quote({
      session: {
        id: "session-mahjong-b",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:30:00.000Z"),
        status: "closed",
      },
      assetHoldings: [],
      now: new Date("2026-06-07T10:30:00.000Z"),
    });

    expect(publicChargeItems(chargeItems)).toEqual([
      {
        id: "session-mahjong-b:time.mahjong-discount:table-b:2026-06-07T10:00:00.000Z",
        source: "time.mahjong-discount",
        label: "八口麻将抵扣",
        amount: -2,
      },
    ]);
  });

  it("handles first grace invalidation on machine operation in priority provider", async () => {
    const provider = createPriorityTimePricingProvider({
      id: "time.priority",
      rules: [
        {
          id: "default",
          label: "Standard",
          priority: 1,
          timeRange: { start: "00:00", end: "00:00" },
          pricing: {
            unitMinutes: 30,
            unitPrice: 15,
            roundGraceMinutes: 5,
            priceCap: 100,
          },
        },
      ],
    });

    // 1. Without device action, 3 minutes is free
    const freeItems = await provider.quote({
      session: {
        id: "session-free",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:03:00.000Z"),
        status: "closed",
      },
      assetHoldings: [],
      now: new Date("2026-06-07T10:03:00.000Z"),
    });
    expect(freeItems[0].amount).toBe(moneyFixture(0));

    // 2. With device action, 3 minutes charges 1 unit (15)
    const operated3m = await provider.quote({
      session: {
        id: "session-op-3m",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:03:00.000Z"),
        status: "closed",
        metadata: { deviceOperated: true },
      },
      assetHoldings: [],
      now: new Date("2026-06-07T10:03:00.000Z"),
    });
    expect(operated3m[0].amount).toBe(moneyFixture(15));

    // 3. With device action, instant logout (0 min) charges 1 unit (15)
    const operated0m = await provider.quote({
      session: {
        id: "session-op-0m",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:00:00.000Z"),
        status: "closed",
        metadata: { deviceOperated: true },
      },
      assetHoldings: [],
      now: new Date("2026-06-07T10:00:00.000Z"),
    });
    expect(operated0m[0].amount).toBe(moneyFixture(15));

    // 4. With device action, 32 minutes (30 min unit + 2 min extra, within 5 min roundGraceMinutes) charges 1 unit (15), not 2 units
    const operated32m = await provider.quote({
      session: {
        id: "session-op-32m",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:32:00.000Z"),
        status: "closed",
        metadata: { deviceOperated: true },
      },
      assetHoldings: [],
      now: new Date("2026-06-07T10:32:00.000Z"),
    });
    expect(operated32m[0].amount).toBe(moneyFixture(15));
  });

  it("splits charges when a higher priority rule starts", async () => {
    const provider = createPriorityTimePricingProvider({
      id: "time.priority",
      rules: [
        {
          id: "day",
          label: "Day rule",
          priority: 1,
          timeRange: { start: "08:00", end: "22:00" },
          pricing: {
            unitMinutes: 60,
            unitPrice: 10,
            roundGraceMinutes: 0,
            priceCap: 100,
          },
        },
        {
          id: "evening",
          label: "Evening peak",
          priority: 10,
          timeRange: { start: "20:00", end: "24:00" },
          pricing: {
            unitMinutes: 60,
            unitPrice: 20,
            roundGraceMinutes: 0,
            priceCap: 100,
          },
        },
      ],
    });

    const chargeItems = await provider.quote({
      session: {
        id: "session-1",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T19:00:00.000Z"),
        endedAt: new Date("2026-06-07T21:00:00.000Z"),
        status: "closed",
      },
      assetHoldings: [],
      now: new Date("2026-06-07T21:00:00.000Z"),
    });

    expect(publicChargeItems(chargeItems)).toEqual([
      {
        id: "session-1:time.priority:day:2026-06-07T19:00:00.000Z",
        source: "time.priority",
        label: "Day rule",
        amount: 10,
      },
      {
        id: "session-1:time.priority:evening:2026-06-07T20:00:00.000Z",
        source: "time.priority",
        label: "Evening peak",
        amount: 20,
      },
    ]);
  });

  it("quotes cross-day time ranges", async () => {
    const provider = createPriorityTimePricingProvider({
      id: "time.priority",
      rules: [
        {
          id: "night",
          label: "Night rule",
          priority: 1,
          timeRange: { start: "22:00", end: "08:00" },
          pricing: {
            unitMinutes: 60,
            unitPrice: 3,
            roundGraceMinutes: 0,
            priceCap: 20,
          },
        },
      ],
    });

    const chargeItems = await provider.quote({
      session: {
        id: "session-2",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T23:00:00.000Z"),
        endedAt: new Date("2026-06-08T01:00:00.000Z"),
        status: "closed",
      },
      assetHoldings: [],
      now: new Date("2026-06-08T01:00:00.000Z"),
    });

    expect(publicChargeItems(chargeItems)).toEqual([
      {
        id: "session-2:time.priority:night:2026-06-07T23:00:00.000Z",
        source: "time.priority",
        label: "Night rule",
        amount: 6,
      },
    ]);
  });

  it("skips non-billable gaps when a session crosses closed hours", async () => {
    const provider = createPriorityTimePricingProvider({
      id: "time.priority",
      rules: [
        {
          id: "business-hours",
          label: "营业时段",
          priority: 1,
          timeRange: { start: "10:00", end: "22:00" },
          pricing: {
            unitMinutes: 60,
            unitPrice: 10,
            roundGraceMinutes: 0,
            priceCap: 100,
          },
        },
      ],
    });

    const chargeItems = await provider.quote({
      session: {
        id: "session-gap",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T09:00:00.000Z"),
        endedAt: new Date("2026-06-07T11:00:00.000Z"),
        status: "closed",
      },
      assetHoldings: [],
      now: new Date("2026-06-07T11:00:00.000Z"),
    });

    expect(publicChargeItems(chargeItems)).toEqual([
      {
        id: "session-gap:time.priority:business-hours:2026-06-07T10:00:00.000Z",
        source: "time.priority",
        label: "营业时段",
        amount: 10,
      },
    ]);
  });

  it("matches cross-day weekday rules by the rule start day", async () => {
    const provider = createPriorityTimePricingProvider({
      id: "time.priority",
      timeZone: "Asia/Tokyo",
      rules: [
        {
          id: "default",
          label: "Default",
          priority: 0,
          timeRange: { start: "00:00", end: "00:00" },
          pricing: {
            unitMinutes: 60,
            unitPrice: 10,
            roundGraceMinutes: 0,
            priceCap: 100,
          },
        },
        {
          id: "saturday-night",
          label: "Saturday night",
          priority: 10,
          weekdays: [6],
          timeRange: { start: "22:00", end: "08:00" },
          pricing: {
            unitMinutes: 60,
            unitPrice: 3,
            roundGraceMinutes: 0,
            priceCap: 100,
          },
        },
      ],
    });

    const chargeItems = await provider.quote({
      session: {
        id: "session-weekday-cross-day",
        playerId: "player-1",
        startedAt: new Date("2026-06-06T15:30:00.000Z"),
        endedAt: new Date("2026-06-06T17:30:00.000Z"),
        status: "closed",
      },
      assetHoldings: [],
      now: new Date("2026-06-06T17:30:00.000Z"),
    });

    expect(publicChargeItems(chargeItems)).toEqual([
      {
        id: "session-weekday-cross-day:time.priority:saturday-night:2026-06-06T15:30:00.000Z",
        source: "time.priority",
        label: "Saturday night",
        amount: 6,
      },
    ]);
  });

  it("matches weekday-specific rules before default rules", async () => {
    const provider = createPriorityTimePricingProvider({
      id: "time.priority",
      rules: [
        {
          id: "default",
          label: "Default day",
          priority: 1,
          timeRange: { start: "08:00", end: "20:00" },
          pricing: {
            unitMinutes: 60,
            unitPrice: 5,
            roundGraceMinutes: 0,
            priceCap: 50,
          },
        },
        {
          id: "weekend",
          label: "Weekend day",
          priority: 10,
          weekdays: [0, 6],
          timeRange: { start: "08:00", end: "20:00" },
          pricing: {
            unitMinutes: 60,
            unitPrice: 8,
            roundGraceMinutes: 0,
            priceCap: 60,
          },
        },
      ],
    });

    const chargeItems = await provider.quote({
      session: {
        id: "session-3",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T12:00:00.000Z"),
        status: "closed",
      },
      assetHoldings: [],
      now: new Date("2026-06-07T12:00:00.000Z"),
    });

    expect(publicChargeItems(chargeItems)).toEqual([
      {
        id: "session-3:time.priority:weekend:2026-06-07T10:00:00.000Z",
        source: "time.priority",
        label: "Weekend day",
        amount: 16,
      },
    ]);
  });

  it("keeps archived priority rules out of settlement quotes", async () => {
    const provider = createPriorityTimePricingProvider({
      id: "time.priority",
      rules: [
        {
          id: "default",
          label: "Default day",
          priority: 0,
          timeRange: { start: "00:00", end: "00:00" },
          pricing: {
            unitMinutes: 60,
            unitPrice: 5,
            roundGraceMinutes: 0,
            priceCap: 100,
          },
        },
        {
          id: "old-event",
          label: "Archived event",
          priority: 100,
          status: "archived",
          timeRange: { start: "10:00", end: "12:00" },
          pricing: {
            unitMinutes: 60,
            unitPrice: 99,
            roundGraceMinutes: 0,
            priceCap: 999,
          },
        },
      ],
    });

    const chargeItems = await provider.quote({
      session: {
        id: "session-archived-rule",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T12:00:00.000Z"),
        status: "closed",
      },
      assetHoldings: [],
      now: new Date("2026-06-07T12:00:00.000Z"),
    });

    expect(publicChargeItems(chargeItems)).toEqual([
      {
        id: "session-archived-rule:time.priority:default:2026-06-07T10:00:00.000Z",
        source: "time.priority",
        label: "Default day",
        amount: 10,
      },
    ]);
  });

  it("skips weekday-specific rules on non-matching days", async () => {
    const provider = createPriorityTimePricingProvider({
      id: "time.priority",
      rules: [
        {
          id: "default",
          label: "Default day",
          priority: 1,
          timeRange: { start: "08:00", end: "20:00" },
          pricing: {
            unitMinutes: 60,
            unitPrice: 5,
            roundGraceMinutes: 0,
            priceCap: 50,
          },
        },
        {
          id: "weekend",
          label: "Weekend day",
          priority: 10,
          weekdays: [0, 6],
          timeRange: { start: "08:00", end: "20:00" },
          pricing: {
            unitMinutes: 60,
            unitPrice: 8,
            roundGraceMinutes: 0,
            priceCap: 60,
          },
        },
      ],
    });

    const chargeItems = await provider.quote({
      session: {
        id: "session-4",
        playerId: "player-1",
        startedAt: new Date("2026-06-08T10:00:00.000Z"),
        endedAt: new Date("2026-06-08T12:00:00.000Z"),
        status: "closed",
      },
      assetHoldings: [],
      now: new Date("2026-06-08T12:00:00.000Z"),
    });

    expect(publicChargeItems(chargeItems)).toEqual([
      {
        id: "session-4:time.priority:default:2026-06-08T10:00:00.000Z",
        source: "time.priority",
        label: "Default day",
        amount: 10,
      },
    ]);
  });

  it("matches specific-date rules before default rules", async () => {
    const provider = createPriorityTimePricingProvider({
      id: "time.priority",
      rules: [
        {
          id: "default",
          label: "Default day",
          priority: 1,
          timeRange: { start: "08:00", end: "20:00" },
          pricing: {
            unitMinutes: 60,
            unitPrice: 5,
            roundGraceMinutes: 0,
            priceCap: 50,
          },
        },
        {
          id: "event",
          label: "Event day",
          priority: 20,
          specificDates: ["2026-06-09"],
          timeRange: { start: "08:00", end: "20:00" },
          pricing: {
            unitMinutes: 60,
            unitPrice: 12,
            roundGraceMinutes: 0,
            priceCap: 100,
          },
        },
      ],
    });

    const chargeItems = await provider.quote({
      session: {
        id: "session-5",
        playerId: "player-1",
        startedAt: new Date("2026-06-09T10:00:00.000Z"),
        endedAt: new Date("2026-06-09T12:00:00.000Z"),
        status: "closed",
      },
      assetHoldings: [],
      now: new Date("2026-06-09T12:00:00.000Z"),
    });

    expect(publicChargeItems(chargeItems)).toEqual([
      {
        id: "session-5:time.priority:event:2026-06-09T10:00:00.000Z",
        source: "time.priority",
        label: "Event day",
        amount: 24,
      },
    ]);
  });

  it("respects paid history for capped rule windows", async () => {
    const provider = createPriorityTimePricingProvider({
      id: "time.priority",
      paidHistory: {
        "time.priority@time.priority@day@2026-06-07T08:00:00.000Z": moneyFixture(15),
      },
      rules: [
        {
          id: "day",
          label: "Day rule",
          priority: 1,
          timeRange: { start: "08:00", end: "20:00" },
          pricing: {
            unitMinutes: 60,
            unitPrice: 10,
            roundGraceMinutes: 0,
            priceCap: 20,
          },
        },
      ],
    });

    const chargeItems = await provider.quote({
      session: {
        id: "session-6",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T11:00:00.000Z"),
        status: "closed",
      },
      assetHoldings: [],
      now: new Date("2026-06-07T11:00:00.000Z"),
    });

    expect(publicChargeItems(chargeItems)).toEqual([
      {
        id: "session-6:time.priority:day:2026-06-07T10:00:00.000Z",
        source: "time.priority",
        label: "Day rule",
        amount: 5,
      },
    ]);
    expect(chargeItems[0]?.pricingHistory).toEqual({
      pricingConfigId: "time.priority",
      providerId: "time.priority",
      ruleId: "day",
      ruleAnchorAt: new Date("2026-06-07T08:00:00.000Z"),
      amount: moneyFixture(5),
    });
  });

  it("accumulates capped history inside one quote when higher priority rules split the same rule anchor", async () => {
    const provider = createPriorityTimePricingProvider({
      id: "time.priority",
      timeZone: "Asia/Tokyo",
      rules: [
        {
          id: "day",
          label: "日间",
          priority: 1,
          timeRange: { start: "10:00", end: "22:00" },
          pricing: {
            unitMinutes: 30,
            unitPrice: 4,
            roundGraceMinutes: 0,
            priceCap: 40,
          },
        },
        {
          id: "event",
          label: "临时活动",
          priority: 10,
          dateTimeRange: {
            start: new Date("2026-06-07T04:00:00.000Z"),
            end: new Date("2026-06-07T05:00:00.000Z"),
          },
          pricing: {
            unitMinutes: 30,
            unitPrice: 99,
            roundGraceMinutes: 0,
            priceCap: 999,
          },
        },
      ],
    });

    const chargeItems = await provider.quote({
      session: {
        id: "session-internal-history",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T01:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:00:00.000Z"),
        status: "closed",
      },
      assetHoldings: [],
      now: new Date("2026-06-07T10:00:00.000Z"),
    });

    expect(publicChargeItems(chargeItems)).toEqual([
      {
        id: "session-internal-history:time.priority:day:2026-06-07T01:00:00.000Z",
        source: "time.priority",
        label: "日间",
        amount: 24,
      },
      {
        id: "session-internal-history:time.priority:event:2026-06-07T04:00:00.000Z",
        source: "time.priority",
        label: "临时活动",
        amount: 198,
      },
      {
        id: "session-internal-history:time.priority:day:2026-06-07T05:00:00.000Z",
        source: "time.priority",
        label: "日间",
        amount: 16,
      },
    ]);
  });

  it("matches absolute date-time range rules", async () => {
    const provider = createPriorityTimePricingProvider({
      id: "time.priority",
      rules: [
        {
          id: "default",
          label: "Default day",
          priority: 1,
          timeRange: { start: "08:00", end: "20:00" },
          pricing: {
            unitMinutes: 60,
            unitPrice: 5,
            roundGraceMinutes: 0,
            priceCap: 50,
          },
        },
        {
          id: "event-range",
          label: "Event range",
          priority: 100,
          dateTimeRange: {
            start: new Date("2026-06-07T10:30:00.000Z"),
            end: new Date("2026-06-07T11:30:00.000Z"),
          },
          pricing: {
            unitMinutes: 30,
            unitPrice: 20,
            roundGraceMinutes: 0,
            priceCap: 100,
          },
        },
      ],
    });

    const chargeItems = await provider.quote({
      session: {
        id: "session-7",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T12:00:00.000Z"),
        status: "closed",
      },
      assetHoldings: [],
      now: new Date("2026-06-07T12:00:00.000Z"),
    });

    expect(publicChargeItems(chargeItems)).toEqual([
      {
        id: "session-7:time.priority:default:2026-06-07T10:00:00.000Z",
        source: "time.priority",
        label: "Default day",
        amount: 5,
      },
      {
        id: "session-7:time.priority:event-range:2026-06-07T10:30:00.000Z",
        source: "time.priority",
        label: "Event range",
        amount: 40,
      },
      {
        id: "session-7:time.priority:default:2026-06-07T11:30:00.000Z",
        source: "time.priority",
        label: "Default day",
        amount: 5,
      },
    ]);
  });

  it("uses date-time range rules only inside their configured clock range and falls back at the end boundary", async () => {
    const provider = createPriorityTimePricingProvider({
      id: "time.priority",
      timeZone: "Asia/Tokyo",
      rules: [
        {
          id: "day",
          label: "标准日间",
          priority: 1,
          timeRange: { start: "10:00", end: "22:00" },
          pricing: {
            unitMinutes: 30,
            unitPrice: 4,
            roundGraceMinutes: 0,
            priceCap: 40,
          },
        },
        {
          id: "night",
          label: "标准夜间",
          priority: 1,
          timeRange: { start: "22:00", end: "10:00" },
          pricing: {
            unitMinutes: 30,
            unitPrice: 4,
            roundGraceMinutes: 0,
            priceCap: 40,
          },
        },
        {
          id: "spring-day",
          label: "春节日间",
          priority: 20,
          dateTimeRange: {
            start: new Date("2026-02-17T00:00:00.000+09:00"),
            end: new Date("2026-03-03T20:00:00.000+09:00"),
          },
          timeRange: { start: "10:00", end: "22:00" },
          pricing: {
            unitMinutes: 30,
            unitPrice: 3,
            roundGraceMinutes: 0,
            priceCap: 30,
          },
        },
        {
          id: "spring-night",
          label: "春节夜间",
          priority: 20,
          dateTimeRange: {
            start: new Date("2026-02-17T00:00:00.000+09:00"),
            end: new Date("2026-03-03T20:00:00.000+09:00"),
          },
          timeRange: { start: "22:00", end: "10:00" },
          pricing: {
            unitMinutes: 30,
            unitPrice: 3,
            roundGraceMinutes: 0,
            priceCap: 30,
          },
        },
      ],
    });

    const beforeFestival = await provider.quote({
        session: {
          id: "session-before-festival",
          playerId: "player-1",
          startedAt: new Date("2026-02-16T02:00:00.000Z"),
          endedAt: new Date("2026-02-16T03:00:00.000Z"),
          status: "closed",
        },
        assetHoldings: [],
        now: new Date("2026-02-16T03:00:00.000Z"),
      });
    expect(beforeFestival).toMatchObject([
      {
        label: "标准日间",
        amount: moneyFixture(8),
      },
    ]);

    const duringFestivalDay = await provider.quote({
        session: {
          id: "session-during-festival-day",
          playerId: "player-1",
          startedAt: new Date("2026-02-17T02:00:00.000Z"),
          endedAt: new Date("2026-02-17T03:00:00.000Z"),
          status: "closed",
        },
        assetHoldings: [],
        now: new Date("2026-02-17T03:00:00.000Z"),
      });
    expect(duringFestivalDay).toMatchObject([
      {
        label: "春节日间",
        amount: moneyFixture(6),
      },
    ]);

    const duringFestivalNight = await provider.quote({
        session: {
          id: "session-during-festival-night",
          playerId: "player-1",
          startedAt: new Date("2026-02-17T14:00:00.000Z"),
          endedAt: new Date("2026-02-17T15:00:00.000Z"),
          status: "closed",
        },
        assetHoldings: [],
        now: new Date("2026-02-17T15:00:00.000Z"),
      });
    expect(duringFestivalNight).toMatchObject([
      {
        label: "春节夜间",
        amount: moneyFixture(6),
      },
    ]);

    const afterFestivalBoundary = await provider.quote({
        session: {
          id: "session-after-festival-boundary",
          playerId: "player-1",
          startedAt: new Date("2026-03-03T11:00:00.000Z"),
          endedAt: new Date("2026-03-03T12:00:00.000Z"),
          status: "closed",
        },
        assetHoldings: [],
        now: new Date("2026-03-03T12:00:00.000Z"),
      });
    expect(afterFestivalBoundary).toMatchObject([
      {
        label: "标准日间",
        amount: moneyFixture(8),
      },
    ]);
  });

  it("keeps non-business gaps closed around limited event coverage", async () => {
    const provider = createPriorityTimePricingProvider({
      id: "time.priority",
      timeZone: "Asia/Tokyo",
      rules: [
        {
          id: "business-hours",
          label: "标准营业",
          priority: 1,
          timeRange: { start: "10:00", end: "22:00" },
          pricing: {
            unitMinutes: 60,
            unitPrice: 10,
            roundGraceMinutes: 0,
            priceCap: 100,
          },
        },
        {
          id: "spring-business-hours",
          label: "春节营业",
          priority: 20,
          dateTimeRange: {
            start: new Date("2026-02-17T00:00:00.000+09:00"),
            end: new Date("2026-03-03T20:00:00.000+09:00"),
          },
          timeRange: { start: "10:00", end: "22:00" },
          pricing: {
            unitMinutes: 60,
            unitPrice: 6,
            roundGraceMinutes: 0,
            priceCap: 60,
          },
        },
      ],
    });

    const openedDuringEvent = await provider.quote({
      session: {
        id: "session-event-open-gap",
        playerId: "player-1",
        startedAt: new Date("2026-02-17T09:00:00.000+09:00"),
        endedAt: new Date("2026-02-17T11:00:00.000+09:00"),
        status: "closed",
      },
      assetHoldings: [],
      now: new Date("2026-02-17T11:00:00.000+09:00"),
    });
    expect(publicChargeItems(openedDuringEvent)).toEqual([
      {
        id: "session-event-open-gap:time.priority:spring-business-hours:2026-02-17T01:00:00.000Z",
        source: "time.priority",
        label: "春节营业",
        amount: 6,
      },
    ]);

    const closedAfterBusinessHours = await provider.quote({
      session: {
        id: "session-event-closed-gap",
        playerId: "player-1",
        startedAt: new Date("2026-02-17T22:00:00.000+09:00"),
        endedAt: new Date("2026-02-17T23:00:00.000+09:00"),
        status: "closed",
      },
      assetHoldings: [],
      now: new Date("2026-02-17T23:00:00.000+09:00"),
    });
    expect(closedAfterBusinessHours).toEqual([]);

    const afterEventEnd = await provider.quote({
      session: {
        id: "session-event-ended",
        playerId: "player-1",
        startedAt: new Date("2026-03-03T20:00:00.000+09:00"),
        endedAt: new Date("2026-03-03T21:00:00.000+09:00"),
        status: "closed",
      },
      assetHoldings: [],
      now: new Date("2026-03-03T21:00:00.000+09:00"),
    });
    expect(publicChargeItems(afterEventEnd)).toEqual([
      {
        id: "session-event-ended:time.priority:business-hours:2026-03-03T11:00:00.000Z",
        source: "time.priority",
        label: "标准营业",
        amount: 10,
      },
    ]);
  });

  it("matches clock ranges and weekdays in the configured store time zone", async () => {
    const provider = createPriorityTimePricingProvider({
      id: "time.priority",
      timeZone: "Asia/Tokyo",
      rules: [
        {
          id: "default",
          label: "Default",
          priority: 0,
          timeRange: { start: "00:00", end: "00:00" },
          pricing: {
            unitMinutes: 30,
            unitPrice: 5,
            roundGraceMinutes: 0,
            priceCap: 100,
          },
        },
        {
          id: "evening",
          label: "Evening peak",
          priority: 10,
          weekdays: [0],
          timeRange: { start: "20:00", end: "22:00" },
          pricing: {
            unitMinutes: 30,
            unitPrice: 20,
            roundGraceMinutes: 0,
            priceCap: 100,
          },
        },
      ],
    });

    const chargeItems = await provider.quote({
      session: {
        id: "session-8",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:30:00.000Z"),
        endedAt: new Date("2026-06-07T12:30:00.000Z"),
        status: "closed",
      },
      assetHoldings: [],
      now: new Date("2026-06-07T12:30:00.000Z"),
    });

    expect(publicChargeItems(chargeItems)).toEqual([
      {
        id: "session-8:time.priority:default:2026-06-07T10:30:00.000Z",
        source: "time.priority",
        label: "Default",
        amount: 5,
      },
      {
        id: "session-8:time.priority:evening:2026-06-07T11:00:00.000Z",
        source: "time.priority",
        label: "Evening peak",
        amount: 60,
      },
    ]);
  });

  it("builds a graphical day timeline from priority rules in the store time zone", () => {
    const timeline = buildPriorityTimePricingTimeline({
      localDate: "2026-06-07",
      config: {
        id: "time.priority",
        timeZone: "Asia/Tokyo",
        rules: [
          {
            id: "default",
            label: "Default",
            priority: 0,
            timeRange: { start: "00:00", end: "00:00" },
            pricing: {
              unitMinutes: 30,
              unitPrice: 5,
              roundGraceMinutes: 0,
              priceCap: 100,
            },
          },
          {
            id: "morning",
            label: "Morning",
            priority: 5,
            timeRange: { start: "08:00", end: "12:00" },
            pricing: {
              unitMinutes: 30,
              unitPrice: 8,
              roundGraceMinutes: 0,
              priceCap: 100,
            },
          },
          {
            id: "evening",
            label: "Evening peak",
            priority: 10,
            weekdays: [0],
            timeRange: { start: "20:00", end: "22:00" },
            pricing: {
              unitMinutes: 30,
              unitPrice: 20,
              roundGraceMinutes: 0,
              priceCap: 100,
            },
          },
        ],
      },
    });

    expect(timeline).toMatchObject({
      localDate: "2026-06-07",
      timeZone: "Asia/Tokyo",
      segments: [
        {
          ruleId: "default",
          startMinute: 0,
          endMinute: 480,
          startLabel: "00:00",
          endLabel: "08:00",
        },
        {
          ruleId: "morning",
          startMinute: 480,
          endMinute: 720,
          startLabel: "08:00",
          endLabel: "12:00",
        },
        {
          ruleId: "default",
          startMinute: 720,
          endMinute: 1200,
          startLabel: "12:00",
          endLabel: "20:00",
        },
        {
          ruleId: "evening",
          startMinute: 1200,
          endMinute: 1320,
          startLabel: "20:00",
          endLabel: "22:00",
        },
        {
          ruleId: "default",
          startMinute: 1320,
          endMinute: 1440,
          startLabel: "22:00",
          endLabel: "24:00",
        },
      ],
    });
  });

  it("includes closed gaps in the graphical day timeline when no rule is active", () => {
    const timeline = buildPriorityTimePricingTimeline({
      localDate: "2026-06-07",
      config: {
        id: "time.priority",
        timeZone: "Asia/Tokyo",
        rules: [
          {
            id: "business-hours",
            label: "营业时段",
            priority: 1,
            timeRange: { start: "10:00", end: "22:00" },
            pricing: {
              unitMinutes: 60,
              unitPrice: 10,
              roundGraceMinutes: 0,
              priceCap: 100,
            },
          },
        ],
      },
    });

    expect(timeline.segments).toMatchObject([
      {
        ruleId: "__closed__",
        label: "非营业",
        startMinute: 0,
        endMinute: 600,
      },
      {
        ruleId: "business-hours",
        label: "营业时段",
        startMinute: 600,
        endMinute: 1320,
      },
      {
        ruleId: "__closed__",
        label: "非营业",
        startMinute: 1320,
        endMinute: 1440,
      },
    ]);
  });

  it("shows non-business gaps around limited event segments on the graphical day timeline", () => {
    const timeline = buildPriorityTimePricingTimeline({
      localDate: "2026-02-17",
      config: {
        id: "time.priority",
        timeZone: "Asia/Tokyo",
        rules: [
          {
            id: "business-hours",
            label: "标准营业",
            priority: 1,
            timeRange: { start: "10:00", end: "22:00" },
            pricing: {
              unitMinutes: 60,
              unitPrice: 10,
              roundGraceMinutes: 0,
              priceCap: 100,
            },
          },
          {
            id: "spring-business-hours",
            label: "春节营业",
            priority: 20,
            dateTimeRange: {
              start: new Date("2026-02-17T00:00:00.000+09:00"),
              end: new Date("2026-03-03T20:00:00.000+09:00"),
            },
            timeRange: { start: "10:00", end: "22:00" },
            pricing: {
              unitMinutes: 60,
              unitPrice: 6,
              roundGraceMinutes: 0,
              priceCap: 60,
            },
          },
        ],
      },
    });

    expect(timeline.segments).toMatchObject([
      {
        ruleId: "__closed__",
        label: "非营业",
        startMinute: 0,
        endMinute: 600,
      },
      {
        ruleId: "spring-business-hours",
        label: "春节营业",
        startMinute: 600,
        endMinute: 1320,
      },
      {
        ruleId: "__closed__",
        label: "非营业",
        startMinute: 1320,
        endMinute: 1440,
      },
    ]);
  });

  it("keeps archived priority rules visible in config but out of the graphical timeline", () => {
    const timeline = buildPriorityTimePricingTimeline({
      localDate: "2026-06-07",
      config: {
        id: "time.priority",
        timeZone: "Asia/Tokyo",
        rules: [
          {
            id: "default",
            label: "Default",
            priority: 0,
            timeRange: { start: "00:00", end: "00:00" },
            pricing: {
              unitMinutes: 30,
              unitPrice: 5,
              roundGraceMinutes: 0,
              priceCap: 100,
            },
          },
          {
            id: "archived-peak",
            label: "Archived peak",
            priority: 10,
            status: "archived",
            timeRange: { start: "20:00", end: "22:00" },
            pricing: {
              unitMinutes: 30,
              unitPrice: 20,
              roundGraceMinutes: 0,
              priceCap: 100,
            },
          },
        ],
      },
    });

    expect(timeline.segments).toEqual([
      {
        ruleId: "default",
        label: "Default",
        priority: 0,
        startMinute: 0,
        endMinute: 1440,
        startLabel: "00:00",
        endLabel: "24:00",
        startedAt: "2026-06-06T15:00:00.000Z",
        endedAt: "2026-06-07T15:00:00.000Z",
        windowStartedAt: "2026-06-06T15:00:00.000Z",
        windowEndedAt: "2026-06-07T15:00:00.000Z",
        pricing: {
          unitMinutes: 30,
          unitPrice: 5,
          roundGraceMinutes: 0,
          priceCap: 100,
        },
      },
    ]);
  });

  it("shows the early-morning part of a cross-day weekday rule on the next day's timeline", () => {
    const timeline = buildPriorityTimePricingTimeline({
      localDate: "2026-06-07",
      config: {
        id: "time.priority",
        timeZone: "Asia/Tokyo",
        rules: [
          {
            id: "default",
            label: "Default",
            priority: 0,
            timeRange: { start: "00:00", end: "00:00" },
            pricing: {
              unitMinutes: 60,
              unitPrice: 10,
              roundGraceMinutes: 0,
              priceCap: 100,
            },
          },
          {
            id: "saturday-night",
            label: "Saturday night",
            priority: 10,
            weekdays: [6],
            timeRange: { start: "22:00", end: "08:00" },
            pricing: {
              unitMinutes: 60,
              unitPrice: 3,
              roundGraceMinutes: 0,
              priceCap: 100,
            },
          },
        ],
      },
    });

    expect(timeline.segments).toMatchObject([
      {
        ruleId: "saturday-night",
        startMinute: 0,
        endMinute: 480,
        startLabel: "00:00",
        endLabel: "08:00",
      },
      {
        ruleId: "default",
        startMinute: 480,
        endMinute: 1440,
        startLabel: "08:00",
        endLabel: "24:00",
      },
    ]);
  });
});

describe("a period cap of 0", () => {
  it("leaves the period uncapped instead of making it free", async () => {
    const quote = async (priceCap: number, paidBefore?: Cents) => {
      const provider = createPriorityTimePricingProvider({
        id: "mahjong",
        timeZone: "UTC",
        ...(paidBefore === undefined ? {} : { paidHistory: { "mahjong@mahjong@all-day@2026-06-07T00:00:00.000Z": paidBefore } }),
        rules: [{ id: "all-day", label: "全天", priority: 0, timeRange: { start: "00:00", end: "00:00" },
          pricing: { unitMinutes: 60, unitPrice: 10, roundGraceMinutes: 15, priceCap } }],
      });
      const items = await provider.quote({
        session: { id: "s", playerId: "p", startedAt: new Date("2026-06-07T10:00:00.000Z"), endedAt: new Date("2026-06-07T13:00:00.000Z"), status: "closed" },
        assetHoldings: [],
        now: new Date("2026-06-07T13:00:00.000Z"),
      });
      return items.map((item) => ({ amount: yuanOf(item.amount), reached: item.pricingExplanation?.intervalCapReached }));
    };
    expect(await quote(0)).toEqual([{ amount: 30, reached: false }]);
    expect(await quote(0, integerFixture(10_000))).toEqual([{ amount: 30, reached: false }]);
    expect(await quote(25)).toEqual([{ amount: 25, reached: true }]);
  });
});

describe("a day timeline", () => {
  it("keeps a cap that resets at 06:00 as two windows, and a 22:00–10:00 period as its two parts", () => {
    const cap = buildTimeCapPricingTimeline({
      localDate: "2026-06-07",
      config: { id: "daily", timeZone: "UTC", includedPricingConfigIds: ["p"],
        rules: [{ id: "day", label: "每日", priority: 0, timeRange: { start: "06:00", end: "06:00" }, priceCap: 60 }] },
    });
    expect(cap.segments.map((s) => [s.startLabel, s.endLabel, s.windowStartedAt, s.windowEndedAt])).toEqual([
      ["00:00", "06:00", "2026-06-06T06:00:00.000Z", "2026-06-07T06:00:00.000Z"],
      ["06:00", "24:00", "2026-06-07T06:00:00.000Z", "2026-06-08T06:00:00.000Z"],
    ]);

    const night = buildTimeCapPricingTimeline({
      localDate: "2026-06-07",
      config: { id: "night", timeZone: "UTC", includedPricingConfigIds: ["p"],
        rules: [{ id: "night", label: "夜间", priority: 0, timeRange: { start: "22:00", end: "10:00" }, priceCap: 30 }] },
    });
    expect(night.segments.map((s) => [s.ruleId, s.startLabel, s.endLabel, s.windowStartedAt ?? null])).toEqual([
      ["night", "00:00", "10:00", "2026-06-06T22:00:00.000Z"],
      ["__closed__", "10:00", "22:00", null],
      ["night", "22:00", "24:00", "2026-06-07T22:00:00.000Z"],
    ]);
  });
});

describe("a cap across plans", () => {
  it("counts each unit in the window it begins in, not the charge's time split", async () => {
    const provider = createPriorityTimePricingProvider({
      id: "rhythm", pricingConfigId: "rhythm", timeZone: "UTC",
      rules: [{ id: "all", label: "全天", priority: 0, timeRange: { start: "00:00", end: "00:00" }, pricing: { unitMinutes: 60, unitPrice: 3, roundGraceMinutes: 5, priceCap: 0 } }],
    });
    // 00:00–12:18: 12 whole hours and 18 minutes past the grace, 13 units, 39.00.
    const items = await provider.quote({
      session: { id: "s", playerId: "p", startedAt: new Date("2026-06-07T00:00:00.000Z"), status: "active" },
      assetHoldings: [], now: new Date("2026-06-07T12:18:00.000Z"),
    });
    const windows = explainTimeCapPricing({
      chargeItems: items,
      config: { id: "split", includedPricingConfigIds: ["rhythm"], timeZone: "UTC", rules: [
        { id: "night", label: "夜间", priority: 0, timeRange: { start: "22:00", end: "10:00" }, priceCap: 1000 },
        { id: "day", label: "日间", priority: 0, timeRange: { start: "10:00", end: "22:00" }, priceCap: 1000 },
      ] },
    });
    // Units begun 00:00–09:00 are the night's 10; 10:00, 11:00 and 12:00 the day's 3.
    expect(windows.map((w) => [w.ruleLabel, yuanOf(w.currentAmount)])).toEqual([["夜间", 30], ["日间", 9]]);
  });
});

describe("several caps across plans", () => {
  const hourly = (id: string, unitPrice: number) => createPriorityTimePricingProvider({
    id, pricingConfigId: id, timeZone: "UTC",
    rules: [{ id: "all", label: "全天", priority: 0, timeRange: { start: "00:00", end: "00:00" }, pricing: { unitMinutes: 60, unitPrice, roundGraceMinutes: 0, priceCap: 0 } }],
  });
  const quote = async (id: string, unitPrice: number, from: string, to: string) =>
    (await hourly(id, unitPrice).quote({
      session: { id: `s-${id}`, playerId: "p", startedAt: new Date(`2026-06-07T${from}:00.000Z`), status: "active" },
      assetHoldings: [], now: new Date(`2026-06-07T${to}:00.000Z`),
    })).map((item) => ({ ...item, sessionId: `s-${id}` }));
  const cap = (id: string, start: string, end: string, priceCap: number, plans = ["play"]) =>
    ({ id, includedPricingConfigIds: plans, timeZone: "UTC", rules: [{ id: "w", label: id, priority: 0, timeRange: { start, end }, priceCap }] });

  it("holds each unit back once, by the cap whose allowance ran out", async () => {
    // 10 an hour from 00:00 to 12:00: 120 before any cap.
    const items = await quote("play", 10, "00:00", "12:00");
    const night = cap("night", "22:00", "06:00", 30);
    const daily = cap("daily", "00:00", "00:00", 70);
    const { windows, adjustments } = settleTimeCaps({ configs: [night, daily], chargeItems: items });
    // 00–03 charged 30 and the night is full; 03–06 free; from 06 the daily has 40 left: 06–10.
    const held = adjustments.reduce((sum, a) => sum + a.amount, 0);
    expect(yuanOf(-held as Cents)).toBe(50);
    expect(windows.map((w) => [w.capConfigId, yuanOf(w.amountApplied), yuanOf(w.heldBack!)])).toEqual([
      ["night", 30, 30],
      ["daily", 70, 20],
    ]);
    // Each cap alone holds back 30 and 50; adding them up, as before, charged 40 instead of 70.
    const alone = [night, daily].map((config) => applyTimeCapPricing({ config, chargeItems: items }).reduce((s, a) => s + a.amount, 0));
    expect(alone).toEqual([integerFixture(-3000), integerFixture(-5000)]);
  });

  it("with one cap, charges each window what it always has", async () => {
    const items = [...await quote("play", 10, "00:00", "05:00"), ...await quote("rest", 4, "01:00", "05:00")];
    for (const [paid, priceCap] of [[0, 35], [20, 35], [50, 35], [0, 500]] as const) {
      const config = { ...cap("one", "00:00", "00:00", priceCap, ["play", "rest"]), paidHistory: { "one@w@2026-06-07T00:00:00.000Z": integerFixture(paid * 100) } };
      const [window] = explainTimeCapPricing({ config, chargeItems: items });
      const current = 50 + 16;
      expect(yuanOf(window!.amountApplied)).toBe(paid >= priceCap ? 0 : Math.min(current, priceCap - paid));
    }
  });

  it("nets a discount in the window before holding anything back", async () => {
    const items = [...await quote("play", 10, "00:00", "04:00"), ...await quote("off", -5, "00:00", "04:00")];
    const [window] = explainTimeCapPricing({ config: cap("one", "00:00", "00:00", 25, ["play", "off"]), chargeItems: items });
    // 40 - 20 = 20 is under the cap: nothing is held back.
    expect([yuanOf(window!.currentAmount), yuanOf(window!.amountApplied), yuanOf(window!.heldBack!)]).toEqual([20, 20, 0]);
  });
});

describe("a period cap with a cap across plans", () => {
  it("counts only what was charged, so a unit the cap across plans let off leaves room in the period cap", async () => {
    const provider = createPriorityTimePricingProvider({
      id: "base", pricingConfigId: "base", timeZone: "UTC",
      rules: [{ id: "all", label: "全天", priority: 0, timeRange: { start: "00:00", end: "00:00" }, pricing: { unitMinutes: 60, unitPrice: 12, roundGraceMinutes: 5, priceCap: 60 } }],
    });
    const items = (await provider.quote({
      session: { id: "s", playerId: "p", startedAt: new Date("2026-06-07T14:20:00.000Z"), status: "active" },
      assetHoldings: [], now: new Date("2026-06-07T22:20:00.000Z"),
    })).map((item) => ({ ...item, sessionId: "s" }));
    // The quote counts the period cap on list prices: 8 units, 96, capped to 60.
    expect(items.reduce((sum, item) => sum + item.amount, 0)).toBe(integerFixture(6000));
    const { units, adjustments } = settleTimeCaps({
      configs: [{ id: "afternoon", includedPricingConfigIds: ["base"], timeZone: "UTC", rules: [{ id: "w", label: "下午", priority: 0, timeRange: { start: "14:00", end: "18:00" }, priceCap: 20 }] }],
      chargeItems: items,
    });
    // 14:20–17:20 inside the 20 cap: 12, 8, 0, 0. After it the period cap has 40 left: 12, 12, 12, 4.
    expect(units.map((u) => yuanOf(u.charged))).toEqual([12, 8, 0, 0, 12, 12, 12, 4]);
    expect(units.map((u) => u.heldBy)).toEqual([null, "afternoon@w@2026-06-07T14:00:00.000Z", "afternoon@w@2026-06-07T14:00:00.000Z", "afternoon@w@2026-06-07T14:00:00.000Z", null, null, null, "period"]);
    // Charged 60 in all, as the quote did: nothing is taken off the bill.
    expect(adjustments.reduce((sum, a) => sum + a.amount, 0)).toBe(0);
  });
});
