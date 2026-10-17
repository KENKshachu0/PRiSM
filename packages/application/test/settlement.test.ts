import { centsOf as moneyFixture, centsOfInteger as integerFixture } from "@prism/core";
import { describe, expect, it } from "bun:test";
import {
  AssetDefinition,
  AssetDefinitionRepository,
  AssetHolding,
  AssetLedgerEntry,
  AssetRepository,
  AssetTransaction,
  DeviceOperation,
  PricingProvider,
  PlayerCheckout,
  Session,
  SessionRepository,
  SettlementRecord,
  SettlementRepository,
  centsOf,
  yuanOf,
} from "@prism/core";
import { createTimePricingProvider } from "@prism/core";
import { createAssetDefinitionEffectProvider, createAvailableAssetReader, createSettlementService } from "../src/index";

class MemorySessionRepository implements SessionRepository {
  saved: Session[] = [];

  constructor(initial: Session | null | Session[]) {
    if (Array.isArray(initial)) {
      this.saved.push(...initial);
    } else if (initial) {
      this.saved.push(initial);
    }
  }

  async findActiveByPlayerId(playerId: string): Promise<Session[]> {
    return this.saved.filter((s) => s.playerId === playerId && s.status === "active");
  }

  async findById(sessionId: string): Promise<Session | null> {
    return this.saved.find((s) => s.id === sessionId) ?? null;
  }

  async findUnpaidClosedByPlayerId(playerId: string): Promise<Session[]> {
    return this.saved.filter((s) => s.playerId === playerId && s.status === "closed" && s.paymentStatus === "unpaid");
  }

  async save(session: Session): Promise<void> {
    this.saved = this.saved.filter((s) => s.id !== session.id);
    this.saved.push(session);
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
    return this.assetTransactions.map((transaction) => ({ ...transaction }));
  }
}

class MemorySettlementRepository implements SettlementRepository {
  saved: SettlementRecord[] = [];
  checkouts: PlayerCheckout[] = [];
  sessions?: SessionRepository;

  async saveSettlement(record: SettlementRecord): Promise<void> {
    this.saved.push(record);
  }

  async saveCheckout(checkout: PlayerCheckout, records: readonly SettlementRecord[]): Promise<void> {
    this.checkouts.push({ ...checkout });
    this.saved.push(...records);
  }

  async findSettlementBySessionId(sessionId: string): Promise<SettlementRecord | null> {
    return this.saved.find((record) => record.settlement.sessionId === sessionId) ?? null;
  }

  async listPastAppliedAdjustmentsByPlayerId(playerId: string): Promise<any[]> {
    const list: any[] = [];
    for (const record of this.saved) {
      const session = this.sessions ? await this.sessions.findById(record.settlement.sessionId) : null;
      for (const adj of record.adjustments) {
        list.push({
          source: adj.source,
          sessionStartedAt: session?.startedAt ?? new Date(),
        });
      }
    }
    return list;
  }
}

function operation(overrides: Partial<DeviceOperation>): DeviceOperation {
  return {
    id: "op",
    deviceId: "device-1",
    capability: "hinata_io",
    action: "coin",
    parentId: null,
    playerId: "player-1",
    staffId: null,
    status: "succeeded",
    countsAsPlay: true,
    failure: null,
    payload: {},
    requestedAt: new Date("2026-07-09T00:00:00.000Z"),
    settledAt: null,
    confirmedAt: null,
    ...overrides,
  };
}

function memoryOperations(operations: DeviceOperation[]) {
  return {
    async listOperationsByPlayer(playerId: string) {
      return operations.filter((item) => item.playerId === playerId);
    },
  };
}

class MemoryPricingCapHistoryRepository {
  entries: any[] = [];

  constructor(private readonly totals: Record<string, number> = {}) {}

  async sumByPlayerAndKeys(_playerId: string, keys: readonly any[]): Promise<Record<string, number>> {
    return Object.fromEntries(keys.map((key) => [key.key, this.totals[key.key] ?? 0]));
  }

  async appendEntries(entries: readonly any[]): Promise<void> {
    this.entries.push(...entries.map((entry) => ({ ...entry })));
  }
}

const pricing: PricingProvider = {
  id: "time",
  quote() {
    return [
      {
        id: "charge-1",
        source: "time",
        label: "Time",
        amount: moneyFixture(20),
      },
    ];
  },
};

function fixedPricingProvider(amount: number): PricingProvider {
  return {
    id: `fixed-${amount}`,
    quote() {
      return [
        {
          id: `charge-${amount}`,
          source: "time",
          label: "Time",
          amount: moneyFixture(amount),
        },
      ];
    },
  };
}

function durationPricingProvider(): PricingProvider {
  return {
    id: "duration",
    quote(context) {
      const endedAt = context.session.endedAt ?? context.now;
      const amount = Math.floor((endedAt.getTime() - context.session.startedAt.getTime()) / 60_000);
      return [
        {
          id: `charge-${context.session.id}`,
          source: "time",
          label: "Time",
          amount: moneyFixture(amount),
        },
      ];
    },
  };
}

function configuredPricingProvider(input: {
  providerId: string;
  pricingConfigId: string;
  label: string;
  amount: number;
  startedAt?: Date;
  endedAt?: Date;
  includeSessionId?: boolean;
}): PricingProvider {
  return {
    id: input.providerId,
    quote(context) {
      const startedAt = input.startedAt ?? context.session.startedAt;
      const endedAt = input.endedAt ?? context.session.endedAt ?? context.now;
      return [
        {
          id: `${context.session.id}:${input.providerId}`,
          ...(input.includeSessionId === false ? {} : { sessionId: context.session.id }),
          source: input.providerId,
          label: input.label,
          amount: moneyFixture(input.amount),
          period: {
            startedAt,
            endedAt,
          },
          pricingHistory: {
            pricingConfigId: input.pricingConfigId,
            providerId: input.providerId,
            ruleId: "day",
            ruleAnchorAt: new Date("2026-07-09T02:00:00.000Z"),
            amount: moneyFixture(input.amount),
          },
        },
      ];
    },
  };
}

describe("createSettlementService", () => {
  it("previews checkout without mutating persisted state", async () => {
    const sessions = new MemorySessionRepository({
      id: "session-1",
      playerId: "player-1",
      startedAt: new Date("2026-06-07T10:00:00.000Z"),
      status: "active",
      pricingConfigIds: ["time"],
      paymentStatus: "unpaid",
    });
    const assets = new MemoryAssetRepository([
      {
        id: "holding-1",
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: centsOf(100),
      },
    ]);
    const settlements = new MemorySettlementRepository();
    const service = createSettlementService({
      sessions,
      assets,
      settlements,
      pricingProviders: [pricing],
      assetEffectProviders: [],
      now: () => new Date("2026-06-07T11:00:00.000Z"),
    });

    const result = await service.previewCheckout({
      playerId: "player-1",
    });

    expect(yuanOf(result.settlementPreview.total)).toBe(20);
    expect(result.wallet).toEqual({ balanceBefore: centsOf(100), balanceAfter: centsOf(80) });
    expect(sessions.saved).toEqual([
      {
        id: "session-1",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        status: "active",
        pricingConfigIds: ["time"],
        paymentStatus: "unpaid",
      },
    ]);
    expect(assets.savedHoldings).toEqual([]);
    expect(assets.ledgerEntries).toEqual([]);
    expect(settlements.saved).toEqual([]);
  });

  it("does not display or spend currency whose asset definition is archived", async () => {
    const now = new Date("2026-06-07T11:00:00.000Z");
    const sessions = new MemorySessionRepository({
      id: "session-archived-wallet",
      playerId: "player-1",
      startedAt: new Date("2026-06-07T10:00:00.000Z"),
      status: "active",
      pricingConfigIds: ["time"],
      paymentStatus: "unpaid",
    });
    const assets = new MemoryAssetRepository([
      {
        id: "holding-archived-wallet",
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: centsOf(100),
      },
    ]);
    const assetDefinitions = new MemoryAssetDefinitionRepository([
      {
        type: "currency",
        code: "currency.paid",
        name: "已归档余额",
        stackable: true,
        status: "archived",
        metadata: null,
      },
    ]);
    const availableAssets = createAvailableAssetReader({
      assets,
      assetDefinitions,
      now: () => now,
    });
    const service = createSettlementService({
      sessions,
      assets,
      assetDefinitions,
      availableAssets,
      settlements: new MemorySettlementRepository(),
      pricingProviders: [pricing],
      assetEffectProviders: [],
      now: () => now,
    });

    const preview = await service.previewCheckout({ playerId: "player-1" });
    expect(preview.wallet).toEqual({ balanceBefore: centsOf(0), balanceAfter: centsOf(-20) });
    await expect(service.checkout({
      playerId: "player-1",
      closeSessionsBeforeBalanceCheck: false,
    })).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
  });

  it("checks out by closing the session, settling, and persisting mutations", async () => {
    const sessions = new MemorySessionRepository({
      id: "session-1",
      playerId: "player-1",
      startedAt: new Date("2026-06-07T10:00:00.000Z"),
      status: "active",
      pricingConfigIds: ["time"],
      paymentStatus: "unpaid",
    });
    const assets = new MemoryAssetRepository([
      {
        id: "holding-1",
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: centsOf(100),
      },
    ]);
    const settlements = new MemorySettlementRepository();
    const service = createSettlementService({
      sessions,
      assets,
      settlements,
      pricingProviders: [pricing],
      assetEffectProviders: [],
      now: () => new Date("2026-06-07T11:00:00.000Z"),
    });

    const result = await service.checkout({
      playerId: "player-1",
    });

    expect(result.playerSettlement).toEqual({
      playerId: "player-1",
      sessionIds: ["session-1"],
      subtotal: moneyFixture(20),
      total: moneyFixture(20),
      status: "settled",
      settledAt: new Date("2026-06-07T11:00:00.000Z"),
    });
    expect(result.settlements[0].settlement).toEqual({
      sessionId: "session-1",
      subtotal: centsOf(20),
      total: centsOf(20),
      status: "settled",
      settledAt: new Date("2026-06-07T11:00:00.000Z"),
    });
    expect(sessions.saved).toEqual([
      {
        id: "session-1",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T11:00:00.000Z"),
        status: "closed",
        pricingConfigIds: ["time"],
        paymentStatus: "paid",
      },
    ]);
    expect(assets.savedHoldings).toEqual([
      [
        {
          id: "holding-1",
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: centsOf(80),
        },
      ],
    ]);
    expect(assets.ledgerEntries).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.paid",
        delta: centsOf(-20),
        reason: "session.settlement",
        refId: "session-1",
        transactionId: "asset-tx:session.settlement:session-1",
      },
    ]);
    expect(settlements.saved).toEqual(result.settlements);
  });

  it("stops one active session without charging the player", async () => {
    const sessions = new MemorySessionRepository([
      {
        id: "session-music",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        status: "active",
        pricingConfigIds: ["time"],
        paymentStatus: "unpaid",
        label: "音游区间",
      },
      {
        id: "session-mahjong",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:30:00.000Z"),
        status: "active",
        pricingConfigIds: ["time"],
        paymentStatus: "unpaid",
        label: "四口麻将",
      },
    ]);
    const assets = new MemoryAssetRepository([
      {
        id: "holding-wallet",
        assetType: "currency",
        assetCode: "paid",
        quantity: centsOf(200),
      },
    ]);
    const settlements = new MemorySettlementRepository();
    const service = createSettlementService({
      sessions,
      assets,
      settlements,
      pricingProviders: [fixedPricingProvider(50)],
      assetEffectProviders: [],
      now: () => new Date("2026-06-07T11:00:00.000Z"),
    });

    const stopped = await service.stopSession({
      playerId: "player-1",
      sessionId: "session-mahjong",
    });

    expect(stopped).toMatchObject({
      id: "session-mahjong",
      playerId: "player-1",
      status: "closed",
      endedAt: new Date("2026-06-07T11:00:00.000Z"),
      paymentStatus: "unpaid",
    });
    expect(sessions.saved.find((session) => session.id === "session-music")?.status).toBe("active");
    expect(settlements.saved).toEqual([]);
    expect(assets.savedHoldings).toEqual([]);
    expect(assets.assetTransactions).toEqual([]);
  });

  it("previews all active and unpaid sessions for one player without persisting mutations", async () => {
    const sessions = new MemorySessionRepository([
      {
        id: "session-closed",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:30:00.000Z"),
        status: "closed",
        pricingConfigIds: ["time"],
        paymentStatus: "unpaid",
      },
      {
        id: "session-active",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:45:00.000Z"),
        status: "active",
        pricingConfigIds: ["time"],
        paymentStatus: "unpaid",
      },
    ]);
    const assets = new MemoryAssetRepository([
      {
        id: "holding-wallet",
        assetType: "currency",
        assetCode: "paid",
        quantity: centsOf(200),
      },
    ]);
    const settlements = new MemorySettlementRepository();
    const service = createSettlementService({
      sessions,
      assets,
      settlements,
      pricingProviders: [durationPricingProvider()],
      assetEffectProviders: [],
      now: () => new Date("2026-06-07T11:15:00.000Z"),
    });

    const preview = await service.previewCheckout({
      playerId: "player-1",
    });

    expect(preview.settlementPreview).toEqual({
      playerId: "player-1",
      sessionIds: ["session-closed", "session-active"],
      subtotal: centsOf(60),
      total: centsOf(60),
      status: "preview",
      previewedAt: new Date("2026-06-07T11:15:00.000Z"),
    });
    expect(preview.sessionPreviews.map((item) => ({
      sessionId: item.sessionId,
      subtotal: item.subtotal,
      total: item.total,
    }))).toEqual([
      { sessionId: "session-closed", subtotal: moneyFixture(30), total: moneyFixture(30) },
      { sessionId: "session-active", subtotal: moneyFixture(30), total: moneyFixture(30) },
    ]);
    expect(sessions.saved.find((session) => session.id === "session-active")?.status).toBe("active");
    expect(settlements.saved).toEqual([]);
    expect(assets.savedHoldings).toEqual([]);
  });

  it("confirms all active and unpaid sessions for one player as one unified checkout", async () => {
    const sessions = new MemorySessionRepository([
      {
        id: "session-closed",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:30:00.000Z"),
        status: "closed",
        pricingConfigIds: ["time"],
        paymentStatus: "unpaid",
      },
      {
        id: "session-music",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:45:00.000Z"),
        status: "active",
        pricingConfigIds: ["time"],
        paymentStatus: "unpaid",
      },
      {
        id: "session-mahjong",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T11:00:00.000Z"),
        status: "active",
        pricingConfigIds: ["time"],
        paymentStatus: "unpaid",
      },
    ]);
    const assets = new MemoryAssetRepository([
      {
        id: "holding-wallet",
        assetType: "currency",
        assetCode: "paid",
        quantity: centsOf(200),
      },
    ]);
    const settlements = new MemorySettlementRepository();
    const service = createSettlementService({
      sessions,
      assets,
      settlements,
      pricingProviders: [durationPricingProvider()],
      assetEffectProviders: [],
      now: () => new Date("2026-06-07T11:30:00.000Z"),
    });

    const result = await service.checkout({
      playerId: "player-1",
    });

    expect(result.playerSettlement).toEqual({
      playerId: "player-1",
      sessionIds: ["session-closed", "session-music", "session-mahjong"],
      subtotal: moneyFixture(105),
      total: moneyFixture(105),
      status: "settled",
      settledAt: new Date("2026-06-07T11:30:00.000Z"),
    });
    expect(sessions.saved.map((session) => ({
      id: session.id,
      status: session.status,
      paymentStatus: session.paymentStatus,
      endedAt: session.endedAt,
    })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      {
        id: "session-closed",
        status: "closed",
        paymentStatus: "paid",
        endedAt: new Date("2026-06-07T10:30:00.000Z"),
      },
      {
        id: "session-mahjong",
        status: "closed",
        paymentStatus: "paid",
        endedAt: new Date("2026-06-07T11:30:00.000Z"),
      },
      {
        id: "session-music",
        status: "closed",
        paymentStatus: "paid",
        endedAt: new Date("2026-06-07T11:30:00.000Z"),
      },
    ]);
    expect(settlements.saved.map((record) => record.settlement.sessionId).sort()).toEqual([
      "session-closed",
      "session-mahjong",
      "session-music",
    ]);
    expect(settlements.checkouts).toEqual([{
      timeline: expect.objectContaining({ tracks: expect.any(Array), events: expect.any(Array), totals: expect.any(Array) }),
      id: "player-checkout:session-mahjong",
      playerId: "player-1",
      subtotal: moneyFixture(105),
      total: moneyFixture(105),
      status: "settled",
      settledAt: new Date("2026-06-07T11:30:00.000Z"),
    }]);
    expect(settlements.checkouts[0]!.timeline?.tracks).toHaveLength(3);
    expect(settlements.checkouts[0]!.timeline?.events.flatMap(event => event.entries).some(entry => entry.kind === "current")).toBe(false);
    expect(settlements.checkouts[0]!.timeline?.totals.reduce((total, item) => total + item.amount, 0)).toBe(105);
    expect(assets.assetTransactions).toEqual([
      {
        id: "asset-tx:session.settlement:session-mahjong",
        playerId: "player-1",
        kind: "session.settlement",
        refId: "session-mahjong",
        createdAt: new Date("2026-06-07T11:30:00.000Z"),
        metadata: {
          sessions: ["session-closed", "session-music", "session-mahjong"],
          total: centsOf(105),
          walletBalanceAfter: centsOf(95),
        },
      },
    ]);
  });

  it("preserves negative session contributions until the unified checkout total is calculated", async () => {
    const sessions = new MemorySessionRepository([
      {
        id: "session-charge",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        status: "active",
        pricingConfigIds: ["time-charge"],
        paymentStatus: "unpaid",
      },
      {
        id: "session-discount",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:30:00.000Z"),
        status: "active",
        pricingConfigIds: ["time-discount"],
        paymentStatus: "unpaid",
      },
    ]);
    const assets = new MemoryAssetRepository([{
      id: "holding-paid",
      assetType: "currency",
      assetCode: "paid",
      quantity: centsOf(20),
    }]);
    const settlements = new MemorySettlementRepository();
    const amounts: Record<string, number> = {
      "session-charge": 10,
      "session-discount": -3,
    };
    const service = createSettlementService({
      sessions,
      assets,
      settlements,
      pricingProviders: [],
      pricingProviderResolver: async ({ session }) => [configuredPricingProvider({
        providerId: `pricing-${session.id}`,
        pricingConfigId: session.pricingConfigIds?.[0] ?? "time",
        label: session.id === "session-discount" ? "每小时优惠三元" : "标准计费",
        amount: amounts[session.id] ?? 0,
      })],
      assetEffectProviders: [],
      now: () => new Date("2026-06-07T11:00:00.000Z"),
    });

    const preview = await service.previewCheckout({ playerId: "player-1" });
    expect(preview.sessionPreviews.map(({ sessionId, total }) => ({ sessionId, total }))).toEqual([
      { sessionId: "session-charge", total: moneyFixture(10) },
      { sessionId: "session-discount", total: moneyFixture(-3) },
    ]);
    expect(yuanOf(preview.settlementPreview.total)).toBe(7);

    const result = await service.checkout({ playerId: "player-1" });
    expect(result.settlements.map(({ settlement }) => ({
      sessionId: settlement.sessionId,
      subtotal: settlement.subtotal,
      total: settlement.total,
    }))).toEqual([
      { sessionId: "session-charge", subtotal: centsOf(10), total: centsOf(10) },
      { sessionId: "session-discount", subtotal: centsOf(-3), total: centsOf(-3) },
    ]);
    expect(result.playerSettlement).toMatchObject({ subtotal: moneyFixture(7), total: moneyFixture(7) });
    expect(assets.ledgerEntries).toContainEqual(expect.objectContaining({ delta: centsOf(-7) }));
  });

  it("floors only the unified checkout total when session contributions sum below zero", async () => {
    const sessions = new MemorySessionRepository([
      {
        id: "session-charge",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        status: "active",
        pricingConfigIds: ["time-charge"],
        paymentStatus: "unpaid",
      },
      {
        id: "session-discount",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:30:00.000Z"),
        status: "active",
        pricingConfigIds: ["time-discount"],
        paymentStatus: "unpaid",
      },
    ]);
    const assets = new MemoryAssetRepository([]);
    const settlements = new MemorySettlementRepository();
    const amounts: Record<string, number> = {
      "session-charge": 2,
      "session-discount": -5,
    };
    const service = createSettlementService({
      sessions,
      assets,
      settlements,
      pricingProviders: [],
      pricingProviderResolver: async ({ session }) => [configuredPricingProvider({
        providerId: `pricing-${session.id}`,
        pricingConfigId: session.pricingConfigIds?.[0] ?? "time",
        label: session.id === "session-discount" ? "相对优惠" : "标准计费",
        amount: amounts[session.id] ?? 0,
      })],
      assetEffectProviders: [],
      now: () => new Date("2026-06-07T11:00:00.000Z"),
    });

    const preview = await service.previewCheckout({ playerId: "player-1" });
    expect(preview.sessionPreviews.map(({ sessionId, total }) => ({ sessionId, total }))).toEqual([
      { sessionId: "session-charge", total: moneyFixture(2) },
      { sessionId: "session-discount", total: moneyFixture(-5) },
    ]);
    expect(yuanOf(preview.settlementPreview.total)).toBe(0);

    const result = await service.checkout({ playerId: "player-1" });
    expect(result.settlements.map(({ settlement }) => yuanOf(settlement.total))).toEqual([2, -5]);
    expect(result.playerSettlement.total).toBe(moneyFixture(0));
    expect(assets.ledgerEntries).toEqual([]);
    expect(assets.assetTransactions[0]?.metadata).toMatchObject({ total: 0 });
  });

  it("records checkout asset mutations under one asset transaction", async () => {
    const sessions = new MemorySessionRepository({
      id: "session-1",
      playerId: "player-1",
      startedAt: new Date("2026-06-07T10:00:00.000Z"),
      status: "active",
      pricingConfigIds: ["time"],
      paymentStatus: "unpaid",
    });
    const assets = new MemoryAssetRepository([
      {
        id: "holding-free",
        assetType: "currency",
        assetCode: "currency.free",
        quantity: centsOf(5),
      },
      {
        id: "holding-paid",
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: centsOf(30),
      },
    ]);
    const settlements = new MemorySettlementRepository();
    const service = createSettlementService({
      sessions,
      assets,
      settlements,
      pricingProviders: [
        {
          id: "session-time",
          quote() {
            return [
              {
                id: "charge-1",
                source: "session-time",
                label: "Time",
                amount: moneyFixture(25),
              },
            ];
          },
        },
      ],
      assetEffectProviders: [],
      now: () => new Date("2026-06-07T11:00:00.000Z"),
    });

    await service.checkout({
      playerId: "player-1",
    });

    expect(assets.assetTransactions).toEqual([
      {
        id: "asset-tx:session.settlement:session-1",
        playerId: "player-1",
        kind: "session.settlement",
        refId: "session-1",
        createdAt: new Date("2026-06-07T11:00:00.000Z"),
        metadata: {
          sessions: ["session-1"],
          total: centsOf(25),
          walletBalanceAfter: centsOf(10),
        },
      },
    ]);
    expect(assets.ledgerEntries).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.free",
        delta: centsOf(-5),
        reason: "session.settlement",
        refId: "session-1",
        transactionId: "asset-tx:session.settlement:session-1",
      },
      {
        assetType: "currency",
        assetCode: "currency.paid",
        delta: centsOf(-20),
        reason: "session.settlement",
        refId: "session-1",
        transactionId: "asset-tx:session.settlement:session-1",
      },
    ]);
  });

  it("checks out with a staff override adjustment and persists the billing explanation", async () => {
    const sessions = new MemorySessionRepository({
      id: "session-1",
      playerId: "player-1",
      startedAt: new Date("2026-06-07T10:00:00.000Z"),
      status: "active",
      pricingConfigIds: ["time"],
      paymentStatus: "unpaid",
    });
    const assets = new MemoryAssetRepository([
      {
        id: "holding-1",
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: centsOf(100),
      },
    ]);
    const settlements = new MemorySettlementRepository();
    const service = createSettlementService({
      sessions,
      assets,
      settlements,
      pricingProviders: [pricing],
      assetEffectProviders: [],
      now: () => new Date("2026-06-07T11:00:00.000Z"),
    });

    const result = await service.checkoutWithOverride({
      playerId: "player-1",
      staffId: "staff-1",
      total: 5,
      reason: "machine fault",
    });

    expect(result.playerSettlement).toEqual({
      playerId: "player-1",
      sessionIds: ["session-1"],
      subtotal: moneyFixture(20),
      total: moneyFixture(5),
      status: "settled",
      settledAt: new Date("2026-06-07T11:00:00.000Z"),
    });
    expect(result.adjustments).toEqual([
      {
        id: "session-1:staff.override",
        source: "staff.override:staff-1",
        label: "Staff override: machine fault",
        amount: moneyFixture(-15),
      },
    ]);
    expect(assets.savedHoldings).toEqual([
      [
        {
          id: "holding-1",
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: centsOf(95),
        },
      ],
    ]);
    expect(settlements.saved).toEqual(result.settlements);
  });

  it("rejects negative or non-finite staff override totals without changing sessions or assets", async () => {
    const sessions = new MemorySessionRepository({
      id: "session-1",
      playerId: "player-1",
      startedAt: new Date("2026-06-07T10:00:00.000Z"),
      status: "active",
      pricingConfigIds: ["time"],
      paymentStatus: "unpaid",
    });
    const assets = new MemoryAssetRepository([{
      id: "holding-1",
      assetType: "currency",
      assetCode: "currency.paid",
      quantity: centsOf(100),
    }]);
    const settlements = new MemorySettlementRepository();
    const service = createSettlementService({
      sessions, assets, settlements,
      pricingProviders: [pricing], assetEffectProviders: [],
      now: () => new Date("2026-06-07T11:00:00.000Z"),
    });
    for (const total of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(service.checkoutWithOverride({
        playerId: "player-1", staffId: "staff-1", total, reason: "invalid",
      })).rejects.toMatchObject({ code: "INVALID_OVERRIDE_TOTAL" });
    }
    expect(assets.savedHoldings).toEqual([]);
    expect(settlements.saved).toEqual([]);
  });

  it("separates unified checkout discounts from session and cap adjustments", async () => {
    const sessions = new MemorySessionRepository({
      id: "session-1",
      playerId: "player-1",
      startedAt: new Date("2026-07-10T07:18:43.664Z"),
      status: "active",
      pricingConfigIds: ["time"],
      paymentStatus: "unpaid",
      label: "🎵 音乐游戏",
    });
    const assets = new MemoryAssetRepository([
      {
        id: "holding-discount",
        assetType: "ticket",
        assetCode: "freemother",
        quantity: integerFixture(1),
      },
      {
        id: "holding-wallet",
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: centsOf(12),
      },
    ]);
    const assetDefinitions = new MemoryAssetDefinitionRepository([
      {
        type: "ticket",
        code: "freemother",
        name: "老冯",
        stackable: false,
        status: "active",
        metadata: null,
        pricingEffect: {
          id: "effect-free",
          name: "老冯",
          type: "free",
          scope: "unified",
          value: null,
          consumable: false,
          limitPerDay: null,
          status: "active",
          config: null,
        },
      },
    ]);
    const service = createSettlementService({
      sessions,
      assets,
      settlements: new MemorySettlementRepository(),
      assetDefinitions,
      pricingProviders: [fixedPricingProvider(12)],
      assetEffectProviders: [],
      now: () => new Date("2026-07-10T08:13:48.998Z"),
    });

    const result = await service.checkout({ playerId: "player-1" });

    expect(result.playerSettlement).toMatchObject({ subtotal: moneyFixture(12), total: moneyFixture(0) });
    expect(result.checkoutAdjustments).toEqual([
      expect.objectContaining({ source: "ticket.freemother", label: "老冯", amount: moneyFixture(-12) }),
    ]);
    expect(result.pricingCapAdjustments).toEqual([]);
    expect(result.globalCapWindows).toEqual([]);
  });

  it("prevents double-discounting of daily-limit coupons in a unified checkout of multiple sessions", async () => {
    const sessions = new MemorySessionRepository([
      {
        id: "session-1",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:30:00.000Z"),
        status: "closed",
        pricingConfigIds: ["time"],
        paymentStatus: "unpaid",
      },
      {
        id: "session-2",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:45:00.000Z"),
        status: "active",
        pricingConfigIds: ["time"],
        paymentStatus: "unpaid",
      },
    ]);

    const assets = new MemoryAssetRepository([
      {
        id: "holding-vip-day",
        assetType: "pass",
        assetCode: "pass.daily-vip",
        quantity: integerFixture(1),
      },
      {
        id: "holding-wallet",
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: centsOf(100),
      },
    ]);

    const assetDefinitions = new MemoryAssetDefinitionRepository([
      {
        type: "pass",
        code: "pass.daily-vip",
        name: "Daily VIP Pass",
        stackable: false,
        status: "active",
        metadata: null,
        pricingEffect: {
          id: "effect-daily-vip",
          name: "Daily VIP Pass",
          type: "free",
          consumable: false,
          scope: "session",
          value: null,
          limitPerDay: 1,
          status: "active",
          config: null,
        },
      },
    ]);

    const settlements = new MemorySettlementRepository();
    settlements.sessions = sessions;

    const service = createSettlementService({
      sessions,
      assets,
      settlements,
      assetDefinitions,
      pricingProviders: [pricing],
      assetEffectProviders: [createAssetDefinitionEffectProvider(assetDefinitions)],
      now: () => new Date("2026-06-07T11:00:00.000Z"),
    });

    const result = await service.checkout({
      playerId: "player-1",
    });

    expect(result.playerSettlement.total).toBe(moneyFixture(20));

    const savedSettlements = settlements.saved;
    expect(savedSettlements.length).toBe(2);

    const s1 = savedSettlements.find((s) => s.settlement.sessionId === "session-1")!;
    expect(yuanOf(s1.settlement.total)).toBe(0);
    expect(s1.adjustments.length).toBe(1);

    const s2 = savedSettlements.find((s) => s.settlement.sessionId === "session-2")!;
    expect(yuanOf(s2.settlement.total)).toBe(20);
    expect(s2.adjustments.length).toBe(0);
  });

  it("applies global time caps to only the selected pricing configs before unified discounts", async () => {
    const sessions = new MemorySessionRepository({
      id: "session-cap",
      playerId: "player-1",
      startedAt: new Date("2026-07-09T02:00:00.000Z"),
      status: "active",
      pricingConfigIds: ["pricing-base", "pricing-discount", "pricing-extra"],
      paymentStatus: "unpaid",
    });
    const assets = new MemoryAssetRepository([
      {
        id: "holding-wallet",
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: centsOf(200),
      },
    ]);
    const settlements = new MemorySettlementRepository();
    const pricingCapHistory = new MemoryPricingCapHistoryRepository();
    const service = createSettlementService({
      sessions,
      assets,
      settlements,
      pricingProviders: [
        configuredPricingProvider({
          providerId: "time.base",
          pricingConfigId: "pricing-base",
          label: "音游",
          amount: 96,
        }),
        configuredPricingProvider({
          providerId: "time.mahjong",
          pricingConfigId: "pricing-discount",
          label: "四口麻将",
          amount: -24,
        }),
        configuredPricingProvider({
          providerId: "time.extra",
          pricingConfigId: "pricing-extra",
          label: "不参与服务",
          amount: 20,
        }),
      ],
      pricingCapHistory: pricingCapHistory as any,
      globalCapResolver: async () => [
        {
          id: "cap.global",
          pricingConfigId: "cap-config",
          includedPricingConfigIds: ["pricing-base", "pricing-discount"],
          timeZone: "Asia/Shanghai",
          rules: [
            {
              id: "day",
              label: "日场全局封顶",
              priority: 1,
              timeRange: { start: "10:00", end: "22:00" },
              priceCap: 69,
            },
          ],
        },
      ],
      assetEffectProviders: [],
      now: () => new Date("2026-07-09T10:00:00.000Z"),
    } as any);

    const result = await service.checkout({
      playerId: "player-1",
    });

    expect(result.playerSettlement).toMatchObject({
      subtotal: moneyFixture(92),
      total: moneyFixture(89),
    });
    expect(result.adjustments).toEqual([
      expect.objectContaining({
        source: "time.cap:cap-config:day",
        label: "日场全局封顶",
        amount: moneyFixture(-3),
      }),
    ]);
    expect(result.checkoutAdjustments).toEqual([]);
    expect(result.pricingCapAdjustments).toEqual([
      expect.objectContaining({
        source: "time.cap:cap-config:day",
        label: "日场全局封顶",
        amount: moneyFixture(-3),
      }),
    ]);
    expect(result.globalCapWindows).toEqual([
      expect.objectContaining({
        ruleLabel: "日场全局封顶",
        currentAmount: moneyFixture(72),
        amountApplied: moneyFixture(69),
        priceCap: moneyFixture(69),
      }),
    ]);
    expect(pricingCapHistory.entries).toEqual([
      expect.objectContaining({
        playerId: "player-1",
        capConfigId: "cap-config",
        capRuleId: "day",
        amount: centsOf(69),
      }),
    ]);
  });

  it("includes globally capped pricing windows in checkout previews", async () => {
    const sessions = new MemorySessionRepository([
      {
        id: "session-z",
        playerId: "player-1",
        startedAt: new Date("2026-07-09T02:00:00.000Z"),
        status: "active",
        pricingConfigIds: ["pricing-base"],
        paymentStatus: "unpaid",
      },
      {
        id: "session-a",
        playerId: "player-1",
        startedAt: new Date("2026-07-09T03:00:00.000Z"),
        status: "active",
        pricingConfigIds: ["pricing-base"],
        paymentStatus: "unpaid",
      },
    ]);
    const pricingCapHistory = new MemoryPricingCapHistoryRepository({
      "cap-config@day@2026-07-09T02:00:00.000Z": centsOf(50),
    });
    const service = createSettlementService({
      sessions,
      assets: new MemoryAssetRepository([]),
      settlements: new MemorySettlementRepository(),
      pricingProviders: [],
      pricingProviderResolver: async ({ session }: { session: Session }) => [configuredPricingProvider({
        providerId: "time.base",
        pricingConfigId: "pricing-base",
        label: "音游",
        amount: session.id === "session-z" ? 30 : 10,
      })],
      pricingCapHistory: pricingCapHistory as any,
      globalCapResolver: async () => [
        {
          id: "cap.global",
          pricingConfigId: "cap-config",
          includedPricingConfigIds: ["pricing-base"],
          timeZone: "Asia/Shanghai",
          rules: [
            {
              id: "day",
              label: "日场全局封顶",
              priority: 1,
              timeRange: { start: "10:00", end: "22:00" },
              priceCap: 79,
            },
          ],
        },
      ],
      assetEffectProviders: [],
      now: () => new Date("2026-07-09T10:00:00.000Z"),
    } as any);

    const result = await service.previewCheckout({ playerId: "player-1" });

    expect(result.globalCapWindows).toEqual([
      expect.objectContaining({ paidBefore: moneyFixture(50), currentAmount: moneyFixture(40), priceCap: moneyFixture(79), amountApplied: moneyFixture(29) }),
    ]);
    expect(result.globalCapWindows[0].contributions).toEqual([
      { sessionId: "session-a", pricingConfigId: "pricing-base", amount: moneyFixture(7.25) },
      { sessionId: "session-z", pricingConfigId: "pricing-base", amount: moneyFixture(21.75) },
    ]);
    expect(result.globalCapWindows[0].contributions.reduce((sum, item) => sum + item.amount, 0))
      .toBe(result.globalCapWindows[0].amountApplied);
  });

  it("attributes untagged charges to their owning sessions in global cap windows", async () => {
    const sessions = new MemorySessionRepository([
      {
        id: "session-c",
        playerId: "player-1",
        startedAt: new Date("2026-07-09T02:00:00.000Z"),
        status: "active",
        pricingConfigIds: ["pricing-base"],
        paymentStatus: "unpaid",
      },
      {
        id: "session-a",
        playerId: "player-1",
        startedAt: new Date("2026-07-09T03:00:00.000Z"),
        status: "active",
        pricingConfigIds: ["pricing-base"],
        paymentStatus: "unpaid",
      },
      {
        id: "session-b",
        playerId: "player-1",
        startedAt: new Date("2026-07-09T04:00:00.000Z"),
        status: "active",
        pricingConfigIds: ["pricing-base"],
        paymentStatus: "unpaid",
      },
    ]);
    const amountsBySessionId = {
      "session-a": 3_328_000_000,
      "session-b": 14_808_000_000,
      "session-c": 23_824_000_000,
    };
    const service = createSettlementService({
      sessions,
      assets: new MemoryAssetRepository([]),
      settlements: new MemorySettlementRepository(),
      pricingProviders: [],
      pricingProviderResolver: async ({ session }: { session: Session }) => [configuredPricingProvider({
        providerId: "time.base",
        pricingConfigId: "pricing-base",
        label: "音游",
        amount: amountsBySessionId[session.id as keyof typeof amountsBySessionId],
        includeSessionId: false,
      })],
      globalCapResolver: async () => [
        {
          id: "cap.global",
          pricingConfigId: "cap-config",
          includedPricingConfigIds: ["pricing-base"],
          timeZone: "Asia/Shanghai",
          rules: [{
            id: "day",
            label: "日场全局封顶",
            priority: 1,
            timeRange: { start: "10:00", end: "22:00" },
            priceCap: 38_633_722_597,
          }],
        },
      ],
      assetEffectProviders: [],
      now: () => new Date("2026-07-09T10:00:00.000Z"),
    } as any);

    const result = await service.previewCheckout({ playerId: "player-1" });
    const window = result.globalCapWindows[0];

    expect(window.amountApplied).toBe(moneyFixture(38_633_722_597));
    expect(window.contributions.map((contribution) => contribution.sessionId))
      .toEqual(["session-a", "session-b", "session-c"]);
  });

  it("exactly conserves three global cap contributions in left-to-right order", async () => {
    const sessions = new MemorySessionRepository([
      {
        id: "session-c",
        playerId: "player-1",
        startedAt: new Date("2026-07-09T02:00:00.000Z"),
        status: "active",
        pricingConfigIds: ["pricing-base"],
        paymentStatus: "unpaid",
      },
      {
        id: "session-a",
        playerId: "player-1",
        startedAt: new Date("2026-07-09T03:00:00.000Z"),
        status: "active",
        pricingConfigIds: ["pricing-base"],
        paymentStatus: "unpaid",
      },
      {
        id: "session-b",
        playerId: "player-1",
        startedAt: new Date("2026-07-09T04:00:00.000Z"),
        status: "active",
        pricingConfigIds: ["pricing-base"],
        paymentStatus: "unpaid",
      },
    ]);
    const amountsBySessionId = {
      "session-a": 3_328_000_000,
      "session-b": 14_808_000_000,
      "session-c": 23_824_000_000,
    };
    const service = createSettlementService({
      sessions,
      assets: new MemoryAssetRepository([]),
      settlements: new MemorySettlementRepository(),
      pricingProviders: [],
      pricingProviderResolver: async ({ session }: { session: Session }) => [configuredPricingProvider({
        providerId: "time.base",
        pricingConfigId: "pricing-base",
        label: "音游",
        amount: amountsBySessionId[session.id as keyof typeof amountsBySessionId],
      })],
      globalCapResolver: async () => [
        {
          id: "cap.global",
          pricingConfigId: "cap-config",
          includedPricingConfigIds: ["pricing-base"],
          timeZone: "Asia/Shanghai",
          rules: [{
            id: "day",
            label: "日场全局封顶",
            priority: 1,
            timeRange: { start: "10:00", end: "22:00" },
            priceCap: 38_633_722_597,
          }],
        },
      ],
      assetEffectProviders: [],
      now: () => new Date("2026-07-09T10:00:00.000Z"),
    } as any);

    const result = await service.previewCheckout({ playerId: "player-1" });
    const window = result.globalCapWindows[0];

    expect(window.contributions.map((contribution) => contribution.sessionId))
      .toEqual(["session-a", "session-b", "session-c"]);
    expect(window.contributions.reduce((sum, contribution) => sum + contribution.amount, 0))
      .toBe(window.amountApplied);
  });

  it("settles with 0 fee if session ended within grace period and no device was operated", async () => {
    const sessions = new MemorySessionRepository([
      {
        id: "session-free",
        playerId: "player-1",
        startedAt: new Date("2026-07-09T02:00:00.000Z"),
        endedAt: new Date("2026-07-09T02:03:00.000Z"),
        status: "closed",
        pricingConfigIds: ["pricing-base"],
        paymentStatus: "unpaid",
      },
    ]);
    const provider = createTimePricingProvider({
      id: "time.base",
      label: "音游",
      unitMinutes: 30,
      unitPrice: 10,
      roundGraceMinutes: 5,
      priceCap: 50,
    });
    const service = createSettlementService({
      sessions,
      assets: new MemoryAssetRepository([]),
      settlements: new MemorySettlementRepository(),
      pricingProviders: [provider],
      assetEffectProviders: [],
      now: () => new Date("2026-07-09T02:03:00.000Z"),
    });

    const result = await service.previewCheckout({ playerId: "player-1" });
    expect(yuanOf(result.settlementPreview.total)).toBe(0);
  });

  it("invalidates first grace period when session has deviceOperated metadata", async () => {
    const sessions = new MemorySessionRepository([
      {
        id: "session-op",
        playerId: "player-1",
        startedAt: new Date("2026-07-09T02:00:00.000Z"),
        endedAt: new Date("2026-07-09T02:03:00.000Z"),
        status: "closed",
        pricingConfigIds: ["pricing-base"],
        paymentStatus: "unpaid",
        metadata: { deviceOperated: true },
      },
    ]);
    const provider = createTimePricingProvider({
      id: "time.base",
      label: "音游",
      unitMinutes: 30,
      unitPrice: 10,
      roundGraceMinutes: 5,
      priceCap: 50,
    });
    const service = createSettlementService({
      sessions,
      assets: new MemoryAssetRepository([]),
      settlements: new MemorySettlementRepository(),
      pricingProviders: [provider],
      assetEffectProviders: [],
      now: () => new Date("2026-07-09T02:03:00.000Z"),
    });

    const result = await service.previewCheckout({ playerId: "player-1" });
    expect(yuanOf(result.settlementPreview.total)).toBe(10);
  });

  it("treats a power operation as device use and invalidates first grace", async () => {
    const sessions = new MemorySessionRepository([
      {
        id: "session-power",
        playerId: "player-1",
        startedAt: new Date("2026-07-09T02:00:00.000Z"),
        endedAt: new Date("2026-07-09T02:03:00.000Z"),
        status: "closed",
        pricingConfigIds: ["pricing-base"],
        paymentStatus: "unpaid",
      },
    ]);
    const deviceOperations = memoryOperations([
      operation({ id: "op-power-1", action: "power.on", capability: "power", countsAsPlay: true, requestedAt: new Date("2026-07-09T02:01:00.000Z") }),
    ]);
    const provider = createTimePricingProvider({
      id: "time.base",
      label: "音游",
      unitMinutes: 30,
      unitPrice: 10,
      roundGraceMinutes: 5,
      priceCap: 50,
    });
    const service = createSettlementService({
      sessions,
      assets: new MemoryAssetRepository([]),
      settlements: new MemorySettlementRepository(),
      pricingProviders: [provider],
      deviceOperations,
      assetEffectProviders: [],
      now: () => new Date("2026-07-09T02:03:00.000Z"),
    });

    const result = await service.previewCheckout({ playerId: "player-1" });
    expect(yuanOf(result.settlementPreview.total)).toBe(10);
  });

  it("keeps free exit when only a door operation occurred during grace window", async () => {
    const sessions = new MemorySessionRepository([
      {
        id: "session-door-only",
        playerId: "player-1",
        startedAt: new Date("2026-07-09T02:00:00.000Z"),
        endedAt: new Date("2026-07-09T02:03:00.000Z"),
        status: "closed",
        pricingConfigIds: ["pricing-base"],
        paymentStatus: "unpaid",
      },
    ]);
    const deviceOperations = memoryOperations([
      operation({ id: "op-door-1", action: "door.open", capability: "door", countsAsPlay: false, requestedAt: new Date("2026-07-09T02:00:10.000Z") }),
    ]);
    const provider = createTimePricingProvider({
      id: "time.base",
      label: "音游",
      unitMinutes: 30,
      unitPrice: 10,
      roundGraceMinutes: 5,
      priceCap: 50,
    });
    const service = createSettlementService({
      sessions,
      assets: new MemoryAssetRepository([]),
      settlements: new MemorySettlementRepository(),
      pricingProviders: [provider],
      deviceOperations,
      assetEffectProviders: [],
      now: () => new Date("2026-07-09T02:03:00.000Z"),
    });

    const result = await service.previewCheckout({ playerId: "player-1" });
    expect(yuanOf(result.settlementPreview.total)).toBe(0);
  });

  it("atomically recharges paid currency and settles all open sessions with one checkout commit", async () => {
    const sessions = new MemorySessionRepository([
      { id: "s1", playerId: "player-1", startedAt: new Date("2026-07-09T01:00:00Z"), status: "active", paymentStatus: "unpaid" },
      { id: "s2", playerId: "player-1", startedAt: new Date("2026-07-09T02:00:00Z"), status: "active", paymentStatus: "unpaid" },
    ]);
    const assets = new MemoryAssetRepository([
      { id: "paid-1", assetType: "currency", assetCode: "paid", quantity: centsOf(5) },
    ]);
    const definitions = new MemoryAssetDefinitionRepository([
      { type: "currency", code: "paid", name: "充值余额", stackable: true, status: "active", metadata: null },
    ]);
    const settlements = new MemorySettlementRepository();
    const commits: Array<import("@prism/core").CheckoutCommit> = [];
    const service = createSettlementService({
      sessions, assets, settlements,
      assetDefinitions: definitions,
      availableAssets: createAvailableAssetReader({
        assets, assetDefinitions: definitions, now: () => new Date("2026-07-09T03:00:00Z"),
      }),
      commitCheckout: async data => {
        commits.push(data);
        await assets.commitAssetTransaction(data.assets!);
        await settlements.saveCheckout(data.checkout, data.settlements);
        for (const session of data.sessions) await sessions.save(session);
      },
      pricingProviders: [pricing],
      assetEffectProviders: [],
      now: () => new Date("2026-07-09T03:00:00Z"),
      id: () => "generated-recharge-id",
    });
    const result = await service.checkoutWithRecharge({
      playerId: "player-1", staffId: "staff-1", amount: 50,
    });
    expect(result.playerSettlement.sessionIds).toEqual(["s1", "s2"]);
    expect(yuanOf(result.playerSettlement.total)).toBe(40);
    expect(yuanOf(result.wallet.balanceBefore)).toBe(55);
    expect(yuanOf(result.wallet.balanceAfter)).toBe(15);
    expect(commits).toHaveLength(1);
    expect(assets.assetTransactions).toHaveLength(1);
    expect(assets.assetTransactions[0]?.metadata).toMatchObject({
      rechargeAmount: centsOf(50),
      rechargeStaffId: "staff-1",
      walletBalanceAfter: centsOf(15),
    });
    expect(assets.ledgerEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        assetType: "currency", assetCode: "paid",
        delta: centsOf(50), reason: "staff.checkout.recharge",
        transactionId: "asset-tx:session.settlement:s2",
      }),
      expect.objectContaining({
        assetType: "currency", assetCode: "paid",
        delta: centsOf(-40), reason: "session.settlement",
        transactionId: "asset-tx:session.settlement:s2",
      }),
    ]));
    expect(sessions.saved.every(session => session.status === "closed" && session.paymentStatus === "paid")).toBe(true);
  });

  it("does not recharge or close sessions when the freshly calculated bill is not covered", async () => {
    const sessions = new MemorySessionRepository([
      { id: "s1", playerId: "player-1", startedAt: new Date("2026-07-09T01:00:00Z"), status: "active", paymentStatus: "unpaid" },
      { id: "s2", playerId: "player-1", startedAt: new Date("2026-07-09T02:00:00Z"), status: "active", paymentStatus: "unpaid" },
    ]);
    const assets = new MemoryAssetRepository([
      { id: "paid-1", assetType: "currency", assetCode: "paid", quantity: centsOf(5) },
    ]);
    const definitions = new MemoryAssetDefinitionRepository([
      { type: "currency", code: "paid", name: "充值余额", stackable: true, status: "active", metadata: null },
    ]);
    const settlements = new MemorySettlementRepository();
    let commits = 0;
    const service = createSettlementService({
      sessions, assets, settlements, assetDefinitions: definitions,
      availableAssets: createAvailableAssetReader({
        assets, assetDefinitions: definitions, now: () => new Date("2026-07-09T03:00:00Z"),
      }),
      commitCheckout: async () => { commits++; },
      pricingProviders: [pricing], assetEffectProviders: [],
      now: () => new Date("2026-07-09T03:00:00Z"),
      id: () => "generated-recharge-id",
    });
    await expect(service.checkoutWithRecharge({
      playerId: "player-1", staffId: "staff-1", amount: 34.99,
    })).rejects.toMatchObject({ code: "INSUFFICIENT_RECHARGE_BALANCE" });
    expect(commits).toBe(0);
    expect(assets.savedHoldings).toHaveLength(0);
    expect(assets.assetTransactions).toHaveLength(0);
    expect(settlements.saved).toHaveLength(0);
    expect(sessions.saved.every(session => session.status === "active")).toBe(true);
    for (const amount of [0, -1, NaN, Infinity, 0.001]) {
      await expect(service.checkoutWithRecharge({
        playerId: "player-1", staffId: "staff-1", amount,
      })).rejects.toMatchObject({ code: "INVALID_CHECKOUT_RECHARGE_AMOUNT" });
    }
    expect(commits).toBe(0);
  });

  it("fails closed if atomic checkout or the paid currency definition is unavailable", async () => {
    const sessions = new MemorySessionRepository({
      id: "s1", playerId: "player-1", startedAt: new Date("2026-07-09T01:00:00Z"),
      status: "active", paymentStatus: "unpaid",
    });
    const assets = new MemoryAssetRepository([]);
    const definitions = new MemoryAssetDefinitionRepository([
      { type: "currency", code: "paid", name: "充值余额", stackable: true, status: "archived", metadata: null },
    ]);
    const common = {
      sessions, assets, assetDefinitions: definitions, settlements: new MemorySettlementRepository(),
      pricingProviders: [pricing], assetEffectProviders: [],
      now: () => new Date("2026-07-09T03:00:00Z"),
    };
    await expect(createSettlementService({
      ...common,
      commitCheckout: async () => {},
    }).checkoutWithRecharge({
      playerId: "player-1", staffId: "staff-1", amount: 20,
    })).rejects.toMatchObject({ code: "RECHARGE_ASSET_UNAVAILABLE" });
    await expect(createSettlementService(common).checkoutWithRecharge({
      playerId: "player-1", staffId: "staff-1", amount: 20,
    })).rejects.toMatchObject({ code: "RECHARGE_CHECKOUT_NOT_CONFIGURED" });
    expect(assets.assetTransactions).toHaveLength(0);
    expect(sessions.saved[0]?.status).toBe("active");
  });

});
