import { describe, expect, it } from "bun:test";
import type { DeviceEvent, DeviceEventRepository, DeviceOperation, DeviceRecord, DeviceStateValue } from "@prism/core";
import { createDeviceBus, type ActionRunner, type StateReader } from "../src/devices/bus.js";
import type { BoundCapability, Device } from "../src/devices/device.js";
import type { CapabilityId } from "../src/devices/capabilities.js";

/** In-memory repository that applies a record the way the SQL one does. */
function memoryRepository() {
  const events: DeviceEvent[] = [];
  const operations = new Map<string, DeviceOperation>();
  const state = new Map<string, { value: unknown; changedAt: Date }>();
  const repo: DeviceEventRepository = {
    async record(input: DeviceRecord) {
      events.push(...input.events);
      if (input.operation) operations.set(input.operation.id, input.operation);
      if (input.settle) {
        const op = operations.get(input.settle.operationId);
        if (op && op.status === "pending") {
          operations.set(op.id, { ...op, status: input.settle.status, failure: input.settle.failure, settledAt: input.settle.settledAt });
        }
      }
      if (input.confirm) {
        const op = operations.get(input.confirm.operationId);
        if (op && !op.confirmedAt) operations.set(op.id, { ...op, confirmedAt: input.confirm.confirmedAt });
      }
      for (const { write, event } of input.states ?? []) {
        const key = `${write.deviceId}/${write.capability}/${write.key}`;
        const previous = state.get(key);
        if (previous && JSON.stringify(previous.value) === JSON.stringify(write.value)) continue;
        events.push(event);
        state.set(key, { value: write.value, changedAt: event.occurredAt });
      }
    },
    async listEvents() { return [...events].reverse(); },
    async getOperation(id) { return operations.get(id) ?? null; },
    async listOperationsByPlayer(playerId) { return [...operations.values()].filter((o) => o.playerId === playerId); },
    async listRecentOperations() { return [...operations.values()]; },
    async listState(): Promise<DeviceStateValue[]> { return []; },
  };
  return { repo, events, operations, state };
}

function device(bound: Partial<Record<CapabilityId, Partial<BoundCapability>>>, enabled = true): Device {
  const capabilities = new Map<CapabilityId, BoundCapability>();
  for (const [id, value] of Object.entries(bound) as [CapabilityId, Partial<BoundCapability>][]) {
    capabilities.set(id, { id, config: {}, secretNames: new Set(), credentialHash: null, ...value });
  }
  return { id: "m1", shopId: "shop", publicId: "pub", name: "Cabinet", aliases: [], enabled, kind: "machine", capabilities };
}

const ioDevice = (config: Record<string, unknown> = {}, secrets: string[] = ["url", "password"]) =>
  device({ hinata_io: { config: { transport: "external", coinKey: 32, coinAfterSwipe: false, ...config }, secretNames: new Set(secrets) } });
const powerDevice = () => device({ power: { secretNames: new Set(["binding"]) } });

function busWith(input: { runners?: Record<string, ActionRunner>; readers?: Record<string, StateReader> } = {}) {
  const memory = memoryRepository();
  let tick = 0;
  let next = 0;
  const bus = createDeviceBus({
    events: memory.repo,
    now: () => new Date(Date.UTC(2026, 1, 1, 10, 0, tick++)),
    id: () => `id${next++}`,
    runners: input.runners ?? {},
    readers: input.readers ?? {},
  });
  return { bus, ...memory };
}

const player = { type: "player" as const, playerId: "p1" };

describe("device bus: perform", () => {
  it("records the request before running, then the result that settles it", async () => {
    let seenAtRun = 0;
    const { bus, events, operations } = busWith({
      runners: {
        coin: async () => {
          seenAtRun = events.length;
          return { outcome: "ok" };
        },
      },
    });
    const { operation } = await bus.perform({ device: ioDevice(), action: "coin", actor: player, operationId: "op" });
    // A crash inside the runner would still leave this request on record.
    expect(seenAtRun).toBe(1);
    expect(events.map((e) => `${e.kind}:${e.name}`)).toEqual(["request:coin", "result:coin"]);
    expect(operation).toMatchObject({ status: "succeeded", countsAsPlay: true, playerId: "p1" });
    expect(operations.get("op")!.status).toBe("succeeded");
  });

  it("keeps an unknown outcome pending, the way billing has always counted it", async () => {
    const { bus, operations } = busWith({
      runners: { coin: async () => { throw new Error("socket closed"); } },
    });
    const { operation } = await bus.perform({ device: ioDevice(), action: "coin", actor: player, operationId: "op" });
    expect(operation.status).toBe("pending");
    expect(operations.get("op")!.status).toBe("pending");
  });

  it("records a failure with its reason", async () => {
    const { bus, operations } = busWith({
      runners: { coin: async () => ({ outcome: "failed", message: "机台未在线" }) },
    });
    await bus.perform({ device: ioDevice(), action: "coin", actor: player, operationId: "op" });
    expect(operations.get("op")).toMatchObject({ status: "failed", failure: "机台未在线" });
  });

  it("never stores a sensitive result, but still returns it to the caller", async () => {
    const { bus, events } = busWith({
      runners: { "door.open": async () => ({ outcome: "ok", result: { temporaryPassword: "12345678" } }) },
    });
    const done = await bus.perform({
      device: device({ door: { config: { lockId: 1 } } }),
      action: "door.open",
      actor: player,
    });
    expect(done.result.temporaryPassword).toBe("12345678");
    expect(JSON.stringify(events)).not.toContain("12345678");
    expect(done.operation.countsAsPlay).toBe(false);
  });

  it("passes transient values to the runner without persisting them", async () => {
    let received: Record<string, unknown> = {};
    const { bus, events, operations } = busWith({
      runners: { "aime.scan": async ({ payload }) => { received = payload; return { outcome: "ok" }; } },
    });
    await bus.perform({
      device: ioDevice(),
      action: "aime.scan",
      actor: player,
      operationId: "op",
      payload: { cardId: "card-1" },
      transient: { accessCode: "01234567890123456789" },
    });
    expect(received).toEqual({ cardId: "card-1", accessCode: "01234567890123456789" });
    const stored = JSON.stringify([events, [...operations.values()]]);
    expect(stored).not.toContain("01234567890123456789");
    expect(stored).toContain("card-1");
  });

  it("re-reads power after acting rather than assuming the effect", async () => {
    let live = "off";
    const { bus, events } = busWith({
      runners: { "power.on": async () => ({ outcome: "ok" }) },
      readers: { "power.power": async () => live },
    });
    // The switch accepted the request but the outlet stayed off.
    await bus.perform({ device: powerDevice(), action: "power.on", actor: player });
    expect(events.filter((e) => e.kind === "change").map((e) => e.payload.to)).toEqual(["off"]);
    live = "on";
    await bus.perform({ device: powerDevice(), action: "power.on", actor: player });
    expect(events.filter((e) => e.kind === "change").map((e) => e.payload.to)).toEqual(["off", "on"]);
  });

  it("refuses an action the device's configuration cannot perform", async () => {
    const { bus, events } = busWith({ runners: { coin: async () => ({ outcome: "ok" }) } });
    // External relay without a password cannot send a key press.
    await expect(bus.perform({ device: ioDevice({}, ["url"]), action: "coin", actor: player }))
      .rejects.toMatchObject({ code: "DEVICE_ACTION_UNSUPPORTED" });
    // Coin disabled by a zero key.
    await expect(bus.perform({ device: ioDevice({ coinKey: 0 }), action: "coin", actor: player }))
      .rejects.toMatchObject({ code: "DEVICE_ACTION_UNSUPPORTED" });
    expect(events).toEqual([]);
  });

  it("lets a direct-connect machine coin without a relay password", async () => {
    const { bus } = busWith({ runners: { coin: async () => ({ outcome: "ok" }) } });
    const embedded = ioDevice({ transport: "embedded", channel: "m_x" }, []);
    const { operation } = await bus.perform({ device: embedded, action: "coin", actor: player });
    expect(operation.status).toBe("succeeded");
  });

  it("refuses a disabled device", async () => {
    const { bus } = busWith({ runners: { coin: async () => ({ outcome: "ok" }) } });
    const disabled = device({ hinata_io: { config: { transport: "external", coinKey: 32 }, secretNames: new Set(["url", "password"]) } }, false);
    await expect(bus.perform({ device: disabled, action: "coin", actor: player }))
      .rejects.toMatchObject({ code: "DEVICE_DISABLED" });
  });
});

describe("device bus: signals and state", () => {
  it("confirms the operation a card report names", async () => {
    const { bus, operations } = busWith({ runners: { "aime.scan": async () => ({ outcome: "ok" }) } });
    await bus.perform({ device: ioDevice(), action: "aime.scan", actor: player, operationId: "scan" });
    await bus.signal({ device: { id: "m1" }, capability: "hinata_io", name: "card.consumed", operationId: "scan" });
    expect(operations.get("scan")!.confirmedAt).not.toBeNull();
  });

  it("does not let an unrelated signal confirm anything", async () => {
    const { bus, operations } = busWith({ runners: { "aime.scan": async () => ({ outcome: "ok" }) } });
    await bus.perform({ device: ioDevice(), action: "aime.scan", actor: player, operationId: "scan" });
    await bus.signal({ device: { id: "m1" }, capability: "hinata_io", name: "card.state", operationId: "scan" });
    expect(operations.get("scan")!.confirmedAt).toBeNull();
  });

  it("drops per-frame telemetry instead of storing it", async () => {
    const { bus, events } = busWith();
    expect(await bus.signal({ device: { id: "m1" }, capability: "hinata_io", name: "led.set" })).toBe(false);
    expect(events).toEqual([]);
  });

  it("logs an owned state only when it changes", async () => {
    const { bus, events } = busWith();
    await bus.setOwned({ device: { id: "m1" }, capability: "hinata_io", key: "link", value: { online: true } });
    await bus.setOwned({ device: { id: "m1" }, capability: "hinata_io", key: "link", value: { online: true } });
    await bus.setOwned({ device: { id: "m1" }, capability: "hinata_io", key: "link", value: { online: false } });
    expect(events.map((e) => (e.payload.to as { online: boolean }).online)).toEqual([true, false]);
  });

  it("refuses to treat an external state as owned", async () => {
    const { bus } = busWith();
    await expect(bus.setOwned({ device: { id: "m1" }, capability: "power", key: "power", value: "on" }))
      .rejects.toMatchObject({ code: "DEVICE_STATE_NOT_OWNED" });
  });

  it("returns null and records nothing when an external source is unreachable", async () => {
    const { bus, events } = busWith({ readers: { "power.power": async () => null } });
    expect(await bus.observe(powerDevice(), "power", "power")).toBeNull();
    expect(events).toEqual([]);
  });
});
