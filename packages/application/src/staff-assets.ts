import type {
  AssetAdjustment,
  AssetDefinitionRepository,
  AssetGrant,
  AssetMergeStrategy,
  AssetRepository,
  OperationLockRepository,
  GrantAssetsResult,
} from "@prism/core";
import {
  adjustAssets,
  addCents,
  centsOf,
  deductCurrency,
  diffAssetHoldings,
  grantAssets,
  isActiveInWindow,
  isPositiveCents,
  isZeroCents,
  negCents,
  type Cents,
  PrismDomainError,
} from "@prism/core";
import { withOperationLease } from "./operation-lock";
import { sumAvailableWalletBalance, type AvailableAssetReader } from "./available-assets";

export type StaffAssetGrantInput = {
  staffId: string;
  playerId: string;
  reason?: string;
  grants: Array<{
    assetType: string;
    assetCode: string;
    amount: number;
    mergeStrategy: AssetMergeStrategy;
    activeAt: Date | null;
    expiresAt: Date | null;
    durationMs?: number;
  }>;
};

export type StaffAssetServiceDependencies = {
  assets: AssetRepository;
  availableAssets: AvailableAssetReader;
  assetDefinitions?: AssetDefinitionRepository;
  operationLocks?: OperationLockRepository;
  id: () => string;
  now: () => Date;
};

export type StaffAssetAdjustmentInput = {
  staffId: string;
  playerId: string;
  adjustments: Array<{
    holdingId?: string;
    assetType: string;
    assetCode: string;
    quantityDelta: number;
    activeAt?: Date | null;
    expiresAt?: Date | null;
    reason: string;
  }>;
};

export type StaffWalletAdjustmentInput = {
  staffId: string;
  playerId: string;
  amount: number;
  reason: string;
};

export type StaffWalletAdjustmentResult = GrantAssetsResult & {
  balanceBefore: Cents;
  balanceAfter: Cents;
};

export type StaffAssetService = {
  grantAssets(input: StaffAssetGrantInput): Promise<GrantAssetsResult>;
  adjustAssets(input: StaffAssetAdjustmentInput): Promise<GrantAssetsResult>;
  adjustWallet(input: StaffWalletAdjustmentInput): Promise<StaffWalletAdjustmentResult>;
};

export function createStaffAssetService(dependencies: StaffAssetServiceDependencies): StaffAssetService {
  return {
    async grantAssets(input) {
      return withPlayerAssetLease(dependencies, input.playerId, async () => {
      const now = dependencies.now();
      await assertGrantAssetDefinitionsActive(dependencies, input.grants, now);
      const existingHoldings = await dependencies.assets.listAssetHoldings(input.playerId);
      const reason = input.reason?.trim() || "staff.asset.grant";
      const grants: AssetGrant[] = input.grants.map((grant) => ({
        ...grant,
        reason,
        refId: input.staffId,
      }));
      const result = grantAssets({
        playerId: input.playerId,
        existingHoldings,
        grants,
        idFactory: dependencies.id,
        now,
      });
      const transactionId = assetTransactionId(
        "staff.asset.grant",
        input.staffId,
        input.playerId,
        now,
        dependencies.id(),
      );

      await dependencies.assets.commitAssetTransaction({
        transaction: {
          id: transactionId,
          playerId: input.playerId,
          kind: "staff.asset.grant",
          refId: input.staffId,
          createdAt: now,
          metadata: {
            staffId: input.staffId,
            grantCount: input.grants.length,
          },
        },
        holdingChanges: diffAssetHoldings(existingHoldings, result.holdings),
        assetLedgerEntries: result.assetLedgerEntries,
      });

      return result;
      });
    },

    async adjustAssets(input) {
      return withPlayerAssetLease(dependencies, input.playerId, async () => {
      const now = dependencies.now();
      const existingHoldings = await dependencies.assets.listAssetHoldings(input.playerId);
      const adjustments: AssetAdjustment[] = input.adjustments.map((adjustment) => ({
        ...adjustment,
        refId: input.staffId,
      }));
      const result = adjustAssets({
        playerId: input.playerId,
        existingHoldings,
        adjustments,
      });
      const transactionId = assetTransactionId(
        "staff.asset.adjust",
        input.staffId,
        input.playerId,
        now,
        dependencies.id(),
      );

      await dependencies.assets.commitAssetTransaction({
        transaction: {
          id: transactionId,
          playerId: input.playerId,
          kind: "staff.asset.adjust",
          refId: input.staffId,
          createdAt: now,
          metadata: {
            staffId: input.staffId,
            adjustmentCount: input.adjustments.length,
          },
        },
        holdingChanges: diffAssetHoldings(existingHoldings, result.holdings),
        assetLedgerEntries: result.assetLedgerEntries,
      });

      return result;
      });
    },

    async adjustWallet(input) {
      return withPlayerAssetLease(dependencies, input.playerId, async () => {
      if (!Number.isFinite(input.amount)) {
        throw new PrismDomainError("Wallet adjustment amount must be non-zero.", "INVALID_WALLET_ADJUSTMENT_AMOUNT");
      }
      const amount = centsOf(input.amount);
      if (isZeroCents(amount)) {
        throw new PrismDomainError("Wallet adjustment amount must be non-zero.", "INVALID_WALLET_ADJUSTMENT_AMOUNT");
      }
      const now = dependencies.now();
      const existingHoldings = await dependencies.assets.listAssetHoldings(input.playerId);
      const currentHoldings = existingHoldings.map((holding) => ({ ...holding }));
      const availableHoldings = await dependencies.availableAssets.resolveAvailableHoldings(currentHoldings, {
        at: now,
        includeHidden: true,
      });
      const balanceBefore = sumAvailableWalletBalance(availableHoldings);
      let result: GrantAssetsResult;
      if (isPositiveCents(amount)) {
        await assertGrantAssetDefinitionsActive(dependencies, [{
          assetType: "currency",
          assetCode: "free",
        }], now);
        result = grantAssets({
          playerId: input.playerId,
          existingHoldings,
          grants: [{
            assetType: "currency",
            assetCode: "free",
            amount: input.amount,
            mergeStrategy: "stack",
            activeAt: null,
            expiresAt: null,
            reason: input.reason,
            refId: input.staffId,
          }],
          idFactory: dependencies.id,
          now,
        });
      } else {
        const assetLedgerEntries = deductCurrency(availableHoldings.map((asset) => asset.holding), {
          amount: negCents(amount),
          reason: input.reason,
          refId: input.staffId,
          now,
        });
        result = { holdings: currentHoldings.filter((holding) => isPositiveCents(holding.quantity)), assetLedgerEntries };
      }
      const transactionId = assetTransactionId(
        "staff.wallet.adjust",
        input.staffId,
        input.playerId,
        now,
        dependencies.id(),
      );
      await dependencies.assets.commitAssetTransaction({
        transaction: {
          id: transactionId,
          playerId: input.playerId,
          kind: "staff.wallet.adjust",
          refId: input.staffId,
          createdAt: now,
          metadata: { staffId: input.staffId, amount, reason: input.reason },
        },
        holdingChanges: diffAssetHoldings(existingHoldings, result.holdings),
        assetLedgerEntries: result.assetLedgerEntries,
      });
      return { ...result, balanceBefore, balanceAfter: addCents(balanceBefore, amount) };
      });
    },
  };
}

function withPlayerAssetLease<T>(dependencies: StaffAssetServiceDependencies, playerId: string, action: () => Promise<T>): Promise<T> {
  return withOperationLease({ repository: dependencies.operationLocks, scope: "player.assets", resourceId: playerId, id: dependencies.id, now: dependencies.now }, action);
}

async function assertGrantAssetDefinitionsActive(
  dependencies: StaffAssetServiceDependencies,
  grants: readonly Pick<AssetGrant, "assetType" | "assetCode">[],
  now: Date,
): Promise<void> {
  if (!dependencies.assetDefinitions) return;

  const definitions = new Map(
    (await dependencies.assetDefinitions.listAll()).map((definition) => [
      `${definition.type}\u0000${definition.code}`,
      definition,
    ]),
  );
  for (const grant of grants) {
    const definition = definitions.get(`${grant.assetType}\u0000${grant.assetCode}`);
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

function assetTransactionId(
  kind: string,
  staffId: string,
  playerId: string,
  now: Date,
  id: string,
): string {
  return `asset-tx:${kind}:${staffId}:${playerId}:${now.toISOString()}:${id}`;
}
