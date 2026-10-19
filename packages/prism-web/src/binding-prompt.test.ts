import { describe, expect, it } from "vitest";
import { bindingPromptLines } from "./binding-prompt";

describe("binding prompt", () => {
  it("uses the standard wording when the shop wrote nothing", () => {
    expect(bindingPromptLines("", "AB23CD45")).toBeNull();
    expect(bindingPromptLines("  \n ", "AB23CD45")).toBeNull();
  });

  it("turns every line holding {code} into the command to copy", () => {
    expect(bindingPromptLines("加入 QQ 群 123456\n在群里发送：\n/绑定 {code}", "AB23CD45")).toEqual([
      { text: "加入 QQ 群 123456", command: false },
      { text: "在群里发送：", command: false },
      { text: "/绑定 AB23CD45", command: true },
    ]);
  });

  it("keeps legacy contact text and adds the standard command after it", () => {
    expect(bindingPromptLines("@arcade_bot", "AB23CD45")).toEqual([
      { text: "@arcade_bot", command: false },
      { text: "bind AB23CD45", command: true },
    ]);
  });
});
