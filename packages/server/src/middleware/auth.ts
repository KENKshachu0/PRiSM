import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import type { AppBindings, AuthUser, StaffPrincipal, TenantShop } from "../bindings.js";
import { addDays, jsonError, nowIso } from "../http.js";
import { randomToken, sha256, sha256Hex } from "../crypto.js";

const cookieName = "arcadelink_session";
const sessionDays = 30;

export const attachUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  const authHeader = c.req.header("authorization");
  const bearerToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = bearerToken || getCookie(c, cookieName);

  if (!token) {
    c.set("user", null);
    c.set("sessionId", null);
    await next();
    return;
  }

  const tokenHash = await sha256(token);
  const row = await c.env.DB.prepare(
    `SELECT sessions.id AS session_id, users.id, identities.username, identities.display_name,
            users.role, users.banned_at
     FROM auth_sessions AS sessions
     JOIN users ON users.id = sessions.user_id
     LEFT JOIN auth_identities AS identities ON identities.id = (
       SELECT id FROM auth_identities
       WHERE user_id = users.id
       ORDER BY CASE WHEN provider = 'munet' THEN 0 ELSE 1 END, created_at ASC
       LIMIT 1
     )
     WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
  )
    .bind(tokenHash, nowIso())
    .first<{
      session_id: string;
      id: string;
      username: string | null;
      display_name: string | null;
      role: AuthUser["role"];
      banned_at: string | null;
    }>();

  if (!row) {
    deleteSessionCookie(c);
    c.set("user", null);
    c.set("sessionId", null);
    await next();
    return;
  }

  c.set("sessionId", row.session_id);
  c.set("user", {
    id: row.id,
    username: row.username ?? "",
    displayName: row.display_name ?? row.username ?? "用户",
    role: row.role,
    bannedAt: row.banned_at,
  });
  await next();
};

export function requireUser(c: Context<AppBindings>): AuthUser {
  const user = c.get("user");
  if (!user) jsonError(401, "请先登录", "AUTHENTICATION_REQUIRED");
  if (user.bannedAt) jsonError(403, "这个账号暂时无法使用", "ACCOUNT_BANNED");
  return user;
}

export function optionalUser(c: Context<AppBindings>): AuthUser | null {
  const user = c.get("user");
  if (user?.bannedAt) return null;
  return user ?? null;
}

export function requireAdmin(c: Context<AppBindings>): AuthUser {
  const user = requireUser(c);
  if (user.role !== "admin") jsonError(403, "你没有管理权限", "FORBIDDEN");
  return user;
}

export async function staffPrincipal(
  c: Context<AppBindings>,
  shop: TenantShop,
  readOnly = false,
): Promise<StaffPrincipal> {
  // The standalone runtime issues per-shop admin-session bearer tokens.
  // Resolve those before platform cookies, always against the selected tenant.
  if (!c.get("user")) {
    const token = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    const deps = c.get("deps");
    if (token && deps) {
      const session = await deps.repositories.system.findAdminSessionByTokenHash(await sha256Hex(token));
      if (session && session.expiresAt.getTime() > Date.now()) {
        const staff = await deps.repositories.system.findStaffUserById(session.staffUserId);
        if (staff?.status === "active") {
          if (!readOnly && staff.role === "viewer") {
            jsonError(403, "只读账号不能执行此操作", "FORBIDDEN");
          }
          return { role: "staff", staffId: staff.id, staffRole: staff.role };
        }
      }
    }
  }
  const user = requireUser(c);

  const mapping = await c.env.DB.prepare(
    `SELECT s.id, s.role, s.status FROM shop_staff_accounts a
     JOIN staff_users s ON s.shop_id = a.shop_id AND s.id = a.staff_id
     WHERE a.shop_id = ? AND a.user_id = ?`,
  )
    .bind(shop.id, user.id)
    .first<{
      id: string;
      role: "owner" | "manager" | "viewer";
      status: string;
    }>();

  const member = await c.env.DB.prepare(
    "SELECT role FROM shop_members WHERE shop_id = ? AND user_id = ?",
  )
    .bind(shop.id, user.id)
    .first<{ role: string }>();

  if (!member && user.role !== "admin") {
    jsonError(403, "没有店铺账务管理权限", "FORBIDDEN");
  }

  if (mapping?.status === "active") {
    // An old billing-owner mapping must not survive revocation of shop ownership.
    // Billing managers remain writable; owner-only actions require actual membership.
    const effectiveRole =
      mapping.role === "owner" && member?.role !== "owner" && user.role !== "admin"
        ? "manager"
        : mapping.role;
    if (!readOnly && effectiveRole === "viewer") {
      jsonError(403, "只读账号不能执行此操作", "FORBIDDEN");
    }
    return { role: "staff", staffId: mapping.id, staffRole: effectiveRole };
  }

  if (member?.role !== "owner" && user.role !== "admin") {
    jsonError(403, "没有店铺账务管理权限", "FORBIDDEN");
  }

  const staffId = `account:${user.id}`;
  if (readOnly) return { role: "staff", staffId, staffRole: "owner" };

  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO staff_users (shop_id, id, username, display_name, password_hash, password_salt, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'owner', 'active', ?, ?) ON CONFLICT(shop_id, id) DO NOTHING",
    ).bind(
      shop.id,
      staffId,
      `account:${user.id}`,
      user.displayName,
      crypto.randomUUID(),
      crypto.randomUUID(),
      new Date().toISOString(),
      new Date().toISOString(),
    ),
    c.env.DB.prepare(
      "INSERT INTO shop_staff_accounts (shop_id, user_id, staff_id) VALUES (?, ?, ?) ON CONFLICT(shop_id, user_id) DO NOTHING",
    ).bind(shop.id, user.id, staffId),
  ]);

  return { role: "staff", staffId, staffRole: "owner" };
}

export async function createSession(
  c: Context<AppBindings>,
  userId: string,
): Promise<string> {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const expiresAt = addDays(new Date(), sessionDays).toISOString();

  await c.env.DB.prepare(
    "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), userId, tokenHash, expiresAt)
    .run();

  setCookie(c, cookieName, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: sessionDays * 24 * 60 * 60,
  });

  return token;
}

export async function destroySession(c: Context<AppBindings>): Promise<void> {
  const sessionId = c.get("sessionId");
  if (sessionId) {
    await c.env.DB.prepare("DELETE FROM auth_sessions WHERE id = ?")
      .bind(sessionId)
      .run();
  }
  deleteSessionCookie(c);
}

export function deleteSessionCookie(c: Context<AppBindings>): void {
  deleteCookie(c, cookieName, { path: "/" });
}
