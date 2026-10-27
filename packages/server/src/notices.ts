/**
 * What a player is told, and how. One table keyed by error or outcome code, so
 * the wording, its language and whether it interrupts are decided here rather
 * than in each client: a new case needs a server change, not an App Clip review.
 *
 * `display` is the important choice:
 * - `dialog` interrupts. Only for things that went wrong unexpectedly and need
 *   the player to read and act (an iOS alert cannot be dismissed by tapping
 *   outside it, so this must be rare).
 * - `inline` is shown where the player just acted, such as the card row they
 *   tapped. Normal outcomes of a normal flow belong here.
 * - `none` shows nothing; the client only runs `flow`.
 *
 * `flow` names one of a few behaviours every client has built in.
 */
export type NoticeLevel = "success" | "info" | "warning" | "error";
export type NoticeDisplay = "dialog" | "inline" | "none";
/** expired: the QR session is gone, scan again. refresh: reload the page state. signin: sign in again. */
export type NoticeFlow = "none" | "expired" | "refresh" | "signin";
export type NoticeAction = { kind: "dismiss" | "retry"; label: string };

export type Notice = {
  code: string;
  level: NoticeLevel;
  display: NoticeDisplay;
  flow: NoticeFlow;
  title: string | null;
  body: string;
  actions: NoticeAction[];
};

export type Locale = "zh" | "en";

type Text = { zh: string; en: string };
type Entry = {
  body: Text;
  title?: Text;
  level?: NoticeLevel;
  display?: NoticeDisplay;
  flow?: NoticeFlow;
  /** Offer a retry; a client without a way to retry shows only the dismiss button. */
  retry?: boolean;
};

const t = (zh: string, en: string): Text => ({ zh, en });

const CATALOG: Record<string, Entry> = {
  // The page itself moves on; nothing to read.
  TICKET_EXPIRED: { body: t("本次会话已失效，请重新扫码", "This session has ended. Please scan again."), display: "none", flow: "expired" },
  PLATFORM_BINDING_REQUIRED: { body: t("请先绑定平台身份", "Please link your platform account first."), display: "none", flow: "refresh" },
  CHECKIN_REQUIRED: { body: t("请先确认入场", "Please check in first."), display: "none", flow: "refresh" },
  AUTHENTICATION_REQUIRED: { body: t("请先登录", "Please sign in."), display: "none", flow: "signin" },
  UNAUTHORIZED: { body: t("请先登录", "Please sign in."), display: "none", flow: "signin" },

  // Unexpected and needs reading.
  ACCOUNT_BANNED: { title: t("账号已停用", "Account suspended"), body: t("这个账号暂时无法使用，如有疑问请联系店员", "This account cannot be used for now. Please ask the staff.") },
  ACCESS_RESTRICTED: { body: t("当前无法进行此操作，如有疑问请联系店员", "This cannot be done right now. Please ask the staff.") },
  PLAYER_DISABLED: { title: t("无法使用", "Not available"), body: t("你在本店的玩家资格已停用，请联系店员", "Your membership at this shop is suspended. Please ask the staff.") },
  PLAYER_NOT_ACTIVE: { title: t("无法使用", "Not available"), body: t("你在本店的玩家资格已停用，请联系店员", "Your membership at this shop is suspended. Please ask the staff.") },
  INSUFFICIENT_BALANCE: { title: t("余额不足", "Insufficient balance"), body: t("余额不足，请充值后再结账，计费会继续", "Not enough balance. Top up and check out again; billing continues."), level: "warning" },
  DEVICE_UNAVAILABLE: { body: t("设备连接失败，请联系店员", "Could not reach the device. Please ask the staff."), retry: true },
  DEVICE_DISABLED: { body: t("这个资源已停用", "This is disabled.") },
  DEVICE_NOT_FOUND: { body: t("没有找到这个资源", "Not found.") },
  DEVICE_ACTION_UNSUPPORTED: { body: t("这里不支持此操作", "This cannot be done here.") },
  RESOURCE_NOT_BILLED: { body: t("这里不计费，无需确认", "This is free to use; there is nothing to confirm.") },
  LOCATION_REQUIRED: { title: t("需要定位", "Location needed"), body: t("此操作需要获取当前位置，请允许定位", "This needs your location. Please allow location access."), level: "warning", retry: true },

  // Expected in normal use: shown by the control the player touched.
  DEVICE_POWER_OFF: { body: t("请先开机", "Turn the machine on first."), level: "warning", display: "inline" },
  COIN_COOLDOWN: { body: t("请稍后再投币", "Please wait before adding another coin."), level: "info", display: "inline" },
  RATE_LIMITED: { body: t("操作过于频繁，请稍后再试", "Too many attempts. Please wait a moment."), level: "info", display: "inline" },
  OPERATION_PENDING: { body: t("上一次操作还在处理中", "The last request is still being processed."), level: "info", display: "inline" },
  OPERATION_IN_PROGRESS: { body: t("上一次操作还在处理中", "The last request is still being processed."), level: "info", display: "inline" },
  CARD_NOT_FOUND: { body: t("卡片不可用", "Card unavailable."), level: "warning", display: "inline" },
  CHECKIN_CONSENT_REQUIRED: { body: t("请确认入场计费规则", "Please accept the billing rules first."), level: "warning", display: "inline" },
  LOCATION_LOW_ACCURACY: { body: t("定位精度不足，请重试", "Location not precise enough. Retry."), level: "warning", display: "inline" },
  LOCATION_OUT_OF_RANGE: { body: t("不在店铺范围内", "Not within the shop area."), level: "warning", display: "inline" },
  LOCATION_STILL_INSIDE: { body: t("请离开店铺定位范围后再结账", "Please leave the shop before checking out."), level: "warning", display: "inline" },
  REDEEM_CODE_NOT_FOUND: { body: t("兑换码无效", "This code is not valid."), level: "warning", display: "inline" },
  REDEEM_CODE_EXPIRED: { body: t("兑换码已过期", "This code has expired."), level: "warning", display: "inline" },
  PRESENT_NOT_ACTIVE: { body: t("兑换码已失效", "This code is no longer valid."), level: "warning", display: "inline" },
  PRESENT_EXPIRED: { body: t("兑换码已过期", "This code has expired."), level: "warning", display: "inline" },
  PLAYER_HAS_NO_UNSETTLED_SESSIONS: { body: t("没有需要结账的场次", "Nothing to check out."), level: "info", display: "inline" },
  ACTIVE_SESSION_NOT_FOUND: { body: t("没有进行中的场次", "No visit in progress."), level: "info", display: "inline" },
  SESSION_NOT_ACTIVE: { body: t("这个场次已经结束", "This visit has ended."), level: "info", display: "inline" },
  // Why a scanned resource cannot bill now: shown in place of its pricing rules. Each is the shop's to fix.
  PRICING_PLAN_NOT_FOUND: { body: t("这里的计费方案已不存在，请联系店员", "This place's pricing plan no longer exists. Please ask the staff."), level: "warning", display: "inline" },
  PRICING_PLAN_NOT_STARTABLE: { body: t("这里的计费方案不能用来计时，请联系店员", "This place's pricing plan cannot time a visit. Please ask the staff."), level: "warning", display: "inline" },
  PRICING_REQUIREMENT_UNAVAILABLE: { body: t("这里依赖的计费方案已停用，请联系店员", "A pricing plan this place depends on is disabled. Please ask the staff."), level: "warning", display: "inline" },
  PRICING_RELATION_UNKNOWN_TARGET: { body: t("这里依赖的计费方案已不存在，请联系店员", "A pricing plan this place depends on no longer exists. Please ask the staff."), level: "warning", display: "inline" },
  PRICING_RELATION_CONTRADICTION: { body: t("这里的计费方案设置互相冲突，请联系店员", "This place's pricing plans conflict with each other. Please ask the staff."), level: "warning", display: "inline" },
  PRICING_RELATION_CYCLE: { body: t("这里的计费方案设置互相依赖成环，请联系店员", "This place's pricing plans depend on each other in a loop. Please ask the staff."), level: "warning", display: "inline" },

  // Outcomes of a swipe, sent with a successful response and shown on the card
  // row, one short part each. The coin after a swipe is a side effect: whatever
  // happens to it, it never interrupts the swipe.
  CARD_NOT_READ: { body: t("登录失败", "Sign-in failed"), level: "warning", display: "inline" },
  CARD_SENT: { body: t("已刷卡", "Card sent"), level: "success", display: "inline" },
  COIN_SENT: { body: t("已投币", "Coin added"), level: "success", display: "inline" },
  COIN_SKIPPED: { body: t("投币冷却中", "Coin cooling down"), level: "info", display: "inline" },
  COIN_FAILED: { body: t("投币失败", "Coin failed"), level: "warning", display: "inline" },
  COIN_UNKNOWN: { body: t("投币未确认", "Coin not confirmed"), level: "warning", display: "inline" },
  DOOR_CODE_FAILED: { body: t("开门密码获取失败，请重试", "Could not get the door code. Retry."), level: "warning", display: "inline" },
};

const GENERIC: Entry = { body: t("操作失败，请稍后重试", "Something went wrong. Please try again."), retry: true };
const DISMISS: Text = t("知道了", "OK");
const RETRY: Text = t("重试", "Retry");
const CJK = /[\u3400-\u9fff]/;

/** The player's language from `Accept-Language`; Chinese unless English comes first. */
export function requestLocale(header: string | null | undefined): Locale {
  const first = (header ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("en") ? "en" : "zh";
}

export function hasNotice(code: string): boolean {
  return Object.hasOwn(CATALOG, code);
}

function build(code: string, entry: Entry, locale: Locale, body?: string): Notice {
  const display = entry.display ?? "dialog";
  return {
    code,
    level: entry.level ?? "error",
    display,
    flow: entry.flow ?? "none",
    title: entry.title?.[locale] ?? null,
    body: body ?? entry.body[locale],
    actions: display === "dialog"
      ? [{ kind: "dismiss", label: DISMISS[locale] }, ...(entry.retry ? [{ kind: "retry" as const, label: RETRY[locale] }] : [])]
      : [],
  };
}

/** A notice for a known code, e.g. a swipe outcome. */
export function notice(code: string, locale: Locale): Notice {
  return build(code, CATALOG[code] ?? GENERIC, locale);
}

/**
 * The notice for an error response. A known code uses the table. Otherwise a
 * message already written for players (Chinese text from a route) is kept and
 * shown inline, since a route rejects what the player just tried by rule; a
 * case that must interrupt goes in the table. Anything else — a developer
 * message, a server fault — becomes the generic text, so internal wording
 * never reaches a player.
 */
export function errorNotice(input: { code: string; message: string; status: number }, locale: Locale): Notice {
  const entry = CATALOG[input.code];
  if (entry) return build(input.code, entry, locale);
  if (input.status < 500 && CJK.test(input.message)) return build(input.code, { body: t(input.message, input.message), level: "warning", display: "inline" }, locale);
  return build(input.code, GENERIC, locale);
}
