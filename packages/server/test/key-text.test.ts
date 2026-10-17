import { describe, expect, it } from "bun:test";
import { vkFromKeyText } from "../src/devices/key-text.js";

describe("coin key text", () => {
  it("maps a typed key to its Virtual-Key code", () => {
    expect(vkFromKeyText("a")).toBe(65);
    expect(vkFromKeyText("Z")).toBe(90);
    expect(vkFromKeyText("5")).toBe(53);
    expect(vkFromKeyText(" ")).toBe(32);
    expect(vkFromKeyText("Enter")).toBe(13);
    expect(vkFromKeyText(";")).toBe(186);
  });

  it("still accepts a raw key code", () => {
    expect(vkFromKeyText("32")).toBe(32);
  });

  it("rejects what the protocol cannot press", () => {
    expect(vkFromKeyText("")).toBeNull();
    expect(vkFromKeyText("ab")).toBeNull();
    expect(vkFromKeyText("!")).toBeNull();
    expect(vkFromKeyText("99999")).toBeNull();
  });
});
