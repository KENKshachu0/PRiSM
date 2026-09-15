import { assetQuantityToNatural } from "@prism/core";
import { centsOf as moneyFixture, centsOfInteger as integerFixture } from "@prism/core";
import { ZERO_CENTS, centsOf, yuanOf } from "@prism/core";
import { describe, expect, it } from "bun:test";
import {
  adjustAssets,
  diffAssetHoldings,
  evaluateAssetHoldingAvailability,
  grantAssets,
  sumCurrencyHoldings,
} from "../src/index";

describe("grantAssets", () => {
  it("stacks decimal balances without rounding", () => {
    const result = grantAssets({
      playerId: "player-1",
      existingHoldings: [
        {
          id: "asset-1",
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: centsOf(10.25),
          activeAt: null,
          expiresAt: null,
        },
      ],
      grants: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          amount: 2.75,
          mergeStrategy: "stack",
          activeAt: null,
          expiresAt: null,
          reason: "staff.asset.grant",
          refId: "staff-1",
        },
      ],
      idFactory: () => "asset-new",
    });

    expect(assetQuantityToNatural(result.holdings[0]?.assetType, result.holdings[0]?.quantity)).toBe(13);
    expect(assetQuantityToNatural(result.assetLedgerEntries[0]?.assetType, result.assetLedgerEntries[0]?.delta)).toBe(2.75);
  });

  it("stacks matching assets and emits ledger entries", () => {
    const result = grantAssets({
      playerId: "player-1",
      existingHoldings: [
        {
          id: "asset-1",
          assetType: "currency",
          assetCode: "currency.free",
          quantity: centsOf(5),
          activeAt: null,
          expiresAt: null,
        },
      ],
      grants: [
        {
          assetType: "currency",
          assetCode: "currency.free",
          amount: 7,
          mergeStrategy: "stack",
          activeAt: null,
          expiresAt: null,
          reason: "gift.redeem",
          refId: "redeem-1",
        },
      ],
      idFactory: () => "asset-new",
    });

    expect(result.holdings).toEqual([
      {
        id: "asset-1",
        assetType: "currency",
        assetCode: "currency.free",
        quantity: centsOf(12),
        activeAt: null,
        expiresAt: null,
      },
    ]);
    expect(result.assetLedgerEntries).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.free",
        delta: centsOf(7),
        reason: "gift.redeem",
        refId: "redeem-1",
      },
    ]);
  });

  it("creates a new asset when no stack target exists", () => {
    const result = grantAssets({
      playerId: "player-1",
      existingHoldings: [],
      grants: [
        {
          assetType: "ticket",
          assetCode: "coupon.fixed-5",
          amount: 1,
          mergeStrategy: "stack",
          activeAt: new Date("2026-06-07T00:00:00.000Z"),
          expiresAt: new Date("2026-07-07T00:00:00.000Z"),
          reason: "admin.grant",
          refId: "staff-1",
        },
      ],
      idFactory: () => "asset-new",
    });

    expect(result.holdings).toEqual([
      {
        id: "asset-new",
        assetType: "ticket",
        assetCode: "coupon.fixed-5",
        quantity: integerFixture(1),
        activeAt: new Date("2026-06-07T00:00:00.000Z"),
        expiresAt: new Date("2026-07-07T00:00:00.000Z"),
      },
    ]);
    expect(result.assetLedgerEntries).toEqual([
      {
        assetType: "ticket",
        assetCode: "coupon.fixed-5",
        delta: integerFixture(1),
        reason: "admin.grant",
        refId: "staff-1",
      },
    ]);
  });

  it("extends the latest matching asset expiration", () => {
    const result = grantAssets({
      playerId: "player-1",
      existingHoldings: [
        {
          id: "pass-1",
          assetType: "pass",
          assetCode: "monthly",
          quantity: integerFixture(1),
          activeAt: new Date("2026-06-01T00:00:00.000Z"),
          expiresAt: new Date("2026-06-10T00:00:00.000Z"),
        },
      ],
      grants: [
        {
          assetType: "pass",
          assetCode: "monthly",
          amount: 1,
          mergeStrategy: "extend-time",
          activeAt: null,
          expiresAt: null,
          durationMs: 7 * 24 * 60 * 60 * 1000,
          reason: "gift.redeem",
          refId: "redeem-2",
        },
      ],
      idFactory: () => "pass-new",
      now: new Date("2026-06-07T00:00:00.000Z"),
    });

    expect(result.holdings).toEqual([
      {
        id: "pass-1",
        assetType: "pass",
        assetCode: "monthly",
        quantity: integerFixture(1),
        activeAt: new Date("2026-06-01T00:00:00.000Z"),
        expiresAt: new Date("2026-06-17T00:00:00.000Z"),
      },
    ]);
    expect(result.assetLedgerEntries).toEqual([
      {
        assetType: "pass",
        assetCode: "monthly",
        delta: integerFixture(1),
        reason: "gift.redeem",
        refId: "redeem-2",
      },
    ]);
  });

  it("replaces matching assets", () => {
    const result = grantAssets({
      playerId: "player-1",
      existingHoldings: [
        {
          id: "title-1",
          assetType: "title",
          assetCode: "vip",
          quantity: integerFixture(1),
          activeAt: null,
          expiresAt: null,
        },
      ],
      grants: [
        {
          assetType: "title",
          assetCode: "vip",
          amount: 2,
          mergeStrategy: "replace",
          activeAt: new Date("2026-06-07T00:00:00.000Z"),
          expiresAt: new Date("2026-07-07T00:00:00.000Z"),
          reason: "admin.grant",
          refId: "staff-1",
        },
      ],
      idFactory: () => "title-new",
    });

    expect(result.holdings).toEqual([
      {
        id: "title-1",
        assetType: "title",
        assetCode: "vip",
        quantity: integerFixture(2),
        activeAt: new Date("2026-06-07T00:00:00.000Z"),
        expiresAt: new Date("2026-07-07T00:00:00.000Z"),
      },
    ]);
    expect(result.assetLedgerEntries).toEqual([
      {
        assetType: "title",
        assetCode: "vip",
        delta: integerFixture(2),
        reason: "admin.grant",
        refId: "staff-1",
      },
    ]);
  });
});

describe("adjustAssets", () => {
  it("deducts decimal balances without rounding", () => {
    const result = adjustAssets({
      playerId: "player-1",
      existingHoldings: [
        {
          id: "holding-1",
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: centsOf(10.25),
          activeAt: null,
          expiresAt: null,
        },
      ],
      adjustments: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          quantityDelta: -2.5,
          activeAt: null,
          expiresAt: null,
          reason: "staff.asset.deduct",
          refId: "staff-1",
        },
      ],
    });

    expect(assetQuantityToNatural(result.holdings[0]?.assetType, result.holdings[0]?.quantity)).toBe(7.75);
    expect(assetQuantityToNatural(result.assetLedgerEntries[0]?.assetType, result.assetLedgerEntries[0]?.delta)).toBe(-2.5);
  });

  it("deducts matching assets and emits negative ledger entries", () => {
    const result = adjustAssets({
      playerId: "player-1",
      existingHoldings: [
        {
          id: "holding-1",
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: centsOf(100),
          activeAt: null,
          expiresAt: null,
        },
      ],
      adjustments: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          quantityDelta: -30,
          activeAt: null,
          expiresAt: null,
          reason: "staff.asset.deduct",
          refId: "staff-1",
        },
      ],
    });

    expect(result.holdings).toEqual([
      {
        id: "holding-1",
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: centsOf(70),
        activeAt: null,
        expiresAt: null,
      },
    ]);
    expect(result.assetLedgerEntries).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.paid",
        delta: centsOf(-30),
        reason: "staff.asset.deduct",
        refId: "staff-1",
      },
    ]);
  });

  it("rejects deductions that would make the holding negative", () => {
    expect(() =>
      adjustAssets({
        playerId: "player-1",
        existingHoldings: [
          {
            id: "holding-1",
            assetType: "ticket",
            assetCode: "coupon",
            quantity: integerFixture(1),
            activeAt: null,
            expiresAt: null,
          },
        ],
        adjustments: [
          {
            assetType: "ticket",
            assetCode: "coupon",
            quantityDelta: -2,
            activeAt: null,
            expiresAt: null,
            reason: "staff.asset.deduct",
            refId: "staff-1",
          },
        ],
      }),
    ).toThrow("Insufficient asset quantity.");
  });

  it("expires matching assets and emits a zero-delta ledger entry", () => {
    const result = adjustAssets({
      playerId: "player-1",
      existingHoldings: [
        {
          id: "pass-1",
          assetType: "pass",
          assetCode: "monthly",
          quantity: integerFixture(1),
          activeAt: new Date("2026-06-01T00:00:00.000Z"),
          expiresAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
      adjustments: [
        {
          assetType: "pass",
          assetCode: "monthly",
          quantityDelta: 0,
          activeAt: new Date("2026-06-01T00:00:00.000Z"),
          expiresAt: new Date("2026-06-07T10:00:00.000Z"),
          reason: "staff.asset.expire",
          refId: "staff-1",
        },
      ],
    });

    expect(result.holdings).toEqual([
      {
        id: "pass-1",
        assetType: "pass",
        assetCode: "monthly",
        quantity: integerFixture(1),
        activeAt: new Date("2026-06-01T00:00:00.000Z"),
        expiresAt: new Date("2026-06-07T10:00:00.000Z"),
      },
    ]);
    expect(result.assetLedgerEntries).toEqual([
      {
        assetType: "pass",
        assetCode: "monthly",
        delta: integerFixture(0),
        reason: "staff.asset.expire",
        refId: "staff-1",
      },
    ]);
  });

  it("revokes a holding by id and removes it from current holdings", () => {
    const result = adjustAssets({
      playerId: "player-1",
      existingHoldings: [
        {
          id: "title-1",
          assetType: "title",
          assetCode: "vip",
          quantity: integerFixture(1),
          activeAt: null,
          expiresAt: null,
        },
        {
          id: "title-2",
          assetType: "title",
          assetCode: "vip",
          quantity: integerFixture(1),
          activeAt: null,
          expiresAt: null,
        },
      ],
      adjustments: [
        {
          holdingId: "title-1",
          assetType: "title",
          assetCode: "vip",
          quantityDelta: -1,
          reason: "staff.asset.revoke",
          refId: "staff-1",
        },
      ],
    });

    expect(result.holdings).toEqual([
      {
        id: "title-2",
        assetType: "title",
        assetCode: "vip",
        quantity: integerFixture(1),
        activeAt: null,
        expiresAt: null,
      },
    ]);
    expect(result.assetLedgerEntries).toEqual([
      {
        assetType: "title",
        assetCode: "vip",
        delta: integerFixture(-1),
        reason: "staff.asset.revoke",
        refId: "staff-1",
      },
    ]);
  });
});

describe("diffAssetHoldings", () => {
  it("writes only added or changed holdings and deletes only removed ids", () => {
    const before = [
      {
        id: "paid",
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: centsOf(100),
        activeAt: null,
        expiresAt: null,
      },
      {
        id: "ticket",
        assetType: "ticket",
        assetCode: "ticket.monthly",
        quantity: integerFixture(1),
        activeAt: null,
        expiresAt: null,
      },
      {
        id: "revoked",
        assetType: "title",
        assetCode: "title.temporary",
        quantity: integerFixture(1),
        activeAt: null,
        expiresAt: null,
      },
    ];
    const after = [
      { ...before[0]!, quantity: centsOf(80) },
      before[1]!,
      {
        id: "free",
        assetType: "currency",
        assetCode: "currency.free",
        quantity: centsOf(10),
        activeAt: null,
        expiresAt: null,
      },
    ];

    expect(diffAssetHoldings(before, after)).toEqual({
      upserts: [
        {
          id: "paid",
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: centsOf(80),
          activeAt: null,
          expiresAt: null,
        },
        {
          id: "free",
          assetType: "currency",
          assetCode: "currency.free",
          quantity: centsOf(10),
          activeAt: null,
          expiresAt: null,
        },
      ],
      deleteIds: ["revoked"],
    });
  });
});

describe("asset holdings money precision", () => {
  it("removes a fully spent holding instead of leaving subtraction residue behind", () => {
    const result = adjustAssets({
      playerId: "player-1",
      existingHoldings: [
        {
          id: "holding-1",
          assetType: "currency",
          assetCode: "currency.free",
          quantity: centsOf(1),
          activeAt: null,
          expiresAt: null,
        },
      ],
      adjustments: [
        {
          assetType: "currency",
          assetCode: "currency.free",
          quantityDelta: -1,
          activeAt: null,
          expiresAt: null,
          reason: "staff.asset.deduct",
          refId: "staff-1",
        },
      ],
    });

    expect(result.holdings).toEqual([]);
  });

  it("does not keep a holding whose balance is pure floating-point residue", () => {
    const deduct = (quantityDelta: number) => ({
      assetType: "currency",
      assetCode: "currency.free",
      quantityDelta,
      activeAt: null,
      expiresAt: null,
      reason: "staff.asset.deduct",
      refId: "staff-1",
    });

    const result = adjustAssets({
      playerId: "player-1",
      existingHoldings: [
        {
          id: "holding-1",
          assetType: "currency",
          assetCode: "currency.free",
          quantity: centsOf(1),
          activeAt: null,
          expiresAt: null,
        },
      ],
      adjustments: [deduct(-0.3), deduct(-0.3), deduct(-0.3), deduct(-0.1)],
    });

    expect(result.holdings).toEqual([]);
  });

  it("accepts a residual deduction that only overshoots by floating-point noise", () => {
    const result = adjustAssets({
      playerId: "player-1",
      existingHoldings: [
        {
          id: "holding-1",
          assetType: "currency",
          assetCode: "currency.free",
          quantity: centsOf(1),
          activeAt: null,
          expiresAt: null,
        },
      ],
      adjustments: [
        {
          assetType: "currency",
          assetCode: "currency.free",
          quantityDelta: -1.0000000000000002,
          activeAt: null,
          expiresAt: null,
          reason: "staff.asset.deduct",
          refId: "staff-1",
        },
      ],
    });

    expect(result.holdings).toEqual([]);
  });
});

describe("currency balance helpers", () => {
  it("classifies a empty holding as out of quantity", () => {
    const evaluation = evaluateAssetHoldingAvailability({
      holding: {
        assetType: "currency",
        assetCode: "currency.free",
        quantity: ZERO_CENTS,
      },
      definition: null,
      at: new Date("2026-06-07T10:00:00.000Z"),
    });

    expect(evaluation.available).toBe(false);
    expect(evaluation.unavailableReasons).toContain("quantity_not_positive");
  });

  it("sums currency holdings to a canonical cent total", () => {
    expect(
      yuanOf(
      sumCurrencyHoldings([
        { assetType: "currency", quantity: centsOf(0.01) },
        { assetType: "currency", quantity: centsOf(0.06) },
        { assetType: "ticket", quantity: integerFixture(999) },
      ]),
      )).toBe(0.07);
  });
});
