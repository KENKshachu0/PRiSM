/**
 * What the platform knows about a device's Home Assistant state, and whether it
 * may be believed.
 *
 * A Home Assistant connection is in one of two modes. While a HINATA IO watches
 * it (`ha_event_connections` has a row) every change arrives as an event and
 * `device_state` is current: readers take the stored value and never ask Home
 * Assistant. Otherwise nothing is known and a reader that needs the state has
 * to ask Home Assistant itself. Only the shop hub moves a connection between
 * the two, after the full state of a new watcher is stored, so a row here is
 * never ahead of the data it vouches for.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import { listResources, type Resource } from "../resource.js";
import type { ClimateState } from "./runtime.js";

/** Power and climate state of one device as stored facts. */
export type DeviceFacts = {
  /** Every Home Assistant connection the device uses is watched, so the values are current. */
  watching: boolean;
  /** Null when not watching, when the device has no power, or when Home Assistant reports it unavailable. */
  power: "on" | "off" | null;
  /** Null when not watching, when the device has no climate, or when Home Assistant reports it unavailable. */
  climate: ClimateState | null;
};

export const noFacts: DeviceFacts = { watching: false, power: null, climate: null };

/**
 * The Home Assistant connections a device's power and climate use. A binding
 * from before connections existed has none and can never be watched, which
 * shows up as an empty string.
 */
export function haConnectionsOf(device: Pick<Resource, "capabilities">): string[] {
  const ids = new Set<string>();
  for (const id of ["power", "climate"] as const) {
    const bound = device.capabilities.get(id);
    if (!bound) continue;
    const connectionId = (bound.config as { connectionId?: unknown }).connectionId;
    ids.add(typeof connectionId === "string" && connectionId ? connectionId : "");
  }
  return [...ids];
}

type Rows<T> = { results: T[] };
type StateRow = { capability: string; key: string; value_json: string };

/** The facts from a device's stored rows, given which of its connections are watched. */
function factsFrom(connections: readonly string[], watched: ReadonlySet<string>, rows: readonly StateRow[]): DeviceFacts {
  if (!connections.length || connections.includes("") || !connections.every((id) => watched.has(id))) return noFacts;
  const facts: DeviceFacts = { watching: true, power: null, climate: null };
  for (const row of rows) {
    let value: unknown;
    try {
      value = JSON.parse(row.value_json);
    } catch {
      continue;
    }
    if (row.capability === "power") facts.power = value === "on" || value === "off" ? value : null;
    else if (value && typeof value === "object") facts.climate = value as ClimateState;
  }
  return facts;
}

/** The stored facts for a device; `noFacts` unless every connection it uses is watched. */
export async function readDeviceFacts(
  db: D1DatabaseLike,
  shopId: string,
  device: Pick<Resource, "id" | "capabilities">,
): Promise<DeviceFacts> {
  const connections = haConnectionsOf(device);
  if (!connections.length || connections.includes("")) return noFacts;
  const [watched, stored] = (await db.batch([
    db
      .prepare(
        `SELECT connection_id FROM ha_event_connections
         WHERE shop_id = ? AND connection_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(shopId, JSON.stringify(connections)),
    db
      .prepare(
        `SELECT capability, key, value_json FROM device_state
         WHERE shop_id = ? AND device_id = ?
           AND ((capability = 'power' AND key = 'power') OR (capability = 'climate' AND key = 'view'))`,
      )
      .bind(shopId, device.id),
  ])) as [Rows<{ connection_id: string }>, Rows<StateRow>];
  return factsFrom(connections, new Set(watched.results.map((row) => row.connection_id)), stored.results);
}

/** The stored facts of every given device in two reads, for a view of the whole shop. */
export async function readShopFacts(
  db: D1DatabaseLike,
  shopId: string,
  devices: ReadonlyArray<Pick<Resource, "id" | "capabilities">>,
): Promise<Map<string, DeviceFacts>> {
  const [watched, stored] = (await db.batch([
    db.prepare("SELECT connection_id FROM ha_event_connections WHERE shop_id = ?").bind(shopId),
    db
      .prepare(
        `SELECT device_id, capability, key, value_json FROM device_state
         WHERE shop_id = ? AND ((capability = 'power' AND key = 'power') OR (capability = 'climate' AND key = 'view'))`,
      )
      .bind(shopId),
  ])) as [Rows<{ connection_id: string }>, Rows<StateRow & { device_id: string }>];
  const live = new Set(watched.results.map((row) => row.connection_id));
  const rowsByDevice = new Map<string, StateRow[]>();
  for (const row of stored.results) {
    const list = rowsByDevice.get(row.device_id) ?? [];
    list.push(row);
    rowsByDevice.set(row.device_id, list);
  }
  return new Map(devices.map((device) => [device.id, factsFrom(haConnectionsOf(device), live, rowsByDevice.get(device.id) ?? [])]));
}

/**
 * The board's view of a shop: every device with power or an air conditioner and
 * its stored facts, in two reads of state and one of devices. A device nothing
 * watches is `noFacts`.
 */
export async function readBoardStates(
  db: D1DatabaseLike,
  shopId: string,
): Promise<{ devices: Resource[]; states: Record<string, DeviceFacts> }> {
  const devices = (await listResources(db, shopId)).filter(
    (device) => device.capabilities.has("power") || device.capabilities.has("climate"),
  );
  const facts = await readShopFacts(db, shopId, devices);
  const states: Record<string, DeviceFacts> = {};
  for (const device of devices) states[device.id] = facts.get(device.id) ?? noFacts;
  return { devices, states };
}

/** The set of watched connections among `connectionIds`, for code that already has its own device rows. */
export async function watchedConnections(db: D1DatabaseLike, shopId: string): Promise<Set<string>> {
  const rows = (
    await db.prepare("SELECT connection_id FROM ha_event_connections WHERE shop_id = ?").bind(shopId).all<{ connection_id: string }>()
  ).results;
  return new Set(rows.map((row) => row.connection_id));
}

/** Move connections into or out of event mode, in one batch. */
export async function writeEventConnections(
  db: D1DatabaseLike,
  shopId: string,
  change: { add: readonly string[]; remove: readonly string[] },
  now = new Date(),
): Promise<void> {
  const statements = [
    ...change.add.map((id) =>
      db
        .prepare(
          `INSERT INTO ha_event_connections (shop_id, connection_id, since) VALUES (?, ?, ?)
           ON CONFLICT(shop_id, connection_id) DO NOTHING`,
        )
        .bind(shopId, id, now.toISOString()),
    ),
    ...change.remove.map((id) =>
      db.prepare("DELETE FROM ha_event_connections WHERE shop_id = ? AND connection_id = ?").bind(shopId, id),
    ),
  ];
  if (statements.length) await db.batch(statements);
}
