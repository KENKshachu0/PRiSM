import { describe, expect, it } from "vitest";
import type { Machine } from "../../api";
import type { Settings } from "../BillingPages";
import {
  identityPolicy,
  identityPolicySettings,
  setupStatus,
  type SetupSignals,
} from "./setup-guide";

const machine = (over: Partial<Machine> = {}): Machine => ({
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

const settings = (over: Partial<Settings> = {}): Settings => ({
  billingEnabled: false,
  cashierEnabled: false,
  autoRegister: false,
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
  defaultPresent: false,
  members: 1,
  presents: 0,
  trialConfirmed: false,
  ...over,
});

const ids = (status: ReturnType<typeof setupStatus>) =>
  status.steps.map((step) => `${step.id}:${step.done ? "done" : "todo"}`);

describe("setup guide", () => {
  it("maps the two identity switches to three policies and back", () => {
    for (const policy of ["web", "bot", "existing"] as const) {
      expect(identityPolicy({ ...settings(), ...identityPolicySettings(policy) })).toBe(policy);
    }
    // With binding off the auto-register switch has no effect on admission.
    expect(identityPolicy(settings({ identityBindingRequired: false, autoRegister: false }))).toBe("web");
  });

  it("asks a new device-only shop only for devices and a trial", () => {
    expect(ids(setupStatus(signals()))).toEqual(["devices:todo", "trial:todo"]);
  });

  it("asks a device-only shop about identity once a door or table needs a shop player", () => {
    const status = setupStatus(signals({ machines: [machine({ ttlockLockId: 7 })] }));
    expect(ids(status)).toEqual(["identity:todo", "devices:done", "door:todo", "trial:todo"]);
    expect(status.doorDevices).toBe(1);
  });

  it("flags the default billing shop: binding required with no bot strands new players", () => {
    const status = setupStatus(
      signals({
        settings: settings({
          billingEnabled: true,
          billingConfiguration: { ready: true, balanceAssetsReady: true, entryPricingReady: true, invalidEntryPricingIds: [] },
        }),
        players: [],
      }),
    );
    expect(ids(status)).toEqual([
      "pricing:done",
      "identity:todo",
      "devices:todo",
      "payment:todo",
      "trial:todo",
    ]);
    expect(status.complete).toBe(false);
  });

  it("only counts a bot as connected once it has used its token", () => {
    const base = { settings: settings({ billingEnabled: true }), players: [] };
    const issued = setupStatus(signals({ ...base, tokens: [{ role: "integration", status: "active", lastUsedAt: null }] }));
    expect(issued.botIssued).toBe(true);
    expect(issued.steps.find((s) => s.id === "identity")!.done).toBe(false);
    const used = setupStatus(signals({ ...base, tokens: [{ role: "integration", status: "active", lastUsedAt: "2026-10-20T00:00:00Z" }] }));
    expect(used.steps.find((s) => s.id === "identity")!.done).toBe(true);
    const revoked = setupStatus(signals({ ...base, tokens: [{ role: "integration", status: "revoked", lastUsedAt: "2026-10-20T00:00:00Z" }] }));
    expect(revoked.botConnected).toBe(false);
  });

  it("explains why billing is not ready", () => {
    const status = (balanceAssetsReady: boolean) =>
      setupStatus(signals({
        settings: settings({
          billingEnabled: true,
          billingConfiguration: { ready: false, balanceAssetsReady, entryPricingReady: false, invalidEntryPricingIds: [] },
        }),
      })).pricingProblem;
    expect(status(false)).toBe("assets");
    expect(status(true)).toBe("entry");
  });

  it("completes a configured billing shop once someone has played", () => {
    const status = setupStatus(
      signals({
        settings: settings({
          billingEnabled: true,
          identityBindingRequired: false,
          cashierEnabled: true,
          billingConfiguration: { ready: true, balanceAssetsReady: true, entryPricingReady: true, invalidEntryPricingIds: [] },
        }),
        machines: [machine({ homeAssistant: { url: "http://ha", entityId: "switch.a" } })],
        players: [{ walletTotal: 0 }],
      }),
    );
    expect(status.complete).toBe(true);
  });

  it("keeps devices open while one has no capability", () => {
    const status = setupStatus(signals({ machines: [machine(), machine({ id: "m2", ttlockLockId: 3 })] }));
    expect(status.unconfigured).toBe(1);
    expect(status.steps.find((s) => s.id === "devices")!.done).toBe(false);
  });
});
