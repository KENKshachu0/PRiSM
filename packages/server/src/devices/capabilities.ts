/**
 * Capability catalog.
 *
 * Every capability a device can carry is declared here once: how its config is
 * validated, which actions it offers and whether they count as play, which
 * device signals it accepts, and which state it keeps and who is authoritative
 * for it. Every other part of the platform asks this catalog instead of looking
 * at storage columns, which is what used to let a dozen call sites disagree.
 *
 * State authority:
 * - owned     the platform is the source of truth; stored value is the fact
 * - external  the truth lives elsewhere (Home Assistant); read live every time,
 *             and storage only keeps the observation history
 */
import { z } from "zod";

export type CapabilityId = "power" | "hinata_io" | "door" | "mahjong";

/** What a player or staff member asks a device to do. Names are the public action names. */
export type ActionName = "power.on" | "power.off" | "aime.scan" | "coin" | "door.open";

export type ActionSpec = {
  /** Billing treats a player who requested this as having used the device. */
  countsAsPlay: boolean;
  /** Only staff may request this from the player QR page. */
  staffOnly?: boolean;
  /** A player must be inside a billed entry to request this. */
  requiresEntry?: boolean;
  /** A device signal with this name marks the operation as confirmed. */
  confirmedBy?: string;
  /** Do not persist the action's result payload (e.g. a temporary door code). */
  sensitiveResult?: boolean;
  /** Re-read this state after the action, instead of assuming the effect. */
  observeAfter?: string;
};

export type SignalSpec = {
  /** The signal shows a person is physically using the device. */
  activity: boolean;
  /** Persist the signal. Per-frame telemetry is not worth a row. */
  store: boolean;
};

export type StateSpec = { authority: "owned" | "external" };

export type CapabilitySpec<Config> = {
  id: CapabilityId;
  /** Value of `executorKind` in compatibility views and Bot responses. */
  legacyExecutor: "home_assistant" | "hinata_io" | "ttlock" | "machine_ws";
  legacyTargetKind: "facility" | "game_machine";
  /** Input may omit defaulted fields; the parsed output is always complete. */
  config: z.ZodType<Config, z.ZodTypeDef, unknown>;
  /** Names of encrypted values stored in `secret_json`. */
  secrets: readonly string[];
  actions: Partial<Record<ActionName, ActionSpec>>;
  signals: Record<string, SignalSpec>;
  state: Record<string, StateSpec>;
  /** Whether an action is usable with this configuration (e.g. coin needs a key). */
  available(action: ActionName, config: Config, secrets: ReadonlySet<string>): boolean;
};

const powerConfig = z.object({}).passthrough();

const hinataConfig = z.object({
  transport: z.enum(["external", "embedded"]).default("external"),
  coinKey: z.number().int().min(0).max(65535).default(32),
  coinAfterSwipe: z.boolean().default(false),
  /** Durable Object name for the embedded relay. Stable across token rotation. */
  channel: z.string().min(1).optional(),
});
export type HinataConfig = z.infer<typeof hinataConfig>;

const doorConfig = z.object({ lockId: z.number().int().positive() });
export type DoorConfig = z.infer<typeof doorConfig>;

const mahjongConfig = z.object({
  capacity: z.number().int().min(2).max(8),
  pricingConfigIds: z.array(z.string().min(1)).max(20).default([]),
});
export type MahjongConfig = z.infer<typeof mahjongConfig>;

export const power: CapabilitySpec<z.infer<typeof powerConfig>> = {
  id: "power",
  legacyExecutor: "home_assistant",
  legacyTargetKind: "facility",
  config: powerConfig,
  secrets: ["binding"],
  actions: {
    "power.on": { countsAsPlay: true, requiresEntry: true, observeAfter: "power" },
    "power.off": { countsAsPlay: true, requiresEntry: true, staffOnly: true, observeAfter: "power" },
  },
  signals: {},
  // Power can be switched outside the platform, so it is always read live.
  state: { power: { authority: "external" } },
  available: (_action, _config, secrets) => secrets.has("binding"),
};

export const hinataIo: CapabilitySpec<HinataConfig> = {
  id: "hinata_io",
  legacyExecutor: "hinata_io",
  legacyTargetKind: "game_machine",
  config: hinataConfig,
  secrets: ["url", "password"],
  actions: {
    "aime.scan": { countsAsPlay: true, requiresEntry: true, confirmedBy: "card.consumed" },
    coin: { countsAsPlay: true, requiresEntry: true },
  },
  signals: {
    "card.state": { activity: true, store: true },
    "card.consumed": { activity: true, store: true },
    // Games call the LED API every frame; idle attract screens do too.
    "led.set": { activity: false, store: false },
  },
  state: { link: { authority: "owned" } },
  available(action, config, secrets) {
    const connected = config.transport === "embedded" ? !!config.channel : secrets.has("url");
    if (!connected) return false;
    if (action !== "coin") return true;
    // An external relay rejects a plaintext key press; the embedded relay
    // authenticates the connection instead and needs no password.
    return config.coinKey > 0 && (config.transport === "embedded" || secrets.has("password"));
  },
};

export const door: CapabilitySpec<DoorConfig> = {
  id: "door",
  legacyExecutor: "ttlock",
  legacyTargetKind: "facility",
  config: doorConfig,
  secrets: [],
  actions: {
    // Opening the door is not playing a machine, and its code must not be logged.
    "door.open": { countsAsPlay: false, sensitiveResult: true },
  },
  signals: {},
  state: {},
  available: () => true,
};

export const mahjong: CapabilitySpec<MahjongConfig> = {
  id: "mahjong",
  legacyExecutor: "machine_ws",
  legacyTargetKind: "game_machine",
  config: mahjongConfig,
  secrets: [],
  // Joining and leaving a table are seat changes handled by the mahjong flow,
  // not device actions.
  actions: {},
  signals: {},
  state: {},
  available: () => false,
};

export const capabilities = { power, hinata_io: hinataIo, door, mahjong } as const;

export function capabilitySpec(id: string): CapabilitySpec<unknown> | null {
  return (capabilities as Record<string, CapabilitySpec<unknown>>)[id] ?? null;
}

/** The capability that offers an action. Each action belongs to exactly one capability. */
export function capabilityForAction(action: string): CapabilitySpec<unknown> | null {
  for (const spec of Object.values(capabilities) as CapabilitySpec<unknown>[]) {
    if (action in spec.actions) return spec;
  }
  return null;
}

export function actionSpec(action: string): ActionSpec | null {
  const spec = capabilityForAction(action);
  return spec ? (spec.actions as Record<string, ActionSpec>)[action]! : null;
}

export function isActionName(value: string): value is ActionName {
  return capabilityForAction(value) !== null;
}
