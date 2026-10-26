import { describe, expect, it } from "vitest";
import type { Resource } from "../../api";
import type { Settings } from "../BillingPages";
import {
  identityPolicy,
  identityPolicySettings,
  operatingMode,
  setupStatus,
  type SetupSignals,
} from "./setup-guide";

const machine = (over: Partial<Resource> = {}): Resource => ({
  id: "m1",
  publicId: "p1",
  shopId: "s1",
  shopPublicId: "shop",
  name: "机台",
  aliases: [],
  enabled: true,
  kind: "machine",
  hasHinata: false,
  hinataUrl: null,
  homeAssistant: null,
  ttlockLockId: null,
  mahjong: null,
  coinKey: 0,
  coinAfterSwipe: false,
  relayConnection: "external",
  ...over,
});

const ready = { ready: true, balanceAssetsReady: true, entryPricingReady: true, invalidEntryPricingIds: [] };

const settings = (over: Partial<Settings> = {}): Settings => ({
  billingEnabled: false,
  cashierEnabled: false,
  autoRegister: true,
  identityBindingRequired: true,
  locationEnabled: false,
  checkinGeo: false,
  checkoutGeo: false,
  machineGeo: false,
  entryPricingIds: [],
  botContact: "",
  ...over,
});

const signals = (over: Partial<SetupSignals> = {}): SetupSignals => ({
  settings: settings(),
  machines: [],
  tokens: [],
  ttLock: null,
  players: null,
  redeemCodes: 0,
  reader: null,
  members: 1,
  presents: 0,
  defaultPresent: false,
  trialConfirmed: false,
  ...over,
});

const ids = (status: ReturnType<typeof setupStatus>) => status.steps.map((step) => `${step.id}:${step.done ? "done" : "todo"}`);
const connectedBot = [{ role: "integration", status: "active", lastUsedAt: "2026-10-20T00:00:00Z" }];

describe("setup guide", () => {
  it("maps the two identity switches to the policies and back", () => {
    for (const policy of ["web", "bot", "existing"] as const) {
      expect(identityPolicy({ ...settings(), ...identityPolicySettings(policy) })).toBe(policy);
    }
    expect(identityPolicy(settings({ identityBindingRequired: false, autoRegister: false }))).toBe("web");
  });

  it("reads the operating mode from billing and the front desk", () => {
    expect(operatingMode(settings())).toBe("devices");
    expect(operatingMode(settings({ billingEnabled: true }))).toBe("self");
    expect(operatingMode(settings({ billingEnabled: true, cashierEnabled: true }))).toBe("desk");
  });

  it("asks a device-only shop only for devices and a trial", () => {
    const status = setupStatus(signals());
    expect(status.mode).toBe("devices");
    expect(ids(status)).toEqual(["devices:todo", "trial:todo"]);
  });

  it("asks a device-only shop about identity once a door needs a shop player", () => {
    const status = setupStatus(signals({ machines: [machine({ ttlockLockId: 7 })] }));
    expect(ids(status)).toEqual(["identity:todo", "devices:done", "door:todo", "trial:todo"]);
  });

  it("walks a self-service shop through pricing, identity, prepaid balance, devices and a trial", () => {
    const status = setupStatus(signals({ settings: settings({ billingEnabled: true, billingConfiguration: ready }), players: [] }));
    expect(status.mode).toBe("self");
    expect(ids(status)).toEqual(["pricing:done", "identity:todo", "prepaid:todo", "devices:todo", "trial:todo"]);
  });

  it("counts prepaid balance as ready once a code can be sold or a player holds balance", () => {
    const base = { settings: settings({ billingEnabled: true, billingConfiguration: ready }) };
    const prepaid = (over: Partial<SetupSignals>) => setupStatus(signals({ ...base, ...over })).steps.find((s) => s.id === "prepaid")!.done;
    expect(prepaid({ players: [] })).toBe(false);
    expect(prepaid({ players: [], redeemCodes: 3 })).toBe(true);
    expect(prepaid({ players: [{ walletTotal: 5 }] })).toBe(true);
  });

  it("walks a front-desk shop through the reader and staff instead of prepaid balance", () => {
    const status = setupStatus(signals({
      settings: settings({ billingEnabled: true, cashierEnabled: true, billingConfiguration: ready }),
      players: [],
      reader: false,
    }));
    expect(status.mode).toBe("desk");
    expect(ids(status)).toEqual(["pricing:done", "reader:todo", "staff:todo", "identity:todo", "devices:todo", "trial:todo"]);
    const ready2 = setupStatus(signals({
      settings: settings({ billingEnabled: true, cashierEnabled: true, billingConfiguration: ready }),
      players: [], reader: true, members: 2,
    }));
    expect(ready2.steps.filter((s) => s.id === "reader" || s.id === "staff").every((s) => s.done)).toBe(true);
  });

  it("only counts a bot as connected once it has used its token", () => {
    const base = { settings: settings({ billingEnabled: true }), players: [] };
    const identityDone = (tokens: SetupSignals["tokens"]) =>
      setupStatus(signals({ ...base, tokens })).steps.find((s) => s.id === "identity")!.done;
    expect(identityDone([{ role: "integration", status: "active", lastUsedAt: null }])).toBe(false);
    expect(identityDone(connectedBot)).toBe(true);
    expect(identityDone([{ ...connectedBot[0]!, status: "revoked" }])).toBe(false);
  });

  it("explains why billing is not ready", () => {
    const problem = (balanceAssetsReady: boolean) =>
      setupStatus(signals({
        settings: settings({
          billingEnabled: true,
          billingConfiguration: { ready: false, balanceAssetsReady, entryPricingReady: false, invalidEntryPricingIds: [] },
        }),
      })).pricingProblem;
    expect(problem(false)).toBe("assets");
    expect(problem(true)).toBe("entry");
  });

  it("completes a configured self-service shop once someone has played", () => {
    const status = setupStatus(signals({
      settings: settings({ billingEnabled: true, billingConfiguration: ready }),
      tokens: connectedBot,
      machines: [machine({ homeAssistant: { url: "http://ha", entityId: "switch.a" } })],
      players: [{ walletTotal: 10 }],
    }));
    expect(status.complete).toBe(true);
  });
});
