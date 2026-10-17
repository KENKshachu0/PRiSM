import type { LegacyD1Database as D1Database, LegacyD1PreparedStatement as D1PreparedStatement } from "./compat.js";
import { businessTables } from "./shop-data-format.js";
import { schemas, type FullTable } from "./shop-data-v2-format.js";

// Suspended only inside the same atomic batch that replaces a shop and restores the triggers.
export const restoreTriggerNames = [
  "pricing_config_version_insert",
  "pricing_config_version_delete",
  "session_pricing_bind",
  "pricing_config_versions_immutable_delete",
  "pricing_releases_immutable_delete",
  "session_pricing_releases_immutable_delete",
] as const;

export function replaceBusinessStatements(
  db: D1Database,
  shopId: string,
  userId: string,
  full: boolean,
) {
  const statements: D1PreparedStatement[] = [];
  const remove = (table: string) =>
    statements.push(
      db.prepare(`DELETE FROM ${table} WHERE shop_id=?`).bind(shopId),
    );
  // Platform credentials and monthly allowance / operation receipts are never reset.
  for (const table of [
    "shop_platform_bindings",
    "shop_player_accounts",
    "shop_imported_accounts",
    "platform_binding_codes",
    "player_sessions",
    "live_activity_tokens",
    "mahjong_seats",
    "device_events",
    "device_operations",
    "device_state",
    "checkout_report_states",
  ])
    remove(table);
  if (full) {
    statements.push(
      db
        .prepare(
          "DELETE FROM machine_tickets WHERE machine_id IN (SELECT id FROM machines WHERE shop_id=?)",
        )
        .bind(shopId),
    );
    statements.push(
      db
        .prepare(
          "UPDATE player_operations SET device_id=NULL WHERE shop_id=? AND device_id IS NOT NULL",
        )
        .bind(shopId),
    );
    remove("device_capabilities");
    remove("machines");
    remove("api_tokens");
    remove("admin_sessions");
    // Retain the current administrator and all existing target owners.
    statements.push(
      db
        .prepare(
          `DELETE FROM shop_staff_accounts WHERE shop_id=? AND user_id!=?
      AND user_id NOT IN (SELECT user_id FROM shop_members WHERE shop_id=? AND role='owner')`,
        )
        .bind(shopId, userId, shopId),
    );
    statements.push(
      db
        .prepare(
          "DELETE FROM staff_users WHERE shop_id=? AND id NOT IN (SELECT staff_id FROM shop_staff_accounts WHERE shop_id=?)",
        )
        .bind(shopId, shopId),
    );
    statements.push(
      db
        .prepare(
          "DELETE FROM shop_members WHERE shop_id=? AND role!='owner' AND user_id!=?",
        )
        .bind(shopId, userId),
    );
  }
  for (const table of [...businessTables].reverse()) remove(table);
  if (full) {
    remove("app_settings");
    remove("shop_billing_settings");
  } else {
    statements.push(
      db
        .prepare(
          "DELETE FROM app_settings WHERE shop_id=? AND key='backup.importedAccounts'",
        )
        .bind(shopId),
    );
  }
  return statements;
}

/** Configuration-only copies overwrite matching keys while keeping historical references valid. */
export function configurationConflict(
  table: FullTable,
  columns = schemas[table].columns.map((column) => column.name),
) {
  const key = schemas[table].keys[0]!;
  return (
    ` ON CONFLICT(${table === "machines" ? "id" : "shop_id" + (key.length ? "," + key.join(",") : "")}) DO UPDATE SET ` +
    columns
      .filter((column) => !key.includes(column))
      .map((column) => `${column}=excluded.${column}`)
      .join(",")
  );
}
