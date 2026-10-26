/**
 * Parity fixtures for the Swift port of the browser billing engine (hinata_go
 * ios/PrismCore). Every scenario is computed here by the real TypeScript code
 * the web runs and written as one JSON file:
 *
 *   { name, kind: "preview",  input: { snapshot, playerId },         expected | expectedError }
 *   { name, kind: "timeline", input: { billInputs, timeZone? },      expected }
 *   { name, kind: "segments", input: { config, localDate, displayTimeZone }, expected, expectedError? }
 *
 * All data is synthetic. Usage (from the repository root):
 *   bun scripts/swift-core-fixtures.ts <outDir>
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  applyTimeCapPricing,
  centsOf,
  centsOfInteger,
  createPriorityTimePricingProvider,
  explainTimeCapPricing,
  type AssetDefinition,
  type AssetHolding,
  type LiveBillingSnapshot,
  type PricingConfig,
  type PricingRelease,
  type Session,
} from "../packages/core/src";
import { createLiveBillingCalculator, hydrateLiveBillingSnapshot } from "../packages/application/src/live-billing-snapshot";
import { buildBillTimeline } from "../packages/application/src/bill-timeline";
import { checkoutPreviewView } from "../packages/prism-web/src/checkout-preview";
import { pricingPreview } from "../packages/prism-web/src/ui/merchant/pricing-preview";
import { pricingInZone } from "../packages/prism-web/src/ui/merchant/pricing-clock";
import { toPricingConfigManagementView } from "../packages/server/src/routes/shops/views";

const outDir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: bun scripts/swift-core-fixtures.ts <outDir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
for (const file of readdirSync(outDir)) if (file.endsWith(".json")) rmSync(join(outDir, file));

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const written: string[] = [];
function write(name: string, fixture: Record<string, unknown>) {
  if (written.includes(name)) throw new Error(`duplicate fixture ${name}`);
  written.push(name);
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify({ name, ...fixture }, null, 2)}\n`);
}
const errorOf = (error: unknown) => ({
  code: (error as { code?: string }).code ?? (error as Error).name,
  message: (error as Error).message,
});

// ── Builders ────────────────────────────────────────────────────────────────

const created = new Date("2026-01-01T00:00:00.000Z");
type Unit = { unitPrice: number; unitMinutes: number; roundGraceMinutes: number; priceCap: number };
const unit = (unitPrice: number, unitMinutes = 60, roundGraceMinutes = 0, priceCap = 0): Unit =>
  ({ unitPrice, unitMinutes, roundGraceMinutes, priceCap });
const rule = (id: string, label: string, start: string, end: string, pricing: Unit, extra: Record<string, unknown> = {}) =>
  ({ id, label, priority: 1, timeRange: { start, end }, pricing, ...extra });
const capRule = (id: string, label: string, start: string, end: string, priceCap: number, extra: Record<string, unknown> = {}) =>
  ({ id, label, priority: 1, timeRange: { start, end }, priceCap, ...extra });

function timePlan(id: string, name: string, rules: unknown[], extra: Record<string, unknown> = {}, provider: Record<string, unknown> = {}): PricingConfig {
  return {
    id, kind: "time.priority", name, enabled: true, status: "active", versionId: `${id}-v1`, version: 1,
    provider: { id: `${id}-provider`, rules, ...provider }, relations: { requires: [], conflicts: [] },
    createdAt: created, updatedAt: created, ...extra,
  } as PricingConfig;
}
function capPlan(id: string, name: string, rules: unknown[], extra: Record<string, unknown> = {}, provider: Record<string, unknown> = {}): PricingConfig {
  return {
    id, kind: "time.cap", name, enabled: true, status: "active", versionId: `${id}-v1`, version: 1,
    provider: { id: `${id}-provider`, includedPricingConfigIds: [], rules, ...provider },
    createdAt: created, updatedAt: created, ...extra,
  } as PricingConfig;
}
function fixedPlan(id: string, name: string, label: string, amount: number): PricingConfig {
  return {
    id, kind: "charge.fixed", name, enabled: true, status: "active", versionId: `${id}-v1`, version: 1,
    provider: { id: `${id}-provider`, label, amount }, createdAt: created, updatedAt: created,
  } as PricingConfig;
}

function session(id: string, start: string, end: string | null, plan: string | null, extra: Partial<Session> = {}): Session {
  return {
    id, playerId: "player-1", startedAt: new Date(start), endedAt: end ? new Date(end) : undefined,
    status: end ? "closed" : "active", pricingConfigIds: plan ? [plan] : [], ...(plan ? { pricingConfigId: plan } : {}),
    paymentStatus: "unpaid", label: undefined,
    metadata: { deviceOperated: false, hasDeviceActivity: false }, ...extra,
  } as Session;
}

type PlayerInput = {
  playerId?: string;
  sessions: Session[];
  holdings?: AssetHolding[];
  pastAppliedAdjustments?: { source: string; sessionStartedAt: Date }[];
  pricingPaidHistory?: Record<string, number>;
  capPaidHistory?: Record<string, number>;
};

function snapshotOf(input: {
  capturedAt: string;
  configs?: PricingConfig[];
  releases?: PricingRelease[];
  definitions?: AssetDefinition[];
  players: PlayerInput[];
}): LiveBillingSnapshot {
  return {
    version: 1,
    capturedAt: new Date(input.capturedAt),
    assetDefinitions: input.definitions ?? [],
    currentPricingConfigs: input.configs ?? [],
    pricingReleases: input.releases ?? [],
    players: input.players.map((player) => ({
      playerId: player.playerId ?? "player-1",
      sessions: player.sessions,
      holdings: player.holdings ?? [],
      pastAppliedAdjustments: player.pastAppliedAdjustments ?? [],
      pricingPaidHistory: Object.fromEntries(Object.entries(player.pricingPaidHistory ?? {}).map(([k, v]) => [k, centsOfInteger(v)])),
      capPaidHistory: Object.fromEntries(Object.entries(player.capPaidHistory ?? {}).map(([k, v]) => [k, centsOfInteger(v)])),
    })),
  } as LiveBillingSnapshot;
}

const timelineZones = ["Asia/Shanghai", "America/New_York", "UTC"];
let timelineZoneCursor = 0;

async function preview(name: string, snapshot: LiveBillingSnapshot, playerId = "player-1") {
  const onWire = wire(snapshot);
  try {
    const result = await createLiveBillingCalculator(hydrateLiveBillingSnapshot(wire(onWire))).previewCheckout(playerId);
    write(name, { kind: "preview", input: { snapshot: onWire, playerId }, expected: wire(checkoutPreviewView(result)) });
    // The same bill as raw timeline inputs (what the server returns for previews/receipts), laid out in a fallback zone.
    const billInputs = wire({
      at: result.settlementPreview.previewedAt,
      sessions: result.sessionPreviews.map(({ sessionId, label, startedAt, endedAt, chargeItems }) => ({ sessionId, label, startedAt, endedAt, chargeItems })),
      adjustments: result.adjustments,
      globalCapWindows: result.globalCapWindows,
    });
    const timeZone = timelineZones[timelineZoneCursor++ % timelineZones.length]!;
    const expected = buildBillTimeline({ ...hydrateBillInputs(billInputs), timeZone });
    write(`timeline-from-${name}`, { kind: "timeline", input: { billInputs, timeZone }, expected: wire(expected) });
  } catch (error) {
    write(name, { kind: "preview", input: { snapshot: onWire, playerId }, expectedError: errorOf(error) });
  }
}

/** Bill inputs off the wire, as the engine types them (instants revived). */
function hydrateBillInputs(value: any) {
  const date = (text: string | null | undefined) => (text == null ? null : new Date(text));
  const period = (p: any) => (p ? { startedAt: new Date(p.startedAt), endedAt: new Date(p.endedAt) } : undefined);
  const item = (i: any) => ({
    ...i,
    ...(i.period ? { period: period(i.period) } : {}),
    ...(i.pricingHistory ? { pricingHistory: { ...i.pricingHistory, ruleAnchorAt: new Date(i.pricingHistory.ruleAnchorAt) } } : {}),
    ...(i.pricingExplanation ? { pricingExplanation: { ...i.pricingExplanation, period: period(i.pricingExplanation.period) } } : {}),
  });
  return {
    at: new Date(value.at),
    sessions: value.sessions.map((s: any) => ({ ...s, startedAt: new Date(s.startedAt), endedAt: date(s.endedAt), chargeItems: s.chargeItems.map(item) })),
    adjustments: value.adjustments.map((a: any) => ({
      ...a, ...(a.pricingCapHistory ? { pricingCapHistory: { ...a.pricingCapHistory, capAnchorAt: new Date(a.pricingCapHistory.capAnchorAt) } } : {}),
    })),
    globalCapWindows: value.globalCapWindows.map((w: any) => ({ ...w, windowStartedAt: new Date(w.windowStartedAt), windowEndedAt: new Date(w.windowEndedAt) })),
  };
}

function timeline(name: string, input: Parameters<typeof buildBillTimeline>[0]) {
  const billInputs = wire({ at: input.at, sessions: input.sessions, adjustments: input.adjustments, globalCapWindows: input.globalCapWindows });
  write(name, { kind: "timeline", input: { billInputs, ...(input.timeZone ? { timeZone: input.timeZone } : {}) }, expected: wire(buildBillTimeline(input)) });
}

/** The scan page: ResourcePricing's conversion into the shop zone, then usePlansDaySegments. */
function segments(name: string, config: PricingConfig, localDate: string, displayTimeZone: string) {
  const view = wire(toPricingConfigManagementView(config)) as any;
  try {
    const shop = pricingInZone(view, view.provider.timeZone ?? "UTC", displayTimeZone, localDate);
    const result = pricingPreview(pricingInZone({ ...shop, provider: JSON.parse(JSON.stringify(shop.provider)) }, displayTimeZone, "UTC", localDate), localDate, displayTimeZone, true);
    write(name, { kind: "segments", input: { config: view, localDate, displayTimeZone }, expected: wire(result?.segments ?? []) });
  } catch (error) {
    write(name, { kind: "segments", input: { config: view, localDate, displayTimeZone }, expected: [], expectedError: errorOf(error) });
  }
}

// ── Preview scenarios ───────────────────────────────────────────────────────

const allDay = (pricing: Unit, id = "all-day", label = "全天") => rule(id, label, "00:00", "00:00", pricing);
const pool = (pricing: Unit, extra: Record<string, unknown> = {}) => timePlan("pool", "台球", [allDay(pricing)], extra);

await preview("preview-unit-grace-below", snapshotOf({
  capturedAt: "2026-09-13T12:00:00.000Z",
  configs: [pool(unit(12, 60, 5))],
  players: [{ sessions: [session("s-grace", "2026-09-13T09:56:30.000Z", null, "pool")] }],
}));

await preview("preview-unit-grace-reached", snapshotOf({
  capturedAt: "2026-09-13T12:07:45.123Z",
  configs: [pool(unit(12, 60, 5))],
  players: [{ sessions: [session("s-grace", "2026-09-13T10:01:00.000Z", null, "pool")] }],
}));

await preview("preview-operated-device", snapshotOf({
  capturedAt: "2026-09-13T12:03:20.000Z",
  configs: [pool(unit(12, 60, 15))],
  players: [{ sessions: [session("s-op", "2026-09-13T12:00:00.000Z", null, "pool", { metadata: { deviceOperated: true, hasDeviceActivity: false } })] }],
}));

// A stop at the very start with device use: the charge reaches one minute past the start, and the
// plan's history is read for the keys of the (empty) session span only.
await preview("preview-operated-zero-length", snapshotOf({
  capturedAt: "2026-09-13T15:00:00.000Z",
  configs: [timePlan("pool", "台球", [rule("day", "日间", "10:00", "22:00", unit(12, 60, 10, 30))])],
  players: [{
    sessions: [
      session("s-zero", "2026-09-13T14:00:00.000Z", "2026-09-13T14:00:00.000Z", "pool", { metadata: { deviceOperated: false, hasDeviceActivity: true } }),
      session("s-after", "2026-09-13T14:10:00.000Z", null, "pool"),
    ],
    pricingPaidHistory: { "pool@pool-provider@day@2026-09-13T10:00:00.000Z": 2500 },
  }],
}));

const dayPlan = (priceCap: number) => timePlan("pool", "台球", [rule("day", "日间", "10:00", "22:00", unit(15, 60, 5, priceCap))]);
await preview("preview-period-cap", snapshotOf({
  capturedAt: "2026-09-13T14:30:00.000Z",
  configs: [dayPlan(40)],
  players: [{ sessions: [session("s-cap", "2026-09-13T10:00:00.000Z", null, "pool")] }],
}));

await preview("preview-period-cap-zero-uncapped", snapshotOf({
  capturedAt: "2026-09-13T14:30:00.000Z",
  configs: [dayPlan(0)],
  players: [{ sessions: [session("s-cap", "2026-09-13T10:00:00.000Z", null, "pool")] }],
}));

await preview("preview-paid-history", snapshotOf({
  capturedAt: "2026-09-13T13:20:00.000Z",
  configs: [dayPlan(40)],
  players: [{
    sessions: [session("s-hist", "2026-09-13T11:00:00.000Z", null, "pool")],
    pricingPaidHistory: { "pool@pool-provider@day@2026-09-13T10:00:00.000Z": 3000, "pool@pool-provider@day@2026-09-12T10:00:00.000Z": 4000 },
  }],
}));

await preview("preview-allday-midnight-split", snapshotOf({
  capturedAt: "2026-09-14T01:10:00.000Z",
  configs: [pool(unit(10, 30, 3, 60))],
  players: [{ sessions: [session("s-night", "2026-09-13T22:31:00.000Z", null, "pool")] }],
}));

await preview("preview-overnight-window", snapshotOf({
  capturedAt: "2026-09-14T02:05:00.000Z",
  configs: [timePlan("night", "夜场", [rule("night", "夜间", "22:00", "10:00", unit(8, 60, 5, 30))])],
  players: [{ sessions: [session("s-night", "2026-09-13T21:40:00.000Z", null, "night")] }],
}));

await preview("preview-closed-hours", snapshotOf({
  capturedAt: "2026-09-13T17:30:00.000Z",
  configs: [timePlan("pool", "台球", [
    rule("noon", "午市", "10:00", "14:00", unit(10, 30, 0)),
    rule("evening", "晚市", "16:00", "22:00", unit(16, 30, 0)),
  ])],
  players: [{ sessions: [session("s-gap", "2026-09-13T13:00:00.000Z", null, "pool")] }],
}));

await preview("preview-rule-switch", snapshotOf({
  capturedAt: "2026-09-13T19:05:00.000Z",
  configs: [timePlan("pool", "台球", [
    rule("day", "日间", "10:00", "18:00", unit(10, 60, 5)),
    rule("evening", "晚间", "18:00", "02:00", unit(15, 30, 5), { priority: 2 }),
  ])],
  players: [{ sessions: [session("s-switch", "2026-09-13T17:20:00.000Z", null, "pool")] }],
}));

await preview("preview-fixed-charge", snapshotOf({
  capturedAt: "2026-09-13T15:00:00.000Z",
  configs: [fixedPlan("ticket", "门票", "入场门票", 25.5), pool(unit(12, 60, 5))],
  players: [{ sessions: [
    session("s-ticket", "2026-09-13T13:00:00.000Z", null, "ticket", { label: "entry" }),
    session("s-pool", "2026-09-13T13:05:00.000Z", null, "pool", { label: "台球桌 3" }),
  ] }],
}));

const mahjong = timePlan("mahjong", "麻将", [
  rule("day", "日间", "08:00", "20:00", unit(6, 30, 5)),
  rule("night", "夜间", "20:00", "08:00", unit(9, 30, 5, 50)),
]);
await preview("preview-parallel-sessions", snapshotOf({
  capturedAt: "2026-09-13T21:15:00.000Z",
  configs: [pool(unit(12, 60, 5)), mahjong],
  players: [{ sessions: [
    session("s-a", "2026-09-13T18:40:00.000Z", null, "pool"),
    session("s-b", "2026-09-13T19:10:00.000Z", null, "mahjong"),
  ] }],
}));

await preview("preview-cross-plan-cap", snapshotOf({
  capturedAt: "2026-09-13T16:00:00.000Z",
  configs: [pool(unit(12, 60, 5)), mahjong, capPlan("daily-cap", "每日封顶", [capRule("all", "全天", "00:00", "00:00", 50)])],
  players: [{
    sessions: [
      session("s-a", "2026-09-13T11:00:00.000Z", null, "pool"),
      session("s-b", "2026-09-13T12:30:00.000Z", null, "mahjong"),
    ],
    capPaidHistory: { "daily-cap@all@2026-09-13T00:00:00.000Z": 1500 },
  }],
}));

await preview("preview-two-overlapping-caps", snapshotOf({
  capturedAt: "2026-09-13T23:40:00.000Z",
  configs: [pool(unit(12, 60, 5)), mahjong,
    capPlan("daily-cap", "每日封顶", [capRule("all", "全天", "00:00", "00:00", 70)]),
    capPlan("evening-cap", "晚间封顶", [capRule("evening", "晚间", "18:00", "22:00", 25)]),
  ],
  players: [{ sessions: [
    session("s-a", "2026-09-13T16:00:00.000Z", null, "pool"),
    session("s-b", "2026-09-13T17:45:00.000Z", null, "mahjong"),
  ] }],
}));

await preview("preview-period-and-cross-cap", snapshotOf({
  capturedAt: "2026-09-13T16:00:00.000Z",
  configs: [
    timePlan("pool", "台球", [allDay(unit(10, 30, 0, 80))]),
    capPlan("lunch-cap", "午间封顶", [capRule("lunch", "午间", "12:00", "14:00", 20)]),
  ],
  players: [{
    sessions: [session("s-long", "2026-09-13T11:00:00.000Z", null, "pool")],
    pricingPaidHistory: { "pool@pool-provider@all-day@2026-09-13T00:00:00.000Z": 500 },
  }],
}));

const definition = (type: string, code: string, name: string, effect: Record<string, unknown> | null, extra: Partial<AssetDefinition> = {}): AssetDefinition => ({
  type, code, name, stackable: true, status: "active", pricingEffectId: effect ? String(effect.id) : null,
  pricingEffect: effect ? { scope: "session", value: null, consumable: false, limitPerDay: null, activeAt: null, expiresAt: null, status: "active", config: null, ...effect } as any : null,
  activeAt: null, expiresAt: null, metadata: null, ...extra,
});
const holding = (id: string, assetType: string, assetCode: string, quantity: number, extra: Partial<AssetHolding> = {}): AssetHolding =>
  ({ id, assetType, assetCode, quantity, activeAt: null, expiresAt: null, ...extra });

await preview("preview-asset-effects", snapshotOf({
  capturedAt: "2026-09-13T16:00:00.000Z",
  configs: [pool(unit(12, 60, 5)), mahjong],
  definitions: [
    definition("currency", "paid", "余额", null),
    definition("currency", "free", "赠送余额", null),
    definition("coupon", "hour-off", "一小时券", { id: "eff-hour", name: "减 5 元", type: "discount", scope: "session", value: 5, consumable: true, limitPerDay: 1, config: { applicablePricingConfigIds: ["pool"] } }),
    definition("membership", "vip", "VIP 九折", { id: "eff-vip", name: "九折", type: "percentage-discount", scope: "unified", value: 10, config: { minSubtotal: 10, daysOfWeek: [7, 1, 2, 3, 4, 5, 6] } }),
    definition("coupon", "weekday-free", "工作日免单", { id: "eff-free", name: "免单", type: "free", scope: "session", config: { daysOfWeek: [1, 2, 3, 4, 5] } }),
    definition("coupon", "expired", "过期券", { id: "eff-old", name: "过期", type: "discount", value: 3, expiresAt: new Date("2026-09-01T00:00:00Z") }),
  ],
  players: [{
    sessions: [
      session("s-a", "2026-09-13T11:00:00.000Z", "2026-09-13T13:30:00.000Z", "pool"),
      session("s-b", "2026-09-13T13:40:00.000Z", null, "pool"),
      session("s-c", "2026-09-13T14:00:00.000Z", null, "mahjong"),
    ],
    holdings: [
      holding("h-paid", "currency", "paid", 10_000),
      holding("h-free", "currency", "free", 500),
      holding("h-coupon", "coupon", "hour-off", 1),
      holding("h-vip", "membership", "vip", 1),
      holding("h-free-coupon", "coupon", "weekday-free", 2),
      holding("h-old", "coupon", "expired", 1),
      holding("h-future", "currency", "paid", 300, { activeAt: new Date("2026-10-01T00:00:00Z") }),
    ],
    pastAppliedAdjustments: [{ source: "coupon.hour-off", sessionStartedAt: new Date("2026-09-12T10:00:00Z") }],
  }],
}));

await preview("preview-asset-limit-per-day", snapshotOf({
  capturedAt: "2026-09-14T16:00:00.000Z",
  configs: [pool(unit(12, 60, 5))],
  definitions: [
    definition("currency", "paid", "余额", null),
    definition("coupon", "daily", "每日一券", { id: "eff-daily", name: "减 3 元", type: "discount", value: 3, limitPerDay: 1 }),
    definition("membership", "gold", "金卡", { id: "eff-gold", name: "八五折", type: "percentage-discount", scope: "unified", value: 15, limitPerDay: 2 }),
  ],
  players: [{
    sessions: [session("s-a", "2026-09-14T12:00:00.000Z", null, "pool")],
    holdings: [holding("h-paid", "currency", "paid", 1_000), holding("h-daily", "coupon", "daily", 3), holding("h-gold", "membership", "gold", 1)],
    pastAppliedAdjustments: [
      { source: "coupon.daily", sessionStartedAt: new Date("2026-09-14T08:00:00Z") },
      { source: "membership.gold", sessionStartedAt: new Date("2026-09-14T09:00:00Z") },
    ],
  }],
}));

await preview("preview-closed-unpaid-and-active", snapshotOf({
  capturedAt: "2026-09-13T18:00:00.000Z",
  configs: [pool(unit(12, 60, 5)), mahjong],
  players: [{
    sessions: [
      session("s-closed", "2026-09-13T10:00:00.000Z", "2026-09-13T12:20:00.000Z", "pool"),
      session("s-paid", "2026-09-13T08:00:00.000Z", "2026-09-13T09:00:00.000Z", "pool", { paymentStatus: "paid" }),
      session("s-active", "2026-09-13T16:45:00.000Z", null, "mahjong"),
    ],
    holdings: [holding("h-paid", "currency", "paid", 2_000)],
  }],
  definitions: [definition("currency", "paid", "余额", null)],
}));

// America/New_York, spring forward (2026-03-08 02:00 EST → 03:00 EDT): rules on the shop clock via the release zone.
const nyRelease = (configs: PricingConfig[]): PricingRelease => ({ id: "release-ny", timeZone: "America/New_York", configs });
await preview("preview-new-york-dst-spring", snapshotOf({
  capturedAt: "2026-03-08T08:10:00.000Z",
  releases: [nyRelease([
    timePlan("pool", "Pool", [rule("night", "Night", "22:00", "06:00", unit(10, 30, 5, 70)), rule("day", "Day", "06:00", "22:00", unit(8, 30, 5))]),
    capPlan("daily-cap", "Daily cap", [capRule("all", "All day", "00:00", "00:00", 60)]),
  ])],
  players: [{ sessions: [session("s-ny", "2026-03-08T05:30:00.000Z", null, "pool", { pricingReleaseId: "release-ny" })] }],
}));

// Fall back (2026-11-01 02:00 EDT → 01:00 EST): the 01:00–02:00 hour happens twice.
await preview("preview-new-york-dst-fall", snapshotOf({
  capturedAt: "2026-11-01T08:00:00.000Z",
  releases: [nyRelease([
    timePlan("pool", "Pool", [
      rule("base", "All day", "00:00", "00:00", unit(6, 60, 0)),
      rule("late", "Late", "01:00", "02:00", unit(9, 30, 0, 20), { priority: 2 }),
    ]),
  ])],
  players: [{ sessions: [session("s-ny", "2026-11-01T04:30:00.000Z", null, "pool", { pricingReleaseId: "release-ny" })] }],
}));

// A pinned Asia/Shanghai release: weekday and specific-date rules, versioned history keys.
await preview("preview-shanghai-release-versioned", snapshotOf({
  capturedAt: "2026-09-13T14:30:00.000Z",
  configs: [pool(unit(99, 60, 0))],
  releases: [{
    id: "release-sh", timeZone: "Asia/Shanghai", configs: [
      timePlan("pool", "台球", [
        rule("weekday", "工作日", "10:00", "22:00", unit(12, 60, 5, 60), { weekdays: [1, 2, 3, 4, 5] }),
        rule("weekend", "周末", "10:00", "22:00", unit(15, 60, 5, 80), { weekdays: [0, 6] }),
        rule("holiday", "节日", "18:00", "23:00", unit(20, 30, 5), { priority: 5, specificDates: ["2026-09-13"] }),
        rule("late", "夜场", "22:00", "02:00", unit(18, 60, 5)),
      ], { versionId: "pool-v3", version: 3 }),
      timePlan("legacy", "旧台球", [allDay(unit(10, 60, 0, 30))], {}, { historyProviderId: "legacy-original" }),
    ],
  }],
  players: [{
    sessions: [
      session("s-sh", "2026-09-13T08:30:00.000Z", null, "pool", { pricingReleaseId: "release-sh" }),
      session("s-legacy", "2026-09-13T09:00:00.000Z", null, "legacy", { pricingReleaseId: "release-sh" }),
    ],
    pricingPaidHistory: {
      "pool@pool-v3@weekend@2026-09-13T02:00:00.000Z": 2000,
      "legacy@legacy-original@all-day@2026-09-12T16:00:00.000Z": 1200,
    },
  }],
}));

// Migrated rules: an absolute anchor with an original rule id, and a dated special that wins by priority.
await preview("preview-anchor-and-date-range", snapshotOf({
  capturedAt: "2026-09-13T20:00:00.000Z",
  configs: [timePlan("pool", "台球", [
    rule("day-utc-a", "日间", "02:00", "14:00", unit(12, 60, 5, 50), { historyRuleId: "day", anchorAt: new Date("2026-09-13T02:00:00.000Z") }),
    rule("evening", "晚间", "14:00", "02:00", unit(14, 60, 5)),
    { id: "promo", label: "特惠", priority: 9, dateTimeRange: { start: new Date("2026-09-13T15:00:00.000Z"), end: new Date("2026-09-13T17:30:00.000Z") }, pricing: unit(5, 30, 0) },
    rule("old", "停用", "00:00", "00:00", unit(1, 60, 0), { status: "archived", priority: 99 }),
  ])],
  players: [{
    sessions: [session("s-mig", "2026-09-13T12:00:00.000Z", null, "pool")],
    pricingPaidHistory: { "pool@pool-provider@day@2026-09-13T02:00:00.000Z": 1200 },
  }],
}));

await preview("preview-negative-unit-price", snapshotOf({
  capturedAt: "2026-09-13T12:00:00.000Z",
  configs: [
    timePlan("pool", "台球", [allDay(unit(6, 30, 2, 100))]),
    timePlan("member-discount", "会员立减", [allDay(unit(-1, 30, 2, 100))]),
    capPlan("cap", "全天优惠", [capRule("all", "Combined", "00:00", "00:00", 20)]),
  ],
  players: [{ sessions: [
    session("s-one", "2026-09-13T08:00:00.000Z", null, "pool"),
    session("s-two", "2026-09-13T08:30:00.000Z", "2026-09-13T10:30:00.000Z", "member-discount"),
    session("s-three", "2026-09-13T11:00:00.000Z", null, "pool"),
  ] }],
}));

// Units beginning together are ordered by session id and plan with localeCompare (case and
// punctuation matter), which decides who a binding cap holds back. Plus an unpriced placeholder visit.
await preview("preview-same-start-ordering-and-placeholder", snapshotOf({
  capturedAt: "2026-09-13T15:00:00.000Z",
  configs: [pool(unit(12, 60, 5)), mahjong, capPlan("daily-cap", "每日封顶", [capRule("all", "全天", "00:00", "00:00", 30)])],
  players: [{ sessions: [
    session("Visit-B", "2026-09-13T12:00:00.000Z", null, "pool"),
    session("visit_a", "2026-09-13T12:00:00.000Z", null, "mahjong"),
    session("visit-A", "2026-09-13T12:00:00.000Z", null, "pool"),
    session("entry-visit", "2026-09-13T11:58:00.000Z", null, "default", { label: "entry", pricingConfigIds: ["default"] }),
  ] }],
}));

// Holdings without ids: offers are keyed by their position; a consumable one is used up by the first visit.
await preview("preview-asset-holdings-without-ids", snapshotOf({
  capturedAt: "2026-09-13T16:00:00.000Z",
  configs: [pool(unit(12, 60, 5))],
  definitions: [
    definition("currency", "paid", "余额", null),
    definition("coupon", "five", "五元券", { id: "eff-five", name: "减 5 元", type: "discount", value: 5, consumable: true }),
    definition("coupon", "all-free", "免单券", { id: "eff-all", name: "免单", type: "free", scope: "unified", consumable: true, config: { minSubtotal: 50 } }),
  ],
  players: [{
    sessions: [
      session("s-1", "2026-09-13T10:00:00.000Z", "2026-09-13T11:00:00.000Z", "pool"),
      session("s-2", "2026-09-13T12:00:00.000Z", null, "pool"),
    ],
    holdings: [
      { assetType: "currency", assetCode: "paid", quantity: 800, activeAt: null, expiresAt: null },
      { assetType: "coupon", assetCode: "five", quantity: 1, activeAt: null, expiresAt: null },
      { assetType: "coupon", assetCode: "all-free", quantity: 1, activeAt: null, expiresAt: null },
    ],
  }],
}));

await preview("preview-error-no-sessions", snapshotOf({
  capturedAt: "2026-09-13T12:00:00.000Z",
  configs: [pool(unit(12))],
  players: [{ sessions: [session("s-paid", "2026-09-13T08:00:00.000Z", "2026-09-13T09:00:00.000Z", "pool", { paymentStatus: "paid" })] }],
}));

await preview("preview-error-release-mismatch", snapshotOf({
  capturedAt: "2026-09-13T12:00:00.000Z",
  releases: [
    { id: "r1", timeZone: "UTC", configs: [pool(unit(12))] },
    { id: "r2", timeZone: "UTC", configs: [pool(unit(14))] },
  ],
  players: [{ sessions: [
    session("s-1", "2026-09-13T08:00:00.000Z", null, "pool", { pricingReleaseId: "r1" }),
    session("s-2", "2026-09-13T09:00:00.000Z", null, "pool", { pricingReleaseId: "r2" }),
  ] }],
}));

await preview("preview-error-player-not-found", snapshotOf({
  capturedAt: "2026-09-13T12:00:00.000Z",
  configs: [pool(unit(12))],
  players: [{ sessions: [] }],
}), "someone-else");

// ── Timeline scenarios (application/test/bill-timeline.test.ts) ────────────

{
  const date = (clock: string) => new Date(`2026-09-13T${clock}:00Z`);
  const pricing = (unitPrice: number) => ({ unitPrice, unitMinutes: 30, roundGraceMinutes: 2, priceCap: 100 });
  const s = (id: string, start: string, end: string | null): Session =>
    ({ id, playerId: "test", label: id, status: end ? "closed" : "active", startedAt: date(start), endedAt: end ? date(end) : null } as unknown as Session);

  timeline("timeline-entry-marker", {
    at: date("12:00"), sessions: [{ sessionId: "visit", label: "entry", startedAt: date("11:00"), endedAt: null, chargeItems: [] }],
    adjustments: [], globalCapWindows: [],
  });

  {
    const at = date("12:00");
    const rules = (price: number) => [
      { id: "night", label: "A", priority: 1, timeRange: { start: "22:00", end: "09:15" }, pricing: pricing(price) },
      { id: "day", label: "B", priority: 1, timeRange: { start: "09:15", end: "22:00" }, pricing: pricing(price) },
    ];
    const sessions = await Promise.all([s("one", "08:00", null), s("two", "08:30", "10:30"), s("three", "11:00", null)].map(async (x, i) => ({
      sessionId: x.id, label: x.label ?? null, startedAt: x.startedAt, endedAt: x.endedAt ?? null,
      chargeItems: await createPriorityTimePricingProvider({ id: `p${i}`, name: `Plan ${i}`, rules: rules(i === 1 ? -1 : 6), timeZone: "UTC" }).quote({ session: x, now: at, assetHoldings: [] }),
    })));
    const chargeItems = sessions.flatMap((x) => x.chargeItems);
    const config = { id: "cap", name: "全天优惠", includedPricingConfigIds: ["p0", "p1", "p2"], timeZone: "UTC", rules: [{ id: "all", label: "Combined", priority: 1, timeRange: { start: "00:00", end: "00:00" }, priceCap: 20 }] };
    timeline("timeline-signed-charges-shared-cap", { at, sessions, adjustments: applyTimeCapPricing({ config, chargeItems }), globalCapWindows: explainTimeCapPricing({ config, chargeItems }) });
  }

  {
    const start = new Date("2026-09-12T23:00:00Z"), at = date("01:00");
    const x = { ...s("night", "00:00", null), startedAt: start };
    const items = await createPriorityTimePricingProvider({ id: "night", rules: [{ id: "night", label: "Night", priority: 1, timeRange: { start: "22:00", end: "10:00" }, pricing: pricing(6) }], timeZone: "UTC" }).quote({ session: x, now: at, assetHoldings: [] });
    timeline("timeline-overnight-and-empty-session", { at, sessions: [{ sessionId: x.id, label: null, startedAt: start, endedAt: null, chargeItems: items }, { sessionId: "empty", label: "Empty", startedAt: start, endedAt: at, chargeItems: [] }], adjustments: [], globalCapWindows: [] });
  }

  {
    const startedAt = date("12:45");
    timeline("timeline-rounded-active-tail", {
      at: new Date("2026-09-13T13:33:42Z"),
      sessions: [{ sessionId: "active", label: "Plan", startedAt, endedAt: null, chargeItems: [{ id: "item", sessionId: "active", source: "plan", label: "日间", amount: centsOf(2), period: { startedAt, endedAt: new Date("2026-09-13T13:33:00Z") } }] }],
      adjustments: [], globalCapWindows: [],
    });
  }

  {
    const at = date("03:54");
    const x = s("gap", "02:08", null);
    const items = await createPriorityTimePricingProvider({ id: "night", rules: [{ id: "night", label: "Night", priority: 1, timeRange: { start: "10:00", end: "03:00" }, pricing: pricing(18) }], timeZone: "Asia/Shanghai" }).quote({ session: x, now: at, assetHoldings: [] });
    timeline("timeline-closed-gap-shanghai", { at, sessions: [{ sessionId: x.id, label: null, startedAt: date("02:08"), endedAt: null, chargeItems: items }], adjustments: [], globalCapWindows: [] });
  }

  {
    const at = date("02:00");
    const start = new Date("2026-09-12T22:00:00Z");
    const night = (id: string, unitPrice: number) => createPriorityTimePricingProvider({
      id, name: id, timeZone: "UTC",
      rules: [{ id: "night", label: "夜场", priority: 1, timeRange: { start: "22:00", end: "10:00" }, pricing: { unitPrice, unitMinutes: 60, roundGraceMinutes: 0, priceCap: 0 } }],
    });
    const sessions = await Promise.all(([["entry", 6], ["rhythm", 3]] as const).map(async ([id, price]) => {
      const x = { ...s(id, "00:00", null), startedAt: start };
      return { sessionId: x.id, label: x.label ?? null, startedAt: start, endedAt: null, chargeItems: await night(id, price).quote({ session: x, now: at, assetHoldings: [] }) };
    }));
    const chargeItems = sessions.flatMap((x) => x.chargeItems.map((item) => ({ ...item, sessionId: x.sessionId })));
    const config = { id: "cap", name: "分段封顶", includedPricingConfigIds: ["entry", "rhythm"], timeZone: "UTC",
      paidHistory: { "cap@night@2026-09-12T22:00:00.000Z": centsOfInteger(1000) },
      rules: [{ id: "night", label: "夜间", priority: 1, timeRange: { start: "22:00", end: "10:00" }, priceCap: 30 }] };
    timeline("timeline-full-cap-holds-tracks", { at, sessions, adjustments: applyTimeCapPricing({ config, chargeItems }), globalCapWindows: explainTimeCapPricing({ config, chargeItems }) });
  }

  {
    // Fixed charges and offers only: the fallback zone lays the bill out.
    const at = new Date("2026-03-08T07:30:00Z");
    timeline("timeline-fixed-only-new-york-fallback", {
      at, timeZone: "America/New_York",
      sessions: [{ sessionId: "ticket", label: "entry", startedAt: new Date("2026-03-08T06:45:00Z"), endedAt: null,
        chargeItems: [{ id: "ticket:fixed", source: "fixed", label: "门票", amount: centsOf(30) }] }],
      adjustments: [
        { id: "ticket:asset-definition:coupon:c:discount", source: "coupon.c", label: "优惠券", amount: centsOf(-5) },
        { id: "zero", source: "x", label: "零", amount: 0 as any },
      ],
      globalCapWindows: [],
    });
  }
}

// ── Day segments (the scan page) ────────────────────────────────────────────

segments("segments-utc-rules-shanghai", timePlan("pool", "台球", [
  rule("day", "日间", "02:00", "14:00", unit(12, 60, 5, 60)),
  rule("late", "夜场", "14:00", "18:00", unit(18, 30, 5)),
]), "2026-09-13", "Asia/Shanghai");

segments("segments-allday-shanghai", timePlan("pool", "台球", [rule("all", "全天", "16:00", "16:00", unit(10, 60, 0, 88))]), "2026-09-13", "Asia/Shanghai");

segments("segments-overnight-and-closed", timePlan("pool", "台球", [
  rule("noon", "午市", "02:00", "06:00", unit(10, 30, 0)),
  rule("night", "夜场", "14:00", "18:00", unit(16, 30, 0, 50)),
]), "2026-09-13", "Asia/Shanghai");

segments("segments-weekday-shift", timePlan("pool", "台球", [
  rule("weekday", "工作日早场", "20:00", "23:00", unit(8, 60, 0), { weekdays: [1, 2, 3, 4, 5] }),
  rule("base", "平时", "23:00", "20:00", unit(12, 60, 0)),
]), "2026-09-12", "Asia/Shanghai");

segments("segments-specific-dates", timePlan("pool", "台球", [
  rule("holiday", "中秋", "10:00", "16:00", unit(20, 60, 0), { specificDates: ["2026-09-25", "2026-09-26"], priority: 5 }),
  rule("base", "平时", "00:00", "00:00", unit(12, 60, 0)),
]), "2026-09-25", "Asia/Tokyo");

segments("segments-cap-window-reset", capPlan("daily-cap", "每日封顶", [
  capRule("day", "日封顶", "22:00", "22:00", 66.666),
]), "2026-09-13", "Asia/Shanghai");

segments("segments-cap-two-windows", capPlan("split-cap", "分段封顶", [
  capRule("night", "夜间", "14:00", "02:00", 40),
  capRule("day", "白天", "02:00", "14:00", 30),
]), "2026-09-13", "Asia/Shanghai");

segments("segments-new-york-dst-spring", timePlan("pool", "Pool", [
  rule("day", "Day", "11:00", "03:00", unit(9.999, 30, 3, 33.333)),
  rule("night", "Night", "03:00", "11:00", unit(6.666, 60, 0)),
]), "2026-03-08", "America/New_York");

segments("segments-new-york-dst-fall", timePlan("pool", "Pool", [
  rule("day", "Day", "10:00", "02:00", unit(9, 30, 3, 40)),
  rule("night", "Night", "02:00", "10:00", unit(6, 60, 0)),
]), "2026-11-01", "America/New_York");

segments("segments-new-york-shop-clock-on-dst-day", timePlan("pool", "Pool", [
  rule("late", "Late", "05:00", "07:00", unit(7, 30, 0), { priority: 2 }),
  rule("base", "All day", "00:00", "00:00", unit(5, 60, 0)),
], {}, { timeZone: "America/New_York" }), "2026-03-08", "America/New_York");

segments("segments-date-time-range", timePlan("pool", "台球", [
  { id: "promo", label: "特惠", priority: 9, dateTimeRange: { start: new Date("2026-09-13T04:00:00.000Z"), end: new Date("2026-09-13T09:30:00.000Z") }, pricing: unit(5, 30, 0) },
  rule("old", "停用", "00:00", "00:00", unit(1, 60, 0), { status: "archived", priority: 99 }),
  rule("base", "平时", "00:00", "00:00", unit(12, 60, 0)),
]), "2026-09-13", "Asia/Shanghai");

segments("segments-tokyo-provider-zone", timePlan("pool", "台球", [
  rule("day", "日間", "09:00", "21:00", unit(800, 60, 0)),
], {}, { timeZone: "Asia/Tokyo" }), "2026-09-13", "Asia/Shanghai");

segments("segments-utc-display", timePlan("pool", "台球", [
  rule("day", "日间", "02:00", "14:00", unit(12.345, 60, 5, 0)),
]), "2026-09-13", "UTC");

segments("segments-anchor-at", timePlan("pool", "台球", [
  rule("day-utc", "日间", "02:00", "14:00", unit(12, 60, 5, 60), { anchorAt: new Date("2026-09-13T02:00:00.000Z"), historyRuleId: "day" }),
]), "2026-09-13", "Asia/Shanghai");

segments("segments-fixed-charge", fixedPlan("ticket", "门票", "入场门票", 25), "2026-09-13", "Asia/Shanghai");

segments("segments-error-dates-across-offsets", timePlan("pool", "Pool", [
  rule("special", "Special", "15:00", "18:00", unit(9, 60, 0), { specificDates: ["2026-03-07", "2026-03-09"] }),
]), "2026-03-07", "America/New_York");

segments("segments-error-negative-cap", timePlan("pool", "台球", [rule("day", "日间", "02:00", "14:00", unit(12, 60, 0, -1))]), "2026-09-13", "Asia/Shanghai");

console.log(`wrote ${written.length} fixtures to ${outDir}`);
