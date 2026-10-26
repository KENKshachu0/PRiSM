import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import type { Pricing } from "./Pricing";
import { pricingPreview } from "./pricing-preview";
import { pricingInZone } from "./pricing-clock";
import { periodRows } from "../period-rows";
import { planColor } from "../plan-colors";
import { billTime } from "../bill-time";
import { input, money, useMerchant } from "./shared";

export type Segment = {
  ruleId: string;
  label: string;
  startMinute: number;
  endMinute: number;
  startLabel: string;
  endLabel: string;
  isClosed?: boolean;
  startedAt?: string;
  endedAt?: string;
  /** The rule's window this piece belongs to; it can start before or end after the day. */
  windowStartedAt?: string;
  windowEndedAt?: string;
  pricing?: { unitPrice: number; unitMinutes: number; priceCap?: number };
  priceCap?: number;
};
const point = (minute: number, radius: number) => {
  const angle = (minute / 1440) * Math.PI * 2 - Math.PI / 2;
  return [160 + Math.cos(angle) * radius, 160 + Math.sin(angle) * radius];
};
function arc(start: number, end: number) {
  const a = point(start, 109),
    mid = point((start + end) / 2, 109),
    b = point(end, 109);
  // Two arcs also represent a full-day rule without a degenerate SVG endpoint.
  return `M ${a.join(" ")} A 109 109 0 0 1 ${mid.join(" ")} A 109 109 0 0 1 ${b.join(" ")}`;
}
export function PricingRing({
  value,
  onSelect,
  localDate: day,
  onDateChange: setDay,
  timeZone: zoneOverride,
  title = "24 小时计费预览",
  showDate = true,
}: {
  /** Rules in the display zone, as the editor holds them. */
  value: Pricing;
  /** Omitted for a read-only ring: choosing a segment only shows its price. */
  onSelect?: (id: string) => void;
  localDate: string;
  onDateChange: (date: string) => void;
  /** The shop's zone where no merchant context provides it (the player page). */
  timeZone?: string;
  title?: string;
  /** False when one date picker outside drives several rings. */
  showDate?: boolean;
}) {
  const { t } = useI18n();
  const merchant = useMerchant();
  const timeZone = zoneOverride ?? merchant.timeZone;
  const hint = onSelect ? "点击时段编辑规则" : "点击时段查看价格";
  const { segments, error, loading } = useDaySegments(value, day, timeZone);
  const [selected, setSelected] = useState<string | null>(null);
  const color = (s: Segment) =>
    s.isClosed
      ? "#d5d9d7"
      : planColor(
          Math.max(0, value.provider.rules?.findIndex((r) => r.id === s.ruleId) ?? 0),
        );
  function choose(s: Segment) {
    setSelected(s.ruleId);
    if (!s.isClosed) onSelect?.(s.ruleId);
  }
  // The centre shows the chosen period, else the one in force now when the day is today.
  const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const clock = billTime(new Date().toISOString(), zone);
  const [nowHour, nowMinute] = clock.time.split(":").map(Number);
  const minuteNow = (nowHour ?? 0) * 60 + (nowMinute ?? 0);
  const active =
    segments.find((s) => s.ruleId === selected) ??
    (clock.date === day ? segments.find((s) => minuteNow >= s.startMinute && minuteNow < s.endMinute) : undefined);
  // A period through midnight is two arcs but one row, labelled 22:00–10:00.
  const rows = periodRows(segments);
  const activeRow = active ? rows.find((row) => row.pieces.includes(active)) : undefined;
  return (
    <section
      className="grid gap-3 rounded-lg border border-ink/10 bg-ink/[.02] p-4"
      aria-label={t(title)}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{t(title)}</h3>
        </div>
        {showDate && (
          <input
            className={`${input} w-auto`}
            type="date"
            aria-label={t("预览日期")}
            required
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        )}
      </div>
      <div
        className="relative mx-auto w-full max-w-[320px]"
        aria-busy={loading}
      >
        <svg
          viewBox="0 0 320 320"
          className="w-full"
          aria-label={t(hint)}
        >
          <circle
            cx="160"
            cy="160"
            r="109"
            fill="none"
            stroke="#e5e7e5"
            strokeWidth="32"
          />
          {!error &&
            segments.map((s, i) => (
              <path
                key={`${s.ruleId}:${i}`}
                d={arc(s.startMinute, s.endMinute)}
                fill="none"
                stroke={color(s)}
                strokeWidth={active?.ruleId === s.ruleId ? 39 : 32}
                className="cursor-pointer outline-none transition-[stroke-width] focus:stroke-[42px]"
                role="button"
                tabIndex={0}
                aria-label={`${s.startLabel}–${s.endLabel} ${s.label}`}
                aria-pressed={selected === s.ruleId}
                onClick={() => choose(s)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    choose(s);
                  }
                }}
              >
                <title>
                  {s.startLabel}–{s.endLabel} · {s.label}
                </title>
              </path>
            ))}
          {Array.from({ length: 8 }, (_, i) => i * 3).map((hour) => {
            const [x, y] = point(hour * 60, 144);
            return (
              <text
                key={hour}
                x={x}
                y={y}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize="11"
                fill="#7a827e"
              >
                {String(hour).padStart(2, "0")}:00
              </text>
            );
          })}
          {active ? (
            <>
              <text x="160" y="140" textAnchor="middle" fontSize="15" fontWeight="600" fill="currentColor">
                {active.isClosed ? t(onSelect ? "未配置" : "不计费") : active.label.slice(0, 10)}
              </text>
              <text x="160" y="163" textAnchor="middle" fontSize="12" fill="#7a827e">
                {activeRow ? `${activeRow.startLabel}–${activeRow.endLabel}` : `${active.startLabel}–${active.endLabel}`}
              </text>
              <text x="160" y="185" textAnchor="middle" fontSize="12" fill="currentColor">
                {active.pricing
                  ? `${money(active.pricing.unitPrice)} / ${active.pricing.unitMinutes} ${t("分钟")}`
                  : active.priceCap != null
                    ? `${t("封顶")} ${money(active.priceCap)}`
                    : ""}
              </text>
            </>
          ) : (
            <text x="160" y="164" textAnchor="middle" fontSize="12" fill="#7a827e">
              {t(hint)}
            </text>
          )}
        </svg>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-coral">
          {error}
        </p>
      ) : (
        <div className="grid gap-1">
          {rows.map((row, i) => {
            const s = row.pieces[0]!;
            return (
            <button
              type="button"
              key={i}
              className="focus-ring flex min-h-10 items-center gap-2 rounded px-2 py-2 text-left text-xs hover:bg-ink/5"
              onClick={() => choose(s)}
            >
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: color(s) }}
              />
              <span className="tabular-nums text-ink/55">
                {row.startLabel}–{row.endLabel}
              </span>
              <span className="ml-auto truncate">
                {s.isClosed ? t(onSelect ? "未配置" : "不计费") : s.label}
              </span>
              {!s.isClosed && s.pricing && (
                <span className="shrink-0 tabular-nums text-ink/70">
                  {money(s.pricing.unitPrice)} / {s.pricing.unitMinutes} {t("分钟")}
                </span>
              )}
            </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** The day's periods of a plan, in the display zone, gaps included as closed segments. */
export function useDaySegments(value: Pricing, day: string, timeZone: string | undefined) {
  const { segments, error, loading } = usePlansDaySegments([value], day, timeZone);
  return { segments: segments[0] ?? [], error, loading };
}

/** The day's periods of several plans at once, in the order given. */
export function usePlansDaySegments(values: readonly Pricing[], day: string, timeZone: string | undefined) {
  const [segments, setSegments] = useState<Segment[][]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const key = JSON.stringify(values.map((value) => [value.kind, value.provider]));
  useEffect(() => {
    let current = true;
    setLoading(true);
    const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timer = setTimeout(() => {
      void Promise.all(
        values.map((value) =>
          pricingPreview(pricingInZone({ ...value, provider: JSON.parse(JSON.stringify(value.provider)) }, zone, "UTC", day), day, zone, true),
        ),
      )
        .then((timelines) => {
          if (current) {
            setSegments(timelines.map((timeline) => timeline?.segments ?? []));
            setError("");
          }
        })
        .catch((e) => {
          if (current) setError(e.message);
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // `values` is read through `key`, which changes whenever a plan does.
  }, [key, day, timeZone]);
  return { segments, error, loading };
}
