import type {
  AssetDefinitionRepository,
  AssetRepository,
  GrantAssetsResult,
  OperationLockRepository,
  PresentGrant,
  RedeemRepository,
  RedeemRecord,
} from "@prism/core";
import { diffAssetHoldings, PrismDomainError, isActiveInWindow, redeemGift } from "@prism/core";
import { withOperationLease } from "./operation-lock";
import { assetKey, toAvailableAssetView, type AvailableAssetReader, type AvailableAssetView } from "./available-assets";

export type RedeemServiceDependencies = {
  assets: AssetRepository;
  assetDefinitions?: AssetDefinitionRepository;
  redeems: RedeemRepository;
  operationLocks?: OperationLockRepository;
  availableAssets: AvailableAssetReader;
  now: () => Date;
  id: () => string;
};

export type RedeemCodeInput = {
  playerId: string;
  code: string;
};

export type RedeemCodeResult = GrantAssetsResult & {
  redeemRecord: RedeemRecord;
  availableHoldings: AvailableAssetView[];
  grantedAssets: Array<{
    assetType: string;
    assetCode: string;
    assetName: string;
    quantity: number;
  }>;
};

export type RedeemService = {
  redeemCode(input: RedeemCodeInput): Promise<RedeemCodeResult>;
};

export function createRedeemService(dependencies: RedeemServiceDependencies): RedeemService {
  return {
    async redeemCode(input) {
      return withOperationLease({ repository: dependencies.operationLocks, scope: "player.assets", resourceId: input.playerId, id: dependencies.id, now: dependencies.now }, async () => {
      const code = await dependencies.redeems.findRedeemCodeByCode(input.code);
      if (!code) {
        throw new PrismDomainError("Redeem code not found.", "REDEEM_CODE_NOT_FOUND");
      }

      const present = await dependencies.redeems.findPresentById(code.presentId);
      if (!present) {
        throw new PrismDomainError("Present not found.", "PRESENT_NOT_FOUND");
      }
      if (present.status === "archived") {
        throw new PrismDomainError("Present has been archived.", "PRESENT_ARCHIVED");
      }
      const now = dependencies.now();
      await assertPresentGrantAssetDefinitionsActive(dependencies, present.grants, now);

      const [existingHoldings, redeemRecords] = await Promise.all([
        dependencies.assets.listAssetHoldings(input.playerId),
        dependencies.redeems.listRedeemRecords(),
      ]);

      const result = redeemGift({
        playerId: input.playerId,
        code,
        present,
        existingHoldings,
        redeemRecords,
        now,
        idFactory: dependencies.id,
      });

      await dependencies.assets.commitAssetTransaction({
        transaction: {
          id: `asset-tx:gift.redeem:${code.id}:${input.playerId}`,
          playerId: input.playerId,
          kind: "gift.redeem",
          refId: code.id,
          createdAt: result.redeemRecord.redeemedAt,
          metadata: {
            presentId: present.id,
            presentName: present.name,
            grantCount: present.grants.length,
          },
        },
        holdingChanges: diffAssetHoldings(existingHoldings, result.holdings),
        assetLedgerEntries: result.assetLedgerEntries,
      });
      await dependencies.redeems.saveRedeemRecord(result.redeemRecord);

      const available = await dependencies.availableAssets.resolveAvailableHoldings(result.holdings);
      const availableByKey = new Map(
        available.map((asset) => [assetKey(asset.holding.assetType, asset.holding.assetCode), asset]),
      );
      const grantedAssets = result.assetLedgerEntries.flatMap((entry) => {
        if (entry.delta <= 0) return [];
        const asset = availableByKey.get(assetKey(entry.assetType, entry.assetCode));
        if (!asset) return [];
        return [{
          assetType: entry.assetType,
          assetCode: entry.assetCode,
          assetName: asset.definition.name,
          quantity: entry.delta,
        }];
      });

      return {
        ...result,
        availableHoldings: available.map(toAvailableAssetView),
        grantedAssets,
      };
      });
    },
  };
}

export async function assertPresentGrantAssetDefinitionsActive(
  dependencies: Pick<RedeemServiceDependencies, "assetDefinitions">,
  grants: readonly Pick<PresentGrant, "assetType" | "assetCode" | "activeAt" | "expiresAt">[],
  now: Date,
): Promise<void> {
  if (!dependencies.assetDefinitions) return;

  const definitions = new Map(
    (await dependencies.assetDefinitions.listAll()).map((definition) => [
      assetKey(definition.type, definition.code),
      definition,
    ]),
  );
  for (const grant of grants) {
    if (!isActiveInWindow(grant, now)) continue;
    const definition = definitions.get(assetKey(grant.assetType, grant.assetCode));
    if (!definition) {
      throw new PrismDomainError("Asset definition not found.", "ASSET_DEFINITION_NOT_FOUND");
    }
    if (definition.status === "archived") {
      throw new PrismDomainError("Asset definition has been archived.", "ASSET_DEFINITION_ARCHIVED");
    }
    if (!isActiveInWindow(definition, now)) {
      throw new PrismDomainError("Asset definition is not available.", "ASSET_DEFINITION_NOT_AVAILABLE");
    }
  }
}
