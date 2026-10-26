/**
 * Adoption of the per-shop device registries older deployments kept in
 * `app_settings` (`devices.homeassistant`, `devices.hinata_io`, `devices.ttlock`).
 *
 * Each registry entry becomes an ordinary device with one capability, under a
 * deterministic id, and the registry is removed in the same batch. From then on
 * there is one device list. Secrets have to be encrypted with the platform key,
 * which only the Worker holds, so this runs at first use rather than in a SQL
 * migration. Writing the registry again (a whole-document settings PUT from an
 * old client) simply queues those entries for adoption once more.
 */
import type { D1BoundStatementLike, D1DatabaseLike } from "@prism/adapter-d1";
import { decryptSecret, encryptSecret, sha256Hex } from "../../crypto.js";
import { normalizeHinataUrl } from "../../hardware/hinata.js";
import { listHaConnections, normalizeHaUrl } from "./ha-connections.js";

const REGISTRY_KEYS = ["devices.homeassistant", "devices.hinata_io", "devices.ttlock"] as const;

type Entry = {
  id: string;
  publicId: string;
  name: string;
  kind: "machine" | "door";
  aliases: string[];
  capability: "power" | "hinata_io" | "door";
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  /** Strings older commands may have recorded as the device id. */
  historyKeys: string[];
};

const adoptedByDatabase = new WeakMap<object, Set<string>>();

function parse(value: string | undefined): unknown {
  try {
    return value === undefined ? undefined : JSON.parse(value);
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

async function stableIds(shopId: string, prefix: string, key: string) {
  const digest = (await sha256Hex(`${shopId}:${key}`)).slice(0, 24);
  return { id: `legacy:${prefix}:${shopId}:${key}`, publicId: `legacy-${prefix}-${digest}` };
}

/** Entity ids already bound by an existing power capability, so they are not duplicated. */
async function boundEntities(db: D1DatabaseLike, shopId: string, key: string): Promise<Set<string>> {
  const rows = (
    await db
      .prepare(
        `SELECT json_extract(secret_json, '$.binding') AS binding,
                json_extract(config_json, '$.connectionId') AS connection_id,
                json_extract(config_json, '$.entityId') AS entity_id
         FROM device_capabilities WHERE shop_id = ? AND capability = 'power'`,
      )
      .bind(shopId)
      .all<{ binding: string | null; connection_id: string | null; entity_id: string | null }>()
  ).results;
  const entities = new Set<string>();
  const connections = new Map((await listHaConnections(db, shopId)).map((connection) => [connection.id, connection.url]));
  for (const row of rows) {
    if (row.connection_id && row.entity_id) {
      const url = connections.get(row.connection_id);
      if (url) entities.add(`${normalizeHaUrl(url)} ${row.entity_id}`);
      continue;
    }
    if (!row.binding) continue;
    try {
      const binding = record(JSON.parse(await decryptSecret(row.binding, key)));
      if (binding) entities.add(`${text(binding.url).replace(/\/+$/, "")} ${text(binding.entityId)}`);
    } catch {
      // An unreadable binding cannot be compared; adopt rather than drop.
    }
  }
  return entities;
}

async function plan(
  db: D1DatabaseLike,
  shopId: string,
  key: string,
  settings: Map<string, unknown>,
): Promise<Entry[]> {
  const entries: Entry[] = [];

  const ha = settings.get("devices.homeassistant");
  const connection = record(settings.get("devices.homeassistant_connection"));
  const url = text(connection?.url).replace(/\/+$/, "");
  const token = text(connection?.token);
  if (Array.isArray(ha) && ha.length && url && token) {
    const bound = await boundEntities(db, shopId, key);
    for (const raw of ha) {
      const item = record(raw);
      const entityId = text(item?.id);
      const name = text(item?.name);
      if (!entityId || !name || bound.has(`${url} ${entityId}`)) continue;
      const aliases = strings(item?.alias);
      entries.push({
        ...(await stableIds(shopId, "ha", entityId)),
        name,
        kind: "machine",
        // Bot users have always been able to name the HA entity itself.
        aliases: [...new Set([entityId, ...aliases])],
        capability: "power",
        config: {},
        secrets: { binding: await encryptSecret(JSON.stringify({ url, entityId, token }), key) },
        historyKeys: [entityId, name, ...aliases],
      });
    }
  }

  const io = settings.get("devices.hinata_io");
  for (const raw of Array.isArray(io) ? io : []) {
    const item = record(raw);
    const id = text(item?.id);
    const name = text(item?.name);
    const ioUrl = text(item?.url);
    if (!id || !name || !ioUrl) continue;
    const aliases = strings(item?.aliases);
    const password = text(item?.password);
    const coinKey = typeof item?.coinKey === "number" && Number.isInteger(item.coinKey) && item.coinKey >= 0 && item.coinKey <= 65535
      ? item.coinKey
      : 32;
    entries.push({
      ...(await stableIds(shopId, "io", id)),
      name,
      kind: "machine",
      aliases: [...new Set([id, ...aliases])],
      capability: "hinata_io",
      config: { transport: "external", coinKey, coinAfterSwipe: false },
      secrets: {
        url: await encryptSecret(normalizeHinataUrl(ioUrl), key),
        ...(password ? { password: await encryptSecret(password, key) } : {}),
      },
      historyKeys: [id, name, ...aliases],
    });
  }

  const locks = settings.get("devices.ttlock");
  for (const raw of Array.isArray(locks) ? locks : []) {
    const item = record(raw);
    const id = text(item?.id);
    const name = text(item?.name);
    const lockId = item?.lockId;
    if (!id || !name || typeof lockId !== "number" || !Number.isInteger(lockId) || lockId <= 0) continue;
    const aliases = strings(item?.aliases);
    entries.push({
      ...(await stableIds(shopId, "lock", id)),
      name,
      kind: "door",
      aliases: [...new Set([id, ...aliases])],
      capability: "door",
      config: { lockId },
      secrets: {},
      historyKeys: [id, name, ...aliases],
    });
  }
  return entries;
}

/**
 * Turn any registry entries of this shop into devices. Idempotent, and cheap
 * after the first call per isolate. Without the platform key nothing can be
 * encrypted, so the registry is left untouched for a later call.
 */
export async function adoptLegacyRegistries(input: {
  db: D1DatabaseLike;
  shopId: string;
  encryptionKey: string | undefined;
  now?: Date;
}): Promise<number> {
  const { db, shopId } = input;
  const adopted = adoptedByDatabase.get(db) ?? new Set<string>();
  adoptedByDatabase.set(db, adopted);
  if (adopted.has(shopId)) return 0;

  const rows = (
    await db
      .prepare(
        `SELECT key, value_json FROM app_settings
         WHERE shop_id = ? AND key IN ('devices.homeassistant', 'devices.homeassistant_connection', 'devices.hinata_io', 'devices.ttlock')`,
      )
      .bind(shopId)
      .all<{ key: string; value_json: string }>()
  ).results;
  const settings = new Map(rows.map((row) => [row.key, parse(row.value_json)]));
  if (!REGISTRY_KEYS.some((key) => settings.has(key))) {
    adopted.add(shopId);
    return 0;
  }
  if (!input.encryptionKey) return 0;

  const entries = await plan(db, shopId, input.encryptionKey, settings);
  const at = (input.now ?? new Date()).toISOString();
  const statements: D1BoundStatementLike[] = [];
  for (const entry of entries) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO machines(id, public_id, shop_id, name, enabled, kind, aliases_json, hinata_url_encrypted)
           VALUES (?, ?, ?, ?, 1, ?, ?, '')`,
        )
        .bind(entry.id, entry.publicId, shopId, entry.name, entry.kind, JSON.stringify(entry.aliases)),
      db
        .prepare(
          `INSERT OR IGNORE INTO device_capabilities
             (shop_id, device_id, capability, config_json, secret_json, credential_hash, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, NULL, ?, ? WHERE EXISTS (SELECT 1 FROM machines WHERE shop_id = ? AND id = ?)`,
        )
        .bind(shopId, entry.id, entry.capability, JSON.stringify(entry.config), JSON.stringify(entry.secrets), at, at, shopId, entry.id),
    );
    // Commands issued against the registry recorded its id (or the name typed
    // to the Bot) as the device. Point that history at the adopted device.
    for (const key of new Set(entry.historyKeys.map((value) => value.toLowerCase()))) {
      for (const table of ["device_operations", "device_events"]) {
        statements.push(
          db
            .prepare(
              `UPDATE ${table} SET device_id = ?
               WHERE shop_id = ? AND lower(trim(device_id)) = ?
                 AND device_id NOT IN (SELECT id FROM machines WHERE shop_id = ?)`,
            )
            .bind(entry.id, shopId, key, shopId),
        );
      }
    }
  }
  statements.push(
    db
      .prepare(`DELETE FROM app_settings WHERE shop_id = ? AND key IN (SELECT value FROM json_each(?))`)
      .bind(shopId, JSON.stringify(REGISTRY_KEYS)),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    // e.g. a shop export holds its write lock. The registry stays and the
    // next call tries again; until then its entries are simply not listed.
    console.error(JSON.stringify({
      event: "legacy_device_registry_adoption_failed",
      shopId,
      message: error instanceof Error ? error.message : String(error),
    }));
    return 0;
  }
  adopted.add(shopId);
  return entries.length;
}
