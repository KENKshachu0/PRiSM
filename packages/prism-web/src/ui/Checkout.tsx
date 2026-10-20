import { useNotice } from "./NoticeProvider";
import { displayDateTime } from "./bill-time";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { playerOperation } from "../api";
import { useI18n } from "../i18n";
import { operationLocation, shopApi, type ShopInfo } from "./BillingPages";
import { BillTimeline, BillTotal, type BillPreview } from "./BillTimeline";

export type Receipt = Omit<BillPreview, "settlementPreview"> & { playerSettlement: { total: number; settledAt: string }; wallet?: { balanceAfter: number } | null };

export function SettledBill({ receipt, timeZone }: { receipt: Receipt; timeZone?: string }) {
  const { t } = useI18n();
  const bill = { ...receipt, settlementPreview: receipt.playerSettlement };
  return <div className="grid gap-5">
    <div className="receipt-status"><span aria-hidden="true">✓</span><div><h2>{t("结账成功")}</h2><p>{displayDateTime(receipt.playerSettlement.settledAt, timeZone)}</p></div></div>
    <BillTotal preview={bill} />
    {receipt.wallet && <div className="receipt-balance"><span>{t("结账后余额")}</span><strong>{receipt.wallet.balanceAfter.toFixed(2)}</strong></div>}
    <BillTimeline preview={bill} timeZone={timeZone} />
  </div>;
}

export function CheckoutButton({ info, onComplete, onPendingChange }: { info: ShopInfo; onComplete: (receipt: Receipt) => void; onPendingChange?: (pending: boolean) => void }) {
  const { t } = useI18n();
  const showNotice = useNotice();
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const complete = useRef(onComplete);
  complete.current = onComplete;
  // A refused checkout is explained above the button for a moment, then the button stands alone.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(""), 5000);
    return () => clearTimeout(timer);
  }, [error]);
  useEffect(() => {
    if (!receipt) return;
    const timer = setTimeout(() => complete.current(receipt), 1500);
    return () => clearTimeout(timer);
  }, [receipt]);
  async function checkout() {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    onPendingChange?.(true);
    try {
      setReceipt(await playerOperation<Receipt>(shopApi(info.shop.publicId, "player/checkout/confirm"), {
        location: await operationLocation(info.shop.locationEnabled ?? info.shop.checkoutGeo),
      }));
    } catch (e) {
      locked.current = false; onPendingChange?.(false);
      const notice = showNotice(e);
      if (notice.display === "inline") setError(notice.body);
    }
    finally { setBusy(false); }
  }
  return <>
    {error && <p role="alert" className="checkout-error">{error}</p>}
    <button ref={button} className="session-action bill-checkout w-full" disabled={busy || !!receipt} onClick={() => void checkout()}>
      {busy && <Loader2 size={20} className="animate-spin" />}{t("结账")}
    </button>
    {receipt && createPortal(<div className="checkout-success" role="status" aria-live="polite">
      <svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="43" /><path d="M28 51 L44 67 L73 35" /></svg>
      <h2>{t("结账成功")}</h2><p>{t("计费已结束，离店前无需再做其他操作。")}</p>
    </div>, button.current?.closest("dialog") ?? document.body)}
  </>;
}
