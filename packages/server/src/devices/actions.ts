/**
 * Device actions requested by the Bot, by staff, and by players through the
 * integration API. Implements the `DeviceActionService` port those callers
 * already depend on, but resolves devices through the capability catalog and
 * performs every action on the device bus.
 *
 * The response stays in the old `DeviceCommand` shape: the Bot reads
 * `status`, `executorKind` and `payload.executorFailure` / `deviceLabel` /
 * `temporaryPassword`, and the staff view serializers are frozen by CI.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import type { DeviceActionService, RequestDeviceActionInput } from "@prism/application";
import {
  operatedWithin,
  operationToLegacyCommand,
  PrismDomainError,
  type DeviceCommand,
  type DeviceEventActor,
  type DeviceEventRepository,
  type PlayerIdentityRepository,
  type SessionRepository,
} from "@prism/core";
import type { Env } from "../bindings.js";
import { actionSpec, capabilityForAction, isActionName, type ActionName } from "./capabilities.js";
import { can, loadDevices, matchesRef, type Device } from "./device.js";
import { createRuntimeBus } from "./runtime.js";

export type DeviceActionDependencies = {
  db: D1DatabaseLike;
  env: Env;
  shopId: string;
  sessions: SessionRepository;
  deviceEvents: DeviceEventRepository;
  playerIdentities: PlayerIdentityRepository;
  coinCooldownMs: () => Promise<number>;
  now: () => Date;
  id: () => string;
  fetcher?: typeof fetch;
};

function actorOf(input: RequestDeviceActionInput): DeviceEventActor {
  return input.actor.type === "player"
    ? { type: "player", playerId: input.actor.playerId }
    : { type: "staff", staffId: input.actor.staffId };
}

/** Find the devices a reference names. `all` is only valid for power. */
function resolveTargets(devices: Device[], input: RequestDeviceActionInput, action: ActionName): Device[] {
  const target = input.target as { kind: string; ref?: string; id?: string };
  if (target.ref?.trim().toLowerCase() === "all") {
    if (action !== "power.on" && action !== "power.off") {
      throw new PrismDomainError("All-device targets only support power actions.", "DEVICE_ACTION_TARGET_MISMATCH");
    }
    const all = devices.filter((device) => device.enabled && can(device, action));
    if (!all.length) throw new PrismDomainError("Device was not found.", "DEVICE_NOT_FOUND");
    return all;
  }
  const ref = target.ref ?? target.id ?? "";
  if (!ref.trim()) throw new PrismDomainError("Device reference is required.", "DEVICE_REFERENCE_REQUIRED");
  const matched = devices.filter((device) => matchesRef(device, ref));
  if (matched.length > 1) throw new PrismDomainError("Device reference is ambiguous.", "DEVICE_REFERENCE_AMBIGUOUS");
  const device = matched[0];
  if (!device) throw new PrismDomainError("Device was not found.", "DEVICE_NOT_FOUND");
  if (!device.enabled) throw new PrismDomainError("Device is disabled.", "DEVICE_DISABLED");
  if (!can(device, action)) {
    throw new PrismDomainError("Device does not support this action.", "DEVICE_ACTION_UNSUPPORTED");
  }
  return [device];
}

async function scanAccessCode(
  identities: PlayerIdentityRepository,
  playerId: string,
  payload: Record<string, unknown> | undefined,
): Promise<string> {
  const provider =
    typeof payload?.provider === "string" && payload.provider.trim() ? payload.provider.trim().toLowerCase() : "aime";
  const requested = typeof payload?.subject === "string" ? payload.subject.trim() : "";
  const identity = (await identities.listByPlayerId(playerId)).find(
    (candidate) =>
      candidate.provider.toLowerCase() === provider && (!requested || candidate.subject === requested),
  );
  if (!identity) {
    throw new PrismDomainError("Scan identity is not bound to the player.", "SCAN_IDENTITY_NOT_BOUND_TO_PLAYER");
  }
  return identity.subject;
}

export function createDeviceActionService(deps: DeviceActionDependencies): DeviceActionService {
  return {
    async requestDeviceAction(input): Promise<DeviceCommand> {
      if (!isActionName(input.type)) {
        throw new PrismDomainError("Unsupported device action.", "DEVICE_ACTION_UNSUPPORTED");
      }
      const action = input.type;
      const spec = actionSpec(action)!;
      const actor = actorOf(input);
      const playerId = actor.type === "player" ? actor.playerId : null;

      const devices = await loadDevices(deps.db, deps.shopId, deps.env.URL_ENCRYPTION_KEY);
      const targets = resolveTargets(devices, input, action);

      if (playerId && spec.requiresEntry) {
        const active = await deps.sessions.findActiveByPlayerId(playerId);
        if (!active.some((session) => session.status === "active")) {
          throw new PrismDomainError(
            "Player device command requires an active session.",
            "DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION",
          );
        }
      }

      if (playerId && action === "coin") {
        const cooldown = await deps.coinCooldownMs();
        const now = deps.now();
        const recent = (await deps.deviceEvents.listOperationsByPlayer(playerId)).filter(
          (operation) => operation.action === "coin",
        );
        if (cooldown > 0 && operatedWithin(
          recent.map((operation) => ({ ...operation, countsAsPlay: true })),
          playerId,
          new Date(now.getTime() - cooldown),
          now,
        )) {
          throw new PrismDomainError("Coin command cooldown is active.", "COIN_COMMAND_COOLDOWN_ACTIVE");
        }
      }

      // The card number is read from the player's bound identity at the last
      // moment and handed to the runner only; it is never stored.
      const accessCode = action === "aime.scan" && playerId
        ? await scanAccessCode(deps.playerIdentities, playerId, input.payload)
        : action === "aime.scan" && typeof input.payload?.subject === "string"
          ? input.payload.subject
          : null;
      const { subject: _subject, provider: _provider, ...payload } = input.payload ?? {};

      const bus = createRuntimeBus({
        db: deps.db,
        env: deps.env,
        shopId: deps.shopId,
        fetcher: deps.fetcher,
        now: deps.now,
        id: deps.id,
      });

      const all = targets.length > 1;
      const parentId = all ? deps.id() : undefined;
      const outcomes = [];
      for (const device of targets) {
        outcomes.push(
          await bus.perform({
            device,
            action,
            actor,
            parentOperationId: parentId,
            payload: { ...payload, deviceLabel: device.name },
            transient: accessCode ? { accessCode } : undefined,
          }),
        );
      }

      const first = outcomes[0]!;
      const failures = outcomes.filter((outcome) => outcome.operation.status === "failed");
      const command = operationToLegacyCommand({
        ...first.operation,
        ...(all
          ? {
              id: parentId!,
              deviceId: null,
              status: failures.length ? "failed" : outcomes.some((o) => o.operation.status === "pending") ? "pending" : "succeeded",
              failure: failures.length
                ? `操作失败：${failures.map((outcome) => String(outcome.operation.payload.deviceLabel)).join("、")}`
                : null,
              payload: { deviceLabel: "所有设备" },
            }
          : {}),
      });
      const capability = capabilityForAction(action)!;
      return {
        ...command,
        executorKind: capability.legacyExecutor,
        targetKind: capability.legacyTargetKind,
        payload: { ...(command.payload ?? {}), ...(all ? {} : first.result) },
      };
    },
  };
}

/** The shop's coin cooldown, shared by the QR page, card swipes and the Bot. */
export async function coinCooldownMs(db: D1DatabaseLike, shopId: string): Promise<number> {
  const row = await db
    .prepare("SELECT json_extract(value_json,'$.coinCooldownMs') AS cooldown FROM app_settings WHERE shop_id=? AND key='venue.operations'")
    .bind(shopId)
    .first<{ cooldown: number | null }>();
  const value = row?.cooldown;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 60_000;
}
