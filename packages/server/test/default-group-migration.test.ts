import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";

const migrations = resolve(import.meta.dir, "../../../migrations");
const run = (sqlite: Database, name: string) => {
  for (const sql of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) sqlite.run(sql);
};

describe("migration 0045: the default group is stored, the front desk is a resource", () => {
  it("moves the shop's default plan onto its default group and gives cashier shops a desk", () => {
    const sqlite = new Database(":memory:");
    sqlite.run("PRAGMA foreign_keys=OFF");
    const names = readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort();
    for (const name of names.filter((file) => file < "0045")) run(sqlite, name);

    const now = new Date().toISOString();
    sqlite.run("INSERT INTO users(id,role,created_at,updated_at) VALUES ('u','user',?,?)", [now, now]);
    for (const id of ["priced", "free", "cashier"])
      sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES (?,?,?,0,0,80,'u')", [id, id, id]);
    sqlite.run(`INSERT INTO shop_billing_settings(shop_id,auto_register,entry_pricing_ids_json) VALUES ('priced',1,'["day"]'),('cashier',1,'["desk-plan"]')`);
    sqlite.run("INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES ('cashier','cashier.settings','{\"enabled\":true}',?)", [now]);
    sqlite.run("INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES ('priced','cashier.settings','{\"enabled\":false}',?)", [now]);

    run(sqlite, names.find((file) => file.startsWith("0045"))!);

    const groups = sqlite.query("SELECT shop_id AS shop, name, default_pricing_config_id AS plan FROM resource_groups WHERE id='default' ORDER BY shop_id").all();
    expect(groups).toEqual([
      { shop: "cashier", name: "默认资源组", plan: "desk-plan" },
      { shop: "free", name: "默认资源组", plan: null },
      { shop: "priced", name: "默认资源组", plan: "day" },
    ]);
    // Only the shop with the front desk on gets a desk, named in its cashier settings.
    expect(sqlite.query("SELECT id, shop_id AS shop, name, resource_group_id AS groupId FROM machines").all())
      .toEqual([{ id: "desk-cashier", shop: "cashier", name: "前台", groupId: null }]);
    const cashier = sqlite.query("SELECT value_json FROM app_settings WHERE shop_id='cashier' AND key='cashier.settings'").get() as { value_json: string };
    expect(JSON.parse(cashier.value_json)).toEqual({ enabled: true, resourceId: "desk-cashier" });
    // The old setting is no longer read, and is cleared so nothing mistakes it for one.
    expect(sqlite.query("SELECT DISTINCT entry_pricing_ids_json AS ids FROM shop_billing_settings").all()).toEqual([{ ids: "[]" }]);

    // Running it again changes nothing.
    run(sqlite, names.find((file) => file.startsWith("0045"))!);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM resource_groups").get()).toEqual({ n: 3 });
    expect(sqlite.query("SELECT COUNT(*) AS n FROM machines").get()).toEqual({ n: 1 });
  });
});
