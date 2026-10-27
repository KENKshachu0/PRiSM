import { isTransientReadFailure, usePagePolling } from "./use-page-polling";
import { idleLive, useResourceLive, type DeviceFacts, type FactsChange, type LiveStatus } from "./use-resource-live";
import { billTime } from "./bill-time";
import { PlatformBinding } from "./SessionContent";
import { PlayerClimate, settleClimate, type ClimateState } from "./ClimateControls";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Power, DoorOpen, Coins, Loader2, CheckCircle2, AlertCircle, XCircle, Info } from "lucide-react";
import { api, invalidatePlayerReads, playerOperation, type Notice, type PublicResource } from "../api";
import { useI18n } from "../i18n";
import {
  operationLocation,
  shopApi,
  type ShopInfo,
  type Summary,
  EntryPricing,
} from "./BillingPages";
import { ResourcePricing, type ResourceRules } from "./ResourcePricing";
import { useAuth } from "./AuthContext";
import { useInlineNotice, useNotice } from "./NoticeProvider";

/** Which control an action's outcome is shown under. */
function anchorOf(action: string) {
  if (action === "door.open") return "door";
  if (action.startsWith("power.")) return "power";
  if (action.startsWith("mahjong.")) return "mahjong";
  if (action.startsWith("climate.")) return "climate";
  return action;
}

function NoticeIcon({ level, size }: { level: Notice["level"]; size: number }) {
  const Icon = level === "success" ? CheckCircle2 : level === "error" ? XCircle : level === "info" ? Info : AlertCircle;
  return <Icon size={size} aria-hidden="true" />;
}

/** A short outcome under a control: a coloured line with its icon. */
function InlineNoticeLine({ note }: { note: Notice }) {
  return <p className="inline-notice" data-level={note.level} role="status"><NoticeIcon level={note.level} size={18} />{note.body}</p>;
}

const localNote = (body: string, level: Notice["level"] = "warning"): Notice =>
  ({ code: "CLIENT", level, display: "inline", flow: "none", title: null, body, actions: [] });

/** How long a power-on waits for the machine to report on before the button comes back. */
const POWER_ON_WAIT_MS = 15_000;

type BillingChange = { planId: string; planName: string; reason: string };
/** What confirming this resource would do to the player's billing, or why it cannot bill. */
export type ResourceBilling = {
  preview?: { pricingConfigId: string; planName: string; changed: boolean; started: BillingChange[]; stopped: BillingChange[]; kept: BillingChange[]; revision: string };
  error?: { code: string; message: string };
  /** The plans this resource bills, shown as its pricing rules. */
  rules?: ResourceRules;
};

export type ResourceState = {
  gate: "ready" | "binding" | "entry";
  /** Set while `gate` is `entry` in a shop that bills. */
  billing?: ResourceBilling | null;
  coinUsed: boolean;
  mahjong?: {capacity:number;seats:{name:string;mine:boolean;playing:boolean}[]} | null;
  /** What is known of the device's Home Assistant state; `watching` says it is current and pushed. */
  device: DeviceFacts;
};
type PowerState = "on" | "off" | "unknown";

export function ResourceControls({
  machine,
  ticket,
  children,
  cardHeadingAction,
  cardTask,
  cardBusy, onExpired,
  initialState = null,
  onCheckingPower,
}: {
  machine: PublicResource;
  ticket: string;
  children: ReactNode;
  /** Shown beside the card heading, such as adding a card at the reader. */
  cardHeadingAction?: ReactNode;
  /** Shown instead of the card list and the coin while the player adds a card. */
  cardTask?: ReactNode;
  cardBusy: boolean;
  onExpired: () => void;
  /** The page state the first read of the scan already returned; the page starts from it. */
  initialState?: ResourceState | null;
  /** Whether the machine's power is being asked for, so the page header can say so. */
  onCheckingPower?: (checking: boolean) => void;
}) {
  const { t, errorText } = useI18n();
  const code = machine.shop.publicId!;
  const { setBillingActive } = useAuth();
  const hasHa = !!(machine.capabilities.power || machine.capabilities.climate);
  const [state, setState] = useState<ResourceState | null>(initialState);
  const [power, setPower] = useState<PowerState>(() => (initialState?.device.watching ? initialState.device.power ?? "unknown" : "unknown"));
  const [climateState, setClimateState] = useState<ClimateState | null>(() => (initialState?.device.watching ? initialState.device.climate : null));
  const [info, setInfo] = useState<ShopInfo | null>(null);
  const [password, setPassword] = useState<{
    temporaryPassword: string;
    expiresAt: string;
  } | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [waitingPower, setWaitingPower] = useState(false);
  const [checking, setChecking] = useState(false);
  /** The device turned out to be watched after the first read said it was not. */
  const [watchHint, setWatchHint] = useState(false);
  const refreshError = useRef("");
  const liveRef = useRef<LiveStatus>(idleLive);
  const showNotice = useNotice();
  const [note, showNote] = useInlineNotice();
  const [noteAnchor, setNoteAnchor] = useState("");
  const noteAt = (anchor: string) => note && noteAnchor === anchor ? <InlineNoticeLine note={note} /> : null;
  const coinNote = noteAnchor === "coin" ? note : null;
  const showNoteAt = useCallback((anchor: string, next: Notice) => { setNoteAnchor(anchor); showNote(next); }, [showNote]);
  /**
   * Every problem goes through the shared notice entry; inline ones are shown under the
   * control named by `anchor`. A quiet one (a background read) only runs its flow.
   */
  const failed = useCallback(
    (e: unknown, anchor = "page", quiet = false) => {
      const notice = showNotice(e, { onExpired, onRefresh: () => invalidatePlayerReads(), quiet });
      if (quiet) return;
      if (notice.display === "inline") showNoteAt(anchor, notice);
      // Kept so a page that could not load offers its retry button.
      else if (notice.display === "dialog") setError(notice.body);
    },
    [onExpired, showNotice, showNoteAt],
  );

  /** What was learned about the device's state, from a read, a pushed frame or the hub's greeting. */
  const applyFacts = useCallback((facts: FactsChange) => {
    if (facts.power !== undefined) {
      setPower(facts.power ?? "unknown");
      if (facts.power === "on") setWaitingPower(false);
    }
    if (facts.climate !== undefined) setClimateState(facts.climate);
  }, []);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const current = await api<ResourceState>(
      `/api/v1/devices/session/state?ticket=${encodeURIComponent(ticket)}&includePower=0&includeClimate=0`, { signal });
    if (signal?.aborted) return;
    setState(current);
    // A pushed state is fresher than this read; with no push, a watched device's stored state is the answer.
    if (current.device.watching && !liveRef.current.connected) applyFacts(current.device);
    const previousRefreshError = refreshError.current;
    setError(previous => previous === previousRefreshError ? "" : previous);
    refreshError.current = "";
  }, [ticket, applyFacts]);

  // A watched device's state and the page's own changes (a bot confirmed the binding) are pushed;
  // the page asks for them only while nothing pushes.
  const live = useResourceLive(ticket, hasHa && (!!state?.device.watching || watchHint), {
    onFacts: applyFacts,
    onChange: applyFacts,
    onRefresh: () => { void refresh().catch(() => undefined); },
  });
  liveRef.current = live;
  const pushed = live.connected && live.watching;
  const eventMode = live.dropped ? false : live.connected ? live.watching : !!state?.device.watching;
  const unpushed = hasHa && state !== null && !eventMode;

  // Nothing pushes this device's state, so ask for it once, without holding the page back:
  // the page is usable meanwhile, and a machine found off simply switches to its power page.
  useEffect(() => {
    if (!unpushed) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = async (attempt: number) => {
      setChecking(true);
      try {
        const facts = await api<DeviceFacts>(`/api/v1/devices/session/device?ticket=${encodeURIComponent(ticket)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (facts.watching) setWatchHint(true);
        applyFacts(facts);
        setChecking(false);
      } catch (e) {
        if (controller.signal.aborted) return;
        if (attempt === 0 && isTransientReadFailure(e)) {
          retry = setTimeout(() => void load(1), 3000);
          return;
        }
        setChecking(false);
        failed(e, "power", true);
      }
    };
    void load(0);
    return () => {
      controller.abort();
      clearTimeout(retry);
      setChecking(false);
    };
  }, [unpushed, ticket, applyFacts, failed]);

  const checkingPower = checking && !!machine.capabilities.power;
  useEffect(() => { onCheckingPower?.(checkingPower); }, [checkingPower, onCheckingPower]);
  useEffect(() => () => onCheckingPower?.(false), [onCheckingPower]);

  usePagePolling(async signal => {
    try { await refresh(signal); }
    catch (e) {
      if (!signal.aborted && (!isTransientReadFailure(e) || !state)) {
        refreshError.current = errorText(e instanceof Error ? e.message : "操作失败");
        // Once the page has shown, a failed poll is retried quietly instead of interrupting.
        failed(e, "page", !!state);
      }
      throw e;
    }
  }, !busy && !cardBusy, ticket,
  // Only the binding (until a push can tell) and the mahjong seats change without the player acting.
  !state || (state.gate === "binding" && !pushed) || !!machine.capabilities.mahjong,
  initialState !== null);
  const previousGate = useRef<ResourceState["gate"] | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    if (previousGate.current !== undefined && previousGate.current !== state?.gate) invalidatePlayerReads();
    previousGate.current = state?.gate;
    api<ShopInfo>(shopApi(code)).then(shop => { if (!cancelled) setInfo(shop); }).catch(failed);
    return () => { cancelled = true; };
  }, [code, state?.gate, failed]);
  useEffect(() => {
    let cancelled = false;
    if (info?.membership) {
      api<Summary>(shopApi(code, "player/me")).then((current) => {
        if (!cancelled) setBillingActive(code, !!current.activeSession);
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [code, state?.gate, info?.membership?.playerId, setBillingActive]);
  /**
   * Runs a player action. The page is read again afterwards in the background, so the
   * controls come back as soon as the action answers; only entry and mahjong seats, which
   * change what the page offers, wait for that read. A failed read is not the action's failure.
   */
  async function act(action: string, fn: () => Promise<void>) {
    if (busy || cardBusy) return;
    const anchor = anchorOf(action);
    setBusy(action);
    if (noteAnchor === anchor) showNote(null);
    try {
      await fn();
    } catch (e) {
      failed(e, anchor);
      setBusy("");
      return;
    }
    const reread = Promise.all([refresh(), api<ShopInfo>(shopApi(code)).then(setInfo)])
      .catch((e) => failed(e, "page", true));
    if (action === "entry" || action === "load" || action.startsWith("mahjong.")) await reread;
    setBusy("");
  }
  // The power button spins until the machine reports on; if it never does, it comes back.
  useEffect(() => {
    if (!waitingPower) return;
    const timer = setTimeout(() => {
      setWaitingPower(false);
      showNoteAt("power", localNote(t("未检测到开机，请重试")));
    }, POWER_ON_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waitingPower, showNoteAt, t]);
  // The push that would say the machine is on is gone (the connection dropped, or nothing
  // watches the device any more). Home Assistant accepted the request; that is all there is to wait for.
  useEffect(() => {
    if (waitingPower && !pushed) {
      setWaitingPower(false);
      setPower("on");
    }
  }, [waitingPower, pushed]);
  function climate(action: string, extra?: Record<string, unknown>) {
    return act(action, async () => {
      const location = await operationLocation(!!(machine.shop.locationEnabled ?? machine.shop.machineGeo));
      await playerOperation("/api/v1/devices/session/actions", {
        ticket,
        action,
        location,
        ...extra,
      });
      // Home Assistant accepted it. A watched device reports the new state as an event; otherwise
      // there is no state to wait for and the page shows what was asked.
      if (!pushed) setClimateState((current) => settleClimate(current, action, extra));
    });
  }
  function operate(action: "power.on" | "coin" | "door.open" | "mahjong.join" | "mahjong.leave") {
    return act(action, async () => {
      const location = await operationLocation(
        action === "door.open"
          ? !!(info?.shop.locationEnabled ?? info?.shop.checkinGeo)
          : !!(machine.shop.locationEnabled ?? machine.shop.machineGeo),
      );
      const result = await playerOperation<{
        temporaryPassword?: string;
        expiresAt?: string;
        notices?: Notice[];
      }>("/api/v1/devices/session/actions", {
        ticket,
        action,
        consent,
        location,
      });
      if (result.temporaryPassword)
        setPassword({
          temporaryPassword: result.temporaryPassword,
          expiresAt: result.expiresAt!,
        });
      // A watched machine reports when it is on, and the page moves on then; otherwise Home
      // Assistant answering is the end of it.
      if (action === "power.on") {
        if (pushed) setWaitingPower(true);
        else setPower("on");
      }
      if (action === "coin")
        setState((current) =>
          current ? { ...current, coinUsed: true } : current,
        );
      const done = result.notices?.find((notice) => notice.display === "inline");
      if (done) showNoteAt(anchorOf(action), done);
    });
  }
  /**
   * Entry that also opens the door. Both come back in one response, so the
   * page switches to the entered view and shows the code in the same render.
   */
  function enterAndOpenDoor(shop: ShopInfo["shop"]) {
    return act("door.open", async () => {
      const result = await playerOperation<{
        door?: { temporaryPassword?: string; expiresAt?: string; notice?: Notice };
      }>(shopApi(code, "player/session/start"), {
        ticket,
        consent,
        openDoor: true,
        location: await operationLocation(shop.locationEnabled ?? shop.checkinGeo),
        ...(preview ? { expectedRevision: preview.revision } : {}),
      });
      setState((current) => (current ? { ...current, gate: "ready" } : current));
      if (result.door?.temporaryPassword && result.door.expiresAt)
        setPassword({ temporaryPassword: result.door.temporaryPassword, expiresAt: result.door.expiresAt });
      else if (result.door?.notice?.display === "dialog") showNotice(result.door.notice);
      else showNoteAt("door", result.door?.notice ?? localNote(t("开门密码获取失败，请重试")));
    });
  }
  const cap = machine.capabilities;
  const preview = state?.billing?.preview ?? null;
  const billingError = state?.billing?.error ?? null;
  const rules = state?.billing?.rules ?? null;
  // A resource without hardware still has to be confirmed before it bills.
  if (!Object.values(cap).some(Boolean) && !machine.billed) return <p className="session-subtitle text-center">{t("这里没有可操作的设备")}</p>;
  const powerBlocked = cap.power && power === "off";
  const hasReadyAction = cap.door || cap.climate || powerBlocked
    || (!powerBlocked && (cap.card || (cap.coin && !machine.coinAfterSwipe)
      || (cap.mahjong && state?.mahjong && (state.mahjong.seats.some(seat => seat.mine)
        || state.mahjong.seats.length < state.mahjong.capacity))));
  const spinner = <Loader2 size={22} className="animate-spin" />;
  return (
    <div className="device-controls">
      {noteAt("page")}
      {!state || state.gate === "entry" && !info ? (
        error ? <button className="session-action" onClick={() => act("load", async () => { invalidatePlayerReads(); })}>{t("重试")}</button> : <div className="flex justify-center" role="status" aria-label={t("正在加载")}>{spinner}</div>
      ) : state.gate === "binding" ? (
        <PlatformBinding code={code} />
      ) : (
        <>
          {state.gate === "entry" && info && (
            <div className="grid gap-6">
              <h2>{t(billingError ? "暂时无法使用" : "计费规则")}</h2>
              {billingError ? (
                <p role="alert" className="text-sm text-coral">{billingError.message}</p>
              ) : (
                <>
                  {rules ? (
                    <ResourcePricing rules={rules} changes={preview ?? undefined} />
                  ) : (
                    <>
                      {preview && <BillingChanges preview={preview} />}
                      <EntryPricing info={info} />
                    </>
                  )}
                </>
              )}
              <label className="flex items-start gap-3 text-sm leading-relaxed">
                <input
                  className="mt-1 shrink-0"
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>
                  {t("确认开始计费，离店前请结账。关闭页面不会停止计费。")}
                </span>
              </label>
              {!cap.door && (
                <button
                  className="session-action primary"
                  disabled={!!busy || !consent || !!billingError}
                  onClick={() =>
                    act("entry", async () => {
                      await playerOperation(
                        shopApi(code, "player/session/start"),
                        {
                          ticket,
                          consent,
                          location: await operationLocation(
                            info.shop.locationEnabled ?? info.shop.checkinGeo,
                          ),
                          // The server refuses a confirmation of a state that has since changed.
                          ...(preview ? { expectedRevision: preview.revision } : {}),
                        },
                      );
                    })
                  }
                >
                  {busy === "entry" && spinner}
                  {t("确认")}
                </button>
              )}
              {noteAt("entry")}
            </div>
          )}
          {cap.door && (
            <div className="grid gap-6">
              {password && (
                <div className="door-password">
                  <h2>{t("开门密码")}</h2>
                  <output className="select-all">
                    {password.temporaryPassword}
                  </output>
                  <small>
                    {t("有效期至")}{" "}
                    {billTime(password.expiresAt).time}
                  </small>
                  <p>{t("在门锁上输入密码后按 #")}</p>
                </div>
              )}
              <button
                className="session-action primary"
                disabled={
                  !!busy || cardBusy || (state.gate === "entry" && (!consent || !!billingError))
                }
                onClick={() =>
                  state.gate === "entry" && info ? enterAndOpenDoor(info.shop) : operate("door.open")}
              >
                {busy === "door.open" ? spinner : <DoorOpen size={22} />}{" "}
                {t(
                  password
                    ? "重新获取密码"
                    : state.gate === "entry"
                      ? "入场并获取开门密码"
                      : "获取开门密码",
                )}
              </button>
              {noteAt("door")}
            </div>
          )}
          {state.gate === "ready" && cap.climate && (
            <PlayerClimate
              state={climateState}
              busy={busy.startsWith("climate.") ? busy : ""}
              blocked={!!busy || cardBusy}
              send={(action, extra) => void climate(action, extra)}
            />
          )}
          {state.gate === "ready" && cap.climate && noteAt("climate")}
          {state.gate === "ready" &&
            (cap.power && power === "off" ? (
              <div className="grid gap-7 text-center">
                <h2>{t("设备尚未开机")}</h2>
                <button
                  className="session-action primary"
                  disabled={!!busy || cardBusy || waitingPower}
                  onClick={() => operate("power.on")}
                >
                  {busy === "power.on" || waitingPower ? (
                    spinner
                  ) : (
                    <Power size={22} />
                  )}{" "}
                  {t("开机")}
                </button>
                {noteAt("power")}
              </div>
            ) : (
              <>
                {cap.mahjong && state.mahjong && <section className="mahjong-table">
                  <header className="mahjong-heading">
                    <div><h2>{t("麻将桌")}</h2><p>{t(state.mahjong.seats.some(s=>s.playing) ? "麻将计费中" : "等待玩家")}</p></div>
                    <span className="mahjong-count">{state.mahjong.seats.length}<span> / {state.mahjong.capacity}</span></span>
                  </header>
                  <ul className="mahjong-seats">
                    {Array.from({length: state.mahjong.capacity}, (_,i)=>{
                      const seat = state.mahjong!.seats[i];
                      return <li className={`mahjong-seat${seat?.mine ? " is-mine" : ""}${!seat ? " is-empty" : ""}`} key={i}>
                        <span className="mahjong-seat-name">{seat?.name || t("空位")}</span>
                        {seat?.mine && <span className="mahjong-self">{t("你")}</span>}
                      </li>;
                    })}
                  </ul>
                  {!state.mahjong.seats.some(s=>s.mine) && state.mahjong.seats.length >= state.mahjong.capacity
                    ? <p className="mahjong-full">{t("已满桌")}</p>
                    : <button className={`session-action${state.mahjong.seats.some(s=>s.mine) ? "" : " primary"}`} disabled={!!busy || cardBusy}
                        onClick={()=>operate(state.mahjong!.seats.some(s=>s.mine) ? "mahjong.leave" : "mahjong.join")}>
                        {busy.startsWith("mahjong.") && spinner}{t(state.mahjong.seats.some(s=>s.mine) ? "下桌" : "上桌")}
                      </button>}
                  {noteAt("mahjong")}
                </section>}
                {cap.card && (
                  <section>
                    <div className="session-task device-card-heading">
                      <h2>{t(cardTask ? "添加卡片" : "选择卡片")}</h2>
                      {!cardTask && cardHeadingAction}
                    </div>
                    {cardTask ?? (
                      <fieldset disabled={!!busy || cardBusy}>
                        {children}
                      </fieldset>
                    )}
                  </section>
                )}
                {cap.coin && !machine.coinAfterSwipe && !cardTask && (
                  // The press answers on the button itself (已投币, 请稍后再投币…) for a moment.
                  <button
                    className="session-action"
                    data-level={coinNote?.level}
                    disabled={!!busy || cardBusy}
                    onClick={() => operate("coin")}
                    aria-live="polite"
                  >
                    {busy === "coin" ? (
                      spinner
                    ) : coinNote ? (
                      <NoticeIcon level={coinNote.level} size={22} />
                    ) : (
                      <Coins size={22} />
                    )}{" "}
                    {coinNote ? coinNote.body : t("投币")}
                  </button>
                )}
              </>
            ))}
          {state.gate === "ready" && !hasReadyAction && <p className="session-subtitle text-center">{t("这里没有可操作的设备")}</p>}
        </>
      )}
    </div>
  );
}

/** What confirming starts, ends and keeps; a plan kept running keeps its timer. */
function BillingChanges({ preview }: { preview: NonNullable<ResourceBilling["preview"]> }) {
  const { t } = useI18n();
  const rows: [string, BillingChange[]][] = [
    [t("新增方案"), preview.started],
    [t("结束方案"), preview.stopped],
    [t("保留方案"), preview.kept],
  ];
  return (
    <dl className="grid gap-2 text-sm">
      {rows.filter(([, items]) => items.length).map(([label, items]) => (
        <div className="flex flex-wrap gap-x-3" key={label}>
          <dt className="text-ink/60">{label}</dt>
          <dd className="font-medium">{items.map((item) => item.planName).join("、")}</dd>
        </div>
      ))}
    </dl>
  );
}
