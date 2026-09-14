import { describe, expect, it } from "bun:test";
import {
  AssetDefinition,
  AssetDefinitionRepository,
  AssetHolding,
  AssetLedgerEntry,
  AssetRepository,
  AssetTransaction,
  centsOf,
  yuanOf,
} from "@prism/core";
import { createAvailableAssetReader, createStaffAssetService } from "../src/index";

class MemoryAssetRepository implements AssetRepository {
  savedHoldings: AssetHolding[][] = [];
  ledgerEntries: AssetLedgerEntry[] = [];
  assetTransactions: AssetTransaction[] = [];

  constructor(private readonly holdings: AssetHolding[]) {}

  async listAssetHoldings(): Promise<AssetHolding[]> {
    return this.holdings.map((holding) => ({ ...holding }));
  }

  async commitAssetTransaction({ transaction, holdingChanges, assetLedgerEntries }: Parameters<AssetRepository["commitAssetTransaction"]>[0]): Promise<void> {
    const next = this.holdings
      .filter((holding) => !holding.id || !holdingChanges.deleteIds.includes(holding.id))
      .map((holding) => ({ ...holding }));
    for (const holding of holdingChanges.upserts) {
      const index = next.findIndex((existing) => existing.id === holding.id);
      if (index >= 0) next[index] = { ...holding };
      else next.push({ ...holding });
    }
    this.holdings.splice(0, this.holdings.length, ...next);
    this.savedHoldings.push(next.map((holding) => ({ ...holding })));
    this.assetTransactions.push({ ...transaction });
    this.ledgerEntries.push(...assetLedgerEntries.map((entry) => ({ ...entry, transactionId: transaction.id })));
  }

  async listLedgerEntriesByPlayerId(): Promise<AssetLedgerEntry[]> {
    return this.ledgerEntries.map((entry) => ({ ...entry }));
  }

  async listTransactionsByPlayerId(): Promise<AssetTransaction[]> {
    return [];
  }
}

class MemoryAssetDefinitionRepository implements AssetDefinitionRepository {
  constructor(private readonly definitions: AssetDefinition[]) {}

  async save(definition: AssetDefinition): Promise<void> {
    const index = this.definitions.findIndex(
      (existing) => existing.type === definition.type && existing.code === definition.code,
    );
    if (index === -1) {
      this.definitions.push(definition);
      return;
    }
    this.definitions[index] = definition;
  }

  async findByCode(type: string, code: string): Promise<AssetDefinition | null> {
    return this.definitions.find((definition) => definition.type === type && definition.code === code) ?? null;
  }

  async listAll(): Promise<AssetDefinition[]> {
    return [...this.definitions];
  }
}

function testAvailableAssets(assets: AssetRepository, now: () => Date) {
  return createAvailableAssetReader({
    assets,
    assetDefinitions: new MemoryAssetDefinitionRepository([
      {
        type: "currency",
        code: "paid",
        name: "付费余额",
        stackable: true,
        status: "active",
        activeAt: null,
        expiresAt: null,
        metadata: null,
      },
      {
        type: "currency",
        code: "free",
        name: "赠送余额",
        stackable: true,
        status: "active",
        activeAt: null,
        expiresAt: null,
        metadata: null,
      },
    ]),
    now,
  });
}

describe("createStaffAssetService", () => {
  it("grants assets to a player and persists holdings plus ledger entries", async () => {
    const assets = new MemoryAssetRepository([
      {
        id: "holding-1",
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: centsOf(100),
        activeAt: null,
        expiresAt: null,
      },
    ]);
    const service = createStaffAssetService({
      assets,
      availableAssets: testAvailableAssets(assets, () => new Date("2026-06-07T10:00:00.000Z")),
      id: () => "holding-new",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    const result = await service.grantAssets({
      staffId: "staff-1",
      playerId: "player-1",
      reason: "现场赠送",
      grants: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          amount: 50,
          mergeStrategy: "stack",
          activeAt: null,
          expiresAt: null,
        },
      ],
    });

    expect(result.holdings).toEqual([
      {
        id: "holding-1",
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: centsOf(150),
        activeAt: null,
        expiresAt: null,
      },
    ]);
    expect(assets.savedHoldings).toEqual([result.holdings]);
    expect(assets.assetTransactions).toEqual([
      {
        id: "asset-tx:staff.asset.grant:staff-1:player-1:2026-06-07T10:00:00.000Z:holding-new",
        playerId: "player-1",
        kind: "staff.asset.grant",
        refId: "staff-1",
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        metadata: {
          staffId: "staff-1",
          grantCount: 1,
        },
      },
    ]);
    expect(assets.ledgerEntries).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.paid",
        delta: centsOf(50),
        reason: "现场赠送",
        refId: "staff-1",
        transactionId: "asset-tx:staff.asset.grant:staff-1:player-1:2026-06-07T10:00:00.000Z:holding-new",
      },
    ]);
  });

  it("adjusts assets for deductions and expiration", async () => {
    const assets = new MemoryAssetRepository([
      {
        id: "holding-1",
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: centsOf(100),
        activeAt: null,
        expiresAt: null,
      },
      {
        id: "pass-1",
        assetType: "pass",
        assetCode: "monthly",
        quantity: centsOf(1),
        activeAt: new Date("2026-06-01T00:00:00.000Z"),
        expiresAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ]);
    const service = createStaffAssetService({
      assets,
      availableAssets: testAvailableAssets(assets, () => new Date("2026-06-07T10:00:00.000Z")),
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    const result = await service.adjustAssets({
      staffId: "staff-1",
      playerId: "player-1",
      adjustments: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          quantityDelta: -30,
          activeAt: null,
          expiresAt: null,
          reason: "staff.asset.deduct",
        },
        {
          assetType: "pass",
          assetCode: "monthly",
          quantityDelta: 0,
          activeAt: new Date("2026-06-01T00:00:00.000Z"),
          expiresAt: new Date("2026-06-07T10:00:00.000Z"),
          reason: "staff.asset.expire",
        },
      ],
    });

    expect(result.holdings).toEqual([
      {
        id: "holding-1",
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: centsOf(70),
        activeAt: null,
        expiresAt: null,
      },
      {
        id: "pass-1",
        assetType: "pass",
        assetCode: "monthly",
        quantity: centsOf(1),
        activeAt: new Date("2026-06-01T00:00:00.000Z"),
        expiresAt: new Date("2026-06-07T10:00:00.000Z"),
      },
    ]);
    expect(assets.savedHoldings).toEqual([result.holdings]);
    expect(assets.assetTransactions).toEqual([
      {
        id: "asset-tx:staff.asset.adjust:staff-1:player-1:2026-06-07T10:00:00.000Z:unused",
        playerId: "player-1",
        kind: "staff.asset.adjust",
        refId: "staff-1",
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        metadata: {
          staffId: "staff-1",
          adjustmentCount: 2,
        },
      },
    ]);
    expect(assets.ledgerEntries).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.paid",
        delta: centsOf(-30),
        reason: "staff.asset.deduct",
        refId: "staff-1",
        transactionId: "asset-tx:staff.asset.adjust:staff-1:player-1:2026-06-07T10:00:00.000Z:unused",
      },
      {
        assetType: "pass",
        assetCode: "monthly",
        delta: centsOf(0),
        reason: "staff.asset.expire",
        refId: "staff-1",
        transactionId: "asset-tx:staff.asset.adjust:staff-1:player-1:2026-06-07T10:00:00.000Z:unused",
      },
    ]);
  });

  it("revokes a specific holding by id through staff adjustments", async () => {
    const assets = new MemoryAssetRepository([
      {
        id: "title-1",
        assetType: "title",
        assetCode: "vip",
        quantity: centsOf(1),
        activeAt: null,
        expiresAt: null,
      },
      {
        id: "title-2",
        assetType: "title",
        assetCode: "vip",
        quantity: centsOf(1),
        activeAt: null,
        expiresAt: null,
      },
    ]);
    const service = createStaffAssetService({
      assets,
      availableAssets: testAvailableAssets(assets, () => new Date("2026-06-07T10:00:00.000Z")),
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    const result = await service.adjustAssets({
      staffId: "staff-1",
      playerId: "player-1",
      adjustments: [
        {
          holdingId: "title-1",
          assetType: "title",
          assetCode: "vip",
          quantityDelta: -1,
          reason: "staff.asset.revoke",
        },
      ],
    });

    expect(result.holdings).toEqual([
      {
        id: "title-2",
        assetType: "title",
        assetCode: "vip",
        quantity: centsOf(1),
        activeAt: null,
        expiresAt: null,
      },
    ]);
    expect(assets.savedHoldings).toEqual([result.holdings]);
    expect(assets.assetTransactions).toEqual([
      {
        id: "asset-tx:staff.asset.adjust:staff-1:player-1:2026-06-07T10:00:00.000Z:unused",
        playerId: "player-1",
        kind: "staff.asset.adjust",
        refId: "staff-1",
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        metadata: {
          staffId: "staff-1",
          adjustmentCount: 1,
        },
      },
    ]);
    expect(assets.ledgerEntries).toEqual([
      {
        assetType: "title",
        assetCode: "vip",
        delta: centsOf(-1),
        reason: "staff.asset.revoke",
        refId: "staff-1",
        transactionId: "asset-tx:staff.asset.adjust:staff-1:player-1:2026-06-07T10:00:00.000Z:unused",
      },
    ]);
  });

  it("does not grant archived asset definitions to players", async () => {
    const assets = new MemoryAssetRepository([]);
    const service = createStaffAssetService({
      assets,
      availableAssets: testAvailableAssets(assets, () => new Date("2026-06-07T10:00:00.000Z")),
      assetDefinitions: new MemoryAssetDefinitionRepository([
        {
          type: "title",
          code: "retired",
          name: "Retired title",
          stackable: false,
          status: "archived",
          metadata: null,
        },
      ]),
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await expect(
      service.grantAssets({
        staffId: "staff-1",
        playerId: "player-1",
        grants: [
          {
            assetType: "title",
            assetCode: "retired",
            amount: 1,
            mergeStrategy: "replace",
            activeAt: null,
            expiresAt: null,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "ASSET_DEFINITION_ARCHIVED",
    });
    expect(assets.savedHoldings).toEqual([]);
    expect(assets.assetTransactions).toEqual([]);
  });

  it("adjusts aggregate wallet balances using free before paid", async () => {
    const assets = new MemoryAssetRepository([
      { id: "free", assetType: "currency", assetCode: "free", quantity: centsOf(20), activeAt: null, expiresAt: null },
      { id: "paid", assetType: "currency", assetCode: "paid", quantity: centsOf(40), activeAt: null, expiresAt: null },
    ]);
    const service = createStaffAssetService({
      assets,
      availableAssets: testAvailableAssets(assets, () => new Date("2026-07-10T00:00:00.000Z")),
      id: () => "new-free",
      now: () => new Date("2026-07-10T00:00:00.000Z"),
    });
    const result = await service.adjustWallet({ staffId: "staff-1", playerId: "player-1", amount: -30, reason: "staff.wallet.deduct" });
    expect(yuanOf(result.balanceBefore)).toBe(60);
    expect(yuanOf(result.balanceAfter)).toBe(30);
    expect(result.assetLedgerEntries).toEqual([
      { assetType: "currency", assetCode: "free", delta: centsOf(-20), reason: "staff.wallet.deduct", refId: "staff-1" },
      { assetType: "currency", assetCode: "paid", delta: centsOf(-10), reason: "staff.wallet.deduct", refId: "staff-1" },
    ]);
  });

  it("gives consecutive staff mutations unique transaction ids at the same instant", async () => {
    const assets = new MemoryAssetRepository([]);
    const ids = ["holding-1", "transaction-1", "holding-2", "transaction-2"];
    const now = () => new Date("2026-07-10T00:00:00.000Z");
    const service = createStaffAssetService({
      assets,
      availableAssets: testAvailableAssets(assets, now),
      id: () => ids.shift()!,
      now,
    });

    await service.grantAssets({
      staffId: "staff-1",
      playerId: "player-1",
      grants: [{
        assetType: "currency",
        assetCode: "free",
        amount: 1,
        mergeStrategy: "stack",
        activeAt: null,
        expiresAt: null,
      }],
    });
    await service.grantAssets({
      staffId: "staff-1",
      playerId: "player-1",
      grants: [{
        assetType: "title",
        assetCode: "vip",
        amount: 1,
        mergeStrategy: "stack",
        activeAt: null,
        expiresAt: null,
      }],
    });

    expect(assets.assetTransactions.map((transaction) => transaction.id)).toEqual([
      "asset-tx:staff.asset.grant:staff-1:player-1:2026-07-10T00:00:00.000Z:transaction-1",
      "asset-tx:staff.asset.grant:staff-1:player-1:2026-07-10T00:00:00.000Z:transaction-2",
    ]);
  });
});
