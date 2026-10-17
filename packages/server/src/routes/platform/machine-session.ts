import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../bindings.js";
import { decryptSecret, encryptSecret, sha256 } from "../../crypto.js";
import { jsonError } from "../../http.js";
import { hinataConfigOf, loadDevice, publicCapabilities } from "../../devices/device.js";

export const machineSessionRouter = new Hono<AppBindings>();
export const machineTicketRouter = new Hono<AppBindings>();
const ttlSeconds = 300;
type Navigation = { shopCode: string; publicId: string; expiresAt: number };
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const navigationKey = (secret: string) => `prism:machine-navigation:v1:${secret}`;

export type Machine = {
  id: string;
  shop_id: string;
  public_id: string;
  shop_public_id: string;
  shop_name: string;
  shop_hero_url: string | null;
  name: string;
  kind: string;
  enabled: number;
  billing_enabled: number;
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
  COALESCE(b.billing_enabled,0) AS billing_enabled
  FROM machines JOIN shops ON shops.id=machines.shop_id
  LEFT JOIN shop_billing_settings b ON b.shop_id=shops.id`;

async function findMachine(c: Context<AppBindings>, publicId: string): Promise<Machine | null> {
  return c.env.DB.prepare(`${machineSelect} WHERE machines.public_id=?`)
    .bind(publicId).first<Machine>();
}

export async function mintMachineTicket(secret: string | undefined, shopCode: string, publicId: string, now = Date.now()) {
  if (!validId(shopCode) || !validId(publicId)) jsonError(404, "机台不可用", "MACHINE_NOT_FOUND");
  if (!secret) jsonError(503, "会话密钥尚未配置", "SESSION_SECRET_NOT_CONFIGURED");
  const payload: Navigation = { shopCode, publicId, expiresAt: now + ttlSeconds * 1000 };
  return {
    ticket: `v1.${await encryptSecret(JSON.stringify(payload), navigationKey(secret))}`,
    expiresIn: ttlSeconds,
  };
}

export async function readMachineTicket(secret: string | undefined, ticket: string, now = Date.now()): Promise<Navigation> {
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

export async function resolveMachineSession(c: Context<AppBindings>, ticket: string, routePublicId?: string) {
  const normalized = ticket.trim(), route = routePublicId?.trim();
  if (!normalized || normalized.length > 1024) jsonError(410, "本次会话已失效", "TICKET_EXPIRED");
  let machine: Machine | null = null;
  if (normalized.startsWith("v1.")) {
    const navigation = await readMachineTicket(c.env.SESSION_SECRET, normalized);
    if (route && route !== navigation.publicId) jsonError(410, "本次会话已失效", "TICKET_EXPIRED");
    machine = await findMachine(c, navigation.publicId);
    if (!machine || machine.shop_public_id !== navigation.shopCode) jsonError(404, "机台不可用", "MACHINE_NOT_FOUND");
  } else {
    machine = await c.env.DB.prepare(
      `${machineSelect} JOIN machine_tickets t ON t.machine_id=machines.id
      WHERE t.token_hash=? AND t.expires_at>?`,
    ).bind(await sha256(normalized), new Date().toISOString()).first<Machine>();
    if (!machine || (route && route !== machine.public_id)) jsonError(410, "本次会话已失效", "TICKET_EXPIRED");
  }
  if (machine.enabled !== 1) jsonError(404, "机台不可用", "MACHINE_NOT_FOUND");
  return machine;
}

async function publicMachine(c: Context<AppBindings>, m: Machine) {
  const device = await loadDevice(c.env.DB, m.shop_id, m.id);
  const capabilities = device
    ? publicCapabilities(device)
    : { power: false, card: false, coin: false, door: false, mahjong: false };
  const io = device ? hinataConfigOf(device) : null;
  return {
    publicId: m.public_id, name: m.name, kind: m.kind, coinAfterSwipe: !!io?.coinAfterSwipe,
    capabilities,
    // Native apps render the full device flow only for a plain card cabinet.
    webOnly: !!io?.coinAfterSwipe || !!m.billing_enabled || !capabilities.card ||
      capabilities.door || capabilities.power,
    shop: {
      name: m.shop_name, publicId: m.shop_public_id,
      locationEnabled: !!m.machine_geo, machineGeo: !!m.machine_geo,
      billingEnabled: !!m.billing_enabled, heroUrl: m.shop_hero_url,
      latitude: m.latitude, longitude: m.longitude, radiusMeters: m.radius_meters,
    },
  };
}

machineSessionRouter.post("/session/start", async (c) => {
  const body = z.object({
    shopCode: z.string().trim().min(1).max(32),
    publicId: z.string().trim().min(1).max(80),
  }).parse(await c.req.json());
  const machine = await findMachine(c, body.publicId);
  if (!machine || machine.enabled !== 1 || machine.shop_public_id !== body.shopCode)
    jsonError(404, "机台不可用", "MACHINE_NOT_FOUND");
  const navigation = await mintMachineTicket(c.env.SESSION_SECRET, body.shopCode, body.publicId);
  return c.json({ ...navigation, machine: await publicMachine(c, machine) });
});

machineSessionRouter.get("/session", async (c) => {
  const machine = await resolveMachineSession(c, c.req.query("ticket") ?? "");
  return c.json({ machine: await publicMachine(c, machine) });
});
machineSessionRouter.get("/:publicId", async (c) => {
  const machine = await resolveMachineSession(c, c.req.query("ticket") || c.req.param("publicId"), c.req.param("publicId"));
  return c.json({ machine: await publicMachine(c, machine) });
});

machineTicketRouter.get("/:shopCode/:publicId", async (c) => {
  const navigation = await mintMachineTicket(
    c.env.SESSION_SECRET, c.req.param("shopCode"), c.req.param("publicId"),
  );
  c.header("cache-control", "no-store");
  c.header("referrer-policy", "no-referrer");
  return c.redirect(`/m#ticket=${encodeURIComponent(navigation.ticket)}`, 302);
});
