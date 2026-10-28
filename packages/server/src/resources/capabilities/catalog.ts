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
 * - external  the truth lives elsewhere (Home Assistant). While a HINATA IO
 *             watches it, every change arrives as an event and the stored value
 *             is the fact; otherwise nothing is known and a reader asks Home
 *             Assistant itself, without recording the answer (see `state-view.ts`)
 */
import { z } from "zod";

export type CapabilityId = "power" | "climate" | "hinata_io" | "door" | "mahjong" | "bot";

/** What a player or staff member asks a device to do. Names are the public action names. */
export type ActionName =
  | "power.on"
  | "power.off"
  | "power.keep"
  | "climate.on"
  | "climate.off"
  | "climate.set_mode"
  | "climate.set_temperature"
  | "climate.set_fan_mode"
  | "aime.scan"
  | "coin"
  | "door.open";

export type ActionSpec = {
  /** Billing treats a player who requested this as having used the device. */
  countsAsPlay: boolean;
  /** Only staff may request this from the player QR page. */
  staffOnly?: boolean;
  /** In a shop that bills, the resource's plan must be billing for the player. */
  requiresBilling?: boolean;
  /** A device signal with this name marks the operation as confirmed. */
  confirmedBy?: string;
  /** Do not persist the action's result payload (e.g. a temporary door code). */
  sensitiveResult?: boolean;
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

/**
 * A Home Assistant entity on one of the shop's connections. Bindings from before
 * connections existed have neither field and keep url and token in the
 * `binding` secret until they are adopted.
 */
const haEntityConfig = z
  .object({
    connectionId: z.string().min(1).optional(),
    entityId: z.string().min(1).optional(),
  })
  .passthrough();
export type HaEntityConfig = z.infer<typeof haEntityConfig>;

const haBound = (config: HaEntityConfig, secrets: ReadonlySet<string>) =>
  secrets.has("binding") || (!!config.connectionId && !!config.entityId);

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

/** A mahjong table's size is the resource's capacity, not part of this config. */
const mahjongConfig = z.object({
  pricingConfigIds: z.array(z.string().min(1)).max(20).default([]),
});
export type MahjongConfig = z.infer<typeof mahjongConfig>;

export const power: CapabilitySpec<HaEntityConfig> = {
  id: "power",
  legacyExecutor: "home_assistant",
  legacyTargetKind: "facility",
  config: haEntityConfig,
  secrets: ["binding"],
  actions: {
    "power.on": { countsAsPlay: true, requiresBilling: true },
    "power.off": { countsAsPlay: true, requiresBilling: true, staffOnly: true },
    // "I am still here": an entered player keeps a running device from being
    // switched off as idle. It never switches anything on.
    "power.keep": { countsAsPlay: true, requiresBilling: true },
  },
  signals: {},
  // Power can be switched outside the platform. A watcher's events keep it
  // current; `idle` is the platform's own verdict.
  state: { power: { authority: "external" }, idle: { authority: "owned" } },
  available: (_action, config, secrets) => haBound(config, secrets),
};

const climateAction: ActionSpec = { countsAsPlay: false, requiresBilling: true };

/**
 * A Home Assistant `climate.*` entity, such as an air conditioner. Kept apart
 * from power: its state is a mode and temperatures rather than on/off, using
 * it is not playing a machine, and an air conditioner being off must not stop
 * a machine from taking coins.
 */
export const climate: CapabilitySpec<HaEntityConfig> = {
  id: "climate",
  legacyExecutor: "home_assistant",
  legacyTargetKind: "facility",
  config: haEntityConfig,
  secrets: ["binding"],
  actions: {
    "climate.on": climateAction,
    "climate.off": climateAction,
    "climate.set_mode": climateAction,
    "climate.set_temperature": climateAction,
    "climate.set_fan_mode": climateAction,
  },
  signals: {},
  state: { climate: { authority: "external" } },
  available: (_action, config, secrets) => haBound(config, secrets),
};

export const hinataIo: CapabilitySpec<HinataConfig> = {
  id: "hinata_io",
  legacyExecutor: "hinata_io",
  legacyTargetKind: "game_machine",
  config: hinataConfig,
  secrets: ["url", "password"],
  actions: {
    "aime.scan": { countsAsPlay: true, requiresBilling: true, confirmedBy: "card.consumed" },
    coin: { countsAsPlay: true, requiresBilling: true },
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

/**
 * A shop bot (Koishi): what it offers players and staff, set by the shop on its
 * resource and delivered to the bot, so its own configuration is only how to
 * connect. Everything the platform already knows (staff, currency, tables,
 * doors) is derived, never configured here.
 */
const botConfig = z.object({
  /** The integration token the bot connects with. */
  tokenId: z.string().min(1),
  /** `readonly`: players may only bind, look up and redeem through the bot. */
  playerCommands: z.enum(["all", "readonly"]).default("all"),
  readOnlyNotice: z.string().max(200).default("请扫描店内二维码或碰 NFC，在网页或 App Clip 里入场、结账和操作设备。"),
  /** Staff (by their bound platform identity) may act for other players. */
  staffCommands: z.boolean().default(true),
  /** Only staff may switch machines off through the bot. */
  powerOffStaffOnly: z.boolean().default(false),
  /** The door `开门` opens; a resource with the door capability. */
  doorResourceId: z.string().min(1).nullable().default(null),
  /** Staff receive checkout receipts privately. */
  receiptsToStaff: z.boolean().default(false),
  /**
   * `login`/`入场` also hands out the door code, so a player who comes in
   * through the bot needs one command. Off by default: a code lives three
   * minutes, and a player who does not need the door should not cost one.
   */
  doorPasswordOnEntry: z.boolean().default(false),
  /**
   * Where everything the shop's bot has to say goes: the idle warning and what
   * happens at the shop share one list. Which is said is decided per kind
   * below, not by channel.
   */
  announceChannelIds: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  /** How many minutes before an idle power-off the channels are warned; 0 for never. */
  idleReminderMinutes: z.number().int().min(0).max(120).default(5),
  /**
   * Which news is told, each on its own: a device idling towards a power-off,
   * a device switched on or off through the platform (the idle rule's
   * power-offs included), someone starting on a resource (上机), a card
   * reaching a cabinet, a coin. A card or a coin that starts someone is one
   * message, said as a start when starts are told. All off by default.
   */
  announceIdle: z.boolean().default(false),
  announcePower: z.boolean().default(false),
  announceStarts: z.boolean().default(false),
  announceCards: z.boolean().default(false),
  announceCoins: z.boolean().default(false),
  /** Whether the bot may be given Home Assistant connections to watch. */
});
export type BotConfig = z.infer<typeof botConfig>;

export const bot: CapabilitySpec<BotConfig> = {
  id: "bot",
  legacyExecutor: "machine_ws",
  legacyTargetKind: "facility",
  config: botConfig,
  secrets: [],
  // A bot is a party that asks for actions, not a device that performs them.
  actions: {},
  signals: {},
  state: {},
  available: () => false,
};

export const capabilities = { power, climate, hinata_io: hinataIo, door, mahjong, bot } as const;

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
