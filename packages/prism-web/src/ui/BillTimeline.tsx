import type { BillTimeline as Timeline } from "@prism/core";
import { useI18n } from "../i18n";

export type BillPreview = {
  settlementPreview: { total: number };
  timeline?: Timeline;
  chargeItems: { label: string; amount: number }[];
  adjustments: { label: string; amount: number }[];
};
const colors = ["#4e7eaf", "#a47553", "#8874b4", "#4b908d", "#ba7187", "#7f8e49"];
export function BillTotal({ preview }: { preview: BillPreview }) {
  const { t } = useI18n();
  return <div className="bill-total"><span>{t("合计")}</span><strong>{preview.settlementPreview.total.toFixed(2)}</strong>{preview.timeline && <div className="bill-breakdown">{preview.timeline.totals.map((item, i) => <span key={i}>{item.name} <b className={item.amount < 0 ? "bill-negative" : ""}>{item.amount.toFixed(2)}</b></span>)}</div>}</div>;
}
export function BillTimeline({ preview }: { preview: BillPreview }) {
  const { t } = useI18n();
  const timeline = preview.timeline;
  if (!timeline) return <div>{[...preview.chargeItems, ...preview.adjustments].map((row, i) => <div className="account-row" key={i}><span>{row.label}</span><span className={row.amount < 0 ? "bill-negative" : ""}>{row.amount.toFixed(2)}</span></div>)}</div>;
  const date = (at: string) => new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
  const labels = { start: "开始计费", end: "结束计费", current: "现在", switch: "切换计费规则", adjustment: "" };
  const lanes = Math.max(1, ...timeline.tracks.map(track => track.lane + 1));
  return <div className="bill-timeline">{timeline.events.map((event, index) => {
    const nextAt = timeline.events[index + 1]?.at;
    const kinds = [...new Set(event.entries.filter(e => e.trackId).map(e => e.kind))];
    return <section className="bill-event" key={event.at} style={{ paddingLeft: lanes * 14 + 18 }}>
      <div className="bill-rails" aria-hidden="true">{timeline.tracks.map(track => {
        const point = event.entries.some(e => e.trackId === track.id);
        const above = track.endedAt > event.at && track.startedAt <= event.at;
        const below = nextAt != null && track.startedAt < event.at && track.endedAt >= event.at;
        if (!point && !above && !below) return null;
        return <div key={track.id} className="bill-rail" style={{ left: track.lane * 14 + 4, color: colors[track.color % colors.length] }}>
          {above && <i className="bill-line above" />}{below && <i className="bill-line below" />}{point && <i className="bill-dot" />}
        </div>;
      })}</div>
      <div className="bill-event-heading"><strong><time dateTime={event.at}>{event.time}</time>{kinds.length === 1 && ` · ${t(labels[kinds[0]!]!)}`}</strong><span>{date(event.date + "T12:00:00")}</span></div>
      {event.entries.map((entry, i) => <div className={`bill-entry ${entry.trackId == null ? "bill-adjustment" : ""}`} key={i}>
        <div className="bill-entry-heading"><span className="bill-plan-name">{entry.trackId && <i aria-hidden="true" className="bill-plan-dot" style={{ background: colors[(timeline.tracks.find(track => track.id === entry.trackId)?.color ?? 0) % colors.length] }} />}{entry.name}{kinds.length > 1 && entry.trackId && <small> · {t(labels[entry.kind])}</small>}</span>{entry.amount != null && <strong className={entry.amount < 0 ? "bill-negative" : ""}>{entry.amount.toFixed(2)}</strong>}</div>
        {entry.rule && <p>{entry.rule}{entry.nextRule && ` → ${entry.nextRule}`}</p>}
        {entry.startedAt && entry.endedAt && <p>{entry.periodLabel} · {Math.round((Date.parse(entry.endedAt) - Date.parse(entry.startedAt)) / 60000)} {t("分钟")}</p>}
        {entry.unitMinutes != null && <p>{entry.unitPrice?.toFixed(2)} / {entry.unitMinutes} {t("分钟")}{entry.units != null && ` × ${entry.units}`}</p>}
        {entry.cap != null && <p>{t(entry.trackId ? "时段封顶" : "跨方案封顶")} {entry.cap.toFixed(2)}{entry.paidBefore ? ` · ${t("历史已计入")} ${entry.paidBefore.toFixed(2)}` : ""}</p>}
      </div>)}
    </section>;
  })}</div>;
}
