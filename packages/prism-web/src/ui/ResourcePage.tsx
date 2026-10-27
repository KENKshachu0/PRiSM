import { SessionPasskeySetup } from "./SessionPasskeySetup";
import { ResourceControls, type ResourceState } from "./ResourceControls";
import { useI18n } from "../i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useParams, useSearchParams } from "react-router-dom";
import { AlertCircle, CheckCircle2, ChevronRight, Loader2, Plus, XCircle } from "lucide-react";
import { operationLocation } from "./BillingPages";
import { ShopHero, SessionSignIn } from "./SessionContent";
import { Api, ApiError, InlineError, type Card, type MachineLoginResult, type Notice, type PublicResource } from "../api";
import { useNotice } from "./NoticeProvider";
import { useAuth } from "./AuthContext";

type CardOutcome = NonNullable<MachineLoginResult["card"]>;
const CARD_TEXT: Record<CardOutcome, string> = {
  not_read: "登录失败",
  read: "已刷卡",
  sent: "已刷卡",
};
function FeedbackIcon({ level }: { level: Notice["level"] }) {
  const Icon = level === "success" ? CheckCircle2 : level === "error" ? XCircle : AlertCircle;
  return <Icon size={24} className="credential-feedback-icon" aria-hidden="true" />;
}

export function ResourcePage() {
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
    <ResourceExpiredPage />
  ) : (
    <ResourceSessionLoader
      key={ticket}
      ticket={ticket}
      onExpired={onExpired}
    />
  );
}

function ResourceSessionLoader({
  ticket, onExpired,
}: {
  ticket: string;
  onExpired: () => void;
}) {
  const { setActiveShop } = useAuth();
  const [page, setPage] = useState<
    | { kind: "loading" }
    | { kind: "failed"; message: string }
    | { kind: "session"; machine: PublicResource; state: ResourceState | null }
  >({ kind: "loading" });
  const [machineAttempt, setResourceAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPage({ kind: "loading" });
    // One request for the machine and the page's state; an older address form has only the machine.
    const first = ticket.startsWith("v1.")
      ? Api.bootstrap<ResourceState>(ticket)
      : Api.publicResource(ticket).then((result) => ({ machine: result.machine, state: null }));
    first
      .then((result) => {
        if (!cancelled) {
          setActiveShop(result.machine.shop.publicId ?? "");
          setPage({ kind: "session", machine: result.machine, state: result.state });
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
      return <ResourceLoadingPage />;
    case "failed":
      return (
        <ResourceFailurePage
          message={page.message}
          onRetry={() => {
            setPage({ kind: "loading" });
            setResourceAttempt((value) => value + 1);
          }}
        />
      );
    case "session":
      return (
        <ResourceSessionPage
          machine={page.machine}
          initialState={page.state}
          ticket={ticket}
          onExpired={onExpired}
        />
      );
  }
}

function ResourceSessionPage({
  machine,
  initialState,
  ticket, onExpired,
}: {
  machine: PublicResource;
  initialState: ResourceState | null;
  ticket: string;
  onExpired: () => void;
}) {
  const { t, errorText } = useI18n();
  const { user, loading } = useAuth();
  /** The machine's power is being asked for; the page is usable meanwhile. */
  const [checkingPower, setCheckingPower] = useState(false);
  const [cards, setCards] = useState<Card[]>([]);
  const [cardsLoading, setCardsLoading] = useState(true);
  const [cardsError, setCardsError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "locating" | "sending">("idle");
  /** A swipe's outcome on its card row: the card's part, then the coin's, each with its own level. */
  const [feedback, setFeedback] = useState<{ cardId: string; parts: Pick<Notice, "level" | "body">[] } | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showNotice = useNotice();
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // Re-reads the card list alone; `reload` also restarts the controls from the page's first state.
  const [cardsVersion, setCardsVersion] = useState(0);

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
      .catch((caught) => {
        if (!cancelled) setCardsError(caught instanceof ApiError ? caught.message : "请检查网络后重试");
      })
      .finally(() => {
        if (!cancelled) setCardsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [machine, user, reload, cardsVersion]);

  const loginWithCard = async (cardId: string) => {
    if (status !== "idle") return;
    setActiveCardId(cardId);
    showFeedback(null);
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
      const notices = result.notices ?? fallbackNotices(result.card ?? "sent");
      const inline = notices.filter((notice) => notice.display === "inline");
      // The card row carries the outcome; only a problem that needs the player interrupts.
      showFeedback({ cardId, parts: inline.length ? inline : fallbackNotices(result.card ?? "sent") });
      for (const notice of notices) if (notice.display === "dialog") showNotice(notice);
    } catch (caught) {
      const notice = showNotice(caught instanceof ApiError ? caught : friendlyLoginError(caught), {
        onExpired,
        onRefresh: () => setReload((value) => value + 1),
        retry: () => void loginWithCard(cardId),
      });
      if (notice.display === "inline") showFeedback({ cardId, parts: [notice] });
      else setActiveCardId(null);
    } finally {
      setStatus("idle");
    }
  };

  /**
   * Adding a card at this cabinet's reader: the page opens a short window and
   * waits for the reader to report the card. A newer attempt or a cancel makes
   * an older one stop waiting.
   */
  const [capture, setCapture] = useState<
    | { phase: "starting" | "waiting" }
    | { phase: "done"; level: "success" | "error"; message: string }
    | null
  >(null);
  const captureRun = useRef(0);
  useEffect(() => () => { captureRun.current += 1; }, []);
  const startCapture = async () => {
    const run = ++captureRun.current;
    const current = () => captureRun.current === run;
    setCapture({ phase: "starting" });
    try {
      const location = await operationLocation(!!(machine.shop.locationEnabled ?? machine.shop.machineGeo));
      const started = await Api.startCardCapture({ ticket, location });
      if (!current()) return;
      setCapture({ phase: "waiting" });
      const deadline = Date.parse(started.expiresAt) + 2000;
      let status: Awaited<ReturnType<typeof Api.cardCaptureResult>>["status"] = "waiting";
      while (status === "waiting" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (!current()) return;
        status = (await Api.cardCaptureResult(started.captureId, ticket)).status;
      }
      if (!current()) return;
      const added = status === "added" || status === "bound" || status === "exists";
      setCapture({
        phase: "done",
        level: added ? "success" : "error",
        message: t(
          added ? "已添加卡片"
            : status === "taken" ? "这张卡已绑定到本店的其他玩家"
            : status === "unsupported" ? "不支持这种卡片"
            : "没有读到卡片",
        ),
      });
      if (added) setCardsVersion((value) => value + 1);
    } catch (caught) {
      if (current()) setCapture({ phase: "done", level: "error", message: caught instanceof Error ? errorText(caught.message) : t("请检查网络后重试") });
    }
  };
  const cancelCapture = () => {
    captureRun.current += 1;
    setCapture(null);
  };
  const capturing = capture?.phase === "starting" || capture?.phase === "waiting";

  /** Shown for a few seconds; the page stays usable meanwhile. */
  const showFeedback = (next: typeof feedback) => {
    clearTimeout(feedbackTimer.current);
    setFeedback(next);
    if (next) feedbackTimer.current = setTimeout(() => setFeedback(null), next.parts[0]?.level === "success" ? 3000 : 5000);
  };
  useEffect(() => () => clearTimeout(feedbackTimer.current), []);

  /** For a server that predates notices: the card result alone. */
  const fallbackNotices = (card: CardOutcome): Notice[] => [{
    code: card, display: "inline", flow: "none", title: null, actions: [],
    level: card === "not_read" ? "warning" : "success",
    body: t(CARD_TEXT[card]),
  }];

  const busy = status !== "idle";
  return (
    <section className="machine-session">
      <ShopHero
        name={machine.shop.name}
        heroUrl={machine.shop.heroUrl}
        subtitle={checkingPower ? `${machine.name} · ${t("正在获取电源状态")}` : machine.name}
      />

      {/* A resource without hardware that has a plan still bills, so it needs the player and a confirmation. */}
      {!Object.values(machine.capabilities).some(Boolean) && !machine.billed ? (
        <div className="device-controls"><p className="session-subtitle text-center">{t("这里没有可操作的设备")}</p></div>
      ) : loading ? (
        <div className="device-controls" role="status"><Loader2 className="mx-auto animate-spin" aria-label={t("正在加载")} /></div>
      ) : !user ? (
        <SessionSignIn />
      ) : (
        <SessionPasskeySetup><ResourceControls
          key={reload}
          machine={machine}
          ticket={ticket}
          initialState={initialState}
          onCheckingPower={setCheckingPower}
          onExpired={onExpired}
          cardBusy={status === "locating" || status === "sending" || capturing}
          cardHeadingAction={machine.cardCapture ? (
            <button
              type="button"
              className="card-capture-add"
              aria-label={t("添加卡片")}
              disabled={busy || capturing}
              onClick={() => void startCapture()}
            >
              <Plus size={22} aria-hidden="true" />
            </button>
          ) : undefined}
          cardTask={capture ? (
            <div className="card-capture" role="status" aria-live="polite">
              {capturing ? (
                <>
                  <Loader2 size={28} className="animate-spin text-mint" aria-hidden="true" />
                  <p className="session-subtitle">
                    {capture.phase === "starting" ? t("正在连接机台…") : t("请把卡片放在「{name}」的读卡器上", { name: machine.name })}
                  </p>
                  <button type="button" className="session-action" onClick={cancelCapture}>{t("取消")}</button>
                </>
              ) : capture.phase === "done" ? (
                <>
                  <FeedbackIcon level={capture.level} />
                  <p className="session-subtitle">{capture.message}</p>
                  <button type="button" className="session-action" onClick={() => setCapture(null)}>{t("完成")}</button>
                </>
              ) : null}
            </div>
          ) : undefined}
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
                const done = feedback?.cardId === card.id ? feedback : null;
                const detail =
                  done ? done.parts.map((part, index) => (
                    <span key={index} className="credential-feedback-part" data-level={part.level}>{part.body}</span>
                  )) :
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
                    data-feedback={done ? done.parts[0]?.level : undefined}
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
                    {done ? (
                      <FeedbackIcon level={done.parts[0]?.level ?? "success"} />
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
        </ResourceControls></SessionPasskeySetup>
      )}
    </section>
  );
}

function ResourceLoadingPage() {
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

function ResourceFailurePage({
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

function ResourceExpiredPage() {
  const { t } = useI18n();
  return (
    <section className="machine-session session-status">
      <h1>{t("本次会话已失效")}</h1>
      <p>{t("请重新碰一下 NFC 或重新扫描二维码。")}</p>
    </section>
  );
}

/** Problems found on this device; a missing fix is retried by tapping the card again. */
function friendlyLoginError(err: unknown): Error | string {
  if (err instanceof ApiError && err.code === "DEVICE_UNAVAILABLE") return err.message;
  if (err instanceof Error) {
    const msg = err.message;
    if (msg === "geo_denied") return "需要定位权限才能确认你在店内";
    if (msg === "geo_failed") return new InlineError("定位获取失败，请重试");
    if (msg === "geo_unsupported") return "定位获取失败";
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
