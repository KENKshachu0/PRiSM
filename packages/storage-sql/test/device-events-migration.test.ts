import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const migrationDir = resolve(import.meta.dir, "../../../migrations");
const files = readdirSync(migrationDir).filter((name) => name.endsWith(".sql")).sort();

function migrateUpTo(db: Database, last: string) {
  for (const name of files) {
    if (name > last) break;
    db.exec(readFileSync(resolve(migrationDir, name), "utf8"));
  }
}

/**
 * The history migration must not change any answer billing already gave.
 * `device_operated` used to be computed from `device_commands`; after the move
 * it is computed from `device_operations`. Seed the old table, run 0037, and
 * compare both answers for every session.
 */
function seededDatabase() {
  const db = new Database(":memory:");
  migrateUpTo(db, "0036_overwrite_shop_import.sql");
  db.exec(`
    INSERT INTO users(id) VALUES ('owner');
    INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by)
      VALUES ('shop','shop-code','Shop',0,0,80,'owner');
    INSERT INTO players(shop_id,id,display_name,status,created_at)
      VALUES ('shop','p1','P1','active','2026-01-01T00:00:00.000Z'),
             ('shop','p2','P2','active','2026-01-01T00:00:00.000Z');
    INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted,hinata_password_encrypted,
      enabled,kind,ha_binding_encrypted,ttlock_lock_id,coin_key,coin_after_swipe,mahjong_config_json)
      VALUES ('m-io','pub-io','shop','IO','enc-url','enc-pw',1,'machine',NULL,NULL,32,1,NULL),
             ('m-ha','pub-ha','shop','HA','',NULL,1,'machine','enc-ha',NULL,0,0,NULL),
             ('m-door','pub-door','shop','Door','',NULL,1,'door',NULL,25356943,0,0,NULL),
             ('m-mj','pub-mj','shop','MJ','',NULL,1,'machine',NULL,NULL,0,0,'{"capacity":4,"pricingConfigIds":[]}');
  `);
  const command = (id: string, type: string, device: string | null, executor: string, target: string,
    player: string | null, status: string, at: string, payload: string | null = null) =>
    db.run(
      `INSERT INTO device_commands(shop_id,id,type,device_id,target_kind,executor_kind,player_id,staff_id,status,
        payload_json,requested_at,acked_at,expired_at) VALUES ('shop',?,?,?,?,?,?,NULL,?,?,?,?,?)`,
      [id, type, device, target, executor, player, status, payload, at,
        status === "acked" ? at : null, status === "expired" ? at : null],
    );
  command("c-coin", "coin", "m-io", "hinata_io", "game_machine", "p1", "acked", "2026-02-01T10:05:00.000Z");
  command("c-scan-pending", "aime.scan", "m-io", "hinata_io", "game_machine", "p1", "pending", "2026-02-02T10:05:00.000Z");
  command("c-power-failed", "power.on", "m-ha", "home_assistant", "facility", "p1", "expired", "2026-02-03T10:05:00.000Z",
    JSON.stringify({ executorFailure: { executorKind: "home_assistant", message: "HA down" } }));
  command("c-door", "door.open", "m-door", "ttlock", "facility", "p2", "acked", "2026-02-04T10:05:00.000Z");
  command("c-all", "power.off", null, "home_assistant", "facility", null, "acked", "2026-02-05T10:05:00.000Z");
  command("c-ws", "coin", "neo-cabinet", "machine_ws", "game_machine", "p2", "acked", "2026-02-06T10:05:00.000Z",
    JSON.stringify({ count: 2, legacyCoinRecordId: 9 }));
  command("c-child", "coin", "m-io", "hinata_io", "game_machine", "p1", "acked", "2026-02-01T10:05:01.000Z",
    JSON.stringify({ parentOperationId: "c-coin" }));
  db.exec(`
    INSERT INTO device_states(shop_id,device_id,type,target_kind,executor_kind,label,status,state,metadata_json,reported_at,reported_by)
      VALUES ('shop','m-ha','power.on','facility','home_assistant','HA','online','on','{}','2026-02-03T11:00:00.000Z','sync'),
             ('shop','gone','power.on','facility','home_assistant','Gone','offline','off','{}','2026-02-03T11:00:00.000Z','sync');
  `);
  return db;
}

const sessions = [
  { player: "p1", from: "2026-02-01T10:00:00.000Z", to: "2026-02-01T11:00:00.000Z" },
  { player: "p1", from: "2026-02-02T10:00:00.000Z", to: "2026-02-02T11:00:00.000Z" },
  { player: "p1", from: "2026-02-03T10:00:00.000Z", to: "2026-02-03T11:00:00.000Z" },
  { player: "p2", from: "2026-02-04T10:00:00.000Z", to: "2026-02-04T11:00:00.000Z" },
  { player: "p2", from: "2026-02-06T10:00:00.000Z", to: "2026-02-06T11:00:00.000Z" },
  { player: "p2", from: "2026-02-07T10:00:00.000Z", to: "2026-02-07T11:00:00.000Z" },
];

const legacyOperated = (db: Database, s: (typeof sessions)[number]) =>
  !!(db.query(`SELECT EXISTS(SELECT 1 FROM device_commands c WHERE c.shop_id='shop' AND c.player_id=?
    AND c.type!='door.open' AND c.status NOT IN ('expired','rejected')
    AND c.requested_at>=? AND c.requested_at<=?) AS v`).get(s.player, s.from, s.to) as { v: number }).v;

const newOperated = (db: Database, s: (typeof sessions)[number]) =>
  !!(db.query(`SELECT EXISTS(SELECT 1 FROM device_operations o WHERE o.shop_id='shop' AND o.player_id=?
    AND o.counts_as_play=1 AND o.status!='failed'
    AND o.requested_at>=? AND o.requested_at<=?) AS v`).get(s.player, s.from, s.to) as { v: number }).v;

describe("0037 device history migration", () => {
  it("gives every session the same device-use answer as before", () => {
    const db = seededDatabase();
    const before = sessions.map((s) => legacyOperated(db, s));
    db.exec(readFileSync(resolve(migrationDir, "0037_device_events.sql"), "utf8"));
    const after = sessions.map((s) => newOperated(db, s));
    expect(after).toEqual(before);
    // The fixture must actually exercise both answers, or equality proves nothing.
    expect(before).toContain(true);
    expect(before).toContain(false);
  });

  it("keeps the coin count the report has always shown", () => {
    const db = seededDatabase();
    const legacy = (db.query("SELECT COUNT(*) n FROM device_commands WHERE type='coin'").get() as { n: number }).n;
    db.exec(readFileSync(resolve(migrationDir, "0037_device_events.sql"), "utf8"));
    const migrated = (db.query("SELECT COUNT(*) n FROM device_operations WHERE action='coin'").get() as { n: number }).n;
    expect(migrated).toBe(legacy);
  });

  it("turns each machine column into a capability row", () => {
    const db = seededDatabase();
    db.exec(readFileSync(resolve(migrationDir, "0037_device_events.sql"), "utf8"));
    const rows = db.query("SELECT device_id, capability, config_json, secret_json FROM device_capabilities ORDER BY device_id, capability")
      .all() as Array<{ device_id: string; capability: string; config_json: string; secret_json: string }>;
    expect(rows.map((r) => `${r.device_id}:${r.capability}`)).toEqual([
      "m-door:door", "m-ha:power", "m-io:hinata_io", "m-mj:mahjong",
    ]);
    const io = rows.find((r) => r.capability === "hinata_io")!;
    expect(JSON.parse(io.config_json)).toEqual({ transport: "external", coinKey: 32, coinAfterSwipe: true });
    // Ciphertext is copied verbatim; the key does not change.
    expect(JSON.parse(io.secret_json)).toEqual({ url: "enc-url", password: "enc-pw" });
    expect(JSON.parse(rows.find((r) => r.capability === "door")!.config_json)).toEqual({ lockId: 25356943 });
  });

  it("maps every legacy status and keeps the failure message", () => {
    const db = seededDatabase();
    db.exec(readFileSync(resolve(migrationDir, "0037_device_events.sql"), "utf8"));
    const ops = Object.fromEntries((db.query("SELECT id, status, failure, capability, parent_id, counts_as_play FROM device_operations").all() as
      Array<{ id: string; status: string; failure: string | null; capability: string; parent_id: string | null; counts_as_play: number }>)
      .map((row) => [row.id, row]));
    expect(ops["c-coin"]!.status).toBe("succeeded");
    expect(ops["c-scan-pending"]!.status).toBe("pending");
    expect(ops["c-power-failed"]!).toMatchObject({ status: "failed", failure: "HA down", capability: "power" });
    expect(ops["c-door"]!).toMatchObject({ capability: "door", counts_as_play: 0 });
    expect(ops["c-child"]!.parent_id).toBe("c-coin");
    // An "all devices" request keeps its null target.
    expect(db.query("SELECT device_id FROM device_operations WHERE id='c-all'").get()).toEqual({ device_id: null });
  });

  it("writes a request event for every operation and a result only once settled", () => {
    const db = seededDatabase();
    db.exec(readFileSync(resolve(migrationDir, "0037_device_events.sql"), "utf8"));
    const count = (sql: string) => (db.query(sql).get() as { n: number }).n;
    const operations = count("SELECT COUNT(*) n FROM device_operations");
    expect(count("SELECT COUNT(*) n FROM device_events WHERE kind='request'")).toBe(operations);
    expect(count("SELECT COUNT(*) n FROM device_events WHERE kind='result'"))
      .toBe(count("SELECT COUNT(*) n FROM device_operations WHERE status!='pending'"));
    expect(db.query("SELECT payload_json FROM device_events WHERE id='c-power-failed.result'").get())
      .toEqual({ payload_json: JSON.stringify({ outcome: "failed", message: "HA down" }) });
  });

  it("keeps a power observation only for devices that still have power", () => {
    const db = seededDatabase();
    db.exec(readFileSync(resolve(migrationDir, "0037_device_events.sql"), "utf8"));
    expect(db.query("SELECT device_id, value_json, authority FROM device_state").all()).toEqual([
      { device_id: "m-ha", value_json: '"on"', authority: "observed" },
    ]);
  });

  it("leaves the foreign keys intact", () => {
    const db = seededDatabase();
    db.exec(readFileSync(resolve(migrationDir, "0037_device_events.sql"), "utf8"));
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
