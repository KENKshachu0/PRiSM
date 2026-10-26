/**
 * Compatibility adapters.
 *
 * The Bot, the staff API and the frozen view serializers still speak the old
 * `DeviceCommand` vocabulary. These map a device operation onto that shape so
 * every legacy response keeps exactly the fields it always had, while the data
 * comes from the device event model.
 */
import { legacyStatusOf, type DeviceOperation } from "./device-events";
import type { DeviceCommand } from "./device-command";

const legacyExecutors: Record<string, DeviceCommand["executorKind"]> = {
  power: "home_assistant",
  hinata_io: "hinata_io",
  door: "ttlock",
};

const legacyTargets: Record<string, DeviceCommand["targetKind"]> = {
  power: "facility",
  door: "facility",
  hinata_io: "game_machine",
};

export function operationToLegacyCommand(operation: DeviceOperation): DeviceCommand {
  const payload = { ...operation.payload };
  // Migrated history kept the original executor and target so old rows render
  // exactly as before (e.g. coins from the retired machine WebSocket).
  const executorKind =
    (typeof payload.legacyExecutor === "string" ? payload.legacyExecutor : null) ??
    legacyExecutors[operation.capability] ??
    "machine_ws";
  const targetKind =
    (typeof payload.legacyTargetKind === "string" ? payload.legacyTargetKind : null) ??
    legacyTargets[operation.capability] ??
    "game_machine";
  delete payload.legacyExecutor;
  delete payload.legacyTargetKind;
  // A failed action says why. So does one still pending: an unanswered request
  // (a timeout) explains more as "设备未响应" than as a bare "稍后再试".
  if (operation.status !== "succeeded" && operation.failure && !payload.executorFailure) {
    payload.executorFailure = { executorKind, message: operation.failure };
  }
  const status = legacyStatusOf(operation.status);
  return {
    id: operation.id,
    type: operation.action as DeviceCommand["type"],
    deviceId: operation.deviceId,
    targetKind: targetKind as DeviceCommand["targetKind"],
    executorKind: executorKind as DeviceCommand["executorKind"],
    playerId: operation.playerId ?? undefined,
    staffId: operation.staffId ?? undefined,
    status,
    payload,
    requestedAt: operation.requestedAt,
    ackedAt: status === "acked" ? (operation.settledAt ?? undefined) : undefined,
    expiredAt: status === "expired" ? (operation.settledAt ?? undefined) : undefined,
  };
}
