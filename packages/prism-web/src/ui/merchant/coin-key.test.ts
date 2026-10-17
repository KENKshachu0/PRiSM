import { describe, expect, it } from "vitest";
import { keyTextFromVk, vkFromKeyText } from "./coin-key";

describe("coin key text", () => {
  it("maps single characters to Virtual-Key codes", () => {
    expect(vkFromKeyText("a")).toBe(65);
    expect(vkFromKeyText("Z")).toBe(90);
    expect(vkFromKeyText("5")).toBe(53);
    expect(vkFromKeyText(" ")).toBe(32);
    expect(vkFromKeyText(";")).toBe(186);
    expect(vkFromKeyText("/")).toBe(191);
  });

  it("accepts named keys and raw codes", () => {
    expect(vkFromKeyText("Enter")).toBe(13);
    expect(vkFromKeyText("space")).toBe(32);
    expect(vkFromKeyText("Tab")).toBe(9);
    expect(vkFromKeyText("13")).toBe(13);
    expect(vkFromKeyText("0")).toBe(48);
  });

  it("rejects text that is not a key", () => {
    expect(vkFromKeyText("")).toBeNull();
    expect(vkFromKeyText("ab")).toBeNull();
    expect(vkFromKeyText("!")).toBeNull();
    expect(vkFromKeyText("99999")).toBeNull();
  });

  it("shows a readable key for a stored code", () => {
    expect(keyTextFromVk(32)).toBe("Space");
    expect(keyTextFromVk(13)).toBe("Enter");
    expect(keyTextFromVk(65)).toBe("a");
    expect(keyTextFromVk(186)).toBe(";");
    expect(keyTextFromVk(0)).toBe("");
    // Unknown keys keep their numeric code so it is not lost.
    expect(keyTextFromVk(112)).toBe("112");
  });
});
