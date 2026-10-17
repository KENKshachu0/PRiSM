import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createApp } from "../src/app.js";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { decryptSecret, encryptSecret, sha256 } from "../src/crypto.js";
import type { Env } from "../src/bindings.js";

const migrationDir=resolve(import.meta.dir,"../../../migrations");
const KEY="transfer-encryption-key";
type Tables=Record<string,Array<Record<string,string|number|null>>>;

async function transferFixture() {
  const sqlite=new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=OFF");
  for(const filename of readdirSync(migrationDir).filter(name=>name.endsWith(".sql")).sort()) {
    for(const statement of splitD1MigrationStatements(readFileSync(resolve(migrationDir,filename),"utf8"))) {
      sqlite.run(statement);
    }
  }
  sqlite.run("PRAGMA foreign_keys=ON");
  const now=new Date().toISOString();
  const userId="transfer-owner";
  const token="transfer-owner-session";
  sqlite.run(
    "INSERT INTO users(id,role,created_at,updated_at) VALUES (?, 'user',?,?)",
    [userId,now,now],
  );
  sqlite.run(
    "INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ('transfer-session',?,?,?)",
    [userId,await sha256(token),new Date(Date.now()+86_400_000).toISOString()],
  );
  for(const id of ["source","destination"]) {
    sqlite.run(
      "INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES (?,?,?,31.23,121.47,80,?)",
      [id,id,id,userId],
    );
    sqlite.run(
      "INSERT INTO shop_members(id,shop_id,user_id,role) VALUES (?, ?, ?, 'owner')",
      [`member-${id}`,id,userId],
    );
  }
  sqlite.run(
    "INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES ('source','venue.operations',?,?)",
    [JSON.stringify({timeZone:"UTC",coinCooldownMs:42_000}),now],
  );
  const d1=createD1DatabaseFromSqlite(sqlite);
  const limiter={limit:async()=>({success:true})};
  const env={DB:d1,SESSION_SECRET:"transfer-secret",URL_ENCRYPTION_KEY:KEY,RATE_LIMIT_10:limiter} as unknown as Env;
  return {sqlite,env,app:createApp(),headers:{authorization:`Bearer ${token}`}};
}

describe("pre-fork shop data restore on migrated D1 schema",()=>{
  it("exports a real v1 configuration backup and imports it into an empty shop",async()=>{
    const {sqlite,env,app,headers}=await transferFixture();
    const url="https://prism.test/api/v1/shops";
    const exported=await app.fetch(new Request(`${url}/source/data/export?version=1&scope=configuration`,{headers}),env);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toContain("attachment;");
    const backup=await exported.json() as Record<string,unknown>;
    expect(backup.format).toBe("prism-shop-data");
    expect(backup.version).toBe(1);
    expect(backup.scope).toBe("configuration");
    const previewed=await app.fetch(new Request(`${url}/destination/data/import/preview`,{
      method:"POST",
      headers:{...headers,"content-type":"application/json"},
      body:JSON.stringify({backup}),
    }),env);
    expect(previewed.status).toBe(200);
    const preview=(await previewed.json() as {data:{canImport:boolean;fingerprint:string}}).data;
    expect(preview.canImport).toBe(true);
    const applied=await app.fetch(new Request(`${url}/destination/data/import/apply`,{
      method:"POST",
      headers:{...headers,"content-type":"application/json"},
      body:JSON.stringify({backup,fingerprint:preview.fingerprint,operationId:crypto.randomUUID()}),
    }),env);
    expect(applied.status).toBe(200);
    const settings=sqlite.query(
      "SELECT value_json FROM app_settings WHERE shop_id='destination' AND key='venue.operations'",
    ).get() as {value_json:string}|null;
    expect(JSON.parse(settings?.value_json??"{}").coinCooldownMs).toBe(42_000);
    sqlite.close();
  });

  it("streams a full business backup, records completion and enforces the export quota",async()=>{
    const {sqlite,env,app,headers}=await transferFixture();
    sqlite.run(
      "INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('source','player-v2','Example Player','active',?)",
      [new Date().toISOString()],
    );
    const endpoint="https://prism.test/api/v1/shops/source/data";
    const response=await app.fetch(new Request(`${endpoint}/export?scope=business`,{headers}),env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    const backup=await response.json() as {
      format:string;version:number;scope:string;tables:{players:Array<{id:string}>};
    };
    expect(backup.format).toBe("prism-shop-data");
    expect(backup.version).toBe(3);
    expect(backup.scope).toBe("business");
    expect(backup.tables.players.some(player=>player.id==="player-v2")).toBe(true);

    const exportJob=sqlite.query(
      "SELECT status FROM shop_data_exports WHERE shop_id='source' ORDER BY created_at DESC LIMIT 1",
    ).get() as {status:string}|null;
    expect(exportJob?.status).toBe("completed");

    const quota=await app.fetch(new Request(`${endpoint}/export-status`,{headers}),env);
    expect(quota.status).toBe(200);
    const quotaBody=await quota.json() as {data:{used:number;remaining:number}};
    expect(quotaBody.data.used).toBe(1);
    expect(quotaBody.data.remaining).toBe(0);

    const second=await app.fetch(new Request(`${endpoint}/export?scope=business`,{headers}),env);
    expect(second.status).toBe(429);
    const secondBody=await second.json() as {error:{code:string}};
    expect(secondBody.error.code).toBe("EXPORT_MONTHLY_LIMIT");
    sqlite.close();
  });

  it("restores a full business backup through staged parts and an atomic import",async()=>{
    const {sqlite,env,app,headers}=await transferFixture();
    sqlite.run(
      "INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('source','staged-player','Staged Player','active',?)",
      [new Date().toISOString()],
    );
    const source="https://prism.test/api/v1/shops/source/data";
    const destination="https://prism.test/api/v1/shops/destination/data";
    const exported=await app.fetch(new Request(`${source}/export?scope=business`,{headers}),env);
    expect(exported.status).toBe(200);
    const backup=await exported.json() as {
      version:number;
      tables:Record<string,Array<Record<string,string|number|null>>>;
      [key:string]:unknown;
    };
    expect(backup.version).toBe(3);
    const {tables,...header}=backup;
    const post=async(url:string,payload:unknown)=>{
      return app.fetch(new Request(url,{
        method:"POST",headers:{...headers,"content-type":"application/json"},
        body:JSON.stringify(payload),
      }),env);
    };
    const created=await post(`${destination}/imports`,header);
    expect(created.status).toBe(200);
    const {jobId}=((await created.json()) as {data:{jobId:string}}).data;
    expect(jobId).toBeTruthy();
    let part=0;
    for(const [table,rows] of Object.entries(tables)){
      if(!rows.length)continue;
      const response=await post(`${destination}/imports/${jobId}/parts`,{table,part,rows});
      expect(response.status).toBe(200);
      part++;
    }
    const counts=Object.fromEntries(Object.entries(tables).map(([table,rows])=>[table,rows.length]));
    const checked=await post(`${destination}/imports/${jobId}/preview`,{counts,parts:part});
    expect(checked.status).toBe(200);
    const preview=((await checked.json()) as {data:{canImport:boolean;errors:string[];fingerprint:string}}).data;
    expect(preview.errors).toEqual([]);
    expect(preview.canImport).toBe(true);

    // The target must remain unchanged between preview and apply; a stale
    // fingerprint cannot overwrite a store that has acquired business rows.
    sqlite.run(
      "INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('destination','concurrent-player','Concurrent','active',?)",
      [new Date().toISOString()],
    );
    const stale=await post(`${destination}/imports/${jobId}/apply`,{
      fingerprint:preview.fingerprint,operationId:crypto.randomUUID(),
    });
    expect(stale.status).toBe(409);
    expect(sqlite.query("SELECT id FROM players WHERE shop_id='destination' AND id='staged-player'").get()).toBeNull();
    sqlite.run("DELETE FROM players WHERE shop_id='destination' AND id='concurrent-player'");
    // The 0036 revision triggers intentionally keep a stale import locked until a fresh preview.
    const refreshed=await post(`${destination}/imports/${jobId}/preview`,{counts,parts:part});
    expect(refreshed.status).toBe(200);
    const freshPreview=((await refreshed.json()) as {data:{canImport:boolean;fingerprint:string}}).data;
    expect(freshPreview.canImport).toBe(true);
    const freshFingerprint=freshPreview.fingerprint;

    const operationId=crypto.randomUUID();
    const applied=await post(`${destination}/imports/${jobId}/apply`,{
      fingerprint:freshFingerprint,operationId,
    });
    expect(applied.status).toBe(200);
    const repeated=await post(`${destination}/imports/${jobId}/apply`,{
      fingerprint:freshFingerprint,operationId,
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(await applied.json());
    const conflicting=await post(`${destination}/imports/${jobId}/apply`,{
      fingerprint:freshFingerprint,operationId:crypto.randomUUID(),
    });
    expect(conflicting.status).toBe(409);
    expect(((await conflicting.json()) as {error:{code:string}}).error.code).toBe("OPERATION_CONFLICT");
    const migrated=sqlite.query(
      "SELECT id,display_name FROM players WHERE shop_id='destination' AND id='staged-player'",
    ).get() as {id:string;display_name:string}|null;
    expect(migrated?.display_name).toBe("Staged Player");
    const job=sqlite.query("SELECT status FROM shop_data_jobs WHERE id=?").get(jobId) as {status:string}|null;
    expect(job?.status).toBe("completed");
    sqlite.close();
  });

  it("round-trips a full configuration backup with the original settings and shop profile",async()=>{
    const {sqlite,env,app,headers}=await transferFixture();
    const source="https://prism.test/api/v1/shops/source/data";
    const dest="https://prism.test/api/v1/shops/destination/data";
    const call=async(url:string,body:unknown)=>app.fetch(new Request(url,{
      method:"POST",headers:{...headers,"content-type":"application/json"},
      body:JSON.stringify(body),
    }),env);
    const exp=await app.fetch(new Request(`${source}/export?scope=configuration`,{headers}),env);
    expect(exp.status).toBe(200);
    const backup=await exp.json() as {
      format:string; version:number;scope:string;
      tables:Record<string,Array<Record<string,string|number|null>>>;
      [key:string]:unknown;
    };
    expect(backup.version).toBe(3);
    expect(backup.scope).toBe("configuration");
    const {tables,...header}=backup;
    const created=await call(`${dest}/imports`,header);
    expect(created.status).toBe(200);
    const {jobId}=((await created.json()) as {data:{jobId:string}}).data;
    let part=0;
    for(const [table,rows] of Object.entries(tables)){
      if(!rows.length)continue;
      const uploaded=await call(`${dest}/imports/${jobId}/parts`,{table,part,rows});
      expect(uploaded.status).toBe(200);
      part++;
    }
    const counts=Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,rows.length]));
    const checked=await call(`${dest}/imports/${jobId}/preview`,{counts,parts:part});
    expect(checked.status).toBe(200);
    const preview=((await checked.json()) as {data:{canImport:boolean;errors:string[];fingerprint:string}}).data;
    expect(preview.canImport).toBe(true);
    expect(preview.errors).toEqual([]);
    const applied=await call(`${dest}/imports/${jobId}/apply`,{
      fingerprint:preview.fingerprint,operationId:crypto.randomUUID(),
    });
    expect(applied.status).toBe(200);
    const settings=sqlite.query(
      "SELECT value_json FROM app_settings WHERE shop_id='destination' AND key='venue.operations'",
    ).get() as {value_json:string}|null;
    expect(JSON.parse(settings?.value_json??"{}").coinCooldownMs).toBe(42_000);
    expect((sqlite.query("SELECT name FROM shops WHERE id='destination'").get() as {name:string}).name).toBe("source");
    sqlite.close();
  });
  it("requires explicit confirmation to overwrite live business records while preserving platform credentials",async()=>{
    const {sqlite,env,app,headers}=await transferFixture();
    const now=new Date().toISOString();
    sqlite.run(
      "INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('source','replacement-player','Restored Player','active',?)",
      [now],
    );
    sqlite.run(
      "INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('destination','old-player','Previous Player','active',?)",
      [now],
    );
    const beforeSessions=sqlite.query("SELECT COUNT(*) AS count FROM auth_sessions").get() as {count:number};
    const request=async(url:string,payload:unknown)=>app.fetch(new Request(url,{
      method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify(payload),
    }),env);
    const source="https://prism.test/api/v1/shops/source/data";
    const target="https://prism.test/api/v1/shops/destination/data";
    const exportResult=await app.fetch(new Request(source+"/export?scope=business",{headers}),env);
    expect(exportResult.status).toBe(200);
    const backup=await exportResult.json() as {
      tables:Record<string,Array<Record<string,string|number|null>>>;
      [key:string]:unknown;
    };
    const {tables,...manifest}=backup;
    const created=await request(target+"/imports",manifest);
    expect(created.status).toBe(200);
    const jobId=((await created.json()) as {data:{jobId:string}}).data.jobId;
    let part=0;
    for(const [table,rows] of Object.entries(tables)){
      if(!rows.length)continue;
      const uploaded=await request(target+`/imports/${jobId}/parts`,{table,part,rows});
      expect(uploaded.status).toBe(200);
      part++;
    }
    const counts=Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,rows.length]));
    const previewed=await request(target+`/imports/${jobId}/preview`,{counts,parts:part});
    expect(previewed.status).toBe(200);
    const preview=((await previewed.json()) as {data:{
      canImport:boolean;fingerprint:string;target:{records:number;mode:string}
    }}).data;
    expect(preview.canImport).toBe(true);
    expect(preview.target.mode).toBe("replace");
    expect(preview.target.records).toBeGreaterThan(0);
    const operationId=crypto.randomUUID();
    const denied=await request(target+`/imports/${jobId}/apply`,{
      fingerprint:preview.fingerprint,operationId,
    });
    expect(denied.status).toBe(409);
    expect(((await denied.json()) as {error:{code:string}}).error.code).toBe("IMPORT_OVERWRITE_REQUIRED");
    const unchanged = sqlite.query("SELECT display_name FROM players WHERE shop_id='destination' AND id='old-player'").get() as {display_name:string}|null;
    expect(unchanged?.display_name).toBe("Previous Player");
    const applied=await request(target+`/imports/${jobId}/apply`,{
      fingerprint:preview.fingerprint,operationId,overwrite:true,
    });
    expect(applied.status).toBe(200);
    const records=sqlite.query(
      "SELECT id FROM players WHERE shop_id='destination' ORDER BY id",
    ).all() as Array<{id:string}>;
    expect(records).toEqual([{id:"replacement-player"}]);
    const afterSessions=sqlite.query("SELECT COUNT(*) AS count FROM auth_sessions").get() as {count:number};
    expect(afterSessions).toEqual(beforeSessions);
    const repeated=await request(target+`/imports/${jobId}/apply`,{
      fingerprint:preview.fingerprint,operationId,overwrite:true,
    });
    expect(repeated.status).toBe(200);
    expect(sqlite.query("SELECT id FROM players WHERE shop_id='destination' ORDER BY id").all()).toEqual(records);
    sqlite.close();
  });

  /** Upload a backup through the staged job API and apply it. */
  async function restore(
    app:ReturnType<typeof createApp>,env:Env,headers:Record<string,string>,
    shop:string,backup:{tables:Tables;[key:string]:unknown},
  ){
    const call=async(path:string,body:unknown)=>app.fetch(new Request(`https://prism.test/api/v1/shops/${shop}/data${path}`,{
      method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify(body),
    }),env);
    const {tables,...header}=backup;
    const created=await call("/imports",header);
    expect(created.status).toBe(200);
    const {jobId}=((await created.json()) as {data:{jobId:string}}).data;
    let part=0;
    for(const [table,rows] of Object.entries(tables)){
      if(!rows.length)continue;
      const uploaded=await call(`/imports/${jobId}/parts`,{table,part,rows});
      expect(uploaded.status).toBe(200);
      part++;
    }
    const counts=Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,rows.length]));
    const checked=await call(`/imports/${jobId}/preview`,{counts,parts:part});
    const preview=((await checked.json()) as {data:{canImport:boolean;errors:string[];fingerprint:string}}).data;
    expect(preview.errors).toEqual([]);
    const applied=await call(`/imports/${jobId}/apply`,{fingerprint:preview.fingerprint,operationId:crypto.randomUUID(),overwrite:true});
    expect(applied.status).toBe(200);
  }

  it("carries device capabilities, secrets and history, and gives a copy its own relay identity",async()=>{
    const {sqlite,env,app,headers}=await transferFixture();
    const now=new Date().toISOString();
    sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('source','p1','P','active',?)",[now]);
    sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted) VALUES ('m1','pub-m1','source','Cabinet','')");
    sqlite.run(
      `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,credential_hash,created_at,updated_at)
       VALUES ('source','m1','hinata_io',?, '{}','hash-1',?,?),('source','m1','power','{}',?,NULL,?,?)`,
      [JSON.stringify({transport:"embedded",coinKey:32,coinAfterSwipe:false,channel:"m_source"}),now,now,
        JSON.stringify({binding:await encryptSecret(JSON.stringify({url:"https://ha",token:"t",entityId:"switch.x"}),KEY)}),now,now],
    );
    sqlite.run(
      `INSERT INTO device_operations(shop_id,id,device_id,capability,action,player_id,status,counts_as_play,payload_json,requested_at)
       VALUES ('source','op1','m1','hinata_io','coin','p1','pending',1,'{}',?)`,[now],
    );
    sqlite.run(
      `INSERT INTO device_events(shop_id,id,device_id,capability,kind,name,operation_id,origin,payload_json,occurred_at)
       VALUES ('source','op1.request','m1','hinata_io','request','coin','op1','platform','{}',?)`,[now],
    );
    sqlite.run(
      `INSERT INTO device_state(shop_id,device_id,capability,key,value_json,authority,changed_at)
       VALUES ('source','m1','hinata_io','link','"online"','owned',?)`,[now],
    );

    const exported=await app.fetch(new Request("https://prism.test/api/v1/shops/source/data/export?scope=business",{headers}),env);
    const backup=await exported.json() as {tables:Tables;[key:string]:unknown};
    const [capability]=backup.tables.device_capabilities!.filter(row=>row.capability==="power");
    // Inside the file secrets are readable; at rest they are encrypted again.
    expect(JSON.parse(String(capability!.secret_json)).binding).toContain("switch.x");
    await restore(app,env,headers,"destination",backup);

    const devices=sqlite.query("SELECT id FROM machines WHERE shop_id='destination'").all() as {id:string}[];
    expect(devices).toHaveLength(1);
    const copy=devices[0]!.id;
    // The id is taken by the source shop, so the copy is a new device.
    expect(copy).not.toBe("m1");
    const io=sqlite.query("SELECT config_json,credential_hash FROM device_capabilities WHERE shop_id='destination' AND capability='hinata_io'").get() as {config_json:string;credential_hash:string|null};
    expect(JSON.parse(io.config_json).channel).not.toBe("m_source");
    expect(io.credential_hash).toBeNull();
    const power=sqlite.query("SELECT secret_json FROM device_capabilities WHERE shop_id='destination' AND capability='power'").get() as {secret_json:string};
    expect(JSON.parse(await decryptSecret(JSON.parse(power.secret_json).binding,KEY))).toEqual({url:"https://ha",token:"t",entityId:"switch.x"});
    expect(sqlite.query("SELECT device_id,status FROM device_operations WHERE shop_id='destination'").all()).toEqual([{device_id:copy,status:"pending"}]);
    expect(sqlite.query("SELECT device_id FROM device_events WHERE shop_id='destination'").all()).toEqual([{device_id:copy}]);
    expect(sqlite.query("SELECT value_json FROM device_state WHERE shop_id='destination'").all()).toEqual([{value_json:'"offline"'}]);
    sqlite.close();
  });

  it("converts a v2 file's machine columns and command history into the device model",async()=>{
    const {sqlite,env,app,headers}=await transferFixture();
    const now=new Date().toISOString();
    sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('source','p1','P','active',?)",[now]);
    const exported=await app.fetch(new Request("https://prism.test/api/v1/shops/source/data/export?scope=business",{headers}),env);
    const current=await exported.json() as {tables:Tables;[key:string]:unknown};
    const {device_capabilities:_c,device_operations:_o,device_events:_e,device_state:_s,...tables}=current.tables;
    const v2={
      ...current,
      version:2,
      tables:{
        ...tables,
        machines:[{
          id:"legacy-m",public_id:"legacy-pub",name:"Old Cabinet",enabled:1,created_at:now,updated_at:now,kind:"machine",
          aliases_json:"[]",hinata_url:"https://relay.example/old",hinata_password:"pw",
          ha_binding_json:JSON.stringify({url:"https://ha",token:"t",entityId:"switch.old"}),
          ttlock_lock_id:null,coin_key:40,coin_after_swipe:1,mahjong_config_json:null,
        }],
        device_commands:[
          {id:"c1",type:"coin",device_id:"legacy-m",target_kind:"game_machine",executor_kind:"hinata_io",player_id:"p1",staff_id:null,
            status:"acked",payload_json:"{}",requested_at:now,acked_at:now,expired_at:null},
          {id:"c2",type:"aime.scan",device_id:"legacy-m",target_kind:"game_machine",executor_kind:"hinata_io",player_id:"p1",staff_id:null,
            status:"pending",payload_json:null,requested_at:now,acked_at:null,expired_at:null},
        ],
        device_states:[{device_id:"legacy-m",type:"power.on",target_kind:"facility",executor_kind:"home_assistant",label:"Old",
          status:"online",state:"on",metadata_json:null,reported_at:now,reported_by:"sync"}],
        machine_connections:[],
      },
    };
    await restore(app,env,headers,"destination",v2);

    const capabilities=sqlite.query("SELECT capability,config_json,secret_json FROM device_capabilities WHERE shop_id='destination' ORDER BY capability").all() as {capability:string;config_json:string;secret_json:string}[];
    expect(capabilities.map(row=>row.capability)).toEqual(["hinata_io","power"]);
    const io=capabilities[0]!;
    expect(JSON.parse(io.config_json)).toEqual({transport:"external",coinKey:40,coinAfterSwipe:true});
    const secrets=JSON.parse(io.secret_json) as Record<string,string>;
    expect(await decryptSecret(secrets.url!,KEY)).toBe("https://relay.example/old");
    expect(await decryptSecret(secrets.password!,KEY)).toBe("pw");
    expect(sqlite.query("SELECT id,action,status,counts_as_play FROM device_operations WHERE shop_id='destination' ORDER BY id").all()).toEqual([
      {id:"c1",action:"coin",status:"succeeded",counts_as_play:1},
      {id:"c2",action:"aime.scan",status:"pending",counts_as_play:1},
    ]);
    expect((sqlite.query("SELECT COUNT(*) AS n FROM device_events WHERE shop_id='destination'").get() as {n:number}).n).toBe(3);
    expect(sqlite.query("SELECT value_json,authority FROM device_state WHERE shop_id='destination'").all()).toEqual([{value_json:'"on"',authority:"observed"}]);
    sqlite.close();
  });
});
