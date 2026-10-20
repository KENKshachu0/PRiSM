import { useNotice } from "./NoticeProvider";
import { CheckoutHistory } from "./CheckoutHistory";
// Account sheets share their bill and checkout components with the standalone shop page.
import { CheckoutButton, SettledBill, type Receipt } from "./Checkout";
import { BillTotal, BillTimeline } from "./BillTimeline";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, X } from "lucide-react";
import { api, playerOperation } from "../api";
import { browserCheckoutPreview } from "../browser-billing";
import { useI18n } from "../i18n";
import { useAuth } from "./AuthContext";
import {
  shopApi,
  post,
  type ShopInfo,
  type Summary,
  type Preview,
  type Assets,
} from "./BillingPages";

export type Section = "账单" | "兑换" | "记录" | "钱包";
export const playerSections: Section[] = ["账单", "兑换", "记录", "钱包"];

export function PlayerDialog({
  title,
  children,
  onClose,
  dismissDisabled = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  dismissDisabled?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useI18n();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="player-dialog"
      onCancel={event => { if (dismissDisabled) event.preventDefault(); else onClose(); }}
      onClick={(e) => {
        if (!dismissDisabled && e.target === ref.current) onClose();
      }}
    >
      <div className="player-dialog-content">
        <header>
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            className="focus-ring p-2"
            onClick={onClose}
            disabled={dismissDisabled}
            aria-label={t("关闭")}
          >
            <X size={22} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

export function AccountContent({
  section,
  info,
  onCheckout,
  onCheckoutPending,
}: {
  section: Section;
  info: ShopInfo;
  onCheckout: () => void;
  onCheckoutPending: (pending: boolean) => void;
}) {
  const { t, errorText } = useI18n();
  const showNotice = useNotice();
  const code = info.shop.publicId;
  const { setBillingActive } = useAuth();
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [assets, setAssets] = useState<Assets | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  /** Why a code was not accepted, under the code field; the section itself loaded fine. */
  const [redeemError, setRedeemError] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!redeemError) return;
    const timer = setTimeout(() => setRedeemError(""), 5000);
    return () => clearTimeout(timer);
  }, [redeemError]);
  const [redeem, setRedeem] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function load() {
      setBusy(true);
      setError("");
      try {
        if (section === "账单") {
          const current = await api<Summary>(shopApi(code, "player/me"));
          const bill = current.activeSession
            ? await browserCheckoutPreview(
                shopApi(code, "player/billing-inputs"), shopApi(code, "player/checkout/preview"), controller.signal,
              )
            : null;
          const latest = current.activeSession ? null : await api<{ receipt: Receipt | null }>(shopApi(code, "player/checkout/latest"));
          if (!cancelled) {
            setReceipt(latest?.receipt ?? null);
            setBillingActive(code, !!current.activeSession);
            setPreview(bill);
          }
        } else if (section === "钱包") {
          const current = await api<Assets>(shopApi(code, "player/assets"));
          if (!cancelled) setAssets(current);

        }
      } catch (e) {
        if (!cancelled)
          setError(errorText(e instanceof Error ? e.message : "操作失败"));
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    void load();
    return () => {
      cancelled = true; controller.abort();
    };
  }, [code, section, attempt, errorText, setBillingActive]);
  if (section === "记录") return <CheckoutHistory code={code} />;
  async function submit() {
    if (busy) return;
    setBusy(true);
    setRedeemError("");
    try {
      await playerOperation(shopApi(code, "player/redeem"), { code: redeem.trim() });
      setDone(true);
      setPreview(null);
    } catch (e) {
      const notice = showNotice(e);
      if (notice.display === "inline") setRedeemError(notice.body);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className={`account-content ${section === "账单" ? "account-bill" : ""}`}
    >
      <div className="account-scroll">
        {section === "账单" && preview && !done && (
          <BillTotal preview={preview} />
        )}
        {error && (
          <div role="alert" className="text-sm text-coral">
            {error}
            <button
              className="ml-3 underline"
              onClick={() => setAttempt((v) => v + 1)}
            >
              {t("重新加载")}
            </button>
          </div>
        )}
        {busy && !preview && (
          <Loader2 className="mx-auto animate-spin" size={24} />
        )}
        {section === "账单" &&
          (receipt ? (
            <SettledBill receipt={receipt} />
          ) : preview ? (
            <BillTimeline preview={preview} />
          ) : (
            !busy && !error && <p>{t("暂无待结账单")}</p>
          ))}
        {section === "兑换" &&
          (done ? (
            <p>{t("兑换成功")}</p>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
              className="grid gap-5"
            >
              <input
                className="session-action text-left"
                aria-label={t("兑换码")}
                placeholder={t("兑换码")}
                value={redeem}
                onChange={(e) => setRedeem(e.target.value)}
                autoComplete="off"
              />
              <button
                className="session-action primary"
                disabled={busy || !redeem.trim()}
              >
                {busy && <Loader2 className="animate-spin" size={20} />}{" "}
                {t("兑换")}
              </button>
              {redeemError && <p role="alert" className="inline-notice" data-level="warning">{redeemError}</p>}
            </form>
          ))}
        {section === "钱包" &&
          assets &&
          (assets.holdings.length ? (
            assets.holdings.map((row) => (
              <div className="account-row" key={row.id}>
                <span>{row.assetName || row.assetCode}</span>
                <strong>{row.quantity}</strong>
              </div>
            ))
          ) : (
            <p>{t("暂无资产")}</p>
          ))}

      </div>
      {section === "账单" && !done && preview && (
        <footer className="account-footer">
          <CheckoutButton info={info} onComplete={onCheckout} onPendingChange={onCheckoutPending} />
        </footer>
      )}
    </div>
  );
}
