import { PrismDomainError } from "./errors";
import {
  type Cents,
  addCents,
  centsOf,
  isNegativeCents,
  isPositiveCents,
  sumCents,
} from "./money";

export type AssetDefinition = {
  type: string;
  code: string;
  name: string;
  stackable: boolean;
  status?: AssetDefinitionStatus;
  pricingEffectId?: string | null;
  pricingEffect?: PricingEffect | null;
  activeAt?: Date | null;
  expiresAt?: Date | null;
  metadata: Record<string, unknown> | null;
};

export type AssetDefinitionStatus = "active" | "archived";

export type PricingEffectStatus = "active" | "archived";

export type PricingEffectType = "free" | "discount" | "percentage-discount" | "surcharge";

export type PricingEffectScope = "session" | "unified";

export type PricingEffect = {
  id: string;
  name: string;
  type: PricingEffectType;
  scope: PricingEffectScope;
  value: number | null;
  consumable: boolean;
  limitPerDay: number | null;
  activeAt?: Date | null;
  expiresAt?: Date | null;
  status?: PricingEffectStatus;
  config: Record<string, unknown> | null;
};

export function isActiveInWindow(
  item: { activeAt?: Date | null; expiresAt?: Date | null },
  now: Date,
): boolean {
  if (item.activeAt && item.activeAt > now) return false;
  if (item.expiresAt && item.expiresAt <= now) return false;
  return true;
}

export type AssetHolding = {
  id?: string;
  assetType: string;
  assetCode: string;
  quantity: Cents;
  activeAt?: Date | null;
  expiresAt?: Date | null;
};

/**
 * The minimal current-state projection change caused by one asset transaction.
 *
 * `upserts` contains new or changed holdings only. `deleteIds` contains holdings
 * whose quantity reached zero or which were explicitly revoked. Callers must
 * persist this change together with its transaction and ledger entries.
 */
export type AssetHoldingChanges = {
  upserts: AssetHolding[];
  deleteIds: string[];
};

/**
 * Builds the write set for a current-holdings projection without treating a
 * player's complete inventory as a replaceable document.
 *
 * Quantity comparison here is deliberately exact (`===`) rather than
 * tolerance-based: this is a "did anything change?" test for persistence, and
 * every caller is expected to have run its quantities through
 * `normalizeQuantity` first so the values are canonical. An error on the strict
 * side only writes one extra row; a tolerance would silently drop a genuine
 * sub-cent change.
 */
export function diffAssetHoldings(
  before: readonly AssetHolding[],
  after: readonly AssetHolding[],
): AssetHoldingChanges {
  const beforeById = new Map(
    before.flatMap((holding) => holding.id ? [[holding.id, holding] as const] : []),
  );
  const afterIds = new Set(after.flatMap((holding) => holding.id ? [holding.id] : []));
  const upserts = after.flatMap((holding) => {
    const previous = holding.id ? beforeById.get(holding.id) : undefined;
    return previous && sameHolding(previous, holding) ? [] : [{ ...holding }];
  });
  const deleteIds = [...beforeById.keys()].filter((id) => !afterIds.has(id));

  return { upserts, deleteIds };
}

function sameHolding(left: AssetHolding, right: AssetHolding): boolean {
  return left.id === right.id &&
    left.assetType === right.assetType &&
    left.assetCode === right.assetCode &&
    left.quantity === right.quantity &&
    sameInstant(left.activeAt ?? null, right.activeAt ?? null) &&
    sameInstant(left.expiresAt ?? null, right.expiresAt ?? null);
}

/** Sums currency holdings that have already passed the caller's availability checks. */
export function sumCurrencyHoldings(
  holdings: readonly Pick<AssetHolding, "assetType" | "quantity">[],
): Cents {
  return sumCents(
    holdings
      .filter((holding) => holding.assetType === "currency")
      .map((holding) => holding.quantity),
  );
}

export type AssetHoldingUnavailableReason =
  | "quantity_not_positive"
  | "holding_not_active"
  | "holding_expired"
  | "definition_missing"
  | "definition_archived"
  | "definition_not_active"
  | "definition_expired"
  | "hidden_from_player";

export function evaluateAssetHoldingAvailability(input: {
  holding: AssetHolding;
  definition: AssetDefinition | null;
  at: Date;
  includeHidden?: boolean;
}): {
  available: boolean;
  unavailableReasons: AssetHoldingUnavailableReason[];
} {
  const unavailableReasons: AssetHoldingUnavailableReason[] = [];
  if (!isPositiveCents(input.holding.quantity)) unavailableReasons.push("quantity_not_positive");
  if (input.holding.activeAt && input.holding.activeAt > input.at) {
    unavailableReasons.push("holding_not_active");
  }
  if (input.holding.expiresAt && input.holding.expiresAt <= input.at) {
    unavailableReasons.push("holding_expired");
  }
  if (!input.definition) {
    unavailableReasons.push("definition_missing");
  } else {
    if (input.definition.status === "archived") unavailableReasons.push("definition_archived");
    if (input.definition.activeAt && input.definition.activeAt > input.at) {
      unavailableReasons.push("definition_not_active");
    }
    if (input.definition.expiresAt && input.definition.expiresAt <= input.at) {
      unavailableReasons.push("definition_expired");
    }
    if (!input.includeHidden && input.definition.metadata?.hiddenFromPlayer === true) {
      unavailableReasons.push("hidden_from_player");
    }
  }
  return {
    available: unavailableReasons.length === 0,
    unavailableReasons,
  };
}

export function isAssetHoldingAvailableAt(input: {
  holding: AssetHolding;
  definition: AssetDefinition | null;
  at: Date;
  includeHidden?: boolean;
}): boolean {
  return evaluateAssetHoldingAvailability(input).available;
}

export type AssetLedgerEntry = {
  assetType: string;
  assetCode: string;
  delta: Cents;
  reason: string;
  refId: string;
  transactionId?: string;
};

export type AssetTransaction = {
  id: string;
  playerId: string;
  kind: string;
  refId: string;
  createdAt: Date;
  metadata: Record<string, unknown> | null;
};

export type AssetMergeStrategy = "stack" | "extend-time" | "replace";

export type AssetGrant = {
  assetType: string;
  assetCode: string;
  amount: number;
  mergeStrategy: AssetMergeStrategy;
  activeAt: Date | null;
  expiresAt: Date | null;
  durationMs?: number;
  reason: string;
  refId: string;
};

export type GrantAssetsInput = {
  playerId: string;
  existingHoldings: readonly AssetHolding[];
  grants: readonly AssetGrant[];
  idFactory: () => string;
  now?: Date;
};

export type GrantAssetsResult = {
  holdings: AssetHolding[];
  assetLedgerEntries: AssetLedgerEntry[];
};

export type AssetAdjustment = {
  holdingId?: string;
  assetType: string;
  assetCode: string;
  quantityDelta: number;
  activeAt?: Date | null;
  expiresAt?: Date | null;
  reason: string;
  refId: string;
};

export type AdjustAssetsInput = {
  playerId: string;
  existingHoldings: readonly AssetHolding[];
  adjustments: readonly AssetAdjustment[];
};

export function grantAssets(input: GrantAssetsInput): GrantAssetsResult {
  const holdings = input.existingHoldings.map((asset) => ({ ...asset }));
  const assetLedgerEntries: AssetLedgerEntry[] = [];

  for (const grant of input.grants) {
    const amount = centsOf(grant.amount);
    if (!isPositiveCents(amount)) {
      throw new PrismDomainError("Asset grant amount must be positive.", "INVALID_ASSET_GRANT_AMOUNT");
    }

    if (grant.mergeStrategy === "stack") {
      const target = holdings.find((asset) => canStackAsset(asset, grant));
      if (target) {
        target.quantity = addCents(target.quantity, amount);
      } else {
        holdings.push(createGrantedAsset(input.idFactory(), grant, amount));
      }
    } else if (grant.mergeStrategy === "extend-time") {
      applyExtendTimeGrant(holdings, grant, input.idFactory, input.now ?? new Date(0), amount);
    } else if (grant.mergeStrategy === "replace") {
      applyReplaceGrant(holdings, grant, input.idFactory, amount);
    } else {
      throw new PrismDomainError("Unsupported asset merge strategy.", "UNSUPPORTED_ASSET_MERGE_STRATEGY");
    }

    assetLedgerEntries.push({
      assetType: grant.assetType,
      assetCode: grant.assetCode,
      delta: amount,
      reason: grant.reason,
      refId: grant.refId,
    });
  }

  return { holdings, assetLedgerEntries };
}

export function adjustAssets(input: AdjustAssetsInput): GrantAssetsResult {
  const holdings = input.existingHoldings.map((asset) => ({ ...asset }));
  const assetLedgerEntries: AssetLedgerEntry[] = [];

  for (const adjustment of input.adjustments) {
    const target = holdings.find((holding) => canAdjustAsset(holding, adjustment));
    if (!target) {
      throw new PrismDomainError("Asset holding not found.", "ASSET_HOLDING_NOT_FOUND");
    }

    const quantityDelta = centsOf(adjustment.quantityDelta);
    const nextQuantity = addCents(target.quantity, quantityDelta);
    if (isNegativeCents(nextQuantity)) {
      throw new PrismDomainError("Insufficient asset quantity.", "INSUFFICIENT_ASSET_QUANTITY");
    }

    target.quantity = nextQuantity;
    if ("activeAt" in adjustment) target.activeAt = adjustment.activeAt ?? null;
    if ("expiresAt" in adjustment) target.expiresAt = adjustment.expiresAt ?? null;

    assetLedgerEntries.push({
      assetType: adjustment.assetType,
      assetCode: adjustment.assetCode,
      delta: quantityDelta,
      reason: adjustment.reason,
      refId: adjustment.refId,
    });
  }

  return {
    holdings: holdings.filter((holding) => isPositiveCents(holding.quantity)),
    assetLedgerEntries,
  };
}

function applyReplaceGrant(
  holdings: AssetHolding[],
  grant: AssetGrant,
  idFactory: () => string,
  amount: Cents,
): void {
  const target = holdings.find((asset) => asset.assetType === grant.assetType && asset.assetCode === grant.assetCode);

  if (!target) {
    holdings.push(createGrantedAsset(idFactory(), grant, amount));
    return;
  }

  target.quantity = amount;
  target.activeAt = grant.activeAt;
  target.expiresAt = grant.expiresAt;
}

function applyExtendTimeGrant(
  holdings: AssetHolding[],
  grant: AssetGrant,
  idFactory: () => string,
  now: Date,
  amount: Cents,
): void {
  if (!grant.durationMs || grant.durationMs <= 0) {
    throw new PrismDomainError("Extend-time asset grant requires a positive duration.", "INVALID_ASSET_GRANT_DURATION");
  }

  const target = holdings
    .filter((asset) => asset.assetType === grant.assetType && asset.assetCode === grant.assetCode)
    .sort((a, b) => getTime(b.expiresAt ?? null) - getTime(a.expiresAt ?? null))[0];

  if (!target) {
    const base = grant.activeAt ?? now;
    holdings.push({
      id: idFactory(),
      assetType: grant.assetType,
      assetCode: grant.assetCode,
      quantity: amount,
      activeAt: grant.activeAt ?? now,
      expiresAt: new Date(base.getTime() + grant.durationMs),
    });
    return;
  }

  const base = target.expiresAt && target.expiresAt > now ? target.expiresAt : now;
  target.expiresAt = new Date(base.getTime() + grant.durationMs);
}

function canStackAsset(asset: AssetHolding, grant: AssetGrant): boolean {
  return (
    asset.assetType === grant.assetType &&
    asset.assetCode === grant.assetCode &&
    sameInstant(asset.activeAt ?? null, grant.activeAt) &&
    sameInstant(asset.expiresAt ?? null, grant.expiresAt)
  );
}

function canAdjustAsset(asset: AssetHolding, adjustment: AssetAdjustment): boolean {
  if (adjustment.holdingId) return asset.id === adjustment.holdingId;

  return (
    asset.assetType === adjustment.assetType &&
    asset.assetCode === adjustment.assetCode &&
    (!("activeAt" in adjustment) || sameInstant(asset.activeAt ?? null, adjustment.activeAt ?? null))
  );
}

function createGrantedAsset(id: string, grant: AssetGrant, amount: Cents): AssetHolding {
  return {
    id,
    assetType: grant.assetType,
    assetCode: grant.assetCode,
    quantity: amount,
    activeAt: grant.activeAt,
    expiresAt: grant.expiresAt,
  };
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

function getTime(date: Date | null): number {
  return date?.getTime() ?? 0;
}
