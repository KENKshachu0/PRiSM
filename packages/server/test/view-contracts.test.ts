import { describe, expect, it } from "bun:test";
import { centsOf, type BillTimeline, type PricingConfig } from "@prism/core";
import type { PreviewPlayerCheckoutResult, SettlePlayerCheckoutResult } from "@prism/application";
import { previewBillTimeline } from "@prism/application";
import {
  toPlayerCheckoutPreviewView,
  toPlayerCheckoutResultView,
  toPricingConfigManagementView,
} from "../src/routes/shops/views.js";

/**
 * Serializers changed after the pre-merge freeze (see
 * docs/server-api-regression-contract.md): each keeps every field it had and
 * only adds the documented ones, so clients built against the old responses
 * (the App Clip, the Koishi bot, older web builds) keep working.
 */
describe("serializers changed after the freeze stay supersets of what they were", () => {
  const at = new Date("2026-10-25T10:00:00.000Z");
  const config = (kind: PricingConfig["kind"]): PricingConfig => ({
    id: "plan", versionId: "plan-v1", version: 1, kind, name: "Plan", enabled: true, status: "active",
    provider: kind === "charge.fixed"
      ? { id: "plan", label: "Ticket", amount: 5 }
      : { id: "plan", timeZone: "UTC", rules: [{ id: "day", label: "Day", priority: 1, timeRange: { start: "00:00", end: "00:00" },
          ...(kind === "time.cap" ? { priceCap: 10 } : { pricing: { unitMinutes: 60, unitPrice: 12, roundGraceMinutes: 5, priceCap: 0 } }) }] },
    ...(kind === "time.priority" ? { relations: { requires: ["base"], conflicts: [] } } : {}),
    createdAt: at, updatedAt: at,
  } as PricingConfig);

  it("pricing config: adds relations, for time plans only", () => {
    const before = ["id", "versionId", "version", "kind", "name", "enabled", "status", "provider", "createdAt", "updatedAt"];
    const time = toPricingConfigManagementView(config("time.priority"));
    expect(Object.keys(time)).toEqual(expect.arrayContaining(before));
    expect(time.relations).toEqual({ requires: ["base"], conflicts: [] });
    for (const kind of ["charge.fixed", "time.cap"] as const) {
      const view = toPricingConfigManagementView(config(kind));
      expect(Object.keys(view)).toEqual(expect.arrayContaining(before));
      expect(view).not.toHaveProperty("relations");
    }
  });

  const session = { sessionId: "s", label: null, startedAt: at, endedAt: null, status: "active" as const, subtotal: centsOf(0), total: centsOf(0), chargeItems: [], adjustments: [] };

  it("checkout preview: the timeline is the preview's bill", () => {
    const result: PreviewPlayerCheckoutResult = {
      settlementPreview: { playerId: "p", sessionIds: ["s"], subtotal: centsOf(0), total: centsOf(0), status: "preview", previewedAt: at },
      sessionPreviews: [session], chargeItems: [], adjustments: [], checkoutAdjustments: [], pricingCapAdjustments: [],
      wallet: { balanceBefore: centsOf(0), balanceAfter: centsOf(0) }, globalCapWindows: [],
    };
    const view = toPlayerCheckoutPreviewView(result);
    expect(Object.keys(view).sort()).toEqual(["adjustments", "chargeItems", "checkoutAdjustments", "globalCapWindows", "pricingCapAdjustments", "sessionPreviews", "settlementPreview", "timeline", "wallet"]);
    expect(view.timeline).toEqual(previewBillTimeline(result));
  });

  it("checkout result: the timeline is the one persisted with the checkout", () => {
    const timeline: BillTimeline = { pricingReleaseIds: ["release"], totals: [], tracks: [], events: [] };
    const result: SettlePlayerCheckoutResult = {
      playerSettlement: { playerId: "p", sessionIds: ["s"], subtotal: centsOf(0), total: centsOf(0), status: "settled", settledAt: at },
      settlements: [], sessionDetails: [{ sessionId: "s", label: null, startedAt: at, endedAt: at }],
      chargeItems: [], adjustments: [], checkoutAdjustments: [], pricingCapAdjustments: [], assetLedgerEntries: [],
      wallet: { balanceBefore: centsOf(0), balanceAfter: centsOf(0) }, globalCapWindows: [], timeline,
    };
    const view = toPlayerCheckoutResultView(result);
    expect(Object.keys(view)).toEqual(expect.arrayContaining(["timeline", "playerSettlement", "settlements", "chargeItems", "adjustments", "checkoutAdjustments", "pricingCapAdjustments", "globalCapWindows", "assetLedgerEntries", "wallet"]));
    expect(view.timeline).toBe(timeline);
  });
});
