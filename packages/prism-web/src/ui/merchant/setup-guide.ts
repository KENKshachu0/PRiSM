import type { Machine } from "../../api";
import type { Settings } from "../BillingPages";
import { deviceCapabilities, isUnconfigured } from "./device-capabilities";

/** How a player proves who they are before entering or using a guarded device. */
export type IdentityPolicy = "web" | "bot" | "existing";

export const identityPolicy = (
  settings: Pick<Settings, "identityBindingRequired" | "autoRegister">,
): IdentityPolicy =>
  !settings.identityBindingRequired
    ? "web"
    : settings.autoRegister
      ? "bot"
      : "existing";

export const identityPolicySettings = (policy: IdentityPolicy) =>
  policy === "web"
    ? { identityBindingRequired: false }
    : { identityBindingRequired: true, autoRegister: policy === "bot" };

/**
 * How the shop takes money. A shop with a front desk always takes payment
 * there; one without may still have staff, but they do not handle money.
 * "devices" shops bill elsewhere and use PRiSM only to run devices.
 */
export type OperatingMode = "devices" | "self" | "desk";

export const operatingMode = (
  settings: Pick<Settings, "billingEnabled" | "cashierEnabled">,
): OperatingMode =>
  !settings.billingEnabled ? "devices" : settings.cashierEnabled ? "desk" : "self";

export type SetupSignals = {
  settings: Settings;
  machines: Machine[];
  tokens: { role: string; status: string; lastUsedAt?: string | null }[];
  ttLock: {
    clientId?: string;
    clientSecret?: string;
    accessToken?: string;
    appAccount?: string;
  } | null;
  /** Players of a billing shop; device-only shops do not keep a roster. */
  players: { walletTotal: number }[] | null;
  /** Redeem codes that can still be used. */
  redeemCodes: number;
  /** A HINATA reader is authorized in this browser; `null` when WebHID is absent. */
  reader: boolean | null;
  members: number;
  presents: number;
  defaultPresent: boolean;
  /** The owner said they printed the codes and tried one; nothing records it. */
  trialConfirmed: boolean;
};

export type SetupStepId =
  | "pricing"
  | "identity"
  | "prepaid"
  | "reader"
  | "staff"
  | "devices"
  | "door"
  | "trial";

export type SetupStep = { id: SetupStepId; done: boolean };

export type SetupStatus = {
  mode: OperatingMode;
  billing: boolean;
  steps: SetupStep[];
  complete: boolean;
  /** Why billing is not ready: no balance asset, or no usable entry rule. */
  pricingProblem: "assets" | "entry" | null;
  devices: number;
  unconfigured: number;
  doorDevices: number;
  identity: IdentityPolicy;
  identityMatters: boolean;
  botIssued: boolean;
  botConnected: boolean;
  bindingPrompt: string;
  ttLockReady: boolean;
  players: number;
  fundedPlayers: number;
  redeemCodes: number;
  reader: boolean | null;
  members: number;
  presents: number;
  defaultPresent: boolean;
  locationEnabled: boolean;
};

/**
 * Derive the shop's setup checklist from data the admin already reads. A step
 * is listed only when a real player would be stuck without it, and the list
 * follows how the shop takes money.
 */
export function setupStatus(signals: SetupSignals): SetupStatus {
  const { settings, machines } = signals;
  const mode = operatingMode(settings);
  const billing = mode !== "devices";
  const caps = machines.map(deviceCapabilities);
  const unconfigured = machines.filter(isUnconfigured).length;
  const doorDevices = caps.filter((c) => c.door).length;
  const activeBots = signals.tokens.filter(
    (token) => token.role === "integration" && token.status === "active",
  );
  const botConnected = activeBots.some((token) => !!token.lastUsedAt);
  const identity = identityPolicy(settings);
  const ttLock = signals.ttLock;
  const ttLockReady = !!(
    ttLock?.clientId &&
    ttLock.clientSecret &&
    (ttLock.accessToken || ttLock.appAccount)
  );
  // The server asks for a shop player on every billed device, and on doors
  // and mahjong tables everywhere.
  const identityMatters = billing || caps.some((c) => c.door || c.mahjong);
  const players = signals.players ?? [];
  const fundedPlayers = players.filter((player) => player.walletTotal > 0).length;
  const steps: SetupStep[] = [];
  if (billing)
    steps.push({ id: "pricing", done: !!settings.billingConfiguration?.ready });
  if (mode === "desk") {
    steps.push({ id: "reader", done: signals.reader === true });
    steps.push({ id: "staff", done: signals.members > 1 });
  }
  if (identityMatters)
    steps.push({ id: "identity", done: identity === "web" || botConnected });
  if (mode === "self")
    steps.push({ id: "prepaid", done: signals.redeemCodes > 0 || fundedPlayers > 0 });
  steps.push({ id: "devices", done: machines.length > 0 && unconfigured === 0 });
  if (doorDevices) steps.push({ id: "door", done: ttLockReady });
  steps.push({
    id: "trial",
    done: signals.trialConfirmed || (billing && players.length > 0),
  });
  const configuration = settings.billingConfiguration;
  return {
    mode,
    billing,
    steps,
    complete: steps.every((step) => step.done),
    pricingProblem:
      !billing || !configuration || configuration.ready
        ? null
        : !configuration.balanceAssetsReady
          ? "assets"
          : "entry",
    devices: machines.length,
    unconfigured,
    doorDevices,
    identity,
    identityMatters,
    botIssued: activeBots.length > 0,
    botConnected,
    bindingPrompt: settings.botContact ?? "",
    ttLockReady,
    players: players.length,
    fundedPlayers,
    redeemCodes: signals.redeemCodes,
    reader: signals.reader,
    members: signals.members,
    presents: signals.presents,
    defaultPresent: signals.defaultPresent,
    locationEnabled: settings.locationEnabled,
  };
}
