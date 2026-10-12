import type { Context } from "hono";
import { z } from "zod";
import { TTLockClient } from "../../hardware/ttlock.js";
import { sendHinataCoin } from "../../hardware/hinata.js";
import { normalizeTTLockConnectionConfig } from "@prism/application";
import { decryptSecret } from "../../crypto.js";
import { jsonError, clientIp } from "../../http.js";
import { requireUser } from "../../middleware/auth.js";
import { checkShopLocation } from "../../middleware/geo.js";
import { enforceRateLimits } from "../../middleware/rate-limit.js";
import { getOrCreateShopDependencies } from "../../middleware/tenant.js";
import { refreshActivityBill } from "../../durable-objects/live-activity-billing.js";
import { runPlayerOperation } from "../shops/player-operation.js";
import { assertNotBanned, claimCoin, getShopForMachine as getBillingShop, requireShopPlayer, requireActiveEntry, machinePower } from "./machine-login.js";
import type { Machine as MachineRow } from "./machine-session.js";
import type { AppBindings } from "../../bindings.js";

type C = Context<AppBindings, any, any>;
type HA={url:string;token:string;entityId:string};

export const actionSchema=z.object({
  ticket:z.string().min(1),
  operationId:z.string().uuid(),
  action:z.enum(["power.on","power.off","coin","door.open","mahjong.join","mahjong.leave"]),
  consent:z.boolean().optional(),
  location:z.unknown().optional(),
});

async function haBinding(c:C,machine:MachineRow):Promise<HA|null> {
  if(!machine.ha_binding_encrypted)return null;
  if(!c.env.URL_ENCRYPTION_KEY)jsonError(503,"设备密钥尚未配置","DEVICE_ENCRYPTION_UNAVAILABLE");
  return JSON.parse(await decryptSecret(machine.ha_binding_encrypted,c.env.URL_ENCRYPTION_KEY)) as HA;
}
async function devicePower(c:C,machine:MachineRow) {
  return machinePower(c,machine);
}
async function requirePoweredMachine(c:C,machine:MachineRow) {
  if(!machine.hinata_url_encrypted)
    jsonError(409,"设备不支持此操作","DEVICE_ACTION_UNSUPPORTED");
  if(await devicePower(c,machine)==="off")
    jsonError(409,"请先开机","DEVICE_POWER_OFF");
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
  const isDoor = body.action === "door.open";
  if (isDoor && !machine.ttlock_lock_id)
    jsonError(409, "设备不支持此操作", "DEVICE_ACTION_UNSUPPORTED");
  if (!staff)
    checkShopLocation(shop, isDoor ? "checkin" : "machine", body.location);
  const player = staff
    ? null
    : isDoor
      ? await requireShopPlayer(c, shop, true)
      : shop.billing_enabled
        ? { id: await requireActiveEntry(c, shop) }
        : machine.ttlock_lock_id
          ? await requireShopPlayer(c, shop, true)
          : null;
  const isPower = body.action === "power.on" || body.action === "power.off";
  const ha = isPower ? await haBinding(c, machine) : null;
  if (isPower && !ha)
    jsonError(409, "设备未绑定电源", "DEVICE_ACTION_UNSUPPORTED");
  const deps = getOrCreateShopDependencies(c.env.DB, shop, c.env.URL_ENCRYPTION_KEY);
  const lockSettingRow = isDoor
    ? await c.env.DB.prepare(
        "SELECT value_json FROM app_settings WHERE shop_id=? AND key='devices.ttlock_connection'",
      )
        .bind(shop.id)
        .first<{ value_json: string }>()
    : null;
  const lockSetting = lockSettingRow?.value_json;
  const connection = isDoor
    ? normalizeTTLockConnectionConfig(
        lockSetting ? JSON.parse(lockSetting) : undefined,
      )
    : null;
  if (
    isDoor &&
    (!machine.ttlock_lock_id ||
      !connection?.clientId ||
      !(
        connection.accessToken ||
        connection.refreshToken ||
        (connection.appAccount && connection.appPwd)
      ))
  )
    jsonError(409, "店家尚未配置门锁", "DEVICE_CONFIGURATION_REQUIRED");
  if (body.action === "coin") {
    if (machine.coin_key <= 0)
      jsonError(409, "设备未启用投币", "DEVICE_ACTION_UNSUPPORTED");
    if (!staff && machine.coin_after_swipe)
      jsonError(409, "请通过刷卡投币", "DEVICE_ACTION_UNSUPPORTED");
    await requirePoweredMachine(c, machine);
    if (!machine.hinata_password_encrypted)
      jsonError(
        409,
        "投币需要 HINATA IO 连接密码",
        "DEVICE_CONFIGURATION_REQUIRED",
      );
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
      if (body.action === "coin") {
        if (!(await claimCoin(c, shop.id, machine.id, body.operationId))) {
          jsonError(429, "请稍后再投币", "COIN_COOLDOWN");
        }
      }
      if (!staff && isDoor && shop.billing_enabled) {
        try {
          await requireActiveEntry(c, shop);
        } catch (error) {
          if (!(
            error instanceof Error &&
            "status" in error &&
            error.status === 403
          ))
            throw error;
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
      const executor = isDoor
        ? "ttlock"
        : body.action === "coin"
          ? "hinata_io"
          : "home_assistant";
      const now = new Date().toISOString();
      await c.env.DB.prepare(
        "INSERT INTO device_commands(shop_id,id,type,device_id,target_kind,executor_kind,player_id,status,payload_json,requested_at) VALUES (?,?,?,?,?,?,?,'pending','{}',?)",
      )
        .bind(
          shop.id,
          body.operationId,
          body.action,
          machine.id,
          isDoor ? "facility" : "game_machine",
          executor,
          player?.id ?? null,
          now,
        )
        .run();
      let result: Record<string, unknown> = {};
      try {
        if (isDoor) {
          const client = new TTLockClient({
            connection: connection!,
            fetcher: (url, init) =>
              fetch(url, { ...init, signal: AbortSignal.timeout(10000) }),
            onConnectionUpdated: async (value) => {
              await c.env.DB.prepare(
                "UPDATE app_settings SET value_json=?,updated_at=? WHERE shop_id=? AND key='devices.ttlock_connection'",
              )
                .bind(JSON.stringify(value), new Date().toISOString(), shop.id)
                .run();
            },
          });
          const pwd = await client.createRandomTemporaryPassword(
            machine.ttlock_lock_id!,
            `prism:${player?.id ?? user.id}`,
          );
          result = {
            temporaryPassword: pwd.password,
            expiresAt: pwd.expiresAt,
          };
        } else if (body.action === "power.on" || body.action === "power.off") {
          const response = await fetch(
            `${ha!.url.replace(/\/+$/, "")}/api/services/${ha!.entityId.split(".")[0]}/${body.action === "power.on" ? "turn_on" : "turn_off"}`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${ha!.token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ entity_id: ha!.entityId }),
              signal: AbortSignal.timeout(10000),
            },
          );
          if (!response.ok) throw new Error("HA request failed");
          
          result = { power: await devicePower(c, machine) };
        } else {
          const sent = await sendHinataCoin(
            await decryptSecret(
              machine.hinata_url_encrypted!,
              c.env.URL_ENCRYPTION_KEY!,
            ),
            machine.coin_key,
            machine.hinata_password_encrypted
              ? await decryptSecret(
                  machine.hinata_password_encrypted,
                  c.env.URL_ENCRYPTION_KEY!,
                )
              : null,
            body.operationId,
          );
          if (!sent.ok) throw new Error("IO request failed");
        }
      } catch {
        return c.json(
          {
            error: {
              code: "DEVICE_UNAVAILABLE",
              message: isDoor
                ? "获取开门密码失败，请联系店员"
                : "设备连接失败，请联系店员检查设备或配置",
              details: { operationId: body.operationId },
            },
          },
          502,
        );
      }
      await c.env.DB.batch([
        c.env.DB.prepare(
          "UPDATE device_commands SET status='acked',acked_at=? WHERE shop_id=? AND id=?",
        ).bind(new Date().toISOString(), shop.id, body.operationId),
        c.env.DB.prepare(
          "UPDATE sessions SET metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.deviceOperated',json('true')) WHERE shop_id=? AND player_id=? AND status='active'",
        ).bind(shop.id, player?.id ?? ""),
      ]);
      if (player) {
        const sync = refreshActivityBill(c.env, shop.id, player.id).catch(error => console.error("Device live bill sync failed", error));
        try { c.executionCtx.waitUntil(sync); } catch { void sync; }
      }
      return c.json({ operationId: body.operationId, ...result });
    },
  );
}
