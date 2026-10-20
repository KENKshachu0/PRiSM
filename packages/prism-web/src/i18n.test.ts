import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { resolveLocale, translate, translateError } from "./i18n";
import english from "./locales/en.json";

describe("localization", () => {
  it("negotiates browser preferences with an English fallback", () => {
    expect(resolveLocale(["zh-TW", "en-US"])).toBe("zh");
    expect(resolveLocale(["ja-JP", "en-GB", "zh-CN"])).toBe("en");
    expect(resolveLocale(["ja-JP"])).toBe("en");
    expect(resolveLocale([])).toBe("en");
  });

  it("formats card details without translating card names", () => {
    expect(translate("尾号 {digits}", "en", { digits: "0025" })).toBe("Ending in 0025");
    expect(translate("尾号 {digits}", "zh", { digits: "0025" })).toBe("尾号 0025");
    expect(translate("User's card", "en")).toBe("User's card");
  });

  it("translates errors without changing session expiry classification", () => {
    for (const message of ["本次会话已失效", "缺少会话凭证"]) {
      const error = new ApiError(message, 403);
      for (const locale of ["zh", "en"] as const) {
        expect(translateError(error.message, locale)).toBeTruthy();
        expect(error.sessionExpired).toBe(true);
      }
    }
    expect(new ApiError("请到店再进行登录", 403).sessionExpired).toBe(false);
    expect(translateError("raw upstream diagnostic", "en")).toBe(english["操作失败，请稍后重试"]);
    expect(translateError("toString", "en")).toBe(english["操作失败，请稍后重试"]);
  });

  it("shows the server's notice for a player, never the internal diagnostic", () => {
    const notice = {
      code: "INSUFFICIENT_BALANCE", level: "warning" as const, display: "dialog" as const, flow: "none" as const,
      title: "余额不足", body: "余额不足，请充值后再结账，计费会继续", actions: [],
    };
    const error = new ApiError("余额不足，请充值后再结账，计费会继续", 409, "INSUFFICIENT_BALANCE", undefined, undefined, notice,
      "Insufficient currency holdings for this operation.");
    expect(error.message).toBe(notice.body);
    // Already written for the player in their language: shown as is.
    expect(translateError(error.message, "en")).toBe(notice.body);
    expect(error.sessionExpired).toBe(false);
    // Without a notice, unknown text is still hidden behind the generic line.
    expect(translateError(new ApiError("changed internal diagnostic", 409, "X").message, "zh")).toBe("操作失败，请稍后重试");
  });

  it("treats a notice that says the session ended as expiry", () => {
    const error = new ApiError("x", 410, "SOMETHING", undefined, undefined, {
      code: "SOMETHING", level: "error", display: "none", flow: "expired", title: null, body: "x", actions: [],
    });
    expect(error.sessionExpired).toBe(true);
  });

  it("has English text for every literal translation key in the web UI", () => {
    const missing = new Set<string>();
    for (const name of readdirSync(new URL("./ui/", import.meta.url), { recursive: true })) {
      if (typeof name !== "string" || !name.endsWith(".tsx")) continue;
      const source = readFileSync(new URL(`./ui/${name}`, import.meta.url), "utf8");
      for (const match of source.matchAll(/\bt\(("(?:[^"\\]|\\.)*")/g)) {
        const key = JSON.parse(match[1]!) as string;
        if (!(key in english)) missing.add(key);
      }
    }
    expect([...missing]).toEqual([]);
  });
});
