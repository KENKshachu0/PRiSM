import { describe, expect, it } from "bun:test";
import { errorNotice, notice, requestLocale } from "../src/notices.js";
import { wrapApiResponse } from "../src/middleware/response-time.js";

describe("player notices", () => {
  it("picks English only when the player's first language is English", () => {
    expect(requestLocale("en-US,en;q=0.9,zh-CN;q=0.8")).toBe("en");
    expect(requestLocale("zh-Hans-CN;q=1, en-US;q=0.9")).toBe("zh");
    expect(requestLocale(undefined)).toBe("zh");
  });

  it("interrupts only for what went wrong, and keeps normal outcomes inline", () => {
    expect(notice("CARD_NOT_READ", "zh")).toMatchObject({ display: "inline", level: "warning", body: "登录失败", actions: [] });
    for (const code of ["COIN_FAILED", "COIN_UNKNOWN", "COIN_SKIPPED"]) expect(notice(code, "zh").display).toBe("inline");
    expect(errorNotice({ code: "COIN_COOLDOWN", message: "请稍后再投币", status: 429 }, "zh").display).toBe("inline");
    const banned = errorNotice({ code: "ACCOUNT_BANNED", message: "这个账号暂时无法使用", status: 403 }, "zh");
    expect(banned).toMatchObject({ display: "dialog", level: "error", title: "账号已停用" });
    expect(banned.actions).toEqual([{ kind: "dismiss", label: "知道了" }]);
  });

  it("lets the client move on by itself where there is nothing to read", () => {
    expect(errorNotice({ code: "TICKET_EXPIRED", message: "本次会话已失效", status: 410 }, "zh")).toMatchObject({ display: "none", flow: "expired" });
    expect(errorNotice({ code: "CHECKIN_REQUIRED", message: "请先确认入场", status: 403 }, "zh")).toMatchObject({ display: "none", flow: "refresh" });
  });

  it("offers a retry only where trying again can help", () => {
    const device = errorNotice({ code: "DEVICE_UNAVAILABLE", message: "设备连接失败", status: 502 }, "en");
    expect(device.actions.map((action) => action.kind)).toEqual(["dismiss", "retry"]);
    // A weak fix is retried by tapping again, right where the player is.
    const location = errorNotice({ code: "LOCATION_LOW_ACCURACY", message: "定位精度不足，请重试", status: 403 }, "en");
    expect(location).toMatchObject({ display: "inline", actions: [], body: "Location not precise enough. Retry." });
  });

  it("keeps a route's own Chinese wording but never shows developer text or faults", () => {
    expect(errorNotice({ code: "SOMETHING_NEW", message: "请先在后台开通", status: 409 }, "zh")).toMatchObject({ body: "请先在后台开通", display: "inline" });
    expect(errorNotice({ code: "REDEEM_THING", message: "Redeem code batch exhausted.", status: 400 }, "zh").body).toBe("操作失败，请稍后重试");
    expect(errorNotice({ code: "INTERNAL_ERROR", message: "数据库超时", status: 500 }, "zh").body).toBe("操作失败，请稍后重试");
  });

  it("is attached to every wrapped error, with the player text also in message", async () => {
    const wrapped = await wrapApiResponse(
      Response.json({ error: { code: "INSUFFICIENT_BALANCE", message: "Insufficient currency holdings for this operation." } }, { status: 409 }),
      "UTC",
      "zh",
    );
    const body = (await wrapped.json()) as { error: { code: string; message: string; reason?: string; notice: { body: string; title: string } } };
    expect(body.error.code).toBe("INSUFFICIENT_BALANCE");
    expect(body.error.message).toBe(body.error.notice.body);
    expect(body.error.notice.title).toBe("余额不足");
    expect(body.error.reason).toBe("Insufficient currency holdings for this operation.");
  });
});
