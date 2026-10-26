/**
 * Home Assistant connections are shop-level: one address and control token per
 * Home Assistant, shared by every power and air-conditioner capability that
 * points at one of its entities. A capability stores only `connectionId` and
 * `entityId`.
 *
 * Each connection is its own `app_settings` row (`devices.ha_connection:<id>`)
 * so two saves never overwrite each other's list. Tokens are encrypted with the
 * platform key like capability secrets; backups decrypt and re-seal them.
 *
 * Bindings written before connections existed kept url, token and entity in the
 * capability's `binding` secret. They keep working as they are and are moved
 * onto a connection the next time the shop's device list is read.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import { decryptSecret, encryptSecret, sha256Hex } from "../../crypto.js";

export const HA_CONNECTION_PREFIX = "devices.ha_connection:";

/** Fields of a connection row that hold sealed values. */
export const HA_CONNECTION_SECRETS = ["token", "readToken"] as const;

/**
 * Whether live state can be read with a token that cannot switch anything.
 * `needs_admin`: the control token is not an administrator's, so the read-only
 * account could not be created automatically.
 */
export type ReadAccess = "ready" | "needs_admin" | "failed";

export type StoredHaConnection = {
  id: string;
  url: string;
  /** Home Assistant's own `internal_url`, for clients inside the shop. */
  internalUrl: string | null;
  /** Sealed control token. */
  token: string;
  /** Sealed read-only token. */
  readToken: string | null;
  readUserId: string | null;
  readAccess: ReadAccess | null;
  readError: string | null;
  updatedAt: string;
};

export type OpenHaConnection = {
  id: string;
  url: string;
  internalUrl: string | null;
  token: string;
  readToken: string | null;
};

export const normalizeHaUrl = (url: string) => url.trim().replace(/\/+$/, "");

function parse(value: string): StoredHaConnection | null {
  try {
    const row = JSON.parse(value) as Partial<StoredHaConnection>;
    if (typeof row.id !== "string" || typeof row.url !== "string" || typeof row.token !== "string") return null;
    return {
      id: row.id,
      url: row.url,
      internalUrl: typeof row.internalUrl === "string" ? row.internalUrl : null,
      token: row.token,
      readToken: typeof row.readToken === "string" ? row.readToken : null,
      readUserId: typeof row.readUserId === "string" ? row.readUserId : null,
      readAccess: row.readAccess === "ready" || row.readAccess === "needs_admin" || row.readAccess === "failed"
        ? row.readAccess
        : null,
      readError: typeof row.readError === "string" ? row.readError : null,
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
    };
  } catch {
    return null;
  }
}

export async function listHaConnections(db: D1DatabaseLike, shopId: string): Promise<StoredHaConnection[]> {
  const rows = (
    await db
      .prepare("SELECT value_json FROM app_settings WHERE shop_id = ? AND key LIKE ? ORDER BY key")
      .bind(shopId, `${HA_CONNECTION_PREFIX}%`)
      .all<{ value_json: string }>()
  ).results;
  return rows.map((row) => parse(row.value_json)).filter((row): row is StoredHaConnection => !!row);
}

export async function getHaConnection(db: D1DatabaseLike, shopId: string, id: string): Promise<StoredHaConnection | null> {
  const row = await db
    .prepare("SELECT value_json FROM app_settings WHERE shop_id = ? AND key = ?")
    .bind(shopId, HA_CONNECTION_PREFIX + id)
    .first<{ value_json: string }>();
  return row ? parse(row.value_json) : null;
}

export function writeHaConnection(db: D1DatabaseLike, shopId: string, connection: StoredHaConnection) {
  return db
    .prepare(
      `INSERT INTO app_settings(shop_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(shop_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .bind(shopId, HA_CONNECTION_PREFIX + connection.id, JSON.stringify(connection), connection.updatedAt);
}

export function deleteHaConnection(db: D1DatabaseLike, shopId: string, id: string) {
  return db.prepare("DELETE FROM app_settings WHERE shop_id = ? AND key = ?").bind(shopId, HA_CONNECTION_PREFIX + id);
}

/** Decrypt a connection for use. Null when it is missing or the key cannot open it. */
export async function openHaConnection(
  db: D1DatabaseLike,
  shopId: string,
  id: string,
  key: string | undefined,
): Promise<OpenHaConnection | null> {
  if (!key) return null;
  const stored = await getHaConnection(db, shopId, id);
  if (!stored) return null;
  try {
    return {
      id: stored.id,
      url: stored.url,
      internalUrl: stored.internalUrl,
      token: await decryptSecret(stored.token, key),
      readToken: stored.readToken ? await decryptSecret(stored.readToken, key) : null,
    };
  } catch {
    return null;
  }
}

/**
 * A connection id that is the same for the same address and token, so adopting
 * old bindings twice, or from two requests at once, lands on one connection.
 */
export async function connectionIdFor(url: string, token: string) {
  return `ha_${(await sha256Hex(`${normalizeHaUrl(url)}\n${token}`)).slice(0, 20)}`;
}

/** A new connection row for an address and plain token. */
export async function newHaConnection(url: string, token: string, key: string, now = new Date()): Promise<StoredHaConnection> {
  return {
    id: await connectionIdFor(url, token),
    url: normalizeHaUrl(url),
    internalUrl: null,
    token: await encryptSecret(token, key),
    readToken: null,
    readUserId: null,
    readAccess: null,
    readError: null,
    updatedAt: now.toISOString(),
  };
}

/**
 * The connection for this address, using `token` when given. Without a token the
 * shop's existing connection to the address is reused; with one, a connection
 * whose token matches is reused or a new one is made.
 */
export async function resolveHaConnection(
  db: D1DatabaseLike,
  shopId: string,
  key: string,
  input: { url: string; token?: string | null },
): Promise<{ connection: StoredHaConnection; created: boolean } | null> {
  const url = normalizeHaUrl(input.url);
  const existing = (await listHaConnections(db, shopId)).filter((c) => c.url === url);
  if (!input.token) return existing[0] ? { connection: existing[0], created: false } : null;
  for (const connection of existing) {
    try {
      if ((await decryptSecret(connection.token, key)) === input.token) return { connection, created: false };
    } catch {
      // Sealed under another key; it cannot match.
    }
  }
  return { connection: await newHaConnection(url, input.token, key), created: true };
}

type LegacyRow = { device_id: string; capability: string; config_json: string; secret_json: string };

/**
 * Move bindings that still carry url and token in the capability secret onto
 * shop connections. Each capability is rewritten only if it is unchanged since
 * it was read, so a concurrent device save always wins.
 */
export async function adoptHaBindings(db: D1DatabaseLike, shopId: string, key: string | undefined): Promise<void> {
  if (!key) return;
  const rows = (
    await db
      .prepare(
        `SELECT device_id, capability, config_json, secret_json FROM device_capabilities
         WHERE shop_id = ? AND capability IN ('power', 'climate') AND json_extract(secret_json, '$.binding') IS NOT NULL`,
      )
      .bind(shopId)
      .all<LegacyRow>()
  ).results;
  if (!rows.length) return;
  const created = new Map<string, StoredHaConnection>();
  const known = new Set<string>();
  const statements = [];
  for (const row of rows) {
    let binding: { url?: unknown; token?: unknown; entityId?: unknown };
    try {
      binding = JSON.parse(await decryptSecret(String(JSON.parse(row.secret_json).binding), key));
    } catch {
      continue;
    }
    if (typeof binding.url !== "string" || typeof binding.token !== "string" || typeof binding.entityId !== "string") continue;
    const id = await connectionIdFor(binding.url, binding.token);
    if (!known.has(id) && !created.has(id)) {
      if (await getHaConnection(db, shopId, id)) known.add(id);
      else created.set(id, await newHaConnection(binding.url, binding.token, key));
    }
    statements.push(
      db
        .prepare(
          `UPDATE device_capabilities SET config_json = ?, secret_json = '{}', updated_at = ?
           WHERE shop_id = ? AND device_id = ? AND capability = ? AND secret_json = ?`,
        )
        .bind(
          JSON.stringify({ connectionId: id, entityId: binding.entityId }),
          new Date().toISOString(),
          shopId,
          row.device_id,
          row.capability,
          row.secret_json,
        ),
    );
  }
  if (!statements.length) return;
  await db.batch([...[...created.values()].map((c) => writeHaConnection(db, shopId, c)), ...statements]);
}
