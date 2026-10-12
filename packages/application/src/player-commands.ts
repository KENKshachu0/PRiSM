import type {
  DeviceCommand,
  DeviceCommandRepository,
  DeviceCommandType,
  DeviceReferenceTarget,
  PlayerIdentityRepository,
  PricingConfigRepository,
  Session,
  SessionRepository,
} from "@prism/core";
import { PrismDomainError, startSession } from "@prism/core";
import { createDeviceActionService, type DeviceActionServiceDependencies } from "./device-actions";

export type PlayerCommandServiceDependencies = {
  sessions: SessionRepository;
  deviceCommands: DeviceCommandRepository;
  pricingConfigs?: PricingConfigRepository;
  resolvePricingConfigs?: (playerId: string) => Promise<import("@prism/core").PricingConfig[]>;
  playerIdentities?: PlayerIdentityRepository;
  now: () => Date;
  id: () => string;
  coinCooldownMs: number;
  getCoinCooldownMs?: () => Promise<number>;
  resolveFacilityTarget?: DeviceActionServiceDependencies["resolveFacilityTarget"];
  resolveGameMachineTarget?: DeviceActionServiceDependencies["resolveGameMachineTarget"];
  canStartSessionAt?: (input: { playerId: string; at: Date }) => Promise<boolean>;
};

export type StartPlayerSessionCommand = {
  playerId: string;
  pricingConfigIds?: string[];
  label?: string;
  metadata?: Record<string, unknown>;
};

export type RequestPlayerDeviceCommand = {
  playerId: string;
  type: DeviceCommandType;
  target: DeviceReferenceTarget;
  payload?: Record<string, unknown>;
};

export type PlayerCommandService = {
  startSession(input: StartPlayerSessionCommand): Promise<Session & { status: "active" }>;
  requestDeviceCommand(input: RequestPlayerDeviceCommand): Promise<DeviceCommand>;
};

export function createPlayerCommandService(dependencies: PlayerCommandServiceDependencies): PlayerCommandService {
  const deviceActions = createDeviceActionService(dependencies);

  return {
    async startSession(input) {
      const now = dependencies.now();
      if (dependencies.canStartSessionAt && !(await dependencies.canStartSessionAt({ playerId: input.playerId, at: now }))) {
        throw new PrismDomainError(
          "Player cannot start a billing session outside billable business intervals.",
          "PLAYER_SESSION_OUTSIDE_BILLABLE_TIME",
        );
      }

      let pricingConfigIds = input.pricingConfigIds ?? [];
      const pinnedConfigs = await dependencies.resolvePricingConfigs?.(input.playerId);
      if (pricingConfigIds.length === 0 && dependencies.pricingConfigs) {
        const enabled = pinnedConfigs ?? await dependencies.pricingConfigs.listEnabled();
        pricingConfigIds = enabled.filter((c) => c.kind === "time.priority").map((c) => c.id);
      }
      if (pricingConfigIds.length === 0) {
        pricingConfigIds = ["default"];
      }
      if (pinnedConfigs?.length && pricingConfigIds.some(id => id !== "default" && !pinnedConfigs.some(config => config.id === id && config.kind !== "time.cap"))) {
        throw new PrismDomainError("当前入场版本不包含此计费方案，请先结账后重新入场", "PRICING_CONFIG_NOT_IN_RELEASE");
      }

      if (input.label) {
        const active = await dependencies.sessions.findActiveByPlayerId(input.playerId);
        const hasDuplicate = active.some((s) => s.label === input.label);
        if (hasDuplicate) {
          throw new PrismDomainError(
            `Player already has an active session with label '${input.label}'.`,
            "DUPLICATE_SESSION_LABEL",
          );
        }
      }

      const session = startSession({
        playerId: input.playerId,
        now,
        id: dependencies.id(),
        pricingConfigIds,
        label: input.label,
        metadata: input.metadata,
      });

      await dependencies.sessions.save(session);
      const saved = await dependencies.sessions.findById(session.id);
      return { ...session, pricingReleaseId: saved?.pricingReleaseId };
    },

    async requestDeviceCommand(input) {
      return deviceActions.requestDeviceAction({
        actor: {
          type: "player",
          playerId: input.playerId,
        },
        type: input.type,
        target: input.target,
        payload: input.payload,
      });
    },
  };
}
