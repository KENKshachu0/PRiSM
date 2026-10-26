import { describe, expect, test } from "bun:test";
import type { PricingConfig } from "@prism/core";
import { simulateBilling } from "../src/billing-simulator";

const date = new Date("2026-10-09T00:00:00Z");
const plan = (id: string, unitPrice: number): PricingConfig => ({
  id,
  kind: "time.priority",
  name: id,
  enabled: true,
  status: "active",
  createdAt: date,
  updatedAt: date,
  provider: {
    id,
    timeZone: "UTC",
    rules: [{
      id: "all",
      label: "全天",
      priority: 1,
      timeRange: { start: "00:00", end: "00:00" },
      pricing: { unitMinutes: 60, unitPrice, roundGraceMinutes: 0, priceCap: 1000 },
    }],
  },
});
const cap = (value: number): PricingConfig => ({
  id: "cap",
  kind: "time.cap",
  name: "叠加封顶",
  enabled: true,
  status: "active",
  createdAt: date,
  updatedAt: date,
  provider: {
    id: "cap",
    timeZone: "UTC",
    // As stored today: a cap holds every time plan and names none.
    includedPricingConfigIds: [],
    rules: [{ id: "all", label: "全天", priority: 1, timeRange: { start: "00:00", end: "00:00" }, priceCap: value }],
  },
});
const sessions = [
  { startedAt: "2026-10-09T10:30:00Z", endedAt: "2026-10-09T11:30:00Z", pricingConfigId: "b" },
  { startedAt: "2026-10-09T10:00:00Z", endedAt: "2026-10-09T11:00:00Z", pricingConfigId: "a" },
];

describe("read-only overlapping Session billing simulation", () => {
  test("admission and departure are derived from the list, not its order", async () => {
    const configs = [plan("a", 10), plan("b", 20)];
    const original = JSON.stringify(configs);
    const result = await simulateBilling({ sessions, pricingConfigs: configs });
    expect(result.admissionAt).toBe("2026-10-09T10:00:00.000Z");
    expect(result.departureAt).toBe("2026-10-09T11:30:00.000Z");
    expect(result.subtotal).toBe(30);
    expect(result.total).toBe(30);
    expect(result.timeline.tracks).toHaveLength(2);
    expect(new Set(result.timeline.tracks.map(track => track.lane)).size).toBe(2);
    expect(result.timeline.events.some(event => event.at === result.admissionAt)).toBe(true);
    expect(result.timeline.events.some(event => event.at === result.departureAt)).toBe(true);
    expect(JSON.stringify(configs)).toBe(original);
  });

  test("applies the same global cap across both sessions without double counting", async () => {
    const result = await simulateBilling({ sessions, pricingConfigs: [plan("a", 10), plan("b", 20), cap(25)] });
    expect(result.subtotal).toBe(30);
    expect(result.total).toBe(25);
    // The cap is a ceiling, not a discount line: the plans under it simply add up to the capped total.
    expect(result.timeline.totals.every(row => row.amount > 0)).toBe(true);
    expect(result.timeline.totals.reduce((sum, row) => sum + row.amount, 0)).toBeCloseTo(25, 2);
    // The cap filling is an event of its own; the charge stops there.
    expect(result.timeline.events.flatMap(event => event.entries).some(entry => entry.kind === "full" && entry.trackId == null)).toBe(true);
  });

  test("a cap stored without a plan list still caps every time plan, as settlement does", async () => {
    // One plan, one cap: 5 hours at 10 is 50, capped at 20.
    const single = [{ startedAt: "2026-10-09T00:00:00Z", endedAt: "2026-10-09T05:00:00Z", pricingConfigId: "a" }];
    const result = await simulateBilling({ sessions: single, pricingConfigs: [plan("a", 10), cap(20)] });
    expect(result.subtotal).toBe(50);
    expect(result.total).toBe(20);
  });

  test("charges each session independently, including fixed plans", async () => {
    const fixed: PricingConfig = {
      id: "fixed",
      kind: "charge.fixed",
      name: "固定收费",
      enabled: true,
      createdAt: date,
      updatedAt: date,
      provider: { id: "fixed", label: "入场服务费", amount: 7.5 },
    };
    const result = await simulateBilling({
      sessions: [
        { ...sessions[0]!, pricingConfigId: "fixed" },
        { ...sessions[1]!, pricingConfigId: "fixed" },
      ],
      pricingConfigs: [fixed],
    });
    expect(result.subtotal).toBe(15);
    expect(result.total).toBe(15);
    expect(result.timeline.tracks).toHaveLength(2);
  });

  test("rejects invalid intervals, missing offsets, archived or cap-only plans, and excessively long spans", async () => {
    const configs = [plan("a", 10), plan("b", 20), cap(25)];
    const quote = (rows: typeof sessions) => simulateBilling({ sessions: rows, pricingConfigs: configs });
    await expect(quote([])).rejects.toThrow();
    await expect(quote([{ ...sessions[0]!, endedAt: sessions[0]!.startedAt }])).rejects.toThrow();
    await expect(quote([{ ...sessions[0]!, startedAt: "2026-10-09T10:30" }])).rejects.toThrow();
    await expect(quote([{ ...sessions[0]!, pricingConfigId: "cap" }])).rejects.toThrow();
    await expect(quote([{ ...sessions[0]!, pricingConfigId: "nonexistent" }])).rejects.toThrow();
    await expect(quote([{ ...sessions[0]!, endedAt: "2026-12-09T12:00:00Z" }])).rejects.toThrow();
    await expect(simulateBilling({ sessions, pricingConfigs: configs.map(config => ({ ...config, enabled: false })) })).rejects.toThrow();
  });
});
