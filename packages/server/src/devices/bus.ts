/**
 * The single write path for devices.
 *
 * Every occurrence on a device becomes events, recorded atomically together
 * with whatever operation or state it changes:
 *
 *   perform(action)  request event + operation, run the capability, then the
 *                    result event that settles it; then re-observe any external
 *                    state the action touches instead of assuming its effect
 *   signal(...)      a fact the device reported; may confirm an operation
 *   setOwned(...)    an owned state value, with a change event when it differs
 *   observe(...)     an external state read live, recorded only when it moved
 *
 * Callers never write device tables directly.
 */
import type {
  DeviceEvent,
  DeviceEventActor,
  DeviceEventRepository,
  DeviceOperation,
  DeviceOperationStatus,
} from "@prism/core";
import { deviceActorFields, PrismDomainError } from "@prism/core";
import {
  actionSpec,
  capabilityForAction,
  capabilitySpec,
  type ActionName,
  type CapabilityId,
} from "./capabilities.js";
import { can, type Device } from "./device.js";

export type ActionContext = {
  device: Device;
  operationId: string;
  payload: Record<string, unknown>;
};

/** Runs an action against real hardware. Throwing means the outcome is unknown. */
export type ActionRunner = (context: ActionContext) => Promise<RunOutcome>;

export type RunOutcome =
  | { outcome: "ok"; result?: Record<string, unknown> }
  /** `httpStatus` is what the hardware's HTTP endpoint answered, when it answered. */
  | { outcome: "failed"; message: string; httpStatus?: number }
  /** The request may or may not have reached the device (e.g. a network timeout). */
  | { outcome: "unknown"; message: string };

/** Reads an external state live. Returns null when the source cannot be reached. */
export type StateReader = (device: Device) => Promise<unknown | null>;

export type DeviceBusDependencies = {
  events: DeviceEventRepository;
  now: () => Date;
  id: () => string;
  runners: Partial<Record<ActionName, ActionRunner>>;
  readers: Partial<Record<string, StateReader>>;
};

export type PerformInput = {
  device: Device;
  action: ActionName;
  actor: DeviceEventActor;
  operationId?: string;
  parentOperationId?: string;
  payload?: Record<string, unknown>;
  /** Values that reach the runner but are never persisted, such as a card number. */
  transient?: Record<string, unknown>;
};

export type PerformResult = {
  operation: DeviceOperation;
  /** Data the caller shows once and that is never stored (a door code, etc.). */
  result: Record<string, unknown>;
  httpStatus: number | null;
};

export type DeviceBus = ReturnType<typeof createDeviceBus>;

export function createDeviceBus(deps: DeviceBusDependencies) {
  const event = (
    input: Omit<DeviceEvent, "id" | "occurredAt" | "parentOperationId" | "playerId" | "staffId"> &
      Partial<Pick<DeviceEvent, "parentOperationId" | "playerId" | "staffId">>,
  ): DeviceEvent => ({
    id: deps.id(),
    occurredAt: deps.now(),
    parentOperationId: null,
    playerId: null,
    staffId: null,
    ...input,
  });

  async function observe(device: Device, capability: CapabilityId, key: string): Promise<unknown | null> {
    const reader = deps.readers[`${capability}.${key}`];
    if (!reader) return null;
    const value = await reader(device);
    if (value === null || value === undefined) return null;
    await deps.events.record({
      events: [],
      states: [
        {
          write: { deviceId: device.id, capability, key, value, authority: "observed" },
          event: event({
            deviceId: device.id,
            capability,
            kind: "change",
            name: key,
            operationId: null,
            origin: "observer",
            payload: { to: value },
          }),
        },
      ],
    });
    return value;
  }

  return {
    /**
     * Ask a device to do something. The request is recorded before the runner is
     * called, so a crash or timeout always leaves an auditable pending operation.
     */
    async perform(input: PerformInput): Promise<PerformResult> {
      const spec = capabilityForAction(input.action);
      const action = actionSpec(input.action);
      if (!spec || !action) {
        throw new PrismDomainError("Unknown device action.", "DEVICE_ACTION_UNSUPPORTED");
      }
      if (!input.device.enabled) {
        throw new PrismDomainError("Device is disabled.", "DEVICE_DISABLED");
      }
      if (!can(input.device, input.action)) {
        throw new PrismDomainError("Device does not support this action.", "DEVICE_ACTION_UNSUPPORTED");
      }
      const runner = deps.runners[input.action];
      if (!runner) {
        throw new PrismDomainError("Device action is not available.", "DEVICE_ACTION_UNSUPPORTED");
      }

      const operationId = input.operationId ?? deps.id();
      const actorFields = deviceActorFields(input.actor);
      const payload = input.payload ?? {};
      const requestedAt = deps.now();
      const operation: DeviceOperation = {
        id: operationId,
        deviceId: input.device.id,
        capability: spec.id,
        action: input.action,
        parentId: input.parentOperationId ?? null,
        ...actorFields,
        status: "pending",
        countsAsPlay: action.countsAsPlay,
        failure: null,
        payload,
        requestedAt,
        settledAt: null,
        confirmedAt: null,
      };
      await deps.events.record({
        events: [
          {
            ...event({
              deviceId: input.device.id,
              capability: spec.id,
              kind: "request",
              name: input.action,
              operationId,
              parentOperationId: input.parentOperationId ?? null,
              origin: "platform",
              payload,
              ...actorFields,
            }),
            occurredAt: requestedAt,
          },
        ],
        operation,
      });

      let outcome: RunOutcome;
      try {
        outcome = await runner({
          device: input.device,
          operationId,
          payload: { ...payload, ...(input.transient ?? {}) },
        });
      } catch (error) {
        outcome = { outcome: "unknown", message: error instanceof Error ? error.message : "设备未响应" };
      }

      const status: DeviceOperationStatus =
        outcome.outcome === "ok" ? "succeeded" : outcome.outcome === "failed" ? "failed" : "pending";
      const failure = outcome.outcome === "ok" ? null : outcome.message;
      const httpStatus = outcome.outcome === "failed" ? outcome.httpStatus ?? null : null;
      const settledAt = deps.now();
      const persisted =
        outcome.outcome === "ok" && !action.sensitiveResult ? (outcome.result ?? {}) : {};
      await deps.events.record({
        events: [
          event({
            deviceId: input.device.id,
            capability: spec.id,
            kind: "result",
            name: input.action,
            operationId,
            parentOperationId: input.parentOperationId ?? null,
            origin: "platform",
            payload: {
              outcome: outcome.outcome,
              ...(failure ? { message: failure } : {}),
              ...(httpStatus ? { httpStatus } : {}),
              ...persisted,
            },
            ...actorFields,
          }),
        ],
        // Unknown leaves the operation pending: the device may still have acted,
        // and billing has always counted an unsettled request as use.
        ...(status === "pending" ? {} : { settle: { operationId, status, failure, settledAt } }),
      });

      if (action.observeAfter && outcome.outcome === "ok") {
        try {
          await observe(input.device, spec.id, action.observeAfter);
        } catch {
          // A failed follow-up read must not turn a successful action into an error.
        }
      }

      return {
        operation: { ...operation, status, failure, settledAt: status === "pending" ? null : settledAt },
        result: outcome.outcome === "ok" ? (outcome.result ?? {}) : {},
        httpStatus,
      };
    },

    /**
     * Record something the device reported. If the signal confirms an action
     * (e.g. the card reached the game) the operation it names is marked confirmed.
     */
    async signal(input: {
      device: Pick<Device, "id">;
      capability: CapabilityId;
      name: string;
      operationId?: string | null;
      payload?: Record<string, unknown>;
    }): Promise<boolean> {
      const spec = capabilitySpec(input.capability);
      const signal = spec?.signals[input.name];
      if (!spec || !signal || !signal.store) return false;
      const occurred = event({
        deviceId: input.device.id,
        capability: spec.id,
        kind: "signal",
        name: input.name,
        operationId: input.operationId ?? null,
        origin: "device",
        payload: input.payload ?? {},
      });
      const confirms =
        !!input.operationId &&
        Object.values(spec.actions).some((action) => action?.confirmedBy === input.name);
      await deps.events.record({
        events: [occurred],
        ...(confirms ? { confirm: { operationId: input.operationId!, deviceId: input.device.id, confirmedAt: occurred.occurredAt } } : {}),
      });
      return true;
    },

    /** Set a state the platform owns. A change event is written only when the value differs. */
    async setOwned(input: {
      device: Pick<Device, "id">;
      capability: CapabilityId;
      key: string;
      value: unknown;
    }): Promise<void> {
      const spec = capabilitySpec(input.capability);
      if (spec?.state[input.key]?.authority !== "owned") {
        throw new PrismDomainError("State is not owned by the platform.", "DEVICE_STATE_NOT_OWNED");
      }
      await deps.events.record({
        events: [],
        states: [
          {
            write: {
              deviceId: input.device.id,
              capability: input.capability,
              key: input.key,
              value: input.value,
              authority: "owned",
            },
            event: event({
              deviceId: input.device.id,
              capability: input.capability,
              kind: "change",
              name: input.key,
              operationId: null,
              origin: "device",
              payload: { to: input.value },
            }),
          },
        ],
      });
    },

    /**
     * Read an external state live. The value returned is the current fact;
     * storage only gains a change event when it differs from the last
     * observation. Null means the source could not be reached right now.
     */
    observe,
  };
}
