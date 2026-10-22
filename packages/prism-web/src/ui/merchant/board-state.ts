import type { ClimateState } from "../ClimateControls";

/**
 * What the board knows of one device's power and air conditioner. `watching` is
 * the "实时" tag: a HINATA IO reports every change, so the values are current.
 * Without it the device has no state of its own and the values are only what the
 * last refresh found, or unknown.
 */
export type BoardState = { watching: boolean; power: "on" | "off" | null; climate: ClimateState | null };
export type BoardStates = Record<string, BoardState>;

/**
 * What the board shows once something was read or said about a device. A live device takes
 * it. A device with no state of its own keeps what it last showed, even if that was
 * pushed before it stopped being live or read ten minutes ago: a value that is out of date is
 * still a value, and only a field that has never been learned is empty.
 */
export function learnBoardState(previous: BoardState | null | undefined, next: BoardState): BoardState {
  if (next.watching || !previous) return next;
  return { watching: false, power: next.power ?? previous.power, climate: next.climate ?? previous.climate };
}

/**
 * What the board shows after a read of the whole shop over HTTP. The read is for the devices with no
 * state of their own, so it only fills those in. A device that is live is kept as it is: the hub already
 * keeps it current, and the read's copy of it is only what the database held when it was read.
 */
export function mergeBoardStates(next: BoardStates, previous: BoardStates | null): BoardStates {
  if (!previous) return next;
  const merged: BoardStates = {};
  for (const [id, state] of Object.entries(next)) {
    const kept = previous[id];
    merged[id] = state.watching && kept?.watching ? kept : learnBoardState(kept, state);
  }
  return merged;
}

/** Whether a refresh has anything to do: some device has no state of its own. */
export function hasUnwatched(states: BoardStates | null): boolean {
  return !!states && Object.values(states).some((state) => !state.watching);
}

/** A frame the shop hub pushes to the board. */
export type BoardFrame =
  /** The whole shop: when the board connects, and again whenever which devices are live changes. */
  | { type: "states"; states: BoardStates }
  /** A live device's state changed; a key that is absent was not part of the change. */
  | { type: "state"; deviceId: string; power?: "on" | "off" | null; climate?: ClimateState | null };

const powerOf = (value: unknown): "on" | "off" | null => (value === "on" || value === "off" ? value : null);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** A frame from the hub, or null for anything that is not one. */
export function parseBoardFrame(raw: string): BoardFrame | null {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(frame)) return null;
  if (frame.type === "states" && isRecord(frame.states)) {
    const states: BoardStates = {};
    for (const [id, value] of Object.entries(frame.states)) {
      if (!isRecord(value)) continue;
      states[id] = {
        watching: value.watching === true,
        power: powerOf(value.power),
        climate: isRecord(value.climate) ? (value.climate as ClimateState) : null,
      };
    }
    return { type: "states", states };
  }
  if (frame.type === "state" && typeof frame.deviceId === "string") {
    return {
      type: "state",
      deviceId: frame.deviceId,
      ...("power" in frame ? { power: powerOf(frame.power) } : {}),
      ...("climate" in frame ? { climate: isRecord(frame.climate) ? (frame.climate as ClimateState) : null } : {}),
    };
  }
  return null;
}

/**
 * What a frame does to the board. The hub only sends a change for a device that is
 * live, so there is nothing to decide here: the change goes onto the device it names,
 * if the board has that device.
 */
export function applyBoardFrame(states: BoardStates | null, frame: BoardFrame): BoardStates | null {
  // The hub's word about which devices are live and what they show is the newest there is.
  if (frame.type === "states")
    return Object.fromEntries(Object.entries(frame.states).map(([id, state]) => [id, learnBoardState(states?.[id], state)]));
  const current = states?.[frame.deviceId];
  if (!states || !current) return states;
  return {
    ...states,
    [frame.deviceId]: {
      ...current,
      ...(frame.power !== undefined ? { power: frame.power } : {}),
      ...(frame.climate !== undefined ? { climate: frame.climate } : {}),
    },
  };
}
