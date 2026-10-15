import { Hono, type Context } from "hono";
import { z } from "zod";
import { createD1Repositories } from "@prism/adapter-d1";
import { withOperationLease } from "@prism/application";
import type { AppBindings, TenantShop } from "../../bindings.js";
import { decryptSecret } from "../../crypto.js";
import { refreshActivityBill } from "../../durable-objects/live-activity-billing.js";
import { sendHinataCard, sendHinataCoin } from "../../hardware/hinata.js";
import { clientIp, jsonError, nowIso } from "../../http.js";
import { requireUser } from "../../middleware/auth.js";
import { checkShopLocation } from "../../middleware/geo.js";
import { enforceRateLimits, loginRateLimitRules } from "../../middleware/rate-limit.js";
import { getOrCreateShopDependencies, isEntry } from "../../middleware/tenant.js";
import { reconnectImportedAccount } from "../shops/data/shop-data-accounts.js";
import { findLegacyShopByCode } from "../../legacy/tenant-resolver.js";
import { resolveMachineSession } from "./machine-session.js";

export const machineLoginRouter = new Hono<AppBindings>();
type C = Context<AppBindings, any, any>;

const machineLoginSchema = z.object({
  cardId: z.string().min(1, "请选择卡片"),
  lat: z.number().gte(-90).lte(90).optional(),
  lng: z.number().gte(-180).lte(180).optional(),
  accuracy: z.number().min(0).max(10_000).optional(),
  ticket: z.string().min(1, "缺少会话凭证"),
  clientTimestamp: z.string().optional(),
});

export async function assertNotBanned(c: C, entries: Array<[string, string]>) {
  for (const [subjectType, subjectValue] of entries) {
    const found = await c.env.DB.prepare(
      "SELECT id FROM bans WHERE subject_type=? AND subject_value=? AND (expires_at IS NULL OR expires_at>?)",
    ).bind(subjectType,subjectValue,nowIso()).first();
    if (found) jsonError(403,"当前无法进行此操作","FORBIDDEN");
  }
}

export async function getShopForMachine(c:C, shopCode:string): Promise<TenantShop> {
  const shop = await findLegacyShopByCode(c.env.DB,shopCode);
  if (!shop) jsonError(404,"没有找到这个店铺","SHOP_NOT_FOUND");
  c.set("responseTimeZone",shop.time_zone);
  await reconnectImportedAccount(c,shop.id);
  return shop;
}

export async function requireShopPlayer(c:C,shop:TenantShop,deviceOnly=false):Promise<{id:string,status:string}> {
  const user=requireUser(c);
  if (!shop.billing_enabled && !deviceOnly) jsonError(409,"店铺未启用计费","BILLING_DISABLED");
  const find=()=>c.env.DB.prepare(
    `SELECT p.id,p.status FROM shop_player_accounts a
      JOIN players p ON p.shop_id=a.shop_id AND p.id=a.player_id
      WHERE a.shop_id=? AND a.user_id=?`,
  ).bind(shop.id,user.id).first<{id:string;status:string}>();
  let player=await find();
  if(shop.identity_binding_required) {
    const bound=await c.env.DB.prepare(
      "SELECT 1 FROM shop_platform_bindings WHERE shop_id=? AND user_id=? LIMIT 1",
    ).bind(shop.id,user.id).first();
    if(!bound)jsonError(403,"请先绑定平台身份","PLATFORM_BINDING_REQUIRED");
  }
  if(!player) {
    const deps=getOrCreateShopDependencies(c.env.DB,shop);
    const repos=createD1Repositories({db:c.env.DB,shopId:shop.id,id:()=>crypto.randomUUID(),now:()=>new Date()});
    player=await withOperationLease(
      {repository:repos.operationLocks,scope:"platform.membership",resourceId:user.id,now:()=>new Date()},
      async()=>{
        const current=await find();
        if(current)return current;
        const created=await deps.integrationCommands.resolveOrRegisterPlayerByIdentity({
          identity:{provider:"web-account",subject:user.id},autoRegister:true,
          displayName:user.displayName || user.username || "玩家",
        });
        await c.env.DB.prepare(
          "INSERT INTO shop_player_accounts(shop_id,user_id,player_id,verified_at) VALUES (?,?,?,?)",
        ).bind(shop.id,user.id,created.id,nowIso()).run();
        return {id:created.id,status:created.status};
      },
    );
  }
  if(player.status!=="active")jsonError(403,"店铺玩家资格已停用","PLAYER_DISABLED");
  return player;
}

export async function requireActiveEntry(c:C,shop:TenantShop):Promise<string> {
  const player=await requireShopPlayer(c,shop);
  const repo=createD1Repositories({db:c.env.DB,shopId:shop.id,id:()=>crypto.randomUUID(),now:()=>new Date()});
  const sessions=await repo.sessions.findActiveByPlayerId(player.id);
  if(!sessions.some(session=>isEntry(session,shop)))jsonError(403,"请先确认入场","CHECKIN_REQUIRED");
  return player.id;
}

export async function machinePower(c:C,machine:{ha_binding_encrypted:string|null}):Promise<"on"|"off"|"unknown"|"unmanaged"> {
  if(!machine.ha_binding_encrypted)return "unmanaged";
  if(!c.env.URL_ENCRYPTION_KEY) jsonError(503,"设备密钥尚未配置","DEVICE_ENCRYPTION_UNAVAILABLE");
  try {
    const ha=JSON.parse(await decryptSecret(machine.ha_binding_encrypted,c.env.URL_ENCRYPTION_KEY)) as {
      url:string;token:string;entityId:string;
    };
    const response=await fetch(
      `${ha.url.replace(new RegExp("/+$"),"")}/api/states/${encodeURIComponent(ha.entityId)}`,
      {headers:{authorization:`Bearer ${ha.token}`},signal:AbortSignal.timeout(3000)},
    );
    if(!response.ok)return "unknown";
    const body=await response.json() as {state?:string};
    return body.state==="on"||body.state==="off"?body.state:"unknown";
  }catch{return "unknown";}
}

async function recordLoginEvent(c:C,event:{
  userId:string;cardId:string;machineId:string;ip:string;
  lat:number|null;lng:number|null;accuracy:number|null;result:string;
  responseCode:number|null;errorMessage:string|null;
}){
  await c.env.DB.prepare(
    `INSERT INTO machine_login_events
      (id,user_id,card_id,machine_id,ip,latitude,longitude,accuracy,distance_meters,
       risk_result,result,response_code,error_message)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    crypto.randomUUID(),event.userId,event.cardId,event.machineId,event.ip,
    event.lat,event.lng,event.accuracy,null,"ok",event.result,event.responseCode,event.errorMessage,
  ).run();
}

export async function claimCoin(c:C,shopId:string,machineId:string,id:string) {
  const configured=await c.env.DB.prepare(
    "SELECT json_extract(value_json,'$.coinCooldownMs') AS cooldown FROM app_settings WHERE shop_id=? AND key='venue.operations'",
  ).bind(shopId).first<{cooldown:number|null}>();
  const raw=configured?.cooldown;
  const cooldown=typeof raw==="number"&&Number.isInteger(raw)&&raw>=0?raw:60000;
  const now=Date.now();
  const claim=await c.env.DB.prepare(
    `INSERT INTO operation_locks(shop_id,scope,resource_id,lock_id,expires_at,acquired_at)
     VALUES (?,'device.coin',?,?,?,?)
     ON CONFLICT(shop_id,scope,resource_id) DO UPDATE SET
       lock_id=excluded.lock_id,expires_at=excluded.expires_at,acquired_at=excluded.acquired_at
     WHERE operation_locks.expires_at<=excluded.acquired_at RETURNING lock_id`,
  ).bind(shopId,machineId,id,new Date(now+cooldown).toISOString(),new Date(now).toISOString()).first();
  return !!claim;
}

async function handleLogin(c:C,routePublicId?:string) {
  const user=requireUser(c);
  const body=machineLoginSchema.parse(await c.req.json());
  const machine=await resolveMachineSession(c,body.ticket,routePublicId);
  const ip=clientIp(c.req.raw);
  const card=await c.env.DB.prepare(
    "SELECT id,access_code FROM cards WHERE id=? AND user_id=? AND disabled_at IS NULL",
  ).bind(body.cardId,user.id).first<{id:string;access_code:string}>();
  if(!card)jsonError(404,"卡片不可用或已失效","CARD_NOT_FOUND");

  await assertNotBanned(c,[["user",user.id],["ip",ip],["card",card.id],["machine",machine.id]]);
  // Match the old Worker contract: never silently bypass distributed login throttling.
  if(!c.env.RATE_LIMIT_5||!c.env.RATE_LIMIT_20||!c.env.RATE_LIMIT_30)
    jsonError(503,"限流服务尚未配置","RATE_LIMIT_UNAVAILABLE");
  await enforceRateLimits(c,loginRateLimitRules(c,{userId:user.id,machineId:machine.id}));

  const shop=await getShopForMachine(c,machine.shop_public_id);
  checkShopLocation(shop,"machine",body);
  const playerId=shop.billing_enabled?await requireActiveEntry(c,shop):null;
  if(!shop.billing_enabled&&machine.ttlock_lock_id)await requireShopPlayer(c,shop,true);
  if(!machine.hinata_url_encrypted)jsonError(409,"设备不支持此操作","DEVICE_ACTION_UNSUPPORTED");
  if(await machinePower(c,machine)==="off")jsonError(409,"请先开机","DEVICE_POWER_OFF");
  if(!c.env.URL_ENCRYPTION_KEY)jsonError(503,"设备密钥尚未配置","DEVICE_ENCRYPTION_UNAVAILABLE");
  const targetUrl=await decryptSecret(machine.hinata_url_encrypted,c.env.URL_ENCRYPTION_KEY);
  const password=machine.hinata_password_encrypted
    ?await decryptSecret(machine.hinata_password_encrypted,c.env.URL_ENCRYPTION_KEY):null;
  const operationId=crypto.randomUUID(),now=nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO player_operations (shop_id,user_id,id,kind,status,created_at,device_id) VALUES (?,?,?,'aime.scan','pending',?,?)",
    ).bind(shop.id,user.id,operationId,now,machine.id),
    c.env.DB.prepare(
      `INSERT INTO device_commands
        (shop_id,id,type,device_id,target_kind,executor_kind,player_id,status,payload_json,requested_at)
        VALUES (?,?,'aime.scan',?,'game_machine','hinata_io',?,'pending',?,?)`,
    ).bind(shop.id,operationId,machine.id,playerId,JSON.stringify({cardId:card.id}),now),
  ]);
  const result=await sendHinataCard(targetUrl,card.access_code,password,operationId);
  await recordLoginEvent(c,{
    userId:user.id,cardId:card.id,machineId:machine.id,ip,
    lat:body.lat??null,lng:body.lng??null,accuracy:body.accuracy??null,
    result:result.ok?"sent":"failed",responseCode:result.status||null,errorMessage:result.error||null,
  });
  const status=result.ok?"completed":result.status===0?"unknown":"failed";
  const response:{
    operationId:string;status:string;coin?:{status:"sent"|"skipped"|"failed"|"unknown";operationId:string;reason?:string}
  }={operationId,status};
  const writes=[
    c.env.DB.prepare(
      "UPDATE player_operations SET status=?,result_json=? WHERE shop_id=? AND user_id=? AND id=?",
    ).bind(status,JSON.stringify(response),shop.id,user.id,operationId),
    c.env.DB.prepare(
      "UPDATE device_commands SET status=?,acked_at=?,expired_at=? WHERE shop_id=? AND id=?",
    ).bind(result.ok?"acked":result.status===0?"pending":"expired",
      result.ok?nowIso():null,!result.ok&&result.status!==0?nowIso():null,shop.id,operationId),
  ];
  if(result.ok&&playerId)writes.push(
    c.env.DB.prepare(
      "UPDATE sessions SET metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.deviceOperated',json('true')) WHERE shop_id=? AND player_id=? AND status='active'",
    ).bind(shop.id,playerId),
  );
  await c.env.DB.batch(writes);
  if(result.ok && playerId) {
    const sync=refreshActivityBill(c.env,shop.id,playerId,false,true)
      .catch(error=>console.error("Machine login live bill sync failed",error));
    try{c.executionCtx.waitUntil(sync);}catch{void sync;}
  }
  if(!result.ok)jsonError(502,
    result.status===0||result.status===404?"设备离线或连接地址不正确，请联系店员":"设备连接失败，请联系店员检查配置",
    "DEVICE_UNAVAILABLE",response);
  if(machine.coin_after_swipe) {
    const coinId=crypto.randomUUID();
    response.coin={operationId:coinId,status:"unknown"};
    try {
      if(!await claimCoin(c,shop.id,machine.id,coinId))response.coin={
        operationId:coinId,status:"skipped",reason:"COIN_COOLDOWN",
      };
      else {
        await c.env.DB.prepare(
          `INSERT INTO device_commands
            (shop_id,id,type,device_id,target_kind,executor_kind,player_id,status,payload_json,requested_at)
            VALUES (?,?,'coin',?,'game_machine','hinata_io',?,'pending',?,?)`,
        ).bind(shop.id,coinId,machine.id,playerId,JSON.stringify({parentOperationId:operationId}),nowIso()).run();
        const coin=await sendHinataCoin(targetUrl,machine.coin_key,password,coinId);
        response.coin.status=coin.ok?"sent":coin.status===0?"unknown":"failed";
        await c.env.DB.prepare(
          "UPDATE device_commands SET status=?,acked_at=?,expired_at=? WHERE shop_id=? AND id=?",
        ).bind(
          coin.ok?"acked":coin.status===0?"pending":"expired",
          coin.ok?nowIso():null,!coin.ok&&coin.status!==0?nowIso():null,shop.id,coinId,
        ).run();
      }
    }catch{response.coin.status="unknown";}
    await c.env.DB.prepare(
      "UPDATE player_operations SET result_json=? WHERE shop_id=? AND user_id=? AND id=?",
    ).bind(JSON.stringify(response),shop.id,user.id,operationId).run();
  }
  return c.json({ok:true,...response});
}

machineLoginRouter.post("/login",c=>handleLogin(c));
machineLoginRouter.post("/:publicId/login",c=>handleLogin(c,c.req.param("publicId")));
