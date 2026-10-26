import {
  collectPriorityTimePricingHistoryLookupKeys,
  createPricingProviderFromConfig,
  PrismDomainError,
  type PricingConfig,
  type PricingProvider,
  type PricingHistoryRepository,
} from "@prism/core";
import type { SettlementServiceDependencies } from "./settlement-service";

export function createVersionedPricingResolvers(input: {
  sessionPricing: (
    session: import("@prism/core").Session,
  ) => Promise<{ configs: PricingConfig[]; timeZone: string }>;
  pricingHistory: Pick<PricingHistoryRepository, "sumByPlayerAndKeys">;
  fallbackPricingProviders?: readonly PricingProvider[];
  pluginPricingProviders?: readonly PricingProvider[];
}): Pick<
  SettlementServiceDependencies,
  "pricingProviderResolver" | "globalCapResolver"
> {
  const fallbackPricingProviders = input.fallbackPricingProviders ?? [];
  const pluginPricingProviders = input.pluginPricingProviders ?? [];
  const versioned = historyVersionedConfig;
  return {
    async pricingProviderResolver(context) {
      const pinned = await input.sessionPricing(context.session);
      const allConfigs = pinned.configs;
      const sessionConfigIds = context.session.pricingConfigIds ?? [];
      const configs = (
        sessionConfigIds.length > 0
          ? allConfigs.filter((config) => sessionConfigIds.includes(config.id))
          : allConfigs
      )
        .filter((config) => config.kind !== "time.cap")
        .map(versioned);

      if (configs.length === 0)
        return [...fallbackPricingProviders, ...pluginPricingProviders];
      const storeTimeZone = pinned.timeZone ?? "UTC";
      const resolvedConfigs = await withRuntimePricingHistory(configs, {
        playerId: context.playerId,
        startedAt: context.session.startedAt,
        endedAt: context.session.endedAt ?? context.now,
        storeTimeZone,
        pricingHistory: input.pricingHistory,
      });
      return [
        ...pluginPricingProviders,
        ...resolvedConfigs.map((config) =>
          createPricingProviderFromConfig(config),
        ),
      ];
    },
    async globalCapResolver(context) {
      const storeTimeZone = "UTC";
      const releases = new Map(
        context.sessions.map((session) => [
          session.pricingReleaseId ?? "legacy",
          session,
        ]),
      );
      if (releases.size > 1)
        throw new PrismDomainError(
          "Unsettled sessions use different pricing releases.",
          "PRICING_RELEASE_MISMATCH",
        );
      const result: import("@prism/core").TimeCapPricingProviderConfig[] = [];
      for (const session of releases.values()) {
        const pinned = await input.sessionPricing(session);
        for (const config of pinned.configs) {
          if (config.kind !== "time.cap") continue;
          result.push(capProviderConfig(config, pinned.timeZone ?? context.timeZone ?? storeTimeZone, capTimePlanIds(pinned.configs)));
        }
      }
      return result;
    },
  };
}

/** A plan as its spending history is keyed: the provider ID of the version that recorded it. */
export function historyVersionedConfig(config: PricingConfig): PricingConfig {
  if (config.kind === "time.priority" && config.provider.historyProviderId) {
    return {
      ...config,
      provider: { ...config.provider, id: config.provider.historyProviderId },
    };
  }
  // Version 1 keeps the pre-migration history key so an upgrade cannot reset caps.
  if (!config.versionId || config.version === 1) return config;
  return {
    ...config,
    provider: { ...config.provider, id: config.versionId },
  } as PricingConfig;
}

/** The time plans a cap across plans holds: every one of the release it is in. */
export function capTimePlanIds(configs: readonly PricingConfig[]): string[] {
  return configs.filter((config) => config.kind === "time.priority").map((config) => config.id);
}

/** A cross-plan cap as settlement applies it, over every time plan of its release. */
export function capProviderConfig(
  config: Extract<PricingConfig, { kind: "time.cap" }>,
  timeZone: string,
  timePlanIds: readonly string[],
): import("@prism/core").TimeCapPricingProviderConfig {
  return {
    ...config.provider,
    name: config.name,
    // A publication pins both the cap and its included plan versions.
    pricingConfigId: config.version === 1 ? config.id : (config.versionId ?? config.id),
    includedPricingConfigIds: [...timePlanIds],
    timeZone: config.provider.timeZone ?? timeZone,
  };
}

async function withRuntimePricingHistory(
  configs: readonly PricingConfig[],
  input: {
    playerId: string;
    startedAt: Date;
    endedAt: Date;
    storeTimeZone?: string;
    pricingHistory: Pick<PricingHistoryRepository, "sumByPlayerAndKeys">;
  },
): Promise<PricingConfig[]> {
  const providersByConfigId = new Map<
    string,
    Extract<PricingConfig, { kind: "time.priority" }>["provider"]
  >();
  const keys = configs.flatMap((config) => {
    if (config.kind !== "time.priority") return [];
    const provider = {
      ...config.provider,
      timeZone: config.provider.timeZone ?? input.storeTimeZone,
      pricingConfigId: config.id,
    };
    providersByConfigId.set(config.id, provider);
    return collectPriorityTimePricingHistoryLookupKeys({
      config: provider,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
    });
  });
  const paidHistory = await input.pricingHistory.sumByPlayerAndKeys(
    input.playerId,
    keys,
  );

  return configs.map((config) => {
    if (config.kind !== "time.priority") return config;
    return {
      ...config,
      provider: {
        ...providersByConfigId.get(config.id)!,
        paidHistory,
      },
    };
  });
}
