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

export type MachineAction = { name: string; capability: string };

/**
 * Which capability owns an action. The server states this for every action it
 * reports; this mapping only covers the built-in catalog and is used when an
 * older response has no capability tag.
 */
export function actionCapability(action: string): CapabilityId | null {
  if (action === "power.on" || action === "power.off") return "power";
  if (action === "aime.scan" || action === "coin") return "hinata_io";
  if (action === "door.open") return "door";
  if (action.startsWith("mahjong.")) return "mahjong";
  return null;
}

/** Staff actions grouped by the capability that owns them. */
export function deviceActionGroups(
  machine: Pick<
    Machine,
    | "homeAssistant"
    | "ttlockLockId"
    | "mahjong"
    | "hasHinata"
    | "relayConnection"
    | "coinKey"
    | "hasPassword"
  > & { actions?: MachineAction[] },
): { capability: CapabilityId; actions: string[] }[] {
  const groups = new Map<CapabilityId, string[]>();
  const add = (capability: CapabilityId | null, action: string) => {
    if (!capability) return;
    groups.set(capability, [...(groups.get(capability) ?? []), action]);
  };
  if (machine.actions?.length) {
    for (const action of machine.actions) {
      add(
        capabilityOrder.includes(action.capability as CapabilityId)
          ? (action.capability as CapabilityId)
          : actionCapability(action.name),
        action.name,
      );
    }
  } else {
    // Fallback for a response written before actions carried capabilities.
    const caps = deviceCapabilities(machine);
    if (caps.power) {
      add("power", "power.on");
      add("power", "power.off");
    }
    if (caps.hinata_io) add("hinata_io", "aime.scan");
    if (canOperateCoin(machine)) add("hinata_io", "coin");
    if (caps.door) add("door", "door.open");
  }
  return capabilityOrder
    .filter((capability) => groups.has(capability))
    .map((capability) => ({
      capability,
      actions: groups.get(capability)!,
    }));
}

/** Flat list of the actions the device offers, in capability order. */
export function deviceActions(
  machine: Parameters<typeof deviceActionGroups>[0],
): string[] {
  return deviceActionGroups(machine).flatMap((group) => group.actions);
}

/** A device with no capability has nothing a staff member can do with it. */
export function isUnconfigured(
  machine: Parameters<typeof deviceCapabilities>[0],
): boolean {
  return !Object.values(deviceCapabilities(machine)).some(Boolean);
}
