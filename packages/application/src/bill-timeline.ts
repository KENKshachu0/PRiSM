import type { BillTimeline, BillTimelineEntry, ChargeItem, SettlementAdjustment, TimeCapPricingWindow, TimeCapUnit } from "@prism/core";
import { type Cents, addCents, isZeroCents, settleTimeCapWindows, yuanOf, ZERO_CENTS, formatOffsetTimestamp, timestampDisplayParts } from "@prism/core";

type Track = BillTimeline["tracks"][number] & { sessionId: string; items: ChargeItem[]; from: number; to: number; live: boolean };
/** A cap filling: from `at` the tracks it covers charge nothing until `until`. */
type Fill = { at: number; until: number; label: string; trackIds: string[] };
type Role = "start" | "switch" | "split" | "full" | "over" | "end" | "current";

/**
 * The bill of a checkout preview, the one way every surface gets it: the
 * player's pages and the shop's (computed in the browser), the server preview
 * for runtimes the browser cannot bill, and the live activity.
 */
export function previewBillTimeline(preview: {
  settlementPreview: { previewedAt: Date };
  sessionPreviews: { sessionId: string; label: string | null; startedAt: Date; endedAt: Date | null; chargeItems: ChargeItem[] }[];
  adjustments: SettlementAdjustment[];
  globalCapWindows: TimeCapPricingWindow[];
}): BillTimeline {
  return buildBillTimeline({
    at: preview.settlementPreview.previewedAt,
    sessions: preview.sessionPreviews,
    adjustments: preview.adjustments,
    globalCapWindows: preview.globalCapWindows,
  });
}

/** What a bill event is called where it has one line, in the order a coinciding event is named by. */
const eventLabels: Array<[BillTimelineEntry["kind"], string]> = [
  ["end", "结束计费"], ["start", "开始计费"], ["switch", "切换计费规则"], ["over", "封顶结束"], ["full", "已封顶"], ["split", "新的一天"],
];

/** The bill's events in time order, each with one label; the point marking now is not an event. */
export function billEvents(timeline: BillTimeline): { at: Date; label: string }[] {
  return timeline.events.flatMap(event => {
    const kinds = new Set(event.entries.map(entry => entry.kind));
    const label = eventLabels.find(([kind]) => kinds.has(kind))?.[1];
    return label ? [{ at: new Date(event.at), label }] : [];
  }).sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** The label a set of coinciding bill events is named by. */
export function billEventLabel(labels: Iterable<string>): string | null {
  const all = new Set(labels);
  return eventLabels.find(([, label]) => all.has(label))?.[1] ?? [...all][0] ?? null;
}

/** When a rule's window ends: its anchor plus the length of its clock range. */
function ruleWindowEnd(item: ChargeItem): number {
  const range = item.pricingExplanation?.ruleTimeRange;
  const anchor = item.pricingHistory?.ruleAnchorAt;
  if (!range || !anchor) return item.period?.endedAt.getTime() ?? 0;
  const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
  const length = (minutes(range.end) - minutes(range.start) + 1440) % 1440 || 1440;
  return new Date(anchor).getTime() + length * 60_000;
}

const merge = (spans: Array<[number, number]>) => {
  const out: Array<[number, number]> = [];
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
};

/**
 * Presentation only: amounts come from the shared billing engine. Each plan of
 * a session is a track. Every point where a track changes (it starts, switches
 * rule, a cap over it fills or ends, it stops, now) ends the stretch before it:
 * a stretch that charged is stated there with its amount and units; a stretch a
 * full cap kept from charging is drawn dashed and has no amount.
 */
export function buildBillTimeline(input: {
  at: Date;
  timeZone?: string;
  planNames?: ReadonlyMap<string, string>;
  sessions: { sessionId: string; label: string | null; startedAt: Date; endedAt: Date | null; chargeItems: ChargeItem[] }[];
  adjustments: SettlementAdjustment[];
  globalCapWindows: TimeCapPricingWindow[];
}): BillTimeline {
  const timeZone = input.sessions.flatMap(s => s.chargeItems).find(i => i.pricingExplanation?.timeZone)?.pricingExplanation?.timeZone ?? input.timeZone ?? "UTC";
  const local = (at: string) => {
    const parts = timestampDisplayParts(formatOffsetTimestamp(at, timeZone))!;
    return { time: parts.time, date: parts.date };
  };
  const iso = (at: number) => new Date(at).toISOString();

  // Replay the caps as settlement applied them, unit by unit.
  const owned = new Map<ChargeItem, ChargeItem>();
  for (const session of input.sessions) for (const item of session.chargeItems) {
    owned.set(item, item.sessionId ? item : { ...item, sessionId: session.sessionId });
  }
  const original = new Map([...owned].map(([item, copy]) => [copy, item]));
  const settled = settleTimeCapWindows(input.globalCapWindows, [...owned.values()]);
  const unitsOf = new Map<ChargeItem, TimeCapUnit[]>();
  for (const unit of settled.units) {
    const item = original.get(unit.item)!;
    unitsOf.set(item, [...(unitsOf.get(item) ?? []), unit]);
  }

  const tracks: Track[] = [];
  for (const session of input.sessions) {
    const groups = new Map<string, ChargeItem[]>();
    for (const item of session.chargeItems) {
      const id = item.pricingExplanation?.pricingConfigId ?? item.source;
      groups.set(id, [...(groups.get(id) ?? []), item]);
    }
    // Zero-charge sessions still have a visible start/stop pair.
    if (!groups.size) groups.set(session.sessionId, []);
    for (const [configId, items] of groups) {
      const to = (session.endedAt ?? input.at).getTime();
      const name = items[0]?.pricingExplanation?.planName ?? input.planNames?.get(configId) ?? (session.label === "entry" ? "入场计费" : session.label) ?? items[0]?.label ?? "计费";
      tracks.push({
        id: `${session.sessionId}:${configId}`, name, lane: 0, color: tracks.length,
        startedAt: session.startedAt.toISOString(), endedAt: iso(to),
        sessionId: session.sessionId, from: session.startedAt.getTime(), to, live: !session.endedAt,
        items: [...items].sort((a, b) => (a.period?.startedAt.getTime() ?? 0) - (b.period?.startedAt.getTime() ?? 0)),
      });
    }
  }
  const trackOf = (item: ChargeItem) => tracks.find(track => track.items.includes(item))!;
  // A charge with no period (a fixed charge, a charge saved before periods were) is not
  // laid along the track: it is a line of its own where the track ends.
  const timeless = (track: Track) => track.items.filter(item => !item.period);

  // Caps filling: a cap across plans at the first unit it stopped, over every track it holds;
  // a period cap at the first unit it stopped, over its own track until its rule's window ends.
  const fills: Fill[] = [];
  for (const window of input.globalCapWindows) {
    const first = settled.units.filter(unit => unit.heldBy === window.key).sort((a, b) => a.at.getTime() - b.at.getTime())[0];
    if (!first) continue;
    fills.push({
      at: first.at.getTime(), until: window.windowEndedAt.getTime(),
      label: `${window.capName ?? input.planNames?.get(window.capConfigId) ?? "全局封顶"}（${window.ruleLabel}）`,
      trackIds: tracks.filter(track => window.contributions.some(c => `${c.sessionId}:${c.pricingConfigId}` === track.id)).map(track => track.id),
    });
  }
  for (const track of tracks) for (const item of track.items) {
    const first = (unitsOf.get(item) ?? []).find(unit => unit.heldBy === "period");
    if (first) fills.push({ at: first.at.getTime(), until: ruleWindowEnd(item), label: `时段封顶（${track.name} ${item.label}）`, trackIds: [track.id] });
  }
  for (const track of tracks) {
    const spans = merge(fills.filter(fill => fill.trackIds.includes(track.id))
      .map(fill => [Math.max(fill.at, track.from), Math.min(fill.until, track.to)] as [number, number])
      .filter(([from, to]) => to > from));
    track.capped = spans.map(([from, to]) => ({ startedAt: iso(from), endedAt: iso(to) }));
  }
  const isCapped = (track: Track, at: number) => (track.capped ?? []).some(span => at >= Date.parse(span.startedAt) && at < Date.parse(span.endedAt));

  // Every point where a track changes.
  const roles = new Map<Track, Map<number, Set<Role>>>();
  const mark = (track: Track, at: number, role: Role) => {
    const points = roles.get(track) ?? new Map<number, Set<Role>>();
    roles.set(track, points);
    points.set(at, new Set([...(points.get(at) ?? []), role]));
  };
  for (const track of tracks) {
    mark(track, track.from, "start");
    track.items.forEach((item, index) => {
      if (!item.period) return;
      if (index > 0) mark(track, item.period.startedAt.getTime(), track.items[index - 1]!.label === item.label ? "split" : "switch");
      // A rule that ends with no rule after it (closed hours) ends the charging there, not at the next point.
      const next = track.items[index + 1]?.period?.startedAt.getTime() ?? track.to;
      const end = item.period.endedAt.getTime();
      if (next - end >= 60_000 && end > track.from) mark(track, end, "end");
    });
    for (const fill of fills) if (fill.trackIds.includes(track.id) && fill.at >= track.from && fill.at < track.to) mark(track, fill.at, "full");
    for (const span of track.capped ?? []) if (Date.parse(span.endedAt) < track.to) mark(track, Date.parse(span.endedAt), "over");
    mark(track, track.to, track.live ? "current" : "end");
  }
  const pointsOf = (track: Track) => [...(roles.get(track)?.keys() ?? [])].sort((a, b) => a - b);

  // A unit counts in the stretch it began in; the unit that filled a cap, in the stretch the fill ends.
  const stretch = new Map<string, TimeCapUnit[]>();
  for (const [item, units] of unitsOf) {
    const track = trackOf(item);
    const points = pointsOf(track);
    for (const unit of units) {
      if (isZeroCents(unit.charged)) continue;
      const at = unit.at.getTime() - (isCapped(track, unit.at.getTime()) ? 1 : 0);
      const end = points.find(point => point > at) ?? track.to;
      stretch.set(`${track.id}@${end}`, [...(stretch.get(`${track.id}@${end}`) ?? []), unit]);
    }
  }
  const ruleAt = (track: Track, at: number) => track.items.find(item => item.period && item.period.startedAt.getTime() <= at && item.period.endedAt.getTime() > at)
    ?? track.items.filter(item => item.period && item.period.startedAt.getTime() <= at).at(-1);

  const events = new Map<string, BillTimelineEntry[]>();
  const add = (at: number, entry: Partial<BillTimelineEntry> & Pick<BillTimelineEntry, "kind" | "name">) => {
    const key = iso(at);
    const row: BillTimelineEntry = {
      trackId: null, periodLabel: null, rule: null, nextRule: null, amount: null, startedAt: null, endedAt: null,
      unitMinutes: null, unitPrice: null, units: null, cap: null, paidBefore: null, counted: null, ...entry,
    };
    if (row.startedAt && row.endedAt) {
      const start = local(row.startedAt), end = local(row.endedAt);
      row.periodLabel = start.date === end.date ? `${start.time} – ${end.time}` : `${start.date.slice(5)} ${start.time} – ${end.date.slice(5)} ${end.time}`;
    }
    events.set(key, [...(events.get(key) ?? []), row]);
  };
  for (const fill of fills) {
    if (fill.at >= input.at.getTime()) continue;
    add(fill.at, { kind: "full", name: fill.label, trackIds: fill.trackIds, until: iso(fill.until) });
  }
  // Each plan at what it was charged, every unit counted once.
  const totals = new Map<string, Cents>();
  for (const [item, units] of unitsOf) {
    const name = trackOf(item).name;
    totals.set(name, units.reduce((sum, unit) => addCents(sum, unit.charged), totals.get(name) ?? ZERO_CENTS));
  }
  for (const track of tracks) for (const item of timeless(track)) {
    totals.set(track.name, addCents(totals.get(track.name) ?? ZERO_CENTS, item.amount));
  }
  const order: Role[] = ["current", "end", "switch", "split", "full", "over"];
  for (const track of tracks) {
    const points = pointsOf(track);
    points.forEach((point, index) => {
      const here = roles.get(track)!.get(point)!;
      if (index === 0) {
        add(point, { trackId: track.id, kind: "start", name: track.name, rule: (ruleAt(track, point) ?? track.items[0])?.label ?? null });
        return;
      }
      const lines = point === track.to ? timeless(track) : [];
      const listLines = () => {
        for (const item of lines) add(point, { trackId: track.id, kind: track.live ? "current" : "end", name: track.name, rule: item.label, amount: item.amount });
      };
      const from = points[index - 1]!;
      const kind = order.find(role => here.has(role))! as Role;
      const rule = ruleAt(track, from);
      const next = here.has("switch") ? ruleAt(track, point)?.label ?? null : null;
      const units = (stretch.get(`${track.id}@${point}`) ?? []).sort((a, b) => a.at.getTime() - b.at.getTime());
      const priced = rule?.period && rule.period.startedAt.getTime() < point && rule.period.endedAt.getTime() > from;
      if (!units.length && (isCapped(track, (from + point) / 2) || !priced)) {
        // A capped stretch, or one with no rule charging, states only where its rule changes, ends or is now;
        // where the track ends with charges of no period, those say it.
        if (lines.length && !rule) { listLines(); return; }
        add(point, { trackId: track.id, kind, name: track.name, rule: rule?.label ?? null, nextRule: next, capped: isCapped(track, (from + point) / 2) });
        listLines();
        return;
      }
      const amount = units.reduce((sum, unit) => addCents(sum, unit.charged), ZERO_CENTS);
      const pricing = rule?.pricingExplanation?.pricing;
      // The unit begun at the end of a running stretch but still inside its grace.
      let pending: number | null = null;
      if (kind === "current" && pricing && rule?.period) {
        const step = pricing.unitMinutes * 60_000;
        const charged = (unitsOf.get(rule) ?? []).length;
        const begun = rule.period.startedAt.getTime() + charged * step;
        if (begun < point && point - begun < step) pending = (point - begun) / step;
      }
      add(point, {
        trackId: track.id, kind, name: track.name, rule: rule?.label ?? null, nextRule: next,
        // A running quote stops at its last whole minute, a little before the preview clock.
        amount, startedAt: iso(from), endedAt: iso(Math.min(point, rule?.period?.endedAt.getTime() ?? point)),
        unitMinutes: pricing?.unitMinutes ?? null, unitPrice: pricing?.unitPrice ?? null, units: units.length,
        unitFills: units.map(unit => unit.nominal > 0 ? Math.min(1, unit.charged / unit.nominal) : 1),
        pending,
      });
      listLines();
    });
  }
  // Adjustments other than caps across plans (offers, price overrides) stay lines of their own.
  for (const adjustment of input.adjustments) {
    if (isZeroCents(adjustment.amount) || adjustment.pricingCapHistory) continue;
    add(input.at.getTime(), { kind: "adjustment", name: adjustment.label, amount: adjustment.amount });
    totals.set(adjustment.label, addCents(totals.get(adjustment.label) ?? ZERO_CENTS, adjustment.amount));
  }
  const lanes: string[] = [];
  for (const track of [...tracks].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))) {
    let lane = lanes.findIndex(end => end <= track.startedAt);
    if (lane < 0) lane = lanes.length;
    track.lane = lane;
    lanes[lane] = track.endedAt;
  }
  return {
    totals: [...totals].filter(([, amount]) => !isZeroCents(amount)).map(([name, amount]) => ({ name, amount: yuanOf(amount) })),
    tracks: tracks.map(({ id, name, lane, color, startedAt, endedAt, capped }) => ({ id, name, lane, color, startedAt, endedAt, capped })),
    events: [...events].sort(([a], [b]) => b.localeCompare(a)).map(([at, entries]) => ({
      at, ...local(at), entries: entries.map(entry => ({ ...entry, amount: entry.amount == null ? null : yuanOf(entry.amount as Cents) })),
    })),
  };
}
