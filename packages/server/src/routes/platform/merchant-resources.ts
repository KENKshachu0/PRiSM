import { Hono, type Context } from "hono";
import { createD1Executor, type D1BoundStatementLike } from "@prism/adapter-d1";
import { createDeviceEventRepository } from "@prism/storage-sql";
import type { AppBindings, AuthUser } from "../../bindings.js";
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from "../../crypto.js";
import { normalizeHinataUrl } from "../../hardware/hinata.js";
import { machineRelayPath } from "../../gateway/relay-path.js";
import { machineRelayNamespace } from "../../gateway/machine-relay-gateway.js";
import { loadResource, loadResources, can, hinataConfigOf, doorConfigOf, mahjongConfigOf, readSecret, type Resource } from "../../resources/resource.js";
import { createOccupancy } from "../../resources/occupancy/service.js";
import { capabilityWrites, storedCapabilities, type StoredCapability } from "../../resources/capabilities/configure.js";
import { capabilities, type BotConfig, type CapabilityId, type HaEntityConfig, type HinataConfig } from "../../resources/capabilities/catalog.js";
import { idleSchedule, notifyBotsChangedAfter } from "../../durable-objects/shop-hub-client.js";
import {
  getHaConnection,
  normalizeHaUrl,
  openHaConnection,
  resolveHaConnection,
  writeHaConnection,
  type StoredHaConnection,
} from "../../resources/capabilities/ha-connections.js";
import { afterHaChange, scheduleReadAccess } from "./merchant-ha.js";
import { z } from "zod";
import { jsonError } from "../../http.js";
import { requireUser } from "../../middleware/auth.js";
import { DEFAULT_RESOURCE_GROUP_ID } from "../../resources/billing.js";
import { findResourceGroup } from "../../resources/repository.js";
import { assertBillablePlan } from "./merchant-resource-groups.js";

/** Restore pre-fork merchant machine discovery and audit-history contracts. */
export const merchantResourceRouter = new Hono<AppBindings>();
type C = Context<AppBindings>;

export async function assertResourceShop(c: C, user: AuthUser, shopId: string) {
  if (user.role === "admin") return;
  const member = await c.env.DB.prepare(
    "SELECT 1 FROM shop_members WHERE shop_id=? AND user_id=?",
  ).bind(shopId, user.id).first();
  if (!member) jsonError(403, "你没有这个店铺的管理权限", "FORBIDDEN");
}

export async function canConfigureResource(c: C, user: AuthUser, shopId: string) {
  if (user.role === "admin") return true;
  const row = await c.env.DB.prepare(
    "SELECT s.role FROM shop_staff_accounts a JOIN staff_users s ON s.shop_id=a.shop_id AND s.id=a.staff_id WHERE a.shop_id=? AND a.user_id=? AND s.status='active'",
  ).bind(shopId, user.id).first<{ role: string }>();
  if (row) return row.role === "owner" || row.role === "manager";
  const owner = await c.env.DB.prepare(
    "SELECT 1 FROM shop_members WHERE shop_id=? AND user_id=? AND role='owner'",
  ).bind(shopId, user.id).first();
  return Boolean(owner);
}

export function encryptionKey(c: C): string {
  if (!c.env.URL_ENCRYPTION_KEY) jsonError(503, "设备密钥尚未配置", "DEVICE_ENCRYPTION_UNAVAILABLE");
  return c.env.URL_ENCRYPTION_KEY;
}

type HaBinding = { url: string; entityId: string; token: string };

/** Where a power or air-conditioner capability points, without its token. */
async function describeHa(
  c: C,
  device: Resource,
  capability: "power" | "climate",
): Promise<{ connectionId: string | null; url: string; entityId: string } | null> {
  const bound = device.capabilities.get(capability);
  if (!bound) return null;
  const config = bound.config as HaEntityConfig;
  if (config.connectionId && config.entityId) {
    const connection = await getHaConnection(c.env.DB, device.shopId, config.connectionId);
    return { connectionId: config.connectionId, url: connection?.url ?? "", entityId: config.entityId };
  }
  const raw = await readSecret(c.env.DB, device, capability, "binding", encryptionKey(c));
  if (!raw) return null;
  try {
    const binding = JSON.parse(raw) as HaBinding;
    return { connectionId: null, url: binding.url, entityId: binding.entityId };
  } catch {
    return null;
  }
}

/**
 * Every action this device can perform right now, tagged with the capability
 * that owns it. The store UI groups the action panel by capability, so a
 * capability added to the catalog appears there without a frontend change.
 */
function availableActions(device: Resource): { name: string; capability: string }[] {
  const actions: { name: string; capability: string }[] = [];
  for (const [id] of device.capabilities) {
    for (const action of Object.keys(capabilities[id].actions)) {
      if (can(device, action as Parameters<typeof can>[1]))
        actions.push({ name: action, capability: id });
    }
  }
  return actions;
}

async function presentResource(c: C, device: Resource, shopPublicId: string, canConfigure: boolean) {
  const hinata = hinataConfigOf(device);
  const io = device.capabilities.get("hinata_io");
  const ha = await describeHa(c, device, "power");
  const climate = await describeHa(c, device, "climate");
  const embedded = hinata?.transport === "embedded";
  const coinKey = hinata?.coinKey ?? 32;
  return {
    id: device.id,
    publicId: device.publicId,
    shopId: device.shopId,
    shopPublicId,
    name: device.name,
    aliases: device.aliases,
    enabled: device.enabled,
    kind: device.kind,
    /** Actions the store may send now; the UI is driven by this list. */
    actions: availableActions(device),
    hasHinata: !!io?.secretNames.has("url"),
    hinataUrl: canConfigure && io?.secretNames.has("url")
      ? await readSecret(c.env.DB, device, "hinata_io", "url", encryptionKey(c))
      : null,
    hasPassword: !!io?.secretNames.has("password"),
    homeAssistant: ha ? { connectionId: ha.connectionId, url: canConfigure ? ha.url : "", entityId: ha.entityId } : null,
    climate: climate ? { connectionId: climate.connectionId, url: canConfigure ? climate.url : "", entityId: climate.entityId } : null,
    ttlockLockId: doorConfigOf(device)?.lockId ?? null,
    mahjong: mahjongConfigOf(device),
    // The token itself is only returned when it is issued.
    bot: (() => {
      const config = device.capabilities.get("bot")?.config as BotConfig | undefined;
      if (!config) return null;
      const { tokenId: _token, ...settings } = config;
      return settings;
    })(),
    // Whether the bot has a live credential, told like a device's relay token.
    hasBotToken: !!device.capabilities.get("bot")?.config.tokenId,
    coinKey,
    coinEnabled: coinKey > 0,
    coinAfterSwipe: !!hinata?.coinAfterSwipe,
    relayConnection: embedded ? "embedded" : "external",
    // The token itself is only ever returned once, at mint time. What the board
    // needs afterwards is whether one exists and where the device should point.
    hasRelayToken: embedded && !!io?.credentialHash,
    relayUrl: embedded ? relayDeviceUrl(c) : null,
    relayOnline: null as boolean | null,
    relayE2ee: null as boolean | null,
  };
}

/**
 * Whether each embedded machine currently has its IO connected.
 *
 * Asked of the relay Durable Object rather than read from stored state: a
 * deploy drops sockets without a close callback, so the stored link state can
 * say online for a device that is gone. Every lookup is independent and
 * failures are swallowed, so one unreachable object does not blank the board
 * and an unknown state is reported as unknown rather than as offline.
 */
async function relayStatus(
  c: C,
  devices: readonly Resource[],
): Promise<Map<string, { online: boolean; e2ee: boolean }>> {
  const status = new Map<string, { online: boolean; e2ee: boolean }>();
  const relay = machineRelayNamespace(c.env);
  if (!relay) return status;
  await Promise.all(
    devices.map(async (device) => {
      const hinata = hinataConfigOf(device);
      if (hinata?.transport !== "embedded" || !hinata.channel) return;
      try {
        const capabilities = await relay.getByName(hinata.channel).getCapabilities();
        status.set(device.id, { online: capabilities.online, e2ee: capabilities.e2ee });
      } catch {
        // Leave it unreported; the board shows "unknown" instead of "offline".
      }
    }),
  );
  return status;
}

async function presentWithStatus(c: C, devices: readonly Resource[], shopPublicId: string, canConfigure: boolean) {
  const [status, bindings] = await Promise.all([relayStatus(c, devices), billingBindings(c, devices)]);
  return Promise.all(devices.map(async (device) => {
    const presented = await presentResource(c, device, shopPublicId, canConfigure);
    const live = status.get(device.id);
    const binding = bindings.get(device.id);
    return {
      ...presented,
      resourceGroupId: binding?.groupId ?? DEFAULT_RESOURCE_GROUP_ID,
      pricingConfigOverrideId: binding?.overrideId ?? null,
      // How many can use it at once (a mahjong table's size), and how long
      // someone counts as on it after the last sign of them.
      capacity: binding?.capacity ?? 0,
      occupancyMinutes: binding?.occupancyMinutes ?? 15,
      relayOnline: live ? live.online : null,
      relayE2ee: live ? live.e2ee : null,
    };
  }));
}

/** Which group each resource bills from, and its own plan when it has one. */
async function billingBindings(c: C, devices: readonly Resource[]) {
  const bindings = new Map<string, { groupId: string | null; overrideId: string | null; capacity: number; occupancyMinutes: number }>();
  const shopId = devices[0]?.shopId;
  if (!shopId) return bindings;
  const rows = await c.env.DB.prepare(
    `SELECT id, resource_group_id AS groupId, pricing_config_override_id AS overrideId,
       capacity, occupancy_minutes AS occupancyMinutes FROM machines
     WHERE shop_id = ? AND id IN (SELECT value FROM json_each(?))`,
  ).bind(shopId, JSON.stringify(devices.map((device) => device.id)))
    .all<{ id: string; groupId: string | null; overrideId: string | null; capacity: number; occupancyMinutes: number }>();
  for (const row of rows.results) bindings.set(row.id, row);
  return bindings;
}

async function shopPublicId(c: C, shopId: string): Promise<string> {
  const row = await c.env.DB.prepare("SELECT public_id FROM shops WHERE id=?").bind(shopId).first<{ public_id: string }>();
  if (!row) jsonError(404, "没有找到这个店铺", "SHOP_NOT_FOUND");
  return row.public_id;
}

/** The exact `[aimeio] serverUrl` value a store pastes into the machine's INI. */
export function relayDeviceUrl(c: C): string {
  const origin = c.env.APP_ORIGIN || new URL(c.req.url).origin;
  return `${origin.replace(/\/+$/, "")}${machineRelayPath}`;
}

merchantResourceRouter.get("/machines", async (c) => {
  const user = requireUser(c);
  const shopId = c.req.query("shopId");
  if (!shopId) jsonError(400, "请选择店铺", "SHOP_REQUIRED");
  await assertResourceShop(c, user, shopId);
  const canConfigure = await canConfigureResource(c, user, shopId);
  const devices = await loadResources(c.env.DB, shopId, c.env.URL_ENCRYPTION_KEY);
  // Doors first, as the board has always listed them.
  const ordered = [...devices.filter((d) => d.capabilities.has("door")), ...devices.filter((d) => !d.capabilities.has("door"))];
  return c.json({ machines: await presentWithStatus(c, ordered, await shopPublicId(c, shopId), canConfigure) });
});

merchantResourceRouter.get("/machines/:id/events", async (c) => {
  const user = requireUser(c);
  const machine = await c.env.DB.prepare("SELECT shop_id FROM machines WHERE id=?")
    .bind(c.req.param("id")).first<{ shop_id: string }>();
  if (!machine) jsonError(404, "没有找到这个资源", "DEVICE_NOT_FOUND");
  await assertResourceShop(c,user,machine.shop_id);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
  const events = await createDeviceEventRepository(createD1Executor(c.env.DB, machine.shop_id))
    .listEvents({ deviceId: c.req.param("id"), limit });
  return c.json({
    events: events.map((event) => ({
      id: event.id,
      capability: event.capability,
      kind: event.kind,
      name: event.name,
      origin: event.origin,
      operationId: event.operationId,
      parentOperationId: event.parentOperationId,
      at: event.occurredAt.toISOString(),
      payload: event.payload,
    })),
  });
});

/** Times in occupancy answers are shown in the shop's time zone, as the rest of the shop's data is. */
async function shopTimes(c: C, shopId: string) {
  const row = await c.env.DB.prepare(
    "SELECT COALESCE((SELECT json_extract(value_json, '$.timeZone') FROM app_settings WHERE shop_id = ? AND key = 'store.profile'), 'Asia/Shanghai') AS time_zone",
  ).bind(shopId).first<{ time_zone: string }>();
  if (row?.time_zone) c.set("responseTimeZone", row.time_zone);
}

/** Who is on each resource now: people, head count and capacity. */
merchantResourceRouter.get("/machines/occupancy", async (c) => {
  const user = requireUser(c);
  const shopId = c.req.query("shopId");
  if (!shopId) jsonError(400, "请选择店铺", "SHOP_REQUIRED");
  await assertResourceShop(c, user, shopId);
  await shopTimes(c, shopId);
  const [resources, offAt] = await Promise.all([
    createOccupancy({ db: c.env.DB, shopId }).current(),
    idleSchedule(c.env, shopId),
  ]);
  return c.json({
    // When the idle rules will switch a device off, for devices counting down.
    powerOffAt: Object.fromEntries(Object.entries(offAt).map(([id, at]) => [id, new Date(at).toISOString()])),
    resources: resources.map((resource) => ({
      resourceId: resource.resourceId,
      capacity: resource.capacity,
      source: resource.source,
      occupants: resource.occupants.map((occupant) => ({
        playerId: occupant.playerId,
        displayName: occupant.displayName,
        startedAt: occupant.since.toISOString(),
        lastSeenAt: occupant.lastSeenAt.toISOString(),
        expiresAt: occupant.expiresAt?.toISOString() ?? null,
      })),
    })),
  });
});

/** Who was on one resource and for how long, newest first. */
merchantResourceRouter.get("/machines/:id/occupancy", async (c) => {
  const user = requireUser(c);
  const machine = await c.env.DB.prepare("SELECT shop_id FROM machines WHERE id=?")
    .bind(c.req.param("id")).first<{ shop_id: string }>();
  if (!machine) jsonError(404, "没有找到这个资源", "DEVICE_NOT_FOUND");
  await assertResourceShop(c, user, machine.shop_id);
  await shopTimes(c, machine.shop_id);
  const before = c.req.query("before");
  const history = await createOccupancy({ db: c.env.DB, shopId: machine.shop_id }).history(c.req.param("id"), {
    limit: Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200),
    ...(before && Number.isFinite(Date.parse(before)) ? { before: new Date(before) } : {}),
  });
  return c.json({
    entries: history.map((entry) => ({
      id: entry.id,
      playerId: entry.playerId,
      displayName: entry.displayName,
      source: entry.source,
      startedAt: entry.startedAt.toISOString(),
      lastSeenAt: entry.lastSeenAt.toISOString(),
      endedAt: entry.endedAt?.toISOString() ?? null,
      endReason: entry.endReason,
    })),
  });
});

merchantResourceRouter.get("/login-events", async (c) => {
  const user = requireUser(c);
  const shopId = c.req.query("shopId");
  const machineId = c.req.query("machineId");
  if (shopId) await assertResourceShop(c,user,shopId);
  if (machineId) {
    const machine = await c.env.DB.prepare("SELECT shop_id FROM machines WHERE id=?")
      .bind(machineId).first<{ shop_id: string }>();
    if (!machine) jsonError(404, "没有找到这个资源", "DEVICE_NOT_FOUND");
    await assertResourceShop(c,user,machine.shop_id);
  }
  const requestedLimit = Number(c.req.query("limit") ?? 50);
  const limit = Number.isFinite(requestedLimit) ? Math.min(100,Math.max(1,Math.floor(requestedLimit))) : 50;
  const where: string[] = [];
  const bindings: Array<string | number> = [];
  if (user.role !== "admin") {
    where.push("EXISTS (SELECT 1 FROM shop_members sm WHERE sm.shop_id=shops.id AND sm.user_id=?)");
    bindings.push(user.id);
  }
  if (shopId) { where.push("shops.id=?"); bindings.push(shopId); }
  if (machineId) { where.push("machines.id=?"); bindings.push(machineId); }
  const sql = `SELECT e.id, e.created_at AS createdAt, e.result, e.risk_result AS riskResult,
    e.response_code AS responseCode, e.error_message AS errorMessage,
    e.distance_meters AS distanceMeters, machines.name AS machineName,
    shops.name AS shopName, i.display_name AS userName, cards.label AS cardLabel
    FROM machine_login_events e
    LEFT JOIN machines ON machines.id=e.machine_id
    LEFT JOIN shops ON shops.id=machines.shop_id
    LEFT JOIN users ON users.id=e.user_id
    LEFT JOIN auth_identities i ON i.id=(SELECT id FROM auth_identities WHERE user_id=users.id AND provider='munet' ORDER BY created_at LIMIT 1)
    LEFT JOIN cards ON cards.id=e.card_id
    ${where.length ? "WHERE "+where.join(" AND ") : ""}
    ORDER BY e.created_at DESC LIMIT ?`;
  const result = await c.env.DB.prepare(sql).bind(...bindings,limit).all();
  return c.json({ events: result.results });
});

/**
 * The old picker for registry entries kept in shop settings. Those entries are
 * now adopted as devices when the device list is first read, so there is never
 * anything left to pick; the route stays for clients that still call it.
 */
merchantResourceRouter.get("/device-bindings", async (c) => {
  const user = requireUser(c);
  const shopId = c.req.query("shopId");
  if (!shopId) jsonError(400, "请选择店铺", "SHOP_REQUIRED");
  await assertResourceShop(c, user, shopId);
  if (!(await canConfigureResource(c, user, shopId))) {
    jsonError(403, "只读账号不能配置资源", "FORBIDDEN");
  }
  return c.json({ bindings: [] });
});

const urlInput = z.string().trim().url().refine(
  value => ["http:","https:"].includes(new URL(value).protocol),
  "连接地址必须为 HTTP 或 HTTPS",
);
// A Home Assistant entity names its shop connection, or — as older clients do —
// the address (and token, when new) from which a connection is found or made.
const haEntityInput = (entity: z.ZodString) => z.object({
  connectionId:z.string().min(1).optional(),
  url:urlInput.optional(),
  entityId:entity,
  token:z.string().trim().max(4096).optional(),
}).refine(value => !!value.connectionId || !!value.url, "请选择 Home Assistant 连接").nullable();
const homeAssistantInput = haEntityInput(z.string().regex(/^(switch|input_boolean)\.[a-z0-9_]+$/));
const climateInput = haEntityInput(z.string().regex(/^climate\.[a-z0-9_]+$/,"空调实体需要是 climate.* 实体"));
const machineInput=z.object({
  shopId:z.string().min(1),
  name:z.string().trim().min(1).max(80),
  kind:z.enum(["machine","door"]).default("machine"),
  enabled:z.boolean().default(true),
  aliases:z.array(z.string().trim().min(1).max(80)).max(32).default([]),
  hinataUrl:z.string().trim().transform(normalizeHinataUrl).refine(
    value=>{try{return ["https:","http:"].includes(new URL(value).protocol);}catch{return false;}},
    "请填写正确的机台连接地址",
  ).nullable().optional(),
  hinataPassword:z.string().trim().max(128).nullable().optional(),
  homeAssistant:homeAssistantInput.optional(),
  climate:climateInput.optional(),
  ttlockLockId:z.number().int().positive().nullable().optional(),
  coinKey:z.number().int().min(0).max(65535).default(32),
  coinAfterSwipe:z.boolean().default(false),
  // Choosing `embedded` points the device at this platform instead of an
  // external relay. Existing devices stay on `external`, so nothing changes
  // until a store opts in per machine.
  relayConnection:z.enum(["external","embedded"]).optional(),
  // Mints a fresh device token and shows it once. Only meaningful for embedded.
  rotateRelayToken:z.boolean().optional(),
  // A shop bot: its settings, or null to remove the bot (its token is revoked).
  // A bot is issued its token when it is created; `rotateBotToken` issues a new one.
  bot:z.object({
    playerCommands:z.enum(["all","readonly"]).optional(),
    readOnlyNotice:z.string().max(200).optional(),
    staffCommands:z.boolean().optional(),
    powerOffStaffOnly:z.boolean().optional(),
    doorResourceId:z.string().min(1).nullable().optional(),
    receiptsToStaff:z.boolean().optional(),
    doorPasswordOnEntry:z.boolean().optional(),
    announceChannelIds:z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    idleReminderMinutes:z.number().int().min(0).max(120).optional(),
    announceIdle:z.boolean().optional(),
    announcePower:z.boolean().optional(),
    announceStarts:z.boolean().optional(),
    announceCards:z.boolean().optional(),
    announceCoins:z.boolean().optional(),
  }).strict().nullable().optional(),
  rotateBotToken:z.boolean().optional(),
  // Billing: the group whose default plan the resource bills (null or
  // "default" for the shop's default group), and an optional plan of its own
  // that replaces the group's.
  resourceGroupId:z.string().min(1).nullable().optional(),
  pricingConfigOverrideId:z.string().min(1).nullable().optional(),
  // How many people can use it at once; 0 for one nobody occupies (an air
  // conditioner). A mahjong table's is its table size.
  capacity:z.number().int().min(0).max(16).optional(),
  // How long someone counts as on it after the last sign of them; also its idle time.
  occupancyMinutes:z.number().int().min(1).max(1440).optional(),
  mahjong:z.object({
    // A table bills one plan; what it stacks on is that plan's `requires`.
    pricingConfigIds:z.array(z.string().min(1)).max(1,"麻将桌只能选择一个计费方案"),
  }).nullable().optional(),
});
const patchInput=machineInput.partial();
type MachineInput=z.infer<typeof patchInput>;

async function validateMahjong(c:C,shopId:string,current:Resource|null,body:MachineInput){
  if(body.mahjong===undefined)return;
  const ids=body.mahjong?.pricingConfigIds??[];
  if(ids.length){
    const active=await c.env.DB.prepare(
      "SELECT id FROM pricing_configs WHERE shop_id=? AND enabled=1 AND status='active'",
    ).bind(shopId).all<{id:string}>();
    const valid=new Set(active.results.map(row=>row.id));
    if(ids.some(id=>!valid.has(id)))jsonError(400,"请选择有效的麻将计费规则","MAHJONG_PRICING_INVALID");
  }
  const before=current?mahjongConfigOf(current):null;
  if(current&&JSON.stringify(body.mahjong)!==JSON.stringify(before)){
    const seated=await c.env.DB.prepare(
      "SELECT 1 FROM mahjong_seats WHERE machine_id=? LIMIT 1",
    ).bind(current.id).first();
    if(seated)jsonError(409,"请先让玩家下桌再修改麻将配置","MAHJONG_IN_USE");
  }
}

/**
 * The capabilities the device should carry after this edit. A field left out
 * of the request keeps what is stored; `null` unbinds. Secrets that did not
 * change are carried over still encrypted.
 */
async function nextCapabilities(
  c:C,
  shopId:string,
  stored:ReadonlyMap<CapabilityId,StoredCapability>,
  body:MachineInput,
):Promise<{next:Map<CapabilityId,StoredCapability>;relayToken:string|null;connections:StoredHaConnection[]}>{
  const next=new Map(stored);
  const seal=(value:string)=>encryptSecret(value,encryptionKey(c));
  const connections:StoredHaConnection[]=[];

  /** The address and token a stored power or air-conditioner capability uses. */
  const previousHa=async(capability:StoredCapability|undefined):Promise<{url:string;token:string}|null>=>{
    if(!capability)return null;
    const connectionId=(capability.config as HaEntityConfig).connectionId;
    if(connectionId){
      const open=await openHaConnection(c.env.DB,shopId,connectionId,encryptionKey(c));
      return open?{url:open.url,token:open.token}:null;
    }
    if(!capability.secrets.binding)return null;
    try{return JSON.parse(await decryptSecret(capability.secrets.binding,encryptionKey(c))) as HaBinding;}
    catch{return null;}
  };
  /**
   * The connection for an entity. A token left empty falls back to the one the
   * capability already used, then to the other Home Assistant capability's
   * when the address is the same, then to any connection to that address.
   */
  const connectionFor=async(
    input:NonNullable<MachineInput["homeAssistant"]>,
    fallbacks:Array<StoredCapability|undefined>,
  ):Promise<string>=>{
    if(input.connectionId){
      if(!await getHaConnection(c.env.DB,shopId,input.connectionId))
        jsonError(400,"没有找到这个 Home Assistant 连接","HA_CONNECTION_NOT_FOUND");
      return input.connectionId;
    }
    const url=normalizeHaUrl(input.url!);
    let token=input.token||null;
    for(const fallback of fallbacks){
      if(token)break;
      const previous=await previousHa(fallback);
      if(previous&&normalizeHaUrl(previous.url)===url)token=previous.token;
    }
    const pending=connections.find(connection=>connection.url===url);
    if(!token&&pending)return pending.id;
    const resolved=await resolveHaConnection(c.env.DB,shopId,encryptionKey(c),{url,token});
    if(!resolved)jsonError(400,"请填写 Home Assistant 令牌","HOME_ASSISTANT_TOKEN_REQUIRED");
    if(resolved.created&&!connections.some(connection=>connection.id===resolved.connection.id))
      connections.push(resolved.connection);
    return resolved.connection.id;
  };

  if(body.homeAssistant===null)next.delete("power");
  else if(body.homeAssistant){
    const connectionId=await connectionFor(body.homeAssistant,[stored.get("power")]);
    next.set("power",{config:{connectionId,entityId:body.homeAssistant.entityId},secrets:{},credentialHash:null});
  }

  if(body.climate===null)next.delete("climate");
  else if(body.climate){
    // The same Home Assistant usually serves both.
    const connectionId=await connectionFor(body.climate,[stored.get("climate"),next.get("power"),stored.get("power")]);
    next.set("climate",{config:{connectionId,entityId:body.climate.entityId},secrets:{},credentialHash:null});
  }

  if(body.ttlockLockId===null)next.delete("door");
  else if(body.ttlockLockId!==undefined)
    next.set("door",{config:{lockId:body.ttlockLockId},secrets:{},credentialHash:null});

  if(body.mahjong===null)next.delete("mahjong");
  else if(body.mahjong)next.set("mahjong",{config:body.mahjong,secrets:{},credentialHash:null});

  const io=stored.get("hinata_io");
  const before=io?.config as Partial<HinataConfig>|undefined;
  const secrets={...io?.secrets};
  if(body.hinataUrl!==undefined){
    if(body.hinataUrl)secrets.url=await seal(body.hinataUrl);else delete secrets.url;
  }
  if(body.hinataPassword!==undefined){
    if(body.hinataPassword)secrets.password=await seal(body.hinataPassword);else delete secrets.password;
  }
  const transport=body.relayConnection??before?.transport??"external";
  const coinKey=body.coinKey??before?.coinKey??32;
  let relayToken:string|null=null;
  if(transport==="embedded"){
    // E2EE and the embedded relay are mutually exclusive: this platform sends
    // plaintext over an authenticated, TLS-protected socket, and a device with
    // remotePassword set rejects every plaintext command. A password kept from
    // the external relay is meaningless here and is dropped; asking for one is
    // an error.
    if(body.hinataPassword)jsonError(400,"直连模式需要清空机台的 remotePassword","DEVICE_RELAY_PASSWORD_CONFLICT");
    delete secrets.password;
    let credentialHash=before?.transport==="embedded"?io?.credentialHash??null:null;
    if(body.rotateRelayToken||!credentialHash){
      // Shown once in the response; only the hash is stored.
      relayToken=`prism_io_${randomToken(32)}`;
      credentialHash=await sha256Hex(relayToken);
    }
    // The channel is independent of the token so rotating the key does not
    // orphan a connected device.
    const channel=before?.channel??`m_${randomToken(16)}`;
    const coinAfterSwipe=coinKey>0&&(body.coinAfterSwipe??!!before?.coinAfterSwipe);
    next.set("hinata_io",{config:{transport,coinKey,coinAfterSwipe,channel},secrets,credentialHash});
  }else if(secrets.url){
    const coinAfterSwipe=coinKey>0&&(body.coinAfterSwipe??!!before?.coinAfterSwipe);
    if(coinAfterSwipe&&!secrets.password)
      jsonError(400,"自动投币需要 HINATA IO 连接密码","DEVICE_CONFIGURATION_REQUIRED");
    next.set("hinata_io",{config:{transport,coinKey,coinAfterSwipe},secrets,credentialHash:null});
  }else{
    next.delete("hinata_io");
  }
  return {next,relayToken,connections};
}

/**
 * The bot capability after this edit, and the token writes it needs. A new
 * bot gets an integration token, returned once; removing the bot or rotating
 * its token revokes the old one, which also ends its connection.
 */
async function nextBot(
  c:C,shopId:string,stored:ReadonlyMap<CapabilityId,StoredCapability>,
  next:Map<CapabilityId,StoredCapability>,body:MachineInput,name:string,
){
  const before=stored.get("bot")?.config as BotConfig|undefined;
  const statements:D1BoundStatementLike[]=[];
  const now=new Date().toISOString();
  const revoke=(tokenId:string)=>statements.push(c.env.DB.prepare(
    "UPDATE api_tokens SET status='revoked',revoked_at=? WHERE shop_id=? AND id=? AND status='active'",
  ).bind(now,shopId,tokenId));
  if(body.bot===null){
    next.delete("bot");
    if(before)revoke(before.tokenId);
    return {statements,token:null as string|null};
  }
  if(body.bot===undefined&&!body.rotateBotToken)return {statements,token:null as string|null};
  if(!before&&body.bot===undefined)return {statements,token:null as string|null};
  if(body.bot?.doorResourceId){
    const door=await c.env.DB.prepare(
      "SELECT 1 FROM device_capabilities WHERE shop_id=? AND device_id=? AND capability='door'",
    ).bind(shopId,body.bot.doorResourceId).first();
    if(!door)jsonError(400,"请选择有门锁能力的资源","BOT_DOOR_INVALID");
  }
  let tokenId=before?.tokenId;
  let token:string|null=null;
  if(!tokenId||body.rotateBotToken){
    token=`prism_integration_${randomToken(32)}`;
    if(tokenId)revoke(tokenId);
    tokenId=crypto.randomUUID();
    statements.push(c.env.DB.prepare(
      "INSERT INTO api_tokens(shop_id,id,label,role,token_prefix,token_hash,status,created_at) VALUES (?,?,?,'integration','prism_integration',?,'active',?)",
    ).bind(shopId,tokenId,name,await sha256Hex(token),now));
  }
  const config=capabilities.bot.config.parse({...before,...body.bot,tokenId});
  next.set("bot",{config,secrets:{},credentialHash:null});
  return {statements,token};
}

/** The billing binding after this edit; a field left out keeps what is stored. */
async function nextBinding(c:C,shopId:string,machineId:string|null,body:MachineInput){
  const stored=machineId
    ?await c.env.DB.prepare(
      "SELECT resource_group_id AS groupId,pricing_config_override_id AS overrideId,capacity,occupancy_minutes AS occupancyMinutes FROM machines WHERE id=? AND shop_id=?",
    ).bind(machineId,shopId).first<{groupId:string|null;overrideId:string|null;capacity:number;occupancyMinutes:number}>()
    :null;
  const requested=body.resourceGroupId===DEFAULT_RESOURCE_GROUP_ID?null:body.resourceGroupId;
  const groupId=requested===undefined?stored?.groupId??null:requested;
  const overrideId=body.pricingConfigOverrideId===undefined?stored?.overrideId??null:body.pricingConfigOverrideId;
  if(requested&&!await findResourceGroup(c.env.DB,shopId,requested))
    jsonError(400,"请选择有效的资源组","RESOURCE_GROUP_NOT_FOUND");
  if(body.pricingConfigOverrideId)await assertBillablePlan(c,shopId,body.pricingConfigOverrideId);
  return {
    groupId,overrideId,
    capacity:body.capacity??stored?.capacity??null,
    occupancyMinutes:body.occupancyMinutes??stored?.occupancyMinutes??15,
  };
}

async function changeResource(c:C, machineId?:string) {
  const user=requireUser(c);
  const raw=await c.req.json();
  const body:MachineInput=machineId?patchInput.parse(raw):machineInput.parse(raw);
  const located=machineId
    ?await c.env.DB.prepare("SELECT shop_id FROM machines WHERE id=?").bind(machineId).first<{shop_id:string}>()
    :null;
  if(machineId&&!located)jsonError(404,"没有找到这个资源","DEVICE_NOT_FOUND");
  const shopId=located?.shop_id??body.shopId;
  if(!shopId)jsonError(400,"请选择店铺","SHOP_REQUIRED");
  await assertResourceShop(c,user,shopId);
  if(!await canConfigureResource(c,user,shopId))
    jsonError(403,"只读账号不能配置资源","FORBIDDEN");
  if(body.shopId&&body.shopId!==shopId)
    jsonError(400,"资源不能移动到其他店铺","DEVICE_SHOP_IMMUTABLE");
  const publicShopId=await shopPublicId(c,shopId);
  const current=machineId?await loadResource(c.env.DB,shopId,machineId):null;

  await validateMahjong(c,shopId,current,body);
  const binding=await nextBinding(c,shopId,machineId??null,body);
  const id=current?.id??crypto.randomUUID();
  const stored=current?await storedCapabilities(c.env.DB,shopId,id):new Map<CapabilityId,StoredCapability>();
  const {next,relayToken,connections}=await nextCapabilities(c,shopId,stored,body);
  const bot=await nextBot(c,shopId,stored,next,body,body.name??current?.name??"Bot");

  const name=body.name??current?.name;
  if(!name)jsonError(400,"资源名称不能为空","INVALID_DEVICE_NAME");
  // A new resource holds one person when a cabinet's IO can tell who is on it,
  // four at a mahjong table, otherwise nobody.
  const capacity=binding.capacity??(next.has("mahjong")?4:next.has("hinata_io")?1:0);
  if(next.has("mahjong")&&(capacity<2||capacity>8))jsonError(400,"麻将桌容量须为 2 到 8 人","MAHJONG_CAPACITY_INVALID");
  // Seats are counted against the capacity, so it cannot change under seated players.
  if(current&&next.has("mahjong")&&capacity!==current.capacity&&await c.env.DB.prepare(
    "SELECT 1 FROM mahjong_seats WHERE machine_id=? LIMIT 1",
  ).bind(current.id).first())jsonError(409,"请先让玩家下桌再修改麻将配置","MAHJONG_IN_USE");
  const aliases=[...new Set((body.aliases??current?.aliases??[]).map(x=>x.trim()).filter(Boolean))];
  const enabled=+(body.enabled??current?.enabled??true);
  const kind=body.kind??current?.kind??"machine";
  const identity=current
    ?c.env.DB.prepare(
      `UPDATE machines SET name=?,enabled=?,kind=?,aliases_json=?,resource_group_id=?,pricing_config_override_id=?,
         capacity=?,occupancy_minutes=?,updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND shop_id=?`,
    ).bind(name,enabled,kind,JSON.stringify(aliases),binding.groupId,binding.overrideId,capacity,binding.occupancyMinutes,id,shopId)
    // The pre-capability columns are kept only for rollback and stay empty.
    :c.env.DB.prepare(
      `INSERT INTO machines(id,public_id,shop_id,name,enabled,kind,aliases_json,hinata_url_encrypted,resource_group_id,pricing_config_override_id,capacity,occupancy_minutes)
       VALUES (?,?,?,?,?,?,?,'',?,?,?,?)`,
    ).bind(id,randomToken(12),shopId,name,enabled,kind,JSON.stringify(aliases),binding.groupId,binding.overrideId,capacity,binding.occupancyMinutes);
  await c.env.DB.batch([
    identity,
    ...connections.map(connection=>writeHaConnection(c.env.DB,shopId,connection)),
    ...capabilityWrites(c.env.DB,{shopId,deviceId:id,next,now:new Date()}),
    ...bot.statements,
  ]);
  // Bots are told the shop's tables and doors, and each its own settings.
  notifyBotsChangedAfter(c,shopId);
  // A new Home Assistant gets its read-only account in the background; a failure
  // is recorded on the connection and shown on the board, never on this save.
  for(const connection of connections)scheduleReadAccess(c,shopId,connection.id);
  afterHaChange(c,shopId);
  const updated=await loadResource(c.env.DB,shopId,id);
  if(!updated)jsonError(500,"资源保存失败","DEVICE_SAVE_FAILED");
  const [machine]=await presentWithStatus(c,[updated],publicShopId,true);
  return c.json({
    machine,
    // Returned exactly once, here. Reloading the device list never re-exposes it.
    ...(relayToken?{relayToken}:{}),
    ...(bot.token?{botToken:bot.token}:{}),
  },current?200:201);
}

merchantResourceRouter.post("/machines",c=>changeResource(c));
merchantResourceRouter.patch("/machines/:id",c=>changeResource(c,c.req.param("id")));
merchantResourceRouter.delete("/machines/:id",async(c)=>{
  const user=requireUser(c),id=c.req.param("id");
  const machine=await c.env.DB.prepare(
    "SELECT id,shop_id FROM machines WHERE id=?",
  ).bind(id).first<{id:string;shop_id:string}>();
  if(!machine)jsonError(404,"没有找到这个资源","DEVICE_NOT_FOUND");
  await assertResourceShop(c,user,machine.shop_id);
  if(!await canConfigureResource(c,user,machine.shop_id))
    jsonError(403,"只读账号不能配置资源","FORBIDDEN");
  const used=await c.env.DB.prepare(
    `SELECT 1 FROM machine_login_events WHERE machine_id=?
     UNION ALL SELECT 1 FROM player_operations WHERE device_id=?
     UNION ALL SELECT 1 FROM device_operations WHERE shop_id=? AND device_id=? LIMIT 1`,
  ).bind(id,id,machine.shop_id,id).first();
  if(used)jsonError(409,"机台已有操作记录，请改为停用","MACHINE_HAS_HISTORY");
  const botToken=await c.env.DB.prepare(
    "SELECT json_extract(config_json,'$.tokenId') AS tokenId FROM device_capabilities WHERE shop_id=? AND device_id=? AND capability='bot'",
  ).bind(machine.shop_id,id).first<{tokenId:string|null}>();
  await c.env.DB.batch([
    // A deleted bot can no longer connect.
    ...(botToken?.tokenId?[c.env.DB.prepare(
      "UPDATE api_tokens SET status='revoked',revoked_at=? WHERE shop_id=? AND id=? AND status='active'",
    ).bind(new Date().toISOString(),machine.shop_id,botToken.tokenId)]:[]),
    c.env.DB.prepare("DELETE FROM machine_tickets WHERE machine_id=?").bind(id),
    c.env.DB.prepare("DELETE FROM device_capabilities WHERE shop_id=? AND device_id=?").bind(machine.shop_id,id),
    c.env.DB.prepare("DELETE FROM device_events WHERE shop_id=? AND device_id=?").bind(machine.shop_id,id),
    c.env.DB.prepare("DELETE FROM device_state WHERE shop_id=? AND device_id=?").bind(machine.shop_id,id),
    c.env.DB.prepare("DELETE FROM machines WHERE id=? AND shop_id=?").bind(id,machine.shop_id),
  ]);
  return c.json({ok:true});
});
