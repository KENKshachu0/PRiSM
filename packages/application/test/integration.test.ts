import { centsOf as moneyFixture, centsOfInteger as integerFixture } from "@prism/core";
import { describe, expect, it } from "bun:test";
import {
  AssetHolding,
  Player,
  PlayerIdentity,
  PlayerIdentityRepository,
  PlayerRepository,
  Session,
  SessionRepository,
  centsOf,
  yuanOf,
} from "@prism/core";
import { PrismDomainError } from "@prism/core";
import { createIntegrationService, type DeviceActionService, type RequestDeviceActionInput } from "../src/index";

class MemoryPlayerRepository implements PlayerRepository {
  saved: Player[] = [];

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

  async updateStatus(): Promise<void> {}
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

  async delete(): Promise<void> {}

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

class MemorySessionRepository implements SessionRepository {
  saved: Session[] = [];

  constructor(initial: Session[] = []) {
    this.saved.push(...initial);
  }

  async findActiveByPlayerId(playerId: string): Promise<Session[]> {
    return this.saved.filter((session) => session.playerId === playerId && session.status === "active");
  }

  async findById(sessionId: string): Promise<Session | null> {
    return this.saved.find((session) => session.id === sessionId) ?? null;
  }

  async findUnpaidClosedByPlayerId(playerId: string): Promise<Session[]> {
    return this.saved.filter(
      (session) => session.playerId === playerId && session.status === "closed" && session.paymentStatus === "unpaid",
    );
  }

  async save(session: Session): Promise<void> {
    this.saved = this.saved.filter((candidate) => candidate.id !== session.id);
    this.saved.push(session);
  }
}

/** Records what the integration service asks of devices; device rules are the server's. */
function recordingDeviceActions(id = "command-1") {
  const calls: RequestDeviceActionInput[] = [];
  const service: DeviceActionService = {
    async requestDeviceAction(input) {
      calls.push(input);
      return {
        id,
        type: input.type,
        deviceId: input.target.id ?? input.target.ref ?? null,
        targetKind: input.target.kind,
        executorKind: input.target.kind === "facility" ? "home_assistant" : "hinata_io",
        playerId: input.actor.type === "player" ? input.actor.playerId : undefined,
        staffId: input.actor.type === "staff" ? input.actor.staffId : undefined,
        status: "acked",
        payload: input.payload,
        requestedAt: new Date("2026-07-07T10:30:00.000Z"),
      };
    },
  };
  return { service, calls };
}

describe("createIntegrationService", () => {
  it("resolves an existing identity and starts a session through player commands", async () => {
    const player = {
      id: "player-1",
      displayName: "A",
      status: "active",
      createdAt: new Date("2026-07-07T10:00:00.000Z"),
    } satisfies Player;
    const players = new MemoryPlayerRepository([player]);
    const identities = new MemoryPlayerIdentityRepository(players, [
      {
        playerId: "player-1",
        provider: "qq",
        subject: "123456",
        createdAt: new Date("2026-07-07T10:00:00.000Z"),
      },
    ]);
    const starts: Array<{
      playerId: string;
      pricingConfigIds?: string[];
      label?: string;
      metadata?: Record<string, unknown>;
    }> = [];
    const service = createIntegrationService({
      players,
      playerIdentities: identities,
      playerCommands: {
        async startSession(input) {
          starts.push(input);
          return {
            id: "session-1",
            playerId: input.playerId,
            startedAt: new Date("2026-07-07T10:30:00.000Z"),
            status: "active",
            pricingConfigIds: input.pricingConfigIds,
            paymentStatus: "unpaid",
            label: input.label,
          } satisfies Session & { status: "active" };
        },
      },
      now: () => new Date("2026-07-07T10:30:00.000Z"),
      id: () => "unused",
    });

    const session = await service.startSessionByIdentity({
      identityKey: "QQ:123456",
      pricingConfigIds: ["music"],
      label: "音游区间",
    });

    expect(session.id).toBe("session-1");
    expect(starts).toEqual([
      {
        playerId: "player-1",
        pricingConfigIds: ["music"],
        label: "音游区间",
        metadata: { createdBy: "integration" },
      },
    ]);
  });

  it("auto-registers a missing identity before starting a session", async () => {
    const players = new MemoryPlayerRepository();
    const identities = new MemoryPlayerIdentityRepository(players);
    const registeredNames: string[] = [];
    const service = createIntegrationService({
      players,
      playerIdentities: identities,
      registerPlayer: async ({ displayName }) => {
        registeredNames.push(displayName);
        const player = {
          id: "player-new",
          displayName,
          status: "active",
          createdAt: new Date("2026-07-07T11:00:00.000Z"),
        } satisfies Player;
        await players.save(player);
        return player;
      },
      playerCommands: {
        async startSession(input) {
          return {
            id: "session-1",
            playerId: input.playerId,
            startedAt: new Date("2026-07-07T11:00:00.000Z"),
            status: "active",
            pricingConfigIds: input.pricingConfigIds,
            paymentStatus: "unpaid",
          } satisfies Session & { status: "active" };
        },
      },
      now: () => new Date("2026-07-07T11:00:00.000Z"),
      id: () => "player-new",
    });

    const session = await service.startSessionByIdentity({
      identity: { provider: "QQ", subject: " 8888 " },
      autoRegister: true,
      displayName: "QQ 8888",
      pricingConfigIds: ["music"],
    });

    expect(session.playerId).toBe("player-new");
    expect(registeredNames).toEqual(["QQ 8888"]);
    expect(players.saved).toEqual([
      {
        id: "player-new",
        displayName: "QQ 8888",
        status: "active",
        createdAt: new Date("2026-07-07T11:00:00.000Z"),
      },
    ]);
    expect(identities.saved).toEqual([
      {
        playerId: "player-new",
        provider: "qq",
        subject: "8888",
        createdAt: new Date("2026-07-07T11:00:00.000Z"),
      },
    ]);
  });

  it("marks integration-started sessions so they can later be stopped by identity", async () => {
    const player = {
      id: "player-1",
      displayName: "A",
      status: "active",
      createdAt: new Date("2026-07-07T10:00:00.000Z"),
    } satisfies Player;
    const players = new MemoryPlayerRepository([player]);
    const identities = new MemoryPlayerIdentityRepository(players, [
      {
        playerId: "player-1",
        provider: "qq",
        subject: "123456",
        createdAt: new Date("2026-07-07T10:00:00.000Z"),
      },
    ]);
    const starts: Array<{ playerId: string; pricingConfigIds?: string[]; label?: string; metadata?: Record<string, unknown> }> = [];
    const service = createIntegrationService({
      players,
      playerIdentities: identities,
      playerCommands: {
        async startSession(input) {
          starts.push(input);
          return {
            id: "session-1",
            playerId: input.playerId,
            startedAt: new Date("2026-07-07T10:30:00.000Z"),
            status: "active",
            pricingConfigIds: input.pricingConfigIds,
            paymentStatus: "unpaid",
            label: input.label,
            metadata: input.metadata,
          } satisfies Session & { status: "active" };
        },
      },
      now: () => new Date("2026-07-07T10:30:00.000Z"),
      id: () => "unused",
    });

    await service.startSessionByIdentity({
      identityKey: "qq:123456",
      pricingConfigIds: ["mahjong-a"],
      label: "麻将桌 a",
    });

    expect(starts).toEqual([
      {
        playerId: "player-1",
        pricingConfigIds: ["mahjong-a"],
        label: "麻将桌 a",
        metadata: { createdBy: "integration" },
      },
    ]);
  });

  it("requests game machine actions by identity after backend session checks pass", async () => {
    const player = {
      id: "player-1",
      displayName: "A",
      status: "active",
      createdAt: new Date("2026-07-07T10:00:00.000Z"),
    } satisfies Player;
    const players = new MemoryPlayerRepository([player]);
    const identities = new MemoryPlayerIdentityRepository(players, [
      {
        playerId: "player-1",
        provider: "qq",
        subject: "123456",
        createdAt: new Date("2026-07-07T10:00:00.000Z"),
      },
    ]);
    const sessions = new MemorySessionRepository([
      {
        id: "session-1",
        playerId: "player-1",
        startedAt: new Date("2026-07-07T10:00:00.000Z"),
        status: "active",
        pricingConfigIds: ["music"],
        paymentStatus: "unpaid",
      },
    ]);
    const devices = recordingDeviceActions();
    const service = createIntegrationService({
      players,
      playerIdentities: identities,
      sessions,
      playerCommands: {
        async startSession() {
          throw new Error("not used");
        },
      },
      deviceActions: devices.service,
      now: () => new Date("2026-07-07T10:30:00.000Z"),
      id: () => "unused",
    });

    const action = await service.requestDeviceActionByIdentity({
      identity: {
        provider: "qq",
        subject: "123456",
      },
      target: {
        kind: "game_machine",
        id: "maimai-dx-1",
      },
      action: {
        type: "coin",
        payload: {
          count: 1,
        },
      },
    });

    expect(action).toMatchObject({ id: "command-1", playerId: "player-1", type: "coin" });
    expect(devices.calls).toEqual([{
      actor: { type: "player", playerId: "player-1" },
      target: { kind: "game_machine", id: "maimai-dx-1" },
      type: "coin",
      payload: { count: 1 },
    }]);
  });

  it("allows trusted integration power actions to use a staff override", async () => {
    const players = new MemoryPlayerRepository();
    const identities = new MemoryPlayerIdentityRepository(players);
    const sessions = new MemorySessionRepository();
    const devices = recordingDeviceActions();
    const service = createIntegrationService({
      players,
      playerIdentities: identities,
      sessions,
      playerCommands: {
        async startSession() {
          throw new Error("not used");
        },
      },
      deviceActions: devices.service,
      now: () => new Date("2026-07-07T10:30:00.000Z"),
      id: () => "unused",
    });

    const action = await service.requestDeviceActionByIdentity({
      identity: { provider: "qq", subject: "admin-1" },
      staffOverride: true,
      target: { kind: "facility", ref: "舞萌一号机" },
      action: { type: "power.off" },
    });

    expect(action).toMatchObject({ type: "power.off", staffId: "integration:qq:admin-1" });
    expect(devices.calls[0]?.target).toEqual({ kind: "facility", ref: "舞萌一号机" });
    expect(players.saved).toEqual([]);
  });

  it("limits integration staff override to power actions", async () => {
    const players = new MemoryPlayerRepository();
    const identities = new MemoryPlayerIdentityRepository(players);
    const devices = recordingDeviceActions();
    const service = createIntegrationService({
      players,
      playerIdentities: identities,
      playerCommands: {
        async startSession() {
          throw new Error("not used");
        },
      },
      deviceActions: devices.service,
      now: () => new Date("2026-07-07T10:30:00.000Z"),
      id: () => "unused",
    });

    await expect(service.requestDeviceActionByIdentity({
      identityKey: "qq:admin-1",
      staffOverride: true,
      target: { kind: "game_machine", id: "maimai-dx-1" },
      action: { type: "coin" },
    })).rejects.toMatchObject({
      code: "INTEGRATION_STAFF_OVERRIDE_ACTION_NOT_ALLOWED",
    });
  });

  it("does not auto-register unknown identities for integration machine actions by default", async () => {
    const players = new MemoryPlayerRepository();
    const identities = new MemoryPlayerIdentityRepository(players);
    const sessions = new MemorySessionRepository();
    const devices = recordingDeviceActions();
    const service = createIntegrationService({
      players,
      playerIdentities: identities,
      sessions,
      playerCommands: {
        async startSession() {
          throw new Error("not used");
        },
      },
      deviceActions: devices.service,
      now: () => new Date("2026-07-07T10:30:00.000Z"),
      id: () => "player-new",
    });

    await expect(
      service.requestDeviceActionByIdentity({
        identityKey: "qq:missing",
        target: {
          kind: "game_machine",
          id: "maimai-dx-1",
        },
        action: {
          type: "coin",
        },
      }),
    ).rejects.toMatchObject({
      code: "PLAYER_IDENTITY_NOT_FOUND",
    });
  });

  it("returns player wallet, assets, history, checkout, and redeem by identity through existing services", async () => {
    const player = {
      id: "player-1",
      displayName: "A",
      status: "active",
      createdAt: new Date("2026-07-07T10:00:00.000Z"),
    } satisfies Player;
    const players = new MemoryPlayerRepository([player]);
    const identities = new MemoryPlayerIdentityRepository(players, [
      {
        playerId: "player-1",
        provider: "qq",
        subject: "123456",
        createdAt: new Date("2026-07-07T10:00:00.000Z"),
      },
    ]);
    const calls: string[] = [];
    const holding = {
      id: "holding-1",
      assetType: "currency",
      assetCode: "currency.paid",
      quantity: centsOf(120),
    } satisfies AssetHolding;
    const service = createIntegrationService({
      players,
      playerIdentities: identities,
      playerCommands: {
        async startSession() {
          throw new Error("not used");
        },
      },
      playerCheckoutCommands: {
        async previewCheckout(input) {
          calls.push(`preview:${input.playerId}`);
          return {
            settlementPreview: {
              playerId: input.playerId,
              sessionIds: ["session-1"],
              subtotal: centsOf(30),
              total: centsOf(30),
              status: "preview",
              previewedAt: new Date("2026-07-07T12:00:00.000Z"),
            },
            sessionPreviews: [
              {
                sessionId: "session-1",
                label: "Time",
                startedAt: new Date("2026-07-07T11:00:00.000Z"),
                endedAt: new Date("2026-07-07T12:00:00.000Z"),
                status: "closed",
                subtotal: centsOf(30),
                total: centsOf(30),
                chargeItems: [],
                adjustments: [],
              },
            ],
            chargeItems: [],
            adjustments: [],
            checkoutAdjustments: [],
            pricingCapAdjustments: [],
            wallet: { balanceBefore: centsOf(120), balanceAfter: centsOf(90) },
            globalCapWindows: [],
          };
        },
        async checkout(input) {
          calls.push(`checkout:${input.playerId}`);
          return {
            playerSettlement: {
              playerId: input.playerId,
              sessionIds: ["session-1"],
              subtotal: centsOf(30),
              total: centsOf(30),
              status: "settled",
              settledAt: new Date("2026-07-07T12:00:00.000Z"),
            },
            settlements: [
              {
                settlement: {
                  sessionId: "session-1",
                  subtotal: centsOf(30),
                  total: centsOf(30),
                  status: "settled",
                  settledAt: new Date("2026-07-07T12:00:00.000Z"),
                },
                chargeItems: [],
                adjustments: [],
              },
            ],
            sessionDetails: [
              {
                sessionId: "session-1",
                label: "Time",
                startedAt: new Date("2026-07-07T11:00:00.000Z"),
                endedAt: new Date("2026-07-07T12:00:00.000Z"),
              },
            ],
            chargeItems: [],
            adjustments: [],
            checkoutAdjustments: [],
            pricingCapAdjustments: [],
            assetLedgerEntries: [],
            wallet: { balanceBefore: centsOf(120), balanceAfter: centsOf(90) },
            globalCapWindows: [],
          };
        },
        async stopSession() {
          throw new Error("not used");
        },
      },
      playerRedeemCommands: {
        async redeemCode(input) {
          calls.push(`redeem:${input.playerId}:${input.code}`);
          return {
            holdings: [holding],
            assetLedgerEntries: [],
            availableHoldings: [],
            grantedAssets: [],
            redeemRecord: {
              playerId: input.playerId,
              codeId: "code-1",
              presentId: "present-1",
              redeemedAt: new Date("2026-07-07T12:00:00.000Z"),
            },
          };
        },
      },
      playerQueries: {
        async getPlayerSummary(playerId) {
          calls.push(`summary:${playerId}`);
          return {
            player,
            wallet: [{ assetCode: "currency.paid", quantity: centsOf(120) }],
            activeSession: null,
          };
        },
        async listPlayerAssets(playerId) {
          calls.push(`assets:${playerId}`);
          return { holdings: [], ledgerEntries: [] };
        },
        async listPlayerSessionHistory(playerId) {
          calls.push(`history:${playerId}`);
          return [];
        },
      },
      now: () => new Date("2026-07-07T12:00:00.000Z"),
      id: () => "unused",
    });

    await expect(service.getWalletByIdentity({ identityKey: "qq:123456" })).resolves.toEqual([
      {
        assetCode: "currency.paid",
        quantity: centsOf(120),
      },
    ]);
    await expect(service.getAssetsByIdentity({ identityKey: "qq:123456" })).resolves.toEqual({
      holdings: [],
      ledgerEntries: [],
    });
    await expect(service.getHistoryByIdentity({ identityKey: "qq:123456" })).resolves.toEqual([]);
    await expect(service.previewCheckoutByIdentity({ identityKey: "qq:123456" })).resolves.toMatchObject({
      settlementPreview: { total: moneyFixture(30) },
    });
    await expect(service.confirmCheckoutByIdentity({ identityKey: "qq:123456" })).resolves.toMatchObject({
      playerSettlement: { total: moneyFixture(30) },
    });
    await expect(service.redeemByIdentity({ identityKey: "qq:123456", code: "GIFT" })).resolves.toMatchObject({
      redeemRecord: { playerId: "player-1" },
    });
    expect(calls).toEqual([
      "summary:player-1",
      "assets:player-1",
      "history:player-1",
      "preview:player-1",
      "checkout:player-1",
      "redeem:player-1:GIFT",
    ]);
  });

  it("rejects missing identity when autoRegister is false", async () => {
    const players = new MemoryPlayerRepository();
    const service = createIntegrationService({
      players,
      playerIdentities: new MemoryPlayerIdentityRepository(players),
      playerCommands: {
        async startSession() {
          throw new Error("not used");
        },
      },
      now: () => new Date("2026-07-07T12:00:00.000Z"),
      id: () => "unused",
    });

    await expect(
      service.resolvePlayerByIdentity({
        identityKey: "qq:missing",
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        name: "PrismDomainError",
        code: "PLAYER_IDENTITY_NOT_FOUND",
      }) as PrismDomainError,
    );
  });

  it("stops an active integration-created session without settling it", async () => {
    const player = {
      id: "player-1",
      displayName: "A",
      status: "active",
      createdAt: new Date("2026-07-07T10:00:00.000Z"),
    } satisfies Player;
    const session = {
      id: "session-1",
      playerId: "player-1",
      startedAt: new Date("2026-07-07T10:00:00.000Z"),
      status: "active",
      pricingConfigIds: ["mahjong-a"],
      paymentStatus: "unpaid",
      label: "麻将桌 a",
      metadata: { createdBy: "integration" },
    } satisfies Session;
    const players = new MemoryPlayerRepository([player]);
    const identities = new MemoryPlayerIdentityRepository(players, [
      {
        playerId: "player-1",
        provider: "qq",
        subject: "123456",
        createdAt: new Date("2026-07-07T10:00:00.000Z"),
      },
    ]);
    const sessions = new MemorySessionRepository([session]);
    const service = createIntegrationService({
      players,
      playerIdentities: identities,
      sessions,
      playerCommands: {
        async startSession() {
          throw new Error("not used");
        },
      },
      playerCheckoutCommands: {
        async previewCheckout() {
          throw new Error("not used");
        },
        async checkout() {
          throw new Error("not used");
        },
        async stopSession(input) {
          const existing = await sessions.findById(input.sessionId);
          if (!existing) throw new Error("missing session");
          const closed = {
            ...existing,
            status: "closed" as const,
            endedAt: new Date("2026-07-07T10:30:00.000Z"),
            paymentStatus: "unpaid" as const,
          };
          await sessions.save(closed);
          return closed;
        },
      },
      now: () => new Date("2026-07-07T10:30:00.000Z"),
      id: () => "unused",
    });

    const stopped = await service.stopSessionByIdentity({
      identityKey: "qq:123456",
      sessionId: "session-1",
    });

    expect(stopped).toMatchObject({
      id: "session-1",
      playerId: "player-1",
      status: "closed",
      paymentStatus: "unpaid",
    });
    expect(sessions.saved).toContainEqual(stopped);
  });

  it("stops the referenced player's session whichever channel opened it, but never another player's", async () => {
    const player = {
      id: "player-1",
      displayName: "A",
      status: "active",
      createdAt: new Date("2026-07-07T10:00:00.000Z"),
    } satisfies Player;
    const players = new MemoryPlayerRepository([player]);
    const identities = new MemoryPlayerIdentityRepository(players, [
      {
        playerId: "player-1",
        provider: "qq",
        subject: "123456",
        createdAt: new Date("2026-07-07T10:00:00.000Z"),
      },
    ]);
    const sessions = new MemorySessionRepository([
      {
        id: "other-player-session",
        playerId: "player-2",
        startedAt: new Date("2026-07-07T10:00:00.000Z"),
        status: "active",
        pricingConfigIds: ["mahjong-a"],
        paymentStatus: "unpaid",
        metadata: { createdBy: "integration" },
      },
      {
        id: "staff-created-session",
        playerId: "player-1",
        startedAt: new Date("2026-07-07T10:00:00.000Z"),
        status: "active",
        pricingConfigIds: ["music"],
        paymentStatus: "unpaid",
      },
    ]);
    const stopped: Array<{ playerId: string; sessionId: string }> = [];
    const service = createIntegrationService({
      players,
      playerIdentities: identities,
      sessions,
      playerCommands: {
        async startSession() {
          throw new Error("not used");
        },
      },
      playerCheckoutCommands: {
        async previewCheckout() {
          throw new Error("not used");
        },
        async checkout() {
          throw new Error("not used");
        },
        async stopSession(input: { playerId: string; sessionId: string }) {
          stopped.push(input);
          return {
            id: input.sessionId,
            playerId: input.playerId,
            startedAt: new Date("2026-07-07T10:00:00.000Z"),
            endedAt: new Date("2026-07-07T10:30:00.000Z"),
            status: "closed" as const,
            pricingConfigIds: ["music"],
            paymentStatus: "unpaid" as const,
          };
        },
      },
      now: () => new Date("2026-07-07T10:30:00.000Z"),
      id: () => "unused",
    });

    await expect(
      service.stopSessionByIdentity({ identityKey: "qq:123456", sessionId: "other-player-session" }),
    ).rejects.toMatchObject({ code: "INTEGRATION_SESSION_NOT_FOUND" });

    // Which channel opened a session is not an authorisation boundary here — only who
    // the session belongs to is. A staff-opened session for the same player is stoppable.
    const result = await service.stopSessionByIdentity({
      identityKey: "qq:123456",
      sessionId: "staff-created-session",
    });
    expect(result.status).toBe("closed");
    expect(stopped).toEqual([{ playerId: "player-1", sessionId: "staff-created-session" }]);
  });

  it("updates player display name when identity is resolved with a different displayName", async () => {
    const player = {
      id: "player-1",
      displayName: "Old Name",
      status: "active",
      createdAt: new Date("2026-07-07T10:00:00.000Z"),
    } satisfies Player;
    const players = new MemoryPlayerRepository([player]);
    const identities = new MemoryPlayerIdentityRepository(players, [
      {
        playerId: "player-1",
        provider: "qq",
        subject: "123456",
        createdAt: new Date("2026-07-07T10:00:00.000Z"),
      },
    ]);
    const service = createIntegrationService({
      players,
      playerIdentities: identities,
      playerCommands: {
        async startSession() {
          throw new Error("not used");
        },
      },
      now: () => new Date("2026-07-07T10:30:00.000Z"),
      id: () => "unused",
    });

    const resolved = await service.resolvePlayerByIdentity({
      identityKey: "qq:123456",
      displayName: "New Platform Nickname",
    });

    // Check that returned player has new name
    expect(resolved.displayName).toBe("New Platform Nickname");
    // Check that player was saved to the player repository with the new name
    const savedPlayer = players.saved.find((p) => p.id === "player-1");
    expect(savedPlayer).toBeDefined();
    expect(savedPlayer!.displayName).toBe("New Platform Nickname");
  });
});
