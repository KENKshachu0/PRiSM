import type { PriorityTimePricingProviderConfig, TimeCapPricingProviderConfig } from "./pricing-time";
import { createPriorityTimePricingProvider } from "./pricing-time";
import { PrismDomainError } from "./errors";
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
          amount: config.amount,
        },
      ];
    },
  };
}

function hasActiveTimeRule(rules: readonly { status?: PricingConfigStatus; timeRange?: unknown; dateTimeRange?: unknown }[]): boolean {
  return rules.some((rule) => (rule.status ?? "active") === "active" && (!!rule.timeRange || !!rule.dateTimeRange));
}
