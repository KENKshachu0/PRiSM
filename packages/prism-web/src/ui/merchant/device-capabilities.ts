import type { Machine } from "../../api";

/**
 * What a device can do, derived from the machine row once.
 *
 * The merchant API still describes a device as a flat row of optional columns
 * (`homeAssistant`, `ttlockLockId`, `hasHinata`, …). The screen needs the
 * capability view of the same facts, so the translation lives here instead of
 * being re-derived at every call site — the previous copy-per-component shape
 * let the device card, the editor and the action list disagree about whether
 * coin was usable on a given machine.
 */
export type CapabilityId = "power" | "hinata_io" | "door" | "mahjong";

export const capabilityOrder: CapabilityId[] = [
  "power",
  "hinata_io",
  "door",
  "mahjong",
];

/** The capabilities this device currently carries. */
export function deviceCapabilities(
  machine: Pick<
    Machine,
    | "homeAssistant"
    | "ttlockLockId"
    | "mahjong"
    | "hasHinata"
    | "relayConnection"
    | "coinEnabled"
    | "hasPassword"
  >,
): Record<CapabilityId, boolean> {
  return {
    power: !!machine.homeAssistant,
    hinata_io:
      !!machine.hasHinata || machine.relayConnection === "embedded",
    door: !!machine.ttlockLockId,
    mahjong: !!machine.mahjong,
  };
}

/** Direct-connect machines authenticate the socket, so they need no password. */
export function isDirectConnect(
  machine: Pick<Machine, "relayConnection">,
): boolean {
  return machine.relayConnection === "embedded";
}

/**
 * Whether the coin action can actually be sent. Mirrors the server's
 * `hinata_io.available`: direct connect needs a key, an external relay needs
 * a key and the password that authenticates a plaintext key press.
 */
export function canOperateCoin(
  machine: Pick<
    Machine,
    "hasHinata" | "relayConnection" | "coinKey" | "hasPassword"
  >,
): boolean {
  if (!(machine.hasHinata || machine.relayConnection === "embedded")) {
    return false;
  }
  // The key is the switch: a set key enables coin, an empty one disables it.
  if (!((machine.coinKey ?? 0) > 0)) return false;
  return isDirectConnect(machine) || !!machine.hasPassword;
}

/**
 * Staff actions offered for a device.
 *
 * The server answers with the capability catalog's own list, so a capability
 * added there shows up here without a frontend change. The derived list is
 * only a fallback for an older response that predates `actions`.
 */
export function deviceActions(
  machine: Pick<
    Machine,
    | "homeAssistant"
    | "ttlockLockId"
    | "mahjong"
    | "hasHinata"
    | "relayConnection"
    | "coinKey"
    | "hasPassword"
  > & { actions?: string[] },
): string[] {
  if (machine.actions?.length) return machine.actions;
  const caps = deviceCapabilities(machine);
  return [
    ...(caps.power ? (["power.on", "power.off"] as const) : []),
    ...(caps.hinata_io ? (["aime.scan"] as const) : []),
    ...(canOperateCoin(machine) ? (["coin"] as const) : []),
    ...(caps.door ? (["door.open"] as const) : []),
  ];
}

/** One short line naming what this device is for, used by the device card. */
export function deviceSummaryKey(
  machine: Pick<
    Machine,
    | "kind"
    | "homeAssistant"
    | "ttlockLockId"
    | "mahjong"
    | "hasHinata"
    | "relayConnection"
  >,
): string {
  const caps = deviceCapabilities(machine);
  if (caps.mahjong) return "麻将桌";
  if (caps.door) return "获取开门密码";
  if (caps.power && caps.hinata_io) return "开机与刷卡";
  if (caps.hinata_io) return "刷卡机台";
  if (caps.power) return "电源控制";
  return "未绑定能力";
}

/** A device with no capability has nothing a staff member can do with it. */
export function isUnconfigured(
  machine: Parameters<typeof deviceCapabilities>[0],
): boolean {
  return !Object.values(deviceCapabilities(machine)).some(Boolean);
}
