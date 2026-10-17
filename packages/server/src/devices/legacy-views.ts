/**
 * Compatibility views over the device model for clients that predate it:
 * `/staff|integration/device-states` (the Bot's power listing and its
 * auto-power-off loop) and `/staff/machine-connections`.
 */
import type { DeviceState, MachineConnection } from "@prism/core";
import { createD1Executor } from "@prism/adapter-d1";
import { createDeviceEventRepository } from "@prism/storage-sql";
import { loadDevices } from "./device.js";
import { createRuntimeBus, type DeviceRuntime } from "./runtime.js";

/**
 * Power of every enabled device that has it, read live. A source that cannot
 * be reached right now reports its last observation as `offline`, or
 * `unknown` when it was never observed.
 */
export async function listDeviceStates(runtime: DeviceRuntime): Promise<DeviceState[]> {
  const now = runtime.now ?? (() => new Date());
  const devices = (await loadDevices(runtime.db, runtime.shopId, runtime.env.URL_ENCRYPTION_KEY))
    .filter((device) => device.enabled && device.capabilities.has("power"));
  if (!devices.length) return [];
  const bus = createRuntimeBus(runtime);
  const stored = new Map(
    (await createDeviceEventRepository(createD1Executor(runtime.db, runtime.shopId))
      .listState(devices.map((device) => device.id)))
      .filter((state) => state.capability === "power" && state.key === "power")
      .map((state) => [state.deviceId, state]),
  );
  return Promise.all(devices.map(async (device): Promise<DeviceState> => {
    const live = await bus.observe(device, "power", "power").catch(() => null);
    const last = stored.get(device.id);
    const reachable = live === "on" || live === "off";
    return {
      deviceId: device.id,
      type: "power.on",
      targetKind: "facility",
      executorKind: "home_assistant",
      label: device.name,
      status: reachable ? "online" : "offline",
      state: reachable ? live : typeof last?.value === "string" ? last.value : "unknown",
      metadata: { aliases: device.aliases },
      reportedAt: reachable ? now() : last?.changedAt ?? now(),
      reportedBy: "home_assistant",
    };
  }));
}

/** Embedded HINATA IO links, from the link state the relay records. */
export async function listMachineConnections(runtime: DeviceRuntime): Promise<MachineConnection[]> {
  const states = (await createDeviceEventRepository(createD1Executor(runtime.db, runtime.shopId)).listState())
    .filter((state) => state.capability === "hinata_io" && state.key === "link");
  return states.map((state) => {
    const online = state.value === "online";
    return {
      machineId: state.deviceId,
      status: online ? "online" : "offline",
      capabilities: ["aime.scan", "coin"],
      connectedAt: state.changedAt,
      lastSeenAt: state.changedAt,
      ...(online ? {} : { disconnectedAt: state.changedAt }),
    };
  });
}
