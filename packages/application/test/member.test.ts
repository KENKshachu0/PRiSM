import { describe, expect, it } from "bun:test";
import {
  MEMBER_ASSET_TYPE,
  MEMBER_PROGRAM_KEY,
  centsOf,
  centsOfInteger,
  type AssetDefinition,
  type AssetDefinitionRepository,
  type AssetHolding,
  type AssetLedgerEntry,
  type AssetRepository,
  type AssetTransaction,
  type Cents,
  type OperationLockRepository,
  type PricingEffect,
  type SystemRepository,
} from "@prism/core";
import {
  createAvailableAssetReader,
  createMemberService,
  type MemberServiceDependencies,
} from "../src/index";

describe("membership cards", () => {
  it("sells a duration of the selected card and reports its effect", async () => {
    const store = createStore();
    store.service = createService(store);
    await store.service.saveProgram({ enabled: true });
    const plan = await store.service.savePlan({
      name: "月卡",
      assetCode: "vip",
      price: centsOf(30),
      durationDays: 30,
    });
    store.assets.holdings.push(currencyHolding("paid", centsOf(50)));

    const purchase = await store.service.purchase({ playerId: "player-1", planId: plan.id });

    expect(purchase.price).toBe(centsOfInteger(3000));
    expect(purchase.walletBefore).toBe(centsOfInteger(5000));
    expect(purchase.walletAfter).toBe(centsOfInteger(2000));
    expect(purchase.status).toMatchObject({
      active: true,
      assetCode: "vip",
      cardName: "会员卡",
      discountPercent: 30,
    });
    expect(purchase.status.expiresAt).not.toBeNull();
  });

  it("extends the same card from its current expiry", async () => {
    const store = createStore();
    store.service = createService(store);
    await store.service.saveProgram({ enabled: true });
    const plan = await store.service.savePlan({ name: "月卡", assetCode: "vip", price: centsOf(30), durationDays: 30 });
    store.assets.holdings.push(currencyHolding("paid", centsOf(100)));

    const first = await store.service.purchase({ playerId: "player-1", planId: plan.id });
    const firstExpiry = first.status.expiresAt!.getTime();
    store.now = new Date(store.now.getTime() + 10 * 86_400_000);
    const second = await store.service.purchase({ playerId: "player-1", planId: plan.id });

    expect(second.walletAfter).toBe(centsOfInteger(4000));
    expect(second.status.expiresAt!.getTime()).toBe(firstExpiry + 30 * 86_400_000);
  });

  it("refuses an insufficient purchase and a plan for a missing card", async () => {
    const store = createStore();
    store.service = createService(store);
    await store.service.saveProgram({ enabled: true });
    const plan = await store.service.savePlan({ name: "月卡", assetCode: "vip", price: centsOf(30), durationDays: 30 });
    store.assets.holdings.push(currencyHolding("paid", centsOf(5)));

    await expect(store.service.purchase({ playerId: "player-1", planId: plan.id }))
      .rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    await expect(store.service.savePlan({
      name: "错卡",
      assetCode: "missing",
      price: centsOf(10),
      durationDays: 30,
    })).rejects.toMatchObject({ code: "MEMBER_CARD_NOT_FOUND" });
  });

  it("reports expired membership and lets staff grant and revoke", async () => {
    const store = createStore();
    store.service = createService(store);
    await store.service.saveProgram({ enabled: true });
    const plan = await store.service.savePlan({ name: "月卡", assetCode: "vip", price: centsOf(30), durationDays: 30 });

    const granted = await store.service.grant({ playerId: "player-1", planId: plan.id, staffId: "staff-1" });
    expect(granted.status.active).toBe(true);
    expect(store.assets.holdings.some((holding) => holding.assetType === "currency")).toBe(false);

    store.now = new Date(store.now.getTime() + 31 * 86_400_000);
    expect((await store.service.getStatus("player-1")).active).toBe(false);

    const revoked = await store.service.revoke({ playerId: "player-1", staffId: "staff-1" });
    expect(revoked.status.active).toBe(false);
    expect(store.assets.holdings.some((holding) => holding.assetType === MEMBER_ASSET_TYPE)).toBe(false);
  });

  it("does not sell or grant while the programme is off", async () => {
    const store = createStore();
    store.service = createService(store);
    await store.service.saveProgram({ enabled: true });
    const plan = await store.service.savePlan({ name: "月卡", assetCode: "vip", price: centsOf(30), durationDays: 30 });
    await store.service.saveProgram({ enabled: false });

    await expect(store.service.purchase({ playerId: "player-1", planId: plan.id }))
      .rejects.toMatchObject({ code: "MEMBER_PROGRAM_DISABLED" });
    await expect(store.service.grant({ playerId: "player-1", planId: plan.id, staffId: "staff-1" }))
      .rejects.toMatchObject({ code: "MEMBER_PROGRAM_DISABLED" });
  });
});

function createStore() {
  return {
    now: new Date("2026-10-29T10:00:00.000Z"),
    system: new MemorySystem(),
    assets: new MemoryAssets(),
    definitions: new MemoryDefinitions(),
    locks: new MemoryLocks(),
    service: null as unknown as ReturnType<typeof createMemberService>,
  };
}

let idSequence = 0;

function createService(store: ReturnType<typeof createStore>): ReturnType<typeof createMemberService> {
  const availableAssets = createAvailableAssetReader({
    assets: store.assets,
    assetDefinitions: store.definitions,
    now: () => store.now,
  });
  const dependencies: MemberServiceDependencies = {
    system: store.system,
    assets: store.assets,
    availableAssets,
    assetDefinitions: store.definitions,
    operationLocks: store.locks,
    id: () => `id-${++idSequence}`,
    now: () => store.now,
  };
  return createMemberService(dependencies);
}

class MemorySystem implements SystemRepository {
  values = new Map<string, unknown>();
  async hasOwnerStaffUser() { return false; }
  async saveStaffUser() {}
  async listStaffUsers() { return []; }
  async findStaffUserByUsername() { return null; }
  async findStaffUserById() { return null; }
  async saveAdminSession() {}
  async findAdminSessionByTokenHash() { return null; }
  async revokeAdminSession() {}
  async saveApiToken() {}
  async listApiTokens() { return []; }
  async findActiveApiTokenByHash() { return null; }
  async updateApiTokenLastUsed() {}
  async revokeApiToken() {}
  async setAppSetting(key: string, value: unknown) { this.values.set(key, value); }
  async getAppSetting<T = unknown>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null;
  }
  async listAppSettings() { return []; }
}

class MemoryAssets implements AssetRepository {
  holdings: AssetHolding[] = [];
  transactions: AssetTransaction[] = [];
  ledger: AssetLedgerEntry[] = [];

  async listAssetHoldings() {
    return this.holdings.map((holding) => ({ ...holding }));
  }

  async commitAssetTransaction(input: {
    transaction: AssetTransaction;
    holdingChanges: { upserts: AssetHolding[]; deleteIds: string[] };
    assetLedgerEntries: readonly AssetLedgerEntry[];
  }) {
    for (const upsert of input.holdingChanges.upserts) {
      const index = this.holdings.findIndex((holding) => holding.id === upsert.id);
      if (index >= 0) this.holdings[index] = { ...upsert };
      else this.holdings.push({ ...upsert });
    }
    const deleted = new Set(input.holdingChanges.deleteIds);
    this.holdings = this.holdings.filter((holding) => !deleted.has(holding.id ?? ""));
    this.transactions.unshift(input.transaction);
    this.ledger.push(...input.assetLedgerEntries);
  }

  async listLedgerEntriesByPlayerId() { return [...this.ledger]; }
  async listTransactionsByPlayerId() { return [...this.transactions]; }
}

class MemoryDefinitions implements AssetDefinitionRepository {
  saved = new Map<string, AssetDefinition>();
  constructor() {
    const effect: PricingEffect = {
      id: "vip-effect",
      name: "会员七折",
      type: "percentage-discount",
      scope: "unified",
      value: 30,
      consumable: false,
      limitPerDay: null,
      status: "active",
      config: null,
    };
    this.saved.set("membership:vip", {
      type: "membership",
      code: "vip",
      name: "会员卡",
      stackable: false,
      status: "active",
      pricingEffectId: effect.id,
      pricingEffect: effect,
      metadata: null,
    });
    this.saved.set("currency:paid", {
      type: "currency",
      code: "paid",
      name: "充值余额",
      stackable: true,
      status: "active",
      metadata: null,
    });
  }
  async save(definition: AssetDefinition) {
    this.saved.set(`${definition.type}:${definition.code}`, { ...definition });
  }
  async findByCode(type: string, code: string) {
    return this.saved.get(`${type}:${code}`) ?? null;
  }
  async listAll() { return [...this.saved.values()]; }
}

class MemoryLocks implements OperationLockRepository {
  held = new Set<string>();
  async acquire(scope: string, resourceId: string) {
    const key = `${scope}:${resourceId}`;
    if (this.held.has(key)) return false;
    this.held.add(key);
    return true;
  }
  async release(scope: string, resourceId: string) {
    this.held.delete(`${scope}:${resourceId}`);
  }
}

function currencyHolding(assetCode: string, quantity: Cents): AssetHolding {
  return {
    id: `currency-${assetCode}`,
    assetType: "currency",
    assetCode,
    quantity,
    activeAt: null,
    expiresAt: null,
  };
}
