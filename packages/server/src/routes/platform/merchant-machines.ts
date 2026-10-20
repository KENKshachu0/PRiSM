import { Hono, type Context } from "hono";
import { createD1Executor } from "@prism/adapter-d1";
import { createDeviceEventRepository } from "@prism/storage-sql";
import type { AppBindings, AuthUser } from "../../bindings.js";
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from "../../crypto.js";
import { normalizeHinataUrl } from "../../hardware/hinata.js";
import { machineRelayPath } from "../../gateway/relay-path.js";
import { machineRelayNamespace } from "../../gateway/machine-relay-gateway.js";
import { loadDevice, loadDevices, can, hinataConfigOf, doorConfigOf, mahjongConfigOf, readSecret, type Device } from "../../devices/device.js";
import { capabilityWrites, storedCapabilities, type StoredCapability } from "../../devices/configure.js";
import { capabilities, type CapabilityId, type HaEntityConfig, type HinataConfig } from "../../devices/capabilities.js";
import {
  getHaConnection,
  normalizeHaUrl,
  openHaConnection,
  resolveHaConnection,
  writeHaConnection,
  type StoredHaConnection,
} from "../../devices/ha-connections.js";
import { scheduleReadAccess } from "./merchant-ha.js";
import { z } from "zod";
import { jsonError } from "../../http.js";
import { requireUser } from "../../middleware/auth.js";

/** Restore pre-fork merchant machine discovery and audit-history contracts. */
export const merchantMachineRouter = new Hono<AppBindings>();
type C = Context<AppBindings>;

export async function assertMachineShop(c: C, user: AuthUser, shopId: string) {
  if (user.role === "admin") return;
  const member = await c.env.DB.prepare(
    "SELECT 1 FROM shop_members WHERE shop_id=? AND user_id=?",
  ).bind(shopId, user.id).first();
  if (!member) jsonError(403, "你没有这个店铺的管理权限", "FORBIDDEN");
}

export async function canConfigureMachine(c: C, user: AuthUser, shopId: string) {
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
  device: Device,
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
function availableActions(device: Device): { name: string; capability: string }[] {
  const actions: { name: string; capability: string }[] = [];
  for (const [id] of device.capabilities) {
    for (const action of Object.keys(capabilities[id].actions)) {
      if (can(device, action as Parameters<typeof can>[1]))
        actions.push({ name: action, capability: id });
    }
  }
  return actions;
}

async function presentMachine(c: C, device: Device, shopPublicId: string, canConfigure: boolean) {
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
  devices: readonly Device[],
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

async function presentWithStatus(c: C, devices: readonly Device[], shopPublicId: string, canConfigure: boolean) {
  const status = await relayStatus(c, devices);
  return Promise.all(devices.map(async (device) => {
    const presented = await presentMachine(c, device, shopPublicId, canConfigure);
    const live = status.get(device.id);
    return { ...presented, relayOnline: live ? live.online : null, relayE2ee: live ? live.e2ee : null };
  }));
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

merchantMachineRouter.get("/machines", async (c) => {
  const user = requireUser(c);
  const shopId = c.req.query("shopId");
  if (!shopId) jsonError(400, "请选择店铺", "SHOP_REQUIRED");
  await assertMachineShop(c, user, shopId);
  const canConfigure = await canConfigureMachine(c, user, shopId);
  const devices = await loadDevices(c.env.DB, shopId, c.env.URL_ENCRYPTION_KEY);
  // Doors first, as the board has always listed them.
  const ordered = [...devices.filter((d) => d.capabilities.has("door")), ...devices.filter((d) => !d.capabilities.has("door"))];
  return c.json({ machines: await presentWithStatus(c, ordered, await shopPublicId(c, shopId), canConfigure) });
});

merchantMachineRouter.get("/machines/:id/events", async (c) => {
  const user = requireUser(c);
  const machine = await c.env.DB.prepare("SELECT shop_id FROM machines WHERE id=?")
    .bind(c.req.param("id")).first<{ shop_id: string }>();
  if (!machine) jsonError(404, "没有找到这台设备", "DEVICE_NOT_FOUND");
  await assertMachineShop(c,user,machine.shop_id);
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

merchantMachineRouter.get("/login-events", async (c) => {
  const user = requireUser(c);
  const shopId = c.req.query("shopId");
  const machineId = c.req.query("machineId");
  if (shopId) await assertMachineShop(c,user,shopId);
  if (machineId) {
    const machine = await c.env.DB.prepare("SELECT shop_id FROM machines WHERE id=?")
      .bind(machineId).first<{ shop_id: string }>();
    if (!machine) jsonError(404, "没有找到这台设备", "DEVICE_NOT_FOUND");
    await assertMachineShop(c,user,machine.shop_id);
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
merchantMachineRouter.get("/device-bindings", async (c) => {
  const user = requireUser(c);
  const shopId = c.req.query("shopId");
  if (!shopId) jsonError(400, "请选择店铺", "SHOP_REQUIRED");
  await assertMachineShop(c, user, shopId);
  if (!(await canConfigureMachine(c, user, shopId))) {
    jsonError(403, "只读账号不能配置设备", "FORBIDDEN");
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
  mahjong:z.object({
    capacity:z.number().int().min(2).max(8),
    pricingConfigIds:z.array(z.string().min(1)).max(20),
  }).nullable().optional(),
});
const patchInput=machineInput.partial();
type MachineInput=z.infer<typeof patchInput>;

async function validateMahjong(c:C,shopId:string,current:Device|null,body:MachineInput){
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

async function changeMachine(c:C, machineId?:string) {
  const user=requireUser(c);
  const raw=await c.req.json();
  const body:MachineInput=machineId?patchInput.parse(raw):machineInput.parse(raw);
  const located=machineId
    ?await c.env.DB.prepare("SELECT shop_id FROM machines WHERE id=?").bind(machineId).first<{shop_id:string}>()
    :null;
  if(machineId&&!located)jsonError(404,"没有找到这台设备","DEVICE_NOT_FOUND");
  const shopId=located?.shop_id??body.shopId;
  if(!shopId)jsonError(400,"请选择店铺","SHOP_REQUIRED");
  await assertMachineShop(c,user,shopId);
  if(!await canConfigureMachine(c,user,shopId))
    jsonError(403,"只读账号不能配置设备","FORBIDDEN");
  if(body.shopId&&body.shopId!==shopId)
    jsonError(400,"设备不能移动到其他店铺","DEVICE_SHOP_IMMUTABLE");
  const publicShopId=await shopPublicId(c,shopId);
  const current=machineId?await loadDevice(c.env.DB,shopId,machineId):null;

  await validateMahjong(c,shopId,current,body);
  const id=current?.id??crypto.randomUUID();
  const stored=current?await storedCapabilities(c.env.DB,shopId,id):new Map<CapabilityId,StoredCapability>();
  const {next,relayToken,connections}=await nextCapabilities(c,shopId,stored,body);

  const name=body.name??current?.name;
  if(!name)jsonError(400,"设备名称不能为空","INVALID_DEVICE_NAME");
  const aliases=[...new Set((body.aliases??current?.aliases??[]).map(x=>x.trim()).filter(Boolean))];
  const enabled=+(body.enabled??current?.enabled??true);
  const kind=body.kind??current?.kind??"machine";
  const identity=current
    ?c.env.DB.prepare(
      `UPDATE machines SET name=?,enabled=?,kind=?,aliases_json=?,updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND shop_id=?`,
    ).bind(name,enabled,kind,JSON.stringify(aliases),id,shopId)
    // The pre-capability columns are kept only for rollback and stay empty.
    :c.env.DB.prepare(
      `INSERT INTO machines(id,public_id,shop_id,name,enabled,kind,aliases_json,hinata_url_encrypted)
       VALUES (?,?,?,?,?,?,?,'')`,
    ).bind(id,randomToken(12),shopId,name,enabled,kind,JSON.stringify(aliases));
  await c.env.DB.batch([
    identity,
    ...connections.map(connection=>writeHaConnection(c.env.DB,shopId,connection)),
    ...capabilityWrites(c.env.DB,{shopId,deviceId:id,next,now:new Date()}),
  ]);
  // A new Home Assistant gets its read-only account in the background; a failure
  // is recorded on the connection and shown on the board, never on this save.
  for(const connection of connections)scheduleReadAccess(c,shopId,connection.id);
  const updated=await loadDevice(c.env.DB,shopId,id);
  if(!updated)jsonError(500,"设备保存失败","DEVICE_SAVE_FAILED");
  const [machine]=await presentWithStatus(c,[updated],publicShopId,true);
  return c.json({
    machine,
    // Returned exactly once, here. Reloading the device list never re-exposes it.
    ...(relayToken?{relayToken}:{}),
  },current?200:201);
}

merchantMachineRouter.post("/machines",c=>changeMachine(c));
merchantMachineRouter.patch("/machines/:id",c=>changeMachine(c,c.req.param("id")));
merchantMachineRouter.delete("/machines/:id",async(c)=>{
  const user=requireUser(c),id=c.req.param("id");
  const machine=await c.env.DB.prepare(
    "SELECT id,shop_id FROM machines WHERE id=?",
  ).bind(id).first<{id:string;shop_id:string}>();
  if(!machine)jsonError(404,"没有找到这台设备","DEVICE_NOT_FOUND");
  await assertMachineShop(c,user,machine.shop_id);
  if(!await canConfigureMachine(c,user,machine.shop_id))
    jsonError(403,"只读账号不能配置设备","FORBIDDEN");
  const used=await c.env.DB.prepare(
    `SELECT 1 FROM machine_login_events WHERE machine_id=?
     UNION ALL SELECT 1 FROM player_operations WHERE device_id=?
     UNION ALL SELECT 1 FROM device_operations WHERE shop_id=? AND device_id=? LIMIT 1`,
  ).bind(id,id,machine.shop_id,id).first();
  if(used)jsonError(409,"机台已有操作记录，请改为停用","MACHINE_HAS_HISTORY");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM machine_tickets WHERE machine_id=?").bind(id),
    c.env.DB.prepare("DELETE FROM device_capabilities WHERE shop_id=? AND device_id=?").bind(machine.shop_id,id),
    c.env.DB.prepare("DELETE FROM device_events WHERE shop_id=? AND device_id=?").bind(machine.shop_id,id),
    c.env.DB.prepare("DELETE FROM device_state WHERE shop_id=? AND device_id=?").bind(machine.shop_id,id),
    c.env.DB.prepare("DELETE FROM machines WHERE id=? AND shop_id=?").bind(id,machine.shop_id),
  ]);
  return c.json({ok:true});
});
