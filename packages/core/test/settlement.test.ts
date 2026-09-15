import { assetQuantityToNatural } from "@prism/core";
import { centsOf as moneyFixture, centsOfInteger as integerFixture } from "@prism/core";
import { describe, expect, it } from "bun:test";
import {
  type AssetEffectProvider,
  type AssetHolding,
  type PricingProvider,
  centsOf,
  centsOfInteger,
  deductCurrency,
  diffAssetHoldings,
  isPositiveCents,
  minCents,
  negCents,
  PrismDomainError,
  previewSessionSettlement,
  quantizeMoney,
  settleSession,
  subCents,
  sumCents,
  yuanOf,
  ZERO_CENTS,
} from "../src/index";

describe("settleSession", () => {
  it("settles plugin charge items through the core asset ledger", async () => {
    const pricing: PricingProvider = {
      id: "manual-package",
      async quote() {
        return [
          {
            id: "charge-1",
            source: "manual-package",
            label: "One song package",
            amount: moneyFixture(12),
          },
        ];
      },
    };

    const wallet: AssetHolding[] = [
      {
        assetType: "currency",
        assetCode: "currency.free",
        quantity: centsOf(5),
      },
      {
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: centsOf(20),
      },
    ];

    const result = await settleSession({
      session: {
        id: "session-1",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:30:00.000Z"),
      },
      pricingProviders: [pricing],
      assetHoldings: wallet,
      now: new Date("2026-06-07T10:30:00.000Z"),
    });

    expect(yuanOf(result.settlement.total)).toBe(12);
    expect(result.settlement.status).toBe("settled");
    expect(result.chargeItems).toEqual([
      {
        id: "charge-1",
        source: "manual-package",
        label: "One song package",
        amount: moneyFixture(12),
      },
    ]);
    expect(result.assetLedgerEntries).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.free",
        delta: centsOf(-5),
        reason: "session.settlement",
        refId: "session-1",
      },
      {
        assetType: "currency",
        assetCode: "currency.paid",
        delta: centsOf(-7),
        reason: "session.settlement",
        refId: "session-1",
      },
    ]);
    expect(result.assetHoldings).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.free",
        quantity: centsOf(0),
      },
      {
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: centsOf(13),
      },
    ]);
  });

  it("rejects settlement without enough currency balance", async () => {
    const pricing: PricingProvider = {
      id: "cover-charge",
      async quote() {
        return [
          {
            id: "charge-1",
            source: "cover-charge",
            label: "Cover charge",
            amount: moneyFixture(30),
          },
        ];
      },
    };

    const wallet: AssetHolding[] = [
      {
        assetType: "currency",
        assetCode: "currency.free",
        quantity: centsOf(5),
      },
      {
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: centsOf(20),
      },
    ];

    expect(
      settleSession({
        session: {
          id: "session-2",
          playerId: "player-1",
          startedAt: new Date("2026-06-07T10:00:00.000Z"),
          endedAt: new Date("2026-06-07T10:30:00.000Z"),
        },
        pricingProviders: [pricing],
        assetHoldings: wallet,
        now: new Date("2026-06-07T10:30:00.000Z"),
      }),
    ).rejects.toMatchObject({
      name: "PrismDomainError",
      code: "INSUFFICIENT_BALANCE",
    } satisfies Partial<PrismDomainError>);
  });

  it("deducts only active and unexpired currency holdings", async () => {
    const pricing: PricingProvider = {
      id: "cover-charge",
      async quote() {
        return [
          {
            id: "charge-1",
            source: "cover-charge",
            label: "Cover charge",
            amount: moneyFixture(20),
          },
        ];
      },
    };

    const result = await settleSession({
      session: {
        id: "session-windowed-currency",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:30:00.000Z"),
      },
      pricingProviders: [pricing],
      assetHoldings: [
        {
          id: "expired-free",
          assetType: "currency",
          assetCode: "currency.free",
          quantity: centsOf(999),
          activeAt: new Date("2026-06-01T00:00:00.000Z"),
          expiresAt: new Date("2026-06-07T09:59:59.000Z"),
        },
        {
          id: "future-free",
          assetType: "currency",
          assetCode: "currency.free",
          quantity: centsOf(999),
          activeAt: new Date("2026-06-08T00:00:00.000Z"),
          expiresAt: null,
        },
        {
          id: "active-paid",
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: centsOf(30),
          activeAt: new Date("2026-06-01T00:00:00.000Z"),
          expiresAt: new Date("2026-06-08T00:00:00.000Z"),
        },
      ],
      now: new Date("2026-06-07T10:30:00.000Z"),
    });

    expect(result.assetLedgerEntries).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.paid",
        delta: centsOf(-20),
        reason: "session.settlement",
        refId: "session-windowed-currency",
      },
    ]);
    expect(result.assetHoldings).toEqual([
      {
        id: "expired-free",
        assetType: "currency",
        assetCode: "currency.free",
        quantity: centsOf(999),
        activeAt: new Date("2026-06-01T00:00:00.000Z"),
        expiresAt: new Date("2026-06-07T09:59:59.000Z"),
      },
      {
        id: "future-free",
        assetType: "currency",
        assetCode: "currency.free",
        quantity: centsOf(999),
        activeAt: new Date("2026-06-08T00:00:00.000Z"),
        expiresAt: null,
      },
      {
        id: "active-paid",
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: centsOf(10),
        activeAt: new Date("2026-06-01T00:00:00.000Z"),
        expiresAt: new Date("2026-06-08T00:00:00.000Z"),
      },
    ]);
  });

  it("deducts free currency before paid currency for canonical setup codes", async () => {
    const pricing: PricingProvider = {
      id: "cover-charge",
      async quote() {
        return [
          {
            id: "charge-1",
            source: "cover-charge",
            label: "Cover charge",
            amount: moneyFixture(12),
          },
        ];
      },
    };

    const result = await settleSession({
      session: {
        id: "session-canonical-currency",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:30:00.000Z"),
      },
      pricingProviders: [pricing],
      assetHoldings: [
        {
          assetType: "currency",
          assetCode: "paid",
          quantity: centsOf(20),
        },
        {
          assetType: "currency",
          assetCode: "free",
          quantity: centsOf(5),
        },
      ],
      now: new Date("2026-06-07T10:30:00.000Z"),
    });

    expect(result.assetLedgerEntries).toEqual([
      {
        assetType: "currency",
        assetCode: "free",
        delta: centsOf(-5),
        reason: "session.settlement",
        refId: "session-canonical-currency",
      },
      {
        assetType: "currency",
        assetCode: "paid",
        delta: centsOf(-7),
        reason: "session.settlement",
        refId: "session-canonical-currency",
      },
    ]);
    expect(result.assetHoldings).toEqual([
      {
        assetType: "currency",
        assetCode: "paid",
        quantity: centsOf(13),
      },
      {
        assetType: "currency",
        assetCode: "free",
        quantity: centsOf(0),
      },
    ]);
  });

  it("does not let pricing plugins mutate asset holdings", async () => {
    const pricing: PricingProvider = {
      id: "mutating-plugin",
      async quote(context) {
        context.assetHoldings[0].quantity = centsOf(999);
        return [
          {
            id: "charge-1",
            source: "mutating-plugin",
            label: "Mutating plugin charge",
            amount: moneyFixture(12),
          },
        ];
      },
    };

    const result = await settleSession({
      session: {
        id: "session-3",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:30:00.000Z"),
      },
      pricingProviders: [pricing],
      assetHoldings: [
        {
          assetType: "currency",
          assetCode: "currency.free",
          quantity: centsOf(5),
        },
        {
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: centsOf(20),
        },
      ],
      now: new Date("2026-06-07T10:30:00.000Z"),
    });

    expect(result.assetLedgerEntries).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.free",
        delta: centsOf(-5),
        reason: "session.settlement",
        refId: "session-3",
      },
      {
        assetType: "currency",
        assetCode: "currency.paid",
        delta: centsOf(-7),
        reason: "session.settlement",
        refId: "session-3",
      },
    ]);
    expect(result.assetHoldings).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.free",
        quantity: centsOf(0),
      },
      {
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: centsOf(13),
      },
    ]);
  });

  it("applies asset effect adjustments before currency deduction", async () => {
    const pricing: PricingProvider = {
      id: "time-pricing",
      async quote() {
        return [
          {
            id: "charge-1",
            source: "time-pricing",
            label: "Time charge",
            amount: moneyFixture(20),
          },
        ];
      },
    };

    const couponEffect: AssetEffectProvider = {
      id: "coupon.fixed-off",
      async apply() {
        return [
          {
            id: "adjustment-1",
            source: "coupon.fixed-off",
            label: "Coupon fixed discount",
            amount: moneyFixture(-6),
          },
        ];
      },
    };

    const result = await settleSession({
      session: {
        id: "session-4",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:30:00.000Z"),
      },
      pricingProviders: [pricing],
      assetEffectProviders: [couponEffect],
      assetHoldings: [
        {
          assetType: "currency",
          assetCode: "currency.free",
          quantity: centsOf(5),
        },
        {
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: centsOf(20),
        },
      ],
      now: new Date("2026-06-07T10:30:00.000Z"),
    });

    expect(yuanOf(result.settlement.subtotal)).toBe(20);
    expect(yuanOf(result.settlement.total)).toBe(14);
    expect(result.adjustments).toEqual([
      {
        id: "adjustment-1",
        source: "coupon.fixed-off",
        label: "Coupon fixed discount",
        amount: moneyFixture(-6),
      },
    ]);
    expect(result.assetLedgerEntries).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.free",
        delta: centsOf(-5),
        reason: "session.settlement",
        refId: "session-4",
      },
      {
        assetType: "currency",
        assetCode: "currency.paid",
        delta: centsOf(-9),
        reason: "session.settlement",
        refId: "session-4",
      },
    ]);
  });

  it("passes only active and unexpired assets to asset effect providers", async () => {
    const pricing: PricingProvider = {
      id: "time-pricing",
      async quote() {
        return [
          {
            id: "charge-1",
            source: "time-pricing",
            label: "Time charge",
            amount: moneyFixture(20),
          },
        ];
      },
    };

    const seenAssetCodes: string[] = [];
    const passEffect: AssetEffectProvider = {
      id: "pass.active-only",
      async apply(context) {
        seenAssetCodes.push(...context.assetHoldings.map((holding) => holding.assetCode));
        return context.assetHoldings.some((holding) => holding.assetCode === "pass.active")
          ? [
              {
                id: "pass-active",
                source: "pass.active",
                label: "Active pass",
                amount: moneyFixture(-20),
              },
            ]
          : [];
      },
    };

    const result = await settleSession({
      session: {
        id: "session-windowed-pass",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:30:00.000Z"),
      },
      pricingProviders: [pricing],
      assetEffectProviders: [passEffect],
      assetHoldings: [
        {
          assetType: "pass",
          assetCode: "pass.expired",
          quantity: integerFixture(1),
          expiresAt: new Date("2026-06-07T09:59:59.000Z"),
        },
        {
          assetType: "pass",
          assetCode: "pass.future",
          quantity: integerFixture(1),
          activeAt: new Date("2026-06-08T00:00:00.000Z"),
        },
        {
          assetType: "pass",
          assetCode: "pass.active",
          quantity: integerFixture(1),
          activeAt: new Date("2026-06-01T00:00:00.000Z"),
          expiresAt: new Date("2026-06-08T00:00:00.000Z"),
        },
      ],
      now: new Date("2026-06-07T10:30:00.000Z"),
    });

    expect(seenAssetCodes).toEqual(["pass.active"]);
    expect(yuanOf(result.settlement.total)).toBe(0);
  });

  it("floors settlement total at zero after adjustments", async () => {
    const pricing: PricingProvider = {
      id: "time-pricing",
      async quote() {
        return [
          {
            id: "charge-1",
            source: "time-pricing",
            label: "Short visit",
            amount: moneyFixture(4),
          },
        ];
      },
    };

    const passEffect: AssetEffectProvider = {
      id: "pass.workday",
      async apply() {
        return [
          {
            id: "adjustment-1",
            source: "pass.workday",
            label: "Workday pass benefit",
            amount: moneyFixture(-10),
          },
        ];
      },
    };

    const result = await settleSession({
      session: {
        id: "session-5",
        playerId: "player-1",
        startedAt: new Date("2026-06-08T10:00:00.000Z"),
        endedAt: new Date("2026-06-08T10:10:00.000Z"),
      },
      pricingProviders: [pricing],
      assetEffectProviders: [passEffect],
      assetHoldings: [
        {
          assetType: "currency",
          assetCode: "currency.free",
          quantity: centsOf(0),
        },
      ],
      now: new Date("2026-06-08T10:10:00.000Z"),
    });

    expect(yuanOf(result.settlement.subtotal)).toBe(4);
    expect(yuanOf(result.settlement.total)).toBe(0);
    expect(result.assetLedgerEntries).toEqual([]);
  });

  it("allows negative charge items and sums them correctly", async () => {
    const pricing: PricingProvider = {
      id: "split-pricing",
      async quote() {
        return [
          {
            id: "charge-positive",
            source: "split-pricing",
            label: "Base Rate",
            amount: moneyFixture(25),
          },
          {
            id: "charge-negative",
            source: "split-pricing",
            label: "Discount Rule",
            amount: moneyFixture(-10),
          },
        ];
      },
    };

    const result = await settleSession({
      session: {
        id: "session-neg-1",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:30:00.000Z"),
      },
      pricingProviders: [pricing],
      assetHoldings: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: centsOf(100),
        },
      ],
      now: new Date("2026-06-07T10:30:00.000Z"),
    });

    expect(yuanOf(result.settlement.subtotal)).toBe(15);
    expect(yuanOf(result.settlement.total)).toBe(15);
  });

  it("preserves a negative charge subtotal while flooring the final total at 0", async () => {
    const pricing: PricingProvider = {
      id: "excess-discount",
      async quote() {
        return [
          {
            id: "charge-positive",
            source: "excess-discount",
            label: "Base Rate",
            amount: moneyFixture(25),
          },
          {
            id: "charge-negative",
            source: "excess-discount",
            label: "Discount Rule",
            amount: moneyFixture(-40),
          },
        ];
      },
    };

    const result = await settleSession({
      session: {
        id: "session-neg-2",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:30:00.000Z"),
      },
      pricingProviders: [pricing],
      assetHoldings: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: centsOf(100),
        },
      ],
      now: new Date("2026-06-07T10:30:00.000Z"),
    });

    expect(yuanOf(result.settlement.subtotal)).toBe(-15);
    expect(yuanOf(result.settlement.total)).toBe(0);
  });
});

describe("previewSessionSettlement", () => {
  it("quotes charges and adjustments without deducting currency", async () => {
    const result = await previewSessionSettlement({
      session: {
        id: "session-6",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T11:00:00.000Z"),
        status: "closed",
      },
      pricingProviders: [
        {
          id: "time",
          quote() {
            return [
              {
                id: "charge-1",
                source: "time",
                label: "Time charge",
                amount: moneyFixture(20),
              },
            ];
          },
        },
      ],
      assetEffectProviders: [
        {
          id: "coupon",
          apply() {
            return [
              {
                id: "coupon-1",
                source: "coupon",
                label: "Coupon",
                amount: moneyFixture(-5),
              },
            ];
          },
        },
      ],
      assetHoldings: [
        {
          id: "holding-1",
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: centsOf(100),
        },
      ],
      now: new Date("2026-06-07T11:00:00.000Z"),
    });

    expect(result).toEqual({
      settlementPreview: {
        sessionId: "session-6",
        subtotal: centsOf(20),
        total: centsOf(15),
        status: "preview",
        previewedAt: new Date("2026-06-07T11:00:00.000Z"),
      },
      chargeItems: [
        {
          id: "charge-1",
          source: "time",
          label: "Time charge",
          amount: moneyFixture(20),
        },
      ],
      adjustments: [
        {
          id: "coupon-1",
          source: "coupon",
          label: "Coupon",
          amount: moneyFixture(-5),
        },
      ],
      assetHoldings: [
        {
          id: "holding-1",
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: centsOf(100),
        },
      ],
    });
  });
});

describe("settlement money precision", () => {
  const session = {
    id: "session-float",
    playerId: "player-1",
    startedAt: new Date("2026-06-07T10:00:00.000Z"),
    endedAt: new Date("2026-06-07T10:30:00.000Z"),
  };

  function chargeOf(amount: number): PricingProvider {
    return {
      id: "time-pricing",
      quote() {
        return [{ id: "charge-1", source: "time-pricing", label: "Time charge", amount: moneyFixture(amount) }];
      },
    };
  }

  it("collects a settlement the player can afford even when the balance does not add up exactly", async () => {
    // 0.01 + 0.06 evaluates to 0.06999999999999999, which is less than the
    // 0.07 charged. A raw `available < amount` check rejected this payment.
    expect(0.01 + 0.06 < 0.07).toBe(true);

    const result = await settleSession({
      session,
      pricingProviders: [chargeOf(0.07)],
      assetHoldings: [
        { assetType: "currency", assetCode: "currency.free", quantity: centsOf(0.01) },
        { assetType: "currency", assetCode: "currency.paid", quantity: centsOf(0.06) },
      ],
      now: session.endedAt,
    });

    expect(yuanOf(result.settlement.total)).toBe(0.07);
    expect(result.assetLedgerEntries).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.free",
        delta: centsOf(-0.01),
        reason: "session.settlement",
        refId: "session-float",
      },
      {
        assetType: "currency",
        assetCode: "currency.paid",
        delta: centsOf(-0.06),
        reason: "session.settlement",
        refId: "session-float",
      },
    ]);
    expect(result.assetHoldings.map((holding) => assetQuantityToNatural(holding.assetType, holding.quantity))).toEqual([0, 0]);
  });

  it("still rejects a settlement the player genuinely cannot afford", async () => {
    await expect(
      settleSession({
        session,
        pricingProviders: [chargeOf(0.04)],
        assetHoldings: [
          { assetType: "currency", assetCode: "currency.free", quantity: centsOf(0.03) },
        ],
        now: session.endedAt,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" } satisfies Partial<PrismDomainError>);
  });

  it("accepts a balance assembled from thirds of a cent once it is quantised to cents", async () => {
    expect(0.3 + 0.6 < 0.9).toBe(true);

    const result = await settleSession({
      session,
      pricingProviders: [chargeOf(0.9)],
      assetHoldings: [
        { assetType: "currency", assetCode: "currency.free", quantity: centsOf(0.3) },
        { assetType: "currency", assetCode: "currency.paid", quantity: centsOf(0.6) },
      ],
      now: session.endedAt,
    });

    expect(result.assetHoldings.map((holding) => assetQuantityToNatural(holding.assetType, holding.quantity))).toEqual([0, 0]);
  });

  it("clears deduction residue so a fully spent balance reaches exactly zero", async () => {
    const holdings: AssetHolding[] = [
      { id: "free-1", assetType: "currency", assetCode: "currency.free", quantity: centsOf(1) },
    ];

    for (let index = 0; index < 10; index++) {
      deductCurrency(holdings, {
        amount: centsOf(0.1),
        reason: "session.settlement",
        refId: "session-residue",
        now: session.endedAt,
      });
    }

    expect(assetQuantityToNatural(holdings[0]!.assetType, holdings[0]!.quantity)).toBe(0);
    expect(holdings[0]!.quantity > 0).toBe(false);
  });

  it("reports a spent holding for deletion instead of leaving a zero-quantity row behind", async () => {
    const before: AssetHolding[] = [
      { id: "free-1", assetType: "currency", assetCode: "currency.free", quantity: centsOf(1) },
    ];
    const holdings = before.map((holding) => ({ ...holding }));

    for (let index = 0; index < 10; index++) {
      deductCurrency(holdings, {
        amount: centsOf(0.1),
        reason: "session.settlement",
        refId: "session-residue",
        now: session.endedAt,
      });
    }

    const nextHoldings = holdings.filter((holding) => holding.quantity > 0);
    expect(diffAssetHoldings(before, nextHoldings).deleteIds).toEqual(["free-1"]);
  });

  it("ignores an empty holding rather than emitting a zero-value ledger entry", async () => {
    const holdings: AssetHolding[] = [
      // Under integer cents a sub-cent residue cannot exist: it is simply zero,
      // and a zero balance must never be selected or emit a ledger entry.
      { id: "free-1", assetType: "currency", assetCode: "currency.free", quantity: ZERO_CENTS },
      { id: "paid-1", assetType: "currency", assetCode: "currency.paid", quantity: centsOf(1) },
    ];

    const entries = deductCurrency(holdings, {
      amount: centsOf(0.01),
      reason: "session.settlement",
      refId: "session-residue",
      now: session.endedAt,
    });

    expect(entries).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.paid",
        delta: centsOf(-0.01),
        reason: "session.settlement",
        refId: "session-residue",
      },
    ]);
    expect(Number(holdings.find((holding) => holding.id === "free-1")!.quantity)).toBe(0);
  });

  it("quantises an override total before it is persisted", async () => {
    const result = await settleSession({
      session,
      pricingProviders: [chargeOf(20)],
      assetHoldings: [
        { assetType: "currency", assetCode: "currency.paid", quantity: centsOf(100) },
      ],
      overrideTotal: {
        total: 33.333333333333336,
        id: "override-1",
        source: "staff.override",
        label: "Manual override",
      },
      now: session.endedAt,
    });

    expect(yuanOf(result.settlement.total)).toBe(33.33);
    expect(result.adjustments[0]!.amount).toBe(moneyFixture(13.33));
    expect(assetQuantityToNatural(result.assetLedgerEntries[0]!.assetType, result.assetLedgerEntries[0]!.delta)).toBe(-33.33);
  });

  it("settles a fixed charge of a tenth ten times without losing a cent", async () => {
    const result = await settleSession({
      session,
      pricingProviders: [
        {
          id: "unit-charges",
          quote() {
            return Array.from({ length: 10 }, (_, index) => ({
              id: `charge-${index}`,
              source: "unit-charges",
              label: "Unit charge",
              amount: centsOf(0.1),
            }));
          },
        },
      ],
      assetHoldings: [
        { assetType: "currency", assetCode: "currency.paid", quantity: centsOf(1) },
      ],
      now: session.endedAt,
    });

    expect(yuanOf(result.settlement.subtotal)).toBe(1);
    expect(yuanOf(result.settlement.total)).toBe(1);
    expect(assetQuantityToNatural(result.assetLedgerEntries[0]!.assetType, result.assetLedgerEntries[0]!.delta)).toBe(-1);
  });

  it("never refuses a payment the balance covers, across every cent pair up to 3 yuan", () => {
    let checked = 0;
    let naiveRefusals = 0;
    const naiveExamples: string[] = [];

    for (let freeCents = 0; freeCents <= 300; freeCents++) {
      for (let paidCents = 0; paidCents <= 300; paidCents++) {
        const owedCents = freeCents + paidCents;
        if (owedCents === 0) continue;
        checked++;

        const freeYuan = freeCents / 100;
        const paidYuan = paidCents / 100;
        const owedYuan = owedCents / 100;

        // What the old raw comparison did, recorded so the regression stays
        // visible: this is the count of payments the player could afford and
        // the settlement refused anyway.
        if (freeYuan + paidYuan < owedYuan) {
          naiveRefusals++;
          if (naiveExamples.length < 3) naiveExamples.push(`${freeYuan} + ${paidYuan} < ${owedYuan}`);
        }

        const holdings: AssetHolding[] = [
          { id: "free-1", assetType: "currency", assetCode: "currency.free", quantity: centsOfInteger(freeCents) },
          { id: "paid-1", assetType: "currency", assetCode: "currency.paid", quantity: centsOfInteger(paidCents) },
        ];

        const entries = deductCurrency(holdings, {
          amount: centsOfInteger(owedCents),
          reason: "session.settlement",
          refId: "session-grid",
          now: session.endedAt,
        });

        // Integer arithmetic: the parts always sum to exactly what was charged,
        // with no tolerance and no residue.
        const deducted = sumCents(entries.map((entry) => entry.delta));
        expect(Number(deducted)).toBe(-owedCents);
        expect(holdings.every((holding) => holding.quantity === 0)).toBe(true);
      }
    }

    expect(checked).toBe(90_600);
    expect(naiveRefusals).toBeGreaterThan(1_000);
    expect(naiveExamples.slice(0, 2)).toEqual(["0.01 + 0.06 < 0.07", "0.01 + 0.09 < 0.1"]);
  });
});
