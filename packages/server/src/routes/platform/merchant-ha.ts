/**
 * The shop's Home Assistant connections: one address and control token per
 * Home Assistant, plus the read-only account used for live state. Owners and
 * managers manage them here; no token is ever sent back.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../bindings.js";
import { encryptSecret } from "../../crypto.js";
import {
  deleteHaConnection,
  getHaConnection,
  listHaConnections,
  normalizeHaUrl,
  openHaConnection,
  writeHaConnection,
  type StoredHaConnection,
} from "../../resources/capabilities/ha-connections.js";
import { provisionReadAccess } from "../../resources/capabilities/ha-read-access.js";
import { MAX_WATCHERS, writeWatcherLimit } from "../../resources/capabilities/ha-watchers.js";
import { refreshShopHub } from "../../durable-objects/shop-hub-client.js";
import { jsonError } from "../../http.js";
import { requireUser } from "../../middleware/auth.js";
import { assertResourceShop, canConfigureResource, encryptionKey } from "./merchant-resources.js";

export const merchantHaRouter = new Hono<AppBindings>();
type C = Context<AppBindings>;

const ENTITY_DOMAINS = ["switch", "input_boolean", "climate"];

/**
 * Run read-only provisioning after the response, recording the outcome on the
 * connection. Without a Worker execution context (the local Bun server, tests)
 * nothing would keep it alive, so it is left to the explicit retry route.
 */
export function scheduleReadAccess(c: C, shopId: string, connectionId: string, adminToken?: string) {
  const key = c.env.URL_ENCRYPTION_KEY;
  let ctx: { waitUntil(promise: Promise<unknown>): void };
  try {
    ctx = c.executionCtx;
  } catch {
    return;
  }
  if (!key) return;
  ctx.waitUntil(
    provisionReadAccess(c.env.DB, shopId, connectionId, key, {
      origin: c.env.APP_ORIGIN || new URL(c.req.url).origin,
      ...(adminToken ? { adminToken } : {}),
    })
      .then((result) => (result.access === "ready" ? refreshShopHub(c.env, shopId) : undefined))
      .catch((error) => console.error("Home Assistant read access failed", error)),
  );
}

/** After the response, have the shop hub pick up changed devices or connections. */
export function afterHaChange(c: C, shopId: string) {
  try {
    c.executionCtx.waitUntil(refreshShopHub(c.env, shopId));
  } catch {
    // No execution context (local server, tests): nothing is watching there.
  }
}

async function usage(c: C, shopId: string): Promise<Map<string, number>> {
  const rows = (
    await c.env.DB.prepare(
      `SELECT json_extract(config_json, '$.connectionId') AS id, COUNT(*) AS n FROM device_capabilities
       WHERE shop_id = ? AND capability IN ('power', 'climate') GROUP BY 1`,
    ).bind(shopId).all<{ id: string | null; n: number }>()
  ).results;
  return new Map(rows.filter((row) => row.id).map((row) => [row.id!, row.n]));
}

function present(connection: StoredHaConnection, used: number, canConfigure: boolean) {
  return {
    id: connection.id,
    url: canConfigure ? connection.url : "",
    internalUrl: canConfigure ? connection.internalUrl : null,
    /** Whether live state can be watched with a token that switches nothing. */
    readAccess: connection.readAccess,
    readError: connection.readError,
    devices: used,
    updatedAt: connection.updatedAt,
  };
}

async function shopFromQuery(c: C, write: boolean) {
  const user = requireUser(c);
  const shopId = c.req.query("shopId");
  if (!shopId) jsonError(400, "请选择店铺", "SHOP_REQUIRED");
  await assertResourceShop(c, user, shopId);
  const canConfigure = await canConfigureResource(c, user, shopId);
  if (write && !canConfigure) jsonError(403, "只读账号不能配置资源", "FORBIDDEN");
  return { shopId, canConfigure };
}

async function connectionOf(c: C, shopId: string) {
  const connection = await getHaConnection(c.env.DB, shopId, c.req.param("id")!);
  if (!connection) jsonError(404, "没有找到这个 Home Assistant 连接", "HA_CONNECTION_NOT_FOUND");
  return connection;
}

merchantHaRouter.get("/ha-connections", async (c) => {
  const { shopId, canConfigure } = await shopFromQuery(c, false);
  const [connections, used] = await Promise.all([listHaConnections(c.env.DB, shopId), usage(c, shopId)]);
  return c.json({ connections: connections.map((connection) => present(connection, used.get(connection.id) ?? 0, canConfigure)) });
});

const patchInput = z.object({
  url: z.string().trim().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "连接地址必须为 HTTP 或 HTTPS").optional(),
  token: z.string().trim().min(1).max(4096).optional(),
});

/** Change a connection's address or control token; every device on it follows. */
merchantHaRouter.patch("/ha-connections/:id", async (c) => {
  const { shopId } = await shopFromQuery(c, true);
  const body = patchInput.parse(await c.req.json());
  const connection = await connectionOf(c, shopId);
  const next: StoredHaConnection = {
    ...connection,
    ...(body.url ? { url: normalizeHaUrl(body.url) } : {}),
    ...(body.token ? { token: await encryptSecret(body.token, encryptionKey(c)) } : {}),
    updatedAt: new Date().toISOString(),
  };
  await writeHaConnection(c.env.DB, shopId, next).run();
  // A new address or token may now be an administrator's; try again.
  if (body.url || body.token) scheduleReadAccess(c, shopId, next.id);
  afterHaChange(c, shopId);
  const used = await usage(c, shopId);
  return c.json({ connection: present(next, used.get(next.id) ?? 0, true) });
});

merchantHaRouter.delete("/ha-connections/:id", async (c) => {
  const { shopId } = await shopFromQuery(c, true);
  const connection = await connectionOf(c, shopId);
  if ((await usage(c, shopId)).get(connection.id)) jsonError(409, "还有设备在使用这个 Home Assistant", "HA_CONNECTION_IN_USE");
  await deleteHaConnection(c.env.DB, shopId, connection.id).run();
  return c.json({ ok: true });
});

const watcherLimitInput = z.object({ count: z.number().int().min(1).max(MAX_WATCHERS) });

/**
 * How many clients (shop bots and HINATA IOs) watch this one shop's Home Assistant at once. Shop
 * owners see the number on the device board but cannot change it: it decides how much the shop asks
 * of its own Home Assistant and of the platform, so it is the platform administrator's alone.
 */
merchantHaRouter.put("/ha-watchers", async (c) => {
  const user = requireUser(c);
  if (user.role !== "admin") jsonError(403, "只有平台管理员可以修改监听器数量", "FORBIDDEN");
  const shopId = c.req.query("shopId");
  if (!shopId) jsonError(400, "请选择店铺", "SHOP_REQUIRED");
  const body = watcherLimitInput.parse(await c.req.json());
  if (!(await c.env.DB.prepare("SELECT 1 FROM shops WHERE id = ?").bind(shopId).first())) jsonError(404, "没有找到这个店铺", "SHOP_NOT_FOUND");
  await writeWatcherLimit(c.env.DB, shopId, body.count);
  // The shop hub picks the new number up, and the board is told who watches now.
  afterHaChange(c, shopId);
  return c.json({ count: body.count });
});

/** Entities a device can bind to, read live with the control token. */
merchantHaRouter.get("/ha-connections/:id/entities", async (c) => {
  const { shopId } = await shopFromQuery(c, true);
  await connectionOf(c, shopId);
  const open = await openHaConnection(c.env.DB, shopId, c.req.param("id"), encryptionKey(c));
  if (!open) jsonError(503, "无法读取 Home Assistant 令牌", "DEVICE_ENCRYPTION_UNAVAILABLE");
  let states: Array<{ entity_id?: unknown; state?: unknown; attributes?: { friendly_name?: unknown } }>;
  try {
    const response = await fetch(`${open.url}/api/states`, {
      headers: { Authorization: `Bearer ${open.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) jsonError(502, `Home Assistant 返回 ${response.status}`, "HOME_ASSISTANT_UNAVAILABLE");
    states = await response.json();
  } catch (error) {
    if (error instanceof Error && "status" in error) throw error;
    jsonError(502, "Home Assistant 未响应", "HOME_ASSISTANT_UNAVAILABLE");
  }
  const entities = (Array.isArray(states) ? states : [])
    .filter((state) => typeof state.entity_id === "string" && ENTITY_DOMAINS.includes(state.entity_id.split(".")[0]!))
    .map((state) => ({
      entityId: state.entity_id as string,
      name: typeof state.attributes?.friendly_name === "string" ? state.attributes.friendly_name : state.entity_id as string,
      state: typeof state.state === "string" ? state.state : "unknown",
    }))
    .sort((a, b) => a.entityId.localeCompare(b.entityId));
  return c.json({ entities });
});

/**
 * Create the read-only account now. `adminToken` is used for this one run and
 * not stored, for a connection whose own token is not an administrator's.
 */
merchantHaRouter.post("/ha-connections/:id/read-access", async (c) => {
  const { shopId } = await shopFromQuery(c, true);
  const body = z.object({ adminToken: z.string().trim().min(1).max(4096).optional() }).parse(await c.req.json().catch(() => ({})));
  const connection = await connectionOf(c, shopId);
  const result = await provisionReadAccess(c.env.DB, shopId, connection.id, encryptionKey(c), {
    origin: c.env.APP_ORIGIN || new URL(c.req.url).origin,
    ...(body.adminToken ? { adminToken: body.adminToken } : {}),
  });
  if (result.access === "ready") afterHaChange(c, shopId);
  const updated = (await getHaConnection(c.env.DB, shopId, connection.id)) ?? connection;
  const used = await usage(c, shopId);
  return c.json({ ...result, connection: present(updated, used.get(updated.id) ?? 0, true) });
});
