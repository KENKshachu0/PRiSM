import { Hono, type Context } from "hono";
import { createD1Repositories } from "@prism/adapter-d1";
import type { AppBindings } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { optionalUser, requireUser } from "../../middleware/auth.js";
import { isEntry } from "../../middleware/tenant.js";
import { getShopForMachine } from "./machine-login.js";
import { publicMachine, resolveMachineSession, type Machine } from "./machine-session.js";
import { executeDeviceAction, actionSchema, deviceClimateState, devicePowerState } from "./device-actions.js";
import { has, loadDevice } from "../../devices/device.js";
import { readDeviceState } from "../../devices/runtime.js";
import { noFacts, readBoardStates, readDeviceFacts } from "../../devices/state-view.js";
import { assertMachineShop } from "./merchant-machines.js";
import { allowedOrigins } from "../../middleware/cors.js";
import { mahjongState, operateMahjong } from "./mahjong.js";

export const deviceSessionRouter=new Hono<AppBindings>();
export const merchantMachineActionRouter=new Hono<AppBindings>();

/**
 * Live updates for a device page: the shop hub pushes this device's power and
 * air-conditioner state as its watchers report it, and tells the page when
 * something it shows changed (a bot confirmed its binding). It also says
 * whether the device is watched at all, so an unwatched page keeps asking for
 * what it needs.
 */
deviceSessionRouter.get("/session/ws", async c=>{
  if(c.req.header("upgrade")?.toLowerCase()!=="websocket")jsonError(426,"需要 WebSocket 连接","UPGRADE_REQUIRED");
  const user=requireUser(c);
  const machine=await resolveMachineSession(c,c.req.query("ticket")??"");
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
 * bind an identity or enter first, mahjong seats, and the device's stored
 * facts. The facts are only what is already known (`device.watching` says
 * whether they are current); nothing here asks Home Assistant. `includePower`
 * and `includeClimate` keep the older contract, where this read also asked
 * Home Assistant, for clients that have not moved to `device`.
 */
async function sessionState(c:C,machine:Machine,options:{includePower:boolean;includeClimate:boolean}){
  const user=requireUser(c);
  const shop=await getShopForMachine(c,machine.shop_public_id);
  let gate:"ready"|"binding"|"entry"="ready";
  const device=await loadDevice(c.env.DB,shop.id,machine.id);
  const bound=(id:Parameters<typeof has>[1])=>!!device&&has(device,id);
  const needsEntry=
    (shop.billing_enabled&&(bound("hinata_io")||bound("power")||bound("climate")||bound("mahjong")))
    ||bound("door")||bound("mahjong");
  if(needsEntry){
    const player=await c.env.DB.prepare(
      `SELECT a.player_id AS playerId,p.status,
       EXISTS(SELECT 1 FROM shop_platform_bindings b WHERE b.shop_id=? AND b.user_id=?) AS identityBound
       FROM (SELECT 1) x
       LEFT JOIN shop_player_accounts a ON a.shop_id=? AND a.user_id=?
       LEFT JOIN players p ON p.shop_id=a.shop_id AND p.id=a.player_id`,
    ).bind(shop.id,user.id,shop.id,user.id).first<{playerId:string|null;status:string|null;identityBound:number}>();
    if(shop.identity_binding_required&&!player?.identityBound)gate="binding";
    else if(!player?.playerId)gate=shop.billing_enabled?"entry":"ready";
    else if(player.status!=="active")jsonError(403,"店铺玩家资格已停用","PLAYER_DISABLED");
    else if(shop.billing_enabled){
      const repos=createD1Repositories({db:c.env.DB,shopId:shop.id,id:()=>crypto.randomUUID(),now:()=>new Date()});
      const sessions=await repos.sessions.findActiveByPlayerId(player.playerId);
      if(!sessions.some(session=>isEntry(session,shop)))gate="entry";
    }
  }
  const facts=device?await readDeviceFacts(c.env.DB,shop.id,device):noFacts;
  return {
    gate,coinUsed:false,
    mahjong:gate==="ready"?await mahjongState(c,machine):null,
    power:gate==="ready"&&bound("power")&&options.includePower
      ?await devicePowerState(c,machine):"unmanaged",
    climate:gate==="ready"&&bound("climate")&&options.includeClimate?await deviceClimateState(c,machine):null,
    device:facts,
  };
}

deviceSessionRouter.get("/session/state", async c=>{
  const machine=await resolveMachineSession(c,c.req.query("ticket")??"");
  return c.json(await sessionState(c,machine,{
    includePower:c.req.query("includePower")!=="0",
    includeClimate:c.req.query("includeClimate")!=="0",
  }));
});

/**
 * The first read of a scanned page: the machine and, for a signed-in player,
 * the page state, in one request instead of two in sequence.
 */
deviceSessionRouter.get("/session/bootstrap", async c=>{
  const machine=await resolveMachineSession(c,c.req.query("ticket")??"");
  return c.json({
    machine:await publicMachine(c,machine),
    state:optionalUser(c)?await sessionState(c,machine,{includePower:false,includeClimate:false}):null,
  });
});

/**
 * Power and climate for a page that is not watched. A watched device answers
 * from its stored facts; otherwise Home Assistant is asked now, in parallel
 * for both, and nothing is recorded.
 */
deviceSessionRouter.get("/session/device", async c=>{
  requireUser(c);
  const machine=await resolveMachineSession(c,c.req.query("ticket")??"");
  const device=await loadDevice(c.env.DB,machine.shop_id,machine.id);
  if(!device)return c.json(noFacts);
  return c.json(await readDeviceState({db:c.env.DB,env:c.env,shopId:machine.shop_id},device));
});

deviceSessionRouter.get("/session/power",async c=>{
  requireUser(c);
  const machine=await resolveMachineSession(c,c.req.query("ticket")??"");
  return c.json({power:await devicePowerState(c,machine)});
});

deviceSessionRouter.post("/session/actions",async c=>{
  requireUser(c);
  const body=actionSchema.parse(await c.req.json());
  if(body.action==="power.off")jsonError(403,"关机需要店员权限","FORBIDDEN");
  const machine=await resolveMachineSession(c,body.ticket);
  if(body.action.startsWith("mahjong."))return operateMahjong(c,machine,body);
  return executeDeviceAction(c,machine,body);
});

async function merchantMachine(c:import("hono").Context<AppBindings, any, any>,write=false):Promise<Machine>{
  const user=requireUser(c);
  const id=c.req.param("id");
  if(!id)jsonError(400,"缺少设备编号","INVALID_REQUEST");
  const machine=await c.env.DB.prepare(
    "SELECT m.*,s.public_id AS shop_public_id FROM machines m JOIN shops s ON s.id=m.shop_id WHERE m.id=?",
  ).bind(id).first<Machine>();
  if(!machine)jsonError(404,"没有找到这台设备","DEVICE_NOT_FOUND");
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
  if(write&&!machine.enabled)jsonError(409,"设备已停用","DEVICE_DISABLED");
  return machine;
}

/**
 * The board's live channel: the shop hub pushes the state of every watched
 * device as its IO reports it, and the whole board again whenever a Home
 * Assistant connection starts or stops being watched. Members of the shop only;
 * the browser's Origin must be the platform's own, because the session is a
 * cookie.
 */
merchantMachineActionRouter.get("/machines/ws",async c=>{
  if(c.req.header("upgrade")?.toLowerCase()!=="websocket")jsonError(426,"需要 WebSocket 连接","UPGRADE_REQUIRED");
  const origin=c.req.header("origin");
  if(origin&&!allowedOrigins(c.env).has(origin))jsonError(403,"请求来源无效","FORBIDDEN");
  const user=requireUser(c);
  const shopId=c.req.query("shopId");
  if(!shopId)jsonError(400,"请选择店铺","SHOP_REQUIRED");
  await assertMachineShop(c,user,shopId);
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
merchantMachineActionRouter.get("/machines/states",async c=>{
  const user=requireUser(c);
  const shopId=c.req.query("shopId");
  if(!shopId)jsonError(400,"请选择店铺","SHOP_REQUIRED");
  await assertMachineShop(c,user,shopId);
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
merchantMachineActionRouter.get("/machines/:id/state",async c=>{
  const machine=await merchantMachine(c);
  const device=await loadDevice(c.env.DB,machine.shop_id,machine.id);
  if(!device)return c.json(noFacts);
  return c.json(await readDeviceState({db:c.env.DB,env:c.env,shopId:machine.shop_id},device));
});

/**
 * Seats let staff see who is at the table before seating someone else. They are not Home
 * Assistant state, nothing pushes them, and reading them asks Home Assistant nothing.
 */
merchantMachineActionRouter.get("/machines/:id/mahjong",async c=>{
  const machine=await merchantMachine(c);
  return c.json({mahjong:await mahjongState(c,machine)});
});

merchantMachineActionRouter.post("/machines/:id/actions",async c=>{
  const machine=await merchantMachine(c,true);
  const raw=await c.req.json();
  const body=actionSchema.parse({...(raw as object),ticket:`staff:${machine.id}`});
  if(body.action.startsWith("mahjong."))return operateMahjong(c,machine,body,{staff:true});
  return executeDeviceAction(c,machine,body,true);
});
