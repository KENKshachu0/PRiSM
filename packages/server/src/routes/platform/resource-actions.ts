import type { Context } from "hono";
import { z } from "zod";
import { jsonError, clientIp } from "../../http.js";
import { requireUser } from "../../middleware/auth.js";
import { checkShopLocation } from "../../middleware/geo.js";
import { enforceRateLimits } from "../../middleware/rate-limit.js";
import { getOrCreateShopDependencies } from "../../middleware/tenant.js";
import { refreshActivityBill } from "../../durable-objects/live-activity-billing.js";
import { runPlayerOperation } from "../shops/player-operation.js";
import { assertNotBanned, claimCoin, getShopForMachine as getBillingShop, requireShopPlayer, requireActiveEntry } from "./machine-login.js";
import type { Machine as MachineRow } from "./machine-session.js";
import type { AppBindings } from "../../bindings.js";
import { can, hinataConfigOf, loadDevice } from "../../devices/device.js";
import { vkFromKeyText } from "../../devices/key-text.js";
import { createRuntimeBus, readClimate, readPower, type ClimateState } from "../../devices/runtime.js";
import { touchShopHubAfter } from "../../durable-objects/shop-hub-client.js";
import { notice, requestLocale } from "../../notices.js";
import type { ActionName } from "../../devices/capabilities.js";

type C = Context<AppBindings, any, any>;

export const actionSchema=z.object({
  ticket:z.string().min(1),
  operationId:z.string().uuid(),
  action:z.enum([
    "power.on","power.off","aime.scan","coin","door.open",
    "climate.on","climate.off","climate.set_mode","climate.set_temperature","climate.set_fan_mode",
    "mahjong.join","mahjong.leave","mahjong.seat","mahjong.unseat",
  ]),
  /** Staff act on behalf of a chosen player for mahjong seats, or send a raw card. */
  playerId:z.string().min(1).optional(),
  /** A card number staff typed in: 20 digits, sent to the machine as-is. */
  cardNumber:z.string().regex(/^\d{20}$/).optional(),
  /** A key staff typed for the coin press; the configured key is the fallback. */
  key:z.string().trim().min(1).max(12).optional(),
  /** Climate settings. Which values an entity accepts is its own; Home Assistant rejects the rest. */
  mode:z.string().regex(/^[a-z_]{1,32}$/).optional(),
  temperature:z.number().finite().min(-20).max(60).optional(),
  fanMode:z.string().trim().min(1).max(40).optional(),
  consent:z.boolean().optional(),
  location:z.unknown().optional(),
});

/**
 * Power state for a device page: "unmanaged" when it has no power binding. A
 * watched connection answers from the stored fact; otherwise Home Assistant is
 * asked now. Neither writes anything.
 */
export async function devicePowerState(
  c: C,
  machine: MachineRow,
): Promise<"on" | "off" | "unknown" | "unmanaged"> {
  const device = await loadDevice(c.env.DB, machine.shop_id, machine.id);
  if (!device?.capabilities.has("power")) return "unmanaged";
  const power = await readPower({ db: c.env.DB, env: c.env, shopId: machine.shop_id }, device).catch(() => null);
  return power ?? "unknown";
}

/** Climate state for a device page; null when it has no climate binding or the state is unknown. */
export async function deviceClimateState(c: C, machine: MachineRow): Promise<ClimateState | null> {
  const device = await loadDevice(c.env.DB, machine.shop_id, machine.id);
  if (!device?.capabilities.has("climate")) return null;
  return readClimate({ db: c.env.DB, env: c.env, shopId: machine.shop_id }, device).catch(() => null);
}

/** The setting a climate action changes, checked before anything is recorded. */
function climatePayload(body: z.infer<typeof actionSchema>): Record<string, unknown> {
  if (body.action === "climate.set_mode") {
    if (!body.mode) jsonError(400, "请选择空调模式", "CLIMATE_MODE_REQUIRED");
    return { mode: body.mode };
  }
  if (body.action === "climate.set_temperature") {
    if (body.temperature === undefined) jsonError(400, "请设置温度", "CLIMATE_TEMPERATURE_REQUIRED");
    return { temperature: body.temperature };
  }
  if (body.action === "climate.set_fan_mode") {
    if (!body.fanMode) jsonError(400, "请选择风速", "CLIMATE_FAN_MODE_REQUIRED");
    return { fanMode: body.fanMode };
  }
  return {};
}

export async function executeDeviceAction(
  c: C,
  machine: MachineRow,
  body: z.infer<typeof actionSchema>,
  staff = false,
) {
  const user = requireUser(c);
  const shop = await getBillingShop(c, machine.shop_public_id);
  await assertNotBanned(c, [
    ["user", user.id],
    ["ip", clientIp(c.req.raw)],
    ["machine", machine.id],
  ]);
  const action = body.action as ActionName;
  const device = await loadDevice(c.env.DB, shop.id, machine.id);
  if (!device || !can(device, action))
    jsonError(409, "设备不支持此操作", "DEVICE_ACTION_UNSUPPORTED");
  const isDoor = action === "door.open";
  const isClimate = action.startsWith("climate.");
  const climate = isClimate ? climatePayload(body) : {};
  if (!staff)
    checkShopLocation(shop, isDoor ? "checkin" : "machine", body.location);
  const player = staff
    ? null
    : isDoor
      ? await requireShopPlayer(c, shop, true)
      : shop.billing_enabled
        ? { id: await requireActiveEntry(c, shop) }
        : device.capabilities.has("door")
          ? await requireShopPlayer(c, shop, true)
          : null;
  if (action === "coin") {
    if (!staff && hinataConfigOf(device)?.coinAfterSwipe)
      jsonError(409, "请通过刷卡投币", "COIN_VIA_SWIPE");
    // Only an explicit "off" blocks: an unreadable switch must not lock players out.
    if (device.capabilities.has("power") && (await readPower({ db: c.env.DB, env: c.env, shopId: shop.id }, device)) === "off")
      jsonError(409, "请先开机", "DEVICE_POWER_OFF");
  }
  const deps = getOrCreateShopDependencies(c.env.DB, shop, c.env.URL_ENCRYPTION_KEY, c.env);
  // A card scan sends a card to the machine. Staff either type the 20-digit
  // card number or name a player whose bound card is used. The number is
  // handed to the runner only; it is never stored.
  let accessCode: string | null = null;
  if (staff && action === "aime.scan") {
    if (body.cardNumber) {
      accessCode = body.cardNumber;
    } else if (body.playerId) {
      const identity = await c.env.DB.prepare(
        `SELECT subject FROM player_identities
         WHERE shop_id=? AND player_id=?
         ORDER BY CASE WHEN provider='aime' THEN 0 ELSE 1 END, created_at
         LIMIT 1`,
      ).bind(shop.id, body.playerId).first<{ subject: string }>();
      if (!identity)
        jsonError(409, "该玩家没有绑定的卡片", "SCAN_IDENTITY_NOT_BOUND_TO_PLAYER");
      accessCode = identity.subject;
    } else {
      jsonError(400, "请输入卡号或选择玩家", "CARD_REQUIRED");
    }
  }
  // A coin press may use a key the staff member typed instead of the device's
  // configured coin key. Players cannot choose the key: pressing arbitrary
  // keys would bypass the configured coin button.
  let coinKey: number | null = null;
  if (action === "coin" && body.key) {
    if (!staff) jsonError(403, "只有店员可以指定按键", "FORBIDDEN");
    coinKey = vkFromKeyText(body.key);
    if (coinKey === null) jsonError(400, "无法识别的按键", "INVALID_COIN_KEY");
  }
  return runPlayerOperation(
    c,
    shop.id,
    `${staff ? "staff-device" : "device"}/${machine.id}/${body.action}`,
    body,
    async () => {
      if (!c.env.RATE_LIMIT_10) jsonError(503, "限流服务尚未配置", "RATE_LIMIT_UNAVAILABLE");
      await enforceRateLimits(c, [
        {
          key: `device:${machine.id}:${user.id}`,
          limit: 10,
          windowSeconds: 60,
        },
      ]);
      if (action === "coin" && !(await claimCoin(c, shop.id, machine.id, body.operationId))) {
        jsonError(429, "请稍后再投币", "COIN_COOLDOWN");
      }
      if (!staff && isDoor && shop.billing_enabled) {
        try {
          await requireActiveEntry(c, shop);
        } catch (error) {
          if (!(error instanceof Error && "status" in error && error.status === 403)) throw error;
          if (!body.consent)
            jsonError(409, "请确认入场计费规则", "CHECKIN_CONSENT_REQUIRED");
          await deps.playerCommands.startSession({ playerId: player!.id });
        }
      }
      await c.env.DB.prepare(
        "UPDATE player_operations SET device_id=? WHERE shop_id=? AND user_id=? AND id=?",
      )
        .bind(machine.id, shop.id, user.id, body.operationId)
        .run();

      const bus = createRuntimeBus({ db: c.env.DB, env: c.env, shopId: shop.id });
      const done = await bus.perform({
        device,
        action,
        actor: player ? { type: "player", playerId: player.id } : { type: "staff", staffId: `user:${user.id}` },
        operationId: body.operationId,
        payload: { holder: player?.id ?? user.id, ...climate },
        ...(accessCode || coinKey !== null
          ? {
              transient: {
                ...(accessCode ? { accessCode } : {}),
                ...(coinKey !== null ? { key: coinKey } : {}),
              },
            }
          : {}),
      });
      if (done.operation.status !== "succeeded") {
        return c.json(
          {
            error: {
              code: "DEVICE_UNAVAILABLE",
              message: isDoor ? "获取开门密码失败，请联系店员" : "设备连接失败，请联系店员检查设备或配置",
              details: { operationId: body.operationId },
            },
          },
          502,
        );
      }
      if (player) {
        const sync = refreshActivityBill(c.env, shop.id, player.id, false, true).catch(error => console.error("Device live bill sync failed", error));
        try { c.executionCtx.waitUntil(sync); } catch { void sync; }
      }
      // Home Assistant answering 200 is the whole outcome: a watched connection
      // reports the new state as an event, and an unwatched one has no state to
      // report, so nothing is read back here.
      // A player or staff action may start or end an idle countdown.
      touchShopHubAfter(c, shop.id);
      // A coin leaves no state to show, so the player is told it went in.
      const notices = action === "coin" ? [notice("COIN_SENT", requestLocale(c.req.header("accept-language")))] : undefined;
      return c.json({ operationId: body.operationId, ...done.result, ...(notices ? { notices } : {}) });
    },
  );
}
