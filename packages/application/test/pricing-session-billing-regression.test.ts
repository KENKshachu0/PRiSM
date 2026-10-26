import { describe, expect, it } from "bun:test";
import type {
  AssetHolding,
  AssetLedgerEntry,
  AssetRepository,
  AssetTransaction,
  OperationLockRepository,
  PastAppliedAdjustment,
  PlayerCheckout,
  PricingConfig,
  PricingConfigRepository,
  PricingProvider,
  Session,
  SessionRepository,
  SessionTransitionWrite,
  SettlementRecord,
  SettlementRepository,
} from "@prism/core";
import { centsOf, createPricingProviderFromConfig, yuanOf } from "@prism/core";
import { createPricingSessionOrchestrator, createSettlementService } from "../src/index";

const at = new Date("2026-10-01T00:00:00.000Z");
const minutes = (value: number) => new Date(at.getTime() + value * 60_000);

/**
 * The design document's §14.1 / §22.5 plan set: normal play 13 元/h, the eight-seat
 * mahjong table +2 元/h, the four-seat table -2 元/h. Unit prices stay in yuan
 * exactly as the pricing editor enters them; the provider converts to cents.
 */
function plan(
  id: string,
  name: string,
  unitPrice: number,
  relations?: { requires?: string[]; conflicts?: string[] },
): PricingConfig {
  return {
    id,
    kind: "time.priority",
    name,
    enabled: true,
    status: "active",
    provider: {
      id: `provider-${id}`,
      rules: [
        {
          id: "all-day",
          label: "全天",
          priority: 0,
          timeRange: { start: "00:00", end: "00:00" },
          pricing: { unitMinutes: 60, unitPrice, roundGraceMinutes: 0, priceCap: 1000 },
        },
      ],
    },
    ...(relations ? { relations: { requires: relations.requires ?? [], conflicts: relations.conflicts ?? [] } } : {}),
    createdAt: at,
    updatedAt: at,
  };
}

const designPlans = (): PricingConfig[] => [
  plan("normal-play", "普通游玩", 13),
  plan("mahjong-eight", "八口机麻将", 2, { requires: ["normal-play"], conflicts: ["mahjong-four"] }),
  plan("mahjong-four", "四口机麻将", -2, { requires: ["normal-play"], conflicts: ["mahjong-eight"] }),
];

class MemorySessionRepository implements SessionRepository {
  sessions: Session[] = [];
  writes = 0;

  async findActiveByPlayerId(playerId: string): Promise<Session[]> {
    return this.sessions.filter((session) => session.playerId === playerId && session.status === "active");
  }

  async findById(sessionId: string): Promise<Session | null> {
    return this.sessions.find((session) => session.id === sessionId) ?? null;
  }

  async findUnpaidClosedByPlayerId(playerId: string): Promise<Session[]> {
    return this.sessions.filter((session) =>
      session.playerId === playerId && session.status === "closed" && session.paymentStatus === "unpaid");
  }

  async save(session: Session): Promise<void> {
    await this.saveMany([session]);
  }

  async saveMany(sessions: readonly Session[]): Promise<void> {
    this.writes += 1;
    for (const session of sessions) {
      this.sessions = [...this.sessions.filter((existing) => existing.id !== session.id), { ...session }];
    }
  }

  async applyTransition(input: SessionTransitionWrite): Promise<void> {
    const duplicate = input.create.find((session) => this.sessions.some((existing) =>
      existing.status === "active" && existing.id !== session.id &&
      existing.pricingConfigId === session.pricingConfigId));
    if (duplicate) throw new Error("UNIQUE constraint failed: index 'idx_sessions_active_plan'");
    await this.saveMany([...input.close, ...input.create]);
  }
}

class MemoryPricingConfigRepository implements PricingConfigRepository {
  constructor(public configs: PricingConfig[]) {}

  async save(config: PricingConfig): Promise<void> {
    this.configs = [config, ...this.configs.filter((existing) => existing.id !== config.id)];
  }

  async findById(configId: string): Promise<PricingConfig | null> {
    return this.configs.find((config) => config.id === configId) ?? null;
  }

  async listAll(): Promise<PricingConfig[]> {
    return this.configs;
  }

  async listEnabled(): Promise<PricingConfig[]> {
    return this.configs.filter((config) => config.enabled);
  }
}

class MemoryOperationLocks implements OperationLockRepository {
  private held = new Map<string, string>();

  async acquire(scope: string, resourceId: string, lockId: string): Promise<boolean> {
    const key = `${scope}/${resourceId}`;
    if (this.held.has(key) && this.held.get(key) !== lockId) return false;
    this.held.set(key, lockId);
    return true;
  }

  async release(scope: string, resourceId: string): Promise<void> {
    this.held.delete(`${scope}/${resourceId}`);
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

  async listPastAppliedAdjustmentsByPlayerId(playerId: string): Promise<PastAppliedAdjustment[]> {
    const list: PastAppliedAdjustment[] = [];
    for (const record of this.saved) {
      const session = this.sessions ? await this.sessions.findById(record.settlement.sessionId) : null;
      for (const adjustment of record.adjustments) {
        list.push({ source: adjustment.source, sessionStartedAt: session?.startedAt ?? new Date() });
      }
    }
    return list;
  }
}

/** Prices a session from its plan list, as the production resolver does. */
function pricingProvidersFor(configs: readonly PricingConfig[], session: Session): PricingProvider[] {
  return (session.pricingConfigIds ?? []).map((planId) => {
    const config = configs.find((candidate) => candidate.id === planId);
    if (!config || config.kind !== "time.priority") {
      throw new Error(`No time.priority pricing config for session '${session.id}'.`);
    }
    return createPricingProviderFromConfig(config);
  });
}

function fixture() {
  const configs = designPlans();
  const sessions = new MemorySessionRepository();
  const pricingConfigs = new MemoryPricingConfigRepository(configs);
  const assets = new MemoryAssetRepository([
    { id: "wallet-1", assetType: "currency", assetCode: "currency.paid", quantity: centsOf(100) },
  ]);
  const settlements = new MemorySettlementRepository();
  settlements.sessions = sessions;
  const operationLocks = new MemoryOperationLocks();
  let clock = at;
  let counter = 0;
  const nextId = () => `id-${++counter}`;
  const orchestrator = createPricingSessionOrchestrator({
    sessions,
    pricingCatalog: () => pricingConfigs.listAll(),
    operationLocks,
    now: () => clock,
    id: nextId,
  });
  const settlement = createSettlementService({
    sessions,
    operationLocks,
    assets,
    settlements,
    pricingProviders: [],
    pricingProviderResolver: async ({ session }) => pricingProvidersFor(configs, session),
    assetEffectProviders: [],
    now: () => clock,
    id: nextId,
  });
  return {
    sessions,
    orchestrator,
    settlement,
    assets,
    settlements,
    advance: (value: number) => { clock = minutes(value); },
  };
}

describe("pricing session billing regression (design §14.1)", () => {
  it("bills 13 元/h normal play plus the 2 元/h eight-seat surcharge as 26 + 2 = 28 元", async () => {
    const { orchestrator, sessions, settlement, advance } = fixture();

    const base = await orchestrator.activate({ playerId: "player-1", pricingConfigId: "normal-play" });
    const baseSessionId = base.started[0]!.sessionId!;
    const baseStartedAt = sessions.sessions.find((session) => session.id === baseSessionId)!.startedAt;

    advance(70);
    const eight = await orchestrator.activate({ playerId: "player-1", pricingConfigId: "mahjong-eight" });
    const eightSessionId = eight.started[0]!.sessionId!;

    // Starting the surcharge keeps the base plan running as one untouched session.
    expect(eight.started.map((item) => item.planId)).toEqual(["mahjong-eight"]);
    expect(eight.kept.map((item) => item.planId)).toEqual(["normal-play"]);
    const baseSessions = sessions.sessions.filter((session) =>
      session.pricingConfigId === "normal-play");
    expect(baseSessions).toHaveLength(1);
    expect(baseSessions[0]!.id).toBe(baseSessionId);
    expect(baseSessions[0]!.status).toBe("active");
    expect(baseSessions[0]!.startedAt).toEqual(at);
    expect(baseStartedAt).toEqual(at);

    advance(120);
    const stopped = await orchestrator.deactivate({ playerId: "player-1", pricingConfigId: "mahjong-eight" });
    expect(stopped.stopped.map((item) => item.planId)).toEqual(["mahjong-eight"]);
    // The base session is still the same one, still running at the same instant.
    const stillBase = sessions.sessions.filter((session) =>
      session.pricingConfigId === "normal-play");
    expect(stillBase).toHaveLength(1);
    expect(stillBase[0]!.id).toBe(baseSessionId);
    expect(stillBase[0]!.status).toBe("active");
    expect(stillBase[0]!.startedAt).toEqual(at);

    const preview = await settlement.previewCheckout({ playerId: "player-1" });
    const previewBySessionId = new Map(preview.sessionPreviews.map((entry) => [entry.sessionId, entry]));
    const basePreview = previewBySessionId.get(baseSessionId)!;
    const eightPreview = previewBySessionId.get(eightSessionId)!;

    // 120 minutes at 13 元/h = 2 units = 2600 cents.
    expect(basePreview.subtotal).toBe(centsOf(26));
    expect(basePreview.chargeItems).toHaveLength(1);
    expect(basePreview.chargeItems[0]).toMatchObject({
      sessionId: baseSessionId,
      amount: centsOf(26),
      pricingHistory: expect.objectContaining({ pricingConfigId: "normal-play" }),
    });

    // 50 minutes at 2 元/h rounds up to one unit: the surcharge has no charge
    // item of its own beyond that, and nothing lands on the base session.
    expect(eightPreview.subtotal).toBe(centsOf(2));
    expect(eightPreview.chargeItems).toHaveLength(1);
    expect(eightPreview.chargeItems[0]).toMatchObject({
      sessionId: eightSessionId,
      amount: centsOf(2),
      pricingHistory: expect.objectContaining({ pricingConfigId: "mahjong-eight" }),
    });
    // The unified checkout sees exactly one charge per session, each attributed
    // to the session that produced it.
    expect(preview.chargeItems.map((item) => [item.sessionId, item.amount])).toEqual([
      [baseSessionId, centsOf(26)],
      [eightSessionId, centsOf(2)],
    ]);

    expect(yuanOf(basePreview.subtotal)).toBe(26);
    expect(yuanOf(eightPreview.subtotal)).toBe(2);
    expect(preview.settlementPreview.subtotal).toBe(centsOf(28));
    expect(preview.settlementPreview.total).toBe(centsOf(28));
    // The stored total is an integer count of cents: 2800 cents = 28 元.
    expect(Number(preview.settlementPreview.total)).toBe(2800);
    expect(basePreview.subtotal + eightPreview.subtotal).toBe(preview.settlementPreview.total);

    const result = await settlement.checkout({ playerId: "player-1" });
    expect(result.playerSettlement.subtotal).toBe(centsOf(28));
    expect(result.playerSettlement.total).toBe(centsOf(28));
    expect(Number(result.playerSettlement.total)).toBe(2800);
    expect(result.settlements.map(({ settlement: record }) => [record.sessionId, record.total])).toEqual([
      [baseSessionId, centsOf(26)],
      [eightSessionId, centsOf(2)],
    ]);
    expect(result.sessionDetails.map((detail) => [detail.sessionId, detail.endedAt])).toEqual([
      [baseSessionId, minutes(120)],
      [eightSessionId, minutes(120)],
    ]);
    expect(yuanOf(result.wallet.balanceBefore)).toBe(100);
    expect(yuanOf(result.wallet.balanceAfter)).toBe(72);
    expect(sessions.sessions).toHaveLength(2);
    expect(sessions.sessions.filter((session) =>
      session.pricingConfigId === "normal-play")).toHaveLength(1);
    expect(sessions.sessions.every((session) =>
      session.status === "closed" && session.paymentStatus === "paid")).toBe(true);
  });

  it("switches mahjong-eight to mahjong-four without restarting normal play, and the -2 元/h surcharge reduces the bill", async () => {
    const { orchestrator, sessions, settlement, advance } = fixture();
    const base = await orchestrator.activate({ playerId: "player-1", pricingConfigId: "normal-play" });
    advance(70);
    await orchestrator.activate({ playerId: "player-1", pricingConfigId: "mahjong-eight" });
    advance(120);

    const switched = await orchestrator.activate({ playerId: "player-1", pricingConfigId: "mahjong-four" });

    expect(switched.stopped.map((item) => item.planId)).toEqual(["mahjong-eight"]);
    expect(switched.started.map((item) => item.planId)).toEqual(["mahjong-four"]);
    expect(switched.kept.map((item) => item.planId)).toEqual(["normal-play"]);

    const baseSession = sessions.sessions.find((session) =>
      session.pricingConfigId === "normal-play")!;
    const eightSession = sessions.sessions.find((session) =>
      session.pricingConfigId === "mahjong-eight")!;
    const fourSession = sessions.sessions.find((session) =>
      session.pricingConfigId === "mahjong-four")!;

    expect(baseSession.id).toBe(base.started[0]!.sessionId!);
    expect(baseSession.status).toBe("active");
    expect(baseSession.startedAt).toEqual(at);
    expect(eightSession.status).toBe("closed");
    expect(eightSession.endedAt).toEqual(minutes(120));
    expect(eightSession.paymentStatus).toBe("unpaid");
    expect(fourSession.status).toBe("active");
    expect(fourSession.startedAt).toEqual(minutes(120));
    expect(fourSession.paymentStatus).toBe("unpaid");

    advance(180);
    const preview = await settlement.previewCheckout({ playerId: "player-1" });
    const previewBySessionId = new Map(preview.sessionPreviews.map((entry) => [entry.sessionId, entry]));
    const basePreview = previewBySessionId.get(baseSession.id)!;
    const eightPreview = previewBySessionId.get(eightSession.id)!;
    const fourPreview = previewBySessionId.get(fourSession.id)!;

    // 180 minutes at 13 元/h, 50 minutes at +2 元/h, 60 minutes at -2 元/h.
    expect(basePreview.subtotal).toBe(centsOf(39));
    expect(eightPreview.subtotal).toBe(centsOf(2));
    expect(fourPreview.subtotal).toBe(centsOf(-2));
    expect(fourPreview.chargeItems).toHaveLength(1);
    expect(fourPreview.chargeItems[0]).toMatchObject({
      sessionId: fourSession.id,
      amount: centsOf(-2),
      pricingHistory: expect.objectContaining({ pricingConfigId: "mahjong-four" }),
    });
    expect(basePreview.subtotal + eightPreview.subtotal + fourPreview.subtotal)
      .toBe(preview.settlementPreview.total);
    // The two positive contributions alone are 41 元; the -2 元 credit lowers
    // the unified total to exactly 39 元.
    expect(basePreview.subtotal + eightPreview.subtotal).toBe(centsOf(41));
    expect(preview.settlementPreview.total).toBe(centsOf(39));
    expect(yuanOf(preview.settlementPreview.total)).toBe(39);

    const result = await settlement.checkout({ playerId: "player-1" });
    expect(result.playerSettlement.total).toBe(centsOf(39));
    expect(result.settlements.find(({ settlement: record }) =>
      record.sessionId === fourSession.id)!.settlement.total).toBe(centsOf(-2));
    expect(yuanOf(result.wallet.balanceAfter)).toBe(61);
  });

  it("stopping normal play cascades to mahjong-eight at the same instant and keeps both unpaid", async () => {
    const { orchestrator, sessions, advance } = fixture();
    await orchestrator.activate({ playerId: "player-1", pricingConfigId: "normal-play" });
    advance(70);
    await orchestrator.activate({ playerId: "player-1", pricingConfigId: "mahjong-eight" });
    advance(120);

    const stopped = await orchestrator.deactivate({ playerId: "player-1", pricingConfigId: "normal-play" });

    expect(stopped.stopped.map((item) => item.planId)).toEqual(["mahjong-eight", "normal-play"]);
    const baseSession = sessions.sessions.find((session) =>
      session.pricingConfigId === "normal-play")!;
    const eightSession = sessions.sessions.find((session) =>
      session.pricingConfigId === "mahjong-eight")!;
    expect(baseSession.status).toBe("closed");
    expect(eightSession.status).toBe("closed");
    expect(baseSession.endedAt).toEqual(minutes(120));
    expect(eightSession.endedAt).toEqual(minutes(120));
    expect(eightSession.endedAt).toEqual(baseSession.endedAt);
    expect(baseSession.paymentStatus).toBe("unpaid");
    expect(eightSession.paymentStatus).toBe("unpaid");
    expect(sessions.sessions.filter((session) => session.status === "active")).toHaveLength(0);
    expect(await sessions.findUnpaidClosedByPlayerId("player-1")).toHaveLength(2);
  });

  it("does not restart an already active plan or create a second session for it", async () => {
    const { orchestrator, sessions, advance } = fixture();
    await orchestrator.activate({ playerId: "player-1", pricingConfigId: "mahjong-eight" });
    const writes = sessions.writes;
    advance(30);

    const again = await orchestrator.activate({ playerId: "player-1", pricingConfigId: "mahjong-eight" });

    expect(again.changed).toBe(false);
    expect(again.started).toEqual([]);
    expect(again.stopped).toEqual([]);
    expect(again.kept.map((item) => item.planId)).toEqual(["mahjong-eight", "normal-play"]);
    expect(sessions.writes).toBe(writes);
    expect(sessions.sessions).toHaveLength(2);
    const eightSessions = sessions.sessions.filter((session) =>
      session.pricingConfigId === "mahjong-eight");
    expect(eightSessions).toHaveLength(1);
    expect(eightSessions[0]!.status).toBe("active");
    expect(eightSessions[0]!.startedAt).toEqual(at);
    expect(sessions.sessions.find((session) =>
      session.pricingConfigId === "normal-play")!.startedAt).toEqual(at);
  });
});
