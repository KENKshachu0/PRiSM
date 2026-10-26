import type { BillTimeline as Timeline, BillTimelineEntry } from "@prism/core";
import type { CSSProperties } from "react";
import { useI18n } from "../i18n";
import { billTime } from "./bill-time";
import { planColor } from "./plan-colors";

export type BillPreview = {
  settlementPreview: { total: number };
  timeline?: Timeline;
  chargeItems: { label: string; amount: number }[];
  adjustments: { label: string; amount: number }[];
};

type Track = Timeline["tracks"][number];

const dotted: CSSProperties = { background: "none", width: 0, borderLeft: "3px dotted currentColor" };
const cappedAt = (track: Track, at: number) => (track.capped ?? []).some((span) => at >= Date.parse(span.startedAt) && at < Date.parse(span.endedAt));

/** The total, with the key to the bill under it. */
export function BillTotal({ preview }: { preview: BillPreview }) {
  const { t } = useI18n();
  return (
    <div className="bill-total">
      <span>{t("合计")}</span>
      <strong>{preview.settlementPreview.total.toFixed(2)}</strong>
      <BillLegend timeline={preview.timeline} />
    </div>
  );
}

/**
 * The key to a bill, shown under its total wherever the bill is: a solid rail
 * charges, a dotted one is capped. Only a bill with a dotted rail needs it.
 */
export function BillLegend({ timeline }: { timeline?: Timeline }) {
  const { t } = useI18n();
  const anyCapped = (timeline?.tracks ?? []).some((track) => (track.capped ?? []).length > 0);
  if (!anyCapped) return null;
  return (
    <div className="mt-3 flex gap-5 text-xs text-ink/60" aria-label={t("图例")}>
      <span className="inline-flex items-center gap-2"><i aria-hidden="true" className="h-3 w-[3px] rounded-full bg-ink/60" />{t("计费")}</span>
      <span className="inline-flex items-center gap-2"><i aria-hidden="true" className="h-3 border-l-[3px] border-dotted border-ink/60" />{t("封顶中")}</span>
    </div>
  );
}

const headings: Partial<Record<BillTimelineEntry["kind"], string>> = {
  current: "现在", end: "结束计费", start: "开始计费", switch: "切换计费规则", over: "封顶结束",
};
const headingOrder: BillTimelineEntry["kind"][] = ["current", "end", "start", "switch", "over"];

/**
 * The bill as one rail per plan. Every point on a rail ends the stretch below
 * it: a stretch that charged is a card at its end with what it charged; a stretch
 * a full cap kept from charging is dotted. The date is written once a day, on its
 * first event.
 */
export function BillTimeline({ preview, timeZone }: { preview: BillPreview; timeZone?: string }) {
  const { t } = useI18n();
  const timeline = preview.timeline;
  if (!timeline) return <div>{[...preview.chargeItems, ...preview.adjustments].map((row, i) => <div className="account-row" key={i}><span>{row.label}</span><span className={row.amount < 0 ? "bill-negative" : ""}>{row.amount.toFixed(2)}</span></div>)}</div>;
  const dateOf = (at: string) => billTime(at, timeZone).date;
  const dateLabel = (at: string) => new Date(`${dateOf(at)}T12:00:00Z`).toLocaleDateString([], { timeZone: "UTC", month: "short", day: "numeric" });
  const lanes = Math.max(1, ...timeline.tracks.map(track => track.lane + 1));
  const colorOfTrack = (trackId: string | null) => planColor(timeline.tracks.find(track => track.id === trackId)?.color ?? 0);
  const events = timeline.events;
  return <div className="bill-timeline">{events.map((event, index) => {
    const newer = events[index - 1]?.at;
    const older = events[index + 1]?.at;
    const at = Date.parse(event.at);
    const kinds = new Set(event.entries.map(entry => entry.kind));
    const heading = headingOrder.find(kind => kinds.has(kind));
    const marked = new Set(event.entries.flatMap(entry => entry.kind === "full" && entry.trackId == null ? entry.trackIds ?? [] : []));
    const showDate = !older || dateOf(older) !== dateOf(event.at);
    const startsOnly = event.entries.every(entry => entry.kind === "start");
    return <section className="bill-event" key={event.at} style={{ paddingLeft: lanes * 14 + 18 }}>
      <div className="bill-rails" aria-hidden="true">{timeline.tracks.map(track => {
        const point = event.entries.some(e => e.trackId === track.id) || marked.has(track.id);
        const above = newer != null && Date.parse(track.endedAt) > at && Date.parse(track.startedAt) <= at;
        const below = older != null && Date.parse(track.startedAt) < at && Date.parse(track.endedAt) >= at;
        if (!point && !above && !below) return null;
        return <div key={track.id} className="bill-rail" style={{ left: track.lane * 14 + 4, color: planColor(track.color) }}>
          {above && <i className="bill-line above" style={cappedAt(track, (at + Date.parse(newer!)) / 2) ? dotted : undefined} />}
          {below && <i className="bill-line below" style={cappedAt(track, (at + Date.parse(older!)) / 2) ? dotted : undefined} />}
          {marked.has(track.id)
            ? <i className="bill-cap-mark" />
            : point && <i className="bill-dot" />}
        </div>;
      })}</div>
      <div className="bill-event-heading">
        <strong><time dateTime={event.at}>{billTime(event.at, timeZone).time}</time>{heading && ` · ${t(headings[heading]!)}`}</strong>
        {showDate && <span>{dateLabel(event.at)}</span>}
      </div>
      {startsOnly ? (
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {event.entries.map((entry, i) => (
            <span key={i} className="inline-flex items-center gap-1.5">
              <i aria-hidden="true" className="bill-plan-dot" style={{ background: colorOfTrack(entry.trackId) }} />
              {entry.name}
              {entry.rule && <span className="text-ink/50">{entry.rule}</span>}
            </span>
          ))}
        </p>
      ) : event.entries.map((entry, i) => <BillEntry key={i} entry={entry} color={entry.trackId ? colorOfTrack(entry.trackId) : null} timeZone={timeZone} />)}
    </section>;
  })}</div>;
}

/** One line of an event: a cap filling, a stretch that charged, a capped stretch's rule change, or an adjustment. */
function BillEntry({ entry, color, timeZone }: { entry: BillTimelineEntry; color: string | null; timeZone?: string }) {
  const { t } = useI18n();
  if (entry.kind === "start") return null;
  if (entry.kind === "full" && entry.trackId == null) {
    return <p className="mb-2 flex items-baseline justify-between gap-3 text-[13px]">
      <span className="font-medium text-mint">{entry.name}{t("已满")}</span>
      {entry.until && <span className="shrink-0 text-xs text-ink/50">{t("封顶到")} {until(entry.until, timeZone)}</span>}
    </p>;
  }
  const rule = entry.rule && (entry.nextRule ? `${entry.rule} → ${entry.nextRule}` : entry.kind === "split" ? t("新的一天") : entry.rule);
  if (entry.trackId && (entry.capped || entry.amount == null)) {
    // A stretch that charged nothing: only a change of rule, an end or now is worth a line.
    if (!["switch", "split", "current", "end"].includes(entry.kind)) return null;
    return <p className="mb-1.5 ml-0.5 flex items-center text-[13px] text-ink/75">
      {color && <i aria-hidden="true" className="bill-plan-dot" style={{ background: color }} />}
      {entry.name}
      {rule && <span className="ml-1.5 text-ink/45">{rule}</span>}
    </p>;
  }
  return <div className="bill-entry">
    <div className="bill-entry-heading">
      <span className="bill-plan-name">
        {color && <i aria-hidden="true" className="bill-plan-dot" style={{ background: color }} />}
        {entry.name}
        {entry.trackId && entry.rule && <small className="ml-1.5 font-normal text-ink/45">{entry.rule}</small>}
      </span>
      {entry.amount != null && <strong className={entry.amount < 0 ? "bill-negative" : ""}>{entry.amount.toFixed(2)}</strong>}
    </div>
    {entry.trackId && entry.unitMinutes != null && entry.unitPrice != null && (
      <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px] text-ink/55 tabular-nums">
        {entry.unitFills
          ? <Blocks fills={entry.unitFills} pending={entry.pending ?? null} color={color!} />
          : entry.units != null && <span>× {entry.units}</span>}
        {entry.unitPrice.toFixed(2)} / {entry.unitMinutes === 60 ? t("小时") : `${entry.unitMinutes} ${t("分钟")}`}
      </div>
    )}
  </div>;
}

/**
 * A block per unit the stretch charged, filled as far as it was charged against
 * its own price (the unit that filled a cap only in part); a unit begun but still
 * inside its grace is outlined.
 */
function Blocks({ fills, pending, color }: { fills: number[]; pending: number | null; color: string }) {
  const { t } = useI18n();
  const count = fills.length + (pending != null ? 1 : 0);
  if (count > 24) return <span>× {fills.length}</span>;
  return (
    <span className="inline-flex flex-wrap gap-0.5" role="img" aria-label={`× ${fills.length}`} title={`${fills.length} ${t("个计费单位")}`}>
      {fills.map((fill, i) => (
        <span key={i} className="relative h-2.5 w-2 overflow-hidden rounded-[2px]" style={{ background: `color-mix(in srgb, ${color} 28%, transparent)` }}>
          <span className="absolute inset-y-0 left-0" style={{ width: `${fill * 100}%`, background: color }} />
        </span>
      ))}
      {pending != null && (
        <span className="relative h-2.5 w-2 overflow-hidden rounded-[2px]" style={{ boxShadow: `inset 0 0 0 1px ${color}` }}>
          <span className="absolute inset-y-0 left-0" style={{ width: `${pending * 100}%`, background: color, opacity: 0.45 }} />
        </span>
      )}
    </span>
  );
}

/** A cap's end as a clock time; one ending at midnight ends at 24:00. */
function until(iso: string, timeZone: string | undefined) {
  const time = billTime(iso, timeZone).time;
  return time === "00:00" ? "24:00" : time;
}
