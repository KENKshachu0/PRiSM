import { mahjongConfig, mahjongState, operateMahjong } from "./mahjong";
import type { Context, Hono } from "hono";
import type { DeviceCommandType } from "@prism/core";
import { z } from "zod";
import { TTLockClient } from "@prism/runtime";
import { normalizeTTLockConnectionConfig } from "@prism/application";
import { requireUser } from "./auth";
import { canAccessShop, getMachineByPublicId } from "./db";
import { decryptSecret, encryptSecret, randomToken, sha256 } from "./crypto";
import {
  checkShopLocation,
  dependencies,
  getBillingShop,
  requireActiveEntry,
  requireShopPlayer,
} from "./billing";
import { resolveMachineSession } from "./machine-session";
import { clientIp, jsonError } from "./http";
import { assertNotBanned, enforceRateLimits } from "./risk";
import { runPlayerOperation } from "./operations";
import { sendHinataCoin } from "./hinata";
import { createMachineSchema, patchMachineSchema } from "./validators";
import type { AppBindings, MachineRow } from "./types";

type C = Context<AppBindings>;
type HA = { url: string; token: string; entityId: string };
function machineAliases(machine: MachineRow): string[] {
  try {
    const aliases = JSON.parse(machine.aliases_json || "[]");
    return Array.isArray(aliases) ? aliases.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim()) : [];
  } catch {
    return [];
  }
}
export async function requireDeviceStaff(c: C, shopId: string, write = false) {
  const user = requireUser(c);
  if (!(await canAccessShop(c, user, shopId)))
    jsonError(403, "没有店铺管理权限");
  if (write) {
    const role = await c.env.DB.prepare(
      "SELECT s.role FROM shop_staff_accounts a JOIN staff_users s ON s.shop_id=a.shop_id AND s.id=a.staff_id WHERE a.shop_id=? AND a.user_id=? AND s.status='active'",
    )
      .bind(shopId, user.id)
      .first<{ role: string }>();
    if (role?.role === "viewer" && user.role !== "admin")
      jsonError(403, "只读账号不能执行此操作");
  }
}
async function haBinding(c: C, machine: MachineRow): Promise<HA | null> {
  return machine.ha_binding_encrypted
    ? JSON.parse(
        await decryptSecret(
          machine.ha_binding_encrypted,
          c.env.URL_ENCRYPTION_KEY,
        ),
      )
    : null;
}
export async function devicePower(
  c: C,
  machine: MachineRow,
): Promise<"on" | "off" | "unknown" | "unmanaged"> {
  try {
    const ha = await haBinding(c, machine);
    if (!ha) return "unmanaged";
    const response = await fetch(
      `${ha.url.replace(/\/+$/, "")}/api/states/${encodeURIComponent(ha.entityId)}`,
      {
        headers: { authorization: `Bearer ${ha.token}` },
        signal: AbortSignal.timeout(3000),
      },
    );
    if (!response.ok) return "unknown";
    const body = (await response.json()) as { state?: string };
    return body.state === "on" || body.state === "off" ? body.state : "unknown";
  } catch {
    return "unknown";
  }
}

export async function resolveLogicalDevice(
  c: C,
  shopId: string,
  ref: string,
  actionType?: DeviceCommandType,
) {
  const normalized = ref.trim().toLowerCase();
  if (!normalized) return null;
  const machine = await c.env.DB.prepare(
    `SELECT machines.* FROM machines
     WHERE machines.shop_id=? AND (lower(machines.id)=? OR lower(machines.public_id)=? OR lower(machines.name)=?
       OR EXISTS (SELECT 1 FROM json_each(COALESCE(machines.aliases_json,'[]')) WHERE lower(trim(value))=?))
     ORDER BY machines.created_at LIMIT 1`,
  ).bind(shopId, normalized, normalized, normalized, normalized).first<MachineRow>();
  if (!machine) return null;
  if (actionType === "door.open") {
    if (machine.ttlock_lock_id == null) return null;
    return { target: { kind: "facility" as const, id: machine.id, executorKind: "ttlock" as const }, deviceLabel: machine.name };
  }
  if (actionType === "power.on" || actionType === "power.off" || actionType === "ac.set_temperature") {
    if (!machine.ha_binding_encrypted) return null;
    return { target: { kind: "facility" as const, id: machine.id, executorKind: "home_assistant" as const }, deviceLabel: machine.name };
  }
  if (!machine.hinata_url_encrypted) return null;
  return { target: { kind: "game_machine" as const, id: machine.id, executorKind: "hinata_io" as const }, deviceLabel: machine.name };
}

export async function listLogicalDevicePowerStates(c: C, shopId: string) {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM machines WHERE shop_id=? AND ha_binding_encrypted IS NOT NULL AND enabled=1 ORDER BY created_at",
  ).bind(shopId).all<MachineRow>();
  return Promise.all(rows.results.map(async (machine) => ({
    deviceId: machine.id,
    label: machine.name,
    aliases: machineAliases(machine),
    targetKind: "facility",
    executorKind: "home_assistant",
    state: await devicePower(c, machine),
  })));
}
export async function requirePoweredMachine(c: C, machine: MachineRow) {
  if (!machine.hinata_url_encrypted)
    jsonError(409, "设备不支持此操作", "DEVICE_ACTION_UNSUPPORTED");
  const power = await devicePower(c, machine);
  if (power === "off") jsonError(409, "请先开机", "DEVICE_POWER_OFF");
}
export async function merchantDevice(
  c: C,
  machine: MachineRow,
  canConfigure = true,
) {
  const ha = await haBinding(c, machine);
  return {
    id: machine.id,
    publicId: machine.public_id,
    shopId: machine.shop_id,
    shopPublicId: machine.shop_public_id,
    name: machine.name,
    aliases: machineAliases(machine),
    enabled: !!machine.enabled,
    kind: machine.kind,
    hasHinata: !!machine.hinata_url_encrypted,
    hinataUrl:
      canConfigure && machine.hinata_url_encrypted
        ? await decryptSecret(
            machine.hinata_url_encrypted,
            c.env.URL_ENCRYPTION_KEY,
          )
        : null,
    hasPassword: !!machine.hinata_password_encrypted,
    homeAssistant: ha
      ? { url: canConfigure ? ha.url : "", entityId: ha.entityId }
      : null,
    ttlockLockId: machine.ttlock_lock_id,
    mahjong: mahjongConfig(machine),
    coinKey: machine.coin_key,
    coinEnabled: machine.coin_key > 0,
    coinAfterSwipe: !!machine.coin_after_swipe,
  };
}
export async function listDevices(c: C) {
  const shopId = c.req.query("shopId");
  if (!shopId) jsonError(400, "请选择店铺");
  await requireDeviceStaff(c, shopId);
  const mapping = await c.env.DB.prepare(
    "SELECT s.role FROM shop_staff_accounts a JOIN staff_users s ON s.shop_id=a.shop_id AND s.id=a.staff_id WHERE a.shop_id=? AND a.user_id=? AND s.status='active'",
  )
    .bind(shopId, requireUser(c).id)
    .first<{ role: string }>();
  const canConfigure =
    requireUser(c).role === "admin" || mapping?.role !== "viewer";
  const rows = await c.env.DB.prepare(
    "SELECT public_id FROM machines WHERE shop_id=? ORDER BY (ttlock_lock_id IS NOT NULL) DESC,created_at",
  )
    .bind(shopId)
    .all<{ public_id: string }>();
  const machines = await Promise.all(
    rows.results.map(async (row) =>
      merchantDevice(
        c,
        (await getMachineByPublicId(c.env.DB, row.public_id))!,
        canConfigure,
      ),
    ),
  );
  return c.json({ machines });
}
export async function saveDevice(c: C, id?: string) {
  const raw = await c.req.json();
  const body = id
    ? patchMachineSchema.parse(raw)
    : createMachineSchema.parse(raw);
  const old = id
    ? await c.env.DB.prepare("SELECT public_id FROM machines WHERE id=?")
        .bind(id)
        .first<{ public_id: string }>()
    : null;
  if (id && !old) jsonError(404, "没有找到这台设备");
  const current = old
    ? (await getMachineByPublicId(c.env.DB, old.public_id))!
    : null;
  const shopId = current?.shop_id ?? body.shopId!;
  await requireDeviceStaff(c, shopId, true);
  if (raw.legacyBindings !== undefined) {
    const bindings = z
      .array(
        z.object({
          kind: z.enum(["home_assistant", "hinata_io", "ttlock"]),
          id: z.string().min(1),
        }),
      )
      .max(3)
      .parse(raw.legacyBindings);
    const shopCode = await c.env.DB.prepare(
      "SELECT public_id FROM shops WHERE id=?",
    )
      .bind(shopId)
      .first<string>("public_id");
    const settings = await dependencies(
      c,
      await getBillingShop(c, shopCode!),
    ).staffSettingsCommands!.getSettings();
    for (const binding of bindings) {
      if (binding.kind === "home_assistant") {
        const device = settings.homeAssistantDevices.find(
          (d) => d.id === binding.id,
        );
        if (!device) jsonError(404, "没有找到原设备配置");
        body.homeAssistant = createMachineSchema.shape.homeAssistant.parse({
          ...settings.homeAssistantConnection,
          entityId: device.id,
        });
      } else if (binding.kind === "hinata_io") {
        const device = settings.hinataIoDevices.find(
          (d) => d.id === binding.id,
        );
        if (!device) jsonError(404, "没有找到原设备配置");
        body.hinataUrl = createMachineSchema.shape.hinataUrl.parse(device.url);
        body.hinataPassword = device.password;
        body.coinKey ??= device.coinKey;
      } else {
        const device = settings.ttLockDevices?.find((d) => d.id === binding.id);
        if (!device) jsonError(404, "没有找到原设备配置");
        body.ttlockLockId = device.lockId;
      }
    }
  }
  if (body.shopId && body.shopId !== shopId)
    jsonError(400, "设备不能移动到其他店铺");
  const kind = body.kind ?? current?.kind ?? "machine";
  const aliases = [...new Set((body.aliases ?? (current ? machineAliases(current) : [])).map((v) => v.trim()).filter(Boolean))];
  const url =
    body.hinataUrl === undefined
      ? (current?.hinata_url_encrypted ?? "")
      : body.hinataUrl
        ? await encryptSecret(body.hinataUrl, c.env.URL_ENCRYPTION_KEY)
        : "";
  const password =
    body.hinataPassword === undefined
      ? (current?.hinata_password_encrypted ?? null)
      : body.hinataPassword
        ? await encryptSecret(body.hinataPassword, c.env.URL_ENCRYPTION_KEY)
        : null;
  let ha = current ? await haBinding(c, current) : null;
  if (body.homeAssistant === null) ha = null;
  else if (body.homeAssistant) {
    const token = body.homeAssistant.token || ha?.token;
    if (!token) jsonError(400, "请填写 Home Assistant 令牌");
    ha = { ...body.homeAssistant, token };
  }
  const lockId =
    body.ttlockLockId === undefined
      ? (current?.ttlock_lock_id ?? null)
      : body.ttlockLockId;
  const machineId = id ?? crypto.randomUUID();
  const publicId = current?.public_id ?? randomToken(12);
  const encryptedHA = ha
    ? await encryptSecret(JSON.stringify(ha), c.env.URL_ENCRYPTION_KEY)
    : null;
  const coinAfterSwipe =
    !!url && (body.coinKey ?? current?.coin_key ?? 32) > 0 && (body.coinAfterSwipe ?? !!current?.coin_after_swipe);
  if (coinAfterSwipe && !password)
    jsonError(
      400,
      "自动投币需要 HINATA IO 连接密码",
      "DEVICE_CONFIGURATION_REQUIRED",
    );
  const mahjong = body.mahjong === undefined ? (current ? mahjongConfig(current) : null) : body.mahjong;
  if (mahjong && mahjong.pricingConfigIds.length) {
    const configured = await c.env.DB.prepare("SELECT id FROM pricing_configs WHERE shop_id=? AND enabled=1 AND status='active'").bind(shopId).all<{id:string}>();
    if (mahjong.pricingConfigIds.some(id => !configured.results.some(r => r.id === id)))
      jsonError(400,"请选择有效的麻将计费规则");
  }
  if (current && body.mahjong !== undefined && JSON.stringify(mahjong) !== JSON.stringify(mahjongConfig(current))) {
    const seated = await c.env.DB.prepare("SELECT 1 FROM mahjong_seats WHERE machine_id=?").bind(current.id).first();
    if (seated) jsonError(409,"请先让玩家下桌再修改麻将配置");
  }
  const values = [
    body.name ?? current!.name,
    url,
    url ? password : null,
    +(body.enabled ?? !!current?.enabled),
    kind,
    encryptedHA,
    lockId,
    body.coinKey ?? current?.coin_key ?? 32,
    +coinAfterSwipe,
    mahjong ? JSON.stringify(mahjong) : null,
    JSON.stringify(aliases),
  ];
  if (id)
    await c.env.DB.prepare(
      "UPDATE machines SET name=?,hinata_url_encrypted=?,hinata_password_encrypted=?,enabled=?,kind=?,ha_binding_encrypted=?,ttlock_lock_id=?,coin_key=?,coin_after_swipe=?,mahjong_config_json=?,aliases_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
    )
      .bind(...values, id)
      .run();
  else
    await c.env.DB.prepare(
      "INSERT INTO machines(name,hinata_url_encrypted,hinata_password_encrypted,enabled,kind,ha_binding_encrypted,ttlock_lock_id,coin_key,coin_after_swipe,mahjong_config_json,aliases_json,id,public_id,shop_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(...values, machineId, publicId, shopId)
      .run();
  return c.json(
    {
      machine: await merchantDevice(
        c,
        (await getMachineByPublicId(c.env.DB, publicId))!,
      ),
    },
    id ? 200 : 201,
  );
}

export async function claimDeviceCoin(
  c: C,
  machine: MachineRow,
  operationId: string,
): Promise<boolean> {
  const configured = await c.env.DB.prepare(
    "SELECT json_extract(value_json,'$.coinCooldownMs') AS cooldown FROM app_settings WHERE shop_id=? AND key='venue.operations'",
  )
    .bind(machine.shop_id)
    .first<number>("cooldown");
  const cooldown =
    typeof configured === "number" &&
    Number.isInteger(configured) &&
    configured >= 0
      ? configured
      : 60000;
  const nowMs = Date.now();
  const claim = await c.env.DB.prepare(
    "INSERT INTO operation_locks(shop_id,scope,resource_id,lock_id,expires_at,acquired_at) VALUES (?,'device.coin',?,?,?,?) ON CONFLICT(shop_id,scope,resource_id) DO UPDATE SET lock_id=excluded.lock_id,expires_at=excluded.expires_at,acquired_at=excluded.acquired_at WHERE operation_locks.expires_at<=excluded.acquired_at RETURNING lock_id",
  )
    .bind(
      machine.shop_id,
      machine.id,
      operationId,
      new Date(nowMs + cooldown).toISOString(),
      new Date(nowMs).toISOString(),
    )
    .first();
  return !!claim;
}

const actionSchema = z.object({
  ticket: z.string().min(1),
  operationId: z.string().uuid(),
  action: z.enum(["power.on", "power.off", "coin", "door.open", "mahjong.join", "mahjong.leave"]),
  consent: z.boolean().optional(),
  location: z.unknown().optional(),
});
export function registerDeviceRoutes(app: Hono<AppBindings>) {
  app.get("/api/v1/merchant/device-bindings", async (c) => {
    const shopId = c.req.query("shopId");
    if (!shopId) jsonError(400, "请选择店铺");
    await requireDeviceStaff(c, shopId, true);
    const shopCode = await c.env.DB.prepare(
      "SELECT public_id FROM shops WHERE id=?",
    )
      .bind(shopId)
      .first<string>("public_id");
    const settings = await dependencies(
      c,
      await getBillingShop(c, shopCode!),
    ).staffSettingsCommands!.getSettings();
    return c.json({
      bindings: [
        ...settings.homeAssistantDevices.map((d) => ({
          id: d.id,
          name: d.name,
          kind: "home_assistant",
        })),
        ...settings.hinataIoDevices.map((d) => ({
          id: d.id,
          name: d.name,
          kind: "hinata_io",
          hasPassword: !!d.password,
        })),
        ...(settings.ttLockDevices ?? []).map((d) => ({
          id: d.id,
          name: d.name,
          kind: "ttlock",
        })),
      ],
    });
  });
  app.get("/api/v1/merchant/machines/:id/events", async (c) => {
    const machine = await c.env.DB.prepare(
      "SELECT shop_id FROM machines WHERE id=?",
    )
      .bind(c.req.param("id"))
      .first<{ shop_id: string }>();
    if (!machine) jsonError(404, "没有找到这台设备");
    await requireDeviceStaff(c, machine.shop_id);
    const events = await c.env.DB.prepare(
      "SELECT id,type,status,requested_at AS requestedAt FROM device_commands WHERE shop_id=? AND device_id=? ORDER BY requested_at DESC LIMIT 30",
    )
      .bind(machine.shop_id, c.req.param("id"))
      .all();
    return c.json({ events: events.results });
  });

  app.get("/api/v1/devices/session/state", async (c) => {
    requireUser(c);
    const { machine, coinUsed } = await resolveMachineSession(
      c,
      c.req.query("ticket") ?? "",
    );
    const shop = await getBillingShop(c, machine.shop_public_id);
    let gate: "ready" | "qq" | "entry" = "ready";
    if (
      (shop.billing_enabled &&
        (machine.hinata_url_encrypted || machine.ha_binding_encrypted || machine.mahjong_config_json)) ||
      !!machine.ttlock_lock_id || !!machine.mahjong_config_json
    ) {
      const user = requireUser(c);
      const player = await c.env.DB.prepare(
        "SELECT a.player_id,p.status FROM shop_player_accounts a JOIN players p ON p.shop_id=a.shop_id AND p.id=a.player_id WHERE a.shop_id=? AND a.user_id=?",
      )
        .bind(shop.id, user.id)
        .first<{ player_id: string; status: string }>();
      if (!player) gate = "qq";
      else if (player.status !== "active")
        jsonError(403, "店铺玩家资格已停用", "PLAYER_DISABLED");
      else if (shop.billing_enabled) {
        try {
          await requireActiveEntry(c, shop);
        } catch (error) {
          if (
            error instanceof Error &&
            "status" in error &&
            error.status === 403
          )
            gate = "entry";
          else throw error;
        }
      }
    }
    return c.json({
      gate,
      coinUsed,
      mahjong: gate === "ready" ? await mahjongState(c, machine) : null,
      power:
        gate === "ready" && !!machine.ha_binding_encrypted
          ? await devicePower(c, machine)
          : "unmanaged",
    });
  });
  app.post("/api/v1/devices/session/actions", async (c) => {
    const body = actionSchema.parse(await c.req.json());
    if (body.action === "power.off") jsonError(403, "关机需要店员权限");
    const { machine } = await resolveMachineSession(c, body.ticket);
    if (body.action.startsWith("mahjong.")) return operateMahjong(c, machine, body);
    return executeDeviceAction(c, machine, body);
  });
  app.get("/api/v1/merchant/machines/:id/state", async (c) => {
    const row = await c.env.DB.prepare(
      "SELECT public_id FROM machines WHERE id=?",
    )
      .bind(c.req.param("id"))
      .first<{ public_id: string }>();
    if (!row) jsonError(404, "没有找到这台设备");
    const machine = (await getMachineByPublicId(c.env.DB, row.public_id))!;
    await requireDeviceStaff(c, machine.shop_id);
    return c.json({ power: await devicePower(c, machine) });
  });
  app.post("/api/v1/merchant/machines/:id/actions", async (c) => {
    const row = await c.env.DB.prepare(
      "SELECT public_id FROM machines WHERE id=?",
    )
      .bind(c.req.param("id"))
      .first<{ public_id: string }>();
    if (!row) jsonError(404, "没有找到这台设备");
    const machine = (await getMachineByPublicId(c.env.DB, row.public_id))!;
    await requireDeviceStaff(c, machine.shop_id, true);
    if (!machine.enabled) jsonError(409, "设备已停用");
    const body = actionSchema.parse({
      ...(await c.req.json()),
      ticket: `staff:${machine.id}`,
    });
    return executeDeviceAction(c, machine, body, true);
  });
}

async function executeDeviceAction(
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
  const deps = dependencies(c, shop);
  const lockSetting = isDoor
    ? await c.env.DB.prepare(
        "SELECT value_json FROM app_settings WHERE shop_id=? AND key='devices.ttlock_connection'",
      )
        .bind(shop.id)
        .first<string>("value_json")
    : null;
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
      await enforceRateLimits(c, [
        {
          key: `device:${machine.id}:${user.id}:${Math.floor(Date.now() / 60000)}`,
          limit: 10,
          windowSeconds: 90,
        },
      ]);
      if (body.action === "coin") {
        if (!(await claimDeviceCoin(c, machine, body.operationId))) {
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
              machine.hinata_url_encrypted,
              c.env.URL_ENCRYPTION_KEY,
            ),
            machine.coin_key,
            machine.hinata_password_encrypted
              ? await decryptSecret(
                  machine.hinata_password_encrypted,
                  c.env.URL_ENCRYPTION_KEY,
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
      return c.json({ operationId: body.operationId, ...result });
    },
  );
}
