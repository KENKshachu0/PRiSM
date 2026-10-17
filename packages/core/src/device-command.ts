/**
 * The command vocabulary of the API before the device event model. Kept as the
 * shape of compatibility views and Bot responses; storage and behaviour live
 * in `device-events.ts`.
 */
export type DeviceTargetKind = "facility" | "game_machine";

export type DeviceExecutorKind = "home_assistant" | "machine_ws" | "hinata_io" | "ttlock";

export type DeviceActionType =
  | "power.on"
  | "power.off"
  | "ac.set_temperature"
  | "coin"
  | "aime.scan"
  | "door.open";

export type DeviceCommandType = DeviceActionType;

export type DeviceReferenceTarget =
  | {
      kind: "facility";
      ref: string;
      id?: never;
    }
  | {
      kind: "game_machine";
      id: string;
      ref?: never;
    }
  | {
      kind: "game_machine";
      ref: string;
      id?: never;
    };

export type DeviceCommandActor =
  | {
      type: "player";
      playerId: string;
    }
  | {
      type: "staff";
      staffId: string;
    };

export type DeviceCommand = {
  id: string;
  type: DeviceCommandType;
  deviceId: string | null;
  targetKind: DeviceTargetKind;
  executorKind: DeviceExecutorKind;
  playerId?: string;
  staffId?: string;
  status: "pending" | "acked" | "expired" | "rejected";
  payload?: Record<string, unknown>;
  requestedAt: Date;
  ackedAt?: Date;
  expiredAt?: Date;
};

export type DeviceState = {
  deviceId: string;
  type: DeviceCommandType;
  targetKind?: DeviceTargetKind;
  executorKind?: DeviceExecutorKind;
  label: string;
  status: "online" | "offline" | "degraded";
  state: string;
  metadata: Record<string, unknown> | null;
  reportedAt: Date;
  reportedBy: string;
};
