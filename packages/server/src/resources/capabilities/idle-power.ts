/**
 * Idle power-off: when a shop or a device has been idle long enough, and what
 * to do about it. This module decides; the shop hub reads the inputs, acts on
 * the plan and wakes for the next deadline.
 *
 * Two rules, both off until the shop turns them on:
 * - **Shop empty**: no active entry for N minutes, then every powered device
 *   and every air conditioner is switched off. Nobody is billed, so this rule
 *   never needs to know who is playing what.
 * - **Device idle**: a device with power has had no activity for its idle time.
 *   Sessions are not tied to devices, and a guest game or a physical coin shows
 *   no activity at all, so while the shop has players the owner chooses what
 *   happens: only mark it idle, remind through the bot, or switch it off.
 *
 * Activity is anything that shows a person at the device: a card signal from
 * its IO, or an action that counts as play requested by a player or staff
 * (power on, coin, swipe, keep-alive). Being switched on counts too, so a
 * machine turned on outside the platform gets its full idle time.
 */
import { z } from "zod";

export const IDLE_SETTINGS_KEY = "devices.idle_power";

export const idleSettingsSchema = z.object({
  shopEmpty: z
    .object({
      enabled: z.boolean().default(false),
      minutes: z.number().int().min(1).max(24 * 60).default(15),
    })
    .default({}),
  device: z
    .object({
      /** 0 turns the per-device rule off unless a device sets its own time. */
      defaultMinutes: z.number().int().min(0).max(24 * 60).default(0),
      whileOccupied: z.enum(["mark", "remind", "off"]).default("mark"),
    })
    .default({}),
  devices: z
    .record(
      z.object({
        /** null or absent: the shop default. 0: this device has no idle time. */
        minutes: z.number().int().min(0).max(24 * 60).nullable().optional(),
        /** Never switched off automatically (a router, a lock's supply). */
        exclude: z.boolean().optional(),
      }),
    )
    .default({}),
});
export type IdleSettings = z.infer<typeof idleSettingsSchema>;

export function parseIdleSettings(value: unknown): IdleSettings {
  const parsed = idleSettingsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : idleSettingsSchema.parse({});
}

/** An automatic power-off that failed is not retried sooner than this. */
export const RETRY_OFF_MS = 10 * 60_000;

export type IdleDevice = {
  id: string;
  name: string;
  hasPower: boolean;
  hasClimate: boolean;
  /** Current power; null when nothing watches the device, or its source reports it unavailable. */
  power: "on" | "off" | null;
  /** Climate mode; anything other than "off" is running. Null when unknown. */
  climate: string | null;
  /** Latest activity, in ms. */
  lastActivity: number | null;
  /** When it was last seen switching on, in ms. */
  poweredOnAt: number | null;
  idle: boolean;
  lastAutoOff: number | null;
};

export type IdleInputs = {
  now: number;
  settings: IdleSettings;
  activeEntries: number;
  /** When the shop became empty, as remembered, or the last entry's end. */
  emptySince: number | null;
  /** The empty period whose power-off already ran. */
  emptyHandled: number | null;
  devices: IdleDevice[];
  /** How long before a power-off the bot should be told; null without a bot. */
  reminderLeadMs: number | null;
  /** Deadlines already reminded about, by key. */
  reminded: Record<string, number>;
};

export type Reminder = { key: string; reason: "shop_empty" | "device_idle"; deviceIds: string[]; at: number };

export type IdlePlan = {
  powerOff: string[];
  climateOff: string[];
  markIdle: string[];
  clearIdle: string[];
  remind: Reminder[];
  emptySince: number | null;
  emptyHandled: number | null;
  nextWake: number | null;
};

export function idleMinutes(settings: IdleSettings, deviceId: string): number {
  const own = settings.devices[deviceId];
  if (own?.exclude) return 0;
  return own?.minutes ?? settings.device.defaultMinutes;
}

export function planIdle(input: IdleInputs): IdlePlan {
  const { now, settings } = input;
  const plan: IdlePlan = {
    powerOff: [],
    climateOff: [],
    markIdle: [],
    clearIdle: [],
    remind: [],
    emptySince: null,
    emptyHandled: null,
    nextWake: null,
  };
  const wake = (at: number) => {
    if (at > now && (plan.nextWake === null || at < plan.nextWake)) plan.nextWake = at;
  };
  const remindBefore = (key: string, reason: Reminder["reason"], deviceIds: string[], deadline: number) => {
    if (input.reminderLeadMs === null || !deviceIds.length) return;
    const at = deadline - input.reminderLeadMs;
    if (now >= at && now < deadline && input.reminded[key] !== deadline) plan.remind.push({ key, reason, deviceIds, at: deadline });
    else if (now < at) wake(at);
  };
  const excluded = (device: IdleDevice) => settings.devices[device.id]?.exclude === true;
  const canRetry = (device: IdleDevice) => device.lastAutoOff === null || now - device.lastAutoOff >= RETRY_OFF_MS;

  const empty = input.activeEntries === 0;
  if (settings.shopEmpty.enabled && empty) {
    const since = input.emptySince ?? now;
    plan.emptySince = since;
    plan.emptyHandled = input.emptyHandled;
    const deadline = since + settings.shopEmpty.minutes * 60_000;
    // An unknown state (nothing watches the device) is treated as possibly on:
    // switching off a device that is already off does no harm.
    const powered = input.devices.filter((d) => d.hasPower && d.power !== "off" && !excluded(d));
    const cooling = input.devices.filter((d) => d.hasClimate && d.climate !== "off" && !excluded(d));
    if (input.emptyHandled !== since) {
      if (now >= deadline) {
        plan.powerOff.push(...powered.filter(canRetry).map((d) => d.id));
        plan.climateOff.push(...cooling.map((d) => d.id));
        plan.emptyHandled = since;
      } else {
        wake(deadline);
        remindBefore(`empty:${since}`, "shop_empty", [...new Set([...powered, ...cooling].map((d) => d.id))], deadline);
      }
    }
  } else if (empty) {
    plan.emptySince = input.emptySince ?? now;
  }

  for (const device of input.devices) {
    const minutes = idleMinutes(settings, device.id);
    // Without a known state the device's own activity is the only clock, and it
    // is switched off once per stretch of idleness: nothing shows whether it took.
    const blind = device.power === null;
    const handled = blind && device.lastAutoOff !== null && device.lastAutoOff >= (device.lastActivity ?? 0);
    if (!device.hasPower || device.power === "off" || minutes <= 0 || excluded(device) || (blind && (device.lastActivity === null || handled))) {
      if (device.idle) plan.clearIdle.push(device.id);
      continue;
    }
    const since = Math.max(device.lastActivity ?? 0, device.poweredOnAt ?? 0) || now;
    const deadline = since + minutes * 60_000;
    if (now < deadline) {
      if (device.idle) plan.clearIdle.push(device.id);
      wake(deadline);
      if (!empty && settings.device.whileOccupied !== "mark")
        remindBefore(`device:${device.id}`, "device_idle", [device.id], deadline);
      continue;
    }
    if (plan.powerOff.includes(device.id)) continue;
    // With nobody in, the device rule switches off unless the shop rule is
    // about to; with players in, the owner's choice applies.
    const policy = empty ? (settings.shopEmpty.enabled ? "mark" : "off") : settings.device.whileOccupied;
    if (!device.idle) plan.markIdle.push(device.id);
    if (policy === "off" && canRetry(device)) plan.powerOff.push(device.id);
    if (policy === "off" && !canRetry(device)) wake(device.lastAutoOff! + RETRY_OFF_MS);
  }
  return plan;
}
