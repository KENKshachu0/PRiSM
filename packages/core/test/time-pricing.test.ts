import { type Cents, yuanOf, centsOf as moneyFixture, centsOfInteger as integerFixture } from "@prism/core";
import { describe, expect, it } from "bun:test";
import {
  applyTimeCapPricing,
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
