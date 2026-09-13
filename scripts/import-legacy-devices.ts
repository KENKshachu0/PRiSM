import { Database } from "bun:sqlite";
import { encryptSecret, sha256Hex } from "../packages/platform/src/crypto.ts";

type LegacyDevice = {
  id?: unknown;
  name?: unknown;
  alias?: unknown;
};

type LegacyConnection = {
  url?: unknown;
  token?: unknown;
};

export type LegacyDeviceImportOptions = {
  sqlitePath: string;
  shopId: string;
  encryptionKey: string;
  sqlOut?: string;
};

export type LegacyDeviceImportReport = {
  shopId: string;
  imported: number;
  updated: number;
  mapped: {
    deviceCommands: number;
    deviceStates: number;
    machineConnections: number;
  };
  sqlOut?: string;
};

type PlannedDevice = {
  id: string;
  publicId: string;
  name: string;
  binding: string;
  lookupKeys: string[];
};

const requiredMachineColumns = [
  "id",
  "public_id",
  "shop_id",
  "name",
  "hinata_url_encrypted",
  "enabled",
  "kind",
  "ha_binding_encrypted",
  "coin_key",
  "coin_after_swipe",
];

function sqlLiteral(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`${label} contains invalid JSON`, { cause: error });
  }
}

function tableColumns(db: Database, table: string): Set<string> {
  return new Set(
    (db.query(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
}

function ensureColumns(db: Database, table: string, required: readonly string[]): void {
  const columns = tableColumns(db, table);
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length) throw new Error(`${table} is missing columns: ${missing.join(", ")}`);
}

async function planDevices(
  db: Database,
  shopId: string,
  encryptionKey: string,
): Promise<PlannedDevice[]> {
  const setting = db
    .query("SELECT value_json FROM app_settings WHERE shop_id=? AND key='devices.homeassistant'")
    .get(shopId) as { value_json: string } | null;
  if (!setting) return [];

  const devices = parseJson<unknown>(setting.value_json, "devices.homeassistant");
  if (!Array.isArray(devices)) throw new Error("devices.homeassistant must be an array");
  if (!devices.length) return [];
  if (!encryptionKey) throw new Error("URL_ENCRYPTION_KEY is required to import HA devices");

  const connectionSetting = db
    .query("SELECT value_json FROM app_settings WHERE shop_id=? AND key='devices.homeassistant_connection'")
    .get(shopId) as { value_json: string } | null;
  if (!connectionSetting) throw new Error("devices.homeassistant_connection is required");
  const connection = parseJson<LegacyConnection>(
    connectionSetting.value_json,
    "devices.homeassistant_connection",
  );
  const url = stringValue(connection.url, "devices.homeassistant_connection.url");
  const token = stringValue(connection.token, "devices.homeassistant_connection.token");
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("devices.homeassistant_connection.url must use HTTP or HTTPS");
  }

  const keys = new Map<string, string>();
  const ids = new Set<string>();
  const result: PlannedDevice[] = [];
  for (const raw of devices as LegacyDevice[]) {
    if (!raw || typeof raw !== "object") throw new Error("devices.homeassistant entries must be objects");
    const id = stringValue(raw.id, "devices.homeassistant[].id");
    const name = stringValue(raw.name, `device ${id} name`);
    if (ids.has(id)) throw new Error(`Duplicate Home Assistant entity id: ${id}`);
    ids.add(id);
    if (!/^(switch|input_boolean)\.[a-z0-9_]+$/.test(id)) {
      throw new Error(`Unsupported Home Assistant entity id: ${id}`);
    }
    const aliases = raw.alias === undefined ? [] : raw.alias;
    if (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== "string")) {
      throw new Error(`devices.homeassistant[].alias must be an array for ${id}`);
    }
    const lookupKeys = [id, name, ...(aliases as string[])]
      .map(normalized)
      .filter(Boolean);
    for (const key of lookupKeys) {
      const previous = keys.get(key);
      if (previous && previous !== id) throw new Error(`Duplicate legacy device alias: ${key}`);
      keys.set(key, id);
    }
    const publicId = `legacy-ha-${(await sha256Hex(`${shopId}:${id}`)).slice(0, 24)}`;
    const binding = await encryptSecret(JSON.stringify({ url, entityId: id, token }), encryptionKey);
    result.push({
      id: `legacy:ha:${shopId}:${id}`,
      publicId,
      name,
      binding,
      lookupKeys: [...new Set(lookupKeys)],
    });
  }
  return result;
}

function machineStatement(device: PlannedDevice, shopId: string): string {
  const columns = [
    "id",
    "public_id",
    "shop_id",
    "name",
    "hinata_url_encrypted",
    "enabled",
    "kind",
    "ha_binding_encrypted",
    "coin_key",
    "coin_after_swipe",
  ];
  const values: Array<string | number | null> = [
    device.id,
    device.publicId,
    shopId,
    device.name,
    "",
    1,
    "machine",
    device.binding,
    0,
    0,
  ];
  return `INSERT INTO machines (${columns.join(",")}) VALUES (${values.map(sqlLiteral).join(",")}) ` +
    "ON CONFLICT(public_id) DO UPDATE SET name=excluded.name,ha_binding_encrypted=excluded.ha_binding_encrypted,enabled=excluded.enabled,updated_at=CURRENT_TIMESTAMP;";
}

function mapStatement(table: string, column: string, shopId: string, key: string, machineId: string): string {
  return `UPDATE ${table} SET ${column}=${sqlLiteral(machineId)} WHERE shop_id=${sqlLiteral(shopId)} AND lower(trim(${column}))=${sqlLiteral(normalized(key))};`;
}

function runMapping(
  db: Database,
  table: string,
  column: string,
  shopId: string,
  key: string,
  machineId: string,
): number {
  return (db.query(
    `UPDATE ${table} SET ${column}=? WHERE shop_id=? AND lower(trim(${column}))=?`,
  ).run(machineId, shopId, normalized(key)) as { changes?: number }).changes ?? 0;
}

export async function importLegacyDevices(
  options: LegacyDeviceImportOptions,
): Promise<LegacyDeviceImportReport> {
  const db = new Database(options.sqlitePath);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    ensureColumns(db, "machines", requiredMachineColumns);
    const shop = db.query("SELECT id FROM shops WHERE id=?").get(options.shopId) as { id: string } | null;
    if (!shop) throw new Error(`Shop not found: ${options.shopId}`);
    const planned = await planDevices(db, options.shopId, options.encryptionKey);
    const report: LegacyDeviceImportReport = {
      shopId: options.shopId,
      imported: 0,
      updated: 0,
      mapped: { deviceCommands: 0, deviceStates: 0, machineConnections: 0 },
      ...(options.sqlOut ? { sqlOut: options.sqlOut } : {}),
    };
    if (!planned.length) {
      if (options.sqlOut) await Bun.write(options.sqlOut, "PRAGMA foreign_keys=ON;\n");
      return report;
    }

    const statements = ["PRAGMA foreign_keys=ON;", "PRAGMA defer_foreign_keys=ON;", "BEGIN;"];
    try {
      db.exec("BEGIN");
      for (const device of planned) {
        const existing = db.query("SELECT id FROM machines WHERE public_id=?").get(device.publicId);
        db.query(
          "INSERT INTO machines (id,public_id,shop_id,name,hinata_url_encrypted,enabled,kind,ha_binding_encrypted,coin_key,coin_after_swipe) VALUES (?,?,?,?,?,?,?,?,?,?) " +
            "ON CONFLICT(public_id) DO UPDATE SET name=excluded.name,ha_binding_encrypted=excluded.ha_binding_encrypted,enabled=excluded.enabled,updated_at=CURRENT_TIMESTAMP",
        ).run(
          device.id,
          device.publicId,
          options.shopId,
          device.name,
          "",
          1,
          "machine",
          device.binding,
          0,
          0,
        );
        if (existing) report.updated += 1;
        else report.imported += 1;
        statements.push(machineStatement(device, options.shopId));
        for (const key of device.lookupKeys) {
          report.mapped.deviceCommands += runMapping(db, "device_commands", "device_id", options.shopId, key, device.id);
          report.mapped.deviceStates += runMapping(db, "device_states", "device_id", options.shopId, key, device.id);
          report.mapped.machineConnections += runMapping(db, "machine_connections", "machine_id", options.shopId, key, device.id);
          statements.push(mapStatement("device_commands", "device_id", options.shopId, key, device.id));
          statements.push(mapStatement("device_states", "device_id", options.shopId, key, device.id));
          statements.push(mapStatement("machine_connections", "machine_id", options.shopId, key, device.id));
        }
      }
      db.exec("COMMIT");
      statements.push("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    if (options.sqlOut) await Bun.write(options.sqlOut, `${statements.join("\n")}\n`);
    return report;
  } finally {
    db.close();
  }
}

function parseArgs(argv: string[]): LegacyDeviceImportOptions {
  let sqlitePath = "";
  let shopId = "";
  let sqlOut: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--sqlite") sqlitePath = next ?? "";
    else if (arg === "--shop-id") shopId = next ?? "";
    else if (arg === "--sql-out") sqlOut = next;
    else throw new Error(`Unknown argument: ${arg}`);
    index += 1;
  }
  if (!sqlitePath || !shopId) throw new Error("Usage: --sqlite <path> --shop-id <id> [--sql-out <path>]");
  const encryptionKey = process.env.URL_ENCRYPTION_KEY ?? "";
  if (!encryptionKey) throw new Error("Set URL_ENCRYPTION_KEY in the environment");
  return { sqlitePath, shopId, encryptionKey, ...(sqlOut ? { sqlOut } : {}) };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await importLegacyDevices(parseArgs(Bun.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
