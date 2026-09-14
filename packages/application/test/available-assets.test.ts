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
import { createAvailableAssetReader, sumAvailableWalletBalance, toAvailableAssetView } from "../src";

class MemoryAssetRepository implements AssetRepository {
  constructor(private readonly holdings: AssetHolding[]) {}

  async listAssetHoldings(): Promise<AssetHolding[]> {
    return this.holdings.map((holding) => ({ ...holding }));
  }

  async commitAssetTransaction(): Promise<void> {}
  async listLedgerEntriesByPlayerId(): Promise<AssetLedgerEntry[]> { return []; }
  async listTransactionsByPlayerId(): Promise<AssetTransaction[]> { return []; }
}

class MemoryAssetDefinitionRepository implements AssetDefinitionRepository {
  constructor(private readonly definitions: AssetDefinition[]) {}

  async save(): Promise<void> {}
  async findByCode(type: string, code: string): Promise<AssetDefinition | null> {
    return this.definitions.find((definition) => definition.type === type && definition.code === code) ?? null;
  }
  async listAll(): Promise<AssetDefinition[]> { return [...this.definitions]; }
}

describe("createAvailableAssetReader", () => {
  it("applies every player-facing availability rule in one place", async () => {
    const at = new Date("2026-07-14T12:00:00.000Z");
    const holdings: AssetHolding[] = [
      holding("available", 2),
      holding("zero", 0),
      holding("future-holding", 1, { activeAt: new Date("2026-07-15T00:00:00.000Z") }),
      holding("expired-holding", 1, { expiresAt: at }),
      holding("missing-definition", 1),
      holding("archived-definition", 1),
      holding("future-definition", 1),
      holding("expired-definition", 1),
      holding("hidden", 1),
    ];
    const definitions: AssetDefinition[] = [
      definition("available", "可用资产"),
      definition("zero", "零数量资产"),
      definition("future-holding", "未生效持有记录"),
      definition("expired-holding", "已过期持有记录"),
      { ...definition("archived-definition", "已归档资产"), status: "archived" },
      { ...definition("future-definition", "未生效定义"), activeAt: new Date("2026-07-15T00:00:00.000Z") },
      { ...definition("expired-definition", "已过期定义"), expiresAt: at },
      { ...definition("hidden", "隐藏资产"), metadata: { hiddenFromPlayer: true } },
    ];
    const reader = createAvailableAssetReader({
      assets: new MemoryAssetRepository(holdings),
      assetDefinitions: new MemoryAssetDefinitionRepository(definitions),
      now: () => at,
    });

    const playerAssets = await reader.listPlayerAvailableAssets("player-1");
    expect(playerAssets.map(toAvailableAssetView)).toEqual([
      {
        id: "holding-available",
        assetType: "test",
        assetCode: "available",
        quantity: centsOf(2),
        activeAt: null,
        expiresAt: null,
        assetName: "可用资产",
        metadata: null,
      },
    ]);

    const internalAssets = await reader.resolveAvailableHoldings(holdings, { includeHidden: true });
    expect(internalAssets.map((asset) => asset.holding.assetCode)).toEqual(["available", "hidden"]);

    const assessments = await reader.listPlayerAssetAssessments("player-1", { includeHidden: true });
    expect(assessments.map((assessment) => ({
      code: assessment.holding.assetCode,
      availability: assessment.availability,
      reasons: assessment.unavailableReasons,
    }))).toEqual([
      { code: "available", availability: "available", reasons: [] },
      { code: "zero", availability: "unavailable", reasons: ["quantity_not_positive"] },
      { code: "future-holding", availability: "unavailable", reasons: ["holding_not_active"] },
      { code: "expired-holding", availability: "unavailable", reasons: ["holding_expired"] },
      { code: "missing-definition", availability: "unavailable", reasons: ["definition_missing"] },
      { code: "archived-definition", availability: "unavailable", reasons: ["definition_archived"] },
      { code: "future-definition", availability: "unavailable", reasons: ["definition_not_active"] },
      { code: "expired-definition", availability: "unavailable", reasons: ["definition_expired"] },
      { code: "hidden", availability: "available", reasons: [] },
    ]);
  });

  it("aggregates the wallet only from holdings accepted by the shared resolver", async () => {
    const at = new Date("2026-07-14T12:00:00.000Z");
    const reader = createAvailableAssetReader({
      assets: new MemoryAssetRepository([
        { ...holding("paid", 10), assetType: "currency" },
        { ...holding("expired", 5, { expiresAt: at }), assetType: "currency" },
        { ...holding("ticket", 1), assetType: "ticket" },
      ]),
      assetDefinitions: new MemoryAssetDefinitionRepository([
        { ...definition("paid", "付费余额"), type: "currency" },
        { ...definition("expired", "过期余额"), type: "currency" },
        { ...definition("ticket", "门票"), type: "ticket" },
      ]),
      now: () => at,
    });

    const available = await reader.listPlayerAvailableAssets("player-1", { includeHidden: true });
    expect(sumAvailableWalletBalance(available)).toBe(10);
  });
});

function holding(
  assetCode: string,
  quantity: number,
  dates: Pick<AssetHolding, "activeAt" | "expiresAt"> = { activeAt: null, expiresAt: null },
): AssetHolding {
  return {
    id: `holding-${assetCode}`,
    assetType: "test",
    assetCode,
    quantity: centsOf(quantity),
    activeAt: dates.activeAt ?? null,
    expiresAt: dates.expiresAt ?? null,
  };
}

function definition(code: string, name: string): AssetDefinition {
  return {
    type: "test",
    code,
    name,
    stackable: true,
    status: "active",
    activeAt: null,
    expiresAt: null,
    metadata: null,
  };
}
