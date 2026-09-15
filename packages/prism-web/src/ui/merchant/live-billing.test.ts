import { expect, test } from "bun:test";
import { liveBilling, stayDuration } from "./live-billing";
import type { LivePlayer } from "./shared";

test("live grouping uses active sessions, preserves multiple plans and distinguishes unknown estimates", () => {
  const session: LivePlayer["sessions"][number] = {
    id: "s", startedAt: "2026-09-11T14:00:00Z", endedAt: null, status: "active", elapsedMinutes: 472, currentImpact: 40,
    pricingCharges: [{ pricingConfigId: "night", planName: "夜场", ruleLabel: "夜间", amount: 40 }], pricingSegments: [],
  };
  const player: LivePlayer = { playerId: "p", displayName: "玩家", status: "active", walletTotal: 50, estimatedTotal: 40,
    stayDurationMinutes: 472, sessions: [session], globalCapWindows: [] };
  expect(stayDuration(472)).toBe("7:52");
  expect(stayDuration(1501)).toBe("25:01");
  expect(liveBilling(player).status).toBe("计费中");
  expect(liveBilling({ ...player, walletTotal: 6 }).status).toBe("余额不足");
  expect(liveBilling({ ...player, estimatedTotal: null }).status).toBe("预估暂不可用");
  expect(liveBilling({ ...player, sessions: [{ ...session, status: "closed" }] })).toEqual({ status: "待结账", planKey: "[]", plans: [] });
  const other = { ...session, id: "table", pricingCharges: [{ pricingConfigId: "table", planName: "麻将", ruleLabel: "日间", amount: 10 }] };
  const bill = liveBilling({ ...player, sessions: [session, other] });
  expect(bill.plans).toHaveLength(2);
  expect(bill.planKey).toBe(liveBilling({ ...player, sessions: [other, session] }).planKey);
});
