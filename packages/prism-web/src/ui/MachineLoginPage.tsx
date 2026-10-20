import { SessionPasskeySetup } from "./SessionPasskeySetup";
import { DeviceControls } from "./DeviceControls";
import { useI18n } from "../i18n";
import { useCallback, useEffect, useState } from "react";
import { useLocation, useParams, useSearchParams } from "react-router-dom";
import { ChevronRight, Loader2 } from "lucide-react";
import { ShopHero, SessionSignIn } from "./SessionContent";
import { Api, ApiError, type Card, type MachineLoginResult, type PublicMachine } from "../api";
import { useAuth } from "./AuthContext";

type CardOutcome = NonNullable<MachineLoginResult["card"]>;
const CARD_TEXT: Record<CardOutcome, string> = {
  ok: "登录成功",
  failed: "登录失败",
  not_read: "未读卡",
  read: "已刷卡",
  sent: "已刷卡",
};
/** Outcomes where the game has the card; the others leave nothing to tick. */
const CARD_TAKEN = new Set<CardOutcome>(["ok", "read", "sent"]);

export function MachineLoginPage() {
  const { ticket: paramTicket = "", publicId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const { hash } = useLocation();
  const ticket = new URLSearchParams(hash.slice(1)).get("ticket") || searchParams.get("ticket") || paramTicket || publicId;
  const [expiredTicket, setExpiredTicket] = useState<string | null>(null);
  const onExpired = useCallback(() => setExpiredTicket(ticket), [ticket]);
  const expired = expiredTicket === ticket ||
    window.location.pathname === "/m/expired" ||
    searchParams.get("expired") === "1";
  return expired || !ticket ? (
    <MachineExpiredPage />
  ) : (
    <MachineSessionLoader
      key={ticket}
      ticket={ticket}
      onExpired={onExpired}
    />
  );
}

function MachineSessionLoader({
  ticket, onExpired,
}: {
  ticket: string;
  onExpired: () => void;
}) {
  const { setActiveShop } = useAuth();
  const [page, setPage] = useState<
    | { kind: "loading" }
    | { kind: "failed"; message: string }
    | { kind: "session"; machine: PublicMachine }
  >({ kind: "loading" });
  const [machineAttempt, setMachineAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPage({ kind: "loading" });
    Api.publicMachine(ticket)
      .then((result) => {
        if (!cancelled) {
          setActiveShop(result.machine.shop.publicId ?? "");
          setPage({ kind: "session", machine: result.machine });
        }
      })
      .catch((caught) => {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.sessionExpired) {
          onExpired();
          return;
        }
        setPage({
          kind: "failed",
          message:
            caught instanceof TypeError
              ? "网络连接失败，请检查网络后重试"
              : "这台机台暂时不可用，请稍后重试",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [ticket, machineAttempt, onExpired]);

  switch (page.kind) {
    case "loading":
      return <MachineLoadingPage />;
    case "failed":
      return (
        <MachineFailurePage
          message={page.message}
          onRetry={() => {
            setPage({ kind: "loading" });
            setMachineAttempt((value) => value + 1);
          }}
        />
      );
    case "session":
      return (
        <MachineSessionPage
          machine={page.machine}
          ticket={ticket}
          onExpired={onExpired}
        />
      );
  }
}

function MachineSessionPage({
  machine,
  ticket, onExpired,
}: {
  machine: PublicMachine;
  ticket: string;
  onExpired: () => void;
}) {
  const { t, errorText } = useI18n();
  const { user, loading } = useAuth();
  const [cards, setCards] = useState<Card[]>([]);
  const [cardsLoading, setCardsLoading] = useState(true);
  const [cardsError, setCardsError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "locating" | "sending" | "done">("idle");
  const [outcome, setOutcome] = useState<CardOutcome>("sent");
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setCardsError(null);
    if (!user) {
      setCards([]);
      setCardsLoading(false);
      return;
    }
    setCardsLoading(true);
    Api.cards()
      .then((result) => {
        if (cancelled) return;
        const activeCards = result.cards.filter((card) => !card.disabledAt);
        setCards(activeCards);
      })
      .catch(() => {
        if (!cancelled) setCardsError("请检查网络后重试");
      })
      .finally(() => {
        if (!cancelled) setCardsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [machine, user, reload]);

  const loginWithCard = async (cardId: string) => {
    if (status !== "idle") return;
    setActiveCardId(cardId);
    setStatus("locating");
    try {
      const position =
        (machine.shop.locationEnabled ?? machine.shop.machineGeo) === false ? null : await getPosition();
      setStatus("sending");
      const result = await Api.loginMachine({
        cardId,
        lat: position?.coords.latitude,
        lng: position?.coords.longitude,
        accuracy: position?.coords.accuracy,
        ticket,
      });
      const card = result.card ?? "sent";
      setOutcome(card);
      setStatus("done");
      window.setTimeout(() => setStatus("idle"), CARD_TAKEN.has(card) ? 1000 : 2500);
      if (["failed", "unknown"].includes(result.coin?.status ?? "")) window.alert(errorText("刷卡已完成，投币请求失败，请联系店员。"));
    } catch (caught) {
      if (caught instanceof ApiError && caught.sessionExpired) {
        onExpired();
        return;
      }
      if (
        caught instanceof ApiError &&
        ["PLATFORM_BINDING_REQUIRED", "CHECKIN_REQUIRED"].includes(caught.code ?? "")
      ) {
        setStatus("idle");
        setReload((value) => value + 1);
        return;
      }
      setStatus("idle");
      setActiveCardId(null);
      const message = friendlyLoginError(caught);
      window.alert(errorText(message));
    }
  };

  const busy = status !== "idle";
  return (
    <section className="machine-session">
      <ShopHero name={machine.shop.name} heroUrl={machine.shop.heroUrl} subtitle={machine.name} />

      {!Object.values(machine.capabilities).some(Boolean) ? (
        <div className="device-controls"><p className="session-subtitle text-center">{t("当前设备没有可操作项")}</p></div>
      ) : loading ? (
        <div className="device-controls" role="status"><Loader2 className="mx-auto animate-spin" aria-label={t("正在加载")} /></div>
      ) : !user ? (
        <SessionSignIn />
      ) : (
        <SessionPasskeySetup><DeviceControls
          key={reload}
          machine={machine}
          ticket={ticket}
          onExpired={onExpired}
          cardBusy={status === "locating" || status === "sending"}
        >
          {cardsLoading ? (
            <div
              className="flex justify-center"
              role="status"
              aria-label={t("正在加载卡片")}
            >
              <Loader2 size={28} className="animate-spin" aria-hidden="true" />
            </div>
          ) : cardsError ? (
            <div className="text-center" role="status">
              <h2 className="text-xl font-semibold">{t("无法加载卡片")}</h2>
              <p className="session-subtitle">{errorText(cardsError)}</p>
              <button
                className="session-action mt-6 w-full"
                onClick={() => setReload((value) => value + 1)}
              >
                {t("重新加载卡片")}
              </button>
            </div>
          ) : cards.length ? (
            <div className="credential-list">
              {cards.map((card) => {
                const active = activeCardId === card.id;
                const done = active && status === "done";
                const detail =
                  done ? t(CARD_TEXT[outcome]) :
                  active && status === "locating"
                    ? t("确认位置…")
                    : active && status === "sending"
                      ? t("正在登录…")
                      : t("尾号 {digits}", {
                          digits: card.accessCode.slice(-4),
                        });
                return (
                  <button
                    key={card.id}
                    className="credential-row"
                    disabled={busy}
                    data-active={active}
                    onClick={() => void loginWithCard(card.id)}
                  >
                    <span className="min-w-0">
                      <span className="credential-name">{card.label}</span>
                      <span
                        className="credential-detail"
                        aria-live={active ? "polite" : "off"}
                      >
                        {detail}
                      </span>
                    </span>
                    {done && CARD_TAKEN.has(outcome) ? (
                      <span aria-hidden="true">✓</span>
                    ) : done ? (
                      <ChevronRight size={20} className="text-ink/30" />
                    ) : active && busy ? (
                      <Loader2 size={20} className="animate-spin text-mint" />
                    ) : (
                      <ChevronRight size={20} className="text-ink/30" />
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="text-center">
              <p className="session-subtitle">
                {t("还没有可用卡片，请先在 PRiSM 添加卡片")}
              </p>
              <a
                className="session-action mt-4 w-full"
                href="/cards"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("添加卡片")}
              </a>
              <button
                className="session-action mt-6 w-full"
                onClick={() => setReload((value) => value + 1)}
              >
                {t("重新加载卡片")}
              </button>
            </div>
          )}
        </DeviceControls></SessionPasskeySetup>
      )}
    </section>
  );
}

function MachineLoadingPage() {
  const { t } = useI18n();
  return (
    <section
      className="machine-session session-status"
      aria-busy="true"
      role="status"
      aria-label={t("正在加载")}
    >
      <Loader2 size={28} className="animate-spin" aria-hidden="true" />
    </section>
  );
}

function MachineFailurePage({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const { t, errorText } = useI18n();
  return (
    <section className="machine-session session-status">
      <h1>{t("无法进入机台会话")}</h1>
      <p>{errorText(message)}</p>
      <button className="session-action" onClick={onRetry}>
        {t("重试")}
      </button>
    </section>
  );
}

function MachineExpiredPage() {
  const { t } = useI18n();
  return (
    <section className="machine-session session-status">
      <h1>{t("本次会话已失效")}</h1>
      <p>{t("请重新碰一下 NFC 或重新扫描二维码。")}</p>
    </section>
  );
}

function friendlyLoginError(err: unknown): string {
  if (err instanceof ApiError && err.code === "DEVICE_UNAVAILABLE") return err.message;
  if (err instanceof Error) {
    const msg = err.message;
    if (msg === "geo_denied") return "需要定位权限才能确认你在店内";
    if (msg === "geo_unsupported" || msg === "geo_failed")
      return "定位获取失败";
    if (
      msg.includes("店内") ||
      msg.includes("距离") ||
      msg.includes("到店") ||
      msg.includes("位置确认失败")
    ) {
      return "请到店再进行登录";
    }
    if (msg.includes("会话已失效") || msg.includes("缺少会话凭证")) {
      return "本次会话已失效";
    }
    if (msg.includes("频繁")) {
      return "操作过于频繁，请稍后重试";
    }
    if (
      msg.includes("无法完成此操作") ||
      msg.includes("当前无法进行此操作") ||
      msg.includes("受限")
    ) {
      return "当前无法进行此操作";
    }
    if (msg.includes("卡片")) {
      return "卡片不可用或已失效";
    }
    if (
      msg.includes("机台") ||
      msg.includes("通信") ||
      msg.includes("响应") ||
      msg.includes("502")
    ) {
      return "这台机台暂时不可用，请稍后重试";
    }
  }
  return "登录失败，请稍后重试";
}

function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("geo_unsupported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      resolve,
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          reject(new Error("geo_denied"));
        } else {
          reject(new Error("geo_failed"));
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 12_000,
        maximumAge: 15_000,
      },
    );
  });
}
