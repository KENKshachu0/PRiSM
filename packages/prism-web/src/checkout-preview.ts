import {
  previewBillTimeline,
  type PreviewPlayerCheckoutResult,
} from "@prism/application";
import { yuanOf } from "@prism/core";

/** A display-only quote; the server never accepts this result as a debit instruction. */
export function checkoutPreviewView(result: PreviewPlayerCheckoutResult) {
  const item = (item: PreviewPlayerCheckoutResult["chargeItems"][number]) => ({
    id: item.id,
    label: item.label,
    amount: yuanOf(item.amount),
  });
  return {
    timeline: previewBillTimeline(result),
    settlementPreview: {
      ...result.settlementPreview,
      subtotal: yuanOf(result.settlementPreview.subtotal),
      total: yuanOf(result.settlementPreview.total),
      previewedAt: result.settlementPreview.previewedAt.toISOString(),
    },
    chargeItems: result.chargeItems.map(item),
    adjustments: result.adjustments.map(item),
    wallet: {
      balanceBefore: yuanOf(result.wallet.balanceBefore),
      balanceAfter: yuanOf(result.wallet.balanceAfter),
    },
  };
}
export type BrowserCheckoutPreview = ReturnType<typeof checkoutPreviewView>;
