import type {
  AssetLedgerEntry,
  AssetRepository,
  BusinessItem,
  BusinessItemOrder,
  BusinessItemOrderRepository,
  BusinessItemRepository,
  OperationLockRepository,
  SessionRepository,
} from "@prism/core";
import { deductCurrency, diffAssetHoldings, isPositiveCents, PrismDomainError } from "@prism/core";
import { withOperationLease } from "./operation-lock";
import type { AvailableAssetReader } from "./available-assets";

export type PurchaseBusinessItemInput = {
  playerId: string;
  businessItemId: string;
  metadata: Record<string, unknown> | null;
};

export type PurchaseBusinessItemResult = {
  order: BusinessItemOrder;
  assetLedgerEntries: AssetLedgerEntry[];
};

export type BusinessItemOrderServiceDependencies = {
  businessItems: BusinessItemRepository;
  businessItemOrders: BusinessItemOrderRepository;
  sessions: SessionRepository;
  assets: AssetRepository;
  availableAssets?: AvailableAssetReader;
  operationLocks?: OperationLockRepository;
  id: () => string;
  now: () => Date;
};

export type BusinessItemOrderService = {
  purchaseBusinessItem(input: PurchaseBusinessItemInput): Promise<PurchaseBusinessItemResult>;
  listBusinessItemOrders(): Promise<BusinessItemOrder[]>;
  listPlayerBusinessItemOrders(input: { playerId: string }): Promise<BusinessItemOrder[]>;
  fulfillBusinessItemOrder(input: { orderId: string }): Promise<BusinessItemOrder>;
  cancelBusinessItemOrder(input: { orderId: string }): Promise<BusinessItemOrder>;
};

export function createBusinessItemOrderService(
  dependencies: BusinessItemOrderServiceDependencies,
): BusinessItemOrderService {
  return {
    async purchaseBusinessItem(input) {
      return withOperationLease({ repository: dependencies.operationLocks, scope: "player.assets", resourceId: input.playerId, id: dependencies.id, now: dependencies.now }, async () => {
      const now = dependencies.now();
      const [item, activeSessions, assetHoldings] = await Promise.all([
        findActiveBusinessItem(dependencies.businessItems, input.businessItemId, now),
        dependencies.sessions.findActiveByPlayerId(input.playerId),
        dependencies.assets.listAssetHoldings(input.playerId),
      ]);
      const session = activeSessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
      if (!session) {
        throw new PrismDomainError("Player has no active session.", "ACTIVE_SESSION_NOT_FOUND");
      }

      await assertBusinessItemCapacity(dependencies, item);

      const price = item.price;
      const order: BusinessItemOrder = {
        id: dependencies.id(),
        businessItemId: item.id,
        businessItemKind: item.kind,
        businessItemName: item.name,
        playerId: input.playerId,
        sessionId: session.id,
        status: "paid",
        price,
        assetType: item.assetType,
        assetCode: item.assetCode,
        metadata: input.metadata,
        createdAt: now,
        updatedAt: now,
        fulfilledAt: null,
        cancelledAt: null,
      };

      const nextHoldings = assetHoldings.map((holding) => ({ ...holding }));
      const spendableHoldings = dependencies.availableAssets
        ? (await dependencies.availableAssets.resolveAvailableHoldings(nextHoldings, {
            at: now,
            includeHidden: true,
          })).map((asset) => asset.holding)
        : nextHoldings;
      const assetLedgerEntries = deductCurrency(spendableHoldings, {
        amount: price,
        reason: "business-item.purchase",
        refId: order.id,
        now,
      });

      await dependencies.assets.commitAssetTransaction({
        transaction: {
          id: `asset-tx:business-item.purchase:${order.id}`,
          playerId: input.playerId,
          kind: "business-item.purchase",
          refId: order.id,
          createdAt: now,
          metadata: {
            businessItemId: item.id,
            businessItemName: item.name,
            price: item.price,
            sessionId: session.id,
          },
        },
        holdingChanges: diffAssetHoldings(assetHoldings, nextHoldings.filter((holding) => isPositiveCents(holding.quantity))),
        assetLedgerEntries,
      });
      await dependencies.businessItemOrders.save(order);

      return {
        order,
        assetLedgerEntries,
      };
      });
    },

    async listBusinessItemOrders() {
      return dependencies.businessItemOrders.listAll();
    },

    async listPlayerBusinessItemOrders(input) {
      return dependencies.businessItemOrders.listByPlayerId(input.playerId);
    },

    async fulfillBusinessItemOrder(input) {
      const existing = await findOrderOrThrow(dependencies.businessItemOrders, input.orderId);
      if (existing.status === "cancelled") {
        throw new PrismDomainError("Cancelled business item order cannot be fulfilled.", "BUSINESS_ITEM_ORDER_CANCELLED");
      }
      if (existing.status === "fulfilled") return existing;
      const now = dependencies.now();
      const fulfilled: BusinessItemOrder = {
        ...existing,
        status: "fulfilled",
        fulfilledAt: now,
        updatedAt: now,
      };
      await dependencies.businessItemOrders.save(fulfilled);
      return fulfilled;
    },

    async cancelBusinessItemOrder(input) {
      const existing = await findOrderOrThrow(dependencies.businessItemOrders, input.orderId);
      if (existing.status === "fulfilled") {
        throw new PrismDomainError("Fulfilled business item order cannot be cancelled.", "BUSINESS_ITEM_ORDER_FULFILLED");
      }
      if (existing.status === "cancelled") return existing;
      const now = dependencies.now();
      const cancelled: BusinessItemOrder = {
        ...existing,
        status: "cancelled",
        cancelledAt: now,
        updatedAt: now,
      };
      await dependencies.businessItemOrders.save(cancelled);
      return cancelled;
    },
  };
}

async function findActiveBusinessItem(
  businessItems: BusinessItemRepository,
  businessItemId: string,
  now: Date,
): Promise<BusinessItem> {
  const item = await businessItems.findById(businessItemId);
  if (!item) {
    throw new PrismDomainError("Business item not found.", "BUSINESS_ITEM_NOT_FOUND");
  }
  if (item.status === "archived") {
    throw new PrismDomainError("Business item has been archived.", "BUSINESS_ITEM_ARCHIVED");
  }
  if (item.activeAt && item.activeAt > now) {
    throw new PrismDomainError("Business item is not active yet.", "BUSINESS_ITEM_NOT_ACTIVE");
  }
  if (item.expiresAt && item.expiresAt <= now) {
    throw new PrismDomainError("Business item has expired.", "BUSINESS_ITEM_EXPIRED");
  }
  return item;
}

async function assertBusinessItemCapacity(
  dependencies: Pick<BusinessItemOrderServiceDependencies, "businessItemOrders">,
  item: BusinessItem,
): Promise<void> {
  const capacity = Number(item.metadata?.capacity ?? 0);
  if (!Number.isFinite(capacity) || capacity <= 0) return;

  const openOrders = await dependencies.businessItemOrders.countOpenByItemId(item.id);
  if (openOrders >= capacity) {
    throw new PrismDomainError("Business item capacity is full.", "BUSINESS_ITEM_CAPACITY_FULL");
  }
}

async function findOrderOrThrow(orders: BusinessItemOrderRepository, orderId: string): Promise<BusinessItemOrder> {
  const order = await orders.findById(orderId);
  if (!order) {
    throw new PrismDomainError("Business item order not found.", "BUSINESS_ITEM_ORDER_NOT_FOUND");
  }
  return order;
}
