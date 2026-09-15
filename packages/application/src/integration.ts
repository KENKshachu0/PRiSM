import type {
  DeviceCommand,
  Cents,
  DeviceCommandType,
  DeviceReferenceTarget,
  ExternalIdentity,
  Player,
  PlayerIdentityRepository,
  PlayerRepository,
  Session,
  SessionRepository,
} from "@prism/core";
import {
  normalizeExternalIdentity,
  parseIdentityKey,
  PrismDomainError,
} from "@prism/core";
import type { PlayerCommandService, StartPlayerSessionCommand } from "./player-commands";
import type {
  PlayerCheckoutInput,
  SettlementService,
} from "./settlement";
import type { RedeemService } from "./redeem";
import type { DeviceActionService } from "./device-actions";
import type { StaffAssetService } from "./staff-assets";

export type IntegrationIdentityInput = {
  identity?: ExternalIdentity;
  identityKey?: string;
  autoRegister?: boolean;
  displayName?: string;
};

export type IntegrationStartSessionInput = IntegrationIdentityInput &
  Omit<StartPlayerSessionCommand, "playerId">;

export type IntegrationCheckoutInput = IntegrationIdentityInput &
  Omit<PlayerCheckoutInput, "playerId">;

export type IntegrationRedeemInput = IntegrationIdentityInput & {
  code: string;
};

export type IntegrationStopSessionInput = IntegrationIdentityInput & {
  sessionId: string;
};

export type IntegrationDeviceActionInput = IntegrationIdentityInput & {
  staffOverride?: boolean;
  target: DeviceReferenceTarget;
  action: {
    type: DeviceCommandType;
    payload?: Record<string, unknown>;
  };
};

export type IntegrationAssetAdjustmentInput = IntegrationIdentityInput & {
  adjustments: Parameters<StaffAssetService["adjustAssets"]>[0]["adjustments"];
};

export type IntegrationWalletAdjustmentInput = IntegrationIdentityInput & {
  amount: number;
  reason: string;
};

export type IntegrationCheckoutOverrideInput = IntegrationIdentityInput & {
  total: number;
  reason: string;
  /**
   * Same meaning as on `checkout`: when explicitly `false`, the balance is
   * verified before any session is written, so a failed override leaves the
   * session running instead of closing it as unpaid.
   */
  closeSessionsBeforeBalanceCheck?: boolean;
};

export type IntegrationPlayerSummary = {
  player: Pick<Player, "id" | "displayName" | "status">;
  wallet: Array<{
    assetCode: string;
    quantity: Cents;
  }>;
  activeSession: {
    id: string;
    startedAt: Date;
  } | null;
};

export type IntegrationPlayerQueries = {
  getPlayerSummary?(playerId: string): Promise<IntegrationPlayerSummary>;
  listPlayerAssets?(playerId: string): Promise<unknown>;
  listPlayerSessionHistory?(playerId: string): Promise<unknown>;
};

export type IntegrationServiceDependencies = {
  players: PlayerRepository;
  playerIdentities: PlayerIdentityRepository;
  registerPlayer?: (input: { displayName: string }) => Promise<Player>;
  sessions?: SessionRepository;
  playerCommands: PlayerCommandService;
  playerCheckoutCommands?: Pick<SettlementService, "previewCheckout" | "checkout" | "stopSession">;
  playerRedeemCommands?: RedeemService;
  deviceActions?: DeviceActionService;
  playerQueries?: IntegrationPlayerQueries;
  staffAssetCommands?: Pick<StaffAssetService, "adjustAssets" | "adjustWallet">;
  staffCheckoutCommands?: Pick<SettlementService, "checkoutWithOverride">;
  now: () => Date;
  id: () => string;
};

export type IntegrationService = {
  resolvePlayerByIdentity(input: IntegrationIdentityInput): Promise<Player>;
  resolveOrRegisterPlayerByIdentity(input: IntegrationIdentityInput): Promise<Player>;
  startSessionByIdentity(input: IntegrationStartSessionInput): Promise<Awaited<ReturnType<PlayerCommandService["startSession"]>>>;
  previewCheckoutByIdentity(input: IntegrationCheckoutInput): Promise<Awaited<ReturnType<SettlementService["previewCheckout"]>>>;
  confirmCheckoutByIdentity(input: IntegrationCheckoutInput): Promise<Awaited<ReturnType<SettlementService["checkout"]>>>;
  getWalletByIdentity(input: IntegrationIdentityInput): Promise<IntegrationPlayerSummary["wallet"]>;
  getAssetsByIdentity(input: IntegrationIdentityInput): Promise<unknown>;
  getHistoryByIdentity(input: IntegrationIdentityInput): Promise<unknown>;
  redeemByIdentity(input: IntegrationRedeemInput): Promise<Awaited<ReturnType<RedeemService["redeemCode"]>>>;
  stopSessionByIdentity(input: IntegrationStopSessionInput): Promise<Session & { status: "closed"; endedAt: Date }>;
  requestDeviceActionByIdentity(input: IntegrationDeviceActionInput): Promise<DeviceCommand>;
  adjustAssetsByIdentity(input: IntegrationAssetAdjustmentInput): ReturnType<StaffAssetService["adjustAssets"]>;
  adjustWalletByIdentity(input: IntegrationWalletAdjustmentInput): ReturnType<StaffAssetService["adjustWallet"]>;
  checkoutWithOverrideByIdentity(input: IntegrationCheckoutOverrideInput): ReturnType<SettlementService["checkoutWithOverride"]>;
};

export function createIntegrationService(dependencies: IntegrationServiceDependencies): IntegrationService {
  async function resolveOrRegister(input: IntegrationIdentityInput): Promise<Player> {
    const identity = identityFromInput(input);
    const existing = await dependencies.playerIdentities.findPlayerByIdentity(identity.provider, identity.subject);
    if (existing) {
      if (input.displayName && existing.displayName !== input.displayName) {
        existing.displayName = input.displayName;
        await dependencies.players.save(existing);
      }
      return existing;
    }

    if (!input.autoRegister) {
      throw new PrismDomainError("Player identity was not found.", "PLAYER_IDENTITY_NOT_FOUND");
    }

    const displayName = input.displayName?.trim() || `${identity.provider}:${identity.subject}`;
    const player = dependencies.registerPlayer
      ? await dependencies.registerPlayer({ displayName })
      : {
          id: dependencies.id(),
          displayName,
          status: "active" as const,
          createdAt: dependencies.now(),
        };
    if (!dependencies.registerPlayer) await dependencies.players.save(player);
    await dependencies.playerIdentities.save({
      playerId: player.id,
      provider: identity.provider,
      subject: identity.subject,
      createdAt: player.createdAt,
    });
    return player;
  }

  return {
    resolvePlayerByIdentity(input) {
      return resolveOrRegister({ ...input, autoRegister: false });
    },

    resolveOrRegisterPlayerByIdentity(input) {
      return resolveOrRegister(input);
    },

    async startSessionByIdentity(input) {
      const player = await resolveOrRegister(input);
      return dependencies.playerCommands.startSession({
        playerId: player.id,
        pricingConfigIds: input.pricingConfigIds,
        label: input.label,
        // Audit trail only: records that a Bot opened this session. It is deliberately
        // never used to authorise anything — see stopSessionByIdentity below.
        metadata: { createdBy: "integration" },
      });
    },

    async previewCheckoutByIdentity(input) {
      if (!dependencies.playerCheckoutCommands) {
        throw new PrismDomainError("Checkout commands are not configured.", "CHECKOUT_NOT_CONFIGURED");
      }
      const player = await resolveOrRegister(input);
      return dependencies.playerCheckoutCommands.previewCheckout({
        playerId: player.id,
      });
    },

    async confirmCheckoutByIdentity(input) {
      if (!dependencies.playerCheckoutCommands) {
        throw new PrismDomainError("Checkout commands are not configured.", "CHECKOUT_NOT_CONFIGURED");
      }
      const player = await resolveOrRegister(input);
      return dependencies.playerCheckoutCommands.checkout({
        playerId: player.id,
        closeSessionsBeforeBalanceCheck: input.closeSessionsBeforeBalanceCheck,
      });
    },

    async getWalletByIdentity(input) {
      if (!dependencies.playerQueries?.getPlayerSummary) {
        throw new PrismDomainError("Player wallet queries are not configured.", "PLAYER_WALLET_NOT_CONFIGURED");
      }
      const player = await resolveOrRegister(input);
      const summary = await dependencies.playerQueries.getPlayerSummary(player.id);
      return summary.wallet;
    },

    async getAssetsByIdentity(input) {
      if (!dependencies.playerQueries?.listPlayerAssets) {
        throw new PrismDomainError("Player asset queries are not configured.", "PLAYER_ASSETS_NOT_CONFIGURED");
      }
      const player = await resolveOrRegister(input);
      return dependencies.playerQueries.listPlayerAssets(player.id);
    },

    async getHistoryByIdentity(input) {
      if (!dependencies.playerQueries?.listPlayerSessionHistory) {
        throw new PrismDomainError("Player history queries are not configured.", "PLAYER_HISTORY_NOT_CONFIGURED");
      }
      const player = await resolveOrRegister(input);
      return dependencies.playerQueries.listPlayerSessionHistory(player.id);
    },

    async redeemByIdentity(input) {
      if (!dependencies.playerRedeemCommands) {
        throw new PrismDomainError("Redeem commands are not configured.", "REDEEM_NOT_CONFIGURED");
      }
      const player = await resolveOrRegister(input);
      return dependencies.playerRedeemCommands.redeemCode({
        playerId: player.id,
        code: input.code,
      });
    },

    async stopSessionByIdentity(input) {
      if (!dependencies.sessions || !dependencies.playerCheckoutCommands?.stopSession) {
        throw new PrismDomainError("Integration stop session is not configured.", "INTEGRATION_STOP_NOT_CONFIGURED");
      }
      const player = await resolveOrRegister(input);
      const session = await dependencies.sessions.findById(input.sessionId);
      if (!session || session.playerId !== player.id || session.status !== "active") {
        throw new PrismDomainError("Integration session was not found.", "INTEGRATION_SESSION_NOT_FOUND");
      }
      // Scope is the player, not the channel that opened the session. A Bot acting for
      // a player may end any of that player's running sessions, including ones staff
      // opened for them, the same way checkout has always worked. Do not reintroduce a
      // check on `metadata.createdBy`: it only describes who opened the session.
      return dependencies.playerCheckoutCommands.stopSession({
        playerId: player.id,
        sessionId: input.sessionId,
      });
    },

    async requestDeviceActionByIdentity(input) {
      if (!dependencies.deviceActions) {
        throw new PrismDomainError("Integration device actions are not configured.", "INTEGRATION_DEVICE_ACTIONS_NOT_CONFIGURED");
      }
      if (input.staffOverride) {
        if (input.action.type !== "power.on" && input.action.type !== "power.off") {
          throw new PrismDomainError(
            "Integration staff override only supports power actions.",
            "INTEGRATION_STAFF_OVERRIDE_ACTION_NOT_ALLOWED",
          );
        }
        const identity = identityFromInput(input);
        return dependencies.deviceActions.requestDeviceAction({
          actor: {
            type: "staff",
            staffId: `integration:${identity.provider}:${identity.subject}`,
          },
          target: input.target,
          type: input.action.type,
          payload: input.action.payload,
        });
      }
      const player = await resolveOrRegister(input);
      return dependencies.deviceActions.requestDeviceAction({
        actor: {
          type: "player",
          playerId: player.id,
        },
        target: input.target,
        type: input.action.type,
        payload: input.action.payload,
      });
    },

    async adjustAssetsByIdentity(input) {
      if (!dependencies.staffAssetCommands) {
        throw new PrismDomainError("Integration asset commands are not configured.", "INTEGRATION_ASSET_COMMANDS_NOT_CONFIGURED");
      }
      const player = await resolveOrRegister(input);
      return dependencies.staffAssetCommands.adjustAssets({
        staffId: "integration",
        playerId: player.id,
        adjustments: input.adjustments,
      });
    },

    async adjustWalletByIdentity(input) {
      if (!dependencies.staffAssetCommands) {
        throw new PrismDomainError("Integration asset commands are not configured.", "INTEGRATION_ASSET_COMMANDS_NOT_CONFIGURED");
      }
      const player = await resolveOrRegister(input);
      return dependencies.staffAssetCommands.adjustWallet({
        staffId: "integration",
        playerId: player.id,
        amount: input.amount,
        reason: input.reason,
      });
    },

    async checkoutWithOverrideByIdentity(input) {
      if (!dependencies.staffCheckoutCommands) {
        throw new PrismDomainError("Integration checkout override is not configured.", "INTEGRATION_CHECKOUT_OVERRIDE_NOT_CONFIGURED");
      }
      const player = await resolveOrRegister(input);
      return dependencies.staffCheckoutCommands.checkoutWithOverride({
        staffId: "integration",
        playerId: player.id,
        total: input.total,
        reason: input.reason,
        closeSessionsBeforeBalanceCheck: input.closeSessionsBeforeBalanceCheck,
      });
    },
  };
}

function identityFromInput(input: IntegrationIdentityInput): ExternalIdentity {
  if (input.identity) return normalizeExternalIdentity(input.identity);
  if (typeof input.identityKey === "string") return parseIdentityKey(input.identityKey);
  throw new PrismDomainError(
    "External identity must include provider and subject.",
    "INVALID_EXTERNAL_IDENTITY",
  );
}
