import {
  createPricingProviderFromConfig,
  isApiInstant,
  previewSessionSettlement,
  PrismDomainError,
  yuanOf,
  type BillTimeline,
  type ChargeItem,
  type PricingConfig,
  type Session,
} from "@prism/core";
import { buildBillTimeline } from "./bill-timeline";
import { capProviderConfig, capTimePlanIds } from "./versioned-pricing";
import { settleSessionsWithCaps } from "./session-billing";

export type BillingSimulationSession = {
  startedAt: string;
  endedAt: string;
  pricingConfigId: string;
};

export type BillingSimulationResult = {
  admissionAt: string;
  departureAt: string;
  subtotal: number;
  total: number;
  timeline: BillTimeline;
};

/**
 * Stateless, read-only quote using the same session pricing providers and
 * cross-session cap rules as the real unified checkout. No player, holdings,
 * historical paid amounts or database writes are involved.
 */
export async function simulateBilling(input: {
  sessions: readonly BillingSimulationSession[];
  pricingConfigs: readonly PricingConfig[];
  timeZone?: string;
}): Promise<BillingSimulationResult> {
  if (!Array.isArray(input.sessions) || input.sessions.length < 1 || input.sessions.length > 30) {
    throw new PrismDomainError("请输入 1 至 30 条 Session。", "INVALID_SIMULATION_SESSIONS");
  }
  const enabled = input.pricingConfigs.filter(config => config.enabled && config.status !== "archived");
  const plans = new Map(enabled.filter(config => config.kind !== "time.cap").map(config => [config.id, config]));
  const rows = input.sessions.map((row, index) => {
    if (!row || !isApiInstant(row.startedAt) || !isApiInstant(row.endedAt)) {
      throw new PrismDomainError("Session 时间必须包含时区偏移。", "INVALID_SIMULATION_TIME");
    }
    const startedAt = new Date(row.startedAt);
    const endedAt = new Date(row.endedAt);
    if (endedAt <= startedAt) {
      throw new PrismDomainError("Session 结束时间必须晚于开始时间。", "INVALID_SIMULATION_RANGE");
    }
    const plan = plans.get(row.pricingConfigId);
    if (!plan) {
      throw new PrismDomainError("计费方案不存在、已禁用或属于全局封顶。", "INVALID_SIMULATION_PLAN");
    }
    return { index, startedAt, endedAt, plan };
  });
  const admission = new Date(Math.min(...rows.map(row => row.startedAt.getTime())));
  const departure = new Date(Math.max(...rows.map(row => row.endedAt.getTime())));
  if (departure.getTime() - admission.getTime() > 31 * 86_400_000) {
    throw new PrismDomainError("模拟的入场至退场时间不能超过 31 天。", "SIMULATION_RANGE_TOO_LONG");
  }

  const timelineSessions: Array<{
    sessionId: string;
    label: string;
    startedAt: Date;
    endedAt: Date;
    chargeItems: ChargeItem[];
  }> = [];
  for (const row of rows) {
    const session: Session = {
      id: "simulation-session-" + (row.index + 1),
      playerId: "billing-simulation",
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      status: "closed",
      paymentStatus: "unpaid",
      pricingConfigIds: [row.plan.id],
      label: row.plan.name,
    };
    // The live checkout quotes each session separately, then applies global caps
    // across all their charge items. Keep that ordering and rounding behavior.
    const preview = await previewSessionSettlement({
      session,
      pricingProviders: [createPricingProviderFromConfig(row.plan.kind === "time.priority"
        ? { ...row.plan, provider: { ...row.plan.provider, paidHistory: {} } }
        : row.plan)],
      assetHoldings: [],
      now: departure,
    });
    timelineSessions.push({
      sessionId: session.id,
      label: row.plan.name,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      chargeItems: preview.chargeItems,
    });
  }

  // The same settlement checkout uses: a cap counts every time plan, not the
  // list it stores (which is empty), and the total is capped quote minus held-back.
  const timeZone = input.timeZone ?? "UTC";
  const timePlanIds = capTimePlanIds(enabled);
  const settled = settleSessionsWithCaps({
    sessions: timelineSessions,
    caps: enabled.flatMap(config => config.kind === "time.cap"
      ? [capProviderConfig(config, config.provider.timeZone ?? timeZone, timePlanIds)]
      : []),
  });
  const { chargeItems: charges, windows: capWindows, adjustments: capAdjustments, subtotal } = settled;
  const total = settled.total;
  return {
    admissionAt: admission.toISOString(),
    departureAt: departure.toISOString(),
    subtotal: yuanOf(subtotal),
    total: yuanOf(total),
    timeline: buildBillTimeline({
      at: departure,
      timeZone: input.timeZone,
      planNames: new Map(enabled.map(config => [config.id, config.name])),
      sessions: timelineSessions,
      adjustments: capAdjustments,
      globalCapWindows: capWindows,
    }),
  };
}
