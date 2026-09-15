import { assetQuantityToNatural } from "@prism/core";
import { centsOf as moneyFixture, centsOfInteger as integerFixture } from "@prism/core";
import { centsOf, yuanOf } from "@prism/core";
import { describe, expect, it } from "bun:test";
import { createPrismNeoMigrationPlan } from "../src";

describe("createPrismNeoMigrationPlan", () => {
  it("preserves fractional wallet balances during migration", () => {
    const plan = createPrismNeoMigrationPlan({
      exportedAt: new Date("2026-09-12T00:00:00Z"),
      users: [{ id: 1, createdAt: new Date("2026-01-01T00:00:00Z"), isBanned: false }],
      assetDefinitions: [{ id: 1, type: "CURRENCY", assetId: 10001, name: "Balance", valid: true }],
      userAssets: [{ id: 1, userId: 1, assetDefId: 10001, assetType: "CURRENCY", count: 12.5 }],
    });
    expect(assetQuantityToNatural(plan.assetHoldings[0]?.assetType, plan.assetHoldings[0]?.quantity)).toBe(12.5);
  });

  it("maps legacy prism-neo exports into PRiSM Next domain records", () => {
    const plan = createPrismNeoMigrationPlan({
      exportedAt: new Date("2026-06-01T00:00:00.000Z"),
      users: [
        { id: 7, createdAt: new Date("2026-01-01T00:00:00.000Z"), isBanned: false },
        { id: 8, createdAt: new Date("2026-01-02T00:00:00.000Z"), isBanned: true },
      ],
      binds: [{ id: 31, userId: 7, type: "QQ", bid: "123456" }],
      assetDefinitions: [
        { id: 1, type: "CURRENCY", assetId: 10001, name: "Paid balance", valid: true },
        { id: 2, type: "CURRENCY", assetId: 10002, name: "Free balance", valid: true },
        {
          id: 3,
          type: "PASS",
          assetId: 10001,
          name: "Monthly pass",
          valid: true,
          billingEffect: { type: "FIXED_OFF", value: 10, consume: false },
        },
        { id: 4, type: "TITLE", assetId: 9, name: "Secret title", valid: false },
      ],
      userAssets: [
        {
          id: 101,
          userId: 7,
          assetDefId: 10001,
          assetType: "CURRENCY",
          count: 500,
          activeAt: null,
          expireAt: null,
          hide: false,
        },
        {
          id: 102,
          userId: 7,
          assetDefId: 10002,
          assetType: "CURRENCY",
          count: 200,
          activeAt: new Date("2026-01-01T00:00:00.000Z"),
          expireAt: new Date("2026-12-31T00:00:00.000Z"),
          hide: false,
        },
        {
          id: 103,
          userId: 7,
          assetDefId: 9,
          assetType: "TITLE",
          count: 1,
          activeAt: null,
          expireAt: null,
          hide: true,
        },
      ],
      userAssetLogs: [
        {
          id: 301,
          userId: 7,
          userAssetId: 101,
          assetId: 10001,
          assetType: "CURRENCY",
          changeAmount: -50,
          action: "DEDUCT_WALLET",
          comment: "checkout",
        },
      ],
      sessions: [
        {
          id: 51,
          userId: 7,
          createdAt: new Date("2026-01-03T10:00:00.000Z"),
          closedAt: new Date("2026-01-03T11:30:00.000Z"),
          isActive: null,
          billingCost: 120,
          finalCost: 90,
          costOverwrite: null,
        },
        {
          id: 52,
          userId: 8,
          createdAt: new Date("2026-01-03T12:00:00.000Z"),
          closedAt: null,
          isActive: true,
          billingCost: null,
          finalCost: null,
          costOverwrite: null,
        },
      ],
      billingRules: [
        {
          id: 2,
          name: "Night",
          available: true,
          priority: 20,
          matchDate: { weekdays: [5, 6] },
          timeRange: { start: "20:00", end: "04:00" },
          pricing: { unitMinutes: 30, unitPrice: 40, priceCap: 160, roundGraceMinutes: 5 },
        },
      ],
      billingRecords: [
        {
          id: 401,
          userId: 7,
          ruleId: 2,
          ruleStartTimeStamp: 1_767_225_600_000,
          cost: 90,
          billingStart: new Date("2026-01-03T10:00:00.000Z"),
          billingEnd: new Date("2026-01-03T11:30:00.000Z"),
          durationMin: 90,
        },
        {
          id: 402,
          userId: 7,
          ruleId: 2,
          ruleStartTimeStamp: 1_767_225_600_000,
          cost: 30,
          billingStart: new Date("2026-01-04T10:00:00.000Z"),
          billingEnd: new Date("2026-01-04T10:30:00.000Z"),
          durationMin: 30,
        },
      ],
      presents: [
        {
          id: 61,
          name: "Recharge pack",
          oncePerUser: true,
          body: [
            {
              assetType: "CURRENCY",
              assetId: 10001,
              count: 1000,
              mergeStrategy: "STACK",
              activeAt: null,
              expireAt: null,
            },
          ],
        },
      ],
      redeems: [
        {
          id: 71,
          code: "ABC123",
          presentId: 61,
          activeAt: new Date("2026-01-01T00:00:00.000Z"),
          expireAt: new Date("2026-12-31T00:00:00.000Z"),
          maxUseCount: 1,
        },
      ],
      redeemRecords: [
        {
          id: 81,
          userId: 7,
          redeemId: 71,
          presentId: 61,
          date: new Date("2026-01-04T00:00:00.000Z"),
        },
      ],
      coinRecords: [
        {
          id: 91,
          userId: 7,
          machineName: "mai-1",
          count: 2,
          createAt: new Date("2026-01-05T00:00:00.000Z"),
        },
      ],
    });

    expect(plan.players).toEqual([
      {
        id: "legacy:user:7",
        displayName: "Player 7",
        status: "active",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: "legacy:user:8",
        displayName: "Player 8",
        status: "banned",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    ]);
    expect(plan.playerIdentities).toEqual([
      {
        playerId: "legacy:user:7",
        provider: "qq",
        subject: "123456",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    ]);
    expect(plan.assetDefinitions).toEqual([
      {
        type: "currency",
        code: "paid",
        name: "Paid balance",
        stackable: true,
        metadata: { legacy: { type: "CURRENCY", assetId: 10001, id: 1 }, valid: true },
      },
      {
        type: "currency",
        code: "free",
        name: "Free balance",
        stackable: true,
        metadata: { legacy: { type: "CURRENCY", assetId: 10002, id: 2 }, valid: true },
      },
      {
        type: "pass",
        code: "legacy.pass.10001",
        name: "Monthly pass",
        stackable: true,
        metadata: {
          billingEffect: { type: "FIXED_OFF", value: 10, consume: false },
          legacy: { type: "PASS", assetId: 10001, id: 3 },
          valid: true,
        },
      },
      {
        type: "title",
        code: "legacy.title.9",
        name: "Secret title",
        stackable: true,
        metadata: {
          hiddenFromPlayer: true,
          legacy: { type: "TITLE", assetId: 9, id: 4 },
          valid: false,
        },
      },
    ]);
    expect(plan.assetHoldings).toContainEqual({
      id: "legacy:user-asset:102",
      playerId: "legacy:user:7",
      assetType: "currency",
      assetCode: "free",
      quantity: centsOf(200),
      activeAt: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt: new Date("2026-12-31T00:00:00.000Z"),
    });
    expect(plan.assetHoldings).toContainEqual({
      id: "legacy:user-asset:103",
      playerId: "legacy:user:7",
      assetType: "title",
      assetCode: "legacy.title.9",
      quantity: integerFixture(1),
      activeAt: null,
      expiresAt: null,
    });
    expect(plan.assetLedgerEntries).toContainEqual({
      id: "legacy:user-asset-log:301",
      playerId: "legacy:user:7",
      assetType: "currency",
      assetCode: "paid",
      delta: centsOf(-50),
      reason: "legacy.DEDUCT_WALLET",
      refId: "legacy:user-asset:101",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(plan.sessions).toEqual([
      {
        id: "legacy:session:51",
        playerId: "legacy:user:7",
        startedAt: new Date("2026-01-03T10:00:00.000Z"),
        endedAt: new Date("2026-01-03T11:30:00.000Z"),
        status: "closed",
        paymentStatus: "paid",
      },
      {
        id: "legacy:session:52",
        playerId: "legacy:user:8",
        startedAt: new Date("2026-01-03T12:00:00.000Z"),
        status: "active",
        paymentStatus: "unpaid",
      },
    ]);
    expect(plan.settlements).toEqual([
      {
        settlement: {
          sessionId: "legacy:session:51",
          subtotal: centsOf(120),
          total: centsOf(90),
          status: "settled",
          settledAt: new Date("2026-01-03T11:30:00.000Z"),
        },
        chargeItems: [
          {
            id: "legacy:billing-record:401",
            source: "legacy.billing-rule.2",
            label: "Legacy billing record 401",
            amount: moneyFixture(90),
          },
        ],
        adjustments: [
          {
            id: "legacy:session-cost-delta:51",
            source: "legacy.session",
            label: "Legacy final cost delta",
            amount: moneyFixture(-30),
          },
        ],
      },
    ]);
    expect(plan.pricingConfigs[0]).toMatchObject({
      id: "legacy:pricing-config:time-priority",
      kind: "time.priority",
      enabled: false,
      provider: {
        id: "legacy.time-priority",
        rules: [
          {
            id: "legacy.rule.2",
            label: "Night",
            priority: 20,
            weekdays: [5, 6],
            timeRange: { start: "20:00", end: "04:00" },
            pricing: { unitMinutes: 30, unitPrice: 40, priceCap: 160, roundGraceMinutes: 5 },
          },
        ],
      },
    });
    expect(plan.pricingHistoryEntries).toEqual([
      {
        id: "legacy:billing-record:401",
        playerId: "legacy:user:7",
        pricingConfigId: "legacy:pricing-config:time-priority",
        providerId: "legacy.time-priority",
        ruleId: "legacy.rule.2",
        ruleAnchorAt: new Date("2026-01-01T00:00:00.000Z"),
        sessionId: "legacy:billing-record:401",
        amount: moneyFixture(90),
        createdAt: new Date("2026-01-03T11:30:00.000Z"),
        metadata: {
          legacy: {
            billingStart: "2026-01-03T10:00:00.000Z",
            billingEnd: "2026-01-03T11:30:00.000Z",
            durationMin: 90,
            ruleStartTimeStamp: 1_767_225_600_000,
          },
        },
      },
      {
        id: "legacy:billing-record:402",
        playerId: "legacy:user:7",
        pricingConfigId: "legacy:pricing-config:time-priority",
        providerId: "legacy.time-priority",
        ruleId: "legacy.rule.2",
        ruleAnchorAt: new Date("2026-01-01T00:00:00.000Z"),
        sessionId: "legacy:billing-record:402",
        amount: moneyFixture(30),
        createdAt: new Date("2026-01-04T10:30:00.000Z"),
        metadata: {
          legacy: {
            billingStart: "2026-01-04T10:00:00.000Z",
            billingEnd: "2026-01-04T10:30:00.000Z",
            durationMin: 30,
            ruleStartTimeStamp: 1_767_225_600_000,
          },
        },
      },
    ]);
    expect(plan.presents).toEqual([
      {
        id: "legacy:present:61",
        name: "Recharge pack",
        oncePerPlayer: true,
        grants: [
          {
            assetType: "currency",
            assetCode: "paid",
            amount: 1000,
            mergeStrategy: "stack",
            activeAt: null,
            expiresAt: null,
          },
        ],
      },
    ]);
    expect(plan.redeemCodes).toEqual([
      {
        id: "legacy:redeem:71",
        code: "ABC123",
        presentId: "legacy:present:61",
        activeAt: new Date("2026-01-01T00:00:00.000Z"),
        expiresAt: new Date("2026-12-31T00:00:00.000Z"),
        maxUseCount: 1,
      },
    ]);
    expect(plan.redeemRecords).toEqual([
      {
        playerId: "legacy:user:7",
        codeId: "legacy:redeem:71",
        presentId: "legacy:present:61",
        redeemedAt: new Date("2026-01-04T00:00:00.000Z"),
      },
    ]);
    expect(plan.deviceCommands).toEqual([
      {
        id: "legacy:coin-record:91",
        type: "coin",
        deviceId: "mai-1",
        targetKind: "game_machine",
        executorKind: "machine_ws",
        playerId: "legacy:user:7",
        status: "acked",
        payload: { count: 2, legacyCoinRecordId: 91 },
        requestedAt: new Date("2026-01-05T00:00:00.000Z"),
        ackedAt: new Date("2026-01-05T00:00:00.000Z"),
      },
    ]);
  });
});
