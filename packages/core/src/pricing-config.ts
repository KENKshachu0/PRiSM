import type { PriorityTimePricingProviderConfig, TimeCapPricingProviderConfig } from "./pricing-time";
import { createPriorityTimePricingProvider } from "./pricing-time";
import { PrismDomainError } from "./errors";
import { centsOf, quantizeMoney } from "./money";
import type { PricingProvider } from "./settlement";

export type PricingConfigKind = "time.priority" | "time.cap" | "charge.fixed";

export type TimePriorityPricingConfig = {
  id: string;
  kind: "time.priority";
  name: string;
  enabled: boolean;
  status?: PricingConfigStatus;
  provider: PriorityTimePricingProviderConfig;
  createdAt: Date;
  updatedAt: Date;
};

export type FixedChargePricingProviderConfig = {
  id: string;
  label: string;
  amount: number;
};

export type FixedChargePricingConfig = {
  id: string;
  kind: "charge.fixed";
  name: string;
  enabled: boolean;
  status?: PricingConfigStatus;
  provider: FixedChargePricingProviderConfig;
  createdAt: Date;
  updatedAt: Date;
};

export type TimeCapPricingConfig = {
  id: string;
  kind: "time.cap";
  name: string;
  enabled: boolean;
  status?: PricingConfigStatus;
  provider: TimeCapPricingProviderConfig;
  createdAt: Date;
  updatedAt: Date;
};

export type PricingConfig = TimePriorityPricingConfig | TimeCapPricingConfig | FixedChargePricingConfig;

export type PricingConfigStatus = "active" | "archived";

/**
 * Snaps every monetary field of a pricing provider to whole cents.
 *
 * Pricing values are the *basis* of every later charge: a `unitPrice` such as
 * `0.1` or `6.6` has no exact binary representation, and a single such value
 * makes every downstream product, cap and deduction carry error. Quantising here
 * — once, at the write boundary, before the config is validated and persisted —
 * keeps the whole charging pipeline working with values that are exact in the
 * sense that matters (a whole number of cents).
 *
 * Time fields (`unitMinutes`, `roundGraceMinutes`) are deliberately untouched:
 * minutes are counts, not money.
 */
export function quantizePricingProvider(
  provider: PriorityTimePricingProviderConfig,
): PriorityTimePricingProviderConfig;
export function quantizePricingProvider(
  provider: TimeCapPricingProviderConfig,
): TimeCapPricingProviderConfig;
export function quantizePricingProvider(
  provider: FixedChargePricingProviderConfig,
): FixedChargePricingProviderConfig;
export function quantizePricingProvider(
  provider: PricingConfig["provider"],
): PricingConfig["provider"] {
  if ("amount" in provider) {
    assertNonNegativePrice(provider.amount);
    return { ...provider, amount: quantizeMoney(provider.amount) };
  }

  if ("includedPricingConfigIds" in provider) {
    for (const rule of provider.rules) assertNonNegativePrice(rule.priceCap);
    return {
      ...provider,
      rules: provider.rules.map((rule) => ({ ...rule, priceCap: quantizeMoney(rule.priceCap) })),
      paidHistory: provider.paidHistory,
    };
  }

  for (const rule of provider.rules) {
    assertNonNegativePrice(rule.pricing.unitPrice);
    assertNonNegativePrice(rule.pricing.priceCap);
  }
  return {
    ...provider,
    rules: provider.rules.map((rule) => ({
      ...rule,
      pricing: {
        ...rule.pricing,
        unitPrice: quantizeMoney(rule.pricing.unitPrice),
        priceCap: quantizeMoney(rule.pricing.priceCap),
      },
    })),
    paidHistory: provider.paidHistory,
  };
}

function assertNonNegativePrice(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new PrismDomainError("Price must be a non-negative finite number.", "INVALID_PRICING_AMOUNT");
  }
}

export function createPricingProviderFromConfig(config: PricingConfig): PricingProvider {
  switch (config.kind) {
    case "time.priority":
      return createPriorityTimePricingProvider({
        ...config.provider,
        pricingConfigId: config.id,
        name: config.name,
      });
    case "time.cap":
      throw new PrismDomainError(
        "Global cap pricing configs do not create charge providers.",
        "TIME_CAP_CONFIG_IS_NOT_PRICING_PROVIDER",
      );
    case "charge.fixed":
      return createFixedChargePricingProvider(config.provider);
  }
}

export function validatePricingConfig(config: PricingConfig): void {
  if (!config.enabled) return;

  switch (config.kind) {
    case "time.priority":
      if (!hasActiveTimeRule(config.provider.rules)) {
        throw new PrismDomainError(
          "Enabled time priority pricing config requires at least one active time rule.",
          "PRICING_CONFIG_REQUIRES_ACTIVE_TIME_RULE",
        );
      }
      return;
    case "time.cap":
      if (config.provider.includedPricingConfigIds.length === 0) {
        throw new PrismDomainError(
          "Enabled global cap pricing config requires at least one included pricing config.",
          "TIME_CAP_REQUIRES_INCLUDED_PRICING_CONFIG",
        );
      }
      if (!hasActiveTimeRule(config.provider.rules)) {
        throw new PrismDomainError(
          "Enabled global cap pricing config requires at least one active cap rule.",
          "TIME_CAP_REQUIRES_ACTIVE_RULE",
        );
      }
      for (const rule of config.provider.rules) {
        if ((rule.status ?? "active") !== "active") continue;
        if (!Number.isFinite(rule.priceCap) || rule.priceCap < 0) {
          throw new PrismDomainError(
            "Global cap price must be a non-negative finite number.",
            "INVALID_TIME_CAP_PRICE",
          );
        }
      }
      return;
    case "charge.fixed":
      if (!Number.isFinite(config.provider.amount) || config.provider.amount < 0) {
        throw new PrismDomainError(
          "Fixed charge pricing amount must be a non-negative finite number.",
          "INVALID_FIXED_CHARGE_AMOUNT",
        );
      }
      return;
  }
}

function createFixedChargePricingProvider(config: FixedChargePricingProviderConfig): PricingProvider {
  return {
    id: config.id,
    quote(context) {
      return [
        {
          id: `${context.session.id}:${config.id}`,
          source: config.id,
          label: config.label,
          amount: centsOf(config.amount),
        },
      ];
    },
  };
}

function hasActiveTimeRule(rules: readonly { status?: PricingConfigStatus; timeRange?: unknown; dateTimeRange?: unknown }[]): boolean {
  return rules.some((rule) => (rule.status ?? "active") === "active" && (!!rule.timeRange || !!rule.dateTimeRange));
}
