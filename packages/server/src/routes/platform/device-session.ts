import { Hono } from "hono";
import { createD1Repositories } from "@prism/adapter-d1";
import type { AppBindings } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { requireUser } from "../../middleware/auth.js";
import { isEntry } from "../../middleware/tenant.js";
import { getShopForMachine } from "./machine-login.js";
import { resolveMachineSession, type Machine } from "./machine-session.js";
import { executeDeviceAction, actionSchema, devicePowerState } from "./device-actions.js";
import { has, loadDevice } from "../../devices/device.js";
import { mahjongState, operateMahjong } from "./mahjong.js";

export const deviceSessionRouter=new Hono<AppBindings>();
export const merchantMachineActionRouter=new Hono<AppBindings>();

deviceSessionRouter.get("/session/state", async c=>{
  const user=requireUser(c);
  const machine=await resolveMachineSession(c,c.req.query("ticket")??"");
  const shop=await getShopForMachine(c,machine.shop_public_id);
  let gate:"ready"|"binding"|"entry"="ready";
  const device=await loadDevice(c.env.DB,shop.id,machine.id);
  const bound=(id:Parameters<typeof has>[1])=>!!device&&has(device,id);
  const needsEntry=
    (shop.billing_enabled&&(bound("hinata_io")||bound("power")||bound("mahjong")))
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
  return c.json({
    gate,coinUsed:false,
    mahjong:gate==="ready"?await mahjongState(c,machine):null,
    power:gate==="ready"&&bound("power")&&c.req.query("includePower")!=="0"
      ?await devicePowerState(c,machine):"unmanaged",
  });
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

merchantMachineActionRouter.get("/machines/:id/state",async c=>{
  const machine=await merchantMachine(c);
  return c.json({
    power:await devicePowerState(c,machine),
    // Seats let staff see who is at the table before seating someone else.
    mahjong:await mahjongState(c,machine),
  });
});

merchantMachineActionRouter.post("/machines/:id/actions",async c=>{
  const machine=await merchantMachine(c,true);
  const raw=await c.req.json();
  const body=actionSchema.parse({...(raw as object),ticket:`staff:${machine.id}`});
  if(body.action.startsWith("mahjong."))return operateMahjong(c,machine,body,{staff:true});
  return executeDeviceAction(c,machine,body,true);
});
