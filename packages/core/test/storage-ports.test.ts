import { centsOf, yuanOf } from "@prism/core";
import { describe, expect, it } from "bun:test";
import type {
  AssetHolding,
  AssetLedgerEntry,
  AssetRepository,
  AssetTransaction,
  DeviceCommand,
  DeviceCommandRepository,
  Present,
  RedeemCode,
  RedeemRecord,
  RedeemRepository,
  SessionRepository,
  SettlementRecord,
  SettlementRepository,
  Session,
} from "../src/index";

class InMemorySessionRepository implements SessionRepository {
  private sessions: Session[] = [];

  async findActiveByPlayerId(playerId: string): Promise<Session[]> {
    return this.sessions
      .filter((session) => session.playerId === playerId && session.status === "active")
      .map((session) => ({ ...session }));
  }

  async findById(sessionId: string): Promise<Session | null> {
    const session = this.sessions.find((item) => item.id === sessionId);
    return session ? { ...session } : null;
  }

  async findUnpaidClosedByPlayerId(playerId: string): Promise<Session[]> {
    return this.sessions
      .filter((session) => session.playerId === playerId && session.status === "closed" && session.paymentStatus !== "paid")
      .map((session) => ({ ...session }));
  }

  async save(session: Session): Promise<void> {
    const index = this.sessions.findIndex((existing) => existing.id === session.id);
    if (index === -1) {
      this.sessions.push({ ...session });
      return;
    }
    this.sessions[index] = { ...session };
  }
}

class InMemoryAssetRepository implements AssetRepository {
  private assets = new Map<string, AssetHolding[]>();
  private ledgerEntries: AssetLedgerEntry[] = [];
  private transactions: AssetTransaction[] = [];

  async listAssetHoldings(playerId: string): Promise<AssetHolding[]> {
    return this.assets.get(playerId)?.map((holding) => ({ ...holding })) ?? [];
  }

  async commitAssetTransaction({ transaction, holdingChanges, assetLedgerEntries }: Parameters<AssetRepository["commitAssetTransaction"]>[0]): Promise<void> {
    const playerId = transaction.playerId;
    const next = (this.assets.get(playerId) ?? [])
      .filter((holding) => !holding.id || !holdingChanges.deleteIds.includes(holding.id))
      .map((holding) => ({ ...holding }));
    for (const holding of holdingChanges.upserts) {
      const index = next.findIndex((existing) => existing.id === holding.id);
      if (index >= 0) next[index] = { ...holding };
      else next.push({ ...holding });
    }
    this.assets.set(playerId, next);
    this.transactions.push(transaction);
    this.ledgerEntries.push(
      ...assetLedgerEntries.map((entry) => ({ ...entry, refId: `${playerId}:${entry.refId}`, transactionId: transaction.id })),
    );
  }

  async listLedgerEntriesByPlayerId(playerId: string): Promise<AssetLedgerEntry[]> {
    return this.ledgerEntries
      .filter((entry) => entry.refId.startsWith(`${playerId}:`))
      .map((entry) => ({ ...entry, refId: entry.refId.slice(playerId.length + 1) }));
  }

  async listTransactionsByPlayerId(playerId: string): Promise<AssetTransaction[]> {
    return this.transactions.filter((transaction) => transaction.playerId === playerId).map((transaction) => ({ ...transaction }));
  }
}

class InMemoryDeviceCommandRepository implements DeviceCommandRepository {
  private commands = new Map<string, DeviceCommand>();

  async enqueueDeviceCommand(command: DeviceCommand): Promise<void> {
    this.commands.set(command.id, command);
  }

  async getDeviceCommand(commandId: string): Promise<DeviceCommand | null> {
    return this.commands.get(commandId) ?? null;
  }

  async listByPlayerId(playerId: string): Promise<DeviceCommand[]> {
    return [...this.commands.values()].filter((command) => command.playerId === playerId);
  }

  async listPending(): Promise<DeviceCommand[]> {
    return [...this.commands.values()].filter((command) => command.status === "pending");
  }
}

class InMemoryRedeemRepository implements RedeemRepository {
  private records: RedeemRecord[] = [];

  async findRedeemCodeByCode() {
    return null;
  }

  async findRedeemCodeById() {
    return null;
  }

  async findPresentById() {
    return null;
  }

  async savePresent(_present: Present): Promise<void> {}

  async listPresents(): Promise<Present[]> {
    return [];
  }

  async saveRedeemCode(_code: RedeemCode): Promise<void> {}

  async listRedeemCodes(): Promise<RedeemCode[]> {
    return [];
  }

  async listRedeemRecords(): Promise<RedeemRecord[]> {
    return this.records;
  }

  async countRedeemCodeUses(codeId: string): Promise<number> {
    return this.records.filter((record) => record.codeId === codeId).length;
  }

  async hasPlayerRedeemedPresent(playerId: string, presentId: string): Promise<boolean> {
    return this.records.some((record) => record.playerId === playerId && record.presentId === presentId);
  }

  async saveRedeemRecord(record: RedeemRecord): Promise<void> {
    this.records.push(record);
  }
}

class InMemorySettlementRepository implements SettlementRepository {
  private settlements = new Map<string, SettlementRecord>();

  async saveSettlement(record: SettlementRecord): Promise<void> {
    this.settlements.set(record.settlement.sessionId, record);
  }

  async saveCheckout(
    _checkout: Parameters<SettlementRepository["saveCheckout"]>[0],
    records: readonly SettlementRecord[],
  ): Promise<void> {
    for (const record of records) await this.saveSettlement(record);
  }

  async findSettlementBySessionId(sessionId: string): Promise<SettlementRecord | null> {
    return this.settlements.get(sessionId) ?? null;
  }

  async listPastAppliedAdjustmentsByPlayerId(playerId: string): Promise<any[]> {
    return [];
  }
}

describe("storage ports", () => {
  it("keeps persistence as explicit repository contracts outside domain behavior", async () => {
    const sessions: SessionRepository = new InMemorySessionRepository();
    const assets: AssetRepository = new InMemoryAssetRepository();
    const commands: DeviceCommandRepository = new InMemoryDeviceCommandRepository();
    const redeems: RedeemRepository = new InMemoryRedeemRepository();
    const settlements: SettlementRepository = new InMemorySettlementRepository();

    await sessions.save({
      id: "session-1",
      playerId: "player-1",
      startedAt: new Date("2026-06-07T10:00:00.000Z"),
      status: "active",
    });
    await assets.commitAssetTransaction({
      transaction: {
        id: "asset-tx-1",
        playerId: "player-1",
        kind: "gift.redeem",
        refId: "code-1",
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        metadata: null,
      },
      holdingChanges: {
        upserts: [{
          id: "holding-1",
          assetType: "currency",
          assetCode: "paid",
          quantity: centsOf(100),
        }],
        deleteIds: [],
      },
      assetLedgerEntries: [{
        assetType: "currency",
        assetCode: "paid",
        delta: centsOf(100),
        reason: "gift.redeem",
        refId: "code-1",
      }],
    });
    await commands.enqueueDeviceCommand({
      id: "command-1",
      type: "coin",
      deviceId: "machine-1",
      targetKind: "game_machine",
      executorKind: "machine_ws",
      playerId: "player-1",
      status: "pending",
      requestedAt: new Date("2026-06-07T10:05:00.000Z"),
    });
    await redeems.saveRedeemRecord({
      playerId: "player-1",
      codeId: "code-1",
      presentId: "present-1",
      redeemedAt: new Date("2026-06-07T10:06:00.000Z"),
    });
    await settlements.saveSettlement({
      settlement: {
        sessionId: "session-1",
        subtotal: centsOf(20),
        total: centsOf(20),
        status: "settled",
        settledAt: new Date("2026-06-07T10:30:00.000Z"),
      },
      chargeItems: [
        {
          id: "charge-1",
          source: "time",
          label: "Time",
          amount: 20,
        },
      ],
      adjustments: [],
    });

    await expect(sessions.findActiveByPlayerId("player-1")).resolves.toEqual([
      {
        id: "session-1",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        status: "active",
      },
    ]);
    await expect(assets.listAssetHoldings("player-1")).resolves.toEqual([
      {
        id: "holding-1",
        assetType: "currency",
        assetCode: "paid",
        quantity: centsOf(100),
      },
    ]);
    await expect(assets.listLedgerEntriesByPlayerId("player-1")).resolves.toEqual([
      {
        assetType: "currency",
        assetCode: "paid",
        delta: centsOf(100),
        reason: "gift.redeem",
        refId: "code-1",
        transactionId: "asset-tx-1",
      },
    ]);
    await expect(commands.getDeviceCommand("command-1")).resolves.toEqual({
      id: "command-1",
      type: "coin",
      deviceId: "machine-1",
      targetKind: "game_machine",
      executorKind: "machine_ws",
      playerId: "player-1",
      status: "pending",
      requestedAt: new Date("2026-06-07T10:05:00.000Z"),
    });
    await expect(redeems.countRedeemCodeUses("code-1")).resolves.toBe(1);
    await expect(redeems.hasPlayerRedeemedPresent("player-1", "present-1")).resolves.toBe(true);
    await expect(settlements.findSettlementBySessionId("session-1")).resolves.toEqual({
      settlement: {
        sessionId: "session-1",
        subtotal: centsOf(20),
        total: centsOf(20),
        status: "settled",
        settledAt: new Date("2026-06-07T10:30:00.000Z"),
      },
      chargeItems: [
        {
          id: "charge-1",
          source: "time",
          label: "Time",
          amount: 20,
        },
      ],
      adjustments: [],
    });
  });
});
