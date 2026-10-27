import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../bindings.js";
import { decryptSecret, encryptSecret, sha256 } from "../../crypto.js";
import { jsonError } from "../../http.js";
import { resourceBilledSql } from "../../resources/billed-sql.js";
import { hinataConfigOf, loadResource, publicCapabilities } from "../../resources/resource.js";

export const resourceTicketRouter = new Hono<AppBindings>();
export const resourceQrRouter = new Hono<AppBindings>();
const ttlSeconds = 300;
type Navigation = { shopCode: string; publicId: string; expiresAt: number };
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const navigationKey = (secret: string) => `prism:machine-navigation:v1:${secret}`;

export type ScannedResource = {
  id: string;
  shop_id: string;
  public_id: string;
  shop_public_id: string;
  shop_name: string;
  shop_hero_url: string | null;
  name: string;
  kind: string;
  enabled: number;
  /** 1 when the resource resolves to a plan. */
  billed: number;
  machine_geo: number;
  latitude: number;
  longitude: number;
  radius_meters: number;
};

const machineSelect = `SELECT machines.*, shops.name AS shop_name,
  CASE WHEN shops.hero_data IS NULL OR shops.hero_data='' THEN NULL
    ELSE '/api/v1/shops/' || shops.public_id || '/hero?v=' || COALESCE(shops.hero_hash,'original') END AS shop_hero_url,
  shops.latitude, shops.longitude, shops.radius_meters, shops.public_id AS shop_public_id,
  (COALESCE(b.machine_geo,0) OR COALESCE(b.checkin_geo,0) OR COALESCE(b.checkout_geo,0)) AS machine_geo,
  ${resourceBilledSql("machines")} AS billed
  FROM machines JOIN shops ON shops.id=machines.shop_id
  LEFT JOIN shop_billing_settings b ON b.shop_id=shops.id`;

/** A resource of a shop by its id, in the shape the scan routes use. */
export async function loadScannedResource(c: Context<AppBindings>, shopId: string, id: string): Promise<ScannedResource | null> {
  return c.env.DB.prepare(`${machineSelect} WHERE machines.shop_id=? AND machines.id=?`)
    .bind(shopId, id).first<ScannedResource>();
}

async function findMachine(c: Context<AppBindings>, publicId: string): Promise<ScannedResource | null> {
  return c.env.DB.prepare(`${machineSelect} WHERE machines.public_id=?`)
    .bind(publicId).first<ScannedResource>();
}

export async function mintResourceTicket(secret: string | undefined, shopCode: string, publicId: string, now = Date.now()) {
  if (!validId(shopCode) || !validId(publicId)) jsonError(404, "机台不可用", "MACHINE_NOT_FOUND");
  if (!secret) jsonError(503, "会话密钥尚未配置", "SESSION_SECRET_NOT_CONFIGURED");
  const payload: Navigation = { shopCode, publicId, expiresAt: now + ttlSeconds * 1000 };
  return {
    ticket: `v1.${await encryptSecret(JSON.stringify(payload), navigationKey(secret))}`,
    expiresIn: ttlSeconds,
  };
}

export async function readResourceTicket(secret: string | undefined, ticket: string, now = Date.now()): Promise<Navigation> {
  let payload: Navigation;
  try {
    if (!secret || !ticket.startsWith("v1.") || ticket.length > 1024) throw Error("invalid ticket");
    payload = JSON.parse(await decryptSecret(ticket.slice(3), navigationKey(secret)));
    if (!payload || !validId(payload.shopCode) || !validId(payload.publicId) ||
        !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= now ||
        payload.expiresAt > now + ttlSeconds * 1000) throw Error("expired ticket");
  } catch {
    jsonError(410, "本次会话已失效", "TICKET_EXPIRED");
  }
  return payload;
}

export async function resolveResourceTicket(c: Context<AppBindings>, ticket: string, routePublicId?: string) {
  const normalized = ticket.trim(), route = routePublicId?.trim();
  if (!normalized || normalized.length > 1024) jsonError(410, "本次会话已失效", "TICKET_EXPIRED");
  let machine: ScannedResource | null = null;
  if (normalized.startsWith("v1.")) {
    const navigation = await readResourceTicket(c.env.SESSION_SECRET, normalized);
    if (route && route !== navigation.publicId) jsonError(410, "本次会话已失效", "TICKET_EXPIRED");
    machine = await findMachine(c, navigation.publicId);
    if (!machine || machine.shop_public_id !== navigation.shopCode) jsonError(404, "机台不可用", "MACHINE_NOT_FOUND");
  } else {
    machine = await c.env.DB.prepare(
      `${machineSelect} JOIN machine_tickets t ON t.machine_id=machines.id
      WHERE t.token_hash=? AND t.expires_at>?`,
    ).bind(await sha256(normalized), new Date().toISOString()).first<ScannedResource>();
    if (!machine || (route && route !== machine.public_id)) jsonError(410, "本次会话已失效", "TICKET_EXPIRED");
  }
  if (machine.enabled !== 1) jsonError(404, "机台不可用", "MACHINE_NOT_FOUND");
  // A bot is managed as a resource but is not something players scan.
  const bot = await c.env.DB.prepare("SELECT 1 FROM device_capabilities WHERE shop_id=? AND device_id=? AND capability='bot'")
    .bind(machine.shop_id, machine.id).first();
  if (bot) jsonError(404, "这里不能扫码使用", "MACHINE_NOT_FOUND");
  return machine;
}

export async function publicResource(c: Context<AppBindings>, m: ScannedResource) {
  const device = await loadResource(c.env.DB, m.shop_id, m.id);
  const capabilities = device
    ? publicCapabilities(device)
    : { power: false, climate: false, card: false, coin: false, door: false, mahjong: false };
  const io = device ? hinataConfigOf(device) : null;
  return {
    publicId: m.public_id, name: m.name, kind: m.kind, coinAfterSwipe: !!io?.coinAfterSwipe,
    capabilities,
    // Using it needs its plan running for the player; a free resource needs nothing.
    billed: !!m.billed,
    // Only a cabinet connected directly reports the cards on its reader.
    cardCapture: capabilities.card && io?.transport === "embedded" && !!io.channel,
    // Native apps render the full device flow only for a plain card cabinet.
    webOnly: !!io?.coinAfterSwipe || !!m.billed || !capabilities.card ||
      capabilities.door || capabilities.power || capabilities.climate,
    shop: {
      name: m.shop_name, publicId: m.shop_public_id,
      locationEnabled: !!m.machine_geo, machineGeo: !!m.machine_geo,
      // Released App Clips read this to tell a resource without hardware that
      // still needs confirming from an idle one; it answers for this resource.
      billingEnabled: !!m.billed, heroUrl: m.shop_hero_url,
      latitude: m.latitude, longitude: m.longitude, radiusMeters: m.radius_meters,
    },
  };
}

resourceTicketRouter.post("/session/start", async (c) => {
  const body = z.object({
    shopCode: z.string().trim().min(1).max(32),
    publicId: z.string().trim().min(1).max(80),
  }).parse(await c.req.json());
  const machine = await findMachine(c, body.publicId);
  if (!machine || machine.enabled !== 1 || machine.shop_public_id !== body.shopCode)
    jsonError(404, "机台不可用", "MACHINE_NOT_FOUND");
  const navigation = await mintResourceTicket(c.env.SESSION_SECRET, body.shopCode, body.publicId);
  return c.json({ ...navigation, machine: await publicResource(c, machine) });
});

resourceTicketRouter.get("/session", async (c) => {
  const machine = await resolveResourceTicket(c, c.req.query("ticket") ?? "");
  return c.json({ machine: await publicResource(c, machine) });
});
resourceTicketRouter.get("/:publicId", async (c) => {
  const machine = await resolveResourceTicket(c, c.req.query("ticket") || c.req.param("publicId"), c.req.param("publicId"));
  return c.json({ machine: await publicResource(c, machine) });
});

resourceQrRouter.get("/:shopCode/:publicId", async (c) => {
  const navigation = await mintResourceTicket(
    c.env.SESSION_SECRET, c.req.param("shopCode"), c.req.param("publicId"),
  );
  c.header("cache-control", "no-store");
  c.header("referrer-policy", "no-referrer");
  return c.redirect(`/m#ticket=${encodeURIComponent(navigation.ticket)}`, 302);
});
