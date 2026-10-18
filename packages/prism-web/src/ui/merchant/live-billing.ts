import type { LivePlayer } from "./shared";

export function liveBilling(player: LivePlayer) {
  // A row can arrive without sessions (or without charges) while the live
  // payload is still filling in; the status must not throw on that.
  const sessions = player.sessions ?? [];
  const active = sessions.filter(session => session.status === "active");
  const plans = new Map(active.flatMap(session => (session.pricingCharges ?? []).map(charge => [charge.pricingConfigId, charge.planName] as const)));
  const status = player.estimatedTotal === null ? (player.quoteState === "loading" ? "正在加载" : "预估暂不可用")
    : player.paymentMode === "cashier" ? (active.length ? "前台计时中" : "前台待收款")
    : player.walletTotal < player.estimatedTotal ? "余额不足"
    : active.length ? "计费中" : "待结账";
  return { status, planKey: JSON.stringify([...plans.keys()].sort()), plans: [...plans.values()].sort() };
}

export function stayDuration(minutes: number) {
  const value = Math.max(0, Math.floor(minutes));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}
