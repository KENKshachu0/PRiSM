import { describe, expect, it } from "bun:test";
import { parseIdleSettings, planIdle, RETRY_OFF_MS, type IdleDevice, type IdleInputs } from "../src/resources/capabilities/idle-power.js";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

const device = (over: Partial<IdleDevice> = {}): IdleDevice => ({
  // 20 minutes busy after a sign of someone, then the shop's default 10 minutes free.
  id: "m1", name: "舞萌", minutes: 20, hasPower: true, hasClimate: false, power: "on", climate: null,
  lastActivity: null, busyUntil: null, poweredOnAt: NOW - 5 * MIN, idle: false, lastAutoOff: null, ...over,
});
const inputs = (over: Omit<Partial<IdleInputs>, "settings"> & { settings?: unknown } = {}): IdleInputs => ({
  now: NOW, activeEntries: 0, emptySince: null, emptyHandled: null, devices: [device()],
  reminderLeadMs: null, reminded: {}, ...over, settings: parseIdleSettings(over.settings ?? {}),
});

describe("idle power planning", () => {
  it("does nothing until the shop turns a rule on", () => {
    const plan = planIdle(inputs({ emptySince: NOW - 60 * MIN }));
    expect(plan).toMatchObject({ powerOff: [], climateOff: [], markIdle: [], nextWake: null });
  });

  it("switches everything off, air conditioners included, once the shop has been empty long enough", () => {
    const settings = { shopEmpty: { enabled: true, minutes: 15 } };
    const devices = [device(), device({ id: "ac", hasPower: false, hasClimate: true, power: null, climate: "cool" }), device({ id: "off", power: "off" })];
    const early = planIdle(inputs({ settings, devices, emptySince: NOW - 10 * MIN }));
    expect(early.powerOff).toEqual([]);
    expect(early.nextWake).toBe(NOW + 5 * MIN);
    const due = planIdle(inputs({ settings, devices, emptySince: NOW - 15 * MIN }));
    expect(due.powerOff).toEqual(["m1"]);
    expect(due.climateOff).toEqual(["ac"]);
    // It runs once per empty period.
    expect(planIdle(inputs({ settings, devices, emptySince: NOW - 15 * MIN, emptyHandled: due.emptyHandled })).powerOff).toEqual([]);
  });

  it("never touches an excluded device", () => {
    const settings = { shopEmpty: { enabled: true, minutes: 1 }, device: { enabled: true, whileOccupied: "off" }, devices: { m1: { exclude: true } } };
    const plan = planIdle(inputs({ settings, emptySince: NOW - 60 * MIN }));
    expect(plan.powerOff).toEqual([]);
    expect(plan.markIdle).toEqual([]);
  });

  it("counts idle time from the later of the last activity and switching on", () => {
    const settings = { device: { enabled: true, whileOccupied: "off" } };
    const fresh = planIdle(inputs({ settings, activeEntries: 1, devices: [device({ poweredOnAt: NOW - 40 * MIN, lastActivity: NOW - 20 * MIN })] }));
    expect(fresh.powerOff).toEqual([]);
    expect(fresh.nextWake).toBe(NOW + 10 * MIN);
    const stale = planIdle(inputs({ settings, activeEntries: 1, devices: [device({ poweredOnAt: NOW - 40 * MIN, lastActivity: NOW - 31 * MIN })] }));
    expect(stale.powerOff).toEqual(["m1"]);
    expect(stale.markIdle).toEqual(["m1"]);
  });

  it("follows the owner's choice while players are in", () => {
    const idle = [device({ poweredOnAt: NOW - 60 * MIN })];
    for (const [whileOccupied, off] of [["mark", []], ["remind", []], ["off", ["m1"]]] as const) {
      const plan = planIdle(inputs({ settings: { device: { enabled: true, whileOccupied } }, activeEntries: 2, devices: idle }));
      expect(plan.markIdle).toEqual(["m1"]);
      expect(plan.powerOff).toEqual([...off]);
    }
  });

  it("switches an idle device off when the shop is empty and the shop rule is off", () => {
    const plan = planIdle(inputs({ settings: { device: { enabled: true } }, devices: [device({ poweredOnAt: NOW - 60 * MIN })] }));
    expect(plan.powerOff).toEqual(["m1"]);
  });

  it("waits each device's occupancy time, then the shop's idle time, and leaves out a device never switched off", () => {
    const settings = { device: { enabled: true, minutes: 1, whileOccupied: "off" }, devices: { m1: { exclude: true } } };
    const plan = planIdle(inputs({ settings, activeEntries: 1, devices: [device({ poweredOnAt: NOW - 60 * MIN }), device({ id: "m2", minutes: 5, poweredOnAt: NOW - 6 * MIN })] }));
    expect(plan.powerOff).toEqual(["m2"]);
  });

  it("never idles a device while someone occupies it", () => {
    const settings = { device: { enabled: true, whileOccupied: "off" } };
    const stale = { poweredOnAt: NOW - 60 * MIN, lastActivity: NOW - 40 * MIN };
    // An occupant whose stay runs on keeps it busy until then.
    const held = planIdle(inputs({ settings, activeEntries: 1, devices: [device({ ...stale, busyUntil: NOW + 3 * MIN })] }));
    // Free in 3 minutes, idle 10 minutes after that.
    expect(held).toMatchObject({ powerOff: [], markIdle: [], nextWake: NOW + 13 * MIN });
    // A seat has no expiry.
    expect(planIdle(inputs({ settings, activeEntries: 1, devices: [device({ ...stale, busyUntil: Infinity })] })).powerOff).toEqual([]);
    expect(planIdle(inputs({ settings, activeEntries: 1, devices: [device(stale)] })).powerOff).toEqual(["m1"]);
  });

  it("reads a device idle time from before idle times moved onto resources as the rule being on", () => {
    expect(parseIdleSettings({ device: { defaultMinutes: 20, whileOccupied: "remind" } }).device).toEqual({ enabled: true, minutes: 20, whileOccupied: "remind" });
    expect(parseIdleSettings({ device: { defaultMinutes: 0 } }).device.enabled).toBe(false);
  });

  it("clears the idle mark once there is activity again", () => {
    const plan = planIdle(inputs({ settings: { device: { enabled: true } }, activeEntries: 1, devices: [device({ idle: true, lastActivity: NOW - MIN })] }));
    expect(plan.clearIdle).toEqual(["m1"]);
  });

  it("does not retry a failed automatic power-off right away", () => {
    const settings = { device: { enabled: true, whileOccupied: "off" } };
    const plan = planIdle(inputs({ settings, activeEntries: 1, devices: [device({ poweredOnAt: NOW - 60 * MIN, idle: true, lastAutoOff: NOW - MIN })] }));
    expect(plan.powerOff).toEqual([]);
    expect(plan.nextWake).toBe(NOW - MIN + RETRY_OFF_MS);
  });

  it("switches a device off without knowing its state, as an unknown one may be on", () => {
    const settings = { shopEmpty: { enabled: true, minutes: 15 } };
    const devices = [
      device({ power: null }),
      device({ id: "ac", hasPower: false, hasClimate: true, power: null, climate: null }),
      device({ id: "known-off", power: "off" }),
    ];
    const due = planIdle(inputs({ settings, devices, emptySince: NOW - 15 * MIN }));
    expect(due.powerOff).toEqual(["m1"]);
    expect(due.climateOff).toEqual(["ac"]);
  });

  it("judges a device of unknown state only by its own activity, and switches it off once per stretch of idleness", () => {
    const settings = { device: { enabled: true, whileOccupied: "off" } };
    const blind = (over: Partial<IdleDevice>) => planIdle(inputs({ settings, activeEntries: 1, devices: [device({ power: null, poweredOnAt: null, ...over })] }));
    // No activity at all: nothing to count from.
    expect(blind({}).powerOff).toEqual([]);
    expect(blind({ lastActivity: NOW - 20 * MIN })).toMatchObject({ powerOff: [], nextWake: NOW + 10 * MIN });
    expect(blind({ lastActivity: NOW - 31 * MIN }).powerOff).toEqual(["m1"]);
    // Already switched off since that activity: nothing shows whether it took, so it is left alone.
    const handled = blind({ lastActivity: NOW - 31 * MIN, lastAutoOff: NOW - 11 * MIN });
    expect(handled.powerOff).toEqual([]);
    // Fresh activity after the last switch-off starts a new stretch.
    expect(blind({ lastActivity: NOW - 31 * MIN, lastAutoOff: NOW - 40 * MIN }).powerOff).toEqual(["m1"]);
  });

  it("reminds the bot once, its lead time before the power-off", () => {
    const settings = { shopEmpty: { enabled: true, minutes: 15 } };
    const before = planIdle(inputs({ settings, emptySince: NOW - 5 * MIN, reminderLeadMs: 5 * MIN }));
    expect(before.remind).toEqual([]);
    expect(before.nextWake).toBe(NOW + 5 * MIN);
    const due = planIdle(inputs({ settings, emptySince: NOW - 11 * MIN, reminderLeadMs: 5 * MIN }));
    expect(due.remind).toEqual([{ key: `empty:${NOW - 11 * MIN}`, reason: "shop_empty", deviceIds: ["m1"], at: NOW + 4 * MIN }]);
    const again = planIdle(inputs({ settings, emptySince: NOW - 11 * MIN, reminderLeadMs: 5 * MIN, reminded: { [due.remind[0]!.key]: due.remind[0]!.at } }));
    expect(again.remind).toEqual([]);
  });

  it("only reminds about a device going off while occupied when the owner chose to", () => {
    const devices = [device({ poweredOnAt: NOW - 28 * MIN })];
    const mark = planIdle(inputs({ settings: { device: { enabled: true, whileOccupied: "mark" } }, activeEntries: 1, devices, reminderLeadMs: 5 * MIN }));
    expect(mark.remind).toEqual([]);
    const remind = planIdle(inputs({ settings: { device: { enabled: true, whileOccupied: "remind" } }, activeEntries: 1, devices, reminderLeadMs: 5 * MIN }));
    expect(remind.remind.map((r) => r.reason)).toEqual(["device_idle"]);
  });
});
