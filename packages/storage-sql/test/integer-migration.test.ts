import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

test("0022 migrates each unit, configuration JSON and linked rows atomically", () => {
  const db = new Database(":memory:");
  const root = resolve(import.meta.dir, "../../../migrations");
  db.run("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(root).filter(name => name.endsWith(".sql") && name < "0022_").sort()) {
    db.exec(readFileSync(resolve(root, name), "utf8"));
  }
  db.exec(`
    INSERT INTO players(id,display_name,status,created_at) VALUES('p','Player','active','2026-09-15');
    INSERT INTO pricing_effects(id,name,type,scope,value,config_json)
      VALUES('effect','Discount','percentage-discount','session',12.34,'{"minSubtotal":1.23}');
    INSERT INTO asset_definitions(type,code,name,pricing_effect_id)
      VALUES('currency','paid','Wallet',NULL),('coupon','entry','Coupon','effect');
    INSERT INTO asset_holdings(id,player_id,asset_type,asset_code,quantity)
      VALUES('money','p','currency','paid',12.340000000000002),('coupon','p','coupon','entry',2);
    INSERT INTO asset_ledger_entries(id,player_id,asset_type,asset_code,delta,reason,ref_id,created_at)
      VALUES('money','p','currency','paid',-1.23,'test','test','2026-09-15'),
            ('coupon','p','coupon','entry',-1,'test','test','2026-09-15');
    INSERT INTO presents(id,name,grants_json)
      VALUES('gift','Gift','[{"assetType":"currency","amount":1.23},{"assetType":"coupon","amount":2}]');
    INSERT INTO pricing_configs(id,kind,name,enabled,provider_json,created_at,updated_at)
      VALUES('fixed','charge.fixed','Fixed',1,'{"amount":1.23}','2026-09-15','2026-09-15'),
            ('time','time.priority','Time',1,'{"rules":[{"pricing":{"unitPrice":2.34,"priceCap":12.34}}],"paidHistory":{"key":1.23}}','2026-09-15','2026-09-15'),
            ('cap','time.cap','Cap',1,'{"rules":[{"priceCap":12.34}]}','2026-09-15','2026-09-15');
  `);
  const migration = readFileSync(resolve(root, "0022_integer_money_columns.sql"), "utf8");
  expect(() => db.transaction(() => {
    db.exec(migration);
    throw new Error("simulate failure");
  })()).toThrow("simulate failure");
  expect(db.query("SELECT quantity FROM asset_holdings WHERE id='coupon'").get()).toEqual({ quantity: 2 });
  expect(db.query("SELECT typeof(quantity) AS type FROM asset_holdings WHERE id='money'").get()).toEqual({ type: "real" });

  db.transaction(() => db.exec(migration))();
  expect(db.query("SELECT id,quantity,typeof(quantity) AS type FROM asset_holdings ORDER BY id").all()).toEqual([
    { id: "coupon", quantity: 2, type: "integer" }, { id: "money", quantity: 1234, type: "integer" },
  ]);
  expect(db.query("SELECT id,delta FROM asset_ledger_entries ORDER BY id").all()).toEqual([
    { id: "coupon", delta: -1 }, { id: "money", delta: -123 },
  ]);
  expect(db.query("SELECT value,json_extract(config_json,'$.minSubtotal') AS minimum FROM pricing_effects").get())
    .toEqual({ value: 1234, minimum: 123 });
  const providers = db.query<{ id: string; provider_json: string }, []>("SELECT id,provider_json FROM pricing_configs ORDER BY id").all();
  expect(providers.map(row => JSON.parse(row.provider_json))).toEqual([
    { rules: [{ priceCap: 1234 }] }, { amount: 123 },
    { rules: [{ pricing: { unitPrice: 234, priceCap: 1234 } }], paidHistory: { key: 123 } },
  ]);
  const gift = db.query<{ grants_json: string }, []>("SELECT grants_json FROM presents").get()!;
  expect(JSON.parse(gift.grants_json)).toEqual([{ assetType: "currency", amount: 123 }, { assetType: "coupon", amount: 2 }]);
  expect(() => db.run("UPDATE asset_holdings SET quantity=1.23 WHERE id='money'")).toThrow();
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(db.query("SELECT name FROM sqlite_master WHERE name='idx_asset_holdings_player'").get()).not.toBeNull();
  db.close();
});
