import { Hono } from "hono";
import { z } from "zod";
import type { DeviceCommandType, DeviceReferenceTarget } from "@prism/core";
import type { AppBindings } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { staffPrincipal } from "../../middleware/auth.js";
import { getShop, getShopDeps } from "../../middleware/tenant.js";
import { toDeviceCommandView, toStaffDeviceCommandView } from "./views.js";

const createMachineSchema = z.object({
  name: z.string().trim().min(1, "设备名称不能为空").max(80),
  kind: z.string().trim().default("game_machine"),
  enabled: z.boolean().default(true),
  coinKey: z.number().int().min(0).max(10).default(0),
  coinAfterSwipe: z.boolean().default(false),
  aliases: z.array(z.string().trim()).default([]),
});

const patchMachineSchema = createMachineSchema.partial();

const deviceActionSchema = z.object({
  action: z.enum(["power.on", "power.off", "coin", "door.open", "aime.scan", "mahjong.join", "mahjong.leave"]),
  playerId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const devicesRouter = new Hono<AppBindings>();

// List Devices
devicesRouter.get("/", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const rows = await c.env.DB.prepare(
    "SELECT * FROM machines WHERE shop_id = ? ORDER BY created_at DESC",
  )
    .bind(shop.id)
    .all();
  return c.json({ devices: rows.results });
});

// Device Details
devicesRouter.get("/:id", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const machineId = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT * FROM machines WHERE shop_id = ? AND (id = ? OR public_id = ?)",
  )
    .bind(shop.id, machineId, machineId)
    .first();
  if (!row) {
    jsonError(404, "没有找到这台设备", "DEVICE_NOT_FOUND");
  }
  return c.json({ device: row });
});

// Create Device
devicesRouter.post("/", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const body = createMachineSchema.parse(await c.req.json());
  const id = crypto.randomUUID();
  const publicId = Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO machines (id, public_id, shop_id, shop_public_id, name, kind, enabled, coin_key, coin_after_swipe, aliases_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      publicId,
      shop.id,
      shop.public_id,
      body.name,
      body.kind,
      body.enabled ? 1 : 0,
      body.coinKey,
      body.coinAfterSwipe ? 1 : 0,
      JSON.stringify(body.aliases),
      now,
      now,
    )
    .run();

  const created = await c.env.DB.prepare("SELECT * FROM machines WHERE id = ?")
    .bind(id)
    .first();
  return c.json({ device: created }, 201);
});

// Update Device
devicesRouter.patch("/:id", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const machineId = c.req.param("id");
  const existing = await c.env.DB.prepare(
    "SELECT id FROM machines WHERE shop_id = ? AND (id = ? OR public_id = ?)",
  )
    .bind(shop.id, machineId, machineId)
    .first<{ id: string }>();

  if (!existing) {
    jsonError(404, "没有找到这台设备", "DEVICE_NOT_FOUND");
  }

  const body = patchMachineSchema.parse(await c.req.json());
  const updates: string[] = [];
  const bindings: unknown[] = [];

  if (body.name !== undefined) {
    updates.push("name = ?");
    bindings.push(body.name);
  }
  if (body.kind !== undefined) {
    updates.push("kind = ?");
    bindings.push(body.kind);
  }
  if (body.enabled !== undefined) {
    updates.push("enabled = ?");
    bindings.push(body.enabled ? 1 : 0);
  }
  if (body.coinKey !== undefined) {
    updates.push("coin_key = ?");
    bindings.push(body.coinKey);
  }
  if (body.coinAfterSwipe !== undefined) {
    updates.push("coin_after_swipe = ?");
    bindings.push(body.coinAfterSwipe ? 1 : 0);
  }
  if (body.aliases !== undefined) {
    updates.push("aliases_json = ?");
    bindings.push(JSON.stringify(body.aliases));
  }

  if (updates.length > 0) {
    updates.push("updated_at = ?");
    bindings.push(new Date().toISOString());
    bindings.push(existing.id);

    await c.env.DB.prepare(
      `UPDATE machines SET ${updates.join(", ")} WHERE id = ?`,
    )
      .bind(...bindings as any)
      .run();
  }

  const updated = await c.env.DB.prepare("SELECT * FROM machines WHERE id = ?")
    .bind(existing.id)
    .first();
  return c.json({ device: updated });
});

// Delete Device
devicesRouter.delete("/:id", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const machineId = c.req.param("id");
  const existing = await c.env.DB.prepare(
    "SELECT id FROM machines WHERE shop_id = ? AND (id = ? OR public_id = ?)",
  )
    .bind(shop.id, machineId, machineId)
    .first<{ id: string }>();

  if (!existing) {
    jsonError(404, "没有找到这台设备", "DEVICE_NOT_FOUND");
  }

  // Machine activity is an audit trail. Historical machines must be disabled, not removed.
  const used = await c.env.DB.prepare(
    `SELECT 1 FROM machine_login_events WHERE machine_id=?
     UNION ALL SELECT 1 FROM player_operations WHERE device_id=?
     UNION ALL SELECT 1 FROM device_commands WHERE shop_id=? AND device_id=? LIMIT 1`,
  ).bind(existing.id, existing.id, shop.id, existing.id).first();
  if (used) jsonError(409, "机台已有操作记录，请改为停用", "MACHINE_HAS_HISTORY");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM machine_tickets WHERE machine_id=?").bind(existing.id),
    c.env.DB.prepare("DELETE FROM machines WHERE id=? AND shop_id=?").bind(existing.id, shop.id),
  ]);
  return c.json({ ok: true });
});

// Device Actions (Power, Coin, Door, Aime Scan)
devicesRouter.post("/:id/actions", async (c) => {
  const shop = getShop(c);
  const staff = await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const machineId = c.req.param("id");

  const machine = await c.env.DB.prepare(
    "SELECT * FROM machines WHERE shop_id = ? AND (id = ? OR public_id = ?)",
  )
    .bind(shop.id, machineId, machineId)
    .first<{ id: string; name: string; kind?: string; enabled: number }>();

  if (!machine) {
    jsonError(404, "没有找到这台设备", "DEVICE_NOT_FOUND");
  }
  if (!machine.enabled) {
    jsonError(409, "设备已停用", "DEVICE_DISABLED");
  }

  const body = deviceActionSchema.parse(await c.req.json());
  const actionType = body.action as DeviceCommandType;
  // Power and doors are facility actions even when the bound machine is a
  // game cabinet. Coin/Aime must go through its validated Hinata resolver.
  const target: DeviceReferenceTarget =
    actionType === "power.on" || actionType === "power.off" || actionType === "door.open"
      ? { kind: "facility", ref: machine.id }
      : { kind: "game_machine", ref: machine.id };

  const command = await deps.deviceActions.requestDeviceAction({
    actor: { type: "staff", staffId: staff.staffId },
    target,
    type: actionType,
    payload: {
      ...(body.payload ?? {}),
      deviceLabel: machine.name,
      ...(body.playerId ? { playerId: body.playerId } : {}),
    },
  });

  return c.json({ command: toDeviceCommandView(command) });
});

// List Device Commands
devicesRouter.get("/commands", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  if (!deps.staffQueries.listDeviceCommands) {
    jsonError(503, "Device command queries not configured.", "DEVICE_COMMANDS_NOT_CONFIGURED");
  }
  const limit = Number(c.req.query("limit") ?? 50);
  const commands = await deps.staffQueries.listDeviceCommands({ limit });
  return c.json({ commands: commands.map(toStaffDeviceCommandView) });
});
