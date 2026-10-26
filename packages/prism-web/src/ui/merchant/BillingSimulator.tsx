import { parseLocalDateTime } from "@prism/core";
import { useRef, useState, type FormEvent } from "react";
import { useI18n } from "../../i18n";
import { BillTimeline, BillTotal } from "../BillTimeline";
import { displayDateTime } from "../bill-time";
import { Field, button, input, primary, useMerchant, useStaffApi } from "./shared";
import type { Pricing } from "./Pricing";

type DraftSession = {
  id: string;
  startedAt: string;
  endedAt: string;
  pricingConfigId: string;
};

type SimulatedBill = {
  admissionAt: string;
  departureAt: string;
  subtotal: number;
  total: number;
  timeline: import("@prism/core").BillTimeline;
};

const blankSession = (): DraftSession => ({
  id: crypto.randomUUID(),
  startedAt: "",
  endedAt: "",
  pricingConfigId: "",
});

function toInstant(value: string, timeZone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    throw new Error("请选择有效的 Session 日期与时间");
  }
  const parsed = parseLocalDateTime(value.slice(0, 10), value.slice(11, 16), timeZone);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Session 日期与时间无效");
  return parsed.toISOString();
}

export function BillingSimulator({ pricingConfigs }: { pricingConfigs: Pricing[] }) {
  const { t } = useI18n();
  const { timeZone } = useMerchant();
  const request = useStaffApi();
  const zone = timeZone || "UTC";
  const plans = pricingConfigs.filter(config => config.enabled && config.status !== "archived" && config.kind !== "time.cap");
  const caps = pricingConfigs.filter(config => config.enabled && config.status !== "archived" && config.kind === "time.cap");
  const [sessions, setSessions] = useState<DraftSession[]>([blankSession()]);
  const [result, setResult] = useState<SimulatedBill | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  function changeSessions(next: DraftSession[]) {
    generation.current++;
    setSessions(next);
    setBusy(false);
    setResult(null);
    setError("");
  }

  async function simulate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = ++generation.current;
    setBusy(true);
    setResult(null);
    setError("");
    try {
      const response = await request<SimulatedBill>("pricing-configs/simulate/preview", "POST", {
        sessions: sessions.map(row => ({
          startedAt: toInstant(row.startedAt, zone),
          endedAt: toInstant(row.endedAt, zone),
          pricingConfigId: row.pricingConfigId,
        })),
      });
      if (generation.current === current) setResult(response);
    } catch (cause) {
      if (generation.current === current) setError(cause instanceof Error ? cause.message : "模拟失败");
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }

  return (
    <section className="grid gap-4" aria-label={t("计费模拟器")}>
      <div className="grid gap-1">
        <p className="text-sm text-ink/60">
          {t("逐行填写 Session 的开启时间、关闭时间和计费方案；最早开启为入场时间，最晚关闭为退场时间。Session 可以重叠。")}
        </p>
        <p className="text-xs text-ink/60">
          {t("时间使用店铺时区")}：{zone}。{t("按当前启用的计费规则和全局封顶模拟，不包含余额、优惠券及既往消费历史；不会生成真实账单。")}
        </p>
        {!!caps.length && <p className="text-xs text-ink/60">
          {t("自动参与计算的跨方案封顶")}：{caps.map(cap => cap.name).join("、")}
        </p>}
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div className="grid gap-4 rounded-xl border border-ink/10 bg-panel p-4">
      <form className="grid gap-4" onSubmit={simulate}>
        {sessions.map((session, index) => (
          <fieldset key={session.id} className="grid gap-3 rounded-xl border border-ink/10 p-4">
            <legend className="px-1 text-sm font-semibold">Session {index + 1}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="开启时间">
                <input className={input} type="datetime-local" step="60" required
                  value={session.startedAt}
                  onChange={event => changeSessions(sessions.map(row => row.id === session.id ? { ...row, startedAt: event.target.value } : row))} />
              </Field>
              <Field label="关闭时间">
                <input className={input} type="datetime-local" step="60" required
                  value={session.endedAt}
                  onChange={event => changeSessions(sessions.map(row => row.id === session.id ? { ...row, endedAt: event.target.value } : row))} />
              </Field>
              <div className="sm:col-span-2">
                <Field label="计费方案">
                  <select className={input} required value={session.pricingConfigId}
                    onChange={event => changeSessions(sessions.map(row => row.id === session.id ? { ...row, pricingConfigId: event.target.value } : row))}>
                    <option value="">{t("选择方案")}</option>
                    {plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
                  </select>
                </Field>
              </div>
            </div>
            {sessions.length > 1 && <button type="button" className={button + " justify-self-end"}
              onClick={() => changeSessions(sessions.filter(row => row.id !== session.id))}>
              {t("移除 Session")}
            </button>}
          </fieldset>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={button} disabled={sessions.length >= 30}
            onClick={() => changeSessions([...sessions, blankSession()])}>
            {t("添加 Session")}
          </button>
          <button type="submit" className={primary} disabled={busy || !plans.length}>
            {t(busy ? "计算中…" : "生成模拟账单")}
          </button>
        </div>
        {!plans.length && <p role="alert" className="text-sm text-coral">{t("请先启用至少一个计费方案。")}</p>}
        {error && <p role="alert" className="text-sm text-coral">{error}</p>}
      </form>
      </div>
      <section className="grid min-w-0 gap-4 rounded-xl border border-ink/10 bg-panel p-4" aria-live="polite" aria-label={t("模拟账单时间轴")}>
      {!result && (
        <p className="rounded-xl border border-dashed border-ink/20 px-4 py-10 text-center text-sm text-ink/50">
          {t("填写左侧的 Session，生成模拟账单。")}
        </p>
      )}
      {result && <div className="grid gap-4">
        <h4 className="font-semibold">{t("模拟账单时间轴")}</h4>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-ink/60">{t("入场时间")}</dt><dd>{displayDateTime(result.admissionAt, zone)}</dd></div>
          <div><dt className="text-ink/60">{t("退场时间")}</dt><dd>{displayDateTime(result.departureAt, zone)}</dd></div>
        </dl>
        <BillTotal preview={{ settlementPreview: { total: result.total }, timeline: result.timeline, chargeItems: [], adjustments: [] }} />
        <BillTimeline preview={{ settlementPreview: { total: result.total }, timeline: result.timeline, chargeItems: [], adjustments: [] }} timeZone={zone} />
      </div>}
      </section>
      </div>
    </section>
  );
}
