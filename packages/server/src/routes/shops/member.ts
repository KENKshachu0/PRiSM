import { Hono, type Context } from "hono";
import { centsOf } from "@prism/core";
import type { AppBindings } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { staffPrincipal } from "../../middleware/auth.js";
import { getShop, getShopDeps } from "../../middleware/tenant.js";
import {
  toMemberPlanView,
  toMemberProgramView,
  toMemberStatusView,
} from "./views.js";

/** Staff-facing membership programme, card-backed plans and per-player grant. */
export const staffMemberRouter = new Hono<AppBindings>();

async function requireMemberStaff(c: Context<AppBindings>, write = false) {
  const principal = await staffPrincipal(c, getShop(c), !write);
  if (write && principal.staffRole === "viewer") {
    jsonError(403, "只读账号不能执行此操作", "FORBIDDEN");
  }
  return principal;
}

async function requireShopPlayer(c: Context<AppBindings>, playerId: string) {
  const player = await getShopDeps(c).repositories.players.findById(playerId);
  if (!player) jsonError(404, "玩家不存在", "PLAYER_NOT_FOUND");
  return player;
}

staffMemberRouter.get("/member", async (c) => {
  await requireMemberStaff(c);
  const program = await getShopDeps(c).memberCommands.getProgram();
  return c.json(toMemberProgramView(program));
});

staffMemberRouter.put("/member", async (c) => {
  await requireMemberStaff(c, true);
  const body = await c.req.json<{ enabled?: unknown }>();
  const program = await getShopDeps(c).memberCommands.saveProgram({
    enabled: body.enabled === true,
  });
  return c.json(toMemberProgramView(program));
});

staffMemberRouter.post("/member/plans", async (c) => {
  await requireMemberStaff(c, true);
  const body = await c.req.json<{
    id?: unknown;
    name?: unknown;
    assetCode?: unknown;
    price?: unknown;
    durationDays?: unknown;
  }>();
  const plan = await getShopDeps(c).memberCommands.savePlan({
    ...(typeof body.id === "string" ? { id: body.id } : {}),
    name: String(body.name ?? ""),
    assetCode: String(body.assetCode ?? ""),
    price: centsOf(Number(body.price ?? 0)),
    durationDays: Number(body.durationDays ?? 0),
  });
  return c.json({ plan: toMemberPlanView(plan) }, 201);
});

staffMemberRouter.put("/member/plans/:planId", async (c) => {
  await requireMemberStaff(c, true);
  const body = await c.req.json<{
    name?: unknown;
    assetCode?: unknown;
    price?: unknown;
    durationDays?: unknown;
  }>();
  const plan = await getShopDeps(c).memberCommands.savePlan({
    id: c.req.param("planId"),
    name: String(body.name ?? ""),
    assetCode: String(body.assetCode ?? ""),
    price: centsOf(Number(body.price ?? 0)),
    durationDays: Number(body.durationDays ?? 0),
  });
  return c.json({ plan: toMemberPlanView(plan) });
});

staffMemberRouter.post("/member/plans/:planId/archive", async (c) => {
  await requireMemberStaff(c, true);
  const plan = await getShopDeps(c).memberCommands.archivePlan({
    planId: c.req.param("planId"),
  });
  return c.json({ plan: toMemberPlanView(plan) });
});

staffMemberRouter.post("/member/plans/:planId/restore", async (c) => {
  await requireMemberStaff(c, true);
  const plan = await getShopDeps(c).memberCommands.restorePlan({
    planId: c.req.param("planId"),
  });
  return c.json({ plan: toMemberPlanView(plan) });
});

staffMemberRouter.get("/players/:playerId/member", async (c) => {
  await requireMemberStaff(c);
  const player = await requireShopPlayer(c, c.req.param("playerId"));
  const status = await getShopDeps(c).memberCommands.getStatus(player.id);
  return c.json({ member: toMemberStatusView(status) });
});

staffMemberRouter.post("/players/:playerId/member/grant", async (c) => {
  const principal = await requireMemberStaff(c, true);
  const player = await requireShopPlayer(c, c.req.param("playerId"));
  const body = await c.req.json<{ planId?: unknown; operationId?: unknown }>();
  const planId = String(body.planId ?? "");
  if (!planId) jsonError(400, "请选择会员方案", "MEMBER_PLAN_REQUIRED");
  const result = await getShopDeps(c).memberCommands.grant({
    playerId: player.id,
    planId,
    staffId: principal.staffId,
    ...(typeof body.operationId === "string" ? { operationId: body.operationId } : {}),
  });
  return c.json({ member: toMemberStatusView(result.status) });
});

staffMemberRouter.post("/players/:playerId/member/revoke", async (c) => {
  const principal = await requireMemberStaff(c, true);
  const player = await requireShopPlayer(c, c.req.param("playerId"));
  const result = await getShopDeps(c).memberCommands.revoke({
    playerId: player.id,
    staffId: principal.staffId,
  });
  return c.json({ member: toMemberStatusView(result.status) });
});
