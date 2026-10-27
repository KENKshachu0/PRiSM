import { isTransientReadFailure, usePagePolling } from "./use-page-polling";
import { SessionPasskeySetup } from "./SessionPasskeySetup";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { api } from "../api";
import { browserCheckoutPreview } from "../browser-billing";
import { useI18n } from "../i18n";
import { useAuth } from "./AuthContext";
import { shopApi, type ShopInfo, type Summary, type Preview } from "./BillingPages";
import { ShopHero, SessionSignIn, PlatformBinding } from "./SessionContent";
import { BillTotal, BillTimeline } from "./BillTimeline";
import { CheckoutButton, SettledBill, type Receipt } from "./Checkout";

export default function ShopPage() {
  const { shopCode = "" } = useParams();
  const { user } = useAuth();
  return <ShopSurface key={`${shopCode}:${user?.id ?? "guest"}`} shopCode={shopCode} />;
}

function ShopSurface({ shopCode }: { shopCode: string }) {
  const { t, errorText } = useI18n();
  const { user, loading, setActiveShop, setBillingActive } = useAuth();
  const [info, setInfo] = useState<ShopInfo | null>(null);
  const [bill, setBill] = useState<Preview | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const checkoutPending = useRef(false);
  const checkoutRevision = useRef(0);
  useEffect(() => { setActiveShop(shopCode); }, [shopCode, setActiveShop]);
  usePagePolling(async signal => {
    if (checkoutPending.current) return;
    const revision = checkoutRevision.current;
    try {
      const shop = await api<ShopInfo>(shopApi(shopCode), { signal });
      const current = user && (shop.membership || !shop.shop.identityBindingRequired)
        ? await api<Summary>(shopApi(shopCode, "player/me"), { signal }) : null;
      const preview = current?.activeSession ? await browserCheckoutPreview(shopApi(shopCode, "player/billing-inputs"), shopApi(shopCode, "player/checkout/preview"), signal) : null;
      const latest = current && !current.activeSession ? await api<{ receipt: Receipt | null }>(shopApi(shopCode, "player/checkout/latest"), { signal }) : null;
      if (signal.aborted || checkoutPending.current || revision !== checkoutRevision.current) return;
      setInfo(shop); setBill(preview); setReceipt(latest?.receipt ?? null);
      setBillingActive(shopCode, !!current?.activeSession);
      setError("");
    } catch (e) {
      if (!signal.aborted && (!info || !isTransientReadFailure(e)))
        setError(errorText(e instanceof Error ? e.message : "操作失败"));
      throw e;
    } finally { if (!signal.aborted) setBusy(false); }
  }, !loading, `${shopCode}:${attempt}`, !info || !!user
    && info.shop.identityBindingRequired && !info.membership?.identityBound && !bill);
  return <section className={`machine-session shop-session ${bill ? "has-checkout" : ""}`}>
    {info && <ShopHero name={info.shop.name || shopCode} heroUrl={info.shop.heroUrl} subtitle={!user ? "" : bill ? t("计费中") : receipt ? t("结账成功") : busy ? t("正在加载") : t("未入场")} />}
    {error && <div role="alert" className="text-coral">{error}<button className="ml-3 underline" onClick={() => setAttempt(value => value + 1)}>{t("重试")}</button></div>}
    {loading || (busy && !info) ? <Loader2 className="mx-auto animate-spin" /> : info && !user ? <SessionSignIn /> : busy && !bill && !receipt ? <Loader2 className="mx-auto animate-spin" /> : info && user && <SessionPasskeySetup>
      {!bill && info.shop.identityBindingRequired && !info.membership?.identityBound ? <PlatformBinding code={shopCode} />
        : bill ? <div className="grid gap-5"><BillTotal preview={bill} /><BillTimeline preview={bill} /></div>
        : receipt ? <SettledBill receipt={receipt} />
        : !error && <p className="session-subtitle">{t("请碰一下 NFC 或扫描机台上的二维码")}</p>}
      {bill && <footer className="shop-checkout"><CheckoutButton info={info} onPendingChange={pending => { checkoutPending.current = pending; checkoutRevision.current++; }} onComplete={result => { checkoutPending.current = false; checkoutRevision.current++; setReceipt(result); setBill(null); setBillingActive(shopCode, false); }} /></footer>}
    </SessionPasskeySetup>}
  </section>;
}
