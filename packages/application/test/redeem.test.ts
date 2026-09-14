import { describe, expect, it } from "bun:test";
import {
  AssetDefinition,
  AssetDefinitionRepository,
  AssetHolding,
  AssetLedgerEntry,
  AssetRepository,
  AssetTransaction,
  Present,
  RedeemCode,
  RedeemRecord,
  RedeemRepository,
  centsOf,
  yuanOf,
} from "@prism/core";
import { createAvailableAssetReader, createRedeemService } from "../src/index";

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
    this.ledgerEntries.push(
      ...assetLedgerEntries.map((entry) => ({ ...entry, transactionId: transaction.id })),
    );
  }

  async listLedgerEntriesByPlayerId(): Promise<AssetLedgerEntry[]> {
    return this.ledgerEntries.map((entry) => ({ ...entry }));
  }

  async listTransactionsByPlayerId(): Promise<AssetTransaction[]> {
    return [];
  }
}

class MemoryRedeemRepository implements RedeemRepository {
  savedRecords: RedeemRecord[] = [];

  constructor(
    private readonly redeemCode: RedeemCode,
    private readonly present: Present,
    private readonly records: RedeemRecord[] = [],
  ) {}

  async findRedeemCodeByCode(code: string): Promise<RedeemCode | null> {
    return this.redeemCode.code === code ? this.redeemCode : null;
  }

  async findRedeemCodeById(codeId: string): Promise<RedeemCode | null> {
    return this.redeemCode.id === codeId ? this.redeemCode : null;
  }

  async findPresentById(presentId: string): Promise<Present | null> {
    return this.present.id === presentId ? this.present : null;
  }

  async savePresent(_present: Present): Promise<void> {}

  async listPresents(): Promise<Present[]> {
    return [this.present];
  }

  async saveRedeemCode(_code: RedeemCode): Promise<void> {}

  async listRedeemCodes(): Promise<RedeemCode[]> {
    return [this.redeemCode];
  }

  async listRedeemRecords(): Promise<RedeemRecord[]> {
    return [...this.records, ...this.savedRecords];
  }

  async countRedeemCodeUses(codeId: string): Promise<number> {
    return (await this.listRedeemRecords()).filter(
      (record) => record.codeId === codeId,
    ).length;
  }

  async hasPlayerRedeemedPresent(
    playerId: string,
    presentId: string,
  ): Promise<boolean> {
    return (await this.listRedeemRecords()).some(
      (record) =>
        record.playerId === playerId && record.presentId === presentId,
    );
  }

  async saveRedeemRecord(record: RedeemRecord): Promise<void> {
    this.savedRecords.push(record);
  }
}

class MemoryAssetDefinitionRepository implements AssetDefinitionRepository {
  constructor(private readonly definitions: AssetDefinition[]) {}

  async save(definition: AssetDefinition): Promise<void> {
    const index = this.definitions.findIndex(
      (existing) =>
        existing.type === definition.type && existing.code === definition.code,
    );
    if (index === -1) {
      this.definitions.push(definition);
      return;
    }
    this.definitions[index] = definition;
  }

  async findByCode(
    type: string,
    code: string,
  ): Promise<AssetDefinition | null> {
    return (
      this.definitions.find(
        (definition) => definition.type === type && definition.code === code,
      ) ?? null
    );
  }

  async listAll(): Promise<AssetDefinition[]> {
    return [...this.definitions];
  }
}

describe("createRedeemService", () => {
  it("redeems a code, persists asset mutations, and stores the redeem record", async () => {
    const assets = new MemoryAssetRepository([]);
    const assetDefinitions = new MemoryAssetDefinitionRepository([
      {
        type: "currency",
        code: "currency.paid",
        name: "猫粮",
        stackable: true,
        metadata: null,
      },
    ]);
    const redeems = new MemoryRedeemRepository(
      {
        id: "code-1",
        code: "PRISM-2026",
        presentId: "present-1",
        activeAt: null,
        expiresAt: null,
        maxUseCount: 1,
      },
      {
        id: "present-1",
        name: "Top up gift",
        oncePerPlayer: true,
        grants: [
          {
            assetType: "currency",
            assetCode: "currency.paid",
            amount: 100,
            mergeStrategy: "stack",
            activeAt: null,
            expiresAt: null,
          },
        ],
      },
    );
    const service = createRedeemService({
      assets,
      assetDefinitions,
      availableAssets: createAvailableAssetReader({
        assets,
        assetDefinitions,
        now: () => new Date("2026-06-07T10:00:00.000Z"),
      }),
      redeems,
      now: () => new Date("2026-06-07T10:00:00.000Z"),
      id: () => "holding-1",
    });

    const result = await service.redeemCode({
      playerId: "player-1",
      code: "PRISM-2026",
    });

    expect(result.redeemRecord).toEqual({
      playerId: "player-1",
      codeId: "code-1",
      presentId: "present-1",
      redeemedAt: new Date("2026-06-07T10:00:00.000Z"),
    });
    expect(assets.savedHoldings).toEqual([
      [
        {
          id: "holding-1",
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: centsOf(100),
          activeAt: null,
          expiresAt: null,
        },
      ],
    ]);
    expect(assets.assetTransactions).toEqual([
      {
        id: "asset-tx:gift.redeem:code-1:player-1",
        playerId: "player-1",
        kind: "gift.redeem",
        refId: "code-1",
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        metadata: {
          presentId: "present-1",
          presentName: "Top up gift",
          grantCount: 1,
        },
      },
    ]);
    expect(assets.ledgerEntries).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.paid",
        delta: centsOf(100),
        reason: "gift.redeem",
        refId: "code-1",
        transactionId: "asset-tx:gift.redeem:code-1:player-1",
      },
    ]);
    expect(result.grantedAssets).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.paid",
        assetName: "猫粮",
        quantity: centsOf(100),
      },
    ]);
    expect(redeems.savedRecords).toEqual([result.redeemRecord]);
  });

  it("rejects redeeming a code whose present has been archived while keeping history intact", async () => {
    const assets = new MemoryAssetRepository([]);
    const assetDefinitions = new MemoryAssetDefinitionRepository([]);
    const redeems = new MemoryRedeemRepository(
      {
        id: "code-archived",
        code: "OLD-GIFT",
        presentId: "present-archived",
        activeAt: null,
        expiresAt: null,
        maxUseCount: 1,
      },
      {
        id: "present-archived",
        name: "Old gift",
        oncePerPlayer: true,
        status: "archived",
        grants: [
          {
            assetType: "currency",
            assetCode: "paid",
            amount: 100,
            mergeStrategy: "stack",
            activeAt: null,
            expiresAt: null,
          },
        ],
      },
    );
    const service = createRedeemService({
      assets,
      assetDefinitions,
      availableAssets: createAvailableAssetReader({
        assets,
        assetDefinitions,
        now: () => new Date("2026-06-07T10:00:00.000Z"),
      }),
      redeems,
      now: () => new Date("2026-06-07T10:00:00.000Z"),
      id: () => "holding-1",
    });

    await expect(
      service.redeemCode({
        playerId: "player-1",
        code: "OLD-GIFT",
      }),
    ).rejects.toMatchObject({
      code: "PRESENT_ARCHIVED",
    });
    expect(assets.savedHoldings).toEqual([]);
    expect(assets.assetTransactions).toEqual([]);
    expect(redeems.savedRecords).toEqual([]);
  });

  it("rejects redeeming a present that would grant an archived asset definition", async () => {
    const assets = new MemoryAssetRepository([]);
    const assetDefinitions = new MemoryAssetDefinitionRepository([
      {
        type: "coupon",
        code: "old-event",
        name: "旧优惠券",
        stackable: true,
        status: "archived",
        metadata: null,
      },
    ]);
    const redeems = new MemoryRedeemRepository(
      {
        id: "code-archived-asset",
        code: "OLD-COUPON",
        presentId: "present-active",
        activeAt: null,
        expiresAt: null,
        maxUseCount: 1,
      },
      {
        id: "present-active",
        name: "旧优惠券礼物",
        oncePerPlayer: false,
        status: "active",
        grants: [
          {
            assetType: "coupon",
            assetCode: "old-event",
            amount: 1,
            mergeStrategy: "stack",
            activeAt: null,
            expiresAt: null,
          },
        ],
      },
    );
    const service = createRedeemService({
      assets,
      assetDefinitions,
      availableAssets: createAvailableAssetReader({
        assets,
        assetDefinitions,
        now: () => new Date("2026-06-07T10:00:00.000Z"),
      }),
      redeems,
      now: () => new Date("2026-06-07T10:00:00.000Z"),
      id: () => "holding-1",
    });

    await expect(
      service.redeemCode({
        playerId: "player-1",
        code: "OLD-COUPON",
      }),
    ).rejects.toMatchObject({
      code: "ASSET_DEFINITION_ARCHIVED",
    });
    expect(assets.savedHoldings).toEqual([]);
    expect(assets.assetTransactions).toEqual([]);
    expect(redeems.savedRecords).toEqual([]);
  });
});
