import type { Context } from "hono";
import { withOperationLease } from "@prism/application";
import { assertNotBanned, getShopForMachine as getBillingShop, requireShopPlayer } from "./machine-login.js";
import { createD1Repositories } from "@prism/adapter-d1";
import { canStartPriorityTimePricingSession } from "@prism/core";
import { requireUser } from "../../middleware/auth.js";
import { isEntry } from "../../middleware/tenant.js";
import { checkShopLocation } from "../../middleware/geo.js";
import { refreshActivityBill } from "../../durable-objects/live-activity-billing.js";
import { jsonError } from "../../http.js";
import { runPlayerOperation } from "../shops/player-operation.js";
import type { AppBindings } from "../../bindings.js";
import type { Machine as MachineRow } from "./machine-session.js";
import { loadDevice, mahjongConfigOf } from "../../devices/device.js";

type C = Context<AppBindings, any, any>;
export type { MahjongConfig } from "../../devices/capabilities.js";
async function mahjongConfig(c: C, machine: MachineRow) {
  const device = await loadDevice(c.env.DB, machine.shop_id, machine.id);
  return device ? mahjongConfigOf(device) : null;
}
// Stale seats never occupy capacity after checkout or a staff session closure.
const liveSeats = `SELECT ms.* FROM mahjong_seats ms
 WHERE EXISTS(SELECT 1 FROM players p WHERE p.shop_id=ms.shop_id AND p.id=ms.player_id AND p.status='active') AND (ms.entry_session_id IS NULL OR EXISTS (
 SELECT 1 FROM sessions e WHERE e.shop_id=ms.shop_id AND e.id=ms.entry_session_id AND e.status='active'))
 AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.shop_id=ms.shop_id AND s.id=ms.session_id AND s.status='closed')`;

export async function mahjongState(c: C, machine: MachineRow) {
  const config = await mahjongConfig(c, machine);
  if (!config) return null;
  const result = await c.env.DB.prepare(`SELECT p.id AS playerId, p.display_name AS name,
    CASE WHEN a.user_id=? THEN 1 ELSE 0 END AS mine,
    CASE WHEN s.status='active' THEN 1 ELSE 0 END AS playing
    FROM (${liveSeats}) ms
    JOIN players p ON p.shop_id=ms.shop_id AND p.id=ms.player_id
    LEFT JOIN shop_player_accounts a ON a.shop_id=ms.shop_id AND a.player_id=ms.player_id
    LEFT JOIN sessions s ON s.shop_id=ms.shop_id AND s.id=ms.session_id
    WHERE ms.machine_id=? ORDER BY ms.joined_at,ms.player_id`)
    .bind(requireUser(c).id,machine.id).all<{playerId:string;name:string;mine:number;playing:number}>();
  return { capacity: config.capacity, seats: result.results.map(s => ({ playerId:s.playerId, name:s.name, mine:!!s.mine, playing:!!s.playing })) };
}

/** A staff member seats a chosen player instead of themselves. */
async function staffTargetPlayer(c: C, shopId: string, playerId: string) {
  const player = await c.env.DB.prepare(
    "SELECT id,status FROM players WHERE shop_id=? AND id=?",
  ).bind(shopId, playerId).first<{id:string;status:string}>();
  if (!player) jsonError(404, "没有找到这个玩家", "PLAYER_NOT_FOUND");
  if (player.status !== "active")
    jsonError(409, "该玩家已停用", "PLAYER_DISABLED");
  return player;
}

export async function operateMahjong(
  c: C,
  machine: MachineRow,
  body: Record<string, unknown>,
  options: { staff?: boolean } = {},
) {
  const config = await mahjongConfig(c, machine);
  if (!config) jsonError(409,"设备不支持此操作","DEVICE_ACTION_UNSUPPORTED");
  await assertNotBanned(c, [["user",requireUser(c).id],["machine",machine.id]]);
  const shop = await getBillingShop(c,machine.shop_public_id);
  if (!options.staff) checkShopLocation(shop,"machine",body.location);
  const targetPlayerId = typeof body.playerId === "string" ? body.playerId : "";
  if (options.staff && !targetPlayerId)
    jsonError(400, "请选择玩家", "PLAYER_REQUIRED");
  const player = options.staff
    ? await staffTargetPlayer(c, shop.id, targetPlayerId)
    : await requireShopPlayer(c,shop,true);
  const joining = body.action === "mahjong.join" || body.action === "mahjong.seat";
  const repos = createD1Repositories({db:c.env.DB,shopId:shop.id,id:()=>crypto.randomUUID(),now:()=>new Date()});
  let entryId:string|null = null;
  if (joining && shop.billing_enabled) {
    // The seated player needs an entry, whether they seated themselves or staff
    // seated them.
    const entry = (await repos.sessions.findActiveByPlayerId(player.id)).find(s => isEntry(s,shop));
    if (!entry) jsonError(403,"请先确认入场","CHECKIN_REQUIRED");
    entryId = entry.id;
    const rules = (await repos.pricingConfigs.listEnabled()).filter(r => config.pricingConfigIds.includes(r.id));
    if (!rules.length || rules.length !== config.pricingConfigIds.length)
      jsonError(409,"请店家配置麻将计费规则","DEVICE_CONFIGURATION_REQUIRED");
    if (rules.every(r => r.kind === "time.priority" && !canStartPriorityTimePricingSession({
      config:{...r.provider,timeZone:r.provider.timeZone ?? "UTC"},at:new Date(),
    }))) jsonError(409,"当前不在麻将计费时段","PLAYER_SESSION_OUTSIDE_BILLABLE_TIME");
  }
  return runPlayerOperation(c,shop.id,`mahjong/${machine.id}`,body,()=>withOperationLease({
    repository:repos.operationLocks,scope:"mahjong.table",resourceId:machine.id,id:()=>crypto.randomUUID(),now:()=>new Date(),
  },async()=>{
    const seated = await c.env.DB.prepare("SELECT player_id FROM mahjong_seats WHERE machine_id=?").bind(machine.id).all<{player_id:string}>();
    const ids = [...new Set([player.id,...seated.results.map(s=>s.player_id)])].sort();
    const locked = <T,>(index:number, action:()=>Promise<T>):Promise<T> => index===ids.length ? action() : withOperationLease({
      repository:repos.operationLocks,scope:"player.assets",resourceId:ids[index]!,id:()=>crypto.randomUUID(),now:()=>new Date(),
    },()=>locked(index+1,action));
    return locked(0,async()=>{

    const db=c.env.DB, now=new Date().toISOString();
    if (joining) {
      const sessionId=crypto.randomUUID();
      await db.batch([
        db.prepare(`DELETE FROM mahjong_seats WHERE shop_id=? AND (shop_id,player_id) NOT IN (SELECT shop_id,player_id FROM (${liveSeats}))`).bind(shop.id),
        db.prepare(`INSERT INTO mahjong_seats(shop_id,player_id,machine_id,session_id,entry_session_id,joined_at)
          SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM mahjong_seats WHERE machine_id=?)<?
          AND (? IS NULL OR EXISTS(SELECT 1 FROM sessions WHERE shop_id=? AND id=? AND status='active'))
          ON CONFLICT(shop_id,player_id) DO NOTHING`)
          .bind(shop.id,player.id,machine.id,sessionId,entryId,now,machine.id,config.capacity,entryId,shop.id,entryId),
        // D1 batch is a transaction: all waiting players start at the same instant, or none do.
        db.prepare(`INSERT INTO sessions(shop_id,id,player_id,started_at,status,pricing_config_ids_json,payment_status,label,metadata_json)
          SELECT ms.shop_id,ms.session_id,ms.player_id,?,'active',?,'unpaid',?,?
          FROM mahjong_seats ms WHERE ms.machine_id=? AND ?=1
          AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.shop_id=ms.shop_id AND s.id=ms.session_id)
          AND ((SELECT COUNT(*) FROM mahjong_seats WHERE machine_id=?)>=?
            OR EXISTS(SELECT 1 FROM mahjong_seats a JOIN sessions s ON s.shop_id=a.shop_id AND s.id=a.session_id WHERE a.machine_id=? AND s.status='active'))`)
          .bind(now,JSON.stringify(config.pricingConfigIds),machine.name,JSON.stringify({mahjongDeviceId:machine.id}),machine.id,+!!shop.billing_enabled,machine.id,config.capacity,machine.id),
      ]);
      const seat=await db.prepare("SELECT machine_id FROM mahjong_seats WHERE shop_id=? AND player_id=?").bind(shop.id,player.id).first<{machine_id:string}>();
      if (!seat) jsonError(409,"当前无法上桌，请刷新后重试","MAHJONG_TABLE_FULL");
      if (seat.machine_id!==machine.id) jsonError(409,"请先从当前麻将桌下桌","MAHJONG_ALREADY_SEATED");
    } else {
      await db.batch([
        db.prepare(`UPDATE sessions SET status='closed',ended_at=? WHERE shop_id=? AND status='active'
          AND id IN (SELECT session_id FROM mahjong_seats WHERE shop_id=? AND player_id=? AND machine_id=?)`)
          .bind(now,shop.id,shop.id,player.id,machine.id),
        db.prepare("DELETE FROM mahjong_seats WHERE shop_id=? AND player_id=? AND machine_id=?").bind(shop.id,player.id,machine.id),
      ]);
    }
    const sync = Promise.all(ids.map(id => refreshActivityBill(c.env, shop.id, id, false, true)))
      .catch(error => console.error("Mahjong live bill sync failed", error));
    try { c.executionCtx.waitUntil(sync); } catch { void sync; }
    return c.json({mahjong:await mahjongState(c,machine)});
    });
  }).catch(error => {
    if (String(error).includes("PRICING_CONFIG_NOT_IN_RELEASE"))
      jsonError(409,"当前入场版本不包含此计费方案，请先结账后重新入场","PRICING_CONFIG_NOT_IN_RELEASE");
    if (error && typeof error === "object" && "code" in error && error.code === "OPERATION_IN_PROGRESS")
      jsonError(409,"其他操作正在进行，请重试","OPERATION_IN_PROGRESS");
    throw error;
  }));
}
