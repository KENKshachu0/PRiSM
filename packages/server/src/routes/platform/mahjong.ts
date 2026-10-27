import type { Context } from "hono";
import { PLAYER_BILLING_LOCK_SCOPE, withOperationLease } from "@prism/application";
import { assertNotBanned, getShopForMachine as getBillingShop, requireShopPlayer } from "./machine-login.js";
import { createD1Repositories } from "@prism/adapter-d1";
import { canStartPriorityTimePricingSession } from "@prism/core";
import { requireUser } from "../../middleware/auth.js";
import { getOrCreateShopDependencies } from "../../middleware/tenant.js";
import { checkShopLocation } from "../../middleware/geo.js";
import { refreshActivityBill } from "../../durable-objects/live-activity-billing.js";
import { jsonError } from "../../http.js";
import { runPlayerOperation } from "../shops/player-operation.js";
import type { AppBindings } from "../../bindings.js";
import type { ScannedResource as ScannedResource } from "./resource-ticket.js";
import { loadResource, mahjongConfigOf } from "../../resources/resource.js";
import { liveSeatsSql } from "../../resources/capabilities/mahjong-occupancy.js";
import { createOccupancy } from "../../resources/occupancy/service.js";

type C = Context<AppBindings, any, any>;
export type { MahjongConfig } from "../../resources/capabilities/catalog.js";
/** The table's plan and size; its size is the resource's capacity. */
async function mahjongConfig(c: C, machine: ScannedResource) {
  const device = await loadResource(c.env.DB, machine.shop_id, machine.id);
  const config = device ? mahjongConfigOf(device) : null;
  return device && config ? { ...config, capacity: device.capacity } : null;
}
// A seat lives as long as the session it runs on; see `mahjong-occupancy.ts`.
const liveSeats = liveSeatsSql;

/** Seats at a table; `mine` marks the viewer's seat: the signed-in user's, or a player's for the bot. */
export async function mahjongState(c: C, machine: ScannedResource, viewer?: { playerId: string }) {
  const config = await mahjongConfig(c, machine);
  if (!config) return null;
  const result = await c.env.DB.prepare(`SELECT p.id AS playerId, p.display_name AS name,
    CASE WHEN ${viewer ? "ms.player_id=?" : "a.user_id=?"} THEN 1 ELSE 0 END AS mine,
    CASE WHEN s.status='active' THEN 1 ELSE 0 END AS playing
    FROM (${liveSeats}) ms
    JOIN players p ON p.shop_id=ms.shop_id AND p.id=ms.player_id
    LEFT JOIN shop_player_accounts a ON a.shop_id=ms.shop_id AND a.player_id=ms.player_id
    LEFT JOIN sessions s ON s.shop_id=ms.shop_id AND s.id=ms.session_id
    WHERE ms.machine_id=? ORDER BY ms.joined_at,ms.player_id`)
    .bind(viewer?.playerId ?? requireUser(c).id,machine.id).all<{playerId:string;name:string;mine:number;playing:number}>();
  return { capacity: config.capacity, seats: result.results.map(s => ({ playerId:s.playerId, name:s.name, mine:!!s.mine, playing:!!s.playing })) };
}

/** A staff member seats a chosen player instead of themselves. */
async function staffTargetPlayer(c: C, shopId: string, playerId: string) {
  const player = await c.env.DB.prepare(
    "SELECT id,status FROM players WHERE shop_id=? AND id=?",
  ).bind(shopId, playerId).first<{id:string;status:string}>();
  if (!player) jsonError(404, "没有找到这个玩家", "PLAYER_NOT_FOUND");
  if (player.status !== "active")
    jsonError(403, "店铺玩家资格已停用", "PLAYER_DISABLED");
  return player;
}

export async function operateMahjong(
  c: C,
  machine: ScannedResource,
  body: Record<string, unknown>,
  /**
   * `staff`: a staff member seats `body.playerId`. `bot`: the shop bot acts for
   * a player it already resolved by platform identity; the player's own
   * command is their confirmation, as a staff member's is.
   */
  options: { staff?: boolean; bot?: { playerId: string } } = {},
) {
  const config = await mahjongConfig(c, machine);
  if (!config) jsonError(409,"这里不支持此操作","DEVICE_ACTION_UNSUPPORTED");
  await assertNotBanned(c, options.bot ? [["machine",machine.id]] : [["user",requireUser(c).id],["machine",machine.id]]);
  const shop = await getBillingShop(c,machine.shop_public_id);
  if (!options.staff && !options.bot) checkShopLocation(shop,"machine",body.location);
  const targetPlayerId = typeof body.playerId === "string" ? body.playerId : "";
  if (options.staff && !targetPlayerId)
    jsonError(400, "请选择玩家", "PLAYER_REQUIRED");
  const player = options.bot
    ? await staffTargetPlayer(c, shop.id, options.bot.playerId)
    : options.staff
      ? await staffTargetPlayer(c, shop.id, targetPlayerId)
      : await requireShopPlayer(c,shop);
  const confirmedForPlayer = !!options.staff || !!options.bot;
  const joining = body.action === "mahjong.join" || body.action === "mahjong.seat";
  const repos = createD1Repositories({db:c.env.DB,shopId:shop.id,id:()=>crypto.randomUUID(),now:()=>new Date()});
  const deps = getOrCreateShopDependencies(c.env.DB, shop, c.env.URL_ENCRYPTION_KEY, c.env);
  const pricingSessions = deps.pricingSessions;
  const occupancy = createOccupancy({ db: c.env.DB, shopId: shop.id });
  // The table bills exactly one plan; whatever that plan requires (usually the
  // base play) is started alongside it by the orchestrator.
  const tablePlanId = config.pricingConfigIds.length === 1 ? config.pricingConfigIds[0]! : null;
  let entryId:string|null = null;
  let entryOwned = false;
  // A table without a plan seats players for free.
  const billed = !!(await deps.resourceBilling.planOf(machine.id));
  if (joining && billed) {
    // Sitting at the table needs the table's own plan running, as using any
    // resource does: that plan is what a seat bills while the table waits to
    // fill. A player confirmed it on the table's page; staff seating someone
    // confirms it for them. Getting up ends it only if it was started for this
    // table, not a plan the player was already billing elsewhere.
    let running = await deps.resourceBilling.activeSession({ resourceId: machine.id, playerId: player.id });
    if (!running && confirmedForPlayer && await seatAvailable(c, shop.id, machine.id, player.id, config.capacity)) {
      running = (await deps.resourceBilling.activate({ resourceId: machine.id, playerId: player.id })).session;
    }
    if (!running) jsonError(403,"请先确认开始计费","CHECKIN_REQUIRED");
    entryId = running.id;
    entryOwned = running.metadata?.resourceId === machine.id;
    const rule = tablePlanId ? (await repos.pricingConfigs.listEnabled()).find(r => r.id === tablePlanId) : null;
    if (!rule) jsonError(409,"请店家配置麻将计费规则","DEVICE_CONFIGURATION_REQUIRED");
    if (rule.kind === "time.priority" && !canStartPriorityTimePricingSession({
      config:{...rule.provider,timeZone:rule.provider.timeZone ?? "UTC"},at:new Date(),
    })) jsonError(409,"当前不在麻将计费时段","PLAYER_SESSION_OUTSIDE_BILLABLE_TIME");
  }
  // A bot's request is replayed by the shop hub, not by player operation records.
  const once = (action: () => Promise<Response>) =>
    options.bot ? action() : runPlayerOperation(c,shop.id,`mahjong/${machine.id}`,body,action);
  return once(()=>withOperationLease({
    repository:repos.operationLocks,scope:"mahjong.table",resourceId:machine.id,id:()=>crypto.randomUUID(),now:()=>new Date(),
  },async()=>{
    const seated = await c.env.DB.prepare("SELECT player_id FROM mahjong_seats WHERE machine_id=?").bind(machine.id).all<{player_id:string}>();
    const ids = [...new Set([player.id,...seated.results.map(s=>s.player_id)])].sort();
    const locked = <T,>(index:number, action:()=>Promise<T>):Promise<T> => index===ids.length ? action() : withOperationLease({
      repository:repos.operationLocks,scope:PLAYER_BILLING_LOCK_SCOPE,resourceId:ids[index]!,id:()=>crypto.randomUUID(),now:()=>new Date(),
    },()=>locked(index+1,action));
    return locked(0,async()=>{

    const db=c.env.DB, at=new Date(), now=at.toISOString();
    if (joining) {
      const sessionId=crypto.randomUUID();
      const seatedBefore=await db.prepare("SELECT 1 FROM mahjong_seats WHERE shop_id=? AND player_id=? AND machine_id=?").bind(shop.id,player.id,machine.id).first();
      await db.batch([
        db.prepare(`DELETE FROM mahjong_seats WHERE shop_id=? AND (shop_id,player_id) NOT IN (SELECT shop_id,player_id FROM (${liveSeats}))`).bind(shop.id),
        db.prepare(`INSERT INTO mahjong_seats(shop_id,player_id,machine_id,session_id,entry_session_id,entry_owned,joined_at)
          SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM mahjong_seats WHERE machine_id=?)<?
          AND (? IS NULL OR EXISTS(SELECT 1 FROM sessions WHERE shop_id=? AND id=? AND status='active'))
          ON CONFLICT(shop_id,player_id) DO NOTHING`)
          .bind(shop.id,player.id,machine.id,sessionId,entryId,+entryOwned,now,machine.id,config.capacity,entryId,shop.id,entryId),
      ]);
      const seat=await db.prepare("SELECT machine_id FROM mahjong_seats WHERE shop_id=? AND player_id=?").bind(shop.id,player.id).first<{machine_id:string}>();
      if (!seat) jsonError(409,"已满桌","MAHJONG_TABLE_FULL");
      if (seat.machine_id!==machine.id) jsonError(409,"请先从当前麻将桌下桌","MAHJONG_ALREADY_SEATED");
      if (billed && tablePlanId) {
        try { await openTable(db, shop.id, machine, config.capacity, tablePlanId, at, pricingSessions); }
        catch (error) {
          // A table that cannot bill everyone does not seat the newcomer either.
          if (!seatedBefore) await db.prepare("DELETE FROM mahjong_seats WHERE shop_id=? AND player_id=? AND machine_id=?").bind(shop.id,player.id,machine.id).run();
          throw error;
        }
      }
    } else {
      // Getting up ends only the session the seat currently runs on: the table
      // plan's once the table plays, otherwise the waiting session, and that
      // one only if it was started for this table and nothing else running
      // needs it. The
      // plans that came along (the base play) keep billing; leaving the shop
      // is checking out.
      const seat=await db.prepare(`SELECT s.id, s.status, s.pricing_config_ids_json AS plans,
          e.id AS entryId, e.status AS entryStatus, e.pricing_config_ids_json AS entryPlans, ms.entry_owned AS entryOwned
        FROM mahjong_seats ms
        LEFT JOIN sessions s ON s.shop_id=ms.shop_id AND s.id=ms.session_id
        LEFT JOIN sessions e ON e.shop_id=ms.shop_id AND e.id=ms.entry_session_id
        WHERE ms.shop_id=? AND ms.player_id=? AND ms.machine_id=?`).bind(shop.id,player.id,machine.id)
        .first<{id:string|null;status:string|null;plans:string|null;entryId:string|null;entryStatus:string|null;entryPlans:string|null;entryOwned:number}>();
      if (!seat) jsonError(409,"你不在这张麻将桌上","MAHJONG_NOT_SEATED");
      const planOf = (plans: string | null) => {
        const ids = plans ? JSON.parse(plans) as string[] : [];
        return ids.length === 1 && ids[0] !== "default" ? ids[0]! : null;
      };
      const end = async (sessionId: string, plans: string | null, onlyAlone: boolean) => {
        const planId = planOf(plans);
        if (!planId) {
          await db.prepare("UPDATE sessions SET status='closed',ended_at=? WHERE shop_id=? AND id=? AND status='active'").bind(now,shop.id,sessionId).run();
          return;
        }
        if (onlyAlone) {
          const preview = await pricingSessions.previewDeactivate({ playerId: player.id, pricingConfigId: planId, at });
          if (preview.stopped.length > 1) return;
        }
        await pricingSessions.deactivate({ playerId: player.id, pricingConfigId: planId, at });
      };
      if (seat.status==="active" && seat.id) await end(seat.id, seat.plans, false);
      else if (!seat.status && seat.entryOwned && seat.entryStatus==="active" && seat.entryId) await end(seat.entryId, seat.entryPlans, true);
      await db.prepare("DELETE FROM mahjong_seats WHERE shop_id=? AND player_id=? AND machine_id=?").bind(shop.id,player.id,machine.id).run();
      await occupancy.left({ resourceId: machine.id, playerId: player.id, at });
    }
    await occupancy.syncHeld(at).catch(error => console.error("Occupancy sync failed", error));
    const sync = Promise.all(ids.map(id => refreshActivityBill(c.env, shop.id, id, false, true)))
      .catch(error => console.error("Mahjong live bill sync failed", error));
    try { c.executionCtx.waitUntil(sync); } catch { void sync; }
    // What still bills after getting up, so the player knows leaving the shop is checking out.
    const remaining = joining || !billed ? undefined
      : (await pricingSessions.getActive(player.id)).active.map(plan => plan.planName);
    return c.json({mahjong:await mahjongState(c,machine,options.bot),...(remaining ? { billing: { remaining } } : {})});
    });
  }).catch(error => {
    if (String(error).includes("PRICING_CONFIG_NOT_IN_RELEASE"))
      jsonError(409,"当前入场版本不包含此计费方案，请先结账后重新入场","PRICING_CONFIG_NOT_IN_RELEASE");
    if (error && typeof error === "object" && "code" in error && error.code === "OPERATION_IN_PROGRESS")
      jsonError(409,"其他操作正在进行，请重试","OPERATION_IN_PROGRESS");
    throw error;
  }));
}

/**
 * Starts the table plan for every seated player once the table is open: when
 * it is full, or when someone is already playing (a later joiner starts at
 * once). Every player is previewed before any is started, so a plan the
 * table cannot bill for one player starts for none; all start at one instant.
 */
async function openTable(
  db: C["env"]["DB"],
  shopId: string,
  machine: ScannedResource,
  capacity: number,
  planId: string,
  at: Date,
  pricingSessions: ReturnType<typeof getOrCreateShopDependencies>["pricingSessions"],
) {
  const seats = (await db.prepare(`SELECT ms.player_id AS playerId, ms.session_id AS sessionId, s.status AS status
    FROM mahjong_seats ms LEFT JOIN sessions s ON s.shop_id=ms.shop_id AND s.id=ms.session_id
    WHERE ms.shop_id=? AND ms.machine_id=? ORDER BY ms.joined_at, ms.player_id`)
    .bind(shopId, machine.id).all<{ playerId: string; sessionId: string; status: string | null }>()).results;
  const open = seats.length >= capacity || seats.some((seat) => seat.status === "active");
  const waiting = seats.filter((seat) => seat.status === null);
  if (!open || waiting.length === 0) return;
  const activation = (seat: (typeof waiting)[number]) => ({
    playerId: seat.playerId,
    pricingConfigId: planId,
    sessionId: seat.sessionId,
    label: machine.name,
    metadata: { mahjongDeviceId: machine.id },
    at,
  });
  for (const seat of waiting) await pricingSessions.previewActivate(activation(seat));
  for (const seat of waiting) {
    const started = await pricingSessions.activate(activation(seat));
    // A plan already running for the player is reused; the seat follows it.
    if (started.session.id !== seat.sessionId) {
      await db.prepare("UPDATE mahjong_seats SET session_id=? WHERE shop_id=? AND player_id=? AND machine_id=?")
        .bind(started.session.id, shopId, seat.playerId, machine.id).run();
    }
  }
}

/** Whether the player could take a seat here, so staff seating never bills for a seat that is not there. */
async function seatAvailable(c: C, shopId: string, machineId: string, playerId: string, capacity: number) {
  const row = await c.env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM (${liveSeats}) ms WHERE ms.machine_id=?) AS taken,
    EXISTS(SELECT 1 FROM (${liveSeats}) ms WHERE ms.shop_id=? AND ms.player_id=?) AS seated`)
    .bind(machineId, shopId, playerId).first<{ taken: number; seated: number }>();
  if (row?.seated) jsonError(409, "请先从当前麻将桌下桌", "MAHJONG_ALREADY_SEATED");
  if ((row?.taken ?? 0) >= capacity) jsonError(409, "已满桌", "MAHJONG_TABLE_FULL");
  return true;
}
