import { describe, expect, it } from "bun:test";
import { parseIdleSettings, planIdle, RETRY_OFF_MS, type IdleDevice, type IdleInputs } from "../src/devices/idle-power.js";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

const device = (over: Partial<IdleDevice> = {}): IdleDevice => ({
  id: "m1", name: "舞萌", hasPower: true, hasClimate: false, power: "on", climate: null,
  lastActivity: null, poweredOnAt: NOW - 5 * MIN, idle: false, lastAutoOff: null, ...over,
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
    const settings = { shopEmpty: { enabled: true, minutes: 1 }, device: { defaultMinutes: 1, whileOccupied: "off" }, devices: { m1: { exclude: true } } };
    const plan = planIdle(inputs({ settings, emptySince: NOW - 60 * MIN }));
    expect(plan.powerOff).toEqual([]);
    expect(plan.markIdle).toEqual([]);
  });

  it("counts idle time from the later of the last activity and switching on", () => {
    const settings = { device: { defaultMinutes: 30, whileOccupied: "off" } };
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
      const plan = planIdle(inputs({ settings: { device: { defaultMinutes: 30, whileOccupied } }, activeEntries: 2, devices: idle }));
      expect(plan.markIdle).toEqual(["m1"]);
      expect(plan.powerOff).toEqual([...off]);
    }
  });

  it("switches an idle device off when the shop is empty and the shop rule is off", () => {
    const plan = planIdle(inputs({ settings: { device: { defaultMinutes: 30 } }, devices: [device({ poweredOnAt: NOW - 60 * MIN })] }));
    expect(plan.powerOff).toEqual(["m1"]);
  });

  it("uses a device's own idle time, and 0 to keep it out of the device rule", () => {
    const settings = { device: { defaultMinutes: 30, whileOccupied: "off" }, devices: { m1: { minutes: 0 }, m2: { minutes: 5 } } };
    const plan = planIdle(inputs({ settings, activeEntries: 1, devices: [device({ poweredOnAt: NOW - 60 * MIN }), device({ id: "m2", poweredOnAt: NOW - 6 * MIN })] }));
    expect(plan.powerOff).toEqual(["m2"]);
  });

  it("clears the idle mark once there is activity again", () => {
    const plan = planIdle(inputs({ settings: { device: { defaultMinutes: 30 } }, activeEntries: 1, devices: [device({ idle: true, lastActivity: NOW - MIN })] }));
    expect(plan.clearIdle).toEqual(["m1"]);
  });

  it("does not retry a failed automatic power-off right away", () => {
    const settings = { device: { defaultMinutes: 30, whileOccupied: "off" } };
    const plan = planIdle(inputs({ settings, activeEntries: 1, devices: [device({ poweredOnAt: NOW - 60 * MIN, idle: true, lastAutoOff: NOW - MIN })] }));
    expect(plan.powerOff).toEqual([]);
    expect(plan.nextWake).toBe(NOW - MIN + RETRY_OFF_MS);
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
    const mark = planIdle(inputs({ settings: { device: { defaultMinutes: 30, whileOccupied: "mark" } }, activeEntries: 1, devices, reminderLeadMs: 5 * MIN }));
    expect(mark.remind).toEqual([]);
    const remind = planIdle(inputs({ settings: { device: { defaultMinutes: 30, whileOccupied: "remind" } }, activeEntries: 1, devices, reminderLeadMs: 5 * MIN }));
    expect(remind.remind.map((r) => r.reason)).toEqual(["device_idle"]);
  });
});
