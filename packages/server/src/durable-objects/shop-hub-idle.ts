/**
 * The shop hub's idle check: read what `planIdle` needs from storage and the
 * watched states, then carry the plan out through the device bus as the system.
 */
import type { Env } from "../bindings.js";
import { capabilities } from "../devices/capabilities.js";
import { loadDevice } from "../devices/device.js";
import {
  IDLE_SETTINGS_KEY,
  parseIdleSettings,
  planIdle,
  type IdleDevice,
  type Reminder,
} from "../devices/idle-power.js";
import { createRuntimeBus } from "../devices/runtime.js";

/** What the hub remembers between checks. */
export type IdleMemory = {
  emptySince: number | null;
  emptyHandled: number | null;
  reminded: Record<string, number>;
  lastAutoOff: Record<string, number>;
  wakeAt: number | null;
};

export const emptyIdleMemory = (): IdleMemory => ({ emptySince: null, emptyHandled: null, reminded: {}, lastAutoOff: {}, wakeAt: null });

/** A reminder for the bot, with device names so it can be shown as is. */
export type IdleNotice = Omit<Reminder, "deviceIds" | "key"> & { devices: Array<{ id: string; name: string }> };

const ACTIVITY_SIGNALS = Object.entries(capabilities.hinata_io.signals)
  .filter(([, spec]) => spec.activity)
  .map(([name]) => name);
/** Actions that show a person at the device. Switching it off does not. */
const ACTIVITY_ACTIONS = Object.values(capabilities)
  .flatMap((spec) => Object.entries(spec.actions))
  .filter(([name, spec]) => spec?.countsAsPlay && name !== "power.off")
  .map(([name]) => name);
/** Only recent activity can matter; idle times are at most a day. */
const LOOKBACK_MS = 24 * 60 * 60_000;

const parse = (value: string | null) => {
  try {
    return value === null ? null : JSON.parse(value);
  } catch {
    return null;
  }
};

export async function runIdleCheck(input: {
  env: Env;
  shopId: string;
  now: number;
  memory: IdleMemory;
  /** Home Assistant connections whose stored state is current; for the others a device's power is unknown. */
  eventConnections: ReadonlySet<string>;
  reminderLeadMs: number | null;
}): Promise<{ memory: IdleMemory; notices: IdleNotice[]; poweredOff: string[] }> {
  const { env, shopId, now } = input;
  const db = env.DB;
  const settings = parseIdleSettings(
    parse(
      (await db.prepare("SELECT value_json FROM app_settings WHERE shop_id = ? AND key = ?").bind(shopId, IDLE_SETTINGS_KEY)
        .first<{ value_json: string }>())?.value_json ?? null,
    ),
  );
  const anyRule = settings.shopEmpty.enabled || settings.device.defaultMinutes > 0
    || Object.values(settings.devices).some((device) => (device.minutes ?? 0) > 0);
  if (!anyRule) return { memory: { ...emptyIdleMemory(), lastAutoOff: input.memory.lastAutoOff }, notices: [], poweredOff: [] };

  const [visits, capabilityRows, stateRows, activityRows] = await Promise.all([
    db.prepare(
      `SELECT (SELECT COUNT(*) FROM sessions WHERE shop_id = ? AND status = 'active') AS active,
              (SELECT MAX(ended_at) FROM sessions WHERE shop_id = ? AND status = 'closed') AS last_end`,
    ).bind(shopId, shopId).first<{ active: number; last_end: string | null }>(),
    db.prepare(
      `SELECT m.id, m.name, c.capability, c.config_json FROM machines m
       JOIN device_capabilities c ON c.shop_id = m.shop_id AND c.device_id = m.id
       WHERE m.shop_id = ? AND m.enabled = 1 AND c.capability IN ('power', 'climate')`,
    ).bind(shopId).all<{ id: string; name: string; capability: "power" | "climate"; config_json: string }>(),
    db.prepare(
      `SELECT device_id, capability, key, value_json, changed_at FROM device_state
       WHERE shop_id = ? AND ((capability = 'power' AND key IN ('power', 'idle')) OR (capability = 'climate' AND key = 'climate'))`,
    ).bind(shopId).all<{ device_id: string; capability: string; key: string; value_json: string; changed_at: string }>(),
    db.prepare(
      `SELECT device_id, MAX(occurred_at) AS at FROM device_events
       WHERE shop_id = ? AND occurred_at >= ?
         AND ((kind = 'signal' AND name IN (SELECT value FROM json_each(?)))
           OR (kind = 'request' AND name IN (SELECT value FROM json_each(?)) AND (player_id IS NOT NULL OR staff_id IS NOT NULL)))
       GROUP BY device_id`,
    ).bind(shopId, new Date(now - LOOKBACK_MS).toISOString(), JSON.stringify(ACTIVITY_SIGNALS), JSON.stringify(ACTIVITY_ACTIONS))
      .all<{ device_id: string; at: string }>(),
  ]);

  const devices = new Map<string, IdleDevice>();
  const device = (id: string, name: string) => {
    let entry = devices.get(id);
    if (!entry) {
      entry = {
        id, name, hasPower: false, hasClimate: false, power: null, climate: null,
        lastActivity: null, poweredOnAt: null, idle: false, lastAutoOff: input.memory.lastAutoOff[id] ?? null,
      };
      devices.set(id, entry);
    }
    return entry;
  };
  // Stored power and climate are facts only on a watched connection; elsewhere
  // they are unknown, and the idle rules switch off without knowing.
  const watchedCapabilities = new Set<string>();
  for (const row of capabilityRows.results) {
    const entry = device(row.id, row.name);
    const connection = (parse(row.config_json) as { connectionId?: unknown } | null)?.connectionId;
    if (typeof connection === "string" && input.eventConnections.has(connection)) watchedCapabilities.add(`${row.id}:${row.capability}`);
    if (row.capability === "power") entry.hasPower = true;
    else entry.hasClimate = true;
  }
  for (const row of stateRows.results) {
    const entry = devices.get(row.device_id);
    if (!entry) continue;
    const value = parse(row.value_json);
    if (row.capability === "power" && row.key === "idle") entry.idle = value === true;
    else if (row.capability === "power" && row.key === "power" && watchedCapabilities.has(`${row.device_id}:power`) && (value === "on" || value === "off")) {
      entry.power = value;
      if (value === "on") entry.poweredOnAt = Date.parse(row.changed_at);
    } else if (row.capability === "climate" && watchedCapabilities.has(`${row.device_id}:climate`) && value && typeof value.mode === "string") {
      entry.climate = value.mode;
    }
  }
  for (const row of activityRows.results) {
    const entry = devices.get(row.device_id);
    if (entry) entry.lastActivity = Date.parse(row.at);
  }

  const lastEnd = visits?.last_end ? Date.parse(visits.last_end) : null;
  const active = visits?.active ?? 0;
  const plan = planIdle({
    now,
    settings,
    activeEntries: active,
    emptySince: active === 0 ? (input.memory.emptySince ?? lastEnd ?? now) : null,
    emptyHandled: input.memory.emptyHandled,
    devices: [...devices.values()],
    reminderLeadMs: input.reminderLeadMs,
    reminded: input.memory.reminded,
  });

  // The hub is told about an IO this switches off itself, so it does not call back into its own object.
  const bus = createRuntimeBus({ db, env, shopId, notifyHub: false });
  const memory: IdleMemory = {
    emptySince: plan.emptySince,
    emptyHandled: plan.emptyHandled,
    reminded: Object.fromEntries(Object.entries(input.memory.reminded).filter(([, at]) => at > now)),
    lastAutoOff: { ...input.memory.lastAutoOff },
    wakeAt: plan.nextWake,
  };
  const act = async (id: string, action: "power.off" | "climate.off") => {
    const target = await loadDevice(db, shopId, id);
    if (!target) return false;
    try {
      return (await bus.perform({ device: target, action, actor: { type: "system" } })).operation.status === "succeeded";
    } catch (error) {
      console.error("Idle power-off failed", { shopId, id, action, error });
      return false;
    }
  };
  const poweredOff: string[] = [];
  for (const id of plan.powerOff) {
    memory.lastAutoOff[id] = now;
    if (await act(id, "power.off")) poweredOff.push(id);
  }
  for (const id of plan.climateOff) await act(id, "climate.off");
  for (const [ids, value] of [[plan.markIdle, true], [plan.clearIdle, false]] as const) {
    for (const id of ids) {
      await bus.setOwned({ device: { id }, capability: "power", key: "idle", value }).catch((error) =>
        console.error("Idle mark failed", { shopId, id, error }));
    }
  }
  const notices = plan.remind.map((reminder) => {
    memory.reminded[reminder.key] = reminder.at;
    return {
      reason: reminder.reason,
      at: reminder.at,
      devices: reminder.deviceIds.map((id) => ({ id, name: devices.get(id)?.name ?? id })),
    };
  });
  if (plan.powerOff.length) {
    // Check again once the retry window has passed, in case one did not take.
    const retry = now + 10 * 60_000;
    memory.wakeAt = memory.wakeAt === null ? retry : Math.min(memory.wakeAt, retry);
  }
  return { memory, notices, poweredOff };
}
