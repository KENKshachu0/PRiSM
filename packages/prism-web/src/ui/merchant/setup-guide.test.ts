import { describe, expect, it } from "vitest";
import type { Resource } from "../../api";
import type { Settings } from "../BillingPages";
import {
  identityPolicy,
  identityPolicySettings,
  operatingMode,
  setupStatus,
  shopBills,
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
  billing: false,
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
    expect(operatingMode({ billing: false, cashierEnabled: false })).toBe("devices");
    expect(operatingMode({ billing: true, cashierEnabled: false })).toBe("self");
    expect(operatingMode({ billing: true, cashierEnabled: true })).toBe("desk");
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
    const status = setupStatus(signals({ billing: true, settings: settings({ billingConfiguration: ready }), players: [] }));
    expect(status.mode).toBe("self");
    expect(ids(status)).toEqual(["pricing:done", "identity:todo", "prepaid:todo", "devices:todo", "trial:todo"]);
  });

  it("counts prepaid balance as ready once a code can be sold or a player holds balance", () => {
    const base = { billing: true, settings: settings({ billingConfiguration: ready }) };
    const prepaid = (over: Partial<SetupSignals>) => setupStatus(signals({ ...base, ...over })).steps.find((s) => s.id === "prepaid")!.done;
    expect(prepaid({ players: [] })).toBe(false);
    expect(prepaid({ players: [], redeemCodes: 3 })).toBe(true);
    expect(prepaid({ players: [{ walletTotal: 5 }] })).toBe(true);
  });

  it("walks a front-desk shop through the reader and staff instead of prepaid balance", () => {
    const status = setupStatus(signals({
      billing: true, settings: settings({ cashierEnabled: true, billingConfiguration: ready }),
      players: [],
      reader: false,
    }));
    expect(status.mode).toBe("desk");
    expect(ids(status)).toEqual(["pricing:done", "reader:todo", "staff:todo", "identity:todo", "devices:todo", "trial:todo"]);
    const ready2 = setupStatus(signals({
      billing: true, settings: settings({ cashierEnabled: true, billingConfiguration: ready }),
      players: [], reader: true, members: 2,
    }));
    expect(ready2.steps.filter((s) => s.id === "reader" || s.id === "staff").every((s) => s.done)).toBe(true);
  });

  it("only counts a bot as connected once it has used its token", () => {
    const base = { billing: true, settings: settings(), players: [] };
    const identityDone = (tokens: SetupSignals["tokens"]) =>
      setupStatus(signals({ ...base, tokens })).steps.find((s) => s.id === "identity")!.done;
    expect(identityDone([{ role: "integration", status: "active", lastUsedAt: null }])).toBe(false);
    expect(identityDone(connectedBot)).toBe(true);
    expect(identityDone([{ ...connectedBot[0]!, status: "revoked" }])).toBe(false);
  });

  it("explains why billing is not ready", () => {
    const problem = (balanceAssetsReady: boolean, invalidEntryPricingIds: string[] = []) =>
      setupStatus(signals({
        billing: true,
        settings: settings({
          billingConfiguration: { ready: false, balanceAssetsReady, entryPricingReady: false, invalidEntryPricingIds },
        }),
      })).pricingProblem;
    expect(problem(false)).toBe("assets");
    expect(problem(true, ["archived-plan"])).toBe("entry");
    // A free default group is fine while another group bills.
    expect(problem(true)).toBeNull();
  });

  it("bills wherever a group or a resource has a plan, with no shop-wide switch", () => {
    const free = { defaultPricingConfigId: null };
    expect(shopBills([free], [machine()])).toBe(false);
    expect(shopBills([free, { defaultPricingConfigId: "night" }], [])).toBe(true);
    expect(shopBills([free], [machine({ pricingConfigOverrideId: "vip" })])).toBe(true);
  });

  it("completes a configured self-service shop once someone has played", () => {
    const status = setupStatus(signals({
      billing: true, settings: settings({ billingConfiguration: ready }),
      tokens: connectedBot,
      machines: [machine({ homeAssistant: { url: "http://ha", entityId: "switch.a" } })],
      players: [{ walletTotal: 10 }],
    }));
    expect(status.complete).toBe(true);
  });
});
