/**
 * A read-only Home Assistant account for live state.
 *
 * The HINATA IO that watches Home Assistant for the shop runs on a game PC, so
 * the token it holds must not be able to switch anything. Home Assistant has no
 * per-entity permissions, but its built-in `system-read-only` group can read
 * every entity and control none. Given an administrator's token this creates a
 * user in that group, signs in as it once, mints a long-lived token for it and
 * removes its password, so the token is the account's only way in.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import { encryptSecret, randomToken } from "../../crypto.js";
import { HaCommandError, openHaSession, type HaSocketFactory } from "../../hardware/home-assistant-ws.js";
import { getHaConnection, openHaConnection, writeHaConnection, type ReadAccess } from "./ha-connections.js";

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ReadAccessOptions = {
  /** An administrator token for this one run; never stored. Defaults to the control token. */
  adminToken?: string;
  /** Where this platform is served, used as the OAuth client id Home Assistant requires. */
  origin: string;
  fetcher?: Fetch;
  open?: HaSocketFactory;
  now?: () => Date;
};

const READ_ONLY_GROUP = "system-read-only";
const TOKEN_LIFESPAN_DAYS = 3650;

async function json<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) throw new HaCommandError(`${what}失败（HTTP ${response.status}）`);
  return (await response.json()) as T;
}

/** Sign in as a Home Assistant user with a password and get a short-lived access token. */
async function signIn(baseUrl: string, origin: string, username: string, password: string, fetcher: Fetch) {
  const clientId = `${origin.replace(/\/+$/, "")}/`;
  const flow = await json<{ flow_id?: string }>(
    await fetcher(`${baseUrl}/auth/login_flow`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: clientId, handler: ["homeassistant", null], redirect_uri: clientId }),
    }),
    "Home Assistant 登录",
  );
  if (!flow.flow_id) throw new HaCommandError("Home Assistant 没有启用用户名密码登录");
  const step = await json<{ type?: string; result?: string }>(
    await fetcher(`${baseUrl}/auth/login_flow/${encodeURIComponent(flow.flow_id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: clientId, username, password }),
    }),
    "Home Assistant 登录",
  );
  if (step.type !== "create_entry" || !step.result) throw new HaCommandError("Home Assistant 没有完成登录");
  const token = await json<{ access_token?: string }>(
    await fetcher(`${baseUrl}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: step.result, client_id: clientId }).toString(),
    }),
    "Home Assistant 登录",
  );
  if (!token.access_token) throw new HaCommandError("Home Assistant 没有返回访问令牌");
  return token.access_token;
}

/**
 * Create (or recreate) the read-only account for one connection and store its
 * token. Returns the resulting access state; failures are recorded on the
 * connection rather than thrown, so a device save never fails because of it.
 */
export async function provisionReadAccess(
  db: D1DatabaseLike,
  shopId: string,
  connectionId: string,
  key: string,
  options: ReadAccessOptions,
): Promise<{ access: ReadAccess; error: string | null }> {
  const stored = await getHaConnection(db, shopId, connectionId);
  const connection = await openHaConnection(db, shopId, connectionId, key);
  if (!stored || !connection) return { access: "failed", error: "没有找到这个 Home Assistant 连接" };
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date());
  const save = async (fields: Partial<typeof stored>) => {
    const latest = (await getHaConnection(db, shopId, connectionId)) ?? stored;
    await writeHaConnection(db, shopId, { ...latest, ...fields, updatedAt: now().toISOString() }).run();
  };

  let admin;
  try {
    admin = await openHaSession(connection.url, options.adminToken || connection.token, { open: options.open });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await save({ readAccess: "failed", readError: message });
    return { access: "failed", error: message };
  }
  try {
    const me = await admin.command<{ is_admin?: boolean }>("auth/current_user");
    if (!me?.is_admin) {
      await save({ readAccess: "needs_admin", readError: null });
      return { access: "needs_admin", error: null };
    }
    // One account per connection: an earlier one is replaced, not kept around.
    if (stored.readUserId) {
      await admin.command("config/auth/delete", { user_id: stored.readUserId }).catch(() => undefined);
    }
    const created = await admin.command<{ user?: { id?: string } }>("config/auth/create", {
      name: "PRiSM 实时状态（只读）",
      group_ids: [READ_ONLY_GROUP],
    });
    const userId = created?.user?.id;
    if (!userId) throw new HaCommandError("Home Assistant 没有返回新用户");
    const username = `prism_${randomToken(8).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    const password = randomToken(32);
    await admin.command("config/auth_provider/homeassistant/create", { user_id: userId, username, password });

    const access = await signIn(connection.url, options.origin, username, password, fetcher);
    const reader = await openHaSession(connection.url, access, { open: options.open });
    let readToken: string;
    try {
      readToken = await reader.command<string>("auth/long_lived_access_token", {
        client_name: "PRiSM",
        lifespan: TOKEN_LIFESPAN_DAYS,
      });
    } finally {
      reader.close();
    }
    if (typeof readToken !== "string" || !readToken) throw new HaCommandError("Home Assistant 没有签发令牌");
    // The long-lived token is the account's only way in from now on.
    await admin.command("config/auth_provider/homeassistant/delete", { username }).catch(() => undefined);

    const config = await fetcher(`${connection.url}/api/config`, { headers: { Authorization: `Bearer ${readToken}` } })
      .then((response) => (response.ok ? response.json() as Promise<{ internal_url?: unknown }> : {}))
      .catch(() => ({}));
    const internalUrl = typeof (config as { internal_url?: unknown }).internal_url === "string"
      ? String((config as { internal_url: string }).internal_url).replace(/\/+$/, "")
      : null;
    await save({
      readToken: await encryptSecret(readToken, key),
      readUserId: userId,
      readAccess: "ready",
      readError: null,
      internalUrl,
    });
    return { access: "ready", error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await save({ readAccess: "failed", readError: message });
    return { access: "failed", error: message };
  } finally {
    admin.close();
  }
}
