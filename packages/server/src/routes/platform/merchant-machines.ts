import { Hono, type Context } from "hono";
import type { AppBindings, AuthUser } from "../../bindings.js";
import { decryptSecret, encryptSecret, randomToken } from "../../crypto.js";
import { normalizeHinataUrl } from "../../hardware/hinata.js";
import { z } from "zod";
import { jsonError } from "../../http.js";
import { requireUser } from "../../middleware/auth.js";
import { getOrCreateShopDependencies } from "../../middleware/tenant.js";
import { findLegacyShopByCode } from "../../legacy/tenant-resolver.js";

/** Restore pre-fork merchant machine discovery and audit-history contracts. */
export const merchantMachineRouter = new Hono<AppBindings>();
type C = Context<AppBindings>;
type MachineRecord = {
  id: string;
  shop_id: string;
  shop_public_id: string;
  public_id: string;
  name: string;
  enabled: number;
  kind: string;
  aliases_json: string | null;
  hinata_url_encrypted: string | null;
  hinata_password_encrypted: string | null;
  ha_binding_encrypted: string | null;
  ttlock_lock_id: number | null;
  mahjong_config_json: string | null;
  coin_key: number;
  coin_after_swipe: number;
};

function parseObject(value: string | null): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

async function assertMachineShop(c: C, user: AuthUser, shopId: string) {
  if (user.role === "admin") return;
  const member = await c.env.DB.prepare(
    "SELECT 1 FROM shop_members WHERE shop_id=? AND user_id=?",
  ).bind(shopId, user.id).first();
  if (!member) jsonError(403, "你没有这个店铺的管理权限", "FORBIDDEN");
}

async function canConfigureMachine(c: C, user: AuthUser, shopId: string) {
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

async function decode(c: C, value: string) {
  if (!c.env.URL_ENCRYPTION_KEY) jsonError(503, "设备密钥未配置", "DEVICE_ENCRYPTION_UNAVAILABLE");
  return decryptSecret(value, c.env.URL_ENCRYPTION_KEY);
}

async function presentMachine(c: C, row: MachineRecord, canConfigure: boolean) {
  const aliases = parseObject(row.aliases_json);
  const ha = row.ha_binding_encrypted
    ? JSON.parse(await decode(c, row.ha_binding_encrypted)) as { url: string; entityId: string; token: string }
    : null;
  return {
    id: row.id,
    publicId: row.public_id,
    shopId: row.shop_id,
    shopPublicId: row.shop_public_id,
    name: row.name,
    aliases: Array.isArray(aliases) ? aliases.filter((a): a is string => typeof a === "string") : [],
    enabled: !!row.enabled,
    kind: row.kind,
    hasHinata: !!row.hinata_url_encrypted,
    hinataUrl: canConfigure && row.hinata_url_encrypted ? await decode(c, row.hinata_url_encrypted) : null,
    hasPassword: !!row.hinata_password_encrypted,
    homeAssistant: ha ? { url: canConfigure ? ha.url : "", entityId: ha.entityId } : null,
    ttlockLockId: row.ttlock_lock_id,
    mahjong: parseObject(row.mahjong_config_json),
    coinKey: row.coin_key,
    coinEnabled: row.coin_key > 0,
    coinAfterSwipe: !!row.coin_after_swipe,
  };
}

merchantMachineRouter.get("/machines", async (c) => {
  const user = requireUser(c);
  const shopId = c.req.query("shopId");
  if (!shopId) jsonError(400, "请选择店铺", "SHOP_REQUIRED");
  await assertMachineShop(c, user, shopId);
  const canConfigure = await canConfigureMachine(c, user, shopId);
  const machines = await c.env.DB.prepare(
    `SELECT machines.*, shops.public_id AS shop_public_id
     FROM machines JOIN shops ON shops.id=machines.shop_id
     WHERE machines.shop_id=? ORDER BY (machines.ttlock_lock_id IS NOT NULL) DESC,machines.created_at`,
  ).bind(shopId).all<MachineRecord>();
  return c.json({ machines: await Promise.all(machines.results.map(m => presentMachine(c,m,canConfigure))) });
});

merchantMachineRouter.get("/machines/:id/events", async (c) => {
  const user = requireUser(c);
  const machine = await c.env.DB.prepare("SELECT shop_id FROM machines WHERE id=?")
    .bind(c.req.param("id")).first<{ shop_id: string }>();
  if (!machine) jsonError(404, "没有找到这台设备", "DEVICE_NOT_FOUND");
  await assertMachineShop(c,user,machine.shop_id);
  const rows = await c.env.DB.prepare(
    "SELECT id,type,status,requested_at AS requestedAt FROM device_commands WHERE shop_id=? AND device_id=? ORDER BY requested_at DESC LIMIT 30",
  ).bind(machine.shop_id,c.req.param("id")).all();
  return c.json({ events: rows.results });
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

/** Historical binding picker, restricted to staff able to configure machines. */
merchantMachineRouter.get("/device-bindings", async (c) => {
  const user = requireUser(c);
  const shopId = c.req.query("shopId");
  if (!shopId) jsonError(400, "请选择店铺", "SHOP_REQUIRED");
  await assertMachineShop(c, user, shopId);
  if (!(await canConfigureMachine(c, user, shopId))) {
    jsonError(403, "只读账号不能配置设备", "FORBIDDEN");
  }
  const shop = await findLegacyShopByCode(c.env.DB, shopId);
  if (!shop) jsonError(404, "没有找到这个店铺", "SHOP_NOT_FOUND");
  const settings = await getOrCreateShopDependencies(c.env.DB, shop, c.env.URL_ENCRYPTION_KEY).staffSettingsCommands.getSettings();
  const bindings = [
    ...settings.homeAssistantDevices.map(device => ({ id: device.id, name: device.name, kind: "home_assistant" })),
    ...settings.hinataIoDevices.map(device => ({ id: device.id, name: device.name, kind: "hinata_io" })),
    ...(settings.ttLockDevices ?? []).map(device => ({ id: device.id, name: device.name, kind: "ttlock" })),
  ];
  return c.json({ bindings });
});

const urlInput = z.string().trim().url().refine(
  value => ["http:","https:"].includes(new URL(value).protocol),
  "连接地址必须为 HTTP 或 HTTPS",
);
const homeAssistantInput = z.object({
  url:urlInput,
  entityId:z.string().regex(/^(switch|input_boolean)\.[a-z0-9_]+$/),
  token:z.string().trim().max(4096).optional(),
}).nullable();
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
  ttlockLockId:z.number().int().positive().nullable().optional(),
  coinKey:z.number().int().min(0).max(65535).default(32),
  coinAfterSwipe:z.boolean().default(false),
  mahjong:z.object({
    capacity:z.number().int().min(2).max(8),
    pricingConfigIds:z.array(z.string().min(1)).max(20),
  }).nullable().optional(),
  legacyBindings:z.array(z.object({
    kind:z.enum(["home_assistant","hinata_io","ttlock"]),id:z.string().min(1),
  })).max(3).optional(),
});
const patchInput=machineInput.partial();

type MachineEditable = MachineRecord & {
  shop_public_id:string; coin_after_swipe:number;
  mahjong_config_json:string|null;
};

async function changeMachine(c:C, machineId?:string) {
  const user=requireUser(c);
  const raw=await c.req.json();
  const body=machineId?patchInput.parse(raw):machineInput.parse(raw);
  const current=machineId
    ?await c.env.DB.prepare(
      "SELECT machines.*, shops.public_id AS shop_public_id FROM machines JOIN shops ON shops.id=machines.shop_id WHERE machines.id=?",
    ).bind(machineId).first<MachineEditable>():null;
  if(machineId&&!current)jsonError(404,"没有找到这台设备","DEVICE_NOT_FOUND");
  const shopId=current?.shop_id??body.shopId;
  if(!shopId)jsonError(400,"请选择店铺","SHOP_REQUIRED");
  await assertMachineShop(c,user,shopId);
  if(!await canConfigureMachine(c,user,shopId))
    jsonError(403,"只读账号不能配置设备","FORBIDDEN");
  if(body.shopId&&body.shopId!==shopId)
    jsonError(400,"设备不能移动到其他店铺","DEVICE_SHOP_IMMUTABLE");
  const shop=await findLegacyShopByCode(c.env.DB,shopId);
  if(!shop)jsonError(404,"没有找到这个店铺","SHOP_NOT_FOUND");

  // The old machine picker allows reusing migrated venue.settings connections.
  if(body.legacyBindings?.length){
    const settings=await getOrCreateShopDependencies(c.env.DB,shop).staffSettingsCommands.getSettings();
    for(const binding of body.legacyBindings){
      if(binding.kind==="home_assistant"){
        const device=settings.homeAssistantDevices.find(d=>d.id===binding.id);
        if(!device)jsonError(404,"没有找到原设备配置","LEGACY_DEVICE_NOT_FOUND");
        body.homeAssistant=homeAssistantInput.parse({
          ...settings.homeAssistantConnection,entityId:device.id,
        });
      }else if(binding.kind==="hinata_io"){
        const device=settings.hinataIoDevices.find(d=>d.id===binding.id);
        if(!device)jsonError(404,"没有找到原设备配置","LEGACY_DEVICE_NOT_FOUND");
        body.hinataUrl=normalizeHinataUrl(device.url);
        body.hinataPassword=device.password;
        body.coinKey??=device.coinKey;
      }else{
        const device=settings.ttLockDevices?.find(d=>d.id===binding.id);
        if(!device)jsonError(404,"没有找到原设备配置","LEGACY_DEVICE_NOT_FOUND");
        body.ttlockLockId=device.lockId;
      }
    }
  }
  const mahjong=body.mahjong===undefined?parseObject(current?.mahjong_config_json??null):body.mahjong;
  if(mahjong&&typeof mahjong==="object"&&"pricingConfigIds" in mahjong){
    const ids=(mahjong as {pricingConfigIds:string[]}).pricingConfigIds;
    if(ids.length){
      const active=await c.env.DB.prepare(
        "SELECT id FROM pricing_configs WHERE shop_id=? AND enabled=1 AND status='active'",
      ).bind(shopId).all<{id:string}>();
      const valid=new Set(active.results.map(row=>row.id));
      if(ids.some(id=>!valid.has(id)))jsonError(400,"请选择有效的麻将计费规则","MAHJONG_PRICING_INVALID");
    }
  }
  if(current&&body.mahjong!==undefined&&JSON.stringify(mahjong)!==JSON.stringify(parseObject(current.mahjong_config_json))){
    const seated=await c.env.DB.prepare(
      "SELECT 1 FROM mahjong_seats WHERE machine_id=? LIMIT 1",
    ).bind(current.id).first();
    if(seated)jsonError(409,"请先让玩家下桌再修改麻将配置","MAHJONG_IN_USE");
  }
  const needsEncryption=body.hinataUrl!==undefined&&body.hinataUrl!==null
    ||body.hinataPassword!==undefined&&body.hinataPassword!==null
    ||body.homeAssistant!==undefined&&body.homeAssistant!==null
    ||Boolean(current?.ha_binding_encrypted);
  if(needsEncryption&&!c.env.URL_ENCRYPTION_KEY)
    jsonError(503,"设备密钥尚未配置","DEVICE_ENCRYPTION_UNAVAILABLE");

  const url=body.hinataUrl===undefined?(current?.hinata_url_encrypted??"")
    :body.hinataUrl?await encryptSecret(body.hinataUrl,c.env.URL_ENCRYPTION_KEY!):"";
  const password=body.hinataPassword===undefined?current?.hinata_password_encrypted??null
    :body.hinataPassword?await encryptSecret(body.hinataPassword,c.env.URL_ENCRYPTION_KEY!):null;
  let ha=current?.ha_binding_encrypted
    ?JSON.parse(await decryptSecret(current.ha_binding_encrypted,c.env.URL_ENCRYPTION_KEY!)) as {
      url:string;entityId:string;token:string;
    }:null;
  if(body.homeAssistant===null)ha=null;
  else if(body.homeAssistant){
    const token=body.homeAssistant.token||ha?.token;
    if(!token)jsonError(400,"请填写 Home Assistant 令牌","HOME_ASSISTANT_TOKEN_REQUIRED");
    ha={...body.homeAssistant,token};
  }
  const encryptedHA=ha?await encryptSecret(JSON.stringify(ha),c.env.URL_ENCRYPTION_KEY!):null;
  const kind=body.kind??current?.kind??"machine";
  const aliases=[...new Set((body.aliases??(Array.isArray(parseObject(current?.aliases_json??null))?parseObject(current?.aliases_json??null) as string[]:[])).map(x=>x.trim()).filter(Boolean))];
  const coinKey=body.coinKey??current?.coin_key??32;
  const coinAfterSwipe=!!url&&coinKey>0&&(body.coinAfterSwipe??!!current?.coin_after_swipe);
  if(coinAfterSwipe&&!password)jsonError(400,"自动投币需要 HINATA IO 连接密码","DEVICE_CONFIGURATION_REQUIRED");
  const name=body.name??current?.name;
  if (!name) jsonError(400,"设备名称不能为空","INVALID_DEVICE_NAME");
  const values: Array<string|number|null>=[
    name, url,url?password:null,+(body.enabled??!!current?.enabled),
    kind,encryptedHA,body.ttlockLockId===undefined?current?.ttlock_lock_id??null:body.ttlockLockId,
    coinKey,+coinAfterSwipe,mahjong?JSON.stringify(mahjong):null,JSON.stringify(aliases),
  ];
  const id=current?.id??crypto.randomUUID(), publicId=current?.public_id??randomToken(12);
  if(current){
    await c.env.DB.prepare(
      `UPDATE machines SET name=?,hinata_url_encrypted=?,hinata_password_encrypted=?,enabled=?,kind=?,
      ha_binding_encrypted=?,ttlock_lock_id=?,coin_key=?,coin_after_swipe=?,mahjong_config_json=?,
      aliases_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND shop_id=?`,
    ).bind(...values,id,shopId).run();
  }else{
    await c.env.DB.prepare(
      `INSERT INTO machines(name,hinata_url_encrypted,hinata_password_encrypted,enabled,kind,
      ha_binding_encrypted,ttlock_lock_id,coin_key,coin_after_swipe,mahjong_config_json,aliases_json,
      id,public_id,shop_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(...values,id,publicId,shopId).run();
  }
  const updated=await c.env.DB.prepare(
    "SELECT machines.*,shops.public_id AS shop_public_id FROM machines JOIN shops ON shops.id=machines.shop_id WHERE machines.id=?",
  ).bind(id).first<MachineRecord>();
  if(!updated)jsonError(500,"设备保存失败","DEVICE_SAVE_FAILED");
  return c.json({machine:await presentMachine(c,updated,true)},current?200:201);
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
     UNION ALL SELECT 1 FROM device_commands WHERE shop_id=? AND device_id=? LIMIT 1`,
  ).bind(id,id,machine.shop_id,id).first();
  if(used)jsonError(409,"机台已有操作记录，请改为停用","MACHINE_HAS_HISTORY");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM machine_tickets WHERE machine_id=?").bind(id),
    c.env.DB.prepare("DELETE FROM machines WHERE id=? AND shop_id=?").bind(id,machine.shop_id),
  ]);
  return c.json({ok:true});
});
