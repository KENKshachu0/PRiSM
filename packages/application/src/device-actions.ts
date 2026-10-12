import type {
  DeviceCommand,
  DeviceCommandActor,
  DeviceCommandRepository,
  DeviceCommandType,
  DeviceExecutorKind,
  DeviceReferenceTarget,
  DeviceTarget,
  PlayerIdentityRepository,
  Session,
  SessionRepository,
} from "@prism/core";
import { ackDeviceCommand, expireDeviceCommand, PrismDomainError, requestDeviceCommand } from "@prism/core";

export type DeviceActionExecutionInput = {
  command: DeviceCommand;
};

export type DeviceActionExecutionResult =
  | {
      status: "success";
      /** Transient data returned to the caller; it is not persisted in the command audit. */
      payload?: Record<string, unknown>;
    }
  | {
      status: "failed";
      message: string;
    };

export type DeviceActionExecutor = {
  execute(input: DeviceActionExecutionInput): Promise<DeviceActionExecutionResult>;
};

export type DeviceActionServiceDependencies = {
  sessions: SessionRepository;
  deviceCommands: DeviceCommandRepository;
  playerIdentities?: PlayerIdentityRepository;
  now: () => Date;
  id: () => string;
  coinCooldownMs: number;
  getCoinCooldownMs?: () => Promise<number>;
  resolveFacilityTarget?: (deviceRef: string, actionType?: DeviceCommandType) => Promise<{
    target: Extract<DeviceTarget, { kind: "facility" }>;
    deviceLabel: string;
    executor?: DeviceActionExecutor;
  }>;
  resolveGameMachineTarget?: (deviceRef: string) => Promise<{
    target: Extract<DeviceTarget, { kind: "game_machine" }>;
    deviceLabel: string;
    executor?: DeviceActionExecutor;
  }>;
  executors?: Partial<Record<DeviceExecutorKind, DeviceActionExecutor>>;
};

export type RequestDeviceActionInput = {
  actor: DeviceCommandActor;
  target: DeviceReferenceTarget;
  type: DeviceCommandType;
  payload?: Record<string, unknown>;
};

export type DeviceActionService = {
  requestDeviceAction(input: RequestDeviceActionInput): Promise<DeviceCommand>;
};

export function createDeviceActionService(dependencies: DeviceActionServiceDependencies): DeviceActionService {
  return {
    async requestDeviceAction(input) {
      let payload = input.payload;
      if (input.actor.type === "player" && input.type === "aime.scan") {
        payload = await resolvePlayerScanIdentity(
          dependencies.playerIdentities,
          input.actor.playerId,
          input.payload,
        );
      }

      const playerId = input.actor.type === "player" ? input.actor.playerId : null;
      const [activeSessions, previousCommands] = await Promise.all([
        playerId ? dependencies.sessions.findActiveByPlayerId(playerId) : Promise.resolve([]),
        playerId ? dependencies.deviceCommands.listByPlayerId(playerId) : Promise.resolve([]),
      ]);
      const coinCooldownMs =
        input.type === "coin" && dependencies.getCoinCooldownMs
          ? await dependencies.getCoinCooldownMs()
          : dependencies.coinCooldownMs;
      const resolvedTarget = await resolveDeviceTarget(input.target, dependencies, input.type);
      const command = requestDeviceCommand({
        actor: input.actor,
        command: {
          type: input.type,
          target: resolvedTarget.target,
          payload: resolvedTarget.deviceLabel
            ? {
                ...(payload ?? {}),
                deviceLabel: resolvedTarget.deviceLabel,
              }
            : payload,
        },
        activeSessions,
        previousCommands,
        coinCooldownMs,
        now: dependencies.now(),
        id: dependencies.id(),
      });

      const executor = resolvedTarget.executor ?? dependencies.executors?.[command.executorKind];
      if (!executor) {
        await dependencies.deviceCommands.enqueueDeviceCommand(command);
        await markActiveSessionsDeviceOperated(activeSessions, command, dependencies.sessions.save?.bind(dependencies.sessions));
        return command;
      }

      // Persist before dispatch: a transport failure must leave an auditable pending command.
      await dependencies.deviceCommands.enqueueDeviceCommand(withoutScanSubject(command));
      const result = await executor.execute({ command });
      let updated: DeviceCommand = result.status === "success"
        ? ackDeviceCommand({ command, now: dependencies.now() })
        : {
            ...expireDeviceCommand({ command, now: dependencies.now() }),
            payload: {
              ...(command.payload ?? {}),
              executorFailure: {
                executorKind: command.executorKind,
                message: result.message,
              },
            },
          };

      if (updated.executorKind === "hinata_io" && updated.type === "aime.scan") {
        updated = withoutScanSubject(updated);
      }

      await dependencies.deviceCommands.enqueueDeviceCommand(updated);
      if (updated.status === "acked") {
        await markActiveSessionsDeviceOperated(activeSessions, command, dependencies.sessions.save?.bind(dependencies.sessions));
      }
      if (result.status === "success" && result.payload) {
        return {
          ...updated,
          payload: {
            ...(updated.payload ?? {}),
            ...result.payload,
          },
        };
      }
      return updated;
    },
  };
}

function isDeviceOperationAction(command: { targetKind: string; type: string }): boolean {
  return command.type !== "door.open";
}

async function markActiveSessionsDeviceOperated(
  sessions: readonly Session[],
  command: DeviceCommand,
  saveSession?: (session: Session) => Promise<void>,
): Promise<void> {
  if (!saveSession || !isDeviceOperationAction(command)) return;
  for (const session of sessions) {
    if (!session.metadata?.deviceOperated) {
      session.metadata = {
        ...(session.metadata ?? {}),
        deviceOperated: true,
      };
      await saveSession({
        ...session,
        metadata: { ...session.metadata },
      });
    }
  }
}

function withoutScanSubject(command: DeviceCommand): DeviceCommand {
  if (!command.payload || !("subject" in command.payload)) return command;
  const { subject: _subject, ...payload } = command.payload;
  return { ...command, payload };
}

async function resolveDeviceTarget(
  target: DeviceReferenceTarget,
  dependencies: Pick<DeviceActionServiceDependencies, "resolveFacilityTarget" | "resolveGameMachineTarget">,
  actionType: DeviceCommandType,
): Promise<{ target: DeviceTarget; deviceLabel?: string; executor?: DeviceActionExecutor }> {
  if (target.kind === "facility") {
    return resolveFacilityTarget(target.ref, dependencies.resolveFacilityTarget, actionType);
  }
  if (typeof target.ref === "string") {
    if (!dependencies.resolveGameMachineTarget) {
      throw new PrismDomainError(
        "Game machine reference resolver is not configured.",
        "GAME_MACHINE_RESOLVER_NOT_CONFIGURED",
      );
    }
    return dependencies.resolveGameMachineTarget(target.ref);
  }
  return { target };
}

async function resolveFacilityTarget(
  deviceRef: string,
  resolver: DeviceActionServiceDependencies["resolveFacilityTarget"],
  actionType?: DeviceCommandType,
): Promise<{
  target: Extract<DeviceTarget, { kind: "facility" }>;
  deviceLabel: string;
  executor?: DeviceActionExecutor;
}> {
  if (!resolver) {
    throw new PrismDomainError(
      "Facility device reference resolver is not configured.",
      "FACILITY_DEVICE_RESOLVER_NOT_CONFIGURED",
    );
  }
  return resolver(deviceRef, actionType);
}

async function resolvePlayerScanIdentity(
  playerIdentities: PlayerIdentityRepository | undefined,
  playerId: string,
  payload: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  if (!playerIdentities) {
    throw new PrismDomainError("Player identity repository is required for Aime scan actions.", "PLAYER_IDENTITY_REPOSITORY_NOT_CONFIGURED");
  }

  const provider = typeof payload?.provider === "string" && payload.provider.trim()
    ? payload.provider.trim().toLowerCase()
    : "aime";
  const requestedSubject = typeof payload?.subject === "string" ? payload.subject.trim() : "";
  const identities = await playerIdentities.listByPlayerId(playerId);
  const identity = identities.find((candidate) =>
    candidate.provider.toLowerCase() === provider && (!requestedSubject || candidate.subject === requestedSubject));
  if (!identity) {
    throw new PrismDomainError("Scan identity is not bound to the player.", "SCAN_IDENTITY_NOT_BOUND_TO_PLAYER");
  }
  return {
    ...(payload ?? {}),
    provider: identity.provider,
    subject: identity.subject,
  };
}
