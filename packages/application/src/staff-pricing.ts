import { buildPriorityTimePricingTimeline, buildTimeCapPricingTimeline, PrismDomainError, quantizePricingProvider, validatePricingConfig } from "@prism/core";
import type {
  PricingConfig,
  PricingConfigKind,
  PricingConfigRepository,
  PriorityTimePricingTimeline,
} from "@prism/core";

export type StaffCreatePricingConfigInput = {
  kind: PricingConfigKind;
  name: string;
  enabled: boolean;
  provider: PricingConfig["provider"];
};

export type StaffUpdatePricingConfigInput = {
  pricingConfigId: string;
  name: string;
  enabled: boolean;
  provider: PricingConfig["provider"];
};

export type StaffPricingServiceDependencies = {
  pricingConfigs: PricingConfigRepository;
  getDefaultTimeZone?: () => Promise<string | undefined>;
  id: () => string;
  now: () => Date;
};

export type StaffPricingService = {
  createPricingConfig(input: StaffCreatePricingConfigInput): Promise<PricingConfig>;
  updatePricingConfig(input: StaffUpdatePricingConfigInput): Promise<PricingConfig>;
  archivePricingConfig(input: { pricingConfigId: string }): Promise<PricingConfig>;
  restorePricingConfig(input: { pricingConfigId: string }): Promise<PricingConfig>;
  listPricingConfigs(): Promise<PricingConfig[]>;
  getPricingTimeline(input: { pricingConfigId: string; localDate: string }): Promise<PriorityTimePricingTimeline>;
  previewPricingTimeline(input: {
    provider:
      | Extract<PricingConfig, { kind: "time.priority" }>["provider"]
      | Extract<PricingConfig, { kind: "time.cap" }>["provider"];
    localDate: string;
  }): Promise<PriorityTimePricingTimeline>;
};

export function createStaffPricingService(dependencies: StaffPricingServiceDependencies): StaffPricingService {
  return {
    async createPricingConfig(input) {
      const now = dependencies.now();
      const base = {
        id: dependencies.id(),
        name: input.name,
        enabled: input.enabled,
        status: "active" as const,
        createdAt: now,
        updatedAt: now,
      };
      const config = await createPricingConfigForKind(input.kind, input.provider, base, dependencies);

      validatePricingConfig(config);
      await dependencies.pricingConfigs.save(config);
      return config;
    },

    async updatePricingConfig(input) {
      const existing = await dependencies.pricingConfigs.findById(input.pricingConfigId);
      if (!existing) {
        throw new PrismDomainError("Pricing config not found.", "PRICING_CONFIG_NOT_FOUND");
      }
      const status = existing.status ?? "active";

      const config = await createPricingConfigForKind(
        existing.kind,
        input.provider,
        {
          id: existing.id,
          name: input.name,
          enabled: status === "archived" ? false : input.enabled,
          status,
          createdAt: existing.createdAt,
          updatedAt: dependencies.now(),
        },
        dependencies,
      );

      validatePricingConfig(config);
      await dependencies.pricingConfigs.save(config);
      return config;
    },

    async archivePricingConfig(input) {
      const existing = await dependencies.pricingConfigs.findById(input.pricingConfigId);
      if (!existing) {
        throw new PrismDomainError("Pricing config not found.", "PRICING_CONFIG_NOT_FOUND");
      }
      const archived: PricingConfig = {
        ...existing,
        enabled: false,
        status: "archived",
        updatedAt: dependencies.now(),
      };
      await dependencies.pricingConfigs.save(archived);
      return archived;
    },

    async restorePricingConfig(input) {
      const existing = await dependencies.pricingConfigs.findById(input.pricingConfigId);
      if (!existing) {
        throw new PrismDomainError("Pricing config not found.", "PRICING_CONFIG_NOT_FOUND");
      }
      const restored: PricingConfig = {
        ...existing,
        enabled: false,
        status: "active",
        updatedAt: dependencies.now(),
      };
      await dependencies.pricingConfigs.save(restored);
      return restored;
    },

    async listPricingConfigs() {
      return dependencies.pricingConfigs.listAll();
    },

    async getPricingTimeline(input) {
      const config = await dependencies.pricingConfigs.findById(input.pricingConfigId);
      if (!config) {
        throw new PrismDomainError("Pricing config not found.", "PRICING_CONFIG_NOT_FOUND");
      }
      if (config.kind !== "time.priority") {
        throw new PrismDomainError("Pricing config does not have a time timeline.", "PRICING_CONFIG_TIMELINE_NOT_SUPPORTED");
      }
      return buildPriorityTimePricingTimeline({
        localDate: input.localDate,
        config: await withDefaultTimeZone(config.provider, dependencies),
      });
    },

    async previewPricingTimeline(input) {
      if ("includedPricingConfigIds" in input.provider) {
        return buildTimeCapPricingTimeline({
          localDate: input.localDate,
          config: quantizePricingProvider(await withDefaultCapTimeZone(input.provider, dependencies)),
        });
      }
      return buildPriorityTimePricingTimeline({
        localDate: input.localDate,
        config: quantizePricingProvider(await withDefaultTimeZone(input.provider, dependencies)),
      });
    },
  };
}

async function createPricingConfigForKind(
  kind: PricingConfigKind,
  provider: PricingConfig["provider"],
  base: Omit<PricingConfig, "kind" | "provider">,
  dependencies: StaffPricingServiceDependencies,
): Promise<PricingConfig> {
  switch (kind) {
    case "time.priority":
      if (
        !("rules" in provider) ||
        "includedPricingConfigIds" in provider ||
        provider.rules.some((rule) => !("pricing" in rule))
      ) {
        throw new PrismDomainError("Time priority pricing requires time rules.", "INVALID_TIME_PRIORITY_PROVIDER");
      }
      return {
        ...base,
        kind,
        provider: quantizePricingProvider(
          await withDefaultTimeZone(
            provider as Extract<PricingConfig, { kind: "time.priority" }>["provider"],
            dependencies,
          ),
        ),
      };
    case "time.cap":
      if (
        !("rules" in provider) ||
        !("includedPricingConfigIds" in provider) ||
        provider.rules.some((rule) => "pricing" in rule || !("priceCap" in rule))
      ) {
        throw new PrismDomainError("Global cap pricing requires cap rules and included pricing configs.", "INVALID_TIME_CAP_PROVIDER");
      }
      await assertIncludedPricingConfigsAreTimePriority(provider.includedPricingConfigIds, dependencies);
      return {
        ...base,
        kind,
        provider: quantizePricingProvider(
          await withDefaultCapTimeZone(
            provider as Extract<PricingConfig, { kind: "time.cap" }>["provider"],
            dependencies,
          ),
        ),
      };
    case "charge.fixed":
      if (!("amount" in provider)) {
        throw new PrismDomainError("Fixed charge pricing requires an amount.", "INVALID_FIXED_CHARGE_PROVIDER");
      }
      return {
        ...base,
        kind,
        provider: quantizePricingProvider(provider),
      };
  }
}

async function assertIncludedPricingConfigsAreTimePriority(
  pricingConfigIds: readonly string[],
  dependencies: StaffPricingServiceDependencies,
): Promise<void> {
  if (pricingConfigIds.length === 0) return;
  const configsById = new Map(
    (await dependencies.pricingConfigs.listAll()).map((config) => [config.id, config]),
  );
  for (const pricingConfigId of pricingConfigIds) {
    const config = configsById.get(pricingConfigId);
    if (!config || config.kind !== "time.priority") {
      throw new PrismDomainError(
        "Global cap included pricing configs must reference time priority configs.",
        "INVALID_TIME_CAP_INCLUDED_PRICING_CONFIG",
      );
    }
  }
}

async function withDefaultTimeZone(
  provider: Extract<PricingConfig, { kind: "time.priority" }>["provider"],
  dependencies: StaffPricingServiceDependencies,
): Promise<Extract<PricingConfig, { kind: "time.priority" }>["provider"]> {
  const timeZone = provider.timeZone ?? (await dependencies.getDefaultTimeZone?.());
  if (!timeZone) return provider;
  return {
    ...provider,
    timeZone,
  };
}

async function withDefaultCapTimeZone(
  provider: Extract<PricingConfig, { kind: "time.cap" }>["provider"],
  dependencies: StaffPricingServiceDependencies,
): Promise<Extract<PricingConfig, { kind: "time.cap" }>["provider"]> {
  const timeZone = provider.timeZone ?? (await dependencies.getDefaultTimeZone?.());
  if (!timeZone) return provider;
  return {
    ...provider,
    timeZone,
  };
}
