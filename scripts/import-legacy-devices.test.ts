import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decryptSecret } from "../packages/platform/src/crypto.ts";
import { importLegacyDevices } from "./import-legacy-devices";

describe("importLegacyDevices", () => {
  test("creates logical devices, maps legacy references, and is idempotent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prism-legacy-devices-"));
    const sqlitePath = join(directory, "target.sqlite");
    const shopId = "shop-1";
    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE shops (id TEXT PRIMARY KEY);
      CREATE TABLE app_settings (shop_id TEXT, key TEXT, value_json TEXT, PRIMARY KEY(shop_id,key));
      CREATE TABLE machines (
        id TEXT PRIMARY KEY, public_id TEXT UNIQUE, shop_id TEXT, name TEXT,
        hinata_url_encrypted TEXT NOT NULL, enabled INTEGER, kind TEXT,
        ha_binding_encrypted TEXT, coin_key INTEGER, coin_after_swipe INTEGER,
        updated_at TEXT
      );
      CREATE TABLE device_commands (shop_id TEXT, device_id TEXT);
      CREATE TABLE device_states (shop_id TEXT, device_id TEXT);
      CREATE TABLE machine_connections (shop_id TEXT, machine_id TEXT);
    `);
    db.query("INSERT INTO shops VALUES (?)").run(shopId);
    db.query("INSERT INTO app_settings VALUES (?,?,?)").run(
      shopId,
      "devices.homeassistant",
      JSON.stringify([{ id: "switch.mai_left", name: "舞萌左机", alias: ["mai"] }]),
    );
    db.query("INSERT INTO app_settings VALUES (?,?,?)").run(
      shopId,
      "devices.homeassistant_connection",
      JSON.stringify({ url: "https://ha.example.test", token: "test-token" }),
    );
    db.query("INSERT INTO device_commands VALUES (?,?)").run(shopId, "switch.mai_left");
    db.query("INSERT INTO device_commands VALUES (?,?)").run(shopId, "mai");
    db.query("INSERT INTO device_states VALUES (?,?)").run(shopId, "舞萌左机");
    db.query("INSERT INTO machine_connections VALUES (?,?)").run(shopId, "switch.mai_left");
    db.close();

    try {
      const first = await importLegacyDevices({ sqlitePath, shopId, encryptionKey: "test-key" });
      expect(first).toMatchObject({ imported: 1, updated: 0, mapped: { deviceCommands: 2, deviceStates: 1, machineConnections: 1 } });

      const check = new Database(sqlitePath);
      const machine = check.query("SELECT * FROM machines WHERE shop_id=?").get(shopId) as {
        id: string;
        public_id: string;
        ha_binding_encrypted: string;
      };
      expect(machine.id).toBe(`legacy:ha:${shopId}:switch.mai_left`);
      expect(machine.public_id).toStartWith("legacy-ha-");
      await expect(decryptSecret(machine.ha_binding_encrypted, "test-key")).resolves.toContain("switch.mai_left");
      expect(check.query("SELECT device_id FROM device_commands ORDER BY device_id").all()).toEqual([
        { device_id: machine.id },
        { device_id: machine.id },
      ]);
      expect(check.query("SELECT device_id FROM device_states").get()).toEqual({ device_id: machine.id });
      expect(check.query("SELECT machine_id FROM machine_connections").get()).toEqual({ machine_id: machine.id });
      check.close();

      await expect(importLegacyDevices({ sqlitePath, shopId, encryptionKey: "test-key" })).resolves.toMatchObject({
        imported: 0,
        updated: 1,
        mapped: { deviceCommands: 0, deviceStates: 0, machineConnections: 0 },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
