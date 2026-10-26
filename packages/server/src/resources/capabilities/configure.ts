/**
 * Writing capability bindings. Reading goes through `device.ts`; this is the
 * only place that writes `device_capabilities`, so every stored config has
 * passed the catalog's schema.
 */
import type { D1BoundStatementLike, D1DatabaseLike } from "@prism/adapter-d1";
import { capabilitySpec, type CapabilityId } from "./capabilities.js";

/** A capability exactly as stored: secrets are still encrypted. */
export type StoredCapability = {
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  credentialHash: string | null;
};

function parseObject(value: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value ?? "{}");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function storedCapabilities(
  db: D1DatabaseLike,
  shopId: string,
  deviceId: string,
): Promise<Map<CapabilityId, StoredCapability>> {
  const rows = (
    await db
      .prepare(
        `SELECT capability, config_json, secret_json, credential_hash
         FROM device_capabilities WHERE shop_id = ? AND device_id = ?`,
      )
      .bind(shopId, deviceId)
      .all<{ capability: string; config_json: string; secret_json: string; credential_hash: string | null }>()
  ).results;
  const stored = new Map<CapabilityId, StoredCapability>();
  for (const row of rows) {
    const spec = capabilitySpec(row.capability);
    if (!spec) continue;
    const secrets = Object.fromEntries(
      Object.entries(parseObject(row.secret_json)).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && !!entry[1],
      ),
    );
    stored.set(spec.id, { config: parseObject(row.config_json), secrets, credentialHash: row.credential_hash });
  }
  return stored;
}

/**
 * Statements that make the device's capabilities exactly `next`. A capability
 * missing from `next` is unbound. Throws when a config does not match the catalog.
 */
export function capabilityWrites(
  db: D1DatabaseLike,
  input: {
    shopId: string;
    deviceId: string;
    next: ReadonlyMap<CapabilityId, StoredCapability>;
    now: Date;
  },
): D1BoundStatementLike[] {
  const at = input.now.toISOString();
  const statements: D1BoundStatementLike[] = [];
  const kept: string[] = [];
  for (const [id, capability] of input.next) {
    const spec = capabilitySpec(id)!;
    const config = spec.config.parse(capability.config);
    const unknownSecret = Object.keys(capability.secrets).find((name) => !spec.secrets.includes(name));
    if (unknownSecret) throw new Error(`Capability ${id} has no secret named ${unknownSecret}`);
    kept.push(id);
    statements.push(
      db
        .prepare(
          `INSERT INTO device_capabilities
             (shop_id, device_id, capability, config_json, secret_json, credential_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(shop_id, device_id, capability) DO UPDATE SET
             config_json = excluded.config_json,
             secret_json = excluded.secret_json,
             credential_hash = excluded.credential_hash,
             updated_at = excluded.updated_at`,
        )
        .bind(
          input.shopId,
          input.deviceId,
          id,
          JSON.stringify(config),
          JSON.stringify(capability.secrets),
          capability.credentialHash,
          at,
          at,
        ),
    );
  }
  statements.push(
    db
      .prepare(
        `DELETE FROM device_capabilities
         WHERE shop_id = ? AND device_id = ? AND capability NOT IN (SELECT value FROM json_each(?))`,
      )
      .bind(input.shopId, input.deviceId, JSON.stringify(kept)),
  );
  return statements;
}
