import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { centsOf } from "@prism/core";
import { sqliteSchema } from "../src/index";

describe("sqliteSchema", () => {
  it("preserves assets linked to pricing effects during tenant migration", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys=ON");
    const root = resolve(import.meta.dir, "../../../migrations");
    for (const name of readdirSync(root).filter(name => name.endsWith(".sql") && name < "0016_").sort()) {
      runMigrationFile(db, resolve(root, name));
    }
    db.run("INSERT INTO pricing_effects(id,name,type,scope,value) VALUES('effect','Discount','discount','session',5)");
    db.run("INSERT INTO asset_definitions(type,code,name,pricing_effect_id) VALUES('item','coupon','Coupon','effect')");
    runMigrationFile(db, resolve(root, "0016_shop_scoped_billing.sql"));
    expect(db.query("SELECT shop_id,pricing_effect_id FROM asset_definitions WHERE code='coupon'").get())
      .toEqual({ shop_id: "legacy", pricing_effect_id: "effect" });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("creates the core tables needed by both SQLite and D1 adapters", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    for (const statement of sqliteSchema) {
      db.run(statement);
    }

    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);

    expect(tables).toEqual([
      "admin_sessions",
      "api_tokens",
      "app_settings",
      "asset_definitions",
      "asset_holdings",
      "asset_ledger_entries",
      "asset_transactions",
      "business_item_orders",
      "business_items",
      "device_commands",
      "device_states",
      "machine_connections",
      "operation_locks",
      "player_checkouts",
      "player_identities",
      "player_sessions",
      "players",
      "presents",
      "pricing_cap_history_entries",
      "pricing_configs",
      "pricing_effects",
      "pricing_history_entries",
      "redeem_codes",
      "redeem_records",
      "sessions",
      "settlement_adjustments",
      "settlement_charge_items",
      "settlements",
      "staff_users",
    ]);
  });

  it("keeps D1 migrations aligned with the runtime schema for setup, assets, and gift windows", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    for (const fileName of readdirSync(resolve(import.meta.dir, "../../../migrations")).filter((name) => name.endsWith(".sql")).sort()) {
      const migrationSql = readFileSync(resolve(import.meta.dir, "../../../migrations", fileName), "utf8");
      for (const statement of migrationSql.split(";").map((item) => item.trim()).filter(Boolean)) {
        db.run(statement);
      }
    }

    const columns = (tableName: string) =>
      db
        .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?) ORDER BY cid")
        .all(tableName)
        .map((row) => row.name);

    expect(columns("staff_users")).toEqual(["shop_id",
      "id",
      "username",
      "display_name",
      "password_hash",
      "password_salt",
      "role",
      "status",
      "created_at",
      "updated_at",
    ]);
    expect(columns("admin_sessions")).toContain("token_hash");
    expect(columns("api_tokens")).toContain("token_hash");
    expect(columns("app_settings")).toEqual(["shop_id", "key", "value_json", "updated_at"]);
    expect(columns("asset_definitions")).toContain("status");
    expect(columns("asset_definitions")).toContain("pricing_effect_id");
    expect(columns("asset_definitions")).toContain("active_at");
    expect(columns("asset_definitions")).toContain("expires_at");
    expect(columns("pricing_effects")).toEqual(["shop_id",
      "id",
      "name",
      "type",
      "scope",
      "value",
      "consumable",
      "limit_per_day",
      "active_at",
      "expires_at",
      "status",
      "config_json",
    ]);
    expect(columns("business_items")).toContain("status");
    expect(columns("business_items")).toContain("metadata_json");
    expect(columns("business_item_orders")).toContain("business_item_id");
    expect(columns("business_item_orders")).toContain("status");
    expect(columns("presents")).toContain("status");
    expect(columns("presents")).toContain("active_at");
    expect(columns("presents")).toContain("expires_at");
    expect(columns("pricing_configs")).toContain("status");
    expect(columns("sessions")).toEqual(["shop_id",
      "id",
      "player_id",
      "started_at",
      "ended_at",
      "status",
      "pricing_config_ids_json",
      "payment_status",
      "label",
      "metadata_json",
    ]);
    expect(columns("pricing_history_entries")).toEqual(["shop_id",
      "id",
      "player_id",
      "pricing_config_id",
      "provider_id",
      "rule_id",
      "rule_anchor_at",
      "session_id",
      "amount",
      "created_at",
      "metadata_json",
    ]);
    expect(columns("pricing_cap_history_entries")).toEqual(["shop_id",
      "id",
      "player_id",
      "cap_config_id",
      "cap_rule_id",
      "cap_anchor_at",
      "included_pricing_config_ids_json",
      "session_ids_json",
      "amount",
      "created_at",
      "metadata_json",
    ]);

    expect(() => db.run(
      "INSERT INTO device_commands (id, type, device_id, target_kind, executor_kind, status, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["hinata-command", "coin", "machine-1", "game_machine", "hinata_io", "acked", "2026-08-15T00:00:00.000Z"],
    )).not.toThrow();
    expect(db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'device_states'",
    ).all().map((row) => row.name)).toContain("idx_device_states_reported_at");
  });

  it("backfills legacy settlements into explicit player checkouts", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    const migrationDir = resolve(import.meta.dir, "../../../migrations");
    const migrationFiles = readdirSync(migrationDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const fileName of migrationFiles.filter((name) => name < "0013_player_checkouts.sql")) {
      runMigrationFile(db, resolve(migrationDir, fileName));
    }
    db.run(
      "INSERT INTO players (id, display_name, status, created_at) VALUES (?, ?, ?, ?)",
      ["player-1", "Neri", "active", "2026-07-16T09:00:00.000Z"],
    );
    for (const [sessionId, total] of [["session-charge", 10], ["session-discount", -3]] as const) {
      db.run(
        "INSERT INTO sessions (id, player_id, started_at, ended_at, status, payment_status) VALUES (?, ?, ?, ?, ?, ?)",
        [sessionId, "player-1", "2026-07-16T09:00:00.000Z", "2026-07-16T10:00:00.000Z", "closed", "paid"],
      );
      db.run(
        "INSERT INTO settlements (id, session_id, subtotal, total, status, settled_at) VALUES (?, ?, ?, ?, ?, ?)",
        [`settlement-${sessionId}`, sessionId, total, total, "settled", "2026-07-16T10:00:00.000Z"],
      );
    }

    runMigrationFile(db, resolve(migrationDir, "0013_player_checkouts.sql"));

    expect(db.query("SELECT player_id, subtotal, total FROM player_checkouts").get()).toEqual({
      player_id: "player-1",
      subtotal: 7,
      total: 7,
    });
    expect(db.query("SELECT COUNT(DISTINCT checkout_id) AS count FROM settlements").get()).toEqual({ count: 1 });
  });

  it("declares money and balance columns as decimal-capable values", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    for (const statement of sqliteSchema) {
      db.run(statement);
    }

    const columnType = (tableName: string, columnName: string) =>
      db
        .query<{ type: string }, [string, string]>(
          "SELECT type FROM pragma_table_info(?) WHERE name = ?",
        )
        .get(tableName, columnName)?.type;

    expect(columnType("asset_holdings", "quantity")).toBe("REAL");
    expect(columnType("asset_ledger_entries", "delta")).toBe("REAL");
    expect(columnType("pricing_effects", "value")).toBe("REAL");
    expect(columnType("settlements", "subtotal")).toBe("REAL");
    expect(columnType("settlements", "total")).toBe("REAL");
    expect(columnType("settlement_charge_items", "amount")).toBe("REAL");
    expect(columnType("settlement_adjustments", "amount")).toBe("REAL");
    expect(columnType("pricing_history_entries", "amount")).toBe("REAL");
    expect(columnType("business_items", "price")).toBe("REAL");
    expect(columnType("business_item_orders", "price")).toBe("REAL");
  });

  it("persists sessions, asset holdings, ledger entries, redeem records, and device commands", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    for (const statement of sqliteSchema) {
      db.run(statement);
    }

    db.run(
      "INSERT INTO players (id, display_name, status, created_at) VALUES (?, ?, ?, ?)",
      ["player-1", "Neri", "active", "2026-06-07T10:00:00.000Z"],
    );
    db.run(
      "INSERT INTO player_identities (player_id, provider, subject, created_at) VALUES (?, ?, ?, ?)",
      ["player-1", "qq", "10001", "2026-06-07T10:01:00.000Z"],
    );
    db.run(
      "INSERT INTO asset_definitions (type, code, name, stackable) VALUES (?, ?, ?, ?)",
      ["currency", "paid", "Paid balance", 1],
    );
    db.run(
      "INSERT INTO sessions (id, player_id, started_at, status) VALUES (?, ?, ?, ?)",
      ["session-1", "player-1", "2026-06-07T10:05:00.000Z", "active"],
    );
    db.run(
      "INSERT INTO asset_holdings (id, player_id, asset_type, asset_code, quantity) VALUES (?, ?, ?, ?, ?)",
      ["holding-1", "player-1", "currency", "paid", 100],
    );
    db.run(
      "INSERT INTO asset_transactions (id, player_id, kind, ref_id, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)",
      ["asset-tx-1", "player-1", "gift.redeem", "code-1", "2026-06-07T10:05:00.000Z", JSON.stringify({ source: "test" })],
    );
    db.run(
      "INSERT INTO asset_ledger_entries (id, player_id, transaction_id, asset_type, asset_code, delta, reason, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["ledger-1", "player-1", "asset-tx-1", "currency", "paid", 100, "gift.redeem", "code-1", "2026-06-07T10:05:00.000Z"],
    );
    db.run(
      "INSERT INTO redeem_codes (id, code, present_id, max_use_count) VALUES (?, ?, ?, ?)",
      ["code-1", "PRISM-2026", "present-1", 1],
    );
    db.run(
      "INSERT INTO redeem_records (id, player_id, code_id, present_id, redeemed_at) VALUES (?, ?, ?, ?, ?)",
      ["redeem-1", "player-1", "code-1", "present-1", "2026-06-07T10:06:00.000Z"],
    );
    db.run(
      "INSERT INTO device_commands (id, type, device_id, target_kind, executor_kind, player_id, status, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["command-1", "coin", "machine-1", "game_machine", "machine_ws", "player-1", "pending", "2026-06-07T10:07:00.000Z"],
    );
    db.run(
      "INSERT INTO device_states (device_id, type, target_kind, executor_kind, label, status, state, metadata_json, reported_at, reported_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "machine-1",
        "power.on",
        "facility",
        "home_assistant",
        "Cabinet 1",
        "online",
        "on",
        JSON.stringify({ voltage: 220 }),
        "2026-06-07T10:07:30.000Z",
        "agent-1",
      ],
    );
    db.run(
      "INSERT INTO settlements (id, session_id, subtotal, total, status, settled_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["settlement-1", "session-1", 20, 20, "settled", "2026-06-07T10:08:00.000Z"],
    );
    db.run(
      "INSERT INTO settlement_charge_items (id, session_id, item_order, source, label, amount) VALUES (?, ?, ?, ?, ?, ?)",
      ["charge-1", "session-1", 0, "time.default", "Base time", 20],
    );
    db.run(
      "INSERT INTO settlement_adjustments (id, session_id, adjustment_order, source, label, amount) VALUES (?, ?, ?, ?, ?, ?)",
      ["adjustment-1", "session-1", 0, "pass.monthly", "Monthly pass", -10],
    );
    db.run(
      "INSERT INTO pricing_history_entries (id, player_id, pricing_config_id, provider_id, rule_id, rule_anchor_at, session_id, amount, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "pricing-history-1",
        "player-1",
        "pricing-1",
        "time.default",
        "base",
        "2026-06-07T00:00:00.000Z",
        "session-1",
        20,
        "2026-06-07T10:08:00.000Z",
        JSON.stringify({ source: "schema-test" }),
      ],
    );
    db.run(
      "INSERT INTO pricing_configs (id, kind, name, enabled, provider_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "pricing-1",
        "time.priority",
        "Default time pricing",
        1,
        JSON.stringify({
          id: "time.default",
          rules: [],
        }),
        "2026-06-07T10:00:00.000Z",
        "2026-06-07T10:00:00.000Z",
      ],
    );
    db.run(
      "INSERT INTO business_items (id, kind, name, status, price, asset_type, asset_code, active_at, expires_at, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "business-item-1",
        "event.entry",
        "Weekend event",
        "active",
        1200,
        "ticket",
        "weekend",
        "2026-06-08T01:00:00.000Z",
        "2026-06-09T01:00:00.000Z",
        JSON.stringify({ capacity: 24 }),
        "2026-06-07T10:00:00.000Z",
        "2026-06-07T10:00:00.000Z",
      ],
    );
    db.run(
      "INSERT INTO business_item_orders (id, business_item_id, business_item_kind, business_item_name, player_id, session_id, status, price, asset_type, asset_code, metadata_json, created_at, updated_at, fulfilled_at, cancelled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "business-order-1",
        "business-item-1",
        "event.entry",
        "Weekend event",
        "player-1",
        "session-1",
        "paid",
        1200,
        "ticket",
        "weekend",
        JSON.stringify({ note: "test" }),
        "2026-06-07T10:09:00.000Z",
        "2026-06-07T10:09:00.000Z",
        null,
        null,
      ],
    );
    db.run(
      "INSERT INTO staff_users (id, username, display_name, password_hash, password_salt, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "staff-1",
        "owner",
        "Owner",
        "hash",
        "salt",
        "owner",
        "active",
        "2026-06-07T10:00:00.000Z",
        "2026-06-07T10:00:00.000Z",
      ],
    );
    db.run(
      "INSERT INTO admin_sessions (id, staff_user_id, token_hash, expires_at, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "admin-session-1",
        "staff-1",
        "session-hash",
        "2026-06-08T10:00:00.000Z",
        "2026-06-07T10:00:00.000Z",
        "2026-06-07T10:00:00.000Z",
      ],
    );
    db.run(
      "INSERT INTO api_tokens (id, label, role, token_prefix, token_hash, status, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "api-token-1",
        "Main integration",
        "integration",
        "integration",
        "api-token-hash",
        "active",
        "2026-06-07T10:00:00.000Z",
        null,
        null,
      ],
    );
    db.run(
      "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)",
      ["store.profile", JSON.stringify({ name: "PRiSM Test", timeZone: "Asia/Tokyo" }), "2026-06-07T10:00:00.000Z"],
    );

    expect(db.query("SELECT COUNT(*) AS count FROM asset_ledger_entries").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM staff_users WHERE role = 'owner'").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM admin_sessions").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM api_tokens WHERE role = 'integration'").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM app_settings WHERE key = 'store.profile'").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM asset_transactions").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM player_identities WHERE provider = 'qq'").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM device_commands").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM device_states WHERE status = 'online'").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM settlements").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM settlement_charge_items").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM settlement_adjustments").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM pricing_history_entries").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM pricing_configs WHERE enabled = 1").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM business_items WHERE status = 'active'").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM business_item_orders WHERE status = 'paid'").get()).toEqual({ count: 1 });
  });
});

function runMigrationFile(db: Database, filePath: string): void {
  const sql = readFileSync(filePath, "utf8");
  for (const statement of sql.split(";").map((item) => item.trim()).filter(Boolean)) {
    db.run(statement);
  }
}
