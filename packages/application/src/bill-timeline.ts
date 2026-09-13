import type { BillTimeline, BillTimelineEntry, ChargeItem, SettlementAdjustment, TimeCapPricingWindow } from "@prism/core";

/** Presentation only: amounts come from the engine, never recalculated by clients. */
export function buildBillTimeline(input: {
  at: Date;
  sessions: { sessionId: string; label: string | null; startedAt: Date; endedAt: Date | null; chargeItems: ChargeItem[] }[];
  adjustments: SettlementAdjustment[];
  globalCapWindows: TimeCapPricingWindow[];
}): BillTimeline {
  const timeZone = input.sessions.flatMap(s => s.chargeItems).find(i => i.pricingExplanation?.timeZone)?.pricingExplanation?.timeZone ?? "UTC";
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const local = (at: string) => {
    const parts = formatter.formatToParts(new Date(at));
    const get = (key: string) => parts.find(p => p.type === key)!.value;
    return { time: `${get("hour")}:${get("minute")}`, date: `${get("year")}-${get("month")}-${get("day")}` };
  };
  const tracks: BillTimeline["tracks"] = [];
  const events = new Map<string, BillTimelineEntry[]>();
  const add = (at: Date, entry: Partial<BillTimelineEntry> & Pick<BillTimelineEntry, "kind" | "name">) => {
    const key = at.toISOString();
    const entries = events.get(key) ?? [];
    const row: BillTimelineEntry = { trackId: null, periodLabel: null, rule: null, nextRule: null, amount: null, startedAt: null, endedAt: null,
      unitMinutes: null, unitPrice: null, units: null, cap: null, paidBefore: null, ...entry };
    if (row.startedAt && row.endedAt) {
      const start = local(row.startedAt), end = local(row.endedAt);
      row.periodLabel = start.date === end.date ? `${start.time} – ${end.time}` : `${start.date.slice(0, 4) === end.date.slice(0, 4) ? start.date.slice(5) : start.date} ${start.time} – ${start.date.slice(0, 4) === end.date.slice(0, 4) ? end.date.slice(5) : end.date} ${end.time}`;
    }
    entries.push(row);
    events.set(key, entries);
  };
  for (const session of input.sessions) {
    const groups = new Map<string, ChargeItem[]>();
    for (const item of session.chargeItems) {
      const id = item.pricingExplanation?.pricingConfigId ?? item.source;
      groups.set(id, [...(groups.get(id) ?? []), item]);
    }
    // Zero-charge sessions still have a visible start/stop pair.
    if (!groups.size) groups.set(session.sessionId, []);
    for (const [configId, items] of groups) {
      const id = `${session.sessionId}:${configId}`;
      const end = session.endedAt ?? input.at;
      const name = items[0]?.pricingExplanation?.planName ?? session.label ?? items[0]?.label ?? "计费";
      tracks.push({ id, name, lane: 0, color: tracks.length, startedAt: session.startedAt.toISOString(), endedAt: end.toISOString() });
      add(session.startedAt, { trackId: id, kind: "start", name });
      const sorted = [...items].sort((a, b) => (a.period?.startedAt.getTime() ?? 0) - (b.period?.startedAt.getTime() ?? 0));
      sorted.forEach((item, index) => {
        const explanation = item.pricingExplanation;
        const period = explanation?.period ?? item.period;
        const periodEnd = period?.endedAt.getTime() ?? end.getTime();
        const endedAt = new Date(Math.min(periodEnd, end.getTime()));
        const next = sorted[index + 1];
        // Active quotes can end at the last whole minute while the preview clock still has seconds.
        const currentTail = !session.endedAt && !next && endedAt.getTime() < end.getTime();
        const isBoundary = !currentTail && endedAt.getTime() < end.getTime() && !!next;
        const eventAt = currentTail ? end : endedAt;
        add(eventAt, {
          trackId: id, name, kind: isBoundary ? "switch" : session.endedAt ? "end" : "current",
          rule: item.label, nextRule: isBoundary ? next?.label ?? null : null, amount: item.amount,
          startedAt: period?.startedAt.toISOString() ?? null, endedAt: period ? eventAt.toISOString() : null,
          unitMinutes: explanation?.pricing?.unitMinutes ?? null, unitPrice: explanation?.pricing?.unitPrice ?? null,
          units: explanation?.units ?? null, cap: explanation?.intervalCapReached ? explanation.intervalCap : null,
          paidBefore: explanation?.paidBefore ?? null,
        });
      });
      if (session.endedAt && !sorted.some(item => Math.min(item.period?.endedAt.getTime() ?? end.getTime(), end.getTime()) === end.getTime())) {
        add(end, { trackId: id, name, kind: session.endedAt ? "end" : "current" });
      }
    }
  }
  for (const adjustment of input.adjustments) {
    if (adjustment.amount === 0) continue;
    const history = adjustment.pricingCapHistory;
    const window = history && input.globalCapWindows.find(w => w.capConfigId === history.capConfigId && w.capRuleId === history.capRuleId && w.windowStartedAt.getTime() === history.capAnchorAt.getTime());
    // Global caps are independent entries: never attribute them to one plan.
    add(window && window.windowEndedAt < input.at ? window.windowEndedAt : input.at, {
      kind: "adjustment", name: adjustment.label, amount: adjustment.amount,
      startedAt: window?.windowStartedAt.toISOString() ?? null,
      endedAt: window ? new Date(Math.min(window.windowEndedAt.getTime(), input.at.getTime())).toISOString() : null,
      cap: window?.priceCap ?? null, paidBefore: window?.paidBefore ?? null,
    });
  }
  const lanes: string[] = [];
  for (const track of [...tracks].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))) {
    let lane = lanes.findIndex(end => end <= track.startedAt);
    if (lane < 0) lane = lanes.length;
    track.lane = lane;
    lanes[lane] = track.endedAt;
  }
  const totals = new Map<string, number>();
  for (const entries of events.values()) for (const entry of entries) {
    if (entry.amount != null) totals.set(entry.name, (totals.get(entry.name) ?? 0) + entry.amount);
  }
  return { totals: [...totals].map(([name, amount]) => ({ name, amount })), tracks, events: [...events].sort(([a], [b]) => b.localeCompare(a)).map(([at, entries]) => ({ at, ...local(at), entries })) };
}
