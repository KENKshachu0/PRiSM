import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { Power, DoorOpen, Coins, Loader2, Check } from "lucide-react";
import { ApiError, api, playerOperation, type PublicMachine } from "../api";
import { useI18n } from "../i18n";
import {
  operationLocation,
  shopApi,
  post,
  type ShopInfo,
  type Summary,
  EntryPricing,
} from "./BillingPages";
import { useAuth } from "./AuthContext";
import { PlayerDialog } from "./PlayerAccountMenu";

type DeviceState = {
  gate: "ready" | "qq" | "entry";
  power: "on" | "off" | "unknown" | "unmanaged";
  coinUsed: boolean;
  mahjong?: {capacity:number;seats:{name:string;mine:boolean;playing:boolean}[]} | null;
};
export function DeviceControls({
  machine,
  ticket,
  children,
  cardBusy,
}: {
  machine: PublicMachine;
  ticket: string;
  children: ReactNode;
  cardBusy: boolean;
}) {
  const { t, errorText } = useI18n();
  const navigate = useNavigate();
  const code = machine.shop.publicId!;
  const { setBillingActive } = useAuth();
  const [state, setState] = useState<DeviceState | null>(null);
  const [info, setInfo] = useState<ShopInfo | null>(null);
  const [binding, setBinding] = useState<{
    code: string;
    expiresAt: string;
  } | null>(null);
  const generating = useRef(false);
  const [bindingFailed, setBindingFailed] = useState(false);
  const [password, setPassword] = useState<{
    temporaryPassword: string;
    expiresAt: string;
  } | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [waitingPower, setWaitingPower] = useState(false);
  const failed = useCallback(
    (e: unknown) => {
      const code =
        e && typeof e === "object" && "code" in e ? String(e.code) : "";
      if (
        [
          "TICKET_EXPIRED",
        ].includes(code)
      )
        navigate("/m/expired", { replace: true });
      else setError(errorText(e instanceof Error ? e.message : "操作失败"));
    },
    [navigate, errorText],
  );
  const refresh = useCallback(async () => {
    const [current, shop] = await Promise.all([
      api<DeviceState>(
        `/api/v1/devices/session/state?ticket=${encodeURIComponent(ticket)}`,
      ),
      api<ShopInfo>(shopApi(code)),
    ]);
    setState(current);
    setInfo(shop);
    if (current.power !== "off") setWaitingPower(false);
  }, [ticket, code]);
  useEffect(() => {
    void refresh().catch(failed);
  }, [refresh, failed]);
  useEffect(() => {
    let cancelled = false;
    if (info?.shop.billingEnabled && info.membership) {
      api<Summary>(shopApi(code, "player/me")).then((current) => {
        if (!cancelled) setBillingActive(code, !!current.activeSession);
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [code, state?.gate, info?.shop.billingEnabled, info?.membership?.playerId, setBillingActive]);
  useEffect(() => {
    if (busy || cardBusy || (state?.gate !== "qq" && !waitingPower && !machine.capabilities.mahjong)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        if (!document.hidden) await refresh();
      } catch (e) {
        if (!stopped && e instanceof ApiError) failed(e);
      } finally {
        if (!stopped) timer = setTimeout(poll, 3000);
      }
    }
    timer = setTimeout(poll, 3000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [state?.gate, waitingPower, cardBusy, busy, refresh, failed, machine.capabilities.mahjong]);
  useEffect(() => {
    if (
      state?.gate !== "qq" ||
      generating.current ||
      bindingFailed ||
      (binding && Date.parse(binding.expiresAt) > Date.now())
    )
      return;
    generating.current = true;
    api<{ code: string; expiresAt: string }>(
      shopApi(code, "qq-binding"),
      post(),
    )
      .then(setBinding)
      .catch((e) => {
        setBindingFailed(true);
        failed(e);
      })
      .finally(() => {
        generating.current = false;
      });
  }, [state, binding, bindingFailed, code, failed]);
  async function act(action: string, fn: () => Promise<void>) {
    if (busy || cardBusy) return;
    setBusy(action);
    try {
      await fn();
      await refresh();
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
  if (!Object.values(cap).some(Boolean)) return null;
  const spinner = <Loader2 size={22} className="animate-spin" />;
  return (
    <div className="device-controls">
      {error && (
        <PlayerDialog title={t("操作失败")} onClose={() => setError("")}>
          <p className="text-sm leading-relaxed">{error}</p>
        </PlayerDialog>
      )}
      {!state || !info ? (
        error ? <button className="session-action" onClick={() => act("load", refresh)}>{t("重试")}</button> : <div className="flex justify-center" role="status" aria-label={t("正在加载")}>{spinner}</div>
      ) : state.gate === "qq" ? (
        <div className="grid gap-6">
          <h2>{t("绑定 QQ")}</h2>
          <div className="binding-code">
            <p>{t("在 QQ 群中发送")}</p>
            {binding ? (
              <>
                <code className="select-all">prism.bind {binding.code}</code>
                <small>
                  {t("有效期至")}{" "}
                  {new Date(binding.expiresAt).toLocaleTimeString()}
                </small>
              </>
            ) : bindingFailed ? (
              <button
                className="session-action"
                onClick={() => setBindingFailed(false)}
              >
                {t("重试")}
              </button>
            ) : (
              spinner
            )}
          </div>
        </div>
      ) : (
        <>
          {state.gate === "entry" && (
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
                    {new Date(password.expiresAt).toLocaleTimeString()}
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
          {state.gate === "ready" &&
            (cap.power && state.power === "off" ? (
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
        </>
      )}
    </div>
  );
}
