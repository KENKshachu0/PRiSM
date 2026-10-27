import { describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createApp } from "../src/app.js";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { sha256 } from "../src/crypto.js";
import { mintResourceTicket } from "../src/routes/platform/resource-ticket.js";
import type { Env } from "../src/bindings.js";

const migrations = resolve(import.meta.dir, "../../../migrations");

async function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=OFF");
  for (const name of readdirSync(migrations).filter((s) => s.endsWith(".sql")).sort())
    for (const sql of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) sqlite.run(sql);
  const now = new Date().toISOString(), token = "entry-door-token";
  sqlite.run("INSERT INTO users(id,role,created_at,updated_at) VALUES ('player-one','user',?,?)", [now, now]);
  sqlite.run("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ('s1','player-one',?,?)", [
    await sha256(token), new Date(Date.now() + 86_400_000).toISOString(),
  ]);
  sqlite.run(
    "INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('shop-id','shop-code','Arcade',0,0,80,'player-one')",
  );
  sqlite.run(
    `INSERT INTO shop_billing_settings(shop_id,auto_register,identity_binding_required)
    VALUES ('shop-id',1,0)`);
  // Every resource without a group of its own bills through the default group.
  sqlite.run("INSERT INTO resource_groups(shop_id,id,name,enabled,default_pricing_config_id,created_at,updated_at) VALUES ('shop-id','default','默认资源组',1,'entry',?,?)", [now, now]);
  sqlite.run("INSERT INTO asset_definitions(shop_id,type,code,name,stackable,status) VALUES ('shop-id','currency','paid','余额',1,'active')");
  sqlite.run(
    `INSERT INTO pricing_configs(shop_id,id,kind,name,enabled,status,provider_json,created_at,updated_at)
     VALUES ('shop-id','entry','time.priority','入场',1,'active',?,?,?)`,
    [JSON.stringify({ id: "entry", timeZone: "UTC", rules: [{ id: "all-day", label: "全天", priority: 0,
      timeRange: { start: "00:00", end: "00:00" }, pricing: { unitMinutes: 60, unitPrice: 100, roundGraceMinutes: 0, priceCap: 100000 } }] }), now, now],
  );
  sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted) VALUES ('door-id','front','shop-id','Door','')");
  sqlite.run(
    `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
     VALUES ('shop-id','door-id','door','{"lockId":7}','{}',?,?)`,
    [now, now],
  );
  sqlite.run(
    "INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES ('shop-id','devices.ttlock_connection',?,?)",
    [JSON.stringify({ baseUrl: "https://ttlock.test", clientId: "c", clientSecret: "s", accessToken: "a", refreshToken: "r" }), now],
  );
  const env = { DB: createD1DatabaseFromSqlite(sqlite), SESSION_SECRET: "session-test-secret" } as unknown as Env;
  const { ticket } = await mintResourceTicket(env.SESSION_SECRET, "shop-code", "front");
  const enter = (body: Record<string, unknown>) =>
    createApp().fetch(new Request("https://prism.test/api/v1/shops/shop-code/player/session/start", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ticket, consent: true, operationId: crypto.randomUUID(), ...body }),
    }), env);
  const sessions = () => (sqlite.query("SELECT COUNT(*) AS n FROM sessions WHERE status='active'").get() as { n: number }).n;
  return { sqlite, enter, sessions };
}

const lock = (ok: boolean) =>
  spyOn(globalThis, "fetch").mockImplementation((async (url: string | URL | Request) => {
    expect(String(url)).toContain("/v3/keyboardPwd/add");
    return ok ? Response.json({ errcode: 0, keyboardPwdId: 1 }) : Response.json({ errcode: -3, errmsg: "lock offline" });
  }) as typeof fetch);

describe("entry that opens the door", () => {
  it("returns the session and the door code together", async () => {
    const { enter, sessions, sqlite } = await fixture();
    const spy = lock(true);
    try {
      const res = await enter({ openDoor: true });
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: { session: { id: string }; door: { temporaryPassword: string; expiresAt: string } } };
      expect(data.session.id).toBeTruthy();
      expect(data.door.temporaryPassword).toMatch(/^\d{8}$/);
      expect(sessions()).toBe(1);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); sqlite.close(); }
  });

  it("keeps the entry when the lock fails, so the code can be asked for again", async () => {
    const { enter, sessions, sqlite } = await fixture();
    const spy = lock(false);
    try {
      const res = await enter({ openDoor: true });
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: { session: unknown; door: { error: { code: string } } } };
      expect(data.session).toBeTruthy();
      expect(data.door.error.code).toBe("DEVICE_UNAVAILABLE");
      expect(sessions()).toBe(1);
    } finally { spy.mockRestore(); sqlite.close(); }
  });

  it("never hands out the code when entry fails", async () => {
    const { enter, sessions, sqlite } = await fixture();
    // Entry fails after the lock was already asked: the code must be dropped.
    sqlite.run("CREATE TRIGGER refuse_entry BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'entry refused'); END");
    const spy = lock(true);
    try {
      const res = await enter({ openDoor: true });
      expect(res.ok).toBe(false);
      expect(JSON.stringify(await res.json())).not.toContain("temporaryPassword");
      expect(sessions()).toBe(0);
    } finally { spy.mockRestore(); sqlite.close(); }
  });

  it("refuses to open a door on a device that has none", async () => {
    const { enter, sqlite } = await fixture();
    sqlite.run("DELETE FROM device_capabilities WHERE capability='door'");
    const res = await enter({ openDoor: true });
    expect(res.status).toBe(409);
    sqlite.close();
  });
});
