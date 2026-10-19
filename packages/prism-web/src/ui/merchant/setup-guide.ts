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
  defaultPresent: boolean;
  members: number;
  presents: number;
  /** The owner said they printed the codes and tried one; nothing records it. */
  trialConfirmed: boolean;
};

export type SetupStepId =
  | "pricing"
  | "identity"
  | "devices"
  | "door"
  | "payment"
  | "trial";

export type SetupStep = { id: SetupStepId; done: boolean };

export type SetupStatus = {
  billing: boolean;
  steps: SetupStep[];
  /** Why billing is not ready: no balance asset, or no usable entry rule. */
  pricingProblem: "assets" | "entry" | null;
  complete: boolean;
  devices: number;
  unconfigured: number;
  doorDevices: number;
  identity: IdentityPolicy;
  botIssued: boolean;
  botConnected: boolean;
  ttLockReady: boolean;
  players: number;
  members: number;
  presents: number;
};

/**
 * Derive the shop's setup checklist from data the admin already reads. Only
 * the steps that block real players are listed: a billing shop needs an entry
 * rule, a way for players to pay and an identity policy that does not strand
 * them; door locks need the shop's TTLock account; every shop needs devices
 * whose QR codes are on the machines.
 */
export function setupStatus(signals: SetupSignals): SetupStatus {
  const { settings, machines } = signals;
  const billing = settings.billingEnabled;
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
  // Devices only gate on identity where the server asks for a shop player:
  // every billed device, and doors and mahjong tables everywhere.
  const identityMatters = billing || caps.some((c) => c.door || c.mahjong);
  const players = signals.players ?? [];
  const steps: SetupStep[] = [];
  if (billing)
    steps.push({ id: "pricing", done: !!settings.billingConfiguration?.ready });
  if (identityMatters)
    steps.push({ id: "identity", done: identity === "web" || botConnected });
  steps.push({ id: "devices", done: machines.length > 0 && unconfigured === 0 });
  if (doorDevices) steps.push({ id: "door", done: ttLockReady });
  if (billing)
    steps.push({
      id: "payment",
      done:
        settings.cashierEnabled ||
        signals.defaultPresent ||
        players.some((player) => player.walletTotal > 0),
    });
  steps.push({
    id: "trial",
    done: signals.trialConfirmed || (billing && players.length > 0),
  });
  const configuration = settings.billingConfiguration;
  return {
    billing,
    steps,
    pricingProblem:
      !billing || !configuration || configuration.ready
        ? null
        : !configuration.balanceAssetsReady
          ? "assets"
          : "entry",
    complete: steps.every((step) => step.done),
    devices: machines.length,
    unconfigured,
    doorDevices,
    identity,
    botIssued: activeBots.length > 0,
    botConnected,
    ttLockReady,
    players: players.length,
    members: signals.members,
    presents: signals.presents,
  };
}
