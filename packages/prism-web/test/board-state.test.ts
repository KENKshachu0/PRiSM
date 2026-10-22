import { describe, expect, test } from "bun:test";
import {
  applyBoardFrame,
  hasUnwatched,
  learnBoardState,
  mergeBoardStates,
  parseBoardFrame,
  type BoardState,
  type BoardStates,
} from "../src/ui/merchant/board-state";

const nothing: BoardState = { watching: false, power: null, climate: null };
const watched = (power: "on" | "off"): BoardState => ({ watching: true, power, climate: null });
const found = (power: "on" | "off"): BoardState => ({ watching: false, power, climate: null });
const cooling = {
  mode: "cool", modes: ["off", "cool"], temperature: 24, currentTemperature: 27, minTemperature: 16,
  maxTemperature: 30, temperatureStep: 1, fanMode: "low", fanModes: ["auto", "low"],
};

describe("what the board shows of a device", () => {
  test("a live device takes what it is given", () => {
    expect(learnBoardState(found("on"), watched("off"))).toEqual(watched("off"));
    expect(learnBoardState(undefined, watched("on"))).toEqual(watched("on"));
  });

  test("a device with no state of its own keeps what it last showed, however old", () => {
    expect(learnBoardState(found("on"), nothing)).toEqual(found("on"));
    // It was live and stopped: the last pushed value stays, and only the tag changes.
    expect(learnBoardState(watched("on"), nothing)).toEqual(found("on"));
  });

  test("a read fills in what it learned and keeps the rest", () => {
    const before: BoardState = { watching: false, power: "on", climate: cooling };
    expect(learnBoardState(before, { watching: false, power: null, climate: { ...cooling, temperature: 22 } }))
      .toEqual({ watching: false, power: "on", climate: { ...cooling, temperature: 22 } });
    expect(learnBoardState(before, { watching: false, power: "off", climate: null })).toEqual({ watching: false, power: "off", climate: cooling });
  });

  test("only what has never been read is empty", () => {
    expect(learnBoardState(undefined, nothing)).toEqual(nothing);
    expect(learnBoardState(nothing, nothing)).toEqual(nothing);
    expect(learnBoardState(nothing, found("off"))).toEqual(found("off"));
  });
});

describe("device board states", () => {
  test("a read fills what has no state of its own and leaves a live device as the hub keeps it", () => {
    // The read's copy of a live device is only what the database held when it was read.
    const previous: BoardStates = { a: watched("on"), b: found("on"), c: nothing };
    const next: BoardStates = { a: watched("off"), b: found("off"), c: found("on") };
    expect(mergeBoardStates(next, previous)).toEqual({ a: watched("on"), b: found("off"), c: found("on") });
  });

  test("a read that could learn nothing leaves the last value in place", () => {
    expect(mergeBoardStates({ a: nothing }, { a: found("on") })).toEqual({ a: found("on") });
    // A device that stopped being live keeps its last pushed value.
    expect(mergeBoardStates({ a: nothing }, { a: watched("on") })).toEqual({ a: found("on") });
  });

  test("a read takes a device that has become live, and everything when the board has nothing yet", () => {
    expect(mergeBoardStates({ a: watched("on") }, { a: found("off") })).toEqual({ a: watched("on") });
    expect(mergeBoardStates({ a: found("on") }, null)).toEqual({ a: found("on") });
  });

  test("a device new to the board, and a device that left", () => {
    expect(mergeBoardStates({ a: found("on"), n: nothing }, { a: found("on") })).toEqual({ a: found("on"), n: nothing });
    expect(mergeBoardStates({ a: nothing }, { a: found("on"), gone: found("off") })).toEqual({ a: found("on") });
  });

  test("says whether anything has no state of its own", () => {
    expect(hasUnwatched(null)).toBe(false);
    expect(hasUnwatched({})).toBe(false);
    expect(hasUnwatched({ a: watched("on"), b: watched("off") })).toBe(false);
    expect(hasUnwatched({ a: watched("on"), b: nothing })).toBe(true);
  });
});

describe("device board frames", () => {
  test("reads the hub's frames and ignores anything else", () => {
    expect(parseBoardFrame(JSON.stringify({ type: "states", states: { a: { watching: true, power: "on", climate: null }, b: { watching: false, power: null, climate: null } } })))
      .toEqual({ type: "states", states: { a: watched("on"), b: nothing } });
    expect(parseBoardFrame('{"type":"state","deviceId":"a","power":"off"}')).toEqual({ type: "state", deviceId: "a", power: "off" });
    // A key that was not said stays out; one that was said as null means unknown.
    expect(parseBoardFrame('{"type":"state","deviceId":"a","power":null}')).toEqual({ type: "state", deviceId: "a", power: null });
    expect(parseBoardFrame('{"type":"state","deviceId":"a","power":"standby"}')).toEqual({ type: "state", deviceId: "a", power: null });
    expect(parseBoardFrame(JSON.stringify({ type: "state", deviceId: "a", climate: cooling }))).toEqual({ type: "state", deviceId: "a", climate: cooling });
    expect(parseBoardFrame('{"type":"state","deviceId":"a","climate":null}')).toEqual({ type: "state", deviceId: "a", climate: null });
    expect(parseBoardFrame('{"type":"state","power":"on"}')).toBeNull();
    expect(parseBoardFrame('{"type":"states","states":"nope"}')).toBeNull();
    expect(parseBoardFrame('{"type":"hello"}')).toBeNull();
    expect(parseBoardFrame("pong")).toBeNull();
    expect(parseBoardFrame("null")).toBeNull();
  });

  test("a change goes onto the device it names, and only what it says", () => {
    const board: BoardStates = { a: { watching: true, power: "on", climate: cooling }, b: watched("off") };
    expect(applyBoardFrame(board, { type: "state", deviceId: "a", climate: { ...cooling, currentTemperature: 28 } }))
      .toEqual({ a: { watching: true, power: "on", climate: { ...cooling, currentTemperature: 28 } }, b: watched("off") });
    expect(applyBoardFrame(board, { type: "state", deviceId: "a", power: null }))
      .toEqual({ a: { watching: true, power: null, climate: cooling }, b: watched("off") });
    expect(applyBoardFrame(board, { type: "state", deviceId: "b", power: "on" })).toEqual({ a: board.a, b: watched("on") });
  });

  test("a change for a device the board does not have, or before it has any state, changes nothing", () => {
    const board: BoardStates = { a: watched("off") };
    expect(applyBoardFrame(board, { type: "state", deviceId: "missing", power: "on" })).toBe(board);
    expect(applyBoardFrame(null, { type: "state", deviceId: "a", power: "on" })).toBeNull();
  });

  test("the whole shop from the hub says which devices are live, and nothing that was known goes back to unknown", () => {
    const board: BoardStates = { a: watched("on"), b: found("on") };
    // Connection a stopped being watched, b stays as it was, c is new.
    const next = applyBoardFrame(board, { type: "states", states: { a: nothing, b: nothing, c: watched("off") } });
    expect(next).toEqual({ a: found("on"), b: found("on"), c: watched("off") });
    expect(applyBoardFrame(null, { type: "states", states: { a: watched("on") } })).toEqual({ a: watched("on") });
  });

  test("who is watching is not about any device, so it leaves the device states alone", () => {
    const board: BoardStates = { a: watched("on") };
    expect(applyBoardFrame(board, { type: "watchers", limit: 2, max: 4, watchers: [], standby: 0 })).toBe(board);
    expect(applyBoardFrame(null, { type: "watchers", limit: 2, max: 4, watchers: [], standby: 0 })).toBeNull();
  });
});

describe("the hub's word on who is watching", () => {
  test("reads each watcher by kind and how far it has got", () => {
    const frame = parseBoardFrame(JSON.stringify({
      type: "watchers",
      limit: 2,
      max: 4,
      standby: 1,
      watchers: [
        { id: "bot:1", kind: "bot", name: "前台", state: "watching" },
        { id: "m1", kind: "device", deviceId: "m1", state: "unreachable" },
      ],
    }));
    expect(frame).toEqual({
      type: "watchers",
      limit: 2,
      max: 4,
      standby: 1,
      watchers: [
        { id: "bot:1", kind: "bot", name: "前台", state: "watching" },
        { id: "m1", kind: "device", deviceId: "m1", state: "unreachable" },
      ],
    });
  });

  test("an empty list is an answer: nobody is watching", () => {
    expect(parseBoardFrame('{"type":"watchers","limit":2,"max":4,"watchers":[],"standby":0}'))
      .toEqual({ type: "watchers", limit: 2, max: 4, watchers: [], standby: 0 });
  });

  test("a state it does not know reads as starting, a bot without a name as Bot, and a malformed entry is skipped", () => {
    const frame = parseBoardFrame(JSON.stringify({
      type: "watchers",
      limit: 1,
      watchers: [
        { id: "bot:1", kind: "bot", state: "somewhere" },
        { id: "x", kind: "device", state: "watching" },
        { kind: "bot", name: "no id", state: "watching" },
        { id: "y", kind: "toaster", state: "watching" },
        "nonsense",
      ],
    }));
    expect(frame).toEqual({
      type: "watchers",
      limit: 1,
      // Without a bound from the hub, the board offers no more than what is set.
      max: 1,
      standby: 0,
      watchers: [{ id: "bot:1", kind: "bot", name: "Bot", state: "starting" }],
    });
  });

  test("a frame without a number of slots or a list is not one", () => {
    expect(parseBoardFrame('{"type":"watchers","watchers":[]}')).toBeNull();
    expect(parseBoardFrame('{"type":"watchers","limit":2}')).toBeNull();
  });
});
