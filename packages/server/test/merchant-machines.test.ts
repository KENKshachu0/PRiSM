import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { D1BoundStatementLike, D1DatabaseLike, SqlValue } from "@prism/adapter-d1";
import type { AppBindings, Env } from "../src/bindings.js";
import { deviceEventSchema } from "@prism/storage-sql";
import { merchantMachineRouter } from "../src/routes/platform/merchant-machines.js";

class SqliteD1 implements D1DatabaseLike {
  constructor(private readonly sqlite: Database) {}
  prepare(sql: string) {
    const db = this.sqlite;
    return { bind(...values: SqlValue[]) {
      return {
        async first<T=unknown>() { return (db.query(sql).get(...values) as T | null) ?? null; },
        async all<T=unknown>() { return { results: db.query(sql).all(...values) as T[] }; },
        async run() { const result=db.run(sql,values); return {meta:{changes:result.changes}}; },
      };
    } };
  }
  async batch(statements: readonly D1BoundStatementLike[]) {
    const results=[];
    for(const stmt of statements) results.push(await stmt.run());
    return results;
  }
}

function fixture() {
  const sqlite=new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE shops(
      id TEXT PRIMARY KEY, public_id TEXT NOT NULL, name TEXT NOT NULL,
      latitude REAL NOT NULL, longitude REAL NOT NULL, radius_meters INTEGER NOT NULL,
      hero_data TEXT, hero_hash TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE app_settings(shop_id TEXT,key TEXT,value_json TEXT,updated_at TEXT,PRIMARY KEY(shop_id,key));
    CREATE TABLE shop_billing_settings(
      shop_id TEXT PRIMARY KEY,billing_enabled INTEGER,auto_register INTEGER,
      identity_binding_required INTEGER,checkin_geo INTEGER,checkout_geo INTEGER,machine_geo INTEGER,
      entry_pricing_ids_json TEXT,bot_contact TEXT
    );
    CREATE TABLE machines(
      shop_id TEXT NOT NULL,id TEXT NOT NULL,public_id TEXT NOT NULL,name TEXT NOT NULL,
      hinata_url_encrypted TEXT NOT NULL DEFAULT '',hinata_password_encrypted TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,kind TEXT NOT NULL DEFAULT 'machine',
      ha_binding_encrypted TEXT,ttlock_lock_id INTEGER,coin_key INTEGER NOT NULL DEFAULT 32,
      coin_after_swipe INTEGER NOT NULL DEFAULT 0,mahjong_config_json TEXT,aliases_json TEXT NOT NULL DEFAULT '[]',
      relay_connection TEXT NOT NULL DEFAULT 'external',relay_token_hash TEXT,relay_channel TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(shop_id,id)
    );
    CREATE TABLE machine_login_events(id TEXT,machine_id TEXT);
    CREATE TABLE player_operations(id TEXT,device_id TEXT);
    CREATE TABLE machine_tickets(machine_id TEXT,token_hash TEXT);
  `);
  sqlite.run("CREATE TABLE players(shop_id TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(shop_id,id))");
  for(const statement of deviceEventSchema)sqlite.run(statement);
  sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters) VALUES ('shop-1','shop-code','Test Shop',0,0,80)");
  const db=new SqliteD1(sqlite);
  const env={DB:db,SESSION_SECRET:"session-secret",URL_ENCRYPTION_KEY:"unit-test-encryption-key"} as unknown as Env;
  const app=new Hono<AppBindings>();
  app.use("*",async(c,next)=> {
    c.set("user",{id:"admin-1",role:"admin",username:"admin",displayName:"Admin",bannedAt:null});
    await next();
  });
  app.route("/api/v1/merchant",merchantMachineRouter);
  return {app,env,sqlite};
}

describe("pre-fork merchant machine lifecycle",()=>{
  it("creates, updates and deletes against the actual shop-scoped machine columns",async()=>{
    const {app,env,sqlite}=fixture();
    const created=await app.fetch(new Request("https://prism.test/api/v1/merchant/machines",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({shopId:"shop-1",name:"Arcade Cabinet",kind:"machine",enabled:true,coinKey:32}),
    }),env);
    expect(created.status).toBe(201);
    const first=await created.json() as {machine:{id:string;publicId:string;shopId:string;name:string}};
    expect(first.machine.shopId).toBe("shop-1");
    expect(first.machine.name).toBe("Arcade Cabinet");
    const stored=sqlite.query("SELECT name,shop_id,public_id FROM machines WHERE id=?").get(first.machine.id) as {name:string;shop_id:string;public_id:string};
    expect(stored.public_id).toBe(first.machine.publicId);
    expect(stored.shop_id).toBe("shop-1");
    const patched=await app.fetch(new Request(`https://prism.test/api/v1/merchant/machines/${first.machine.id}`,{
      method:"PATCH",headers:{"content-type":"application/json"},
      body:JSON.stringify({name:"Renamed Cabinet",aliases:["arcade","cabinet"]}),
    }),env);
    expect(patched.status).toBe(200);
    const updated=await patched.json() as {machine:{name:string;aliases:string[]}};
    expect(updated.machine.name).toBe("Renamed Cabinet");
    expect(updated.machine.aliases).toEqual(["arcade","cabinet"]);
    const removed=await app.fetch(new Request(`https://prism.test/api/v1/merchant/machines/${first.machine.id}`,{method:"DELETE"}),env);
    expect(removed.status).toBe(200);
    expect(sqlite.query("SELECT id FROM machines WHERE id=?").get(first.machine.id)).toBeNull();
  });
  it("binds capabilities and keeps them through an edit that does not mention them",async()=>{
    const {app,env,sqlite}=fixture();
    const send=(method:string,path:string,body:unknown)=>app.fetch(new Request(`https://prism.test/api/v1/merchant${path}`,{
      method,headers:{"content-type":"application/json"},body:JSON.stringify(body),
    }),env);
    const created=await send("POST","/machines",{
      shopId:"shop-1",name:"Cabinet",coinKey:40,coinAfterSwipe:true,
      hinataUrl:"https://relay.example/io",hinataPassword:"secret-pass",
      homeAssistant:{url:"https://ha.example",entityId:"switch.cabinet",token:"ha-token"},
      ttlockLockId:77,
    });
    expect(created.status).toBe(201);
    const {machine}=await created.json() as {machine:Record<string,unknown>&{id:string}};
    expect(machine).toMatchObject({
      hasHinata:true,hinataUrl:"https://relay.example/io",hasPassword:true,coinKey:40,coinAfterSwipe:true,
      homeAssistant:{url:"https://ha.example",entityId:"switch.cabinet"},ttlockLockId:77,relayConnection:"external",
    });
    const rows=()=>sqlite.query("SELECT capability,config_json,secret_json FROM device_capabilities ORDER BY capability").all() as {capability:string;config_json:string;secret_json:string}[];
    expect(rows().map(r=>r.capability)).toEqual(["door","hinata_io","power"]);
    // Secrets are stored encrypted, never in the clear.
    expect(JSON.stringify(rows())).not.toContain("secret-pass");
    expect(JSON.stringify(rows())).not.toContain("ha-token");
    const before=rows();

    const renamed=await send("PATCH",`/machines/${machine.id}`,{name:"Renamed"});
    expect(renamed.status).toBe(200);
    expect(rows().map(r=>[r.capability,r.config_json,r.secret_json])).toEqual(before.map(r=>[r.capability,r.config_json,r.secret_json]));

    // Changing the Home Assistant entity without a token keeps the stored token.
    await send("PATCH",`/machines/${machine.id}`,{homeAssistant:{url:"https://ha.example",entityId:"switch.other"}});
    const listed=await (await app.fetch(new Request("https://prism.test/api/v1/merchant/machines?shopId=shop-1"),env)).json() as {machines:Record<string,unknown>[]};
    expect(listed.machines[0]).toMatchObject({homeAssistant:{entityId:"switch.other"},coinKey:40});

    const unbound=await send("PATCH",`/machines/${machine.id}`,{homeAssistant:null,ttlockLockId:null,hinataUrl:null,hinataPassword:null});
    expect(unbound.status).toBe(200);
    expect(rows()).toEqual([]);
  });
  it("does not delete machines that have historical commands",async()=>{
    const {app,env,sqlite}=fixture();
    sqlite.run("INSERT INTO machines(shop_id,id,public_id,name) VALUES ('shop-1','machine-old','m-old','Archived Machine')");
    sqlite.run(`INSERT INTO device_operations(shop_id,id,device_id,capability,action,status,payload_json,requested_at)
      VALUES ('shop-1','command-1','machine-old','power','power.on','succeeded','{}','2026-01-01T00:00:00.000Z')`);
    const res=await app.fetch(new Request("https://prism.test/api/v1/merchant/machines/machine-old",{method:"DELETE"}),env);
    expect(res.status).toBe(409);
    expect(sqlite.query("SELECT id FROM machines WHERE id='machine-old'").get()).not.toBeNull();
  });
});
