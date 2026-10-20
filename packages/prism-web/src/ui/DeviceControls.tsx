import { isTransientReadFailure, usePagePolling } from "./use-page-polling";
import { billTime } from "./bill-time";
import { PlatformBinding } from "./SessionContent";
import { ClimateControls, type ClimateState } from "./ClimateControls";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Power, DoorOpen, Coins, Loader2, Check } from "lucide-react";
import { api, invalidatePlayerReads, playerOperation, type PublicMachine } from "../api";
import { useI18n } from "../i18n";
import {
  operationLocation,
  shopApi,
  type ShopInfo,
  type Summary,
  EntryPricing,
} from "./BillingPages";
import { useAuth } from "./AuthContext";
import { PlayerDialog } from "./PlayerAccountMenu";

type DeviceState = {
  gate: "ready" | "binding" | "entry";
  power: "on" | "off" | "unknown" | "unmanaged";
  coinUsed: boolean;
  climate?: ClimateState | null;
  mahjong?: {capacity:number;seats:{name:string;mine:boolean;playing:boolean}[]} | null;
};
export function DeviceControls({
  machine,
  ticket,
  children,
  cardBusy, onExpired,
}: {
  machine: PublicMachine;
  ticket: string;
  children: ReactNode;
  cardBusy: boolean;
  onExpired: () => void;
}) {
  const { t, errorText } = useI18n();
  const code = machine.shop.publicId!;
  const { setBillingActive } = useAuth();
  const [state, setState] = useState<DeviceState | null>(null);
  const [power, setPower] = useState<DeviceState["power"]>("unknown");
  const [info, setInfo] = useState<ShopInfo | null>(null);
  const [password, setPassword] = useState<{
    temporaryPassword: string;
    expiresAt: string;
  } | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [waitingPower, setWaitingPower] = useState(false);
  const refreshError = useRef("");
  const failed = useCallback(
    (e: unknown) => {
      const code =
        e && typeof e === "object" && "code" in e ? String(e.code) : "";
      if (
        [
          "TICKET_EXPIRED",
        ].includes(code)
      )
        onExpired();
      else setError(errorText(e instanceof Error ? e.message : "操作失败"));
    },
    [onExpired, errorText],
  );
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const current = await api<DeviceState>(
      `/api/v1/devices/session/state?ticket=${encodeURIComponent(ticket)}&includePower=0`, { signal });
    if (signal?.aborted) return;
    setState(current);
    const previousRefreshError = refreshError.current;
    setError(previous => previous === previousRefreshError ? "" : previous);
    refreshError.current = "";
  }, [ticket]);
  usePagePolling(async signal => {
    try { await refresh(signal); }
    catch (e) {
      if (!signal.aborted && (!isTransientReadFailure(e) || !state)) {
        refreshError.current = errorText(e instanceof Error ? e.message : "操作失败");
        failed(e);
      }
      throw e;
    }
  }, !busy && !cardBusy, ticket, !state || state.gate === "binding" || !!machine.capabilities.mahjong);
  const previousGate = useRef<DeviceState["gate"] | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    if (previousGate.current !== undefined && previousGate.current !== state?.gate) invalidatePlayerReads();
    previousGate.current = state?.gate;
    api<ShopInfo>(shopApi(code)).then(shop => { if (!cancelled) setInfo(shop); }).catch(failed);
    return () => { cancelled = true; };
  }, [code, state?.gate, failed]);
  usePagePolling(async signal => {
    try {
      const current = await api<{ power: DeviceState["power"] }>(
        `/api/v1/devices/session/power?ticket=${encodeURIComponent(ticket)}`, { signal });
      if (signal.aborted) return;
      setPower(current.power);
      if (current.power === "on") setWaitingPower(false);
      if (current.power === "unknown") throw new TypeError("Power state unavailable");
    } catch (error) {
      if (!signal.aborted && !isTransientReadFailure(error)) failed(error);
      throw error;
    }
  }, !!machine.capabilities.power && state?.gate === "ready" && !busy && !cardBusy, ticket,
    waitingPower || power === "unknown");
  useEffect(() => {
    let cancelled = false;
    if (info?.shop.billingEnabled && info.membership) {
      api<Summary>(shopApi(code, "player/me")).then((current) => {
        if (!cancelled) setBillingActive(code, !!current.activeSession);
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [code, state?.gate, info?.shop.billingEnabled, info?.membership?.playerId, setBillingActive]);
  async function act(action: string, fn: () => Promise<void>) {
    if (busy || cardBusy) return;
    setBusy(action);
    try {
      await fn();
      await Promise.all([refresh(), api<ShopInfo>(shopApi(code)).then(setInfo)]);
    } catch (e) {
      if (
        e &&
        typeof e === "object" &&
        "code" in e &&
        e.code === "COIN_ALREADY_USED"
      )
        await refresh().catch(failed);
      else failed(e);
    } finally {
      setBusy("");
    }
  }
  function climate(action: string, extra?: Record<string, unknown>) {
    return act(action, async () => {
      const location = await operationLocation(!!(machine.shop.locationEnabled ?? machine.shop.machineGeo));
      const result = await playerOperation<{ climate?: ClimateState | null }>("/api/v1/devices/session/actions", {
        ticket,
        action,
        location,
        ...extra,
      });
      if (result.climate) setState((current) => (current ? { ...current, climate: result.climate } : current));
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
      if (action === "power.on") setWaitingPower(true);
      if (action === "coin")
        setState((current) =>
          current ? { ...current, coinUsed: true } : current,
        );
    });
  }
  const cap = machine.capabilities;
  if (!Object.values(cap).some(Boolean)) return <p className="session-subtitle text-center">{t("当前设备没有可操作项")}</p>;
  const powerBlocked = cap.power && power === "off";
  const hasReadyAction = cap.door || cap.climate || powerBlocked
    || (!powerBlocked && (cap.card || (cap.coin && !machine.coinAfterSwipe)
      || (cap.mahjong && state?.mahjong && (state.mahjong.seats.some(seat => seat.mine)
        || state.mahjong.seats.length < state.mahjong.capacity))));
  const spinner = <Loader2 size={22} className="animate-spin" />;
  return (
    <div className="device-controls">
      {error && (
        <PlayerDialog title={t("操作失败")} onClose={() => setError("")}>
          <p className="text-sm leading-relaxed">{error}</p>
        </PlayerDialog>
      )}
      {!state || state.gate === "entry" && !info ? (
        error ? <button className="session-action" onClick={() => act("load", async () => { invalidatePlayerReads(); })}>{t("重试")}</button> : <div className="flex justify-center" role="status" aria-label={t("正在加载")}>{spinner}</div>
      ) : state.gate === "binding" ? (
        <PlatformBinding code={code} />
      ) : (
        <>
          {state.gate === "entry" && info && (
            <div className="grid gap-6">
              <h2>{t("确认入场")}</h2>
              <EntryPricing info={info} />
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
                  disabled={!!busy || !consent}
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
                        },
                      );
                    })
                  }
                >
                  {busy === "entry" && spinner}
                  {t("确认入场")}
                </button>
              )}
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
                  !!busy || cardBusy || (state.gate === "entry" && !consent)
                }
                onClick={() => operate("door.open")}
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
            </div>
          )}
          {state.gate === "ready" && cap.climate && (
            <section className="grid gap-4">
              <h2>{t("空调")}</h2>
              <ClimateControls
                state={state.climate ?? null}
                busy={busy.startsWith("climate.") ? busy : ""}
                disabled={!!busy || cardBusy}
                send={(action, extra) => void climate(action, extra)}
                powerClass={`session-action${state.climate && state.climate.mode !== "off" ? "" : " primary"}`}
              />
            </section>
          )}
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
                </section>}
                {cap.card && (
                  <section>
                    <div className="session-task device-card-heading">
                      <h2>{t("选择卡片")}</h2>
                    </div>
                    <fieldset disabled={!!busy || cardBusy}>
                      {children}
                    </fieldset>
                  </section>
                )}
                {cap.coin && !machine.coinAfterSwipe && (
                  <button
                    className="session-action"
                    disabled={!!busy || cardBusy}
                    onClick={() => operate("coin")}
                  >
                    {busy === "coin" ? (
                      spinner
                    ) : (
                      <Coins size={22} />
                    )}{" "}
                    {t("投币")}
                  </button>
                )}
              </>
            ))}
          {state.gate === "ready" && !hasReadyAction && <p className="session-subtitle text-center">{t("当前设备没有可操作项")}</p>}
        </>
      )}
    </div>
  );
}
