import { BillTotal, BillTimeline } from "./BillTimeline";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Loader2, X } from "lucide-react";
import { api, playerOperation } from "../api";
import { useI18n } from "../i18n";
import { useAuth } from "./AuthContext";
import {
  shopApi,
  post,
  operationLocation,
  type ShopInfo,
  type Summary,
  type Preview,
  type Assets,
  type History,
} from "./BillingPages";

export function PlayerDialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
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
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="player-dialog-content">
        <header>
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            className="focus-ring p-2"
            onClick={onClose}
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

type Section = "账单" | "兑换" | "记录" | "钱包";
export function PlayerAccountMenu() {
  const { user, logout, activeShop, billingActive, setBillingActive } = useAuth();
  const { t } = useI18n();
  const [info, setInfo] = useState<ShopInfo | null>(null);
  const [section, setSection] = useState<Section | null>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    if (user && activeShop)
      api<ShopInfo>(shopApi(activeShop))
        .then(async (result) => {
          if (cancelled) return;
          setInfo(result);
          if (result.shop.billingEnabled && result.membership) {
            const current = await api<Summary>(shopApi(activeShop, "player/me"));
            if (!cancelled) setBillingActive(activeShop, !!current.activeSession);
          } else setBillingActive(activeShop, false);
        })
        .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeShop, user, setBillingActive]);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target) &&
        menu.current
      )
        menu.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menu.current) menu.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  if (!user) return null;
  return (
    <>
      <details ref={menu} className="player-account-menu">
        <summary className="focus-ring">
          {billingActive && <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted"><span className="h-1.5 w-1.5 rounded-full bg-green-600" />{t("计费中")}</span>}
          <span className="min-w-0 truncate">{user.displayName || user.username || user.id}</span>
          <ChevronDown size={16} className="shrink-0" />
        </summary>
        <div className="player-menu-items">
          {info?.shop.billingEnabled &&
            (["账单", "兑换", "记录", "钱包"] as Section[]).map((item) => (
              <button
                key={item}
                onClick={() => {
                  menu.current!.open = false;
                  setSection(item);
                }}
              >
                {t(item)}
              </button>
            ))}
          <button
            onClick={async () => {
              menu.current!.open = false;
              await logout();
            }}
          >
            {t("退出登录")}
          </button>
        </div>
      </details>
      {section && info && (
        <PlayerDialog title={t(section)} onClose={() => setSection(null)}>
          <AccountContent
            key={section + activeShop}
            section={section}
            info={info}
          />
        </PlayerDialog>
      )}
    </>
  );
}

function AccountContent({
  section,
  info,
}: {
  section: Section;
  info: ShopInfo;
}) {
  const { t, errorText } = useI18n();
  const code = info.shop.publicId;
  const { setBillingActive } = useAuth();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [assets, setAssets] = useState<Assets | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [redeem, setRedeem] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setBusy(true);
      setError("");
      try {
        if (section === "账单") {
          const current = await api<Summary>(shopApi(code, "player/me"));
          const bill = current.activeSession
            ? await api<Preview>(
                shopApi(code, "player/checkout/preview"),
                post(),
              )
            : null;
          if (!cancelled) {
            setBillingActive(code, !!current.activeSession);
            setSummary(current);
            setPreview(bill);
          }
        } else if (section === "钱包") {
          const current = await api<Assets>(shopApi(code, "player/assets"));
          if (!cancelled) setAssets(current);
        } else if (section === "记录") {
          const current = await api<History>(
            shopApi(code, "player/sessions/history"),
          );
          if (!cancelled) setHistory(current);
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
      cancelled = true;
    };
  }, [code, section, attempt, errorText, setBillingActive]);
  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await playerOperation(
        shopApi(
          code,
          section === "兑换" ? "player/redeem" : "player/checkout/confirm",
        ),
        section === "兑换"
          ? { code: redeem.trim() }
          : { location: await operationLocation(info.shop.locationEnabled ?? info.shop.checkoutGeo) },
      );
      if (section === "账单") setBillingActive(code, false);
      setDone(true);
      setPreview(null);
    } catch (e) {
      setError(errorText(e instanceof Error ? e.message : "操作失败"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`account-content ${section === "账单" ? "account-bill" : ""}`}>
      <div className="account-scroll">
        {section === "账单" && preview && !done && <BillTotal preview={preview} />}
        {error && (
          <div role="alert" className="text-sm text-coral">
            {error}
            <button
              className="ml-3 underline"
              onClick={() => setAttempt((v) => v + 1)}
            >
              {t("重试")}
            </button>
          </div>
        )}
        {busy && !preview && (
          <Loader2 className="mx-auto animate-spin" size={24} />
        )}
        {section === "账单" &&
          (done ? (
            <p>{t("已结账")}</p>
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
        {section === "记录" &&
          history &&
          (history.sessions.length ? (
            history.sessions.map((row) => (
              <div className="account-row" key={row.sessionId}>
                <div>
                  {new Date(row.startedAt).toLocaleString()}
                  <p className="text-xs text-ink/50">
                    {row.endedAt
                      ? new Date(row.endedAt).toLocaleString()
                      : t("计费中")}
                  </p>
                </div>
                <strong>{row.total?.toFixed(2) ?? "—"}</strong>
              </div>
            ))
          ) : (
            <p>{t("暂无记录")}</p>
          ))}
      </div>
      {section === "账单" && !done && preview && (
        <footer className="account-footer">
          <button
            className="session-action bill-checkout w-full"
            disabled={busy}
            onClick={submit}
          >
            {busy && <Loader2 size={20} className="animate-spin" />}
            {t("结账")}
          </button>
        </footer>
      )}
    </div>
  );
}
