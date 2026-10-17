import { describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createApp } from "../src/app.js";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { sha256, encryptSecret } from "../src/crypto.js";
import { mintMachineTicket } from "../src/routes/platform/machine-session.js";
import type { Env } from "../src/bindings.js";

const migrations=resolve(import.meta.dir,"../../../migrations");

async function fixture(){
  const sqlite=new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=OFF");
  for(const name of readdirSync(migrations).filter(s=>s.endsWith(".sql")).sort())
    for(const sql of splitD1MigrationStatements(readFileSync(resolve(migrations,name),"utf8")))
      sqlite.run(sql);
  sqlite.run("PRAGMA foreign_keys=ON");
  const now=new Date().toISOString(), token="machine-test-token";
  sqlite.run("INSERT INTO users(id,role,created_at,updated_at) VALUES ('player-one','user',?,?)",[now,now]);
  sqlite.run("INSERT INTO users(id,role,created_at,updated_at) VALUES ('player-two','user',?,?)",[now,now]);
  sqlite.run("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ('session-one','player-one',?,?)",[
    await sha256(token),new Date(Date.now()+86_400_000).toISOString(),
  ]);
  sqlite.run(
    "INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('shop-id','shop-code','Arcade',0,0,80,'player-one')",
  );
  sqlite.run("INSERT INTO cards(id,user_id,label,access_code) VALUES ('card-one','player-one','Aime','01234567890123456789')");
  sqlite.run("INSERT INTO cards(id,user_id,label,access_code) VALUES ('card-two','player-two','Other','99999999999999999999')");
  const secret="device-test-secret";
  sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted) VALUES ('machine-id','cabinet-code','shop-id','Cabinet','')");
  sqlite.run(
    `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
     VALUES ('shop-id','machine-id','hinata_io','{"transport":"external"}',?,?,?)`,
    [JSON.stringify({url:await encryptSecret("https://hinata.example/scan",secret)}),now,now],
  );
  const limiter={limit:async()=>({success:true})};
  const env={
    DB:createD1DatabaseFromSqlite(sqlite),
    SESSION_SECRET:"session-test-secret",URL_ENCRYPTION_KEY:secret,
    RATE_LIMIT_5:limiter,RATE_LIMIT_20:limiter,RATE_LIMIT_30:limiter,
  } as unknown as Env;
  const {ticket}=await mintMachineTicket(env.SESSION_SECRET,"shop-code","cabinet-code");
  return {sqlite,app:createApp(),env,ticket,token};
}

describe("pre-fork authenticated Aime machine login",()=>{
  it("sends a validated card and journals successful hardware commands",async()=>{
    const {sqlite,app,env,ticket,token}=await fixture();
    const responseFetch=spyOn(globalThis,"fetch");
    try{
      responseFetch.mockResolvedValue(new Response(null,{status:204}));
      const res=await app.fetch(new Request("https://prism.test/api/v1/machines/login",{
        method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},
        body:JSON.stringify({ticket,cardId:"card-one"}),
      }),env);
      expect(res.status).toBe(200);
      const reply=(await res.json()) as {data:{ok:boolean;status:string;operationId:string}};
      expect(reply.data.ok).toBe(true);
      expect(reply.data.status).toBe("completed");
      const sent=responseFetch.mock.calls;
      expect(sent).toHaveLength(1);
      expect(sent[0]?.[0]).toBe("https://hinata.example/scan");
      const command=sqlite.query(
        "SELECT action,status FROM device_operations WHERE id=?",
      ).get(reply.data.operationId) as {action:string;status:string}|null;
      expect(command).toEqual({action:"aime.scan",status:"succeeded"});
      // The card number reaches the machine but is never written down.
      expect(JSON.stringify(sqlite.query("SELECT * FROM device_events").all())).not.toContain("01234567890123456789");
      const op=sqlite.query(
        "SELECT status FROM player_operations WHERE id=?",
      ).get(reply.data.operationId) as {status:string}|null;
      expect(op?.status).toBe("completed");
      const event=sqlite.query("SELECT result,card_id FROM machine_login_events ORDER BY created_at DESC LIMIT 1")
        .get() as {result:string;card_id:string}|null;
      expect(event).toEqual({result:"sent",card_id:"card-one"});
    }finally{responseFetch.mockRestore(); sqlite.close();}
  });
  it("preserves failed delivery outcomes and audit events rather than claiming a successful swipe",async()=>{
    const {sqlite,app,env,ticket,token}=await fixture();
    const responseFetch=spyOn(globalThis,"fetch");
    try{
      responseFetch.mockResolvedValue(new Response("unavailable",{status:503}));
      const res=await app.fetch(new Request("https://prism.test/api/v1/machines/login",{
        method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},
        body:JSON.stringify({ticket,cardId:"card-one"}),
      }),env);
      expect(res.status).toBe(502);
      const body=(await res.json()) as {error:{code:string;details:{operationId:string;status:string}}};
      expect(body.error.code).toBe("DEVICE_UNAVAILABLE");
      expect(body.error.details.status).toBe("failed");
      const operationId=body.error.details.operationId;
      const command=sqlite.query(
        "SELECT status FROM device_operations WHERE id=?",
      ).get(operationId) as {status:string}|null;
      expect(command?.status).toBe("failed");
      const operation=sqlite.query(
        "SELECT status FROM player_operations WHERE id=?",
      ).get(operationId) as {status:string}|null;
      expect(operation?.status).toBe("failed");
      const audit=sqlite.query(
        "SELECT result,response_code FROM machine_login_events WHERE machine_id='machine-id'",
      ).get() as {result:string;response_code:number}|null;
      expect(audit).toEqual({result:"failed",response_code:503});
    }finally{responseFetch.mockRestore();sqlite.close();}
  });
  it("rejects cards owned by other users before sending hardware commands",async()=>{
    const {sqlite,app,env,ticket,token}=await fixture();
    const responseFetch=spyOn(globalThis,"fetch");
    try{
      responseFetch.mockResolvedValue(new Response(null,{status:204}));
      const res=await app.fetch(new Request("https://prism.test/api/v1/machines/login",{
        method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},
        body:JSON.stringify({ticket,cardId:"card-two"}),
      }),env);
      expect(res.status).toBe(404);
      expect(responseFetch).not.toHaveBeenCalled();
      expect((sqlite.query("SELECT COUNT(*) AS n FROM device_operations").get() as {n:number}).n).toBe(0);
    }finally{responseFetch.mockRestore(); sqlite.close();}
  });
});
