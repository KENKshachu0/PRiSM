import { describe, expect, test } from "bun:test";
import {
  applyLiveFrame,
  idleLive,
  parseLiveFrame,
  type FactsChange,
  type LiveHandlers,
} from "../src/ui/use-resource-live";
import { settleClimate, TEMPERATURE_SETTLE_MS, type ClimateState } from "../src/ui/ClimateControls";

const cooling: ClimateState = {
  mode: "cool", modes: ["off", "cool", "heat"], temperature: 24, currentTemperature: 27,
  minTemperature: 16, maxTemperature: 30, temperatureStep: 1, fanMode: "low", fanModes: ["auto", "low"],
};

function recorder() {
  const log: Array<["facts" | "change", FactsChange] | ["refresh"]> = [];
  const handlers: LiveHandlers = {
    onFacts: (facts) => log.push(["facts", facts]),
    onChange: (change) => log.push(["change", change]),
    onRefresh: () => log.push(["refresh"]),
  };
  return { log, handlers };
}

describe("device page frames", () => {
  test("reads the hub's frames and ignores anything else", () => {
    expect(parseLiveFrame('{"type":"hello","watching":false}')).toEqual({ type: "hello", watching: false });
    expect(parseLiveFrame('{"type":"hello","watching":true,"power":"on","climate":null}'))
      .toEqual({ type: "hello", watching: true, power: "on", climate: null });
    expect(parseLiveFrame('{"type":"watching","watching":true,"power":"off"}')).toEqual({ type: "watching", watching: true, power: "off" });
    expect(parseLiveFrame('{"type":"state","power":"on"}')).toEqual({ type: "state", power: "on" });
    // A key that was not said stays out; one that was said as null means unknown.
    expect(parseLiveFrame('{"type":"state","power":null}')).toEqual({ type: "state", power: null });
    expect(parseLiveFrame('{"type":"state","power":"standby"}')).toEqual({ type: "state", power: null });
    expect(parseLiveFrame('{"type":"state","climate":' + JSON.stringify(cooling) + "}")).toEqual({ type: "state", climate: cooling });
    expect(parseLiveFrame('{"type":"refresh","reason":"binding"}')).toEqual({ type: "refresh", reason: "binding" });
    expect(parseLiveFrame('{"type":"mystery"}')).toBeNull();
    expect(parseLiveFrame("pong")).toBeNull();
    expect(parseLiveFrame("null")).toBeNull();
  });

  test("a greeting says whether the device is pushed, and carries its state only when it is", () => {
    const { log, handlers } = recorder();
    const unwatched = applyLiveFrame(idleLive, { type: "hello", watching: false }, handlers);
    expect(unwatched).toEqual({ connected: true, watching: false, dropped: false });
    expect(log).toEqual([]);
    const watched = applyLiveFrame(unwatched, { type: "watching", watching: true, power: "off", climate: cooling }, handlers);
    expect(watched).toEqual({ connected: true, watching: true, dropped: false });
    expect(log).toEqual([["facts", { power: "off", climate: cooling }]]);
  });

  test("passes on changes only while the device is watched, and says when it stops being", () => {
    const { log, handlers } = recorder();
    const idle = applyLiveFrame(idleLive, { type: "hello", watching: false }, handlers);
    applyLiveFrame(idle, { type: "state", power: "on" }, handlers);
    expect(log).toEqual([]);
    const watched = applyLiveFrame(idle, { type: "watching", watching: true, power: "off" }, handlers);
    applyLiveFrame(watched, { type: "state", power: "on" }, handlers);
    expect(log.at(-1)).toEqual(["change", { power: "on" }]);
    const stopped = applyLiveFrame(watched, { type: "watching", watching: false }, handlers);
    expect(stopped).toEqual({ connected: true, watching: false, dropped: false });
  });

  test("a refresh is passed on whatever the status", () => {
    const { log, handlers } = recorder();
    expect(applyLiveFrame(idleLive, { type: "refresh", reason: "binding" }, handlers)).toBe(idleLive);
    expect(log).toEqual([["refresh"]]);
  });
});

describe("air conditioner settings with nothing pushing the state", () => {
  test("show what was asked once Home Assistant accepted it", () => {
    expect(settleClimate(cooling, "climate.off")?.mode).toBe("off");
    expect(settleClimate({ ...cooling, mode: "off" }, "climate.on")?.mode).toBe("cool");
    expect(settleClimate(cooling, "climate.on")).toBe(cooling);
    expect(settleClimate(cooling, "climate.set_mode", { mode: "heat" })?.mode).toBe("heat");
    expect(settleClimate(cooling, "climate.set_temperature", { temperature: 22 })?.temperature).toBe(22);
    expect(settleClimate(cooling, "climate.set_fan_mode", { fanMode: "auto" })?.fanMode).toBe("auto");
    // The rest of the state is kept as it was.
    expect(settleClimate(cooling, "climate.set_temperature", { temperature: 22 })).toMatchObject({ mode: "cool", currentTemperature: 27 });
  });

  test("leave an unknown state unknown, and ignore an action that sets nothing", () => {
    expect(settleClimate(null, "climate.off")).toBeNull();
    expect(settleClimate(cooling, "climate.set_mode")).toBe(cooling);
    expect(settleClimate(cooling, "climate.set_temperature", { temperature: "cold" })).toBe(cooling);
  });

  test("gather taps on the temperature buttons for a second", () => {
    expect(TEMPERATURE_SETTLE_MS).toBe(1000);
  });
});
