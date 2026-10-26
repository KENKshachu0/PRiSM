import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { billTime } from "./bill-time";
import { usePlansDaySegments, type Segment } from "./merchant/PricingRing";
import { pricingInZone } from "./merchant/pricing-clock";
import type { Pricing } from "./merchant/Pricing";
import { money } from "./merchant/shared";
import { periodRows, type PeriodRow } from "./period-rows";
import { planColor } from "./plan-colors";

/** How far a cap is used up now, as the server counted it. */
export type CapProgressView = {
  pricingConfigId: string;
  ruleId: string;
  ruleLabel: string;
  priceCap: number;
  paidBefore: number;
  /** The window the cap is counting now. */
  startsAt: string;
  endsAt: string;
};

type SharedCapView = CapProgressView & { name: string; includedPricingConfigIds: string[]; config: Pricing };

/** The plans a scanned resource bills, as the server resolved them for this player. */
export type ResourceRules = {
  source: { kind: "resource" | "group" | "default"; groupName?: string };
  plans: { config: Pricing; role: "resource" | "required"; requiredBy?: string }[];
  /**
   * Read before confirming: the player's unsettled bill so far, each plan's cap
   * for the period it is in (none for an uncapped period), and the caps across plans.
   */
  caps?: { unsettled: number; plans: CapProgressView[]; shared: SharedCapView[] };
  /** The shop's zone; rules are stored in UTC. */
  timeZone: string;
};

type PlanChange = { planId: string; planName: string };
type Translate = (key: string) => string;

const DAY = 1440;

/**
 * What scanning this resource charges today, read before confirming: one card
 * of lanes on a shared 0–24 axis. Each plan is a strip of its periods with
 * their prices in it, each cap across plans a strip of its windows filled as
 * far as the current one is used up. A lane states its current period in one
 * line; tapping a piece states that one instead.
 */
export function ResourcePricing({
  rules,
  changes,
}: {
  rules: ResourceRules;
  /** What confirming starts, ends and keeps. */
  changes?: { started: PlanChange[]; stopped: PlanChange[]; kept: PlanChange[] };
}) {
  const { t } = useI18n();
  const zone = rules.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = billTime(new Date().toISOString(), zone);
  const [hour, minute] = now.time.split(":").map(Number);
  const nowMinute = (hour ?? 0) * 60 + (minute ?? 0);
  const plans = useMemo(
    () => rules.plans.map((plan) => pricingInZone(plan.config, plan.config.provider.timeZone ?? "UTC", zone, now.date)),
    [rules.plans, zone, now.date],
  );
  const shared = rules.caps?.shared ?? [];
  const capConfigs = useMemo(
    () => shared.map((cap) => pricingInZone(cap.config, cap.config.provider.timeZone ?? "UTC", zone, now.date)),
    [shared, zone, now.date],
  );
  const { segments, error, loading } = usePlansDaySegments([...plans, ...capConfigs], now.date, zone);
  const change = (planId: string) =>
    changes?.started.some((item) => item.planId === planId) ? "新增" : changes?.kept.some((item) => item.planId === planId) ? "保留" : null;
  const unsettled = rules.caps?.unsettled ?? 0;
  return (
    <section className="grid gap-3 text-left" aria-label={t("计费规则")} aria-busy={loading}>
      {error && <p role="alert" className="text-sm text-coral">{error}</p>}
      <div className="grid gap-5 rounded-2xl bg-ink/[0.04] p-4">
        {plans.map((plan, index) => (
          <PlanLane
            key={plan.id}
            plan={plan}
            tag={change(plan.id)}
            color={planColor(index)}
            segments={segments[index] ?? []}
            nowMinute={nowMinute}
            caps={rules.caps?.plans.filter((cap) => cap.pricingConfigId === plan.id) ?? []}
          />
        ))}
        {shared.length > 0 && (
          <div className="grid gap-4 border-t border-ink/10 pt-3">
            <h3 className="-mb-2 text-xs text-ink/50">{t("跨方案封顶")}</h3>
            {shared.map((cap, index) => (
              <CapLane key={cap.pricingConfigId} cap={cap} segments={segments[plans.length + index] ?? []} nowMinute={nowMinute} />
            ))}
          </div>
        )}
        <Axis />
        {(!!changes?.stopped.length || unsettled > 0) && (
          <div className="grid gap-2 border-t border-ink/10 pt-3 text-sm">
            {!!changes?.stopped.length && (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-ink/60">{t("结束方案")}</span>
                <span className="truncate">{changes.stopped.map((item) => item.planName).join("、")}</span>
              </div>
            )}
            {unsettled > 0 && (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-ink/60">{t("已计")}</span>
                <span className="font-semibold tabular-nums">{money(unsettled)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** One plan: name and price, its day with each period's price in it, and the stated period in a line. */
function PlanLane({
  plan,
  tag,
  color,
  segments,
  nowMinute,
  caps,
}: {
  plan: Pricing;
  tag: string | null;
  color: string;
  segments: Segment[];
  nowMinute: number;
  caps: CapProgressView[];
}) {
  const { t } = useI18n();
  const rows = periodRows(segments);
  const { row, pick, picked } = usePickedRow(rows, nowMinute);
  const title = (
    <>
      <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} aria-hidden="true" />
      <span className="truncate font-semibold">{plan.name}</span>
      {tag && <span className="shrink-0 rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] font-normal text-ink/60">{t(tag)}</span>}
    </>
  );
  // A fixed charge has no day to draw: it is billed once for the visit.
  if (plan.kind === "charge.fixed") {
    return (
      <div className="grid gap-2">
        <LaneHeader title={title} value={money(plan.provider.amount ?? 0)} />
        <p className="text-xs text-ink/55">{t("单次收取")}</p>
      </div>
    );
  }
  const first = row?.pieces[0];
  const cap = first && isNow(row, nowMinute) ? caps.find((item) => item.ruleId === first.ruleId) : undefined;
  // Dearer periods are drawn stronger; tapping a piece gives its price.
  const rate = (s: Segment) => (s.isClosed || !s.pricing ? 0 : Math.abs(s.pricing.unitPrice / Math.max(1, s.pricing.unitMinutes)));
  const top = Math.max(0, ...segments.map(rate));
  const tone = (s: Segment): CSSProperties =>
    s.isClosed ? { background: "rgb(var(--color-ink) / .1)" } : { background: color, opacity: top > 0 ? 0.55 + 0.45 * (rate(s) / top) ** 2 : 1 };
  return (
    <div className="grid gap-2">
      <LaneHeader title={title} value={first ? priceText(first, t) : ""} />
      <Strip
        segments={segments}
        rows={rows}
        nowMinute={nowMinute}
        height="h-2.5"
        accent={color}
        tone={tone}
        picked={picked}
        pick={pick}
      />
      {row && first && (
        <p className="truncate text-xs text-ink/55">
          {first.isClosed ? t("不计费") : first.label} {row.startLabel}–{row.endLabel}
          {cap
            ? ` · ${capText(cap, t)}`
            : !first.isClosed && (first.pricing?.priceCap ?? 0) > 0
              ? ` · ${t("封顶")} ${money(first.pricing!.priceCap)}`
              : ""}
        </p>
      )}
    </div>
  );
}

/** One cap across plans: its windows over the day, the current one filled as far as it is used up. */
function CapLane({ cap, segments, nowMinute }: { cap: SharedCapView; segments: Segment[]; nowMinute: number }) {
  const { t } = useI18n();
  const rows = periodRows(segments);
  const { row, pick, picked } = usePickedRow(rows, nowMinute);
  const first = row?.pieces[0];
  const inWindow = (s: Segment) => !!s.windowStartedAt && Date.parse(s.windowStartedAt) === Date.parse(cap.startsAt);
  const counting = segments.filter(inWindow);
  // The window's spending fills its pieces from the left, across a split if it has one.
  let left = (cap.priceCap > 0 ? Math.min(1, cap.paidBefore / cap.priceCap) : 1)
    * counting.reduce((sum, s) => sum + (s.endMinute - s.startMinute), 0);
  const filled = new Map(
    counting.map((s) => {
      const length = s.endMinute - s.startMinute;
      const part = Math.min(length, left);
      left -= part;
      return [s, length > 0 ? part / length : 0] as const;
    }),
  );
  const counted = !!row && row.pieces.some(inWindow);
  return (
    <div className="grid gap-2">
      <LaneHeader
        title={<span className="truncate font-semibold">{cap.name}</span>}
        value={first ? (counted ? capText(cap, t) : first.isClosed ? t("不封顶") : `${t("封顶")} ${money(first.priceCap ?? 0)}`) : ""}
        quiet
      />
      <Strip
        segments={segments}
        rows={rows}
        nowMinute={nowMinute}
        height="h-1.5"
        accent="var(--color-mint)"
        tone={(s) => ({ background: s.isClosed ? "transparent" : "rgb(var(--color-ink) / .12)" })}
        fill={(s) => filled.get(s) ?? 0}
        picked={picked}
        pick={pick}
      />
      {row && first && (
        <p className="truncate text-xs text-ink/55">
          {first.isClosed ? t("不封顶") : first.label} {row.startLabel}–{row.endLabel}
        </p>
      )}
    </div>
  );
}

function LaneHeader({ title, value, quiet = false }: { title: ReactNode; value: string; quiet?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="flex min-w-0 items-center gap-2">{title}</span>
      <span className={`shrink-0 tabular-nums ${quiet ? "text-xs" : "font-semibold"}`}>{value}</span>
    </div>
  );
}

/**
 * The day from 0 to 24 as pieces, one per period window: a period through
 * midnight is two pieces of the same colour. Tapping a piece picks its period.
 */
function Strip({
  segments,
  rows,
  nowMinute,
  height,
  accent,
  tone,
  fill,
  picked,
  pick,
}: {
  segments: Segment[];
  rows: PeriodRow[];
  nowMinute: number;
  height: string;
  /** The lane's colour, which rims the knob marking now. */
  accent: string;
  tone: (s: Segment) => CSSProperties;
  fill?: (s: Segment) => number;
  picked: PeriodRow | null;
  pick: (row: PeriodRow) => void;
}) {
  return (
    <div className={`relative flex ${height} gap-0.5`}>
      {segments.map((s, i) => {
        const row = rows.find((candidate) => candidate.pieces.includes(s));
        const minutes = s.endMinute - s.startMinute;
        return (
          <button
            key={i}
            type="button"
            className={`relative min-w-0 overflow-hidden rounded-full outline-offset-2 ${picked && row === picked ? "outline outline-2 outline-ink/60" : ""}`}
            style={{ flex: `${minutes} 1 0` }}
            aria-label={`${row?.startLabel ?? s.startLabel}–${row?.endLabel ?? s.endLabel} ${s.label}`}
            onClick={() => row && pick(row)}
          >
            <span className="absolute inset-0" style={tone(s)} />
            {fill && fill(s) > 0 && (
              <span className="absolute inset-y-0 left-0" style={{ width: `${fill(s) * 100}%`, background: "var(--color-mint)" }} />
            )}
          </button>
        );
      })}
      <span
        className="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-panel shadow-[0_1px_3px_rgb(0_0_0/.3)]"
        style={{ left: `${(nowMinute / DAY) * 100}%`, borderColor: accent }}
        aria-hidden="true"
      />
    </div>
  );
}

function Axis() {
  return (
    <div className="relative -mt-2 h-3.5 text-[10px] tabular-nums text-ink/45" aria-hidden="true">
      {[0, 6, 12, 18, 24].map((h) => (
        <span
          key={h}
          className={`absolute ${h === 0 ? "" : h === 24 ? "-translate-x-full" : "-translate-x-1/2"}`}
          style={{ left: `${(h / 24) * 100}%` }}
        >
          {h}
        </span>
      ))}
    </div>
  );
}

/** The period a lane states: the one tapped, else the one in force now. */
function usePickedRow(rows: PeriodRow[], nowMinute: number) {
  const [picked, setPicked] = useState<{ start: number; ruleId: string } | null>(null);
  const tapped = picked
    ? rows.find((row) => row.pieces[0]!.startMinute === picked.start && row.pieces[0]!.ruleId === picked.ruleId) ?? null
    : null;
  const row = tapped ?? rows.find((candidate) => isNow(candidate, nowMinute)) ?? null;
  const pick = (next: PeriodRow) => {
    // Tapping the picked or the current period goes back to now.
    setPicked(next === tapped || isNow(next, nowMinute) ? null : { start: next.pieces[0]!.startMinute, ruleId: next.pieces[0]!.ruleId });
  };
  return { row, pick, picked: tapped };
}

function isNow(row: PeriodRow | null | undefined, nowMinute: number) {
  return !!row?.pieces.some((s) => nowMinute >= s.startMinute && nowMinute < s.endMinute);
}

function capText(cap: CapProgressView, t: Translate) {
  return cap.paidBefore >= cap.priceCap
    ? `${t("已达封顶")} ${money(cap.priceCap)}`
    : `${t("已计")} ${money(cap.paidBefore)} / ${t("封顶")} ${money(cap.priceCap)}`;
}

function priceText(s: Segment, t: Translate) {
  return s.isClosed
    ? t("不计费")
    : s.pricing
      ? `${money(s.pricing.unitPrice)} / ${s.pricing.unitMinutes} ${t("分钟")}`
      : s.priceCap != null
        ? `${t("封顶")} ${money(s.priceCap)}`
        : s.label;
}
