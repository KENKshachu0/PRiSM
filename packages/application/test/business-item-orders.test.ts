import { describe, expect, it } from "bun:test";
import {
  AssetDefinition,
  AssetDefinitionRepository,
  AssetHolding,
  AssetLedgerEntry,
  AssetRepository,
  AssetTransaction,
  BusinessItem,
  BusinessItemOrder,
  BusinessItemOrderRepository,
  BusinessItemRepository,
  Session,
  SessionRepository,
  centsOf,
  yuanOf,
} from "@prism/core";
import { createAvailableAssetReader, createBusinessItemOrderService } from "../src/index";

class MemoryBusinessItemRepository implements BusinessItemRepository {
  saved: BusinessItem[] = [];

  async save(item: BusinessItem): Promise<void> {
    this.saved = [item, ...this.saved.filter((existing) => existing.id !== item.id)];
  }

  async findById(itemId: string): Promise<BusinessItem | null> {
    return this.saved.find((item) => item.id === itemId) ?? null;
  }

  async listAll(): Promise<BusinessItem[]> {
    return [...this.saved];
  }
}

class MemoryBusinessItemOrderRepository implements BusinessItemOrderRepository {
  saved: BusinessItemOrder[] = [];

  async save(order: BusinessItemOrder): Promise<void> {
    this.saved = [order, ...this.saved.filter((existing) => existing.id !== order.id)];
  }

  async findById(orderId: string): Promise<BusinessItemOrder | null> {
    return this.saved.find((order) => order.id === orderId) ?? null;
  }

  async listAll(): Promise<BusinessItemOrder[]> {
    return [...this.saved].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async listByPlayerId(playerId: string): Promise<BusinessItemOrder[]> {
    return (await this.listAll()).filter((order) => order.playerId === playerId);
  }

  async countOpenByItemId(itemId: string): Promise<number> {
    return this.saved.filter((order) => order.businessItemId === itemId && order.status !== "cancelled").length;
  }
}

class MemorySessionRepository implements SessionRepository {
  sessions: Session[] = [];

  async findActiveByPlayerId(playerId: string): Promise<Session[]> {
    return this.sessions.filter((session) => session.playerId === playerId && session.status === "active");
  }

  async findById(sessionId: string): Promise<Session | null> {
    return this.sessions.find((session) => session.id === sessionId) ?? null;
  }

  async findUnpaidClosedByPlayerId(playerId: string): Promise<Session[]> {
    return this.sessions.filter((session) => session.playerId === playerId && session.status === "closed" && session.paymentStatus === "unpaid");
  }

  async save(session: Session): Promise<void> {
    this.sessions = [session, ...this.sessions.filter((existing) => existing.id !== session.id)];
  }
}

class MemoryAssetRepository implements AssetRepository {
  holdings: Record<string, AssetHolding[]> = {};
  transactions: Array<{ playerId: string; transaction: AssetTransaction; entries: AssetLedgerEntry[] }> = [];

  async listAssetHoldings(playerId: string): Promise<AssetHolding[]> {
    return (this.holdings[playerId] ?? []).map((holding) => ({ ...holding }));
  }

  async commitAssetTransaction({ transaction, holdingChanges, assetLedgerEntries }: Parameters<AssetRepository["commitAssetTransaction"]>[0]): Promise<void> {
    const playerId = transaction.playerId;
    const next = (this.holdings[playerId] ?? [])
      .filter((holding) => !holding.id || !holdingChanges.deleteIds.includes(holding.id))
      .map((holding) => ({ ...holding }));
    for (const holding of holdingChanges.upserts) {
      const index = next.findIndex((existing) => existing.id === holding.id);
      if (index >= 0) next[index] = { ...holding };
      else next.push({ ...holding });
    }
    this.holdings[playerId] = next;
    this.transactions.push({
      playerId,
      transaction,
      entries: assetLedgerEntries.map((entry) => ({ ...entry })),
    });
  }

  async listLedgerEntriesByPlayerId(): Promise<AssetLedgerEntry[]> {
    return [];
  }

  async listTransactionsByPlayerId(): Promise<AssetTransaction[]> {
    return [];
  }
}

class MemoryAssetDefinitionRepository implements AssetDefinitionRepository {
  constructor(private readonly definitions: AssetDefinition[]) {}
  async save(): Promise<void> {}
  async findByCode(type: string, code: string): Promise<AssetDefinition | null> {
    return this.definitions.find((definition) => definition.type === type && definition.code === code) ?? null;
  }
  async listAll(): Promise<AssetDefinition[]> { return [...this.definitions]; }
}

describe("createBusinessItemOrderService", () => {
  it("lets an in-session player buy an active business item through wallet balance", async () => {
    const businessItems = new MemoryBusinessItemRepository();
    const orders = new MemoryBusinessItemOrderRepository();
    const sessions = new MemorySessionRepository();
    const assets = new MemoryAssetRepository();
    await businessItems.save({
      id: "business-item-1",
      kind: "event.entry",
      name: "周末挑战赛报名",
      status: "active",
      price: 1200,
      assetType: "ticket",
      assetCode: "event.weekend",
      activeAt: new Date("2026-06-08T00:00:00.000Z"),
      expiresAt: new Date("2026-06-09T00:00:00.000Z"),
      metadata: { capacity: 2 },
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
      updatedAt: new Date("2026-06-07T10:00:00.000Z"),
    });
    await sessions.save({
      id: "session-1",
      playerId: "player-1",
      startedAt: new Date("2026-06-08T02:00:00.000Z"),
      status: "active",
    });
    assets.holdings["player-1"] = [
      { id: "holding-free", assetType: "currency", assetCode: "free", quantity: centsOf(500), activeAt: null, expiresAt: null },
      { id: "holding-paid", assetType: "currency", assetCode: "paid", quantity: centsOf(1000), activeAt: null, expiresAt: null },
    ];
    const service = createBusinessItemOrderService({
      businessItems,
      businessItemOrders: orders,
      sessions,
      assets,
      id: () => "order-1",
      now: () => new Date("2026-06-08T03:00:00.000Z"),
    });

    const result = await service.purchaseBusinessItem({
      playerId: "player-1",
      businessItemId: "business-item-1",
      metadata: { note: "bot purchase" },
    });

    expect(result.order).toEqual({
      id: "order-1",
      businessItemId: "business-item-1",
      businessItemKind: "event.entry",
      businessItemName: "周末挑战赛报名",
      playerId: "player-1",
      sessionId: "session-1",
      status: "paid",
      price: 1200,
      assetType: "ticket",
      assetCode: "event.weekend",
      metadata: { note: "bot purchase" },
      createdAt: new Date("2026-06-08T03:00:00.000Z"),
      updatedAt: new Date("2026-06-08T03:00:00.000Z"),
      fulfilledAt: null,
      cancelledAt: null,
    });
    expect(result.assetLedgerEntries).toEqual([
      { assetType: "currency", assetCode: "free", delta: centsOf(-500), reason: "business-item.purchase", refId: "order-1" },
      { assetType: "currency", assetCode: "paid", delta: centsOf(-700), reason: "business-item.purchase", refId: "order-1" },
    ]);
    expect(assets.holdings["player-1"]).toEqual([
      { id: "holding-paid", assetType: "currency", assetCode: "paid", quantity: centsOf(300), activeAt: null, expiresAt: null },
    ]);
    expect(assets.transactions).toEqual([
      {
        playerId: "player-1",
        transaction: {
          id: "asset-tx:business-item.purchase:order-1",
          playerId: "player-1",
          kind: "business-item.purchase",
          refId: "order-1",
          createdAt: new Date("2026-06-08T03:00:00.000Z"),
          metadata: {
            businessItemId: "business-item-1",
            businessItemName: "周末挑战赛报名",
            price: 1200,
            sessionId: "session-1",
          },
        },
        entries: result.assetLedgerEntries,
      },
    ]);
    await expect(orders.listByPlayerId("player-1")).resolves.toEqual([result.order]);
  });

  it("rejects purchase outside an active session and when capacity is full", async () => {
    const businessItems = new MemoryBusinessItemRepository();
    const orders = new MemoryBusinessItemOrderRepository();
    const sessions = new MemorySessionRepository();
    const assets = new MemoryAssetRepository();
    await businessItems.save({
      id: "business-item-1",
      kind: "reservation.slot",
      name: "晚间预约",
      status: "active",
      price: 100,
      assetType: null,
      assetCode: null,
      activeAt: null,
      expiresAt: null,
      metadata: { capacity: 1 },
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
      updatedAt: new Date("2026-06-07T10:00:00.000Z"),
    });
    const service = createBusinessItemOrderService({
      businessItems,
      businessItemOrders: orders,
      sessions,
      assets,
      id: () => "order-2",
      now: () => new Date("2026-06-08T03:00:00.000Z"),
    });

    await expect(
      service.purchaseBusinessItem({
        playerId: "player-1",
        businessItemId: "business-item-1",
        metadata: null,
      }),
    ).rejects.toMatchObject({
      code: "ACTIVE_SESSION_NOT_FOUND",
    });

    await sessions.save({
      id: "session-1",
      playerId: "player-1",
      startedAt: new Date("2026-06-08T02:00:00.000Z"),
      status: "active",
    });
    assets.holdings["player-1"] = [
      { id: "holding-paid", assetType: "currency", assetCode: "paid", quantity: centsOf(1000), activeAt: null, expiresAt: null },
    ];
    await orders.save({
      id: "existing-order",
      businessItemId: "business-item-1",
      businessItemKind: "reservation.slot",
      businessItemName: "晚间预约",
      playerId: "player-2",
      sessionId: "session-2",
      status: "paid",
      price: 100,
      assetType: null,
      assetCode: null,
      metadata: null,
      createdAt: new Date("2026-06-08T02:10:00.000Z"),
      updatedAt: new Date("2026-06-08T02:10:00.000Z"),
      fulfilledAt: null,
      cancelledAt: null,
    });

    await expect(
      service.purchaseBusinessItem({
        playerId: "player-1",
        businessItemId: "business-item-1",
        metadata: null,
      }),
    ).rejects.toMatchObject({
      code: "BUSINESS_ITEM_CAPACITY_FULL",
    });
  });

  it("does not spend currency with an archived asset definition", async () => {
    const now = new Date("2026-06-08T03:00:00.000Z");
    const businessItems = new MemoryBusinessItemRepository();
    const orders = new MemoryBusinessItemOrderRepository();
    const sessions = new MemorySessionRepository();
    const assets = new MemoryAssetRepository();
    const assetDefinitions = new MemoryAssetDefinitionRepository([
      {
        type: "currency",
        code: "paid",
        name: "已归档余额",
        stackable: true,
        status: "archived",
        metadata: null,
      },
    ]);
    await businessItems.save({
      id: "business-item-archived-wallet",
      kind: "event.entry",
      name: "测试报名",
      status: "active",
      price: 100,
      assetType: null,
      assetCode: null,
      activeAt: null,
      expiresAt: null,
      metadata: null,
      createdAt: now,
      updatedAt: now,
    });
    await sessions.save({
      id: "session-archived-wallet",
      playerId: "player-1",
      startedAt: now,
      status: "active",
    });
    assets.holdings["player-1"] = [
      { id: "holding-paid", assetType: "currency", assetCode: "paid", quantity: centsOf(1000) },
    ];
    const availableAssets = createAvailableAssetReader({
      assets,
      assetDefinitions,
      now: () => now,
    });
    const service = createBusinessItemOrderService({
      businessItems,
      businessItemOrders: orders,
      sessions,
      assets,
      availableAssets,
      id: () => "order-archived-wallet",
      now: () => now,
    });

    await expect(service.purchaseBusinessItem({
      playerId: "player-1",
      businessItemId: "business-item-archived-wallet",
      metadata: null,
    })).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    expect(orders.saved).toEqual([]);
  });
});
