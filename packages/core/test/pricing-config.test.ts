import { describe, expect, it } from "bun:test";
import { createPricingProviderFromConfig, PrismDomainError, quantizePricingProvider, validatePricingConfig } from "../src/index";

describe("validatePricingConfig", () => {
  it("accepts an enabled time priority config with a full-day rule", () => {
    expect(() =>
      validatePricingConfig({
        id: "pricing-1",
        kind: "time.priority",
        name: "Default time pricing",
        enabled: true,
        provider: {
          id: "time.default",
          rules: [
            {
              id: "base",
              label: "Base",
              priority: 0,
              timeRange: {
                start: "00:00",
                end: "00:00",
              },
              pricing: {
                unitMinutes: 30,
                unitPrice: 10,
                roundGraceMinutes: 5,
                priceCap: 80,
              },
            },
          ],
        },
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        updatedAt: new Date("2026-06-07T10:00:00.000Z"),
      }),
    ).not.toThrow();
  });

  it("accepts enabled time priority configs whose unrestricted day and night rules cover the full day", () => {
    expect(() =>
      validatePricingConfig({
        id: "pricing-day-night",
        kind: "time.priority",
        name: "标准日夜计费",
        enabled: true,
        provider: {
          id: "time.day-night",
          rules: [
            {
              id: "day",
              label: "日间",
              priority: 1,
              timeRange: {
                start: "10:00",
                end: "22:00",
              },
              pricing: {
                unitMinutes: 30,
                unitPrice: 4,
                roundGraceMinutes: 0,
                priceCap: 40,
              },
            },
            {
              id: "night",
              label: "夜间",
              priority: 1,
              timeRange: {
                start: "22:00",
                end: "10:00",
              },
              pricing: {
                unitMinutes: 30,
                unitPrice: 4,
                roundGraceMinutes: 0,
                priceCap: 40,
              },
            },
          ],
        },
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        updatedAt: new Date("2026-06-07T10:00:00.000Z"),
      }),
    ).not.toThrow();
  });

  it("accepts enabled time priority configs with closed non-billable gaps", () => {
    expect(() =>
      validatePricingConfig({
        id: "pricing-1",
        kind: "time.priority",
        name: "Business hours pricing",
        enabled: true,
        provider: {
          id: "time.business-hours",
          rules: [
            {
              id: "business-hours",
              label: "Business hours",
              priority: 10,
              timeRange: {
                start: "10:00",
                end: "22:00",
              },
              pricing: {
                unitMinutes: 30,
                unitPrice: 10,
                roundGraceMinutes: 5,
                priceCap: 80,
              },
            },
          ],
        },
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        updatedAt: new Date("2026-06-07T10:00:00.000Z"),
      }),
    ).not.toThrow();
  });

  it("rejects enabled time priority configs whose only billable rule is archived", () => {
    expect(() =>
      validatePricingConfig({
        id: "pricing-1",
        kind: "time.priority",
        name: "Archived business hours pricing",
        enabled: true,
        provider: {
          id: "time.archived-business-hours",
          rules: [
            {
              id: "base",
              label: "Base",
              priority: 0,
              status: "archived",
              timeRange: {
                start: "00:00",
                end: "00:00",
              },
              pricing: {
                unitMinutes: 30,
                unitPrice: 10,
                roundGraceMinutes: 5,
                priceCap: 80,
              },
            },
          ],
        },
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        updatedAt: new Date("2026-06-07T10:00:00.000Z"),
      }),
    ).toThrow(new PrismDomainError("Enabled time priority pricing config requires at least one active time rule.", "PRICING_CONFIG_REQUIRES_ACTIVE_TIME_RULE"));
  });

  it("creates a fixed charge pricing provider for non-time venue products", async () => {
    const provider = createPricingProviderFromConfig({
      id: "pricing-cover",
      kind: "charge.fixed",
      name: "入场费",
      enabled: true,
      provider: {
        id: "cover-charge",
        label: "入场费",
        amount: 500,
      },
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
      updatedAt: new Date("2026-06-07T10:00:00.000Z"),
    });

    await expect(
      Promise.resolve(provider.quote({
        session: {
          id: "session-fixed",
          playerId: "player-1",
          startedAt: new Date("2026-06-07T10:00:00.000Z"),
          endedAt: new Date("2026-06-07T11:00:00.000Z"),
          status: "closed",
        },
        assetHoldings: [],
        now: new Date("2026-06-07T11:00:00.000Z"),
      })),
    ).resolves.toEqual([
      {
        id: "session-fixed:cover-charge",
        source: "cover-charge",
        label: "入场费",
        amount: 500,
      },
    ]);
  });

  it("rejects enabled fixed charge pricing configs with invalid amounts", () => {
    expect(() =>
      validatePricingConfig({
        id: "pricing-broken-fixed",
        kind: "charge.fixed",
        name: "坏的固定收费",
        enabled: true,
        provider: {
          id: "broken-fixed",
          label: "坏的固定收费",
          amount: -1,
        },
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        updatedAt: new Date("2026-06-07T10:00:00.000Z"),
      }),
    ).toThrow(new PrismDomainError("Fixed charge pricing amount must be a non-negative finite number.", "INVALID_FIXED_CHARGE_AMOUNT"));
  });
});

describe("quantizePricingProvider", () => {
  it("snaps time pricing unit prices and caps to whole cents", () => {
    const provider = quantizePricingProvider({
      id: "time.default",
      rules: [
        {
          id: "base",
          label: "Base",
          priority: 0,
          timeRange: { start: "00:00", end: "00:00" },
          pricing: {
            unitMinutes: 30,
            unitPrice: 0.07000000000000001,
            roundGraceMinutes: 5,
            priceCap: 80.00000000000001,
          },
        },
      ],
      paidHistory: { "rule:base": 12.3456789 },
    });

    expect(provider.rules[0]!.pricing).toEqual({
      unitMinutes: 30,
      unitPrice: 0.07,
      roundGraceMinutes: 5,
      priceCap: 80,
    });
    expect(provider.paidHistory).toEqual({ "rule:base": 12.35 });
  });

  it("keeps minute fields untouched because they are counts, not money", () => {
    const provider = quantizePricingProvider({
      id: "time.default",
      rules: [
        {
          id: "base",
          label: "Base",
          priority: 0,
          timeRange: { start: "00:00", end: "00:00" },
          pricing: {
            unitMinutes: 33.333333333333336,
            unitPrice: 7.5,
            roundGraceMinutes: 4.5,
            priceCap: 69,
          },
        },
      ],
    });

    expect(provider.rules[0]!.pricing.unitMinutes).toBe(33.333333333333336);
    expect(provider.rules[0]!.pricing.roundGraceMinutes).toBe(4.5);
    expect(provider.rules[0]!.pricing.unitPrice).toBe(7.5);
  });

  it("snaps global cap rule prices and leaves included config ids alone", () => {
    const provider = quantizePricingProvider({
      id: "cap.default",
      includedPricingConfigIds: ["pricing-1", "pricing-2"],
      rules: [
        {
          id: "cap",
          label: "Daily cap",
          priority: 0,
          timeRange: { start: "00:00", end: "00:00" },
          priceCap: 79.00000000000001,
        },
      ],
    });

    expect(provider.rules[0]!.priceCap).toBe(79);
    expect(provider.includedPricingConfigIds).toEqual(["pricing-1", "pricing-2"]);
  });

  it("snaps fixed charge amounts", () => {
    const provider = quantizePricingProvider({
      id: "fixed-1",
      label: "入场费",
      amount: 499.99999999999994,
    });

    expect(provider.amount).toBe(500);
  });
});
