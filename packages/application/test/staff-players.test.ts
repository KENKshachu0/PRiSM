import { describe, expect, it } from "bun:test";
import {
  AssetDefinitionRepository,
  AssetHolding,
  AssetLedgerEntry,
  AssetRepository,
  AssetTransaction,
  Present,
  Player,
  PlayerIdentity,
  PlayerIdentityRepository,
  PlayerRepository,
  PlayerStatus,
  centsOf,
  yuanOf,
} from "@prism/core";
import { createStaffPlayerService } from "../src/index";

class MemoryPlayerRepository implements PlayerRepository {
  saved: Player[] = [];
  statuses: Array<{ playerId: string; status: PlayerStatus }> = [];

  constructor(private readonly players: Player[] = []) {}

  async findById(playerId: string): Promise<Player | null> {
    return [...this.players, ...this.saved].find((player) => player.id === playerId) ?? null;
  }

  async listPlayers(): Promise<Player[]> {
    return [...this.players, ...this.saved];
  }

  async save(player: Player): Promise<void> {
    this.saved.push(player);
  }

  async updateStatus(playerId: string, status: PlayerStatus): Promise<void> {
    this.statuses.push({ playerId, status });
  }
}

class MemoryAssetRepository implements AssetRepository {
  savedHoldings: AssetHolding[][] = [];
  ledgerEntries: AssetLedgerEntry[] = [];
  assetTransactions: AssetTransaction[] = [];

  constructor(private readonly holdings: AssetHolding[] = []) {}

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

class MemoryPlayerIdentityRepository implements PlayerIdentityRepository {
  saved: PlayerIdentity[] = [];

  constructor(
    private readonly players: PlayerRepository,
    private readonly identities: PlayerIdentity[] = [],
  ) {}

  async save(identity: PlayerIdentity): Promise<void> {
    this.saved.push(identity);
  }

  async delete(playerId: string, provider: string, subject: string): Promise<void> {
    const remove = (items: PlayerIdentity[]) => {
      const index = items.findIndex(
        (identity) =>
          identity.playerId === playerId &&
          identity.provider === provider &&
          identity.subject === subject,
      );
      if (index >= 0) items.splice(index, 1);
    };
    remove(this.identities);
    remove(this.saved);
  }

  async findPlayerByIdentity(provider: string, subject: string): Promise<Player | null> {
    const identity = [...this.identities, ...this.saved].find(
      (candidate) => candidate.provider === provider && candidate.subject === subject,
    );
    return identity ? this.players.findById(identity.playerId) : null;
  }

  async listByPlayerId(playerId: string): Promise<PlayerIdentity[]> {
    return [...this.identities, ...this.saved].filter((identity) => identity.playerId === playerId);
  }
}

describe("createStaffPlayerService", () => {
  it("creates a player with active status", async () => {
    const players = new MemoryPlayerRepository();
    const service = createStaffPlayerService({
      players,
      id: () => "player-1",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    const player = await service.createPlayer({
      displayName: "Neri",
    });

    expect(player).toEqual({
      id: "player-1",
      displayName: "Neri",
      status: "active",
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
    });
    expect(players.saved).toEqual([player]);
  });

  it("grants register-time gift assets when staff creates a player", async () => {
    const players = new MemoryPlayerRepository();
    const assets = new MemoryAssetRepository();
    const ids = ["player-1", "holding-1"];
    const service = createStaffPlayerService({
      players,
      assets,
      id: () => ids.shift() ?? "extra-id",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    const player = await service.createPlayer({
      displayName: "Guest",
      initialGrants: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          amount: 80,
          mergeStrategy: "stack",
          activeAt: null,
          expiresAt: null,
        },
      ],
    });

    expect(player.id).toBe("player-1");
    expect(players.saved).toEqual([player]);
    expect(assets.savedHoldings).toEqual([
      [
        {
          id: "holding-1",
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: centsOf(80),
          activeAt: null,
          expiresAt: null,
        },
      ],
    ]);
    expect(assets.assetTransactions).toEqual([
      {
        id: "asset-tx:player.register.grant:player-1",
        playerId: "player-1",
        kind: "player.register.grant",
        refId: "player-1",
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        metadata: {
          grantCount: 1,
        },
      },
    ]);
    expect(assets.ledgerEntries).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.paid",
        delta: centsOf(80),
        reason: "player.register.grant",
        refId: "player-1",
        transactionId: "asset-tx:player.register.grant:player-1",
      },
    ]);
  });

  it("grants the configured present when a player is registered", async () => {
    const players = new MemoryPlayerRepository();
    const assets = new MemoryAssetRepository();
    const present = {
      id: "present-welcome",
      name: "新用户欢迎包",
      status: "active",
      oncePerPlayer: false,
      grants: [
        {
          assetType: "currency",
          assetCode: "paid",
          amount: 80,
          mergeStrategy: "stack",
          activeAt: null,
          expiresAt: null,
        },
      ],
    } satisfies Present;
    const assetDefinitions: AssetDefinitionRepository = {
      async save() {},
      async findByCode() {
        return null;
      },
      async listAll() {
        return [
          {
            type: "currency",
            code: "paid",
            name: "余额",
            stackable: true,
            status: "active",
            metadata: null,
          },
        ];
      },
    };
    const ids = ["player-1", "holding-1"];
    const service = createStaffPlayerService({
      players,
      assets,
      assetDefinitions,
      redeems: {
        async findPresentById() {
          return present;
        },
      },
      getDefaultRegistrationPresentId: async () => present.id,
      id: () => ids.shift() ?? "extra-id",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await service.createPlayer({ displayName: "Guest" });

    expect(assets.savedHoldings[0]).toEqual([
      {
        id: "holding-1",
        assetType: "currency",
        assetCode: "paid",
        quantity: centsOf(80),
        activeAt: null,
        expiresAt: null,
      },
    ]);
    expect(assets.assetTransactions[0]).toMatchObject({
      kind: "player.register.present",
      refId: "present-welcome",
      metadata: {
        presentId: "present-welcome",
        presentName: "新用户欢迎包",
        grantCount: 1,
      },
    });
    expect(assets.ledgerEntries[0]).toMatchObject({
      assetType: "currency",
      assetCode: "paid",
      delta: centsOf(80),
      reason: "player.register.present",
      refId: "present-welcome",
    });
  });

  it("updates player status for staff management", async () => {
    const players = new MemoryPlayerRepository([
      {
        id: "player-1",
        displayName: "Neri",
        status: "active",
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
      },
    ]);
    const service = createStaffPlayerService({
      players,
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await service.updatePlayerStatus({
      playerId: "player-1",
      status: "banned",
    });

    expect(players.statuses).toEqual([
      {
        playerId: "player-1",
        status: "banned",
      },
    ]);
  });

  it("binds and resolves external player identities", async () => {
    const players = new MemoryPlayerRepository([
      {
        id: "player-1",
        displayName: "Neri",
        status: "active",
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
      },
    ]);
    const playerIdentities = new MemoryPlayerIdentityRepository(players);
    const service = createStaffPlayerService({
      players,
      playerIdentities,
      id: () => "unused",
      now: () => new Date("2026-06-07T10:05:00.000Z"),
    });

    const identity = await service.bindPlayerIdentity({
      playerId: "player-1",
      provider: "qq",
      subject: "10001",
    });

    expect(identity).toEqual({
      playerId: "player-1",
      provider: "qq",
      subject: "10001",
      createdAt: new Date("2026-06-07T10:05:00.000Z"),
    });
    await expect(
      service.resolvePlayerIdentity({
        provider: "qq",
        subject: "10001",
      }),
    ).resolves.toEqual({
      id: "player-1",
      displayName: "Neri",
      status: "active",
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
    });

    await service.deletePlayerIdentity({
      playerId: "player-1",
      provider: "qq",
      subject: "10001",
    });
    await expect(
      service.resolvePlayerIdentity({
        provider: "qq",
        subject: "10001",
      }),
    ).resolves.toBeNull();
  });
});
