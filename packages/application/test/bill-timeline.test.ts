import { expect, test } from "bun:test";
import { createPriorityTimePricingProvider, applyTimeCapPricing, explainTimeCapPricing, type Session } from "@prism/core";
import { buildBillTimeline } from "../src/bill-timeline";

const date = (clock: string) => new Date(`2026-09-13T${clock}:00Z`);
const pricing = (unitPrice: number) => ({ unitPrice, unitMinutes: 30, roundGraceMinutes: 2, priceCap: 100 });
const session = (id: string, start: string, end: string | null): Session => ({ id, playerId: "test", label: id, status: end ? "closed" : "active", startedAt: date(start), endedAt: end ? date(end) : null } as Session);

test("engine boundaries drive shared nodes and signed charges; disjoint pairs reuse rails", async () => {
  const at = date("12:00");
  const rules = (price: number) => [
    { id: "night", label: "A", priority: 1, timeRange: { start: "22:00", end: "09:15" }, pricing: pricing(price) },
    { id: "day", label: "B", priority: 1, timeRange: { start: "09:15", end: "22:00" }, pricing: pricing(price) },
  ];
  const sessions = await Promise.all([session("one", "08:00", null), session("two", "08:30", "10:30"), session("three", "11:00", null)].map(async (s, i) => ({
    sessionId: s.id, label: s.label ?? null, startedAt: s.startedAt, endedAt: s.endedAt ?? null,
    chargeItems: await createPriorityTimePricingProvider({ id: `p${i}`, name: `Plan ${i}`, rules: rules(i === 1 ? -1 : 6), timeZone: "UTC" }).quote({ session: s, now: at, assetHoldings: [] }),
  })));
  const chargeItems = sessions.flatMap(s => s.chargeItems);
  const config = { id: "cap", includedPricingConfigIds: ["p0", "p1", "p2"], timeZone: "UTC", rules: [{ id: "all", label: "Combined", priority: 1, timeRange: { start: "00:00", end: "00:00" }, priceCap: 20 }] };
  const adjustments = applyTimeCapPricing({ config, chargeItems });
  const timeline = buildBillTimeline({ at, sessions, adjustments, globalCapWindows: explainTimeCapPricing({ config, chargeItems }) });
  const switched = timeline.events.find(e => e.at === date("09:15").toISOString());
  expect(switched?.entries.filter(e => e.kind === "switch")).toHaveLength(2);
  expect(timeline.events.some(e => e.at === date("10:00").toISOString())).toBe(false);
  expect(timeline.tracks[1]?.lane).toBe(timeline.tracks[2]?.lane);
  expect(timeline.tracks[0]?.lane).not.toBe(timeline.tracks[1]?.lane);
  expect(timeline.events.flatMap(e => e.entries).some(e => (e.amount ?? 0) < 0)).toBe(true);
  expect(timeline.events.flatMap(e => e.entries).reduce((n, e) => n + (e.amount ?? 0), 0)).toBeCloseTo(chargeItems.reduce((n, i) => n + i.amount, 0) + adjustments.reduce((n, i) => n + i.amount, 0));
  expect(timeline.events.flatMap(e => e.entries).filter(e => e.kind === "adjustment").every(e => e.trackId == null)).toBe(true);
});

test("continuous overnight rule has no midnight node; empty and legacy sessions remain visible", async () => {
  const start = new Date("2026-09-12T23:00:00Z"), at = date("01:00");
  const s = { ...session("night", "00:00", null), startedAt: start };
  const items = await createPriorityTimePricingProvider({ id: "night", rules: [{ id: "night", label: "Night", priority: 1, timeRange: { start: "22:00", end: "10:00" }, pricing: pricing(6) }], timeZone: "UTC" }).quote({ session: s, now: at, assetHoldings: [] });
  const timeline = buildBillTimeline({ at, sessions: [{ sessionId: s.id, label: null, startedAt: start, endedAt: null, chargeItems: items }, { sessionId: "empty", label: "Empty", startedAt: start, endedAt: at, chargeItems: [] }], adjustments: [], globalCapWindows: [] });
  expect(timeline.events.map(e => e.at)).toEqual([at.toISOString(), start.toISOString()]);
  expect(timeline.events[0]?.entries.find(e => e.name === "Empty")?.kind).toBe("end");
});

test("active tail rounded before preview time stays current", () => {
  const startedAt = date("12:45");
  const previewedAt = new Date("2026-09-13T13:33:42Z");
  const roundedEnd = new Date("2026-09-13T13:33:00Z");
  const timeline = buildBillTimeline({
    at: previewedAt,
    sessions: [{
      sessionId: "active",
      label: "Plan",
      startedAt,
      endedAt: null,
      chargeItems: [{
        id: "item",
        sessionId: "active",
        source: "plan",
        label: "日间",
        amount: 2,
        period: { startedAt, endedAt: roundedEnd },
      }],
    }],
    adjustments: [],
    globalCapWindows: [],
  });
  expect(timeline.events).toHaveLength(2);
  expect(timeline.events[0]?.at).toBe(previewedAt.toISOString());
  expect(timeline.events[0]?.entries[0]?.kind).toBe("current");
});
