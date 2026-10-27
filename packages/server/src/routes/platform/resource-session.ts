import { Hono, type Context } from "hono";
import { z } from "zod";
import { PrismDomainError } from "@prism/core";
import type { AppBindings } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { optionalUser, requireUser } from "../../middleware/auth.js";
import { getOrCreateShopDependencies } from "../../middleware/tenant.js";
import type { ResourceBillingPreview } from "../../resources/activation.js";
import { toPricingConfigManagementView } from "../shops/views.js";
import { getShopForMachine, requireShopPlayer } from "./machine-login.js";
import { publicResource, resolveResourceTicket, type ScannedResource } from "./resource-ticket.js";
import { executeResourceAction, actionSchema, resourceClimateState, resourcePowerState } from "./resource-actions.js";
import { has, hinataConfigOf, loadResource } from "../../resources/resource.js";
import { CARD_CAPTURE_MS } from "../../resources/card-capture.js";
import { createOccupancy } from "../../resources/occupancy/service.js";
import { machineRelayNamespace } from "../../gateway/machine-relay-gateway.js";
import { checkShopLocation } from "../../middleware/geo.js";
import { readDeviceState } from "../../resources/capabilities/runtime.js";
import { noFacts, readBoardStates, readDeviceFacts } from "../../resources/capabilities/state-view.js";
import { assertResourceShop } from "./merchant-resources.js";
import { errorNotice, requestLocale } from "../../notices.js";
import { allowedOrigins } from "../../middleware/cors.js";
import { mahjongState, operateMahjong } from "./mahjong.js";

export const resourceSessionRouter=new Hono<AppBindings>();
export const merchantResourceActionRouter=new Hono<AppBindings>();

/**
 * Live updates for a device page: the shop hub pushes this device's power and
 * air-conditioner state as its watchers report it, and tells the page when
 * something it shows changed (a bot confirmed its binding). It also says
 * whether the device is watched at all, so an unwatched page keeps asking for
 * what it needs.
 */
resourceSessionRouter.get("/session/ws", async c=>{
  if(c.req.header("upgrade")?.toLowerCase()!=="websocket")jsonError(426,"需要 WebSocket 连接","UPGRADE_REQUIRED");
  const user=requireUser(c);
  const machine=await resolveResourceTicket(c,c.req.query("ticket")??"");
  const shop=await getShopForMachine(c,machine.shop_public_id);
  const hub=c.env.SHOP_HUB as unknown as {getByName(name:string):{fetch(request:Request):Promise<Response>}}|undefined;
  if(!hub)jsonError(503,"店铺连接服务尚未配置","SHOP_HUB_UNAVAILABLE");
  const headers=new Headers(c.req.raw.headers);
  headers.set("x-prism-hub-shop",shop.id);
  headers.set("x-prism-hub-device",machine.id);
  headers.set("x-prism-hub-user",user.id);
  // Only the hub's page channel; the bot channel needs a bot token.
  headers.delete("authorization");
  return hub.getByName(shop.id).fetch(new Request(c.req.raw,{headers}));
});

type C=Context<AppBindings,any,any>;

/**
 * What the page needs before it can show anything: whether the player must
 * bind an identity or confirm billing first, mahjong seats, and the device's
 * stored facts. Every resource with a plan, hardware or not, needs that plan
 * running for the player; `billing` then says what confirming would
 * start, keep and end. Reading this never starts anything. The facts are only
 * what is already known (`device.watching` says whether they are current);
 * nothing here asks Home Assistant. `includePower` and `includeClimate` keep the
 * older contract, where this read also asked Home Assistant, for clients that
 * have not moved to `device`.
 */
async function sessionState(c:C,machine:ScannedResource,options:{includePower:boolean;includeClimate:boolean}){
  const user=requireUser(c);
  const shop=await getShopForMachine(c,machine.shop_public_id);
  let gate:"ready"|"binding"|"entry"="ready";
  let billing:{preview?:ResourceBillingPreview;error?:{code:string;message:string};rules?:unknown}|null=null;
  const device=await loadResource(c.env.DB,shop.id,machine.id);
  const bound=(id:Parameters<typeof has>[1])=>!!device&&has(device,id);
  const resourceBilling=getOrCreateShopDependencies(c.env.DB,shop,c.env.URL_ENCRYPTION_KEY,c.env).resourceBilling;
  /** A resource that cannot bill is shown as such instead of failing the page. */
  const billingRead=async<T,>(read:()=>Promise<T>):Promise<T|undefined>=>{
    try{return await read();}
    catch(error){
      if(!(error instanceof PrismDomainError))throw error;
      // Worded for the player, as an error response would be: developer text never reaches the page.
      billing={...billing,error:{code:error.code,message:errorNotice({code:error.code,message:error.message,status:409},requestLocale(c.req.header("accept-language"))).body}};
      return undefined;
    }
  };
  // Undefined when the resource's binding cannot be read; `billing.error` says why.
  const planId=await billingRead(()=>resourceBilling.planOf(machine.id));
  const bills=planId!==null;
  if(bills||bound("door")||bound("mahjong")){
    const player=await c.env.DB.prepare(
      `SELECT a.player_id AS playerId,p.status,
       EXISTS(SELECT 1 FROM shop_platform_bindings b WHERE b.shop_id=? AND b.user_id=?) AS identityBound
       FROM (SELECT 1) x
       LEFT JOIN shop_player_accounts a ON a.shop_id=? AND a.user_id=?
       LEFT JOIN players p ON p.shop_id=a.shop_id AND p.id=a.player_id`,
    ).bind(shop.id,user.id,shop.id,user.id).first<{playerId:string|null;status:string|null;identityBound:number}>();
    if(shop.identity_binding_required&&!player?.identityBound)gate="binding";
    else if(!player?.playerId)gate=bills?"entry":"ready";
    else if(player.status!=="active")jsonError(403,"店铺玩家资格已停用","PLAYER_DISABLED");
    else if(bills){
      const running=await billingRead(()=>resourceBilling.activeSession({resourceId:machine.id,playerId:player.playerId!}));
      // A seat here is billed for already, by the plan the seat runs on.
      if(!running&&!await createOccupancy({db:c.env.DB,shopId:shop.id}).holds(machine.id,player.playerId))gate="entry";
    }
    if(gate==="entry"&&bills&&!billing){
      // A player not yet registered here has nothing running, so the preview is
      // simply everything the plan needs.
      const preview=await billingRead(()=>resourceBilling.preview({resourceId:machine.id,playerId:player?.playerId??""}));
      if(preview)billing={preview};
    }
    // What the page shows as this resource's pricing: its own plan and every
    // plan that bills with it, as the player's locked release defines them.
    if(planId&&gate!=="binding"&&!billing?.error){
      // Caps only matter where the rules are read before confirming.
      const rules=await billingRead(()=>resourceBilling.rulesOf({resourceId:machine.id,playerId:player?.playerId??"",withCaps:gate==="entry"}));
      if(rules)billing={...billing,rules:{
        ...rules,
        plans:rules.plans.map(plan=>({...plan,config:toPricingConfigManagementView(plan.config)})),
        ...(rules.caps?{caps:{
          unsettled:rules.caps.unsettled,
          plans:rules.caps.plans.map(cap=>({...cap,startsAt:cap.startsAt.toISOString(),endsAt:cap.endsAt.toISOString()})),
          shared:rules.caps.shared.map(cap=>({...cap,startsAt:cap.startsAt.toISOString(),endsAt:cap.endsAt.toISOString(),config:toPricingConfigManagementView(cap.config)})),
        }}:{}),
        timeZone:shop.time_zone,
      }};
    }
  }
  const facts=device?await readDeviceFacts(c.env.DB,shop.id,device):noFacts;
  return {
    gate,coinUsed:false,billing,
    mahjong:gate==="ready"?await mahjongState(c,machine):null,
    power:gate==="ready"&&bound("power")&&options.includePower
      ?await resourcePowerState(c,machine):"unmanaged",
    climate:gate==="ready"&&bound("climate")&&options.includeClimate?await resourceClimateState(c,machine):null,
    device:facts,
  };
}

resourceSessionRouter.get("/session/state", async c=>{
  const machine=await resolveResourceTicket(c,c.req.query("ticket")??"");
  return c.json(await sessionState(c,machine,{
    includePower:c.req.query("includePower")!=="0",
    includeClimate:c.req.query("includeClimate")!=="0",
  }));
});

/**
 * The first read of a scanned page: the machine and, for a signed-in player,
 * the page state, in one request instead of two in sequence.
 */
resourceSessionRouter.get("/session/bootstrap", async c=>{
  const machine=await resolveResourceTicket(c,c.req.query("ticket")??"");
  return c.json({
    machine:await publicResource(c,machine),
    state:optionalUser(c)?await sessionState(c,machine,{includePower:false,includeClimate:false}):null,
  });
});

/**
 * Power and climate for a page that is not watched. A watched device answers
 * from its stored facts; otherwise Home Assistant is asked now, in parallel
 * for both, and nothing is recorded.
 */
resourceSessionRouter.get("/session/device", async c=>{
  requireUser(c);
  const machine=await resolveResourceTicket(c,c.req.query("ticket")??"");
  const device=await loadResource(c.env.DB,machine.shop_id,machine.id);
  if(!device)return c.json(noFacts);
  return c.json(await readDeviceState({db:c.env.DB,env:c.env,shopId:machine.shop_id},device));
});

resourceSessionRouter.get("/session/power",async c=>{
  requireUser(c);
  const machine=await resolveResourceTicket(c,c.req.query("ticket")??"");
  return c.json({power:await resourcePowerState(c,machine)});
});

/**
 * Adding a card at this cabinet's reader: open a short window, then ask what
 * the reader saw. The first card put on the reader in the window, other than
 * one the platform sent, is added to the player's account and bound to them at
 * this shop. Only a cabinet connected directly reports cards back.
 */
resourceSessionRouter.post("/session/cards/capture",async c=>{
  const user=requireUser(c);
  const body=z.object({ticket:z.string().min(1),location:z.unknown().optional()}).parse(await c.req.json());
  const machine=await resolveResourceTicket(c,body.ticket);
  const shop=await getShopForMachine(c,machine.shop_public_id);
  checkShopLocation(shop,"machine",body.location);
  const device=await loadResource(c.env.DB,shop.id,machine.id);
  const io=device?hinataConfigOf(device):null;
  if(!io||io.transport!=="embedded"||!io.channel)jsonError(409,"这台机器不能添加卡片","CARD_CAPTURE_UNSUPPORTED");
  const relay=machineRelayNamespace(c.env);
  if(!relay||!c.env.URL_ENCRYPTION_KEY)jsonError(503,"添加卡片服务尚未配置","CARD_CAPTURE_UNAVAILABLE");
  const player=await requireShopPlayer(c,shop);
  const id=crypto.randomUUID(),expiresAt=Date.now()+CARD_CAPTURE_MS;
  const started=await relay.getByName(io.channel).startCardCapture({id,shopId:shop.id,userId:user.id,playerId:player.id,expiresAt});
  if(!started.ok)jsonError(409,"机台未在线，请联系店员","DEVICE_UNAVAILABLE");
  return c.json({captureId:id,expiresAt:new Date(expiresAt).toISOString()});
});

resourceSessionRouter.get("/session/cards/capture/:id",async c=>{
  const user=requireUser(c);
  const machine=await resolveResourceTicket(c,c.req.query("ticket")??"");
  const device=await loadResource(c.env.DB,machine.shop_id,machine.id);
  const io=device?hinataConfigOf(device):null;
  const relay=machineRelayNamespace(c.env);
  if(!io?.channel||!relay)return c.json({status:"expired"});
  return c.json(await relay.getByName(io.channel).cardCaptureResult(c.req.param("id"),user.id));
});

resourceSessionRouter.post("/session/actions",async c=>{
  requireUser(c);
  const body=actionSchema.parse(await c.req.json());
  if(body.action==="power.off")jsonError(403,"关机需要店员权限","FORBIDDEN");
  const machine=await resolveResourceTicket(c,body.ticket);
  if(body.action.startsWith("mahjong."))return operateMahjong(c,machine,body);
  return executeResourceAction(c,machine,body);
});

async function merchantMachine(c:import("hono").Context<AppBindings, any, any>,write=false):Promise<ScannedResource>{
  const user=requireUser(c);
  const id=c.req.param("id");
  if(!id)jsonError(400,"缺少资源编号","INVALID_REQUEST");
  const machine=await c.env.DB.prepare(
    "SELECT m.*,s.public_id AS shop_public_id FROM machines m JOIN shops s ON s.id=m.shop_id WHERE m.id=?",
  ).bind(id).first<ScannedResource>();
  if(!machine)jsonError(404,"没有找到这个资源","DEVICE_NOT_FOUND");
  if(user.role!=="admin"){
    const member=await c.env.DB.prepare(
      "SELECT role FROM shop_members WHERE shop_id=? AND user_id=?",
    ).bind(machine.shop_id,user.id).first<{role:string}>();
    if(!member)jsonError(403,"没有店铺管理权限","FORBIDDEN");
    if(write){
      const role=await c.env.DB.prepare(
        `SELECT s.role FROM shop_staff_accounts a JOIN staff_users s
         ON s.shop_id=a.shop_id AND s.id=a.staff_id
         WHERE a.shop_id=? AND a.user_id=? AND s.status='active'`,
      ).bind(machine.shop_id,user.id).first<{role:string}>();
      if(role?.role==="viewer")jsonError(403,"只读账号不能操作设备","FORBIDDEN");
    }
  }
  if(write&&!machine.enabled)jsonError(409,"这个资源已停用","DEVICE_DISABLED");
  return machine;
}

/**
 * The board's live channel: the shop hub pushes the state of every watched
 * device as its IO reports it, and the whole board again whenever a Home
 * Assistant connection starts or stops being watched. Members of the shop only;
 * the browser's Origin must be the platform's own, because the session is a
 * cookie.
 */
merchantResourceActionRouter.get("/machines/ws",async c=>{
  if(c.req.header("upgrade")?.toLowerCase()!=="websocket")jsonError(426,"需要 WebSocket 连接","UPGRADE_REQUIRED");
  const origin=c.req.header("origin");
  if(origin&&!allowedOrigins(c.env).has(origin))jsonError(403,"请求来源无效","FORBIDDEN");
  const user=requireUser(c);
  const shopId=c.req.query("shopId");
  if(!shopId)jsonError(400,"请选择店铺","SHOP_REQUIRED");
  await assertResourceShop(c,user,shopId);
  const hub=c.env.SHOP_HUB as unknown as {getByName(name:string):{fetch(request:Request):Promise<Response>}}|undefined;
  if(!hub)jsonError(503,"店铺连接服务尚未配置","SHOP_HUB_UNAVAILABLE");
  const headers=new Headers(c.req.raw.headers);
  headers.set("x-prism-hub-shop",shopId);
  headers.set("x-prism-hub-board","1");
  // Only the hub's board channel; the bot channel needs a bot token.
  headers.delete("authorization");
  return hub.getByName(shopId).fetch(new Request(c.req.raw,{headers}));
});

/**
 * The state of every device with power or an air conditioner, for the board, in
 * one request. A device on a watched Home Assistant connection answers from its
 * stored facts. An unwatched one has no state of its own, so Home Assistant is
 * asked for exactly those devices now, a few at a time, and nothing is recorded.
 */
const BOARD_LIVE_CONCURRENCY=4;
merchantResourceActionRouter.get("/machines/states",async c=>{
  const user=requireUser(c);
  const shopId=c.req.query("shopId");
  if(!shopId)jsonError(400,"请选择店铺","SHOP_REQUIRED");
  await assertResourceShop(c,user,shopId);
  const {devices,states}=await readBoardStates(c.env.DB,shopId);
  // A device nothing watches has no stored state, so Home Assistant is the only place to ask.
  const runtime={db:c.env.DB,env:c.env,shopId};
  const unwatched=devices.filter(device=>!states[device.id]!.watching);
  let next=0;
  await Promise.all(Array.from({length:Math.min(BOARD_LIVE_CONCURRENCY,unwatched.length)},async()=>{
    while(next<unwatched.length){
      const device=unwatched[next++]!;
      states[device.id]=await readDeviceState(runtime,device).catch(()=>noFacts);
    }
  }));
  return c.json({states});
});

/**
 * One device's power and air conditioner: the stored facts if it is watched, otherwise
 * Home Assistant is asked now (and nothing is recorded). For re-reading a device with no
 * state of its own after an action on it.
 */
merchantResourceActionRouter.get("/machines/:id/state",async c=>{
  const machine=await merchantMachine(c);
  const device=await loadResource(c.env.DB,machine.shop_id,machine.id);
  if(!device)return c.json(noFacts);
  return c.json(await readDeviceState({db:c.env.DB,env:c.env,shopId:machine.shop_id},device));
});

/**
 * Seats let staff see who is at the table before seating someone else. They are not Home
 * Assistant state, nothing pushes them, and reading them asks Home Assistant nothing.
 */
merchantResourceActionRouter.get("/machines/:id/mahjong",async c=>{
  const machine=await merchantMachine(c);
  return c.json({mahjong:await mahjongState(c,machine)});
});

merchantResourceActionRouter.post("/machines/:id/actions",async c=>{
  const machine=await merchantMachine(c,true);
  const raw=await c.req.json();
  const body=actionSchema.parse({...(raw as object),ticket:`staff:${machine.id}`});
  if(body.action.startsWith("mahjong."))return operateMahjong(c,machine,body,{staff:true});
  return executeResourceAction(c,machine,body,true);
});
