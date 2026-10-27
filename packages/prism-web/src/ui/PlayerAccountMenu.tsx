import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useMatch, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useI18n } from "../i18n";
import { useAuth } from "./AuthContext";
import { shopApi, type ShopInfo, type Summary } from "./BillingPages";
import {
  AccountContent,
  PlayerDialog,
  playerSections,
  type Section,
} from "./PlayerAccount";

export { PlayerDialog };

export function PlayerAccountMenu() {
  const shopPage = useMatch("/t/:shopCode");
  const navigate = useNavigate();
  const { user, logout, activeShop, billingActive, setBillingActive } = useAuth();
  const { locale, setLocale, t } = useI18n();
  const [info, setInfo] = useState<ShopInfo | null>(null);
  const [section, setSection] = useState<Section | null>(null);
  const [checkoutPending, setCheckoutPending] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setSection(null);
    setCheckoutPending(false);
    if (user && activeShop)
      api<ShopInfo>(shopApi(activeShop))
        .then(async (result) => {
          if (cancelled) return;
          setInfo(result);
          if (result.membership) {
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
          {info &&
            playerSections.filter(item => !shopPage || item !== "账单").map((item) => (
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
            onClick={() => {
              setLocale(locale === "zh" ? "en" : "zh");
              menu.current!.open = false;
            }}
          >
            {t("语言")}: {locale === "zh" ? "English" : "中文"}
          </button>
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
        <PlayerDialog title={t(section)} onClose={() => setSection(null)} dismissDisabled={checkoutPending}>
          <AccountContent
            key={section + activeShop}
            section={section}
            info={info}
            onCheckoutPending={setCheckoutPending}
            onCheckout={() => { setSection(null); setCheckoutPending(false); setBillingActive(info.shop.publicId, false); navigate(`/t/${encodeURIComponent(info.shop.publicId)}`); }}
          />
        </PlayerDialog>
      )}
    </>
  );
}
