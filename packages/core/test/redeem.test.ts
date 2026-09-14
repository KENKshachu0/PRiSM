import { centsOf, yuanOf } from "@prism/core";
import { describe, expect, it } from "bun:test";
import { PrismDomainError, redeemGift } from "../src/index";

describe("redeemGift", () => {
  it("redeems an active code and grants present assets", () => {
    const result = redeemGift({
      playerId: "player-1",
      code: {
        id: "redeem-1",
        code: "ABC123",
        presentId: "present-1",
        activeAt: null,
        expiresAt: null,
        maxUseCount: 1,
      },
      present: {
        id: "present-1",
        name: "Starter gift",
        oncePerPlayer: false,
        grants: [
          {
            assetType: "currency",
            assetCode: "currency.free",
            amount: 10,
            mergeStrategy: "stack",
            activeAt: null,
            expiresAt: null,
          },
        ],
      },
      existingHoldings: [],
      redeemRecords: [],
      now: new Date("2026-06-07T10:00:00.000Z"),
      idFactory: () => "asset-new",
    });

    expect(result.holdings).toEqual([
      {
        id: "asset-new",
        assetType: "currency",
        assetCode: "currency.free",
        quantity: centsOf(10),
        activeAt: null,
        expiresAt: null,
      },
    ]);
    expect(result.assetLedgerEntries).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.free",
        delta: centsOf(10),
        reason: "gift.redeem",
        refId: "redeem-1",
      },
    ]);
    expect(result.redeemRecord).toEqual({
      playerId: "player-1",
      codeId: "redeem-1",
      presentId: "present-1",
      redeemedAt: new Date("2026-06-07T10:00:00.000Z"),
    });
  });

  it("rejects codes that reached max use count", () => {
    expect(() =>
      redeemGift({
        playerId: "player-2",
        code: {
          id: "redeem-1",
          code: "ABC123",
          presentId: "present-1",
          activeAt: null,
          expiresAt: null,
          maxUseCount: 1,
        },
        present: {
          id: "present-1",
          name: "Starter gift",
          oncePerPlayer: false,
          grants: [],
        },
        existingHoldings: [],
        redeemRecords: [
          {
            playerId: "player-1",
            codeId: "redeem-1",
            presentId: "present-1",
            redeemedAt: new Date("2026-06-07T09:00:00.000Z"),
          },
        ],
        now: new Date("2026-06-07T10:00:00.000Z"),
        idFactory: () => "asset-new",
      }),
    ).toThrow(
      expect.objectContaining({
        name: "PrismDomainError",
        code: "REDEEM_CODE_MAX_USE_REACHED",
      }) as PrismDomainError,
    );
  });

  it("rejects once-per-player presents already redeemed by the player", () => {
    expect(() =>
      redeemGift({
        playerId: "player-1",
        code: {
          id: "redeem-2",
          code: "DEF456",
          presentId: "present-1",
          activeAt: null,
          expiresAt: null,
          maxUseCount: 1,
        },
        present: {
          id: "present-1",
          name: "Starter gift",
          oncePerPlayer: true,
          grants: [],
        },
        existingHoldings: [],
        redeemRecords: [
          {
            playerId: "player-1",
            codeId: "redeem-1",
            presentId: "present-1",
            redeemedAt: new Date("2026-06-07T09:00:00.000Z"),
          },
        ],
        now: new Date("2026-06-07T10:00:00.000Z"),
        idFactory: () => "asset-new",
      }),
    ).toThrow(
      expect.objectContaining({
        name: "PrismDomainError",
        code: "PRESENT_ONCE_PER_PLAYER_REDEEMED",
      }) as PrismDomainError,
    );
  });

  it("rejects inactive or expired codes", () => {
    const baseInput = {
      playerId: "player-1",
      present: {
        id: "present-1",
        name: "Starter gift",
        oncePerPlayer: false,
        grants: [],
      },
      existingHoldings: [],
      redeemRecords: [],
      now: new Date("2026-06-07T10:00:00.000Z"),
      idFactory: () => "asset-new",
    };

    expect(() =>
      redeemGift({
        ...baseInput,
        code: {
          id: "redeem-3",
          code: "FUTURE",
          presentId: "present-1",
          activeAt: new Date("2026-06-07T11:00:00.000Z"),
          expiresAt: null,
          maxUseCount: 1,
        },
      }),
    ).toThrow(
      expect.objectContaining({
        name: "PrismDomainError",
        code: "REDEEM_CODE_NOT_ACTIVE",
      }) as PrismDomainError,
    );

    expect(() =>
      redeemGift({
        ...baseInput,
        code: {
          id: "redeem-4",
          code: "EXPIRED",
          presentId: "present-1",
          activeAt: null,
          expiresAt: new Date("2026-06-07T09:00:00.000Z"),
          maxUseCount: 1,
        },
      }),
    ).toThrow(
      expect.objectContaining({
        name: "PrismDomainError",
        code: "REDEEM_CODE_EXPIRED",
      }) as PrismDomainError,
    );
  });

  it("rejects inactive or expired presents even when the redeem code is usable", () => {
    const baseInput = {
      playerId: "player-1",
      code: {
        id: "redeem-5",
        code: "PRESENT-WINDOW",
        presentId: "present-1",
        activeAt: null,
        expiresAt: null,
        maxUseCount: 1,
      },
      existingHoldings: [],
      redeemRecords: [],
      now: new Date("2026-06-07T10:00:00.000Z"),
      idFactory: () => "asset-new",
    };

    expect(() =>
      redeemGift({
        ...baseInput,
        present: {
          id: "present-1",
          name: "Future gift",
          oncePerPlayer: false,
          activeAt: new Date("2026-06-07T11:00:00.000Z"),
          expiresAt: null,
          grants: [],
        },
      }),
    ).toThrow(
      expect.objectContaining({
        name: "PrismDomainError",
        code: "PRESENT_NOT_ACTIVE",
      }) as PrismDomainError,
    );

    expect(() =>
      redeemGift({
        ...baseInput,
        present: {
          id: "present-1",
          name: "Expired gift",
          oncePerPlayer: false,
          activeAt: null,
          expiresAt: new Date("2026-06-07T09:00:00.000Z"),
          grants: [],
        },
      }),
    ).toThrow(
      expect.objectContaining({
        name: "PrismDomainError",
        code: "PRESENT_EXPIRED",
      }) as PrismDomainError,
    );
  });

  it("redeems the gift but skips present contents outside their effective window", () => {
    const result = redeemGift({
      playerId: "player-1",
      code: {
        id: "redeem-6",
        code: "PARTIAL-GIFT",
        presentId: "present-1",
        activeAt: null,
        expiresAt: null,
        maxUseCount: 1,
      },
      present: {
        id: "present-1",
        name: "Partial gift",
        oncePerPlayer: false,
        activeAt: null,
        expiresAt: null,
        grants: [
          {
            assetType: "coupon",
            assetCode: "expired",
            amount: 1,
            mergeStrategy: "stack",
            activeAt: null,
            expiresAt: new Date("2026-06-07T09:00:00.000Z"),
          },
          {
            assetType: "coupon",
            assetCode: "future",
            amount: 1,
            mergeStrategy: "stack",
            activeAt: new Date("2026-06-07T11:00:00.000Z"),
            expiresAt: null,
          },
          {
            assetType: "currency",
            assetCode: "paid",
            amount: 100,
            mergeStrategy: "stack",
            activeAt: null,
            expiresAt: null,
          },
        ],
      },
      existingHoldings: [],
      redeemRecords: [],
      now: new Date("2026-06-07T10:00:00.000Z"),
      idFactory: () => "asset-new",
    });

    expect(result.holdings).toEqual([
      {
        id: "asset-new",
        assetType: "currency",
        assetCode: "paid",
        quantity: centsOf(100),
        activeAt: null,
        expiresAt: null,
      },
    ]);
    expect(result.assetLedgerEntries).toEqual([
      {
        assetType: "currency",
        assetCode: "paid",
        delta: centsOf(100),
        reason: "gift.redeem",
        refId: "redeem-6",
      },
    ]);
    expect(result.redeemRecord).toMatchObject({
      codeId: "redeem-6",
      presentId: "present-1",
    });
  });
});
