import { centsOf as moneyFixture, centsOfInteger as integerFixture } from "@prism/core";
import { expect, test } from "bun:test";
import { createPriorityTimePricingProvider, applyTimeCapPricing, explainTimeCapPricing, type Session } from "@prism/core";
import { buildBillTimeline } from "../src/bill-timeline";

const date = (clock: string) => new Date(`2026-09-13T${clock}:00Z`);
const pricing = (unitPrice: number) => ({ unitPrice, unitMinutes: 30, roundGraceMinutes: 2, priceCap: 100 });
const session = (id: string, start: string, end: string | null): Session => ({ id, playerId: "test", label: id, status: end ? "closed" : "active", startedAt: date(start), endedAt: end ? date(end) : null } as Session);

test("the internal entry marker is never used as an unnamed admission track title", () => {
  const timeline = buildBillTimeline({ at: date("12:00"), sessions: [{ sessionId: "visit", label: "entry", startedAt: date("11:00"), endedAt: null, chargeItems: [] }], adjustments: [], globalCapWindows: [] });
  expect(timeline.tracks[0]?.name).toBe("入场计费");
  expect(timeline.events.flatMap(event => event.entries).every(entry => entry.name === "入场计费")).toBe(true);
});

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
  const config = { id: "cap", name: "全天优惠", includedPricingConfigIds: ["p0", "p1", "p2"], timeZone: "UTC", rules: [{ id: "all", label: "Combined", priority: 1, timeRange: { start: "00:00", end: "00:00" }, priceCap: 20 }] };
  const adjustments = applyTimeCapPricing({ config, chargeItems });
  const timeline = buildBillTimeline({ at, sessions, adjustments, globalCapWindows: explainTimeCapPricing({ config, chargeItems }) });
  expect(timeline.events.flatMap(event => event.entries).filter(entry => entry.kind === "start").every(entry => entry.rule === "A" || entry.rule === "B")).toBe(true);
  expect(timeline.events.flatMap(event => event.entries).filter(entry => entry.kind === "adjustment").every(entry => entry.name === "全天优惠（Combined）")).toBe(true);
  const switched = timeline.events.find(e => e.at === date("09:15").toISOString());
  expect(switched?.entries.filter(e => e.kind === "switch")).toHaveLength(2);
  expect(timeline.events.some(e => e.at === date("10:00").toISOString())).toBe(false);
  expect(timeline.tracks[1]?.lane).toBe(timeline.tracks[2]?.lane);
  expect(timeline.tracks[0]?.lane).not.toBe(timeline.tracks[1]?.lane);
  expect(timeline.events.flatMap(e => e.entries).some(e => (e.amount ?? 0) < 0)).toBe(true);
  expect(Math.round(timeline.events.flatMap(e => e.entries).reduce((n, e) => n + (e.amount ?? 0), 0) * 100)).toBe(chargeItems.reduce((n, i) => n + i.amount, 0) + adjustments.reduce((n, i) => n + i.amount, 0));
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
        amount: moneyFixture(2),
        period: { startedAt, endedAt: roundedEnd },
      }],
    }],
    adjustments: [],
    globalCapWindows: [],
  });
  expect(timeline.events).toHaveLength(2);
  expect(timeline.events[0]?.at).toBe(previewedAt.toISOString());
  expect(timeline.events[0]?.entries[0]?.kind).toBe("current");
  expect(timeline.events[0]?.entries[0]?.endedAt).toBe(roundedEnd.toISOString());
});


test("closed gaps do not extend a charged period to the preview clock", async () => {
  const start = date("02:08"), at = date("03:54");
  const s = session("gap", "02:08", null);
  const items = await createPriorityTimePricingProvider({ id: "night", rules: [{ id: "night", label: "Night", priority: 1, timeRange: { start: "10:00", end: "03:00" }, pricing: pricing(18) }], timeZone: "UTC" }).quote({ session: s, now: at, assetHoldings: [] });
  const timeline = buildBillTimeline({ at, sessions: [{ sessionId: s.id, label: null, startedAt: start, endedAt: null, chargeItems: items }], adjustments: [], globalCapWindows: [] });
  const charge = timeline.events.flatMap(event => event.entries).find(entry => entry.amount != null)!;
  expect(charge.endedAt).toBe(date("03:00").toISOString());
  expect(charge.periodLabel).toBe("02:08 – 03:00");
  expect(timeline.events[0]?.at).toBe(at.toISOString());
  expect(timeline.events[0]?.entries[0]?.amount).toBeNull();
});

test("a full cap ends the stretch that charged, and the tracks it holds are capped until its window ends", async () => {
  const at = date("02:00");
  const start = new Date("2026-09-12T22:00:00Z");
  const night = (id: string, unitPrice: number) => createPriorityTimePricingProvider({
    id, name: id, timeZone: "UTC",
    rules: [{ id: "night", label: "夜场", priority: 1, timeRange: { start: "22:00", end: "10:00" }, pricing: { unitPrice, unitMinutes: 60, roundGraceMinutes: 0, priceCap: 0 } }],
  });
  const sessions = await Promise.all([["entry", 6], ["rhythm", 3]].map(async ([id, price]) => {
    const s = { ...session(id as string, "00:00", null), startedAt: start };
    return { sessionId: s.id, label: s.label ?? null, startedAt: start, endedAt: null, chargeItems: await night(id as string, price as number).quote({ session: s, now: at, assetHoldings: [] }) };
  }));
  const chargeItems = sessions.flatMap(s => s.chargeItems.map(item => ({ ...item, sessionId: s.sessionId })));
  // 10.00 was settled in this window earlier: 20 left under the 30 cap. 22:00 and 23:00 take 18; at 00:00 entry takes the last 2.
  const config = { id: "cap", name: "分段封顶", includedPricingConfigIds: ["entry", "rhythm"], timeZone: "UTC",
    paidHistory: { "cap@night@2026-09-12T22:00:00.000Z": integerFixture(1000) },
    rules: [{ id: "night", label: "夜间", priority: 1, timeRange: { start: "22:00", end: "10:00" }, priceCap: 30 }] };
  const timeline = buildBillTimeline({ at, sessions, adjustments: applyTimeCapPricing({ config, chargeItems }), globalCapWindows: explainTimeCapPricing({ config, chargeItems }) });
  const entries = timeline.events.flatMap(e => e.entries);
  expect(entries.find(e => e.kind === "full" && e.trackId == null)).toMatchObject({
    name: "分段封顶（夜间）", trackIds: ["entry:entry", "rhythm:rhythm"], until: "2026-09-13T10:00:00.000Z",
  });
  expect(timeline.events.find(e => e.at === date("00:00").toISOString())?.entries.filter(e => e.trackId)
    .map(e => [e.trackId, e.kind, e.amount, e.unitFills?.map(f => Math.round(f * 100) / 100)])).toEqual([
    ["entry:entry", "full", 14, [1, 1, 0.33]],
    ["rhythm:rhythm", "full", 6, [1, 1]],
  ]);
  expect(timeline.events[0]?.entries.map(e => [e.trackId, e.kind, e.capped, e.amount])).toEqual([
    ["entry:entry", "current", true, null],
    ["rhythm:rhythm", "current", true, null],
  ]);
  expect(timeline.tracks.map(t => t.capped)).toEqual([
    [{ startedAt: date("00:00").toISOString(), endedAt: at.toISOString() }],
    [{ startedAt: date("00:00").toISOString(), endedAt: at.toISOString() }],
  ]);
  expect(timeline.totals).toEqual([{ name: "entry", amount: 14 }, { name: "rhythm", amount: 6 }]);
});

test("a charge running past a cap window is capped only inside it, and charges again after", async () => {
  const start = new Date("2026-09-13T00:00:00Z"), at = new Date("2026-09-13T12:18:00Z");
  const s = { ...session("rhythm", "00:00", null), startedAt: start };
  const items = (await createPriorityTimePricingProvider({ id: "rhythm", name: "音游差价", timeZone: "UTC",
    rules: [{ id: "all", label: "全天", priority: 1, timeRange: { start: "00:00", end: "00:00" }, pricing: { unitPrice: 3, unitMinutes: 60, roundGraceMinutes: 5, priceCap: 0 } }],
  }).quote({ session: s, now: at, assetHoldings: [] })).map(item => ({ ...item, sessionId: "rhythm" }));
  const config = { id: "split", name: "分段封顶", includedPricingConfigIds: ["rhythm"], timeZone: "UTC", rules: [
    { id: "night", label: "夜间", priority: 1, timeRange: { start: "22:00", end: "10:00" }, priceCap: 20 },
    { id: "day", label: "日间", priority: 1, timeRange: { start: "10:00", end: "22:00" }, priceCap: 40 },
  ] };
  const sessions = [{ sessionId: "rhythm", label: null, startedAt: start, endedAt: null, chargeItems: items }];
  const timeline = buildBillTimeline({ at, sessions, adjustments: applyTimeCapPricing({ config, chargeItems: items }), globalCapWindows: explainTimeCapPricing({ config, chargeItems: items }) });
  const rows = timeline.events.flatMap(e => e.entries).filter(e => e.trackId && e.kind !== "start");
  // 00:00–06:00 charges the night's 20 (the 06:00 unit only 2), capped until 10:00, then the day charges 9.
  expect(rows.map(e => [e.kind, e.endedAt, e.amount, e.capped ?? false])).toEqual([
    ["current", at.toISOString(), 9, false],
    ["over", null, null, true],
    ["full", "2026-09-13T06:00:00.000Z", 20, false],
  ]);
  expect(timeline.tracks[0]?.capped).toEqual([{ startedAt: "2026-09-13T06:00:00.000Z", endedAt: "2026-09-13T10:00:00.000Z" }]);
});
