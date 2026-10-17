/**
 * A device as the rest of the platform sees it: identity plus the capabilities
 * bound to it. Nothing outside this module reads capability storage directly,
 * so "what can this device do" has exactly one answer.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import { decryptSecret } from "../crypto.js";
import { adoptLegacyRegistries } from "./legacy-registries.js";
import {
  capabilities,
  capabilitySpec,
  type ActionName,
  type CapabilityId,
  type DoorConfig,
  type HinataConfig,
  type MahjongConfig,
} from "./capabilities.js";

export type BoundCapability = {
  id: CapabilityId;
  config: Record<string, unknown>;
  /** Names of secrets present. The values stay encrypted until `secret()` is called. */
  secretNames: ReadonlySet<string>;
  credentialHash: string | null;
};

export type Device = {
  id: string;
  shopId: string;
  publicId: string;
  name: string;
  aliases: string[];
  enabled: boolean;
  kind: string;
  capabilities: ReadonlyMap<CapabilityId, BoundCapability>;
};

type DeviceRow = {
  id: string;
  shop_id: string;
  public_id: string;
  name: string;
  aliases_json: string | null;
  enabled: number;
  kind: string;
};

type CapabilityRow = {
  device_id: string;
  capability: string;
  config_json: string;
  secret_json: string;
  credential_hash: string | null;
};

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseAliases(value: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function bind(row: CapabilityRow): BoundCapability | null {
  const spec = capabilitySpec(row.capability);
  // A capability this release does not know is ignored rather than guessed at.
  if (!spec) return null;
  const parsed = spec.config.safeParse(parseObject(row.config_json));
  if (!parsed.success) return null;
  const secrets = parseObject(row.secret_json);
  return {
    id: spec.id,
    config: parsed.data as Record<string, unknown>,
    secretNames: new Set(Object.keys(secrets).filter((key) => typeof secrets[key] === "string" && secrets[key])),
    credentialHash: row.credential_hash,
  };
}

const deviceColumns = "id, shop_id, public_id, name, aliases_json, enabled, kind";

async function assemble(db: D1DatabaseLike, shopId: string, rows: DeviceRow[]): Promise<Device[]> {
  if (!rows.length) return [];
  const capabilityRows = (
    await db
      .prepare(
        `SELECT device_id, capability, config_json, secret_json, credential_hash
         FROM device_capabilities WHERE shop_id = ? AND device_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(shopId, JSON.stringify(rows.map((row) => row.id)))
      .all<CapabilityRow>()
  ).results;
  const byDevice = new Map<string, Map<CapabilityId, BoundCapability>>();
  for (const row of capabilityRows) {
    const bound = bind(row);
    if (!bound) continue;
    const map = byDevice.get(row.device_id) ?? new Map<CapabilityId, BoundCapability>();
    map.set(bound.id, bound);
    byDevice.set(row.device_id, map);
  }
  return rows.map((row) => ({
    id: row.id,
    shopId: row.shop_id,
    publicId: row.public_id,
    name: row.name,
    aliases: parseAliases(row.aliases_json),
    enabled: row.enabled === 1,
    kind: row.kind,
    capabilities: byDevice.get(row.id) ?? new Map(),
  }));
}

export async function loadDevice(db: D1DatabaseLike, shopId: string, deviceId: string): Promise<Device | null> {
  const row = await db
    .prepare(`SELECT ${deviceColumns} FROM machines WHERE shop_id = ? AND id = ?`)
    .bind(shopId, deviceId)
    .first<DeviceRow>();
  return row ? (await assemble(db, shopId, [row]))[0]! : null;
}

/**
 * Every device of a shop. Registry entries left by older deployments are
 * adopted as devices first, so a listing is always complete.
 */
export async function loadDevices(
  db: D1DatabaseLike,
  shopId: string,
  encryptionKey: string | undefined,
): Promise<Device[]> {
  await adoptLegacyRegistries({ db, shopId, encryptionKey });
  const rows = (
    await db
      .prepare(`SELECT ${deviceColumns} FROM machines WHERE shop_id = ? ORDER BY created_at, id`)
      .bind(shopId)
      .all<DeviceRow>()
  ).results;
  return assemble(db, shopId, rows);
}

export function has(device: Device, capability: CapabilityId): boolean {
  return device.capabilities.has(capability);
}

/** Whether the device offers an action right now, given its bound capabilities. */
export function can(device: Device, action: ActionName): boolean {
  for (const [id, bound] of device.capabilities) {
    const spec = capabilities[id];
    if (!(action in spec.actions)) continue;
    return (spec.available as (a: ActionName, c: unknown, s: ReadonlySet<string>) => boolean)(
      action,
      bound.config,
      bound.secretNames,
    );
  }
  return false;
}

export function hinataConfigOf(device: Device): HinataConfig | null {
  return (device.capabilities.get("hinata_io")?.config as HinataConfig | undefined) ?? null;
}

export function doorConfigOf(device: Device): DoorConfig | null {
  return (device.capabilities.get("door")?.config as DoorConfig | undefined) ?? null;
}

export function mahjongConfigOf(device: Device): MahjongConfig | null {
  return (device.capabilities.get("mahjong")?.config as MahjongConfig | undefined) ?? null;
}

/** Decrypt one secret of a bound capability. Reads storage, so only call when acting. */
export async function readSecret(
  db: D1DatabaseLike,
  device: Pick<Device, "id" | "shopId">,
  capability: CapabilityId,
  name: string,
  encryptionKey: string | undefined,
): Promise<string | null> {
  if (!encryptionKey) return null;
  const row = await db
    .prepare(`SELECT secret_json FROM device_capabilities WHERE shop_id = ? AND device_id = ? AND capability = ?`)
    .bind(device.shopId, device.id, capability)
    .first<{ secret_json: string }>();
  const value = parseObject(row?.secret_json ?? null)[name];
  if (typeof value !== "string" || !value) return null;
  try {
    return await decryptSecret(value, encryptionKey);
  } catch {
    return null;
  }
}

/** Case- and space-insensitive device lookup by id, public id, name or alias. */
export function matchesRef(device: Device, ref: string): boolean {
  const target = ref.trim().toLowerCase();
  if (!target) return false;
  return [device.id, device.publicId, device.name, ...device.aliases].some(
    (value) => value.trim().toLowerCase() === target,
  );
}

/** The capability flags the player page and native apps have always received. */
export function publicCapabilities(device: Device) {
  return {
    power: has(device, "power"),
    card: can(device, "aime.scan"),
    coin: can(device, "coin"),
    door: can(device, "door.open"),
    mahjong: has(device, "mahjong"),
  };
}
