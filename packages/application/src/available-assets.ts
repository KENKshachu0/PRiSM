import type {
  AssetDefinition,
  AssetDefinitionRepository,
  AssetHolding,
  AssetHoldingUnavailableReason,
  AssetRepository,
} from "@prism/core";
import { evaluateAssetHoldingAvailability, sumCurrencyHoldings,
  type Cents,
} from "@prism/core";

export type AvailableAsset = {
  holding: AssetHolding;
  definition: AssetDefinition;
};

export type AssetHoldingAssessment = {
  holding: AssetHolding;
  definition: AssetDefinition | null;
  availability: "available" | "unavailable";
  unavailableReasons: AssetHoldingUnavailableReason[];
};

export type AvailableAssetView = Omit<AssetHolding, "id" | "activeAt" | "expiresAt"> & {
  id: string;
  activeAt: Date | null;
  expiresAt: Date | null;
  assetName: string;
  metadata: Record<string, unknown> | null;
};

export type AssessedAssetView = Omit<AvailableAssetView, "assetName"> & {
  assetName: string | null;
  availability: AssetHoldingAssessment["availability"];
  unavailableReasons: AssetHoldingUnavailableReason[];
};

export type AvailableAssetReadOptions = {
  at?: Date;
  includeHidden?: boolean;
};

export type AvailableAssetReader = {
  listPlayerAvailableAssets(
    playerId: string,
    options?: AvailableAssetReadOptions,
  ): Promise<AvailableAsset[]>;
  resolveAvailableHoldings(
    holdings: readonly AssetHolding[],
    options?: AvailableAssetReadOptions,
  ): Promise<AvailableAsset[]>;
  listPlayerAssetAssessments(
    playerId: string,
    options?: AvailableAssetReadOptions,
  ): Promise<AssetHoldingAssessment[]>;
  assessHoldings(
    holdings: readonly AssetHolding[],
    options?: AvailableAssetReadOptions,
  ): Promise<AssetHoldingAssessment[]>;
};

export function createAvailableAssetReader(dependencies: {
  assets: AssetRepository;
  assetDefinitions: AssetDefinitionRepository;
  now: () => Date;
}): AvailableAssetReader {
  async function assess(
    holdings: readonly AssetHolding[],
    options: AvailableAssetReadOptions = {},
  ): Promise<AssetHoldingAssessment[]> {
    const definitions = await dependencies.assetDefinitions.listAll();
    const definitionsByKey = new Map(
      definitions.map((definition) => [assetKey(definition.type, definition.code), definition]),
    );
    const at = options.at ?? dependencies.now();

    return holdings.map((holding) => {
      const definition = definitionsByKey.get(assetKey(holding.assetType, holding.assetCode)) ?? null;
      const evaluation = evaluateAssetHoldingAvailability({
        holding,
        definition,
        at,
        includeHidden: options.includeHidden,
      });
      return {
        holding,
        definition,
        availability: evaluation.available ? "available" : "unavailable",
        unavailableReasons: evaluation.unavailableReasons,
      };
    });
  }

  async function resolve(
    holdings: readonly AssetHolding[],
    options: AvailableAssetReadOptions = {},
  ): Promise<AvailableAsset[]> {
    const assessments = await assess(holdings, options);
    return assessments.flatMap((assessment) =>
      assessment.availability === "available" && assessment.definition
        ? [{ holding: assessment.holding, definition: assessment.definition }]
        : [],
    );
  }

  return {
    async listPlayerAvailableAssets(playerId, options = {}) {
      const holdings = await dependencies.assets.listAssetHoldings(playerId);
      return resolve(holdings, options);
    },
    async listPlayerAssetAssessments(playerId, options = {}) {
      const holdings = await dependencies.assets.listAssetHoldings(playerId);
      return assess(holdings, options);
    },
    resolveAvailableHoldings: resolve,
    assessHoldings: assess,
  };
}

export function toAvailableAssetView(asset: AvailableAsset): AvailableAssetView {
  return {
    ...asset.holding,
    id: asset.holding.id!,
    activeAt: asset.holding.activeAt ?? null,
    expiresAt: asset.holding.expiresAt ?? null,
    assetName: asset.definition.name,
    metadata: asset.definition.metadata,
  };
}

export function toAssessedAssetView(asset: AssetHoldingAssessment): AssessedAssetView {
  return {
    ...asset.holding,
    id: asset.holding.id!,
    activeAt: asset.holding.activeAt ?? null,
    expiresAt: asset.holding.expiresAt ?? null,
    assetName: asset.definition?.name ?? null,
    metadata: asset.definition?.metadata ?? null,
    availability: asset.availability,
    unavailableReasons: asset.unavailableReasons,
  };
}

/** Aggregates only currency holdings that the shared availability resolver accepted. */
export function sumAvailableWalletBalance(assets: readonly AvailableAsset[]): Cents {
  return sumCurrencyHoldings(assets.map((asset) => asset.holding));
}

export function assetKey(assetType: string, assetCode: string): string {
  return `${assetType}\u0000${assetCode}`;
}
