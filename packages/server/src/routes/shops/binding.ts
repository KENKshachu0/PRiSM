import { type Context } from "hono";
import { z } from "zod";
import { createD1Repositories } from "@prism/adapter-d1";
import { withOperationLease } from "@prism/application";
import type { AppBindings, TenantShop } from "../../bindings.js";
import { sha256 } from "../../crypto.js";
import { jsonError } from "../../http.js";
import { notifyUserPages } from "../../durable-objects/shop-hub-client.js";
import { enforceRateLimits } from "../../middleware/rate-limit.js";
import { getShopDeps } from "../../middleware/tenant.js";

export const confirmBindingSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/),
  provider: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_-]{0,63}$/)
    .refine((value) => value !== "web-account", "网页账号身份不可由 Bot 绑定"),
  subject: z.string().trim().min(1).max(256),
});

export async function confirmPlatformBinding(
  c: Context<AppBindings>,
  shop: TenantShop,
  channel: "staff" | "integration",
) {
  await enforceRateLimits(c, [{ key: `bind-confirm:${shop.id}`, limit: 20, windowSeconds: 60 }]);
  const body = confirmBindingSchema.parse(await c.req.json());

  const codeHash = await sha256(body.code);
  const nowIso = new Date().toISOString();

  const code = await c.env.DB.prepare(
    "SELECT user_id FROM platform_binding_codes WHERE shop_id = ? AND code_hash = ? AND expires_at > ?",
  )
    .bind(shop.id, codeHash, nowIso)
    .first<{ user_id: string }>();

  if (!code) {
    jsonError(410, "验证码已失效，请重新生成", "BINDING_CODE_EXPIRED");
  }

  const deps = getShopDeps(c);
  const repos = createD1Repositories({
    db: c.env.DB,
    shopId: shop.id,
    id: crypto.randomUUID,
    now: () => new Date(),
  });

  const player = await withOperationLease(
    { repository: repos.operationLocks, scope: "platform.identities", resourceId: shop.id, now: () => new Date() },
    () =>
      withOperationLease(
        { repository: repos.operationLocks, scope: "platform.membership", resourceId: code.user_id, now: () => new Date() },
        () =>
          withOperationLease(
            { repository: repos.operationLocks, scope: "platform.binding", resourceId: `${body.provider}:${body.subject}`, now: () => new Date() },
            async () => {
              const currentCode = await c.env.DB.prepare(
                "SELECT 1 FROM platform_binding_codes WHERE shop_id = ? AND user_id = ? AND code_hash = ? AND expires_at > ?",
              )
                .bind(shop.id, code.user_id, codeHash, new Date().toISOString())
                .first();

              if (!currentCode) {
                jsonError(410, "验证码已失效，请重新生成", "BINDING_CODE_EXPIRED");
              }

              const conflicts = await c.env.DB.prepare(
                "SELECT user_id, subject FROM shop_platform_bindings WHERE shop_id = ? AND provider = ? AND (user_id = ? OR subject = ?)",
              )
                .bind(shop.id, body.provider, code.user_id, body.subject)
                .all<{ user_id: string; subject: string }>();

              if (conflicts.results.some((r) => r.user_id !== code.user_id || r.subject !== body.subject)) {
                jsonError(409, "账号或平台身份已有其他绑定", "PLATFORM_BINDING_CONFLICT");
              }

              const membership = await c.env.DB.prepare(
                "SELECT player_id FROM shop_player_accounts WHERE shop_id = ? AND user_id = ?",
              )
                .bind(shop.id, code.user_id)
                .first<{ player_id: string }>();

              const existing = await repos.playerIdentities.findPlayerByIdentity(body.provider, body.subject);
              if (membership && existing && existing.id !== membership.player_id) {
                jsonError(409, "该身份属于另一个玩家档案，请联系店员处理", "PLATFORM_BINDING_CONFLICT");
              }

              let player = membership ? await repos.players.findById(membership.player_id) : existing;
              if (!player) {
                if (channel !== "staff" && !shop.auto_register) {
                  jsonError(403, "店铺仅允许绑定已有玩家档案", "PLAYER_IDENTITY_NOT_FOUND");
                }
                player = await deps.integrationCommands.resolveOrRegisterPlayerByIdentity({
                  identity: { provider: body.provider, subject: body.subject },
                  autoRegister: true,
                });
              }

              if (player.status !== "active") {
                jsonError(403, "店铺玩家资格已停用", "PLAYER_DISABLED");
              }

              const occupied = await c.env.DB.prepare(
                "SELECT user_id FROM shop_player_accounts WHERE shop_id = ? AND player_id = ?",
              )
                .bind(shop.id, player.id)
                .first<{ user_id: string }>();

              if (occupied && occupied.user_id !== code.user_id) {
                jsonError(409, "玩家档案已绑定其他账号", "PLATFORM_BINDING_CONFLICT");
              }

              const now = new Date().toISOString();
              await c.env.DB.batch([
                c.env.DB.prepare(
                  "INSERT INTO shop_player_accounts (shop_id, user_id, player_id, verified_at) VALUES (?, ?, ?, ?) ON CONFLICT(shop_id, user_id) DO NOTHING",
                ).bind(shop.id, code.user_id, player.id, now),
                c.env.DB.prepare(
                  "INSERT INTO player_identities (shop_id, player_id, provider, subject, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(shop_id, provider, subject) DO NOTHING",
                ).bind(shop.id, player.id, body.provider, body.subject, now),
                c.env.DB.prepare(
                  "INSERT INTO shop_platform_bindings (shop_id, user_id, provider, subject, verified_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(shop_id, provider, subject) DO NOTHING",
                ).bind(shop.id, code.user_id, body.provider, body.subject, now),
                c.env.DB.prepare(
                  "DELETE FROM platform_binding_codes WHERE shop_id = ? AND user_id = ? AND code_hash = ?",
                ).bind(shop.id, code.user_id, codeHash),
              ]);

              return player;
            },
          ),
      ),
  );

  // The player's open device page learns of it now instead of on its next poll.
  try {
    notifyUserPages(c.env, shop.id, code.user_id, { type: "refresh", reason: "binding" }, c.executionCtx);
  } catch {
    // Local server and tests: no execution context to keep the call alive.
  }
  return c.json({ playerId: player.id, provider: body.provider, subject: body.subject });
}
