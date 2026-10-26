import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import {
  AirVent,
  ChevronRight,
  CreditCard,
  DoorOpen,
  Gamepad2,
  Pencil,
  Plus,
  Power,
  Printer,
  QrCode,
  RefreshCw,
  Ungroup,
} from "lucide-react";
import { Api, api, playerOperation, type DeviceEvent, type Machine } from "../../api";
import { ClimateControls, climateModeName, climateSummary, type ClimateState } from "../ClimateControls";
import { useI18n } from "../../i18n";
import {
  date,
  input,
  Modal,
  State,
  button,
  buttonQuiet,
  primary,
  useCopy,
  useMerchant,
  useResource,
  type LivePlayer,
} from "./shared";
import {
  canOperateCoin,
  capabilityOrder,
  deviceActionGroups,
  deviceActions,
  deviceCapabilities,
  isDirectConnect,
  type CapabilityId,
} from "./device-capabilities";
import { DeviceEditor } from "./DeviceEditor";
import {
  applyBoardFrame,
  hasUnwatched,
  learnBoardState,
  mergeBoardStates,
  type BoardFrame,
  type BoardState,
  type BoardStates,
  type BoardWatchers,
} from "./board-state";
import { HaWatchersPanel } from "./HaWatchers";
import { useBoardLive } from "./use-board-live";
import { useAuth } from "../AuthContext";

type Filter = "all" | CapabilityId | "unconfigured";

/** Capability pills get one icon and one accent each, so a card reads at a glance. */
const capabilityChips: Record<
  CapabilityId,
  { icon: typeof Power; label: string }
> = {
  power: { icon: Power, label: "电源" },
  climate: { icon: AirVent, label: "空调" },
  hinata_io: { icon: CreditCard, label: "刷卡" },
  door: { icon: DoorOpen, label: "门锁" },
  mahjong: { icon: Ungroup, label: "麻将桌" },
};

/**
 * The device list is cached per shop so returning to the tab shows the last
 * known cards instead of a loading line. Every mount still refetches.
 */
const machineCache = new Map<string, Machine[]>();

export function DevicesPage() {
  const { shopId, canWrite } = useMerchant();
  const { user } = useAuth();
  const { t } = useI18n();
  const [devices, setDevices] = useState<Machine[] | null>(
    () => machineCache.get(shopId) ?? null,
  );
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Machine | "new" | null>(null);
  const [qr, setQR] = useState<Machine | null>(null);
  const [acting, setActing] = useState<Machine | null>(null);
  const [history, setHistory] = useState<Machine | null>(null);
  const [editorLocked, setEditorLocked] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [params, setParams] = useSearchParams();
  // The setup guide links here with `?add=1` to open the editor directly.
  useEffect(() => {
    if (params.get("add") !== "1") return;
    if (canWrite) setEditing("new");
    const next = new URLSearchParams(params);
    next.delete("add");
    setParams(next, { replace: true });
  }, [params, setParams, canWrite]);
  const [states, setStates] = useState<BoardStates | null>(null);
  // Who is watching Home Assistant, as the hub last said. Not part of any device's state.
  const [watchers, setWatchers] = useState<BoardWatchers | null>(null);
  const [statesFailed, setStatesFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Whether the devices with no state of their own have been read since the board opened.
  const [firstRead, setFirstRead] = useState(false);
  const askedRef = useRef(false);
  // Another shop's states are not this one's.
  useEffect(() => {
    setStates(null);
    setWatchers(null);
    setStatesFailed(false);
    setFirstRead(false);
    askedRef.current = false;
  }, [shopId]);
  /**
   * The state of the whole shop over HTTP. A live device answers from what is stored and the board
   * already has it from the hub; a device with no state of its own has none stored, so Home
   * Assistant is asked for it. This is how those devices get a value: once when the board opens,
   * by the refresh button, and as the fallback while the hub's connection gives the board nothing.
   */
  const readStates = useCallback(async () => {
    askedRef.current = true;
    try {
      const r = await api<{ states: BoardStates }>(`/api/v1/merchant/machines/states?shopId=${encodeURIComponent(shopId)}`);
      setStates((previous) => mergeBoardStates(r.states, previous));
      setStatesFailed(false);
    } catch {
      setStatesFailed(true);
    }
    setFirstRead(true);
  }, [shopId]);
  /** What the panel read of one device, put where the board shows it. */
  const setDeviceState = useCallback(
    (id: string, next: BoardState) =>
      setStates((previous) => (previous ? { ...previous, [id]: learnBoardState(previous[id], next) } : previous)),
    [],
  );
  async function refresh() {
    setRefreshing(true);
    await readStates();
    setRefreshing(false);
  }
  const load = useCallback(
    () =>
      Api.machines(shopId).then((r) => {
        machineCache.set(shopId, r.machines);
        setDevices(r.machines);
      }),
    [shopId],
  );
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);
  const hasStateDevices = (devices ?? []).some((device) => {
    const caps = deviceCapabilities(device);
    return caps.power || caps.climate;
  });
  const allWatched = states !== null && !hasUnwatched(states);
  // The board's state is what the hub sends: the whole shop when the connection opens, again
  // whenever which devices are live changes, and every change of a live device. A live device is
  // never read: its changes arrive on their own, after an action as well.
  useBoardLive(
    shopId,
    hasStateDevices,
    useCallback((frame: BoardFrame) => {
      if (frame.type === "watchers") setWatchers(frame);
      else setStates((previous) => applyBoardFrame(previous, frame));
    }, []),
  );
  // A device with no state of its own is read once, as soon as the board knows which they are.
  useEffect(() => {
    if (states === null || askedRef.current || !hasUnwatched(states)) return;
    void readStates();
  }, [states, readStates]);
  // If the hub gives the board no state (it cannot connect, or says nothing), read it over HTTP.
  const unread = states === null;
  useEffect(() => {
    if (!hasStateDevices || !unread) return;
    const timer = setTimeout(() => void readStates(), statesFailed ? 15_000 : 3_000);
    return () => clearTimeout(timer);
  }, [hasStateDevices, unread, statesFailed, readStates]);
  const counts = useMemo(() => {
    const result: Record<string, number> = { all: devices?.length ?? 0 };
    for (const device of devices ?? []) {
      const caps = deviceCapabilities(device);
      for (const id of capabilityOrder) if (caps[id]) result[id] = (result[id] ?? 0) + 1;
      if (!Object.values(caps).some(Boolean))
        result.unconfigured = (result.unconfigured ?? 0) + 1;
    }
    return result;
  }, [devices]);
  const shown = devices?.filter((device) => {
    if (filter === "all") return true;
    const caps = deviceCapabilities(device);
    if (filter === "unconfigured") return !Object.values(caps).some(Boolean);
    return caps[filter];
  });
  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold">{t("店内设备")}</h2>
        <div className="flex flex-wrap items-center gap-2">
          {hasStateDevices && (
            <button
              type="button"
              className={button}
              disabled={refreshing || (states === null && !statesFailed) || allWatched}
              title={allWatched ? t("所有设备都在实时监听") : undefined}
              onClick={() => void refresh()}
            >
              <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} aria-hidden="true" />
              {t("刷新设备状态")}
            </button>
          )}
          {canWrite && (
            <button className={primary} onClick={() => setEditing("new")}>
              <Plus size={17} />
              {t("添加设备")}
            </button>
          )}
        </div>
      </header>
      {hasStateDevices && watchers && (
        <HaWatchersPanel
          shopId={shopId}
          watchers={watchers}
          devices={devices ?? []}
          // The number of watchers is the platform administrator's, for this one shop.
          canEdit={user?.role === "admin"}
          onLimit={(limit) => setWatchers((current) => (current ? { ...current, limit } : current))}
        />
      )}
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label={t("设备类型")}
      >
        {(
          [
            ["all", "全部"],
            ...capabilityOrder.map((id) => [id, capabilityChips[id].label] as const),
            ["unconfigured", "未配置"],
          ] as [Filter, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`${button} min-h-9 rounded-full px-4 py-1 ${
              filter === key
                ? "border-ink/25 bg-ink/10 font-semibold"
                : "border-transparent text-ink/55 hover:text-ink"
            }`}
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
          >
            {t(label)}
            {counts[key] ? (
              <span className="text-xs text-ink/45">{counts[key]}</span>
            ) : null}
          </button>
        ))}
      </div>
      {!shown ? (
        <State error={error} />
      ) : !shown.length ? (
        <div className="rounded-xl border border-dashed border-ink/20 px-6 py-14 text-center">
          <Gamepad2 className="mx-auto mb-4 text-ink/30" size={32} />
          <p className="font-medium">
            {t(filter === "all" ? "还没有任何设备" : "这个分类下没有设备")}
          </p>
          {filter === "all" && (
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink/55">
              {t("一台设备对应店里一样玩家扫码就能用的东西：一台机台、一扇门或一张麻将桌。添加后它会有专属二维码。")}
            </p>
          )}
          {canWrite && (
            <button
              className={`${primary} mt-5`}
              onClick={() => setEditing("new")}
            >
              <Plus size={16} />
              {t("添加设备")}
            </button>
          )}
        </div>
      ) : (
        <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((device) => (
            <DeviceCard
              key={device.id}
              device={device}
              canWrite={canWrite}
              state={states?.[device.id] ?? null}
              stateFailed={statesFailed && states === null}
              // The first read of a device with no state of its own is still on its way.
              pending={!firstRead && !!states?.[device.id] && !states[device.id]!.watching}
              onAct={() => setActing(device)}
              onQR={() => setQR(device)}
              onHistory={() => setHistory(device)}
              onEdit={() => setEditing(device)}
            />
          ))}
        </div>
      )}
      {acting && (
        <Modal
          title={`${acting.name} · ${t("操作")}`}
          close={() => setActing(null)}
        >
          <DeviceActions
            device={acting}
            state={states?.[acting.id] ?? null}
            onState={(next) => setDeviceState(acting.id, next)}
            onChanged={() => void load()}
          />
        </Modal>
      )}
      {history && (
        <Modal
          title={`${history.name} · ${t("操作记录")}`}
          close={() => setHistory(null)}
          wide
        >
          <DeviceHistory device={history} />
        </Modal>
      )}
      {editing && (
        <Modal
          title={editing === "new" ? "添加设备" : "编辑设备"}
          close={() => setEditing(null)}
          dismissDisabled={editorLocked}
          wide
        >
          <DeviceEditor
            value={editing === "new" ? undefined : editing}
            onLockChange={setEditorLocked}
            done={() => {
              setEditing(null);
              void load();
            }}
          />
        </Modal>
      )}
      {qr && (
        <Modal title="设备二维码" close={() => setQR(null)}>
          <DeviceQR device={qr} />
        </Modal>
      )}
    </div>
  );
}

function DeviceQR({ device }: { device: Machine }) {
  const { t } = useI18n();
  const [copied, copy] = useCopy();
  const code = useRef<HTMLDivElement>(null);
  const url = `${window.location.origin}/t/${device.shopPublicId}/${device.publicId}`;
  function print() {
    const svg = code.current?.querySelector("svg")?.outerHTML;
    const view = window.open("", "_blank", "width=480,height=640");
    if (!svg || !view) return;
    const name = document.createElement("h1");
    name.textContent = device.name;
    view.document.title = device.name;
    view.document.body.innerHTML = `<main style="display:grid;justify-items:center;gap:16px;padding:32px;font-family:system-ui,sans-serif">${svg}${name.outerHTML}</main>`;
    view.document.querySelector("svg")?.setAttribute("width", "320");
    view.document.querySelector("svg")?.setAttribute("height", "320");
    view.focus();
    view.print();
  }
  return (
    <div className="grid justify-items-center gap-5">
      <div ref={code} className="bg-white p-4">
        <QRCodeSVG value={url} size={224} level="M" />
      </div>
      <h3 className="text-lg font-semibold">{device.name}</h3>
      <div className="flex flex-wrap justify-center gap-2">
        <button type="button" className={primary} onClick={print}>
          <Printer size={16} aria-hidden="true" />
          {t("打印")}
        </button>
        <button type="button" className={button} onClick={() => copy(url)}>
          {t(
            copied === "copied"
              ? "已复制"
              : copied === "failed"
                ? "复制失败"
                : "复制链接 / 写入 NFC",
          )}
        </button>
        <a className={button} href={url} target="_blank" rel="noreferrer">
          {t("测试扫码入口")}
        </a>
      </div>
      <p className="max-w-sm text-center text-xs leading-relaxed text-ink/55">
        {t("NFC：用任意 NFC 写入工具把这个链接写进标签，记录类型选网址（NDEF URI）。iPhone 碰一下会直接打开 PRiSM Link（App Clip，免安装），其它手机用浏览器打开。")}
      </p>
    </div>
  );
}

/**
 * A card states what the device is for, what it can do, and its live power
 * state. Secondary actions live behind an overflow menu: three equal-weight
 * buttons used to overflow the card as soon as the labels grew.
 */
function DeviceCard({
  device,
  canWrite,
  state,
  stateFailed,
  pending,
  onAct,
  onQR,
  onHistory,
  onEdit,
}: {
  device: Machine;
  canWrite: boolean;
  /** What the board knows of this device's power and air conditioner; null until it is read. */
  state: BoardState | null;
  stateFailed: boolean;
  /** A device with no state of its own whose first read has not come back yet. */
  pending: boolean;
  onAct: () => void;
  onQR: () => void;
  onHistory: () => void;
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const caps = deviceCapabilities(device);
  const enabled = !!device.enabled;
  const configured = Object.values(caps).some(Boolean);
  const actions = deviceActions(device);
  // Seating a player is a mahjong operation even though the catalog lists no
  // device action for that capability.
  const hasControls = actions.length > 0 || !!caps.mahjong;
  // The capability chips carry the device's purpose, so the card has no
  // separate subtitle saying the same thing again.
  const chips = capabilityOrder.filter((id) => caps[id]);
  return (
    <article
      className={`flex flex-col rounded-xl border border-ink/10 bg-panel ${
        enabled ? "" : "opacity-60"
      }`}
    >
      <div className="flex items-center gap-3 px-5 py-4">
        <span
          className={`grid size-11 shrink-0 place-items-center rounded-xl ${
            caps.door && !configured
              ? "bg-ink/5 text-ink/40"
              : "bg-mint/10 text-mint"
          }`}
        >
          {caps.door ? <DoorOpen size={22} /> : <Gamepad2 size={22} />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold">{device.name}</h3>
          {!enabled && (
            <p className="mt-1 text-xs text-ink/50">{t("已停用")}</p>
          )}
        </div>
      </div>
      {chips.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2 px-5 text-xs text-ink/70">
          {chips.map((id) => {
            const chip = capabilityChips[id];
            const Icon = chip.icon;
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1.5 rounded-md bg-ink/5 px-2 py-1 text-xs text-ink/70"
              >
                <Icon size={13} />
                {t(chip.label)}
                {id === "mahjong" && device.mahjong && (
                  <span className="text-ink/50">
                    {t("{count} 人", { count: device.mahjong.capacity })}
                  </span>
                )}
                {id === "hinata_io" && isDirectConnect(device) && (
                  <span className="text-mint">{t("直连")}</span>
                )}
              </span>
            );
          })}
          {caps.hinata_io && canOperateCoin(device) && device.coinAfterSwipe && (
            <span className="inline-flex items-center rounded-md bg-ink/5 px-2 py-1 text-xs text-ink/60">
              {t("刷卡后投币")}
            </span>
          )}
          {caps.door && device.ttlockLockId && (
            <span className="inline-flex items-center rounded-md bg-ink/5 px-2 py-1 text-xs text-ink/60">
              TTLock · {device.ttlockLockId}
            </span>
          )}
        </div>
      )}
      {!configured && canWrite && (
        <div className="px-5 pt-3">
          <button type="button" className={`${primary} min-h-9 px-3 py-1`} onClick={onEdit}>
            {t("配置能力")}
          </button>
        </div>
      )}
      {(caps.power || caps.climate || isDirectConnect(device)) && (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 px-5 text-xs">
          {(caps.power || caps.climate) && (
            <LiveStatus state={state} failed={stateFailed} pending={pending} power={caps.power} climate={caps.climate} />
          )}
          {isDirectConnect(device) && (
            <span className="flex items-center gap-1.5 text-ink/60">
              <span
                className={
                  device.relayOnline === true
                    ? "text-mint"
                    : device.relayOnline === false
                      ? "text-coral"
                      : "text-ink/35"
                }
                aria-hidden="true"
              >
                ●
              </span>
              {t(
                device.relayOnline === true
                  ? "机台在线"
                  : device.relayOnline === false
                    ? "机台离线"
                    : "连接未知",
              )}
            </span>
          )}
        </div>
      )}
      <footer className="mt-auto flex items-center justify-between gap-2 border-t border-ink/10 px-4 py-2">
        {canWrite && hasControls && (
          <button
            type="button"
            className={`${primary} min-h-9 flex-1 px-3 py-1 text-xs`}
            disabled={!enabled}
            onClick={onAct}
          >
            {t("操作")}
          </button>
        )}
        {canWrite && (
          <button
            type="button"
            className={`${button} min-h-9 ${hasControls ? "" : "flex-1"} px-3 py-1 text-xs`}
            onClick={onEdit}
          >
            <Pencil size={14} />
            {t("编辑")}
          </button>
        )}
        <button
          type="button"
          className={`${buttonQuiet} min-h-9 px-2 text-xs`}
          onClick={onHistory}
        >
          {t("操作记录")}
          <ChevronRight size={15} className="text-ink/35" />
        </button>
        <button
          type="button"
          className={`${buttonQuiet} grid size-9 shrink-0 place-items-center px-0`}
          aria-label={`${t("设备二维码")} ${device.name}`}
          onClick={onQR}
        >
          <QrCode size={16} />
        </button>
      </footer>
    </article>
  );
}

/**
 * A device's power and air conditioner as the board knows them, with a tag for
 * how: 实时 when a HINATA IO reports every change, 非实时 when the device has no
 * state of its own and shows only what the last refresh found.
 */
function LiveStatus({
  state,
  failed,
  pending,
  power: hasPower,
  climate: hasClimate,
}: {
  state: BoardState | null;
  failed: boolean;
  pending: boolean;
  power: boolean;
  climate: boolean;
}) {
  const { t } = useI18n();
  // Waiting for a read is not "unknown": a device with no state of its own is read once, and
  // only a read that found nothing (or failed) leaves it without a value.
  const waiting = !failed && (!state || (pending && state.power === null && state.climate === null));
  const power = failed ? "unknown" : waiting ? "loading" : state?.power ?? "unknown";
  const running = !!state?.climate && state.climate.mode !== "off";
  return (
    <>
      {state && (
        <span
          className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
            state.watching ? "bg-mint/10 text-mint" : "bg-ink/5 text-ink/55"
          }`}
        >
          {t(state.watching ? "实时" : "非实时")}
        </span>
      )}
      {hasPower && (
        <span className={`flex items-center gap-1.5 ${power === "on" ? "text-mint" : "text-ink/50"}`}>
          <span
            className={`size-1.5 rounded-full ${power === "on" ? "bg-mint" : "bg-ink/30"}`}
            aria-hidden="true"
          />
          {t(
            power === "on"
              ? "已开机"
              : power === "off"
                ? "已关机"
                : power === "loading"
                  ? "读取电源状态…"
                  : "电源状态未知",
          )}
        </span>
      )}
      {hasClimate && (
        <span className={`flex items-center gap-1.5 ${running ? "text-mint" : "text-ink/50"}`}>
          <AirVent size={13} aria-hidden="true" />
          {waiting
            ? t("读取空调状态…")
            : t("空调：{mode}", { mode: climateSummary(state?.climate ?? null, t) })}
        </span>
      )}
    </>
  );
}
/**
 * Pair each request with its result so an action is one line. A result whose
 * request fell outside the loaded page is shown on its own.
 */
function timeline(events: DeviceEvent[]) {
  const results = new Map(
    events.filter((e) => e.kind === "result" && e.operationId).map((e) => [e.operationId!, e]),
  );
  const requested = new Set(events.filter((e) => e.kind === "request").map((e) => e.operationId));
  return events
    .filter((e) => e.kind !== "result" || !requested.has(e.operationId))
    .map((event) => ({
      event: event.kind === "result" ? { ...event, kind: "request" as const } : event,
      result: event.kind === "result" ? event : event.operationId ? results.get(event.operationId) : undefined,
    }));
}

function changeLabel(event: DeviceEvent, t: (message: string, values?: Record<string, string | number>) => string): string {
  const to = event.payload.to;
  if (event.name === "power") return t(to === "on" ? "电源已开启" : "电源已关闭");
  if (event.name === "link") return t(to === "online" ? "机台已连接" : "机台已断开");
  if (event.name === "idle") return t(to === true ? "已闲置" : "恢复使用");
  if (event.name === "climate" && to && typeof to === "object") {
    const setting = to as { mode?: string; temperature?: number | null };
    const mode = t(climateModeName(String(setting.mode ?? "")));
    return setting.mode !== "off" && typeof setting.temperature === "number"
      ? t("空调：{mode} {value}°", { mode, value: setting.temperature })
      : t("空调：{mode}", { mode });
  }
  return event.name;
}

const actionLabels: Record<string, string> = {
  "power.on": "开机",
  "power.off": "关机",
  "power.keep": "延迟关机",
  "climate.on": "开空调",
  "climate.off": "关空调",
  "climate.set_mode": "切换空调模式",
  "climate.set_temperature": "设定温度",
  "climate.set_fan_mode": "调整风速",
  coin: "投币",
  "door.open": "获取开门密码",
  "aime.scan": "刷卡",
  "card.state": "读卡状态变化",
  "card.consumed": "卡片已送入游戏",
  "led.set": "灯光",
};

type MahjongSeat = { playerId: string; name: string; playing: boolean };
type MahjongTable = { capacity: number; seats: MahjongSeat[] };

const capabilityMeta: Record<
  CapabilityId,
  { icon: typeof Power; title: string }
> = {
  power: { icon: Power, title: "电源控制" },
  climate: { icon: AirVent, title: "空调" },
  hinata_io: { icon: CreditCard, title: "刷卡 · HINATA IO" },
  door: { icon: DoorOpen, title: "开门密码" },
  mahjong: { icon: Ungroup, title: "麻将桌" },
};

/**
 * Sending commands is a separate surface from reading the log: one is an
 * action with consequences, the other is history. Keeping them in one modal
 * made the destructive buttons look like part of the record.
 *
 * Actions are grouped by the capability that owns them, and each group shows
 * the state that decides what those actions will do.
 */
function DeviceActions({
  device,
  state,
  onState,
  onChanged,
}: {
  device: Machine;
  /** Power and air conditioner as the board has them: pushed for a live device, last read otherwise. */
  state: BoardState | null;
  /** Hands the board what this panel read of the device. */
  onState: (next: BoardState) => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const caps = deviceCapabilities(device);
  const groups = deviceActionGroups(device);
  const players = useResource<{ players: LivePlayer[] }>(
    caps.mahjong ? "live-players" : null,
  );
  const [selectedPlayer, setSelectedPlayer] = useState("");
  const [cardNumber, setCardNumber] = useState("");
  const [coinKey, setCoinKey] = useState("");
  const power = state?.power ?? null;
  const climate = state?.climate ?? null;
  const [table, setTable] = useState<MahjongTable | null>(null);
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  /**
   * A device with no state of its own, asked of Home Assistant: its power and air conditioner go to the board.
   */
  const readState = useCallback(
    () =>
      api<{ watching: boolean; power: "on" | "off" | null; climate: ClimateState | null }>(
        `/api/v1/merchant/machines/${device.id}/state`,
      )
        .then((r) => onStateRef.current({ watching: r.watching, power: r.power, climate: r.climate ?? null }))
        .catch(() => {}),
    [device.id],
  );
  /** The mahjong table is not Home Assistant state and nothing pushes it, so it is read on its own. */
  const readTable = useCallback(
    () =>
      api<{ mahjong: MahjongTable | null }>(`/api/v1/merchant/machines/${device.id}/mahjong`)
        .then((r) => setTable(r.mahjong))
        .catch(() => {}),
    [device.id],
  );
  // Opening the panel reads nothing about power or the air conditioner; the board already has it.
  useEffect(() => {
    if (caps.mahjong) void readTable();
  }, [caps.mahjong, readTable]);
  async function send(action: string, extra?: Record<string, unknown>) {
    if (busy) return;
    setBusy(action);
    setError("");
    setResult("");
    try {
      const r = await playerOperation<{
        temporaryPassword?: string;
        mahjong?: MahjongTable;
      }>(`/api/v1/merchant/machines/${device.id}/actions`, {
        action,
        ...extra,
      });
      setResult(
        r?.temporaryPassword
          ? `${t("开门密码")} ${r.temporaryPassword}`
          : t("已发送"),
      );
      if (r?.mahjong) setTable(r.mahjong);
      else if (action.startsWith("mahjong.")) void readTable();
      // A device that reports its own changes needs nothing read: the change arrives on its own.
      // One with no state of its own is asked once, since nothing else will say what the action did.
      if (/^(power|climate)\./.test(action) && !state?.watching) void readState();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("操作失败"));
    } finally {
      setBusy("");
    }
  }
  // Seating needs an entry, so only players who are in the shop are offered.
  const playerOptions = (players.data?.players ?? []).map((player) => ({
    id: player.playerId,
    name: player.displayName,
  }));
  const seated = new Set(table?.seats.map((seat) => seat.playerId));
  const full = !!table && table.seats.length >= table.capacity;
  /** The state each capability's actions act on, shown in its header. */
  const stateLabel = (id: CapabilityId): string => {
    if (id === "power")
      return power === "on"
        ? t("已开机")
        : power === "off"
          ? t("已关机")
          : t("未知");
    if (id === "climate") return climateSummary(climate, t);
    if (id === "hinata_io")
      return device.relayOnline === true
        ? t("已连接")
        : device.relayOnline === false
          ? t("未连接")
          : isDirectConnect(device)
            ? t("未知")
            : t("外部中继");
    if (id === "door")
      return device.ttlockLockId ? `TTLock · ${device.ttlockLockId}` : "";
    return table ? `${table.seats.length} / ${table.capacity}` : "";
  };
  const sections = capabilityOrder.filter(
    (id) =>
      groups.some((group) => group.capability === id) ||
      (id === "mahjong" && caps.mahjong),
  );
  return (
    <div className="grid gap-4">
      {sections.map((id) => {
        const meta = capabilityMeta[id];
        const Icon = meta.icon;
        const actionNames =
          groups.find((group) => group.capability === id)?.actions ?? [];
        return (
          <section key={id} className="rounded-xl border border-ink/10 p-4">
            <header className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm font-medium">
                <Icon size={16} className="text-ink/45" />
                {t(meta.title)}
              </span>
              <span className="text-xs text-ink/55">{stateLabel(id)}</span>
            </header>
            <div className="mt-3 grid gap-3">
              {(id === "power" || id === "door") && (
                <div className="flex flex-wrap gap-2">
                  {actionNames.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className={`${button} min-h-11 justify-center`}
                      // The click is the intent; pressing the button again is
                      // easier than confirming a second time.
                      disabled={!device.enabled || !!busy}
                      onClick={() => void send(name)}
                    >
                      {t(actionLabels[name] ?? name)}
                    </button>
                  ))}
                </div>
              )}
              {id === "climate" && (
                <ClimateControls
                  state={climate}
                  busy={busy}
                  disabled={!device.enabled}
                  send={(action, extra) => void send(action, extra)}
                  powerClass={`${button} min-h-11 justify-self-start`}
                />
              )}
              {id === "hinata_io" && actionNames.includes("aime.scan") && (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className={`${input} min-h-9 w-56 font-mono`}
                    inputMode="numeric"
                    maxLength={20}
                    placeholder={t("20 位卡号")}
                    aria-label={t("卡号")}
                    value={cardNumber}
                    disabled={!device.enabled}
                    onChange={(e) =>
                      setCardNumber(
                        e.target.value.replace(/\D/g, "").slice(0, 20),
                      )
                    }
                  />
                  <button
                    type="button"
                    className={button}
                    disabled={
                      !device.enabled || cardNumber.length !== 20 || !!busy
                    }
                    onClick={() => void send("aime.scan", { cardNumber })}
                  >
                    {t("刷卡")}
                  </button>
                </div>
              )}
              {id === "hinata_io" && actionNames.includes("coin") && (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className={`${input} min-h-9 w-40`}
                    placeholder={t("按键")}
                    aria-label={t("投币按键")}
                    value={coinKey}
                    disabled={!device.enabled}
                    onChange={(e) => setCoinKey(e.target.value)}
                  />
                  <button
                    type="button"
                    className={button}
                    disabled={!device.enabled || !!busy}
                    onClick={() =>
                      void send(
                        "coin",
                        coinKey.trim() ? { key: coinKey } : undefined,
                      )
                    }
                  >
                    {t("投币")}
                  </button>
                </div>
              )}
              {id === "mahjong" && (
                <>
                  <div className="grid gap-1">
                    {table?.seats.map((seat) => (
                      <div
                        key={seat.playerId}
                        className="flex items-center justify-between gap-2 rounded-lg bg-ink/5 px-3 py-2 text-sm"
                      >
                        <span>{seat.name}</span>
                        <button
                          type="button"
                          className={`${buttonQuiet} min-h-8 px-2 text-xs`}
                          disabled={!device.enabled || !!busy}
                          onClick={() =>
                            void send("mahjong.unseat", {
                              playerId: seat.playerId,
                            })
                          }
                        >
                          {t("下桌")}
                        </button>
                      </div>
                    ))}
                    {table && !table.seats.length && (
                      <p className="text-sm text-ink/55">{t("空位")}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      className={`${input} min-h-9 max-w-56`}
                      aria-label={t("选择玩家")}
                      value={selectedPlayer}
                      onChange={(e) => setSelectedPlayer(e.target.value)}
                    >
                      <option value="">{t("选择玩家")}</option>
                      {playerOptions
                        .filter((player) => !seated.has(player.id))
                        .map((player) => (
                          <option key={player.id} value={player.id}>
                            {player.name}
                          </option>
                        ))}
                    </select>
                    <button
                      type="button"
                      className={button}
                      disabled={
                        !device.enabled || full || !selectedPlayer || !!busy
                      }
                      onClick={() =>
                        void send("mahjong.seat", {
                          playerId: selectedPlayer,
                        })
                      }
                    >
                      {t("上桌")}
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>
        );
      })}
      {!device.enabled && (
        <p className="text-sm text-coral">
          {t("设备已停用，操作不可用。")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-coral">
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="select-all text-sm">
          {result}
        </p>
      )}
    </div>
  );
}

/** Read-only history: what the platform asked for and what the device reported. */
function DeviceHistory({ device }: { device: Machine }) {
  const { t } = useI18n();
  const [events, setEvents] = useState<DeviceEvent[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(
    () =>
      api<{ events: DeviceEvent[] }>(
        `/api/v1/merchant/machines/${device.id}/events`,
      ).then((r) => setEvents(r.events)),
    [device.id],
  );
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);
  return (
    <div className="grid gap-4">
      {!events ? (
        <State error={error} />
      ) : !events.length ? (
        <State empty />
      ) : (
        <div className="divide-y divide-ink/10">
          {timeline(events).map(({ event: e, result }) => {
            const inbound = e.kind === "signal";
            const outcome = result ? String(result.payload.outcome) : null;
            return (
              <div
                className="flex justify-between gap-3 py-3 text-sm"
                key={e.id}
              >
                <div>
                  <span className="flex items-center gap-1.5">
                    {/* Direction is the difference between "we asked" and
                        "the machine reported", which is what makes a card event
                        worth logging at all. */}
                    {e.kind !== "change" && (
                      <span
                        className={inbound ? "text-mint" : "text-ink/45"}
                        title={inbound ? t("机台回报") : t("平台下发")}
                      >
                        {inbound ? "←" : "→"}
                      </span>
                    )}
                    {e.kind === "change"
                      ? changeLabel(e, t)
                      : e.name === "card.login"
                        ? t(e.payload.result === "ok" ? "游戏登录成功" : "游戏拒绝了卡片")
                        : t(actionLabels[e.name] ?? e.name)}
                  </span>
                  <p className="mt-1 text-xs text-ink/50">{date(e.at)}</p>
                </div>
                <span className="text-xs text-ink/55">
                  {e.kind === "signal"
                    ? t("机台回报")
                    : e.kind === "change"
                      ? t(e.origin === "observer" ? "检测到" : "机台回报")
                      : outcome === "ok"
                        ? t("已完成")
                        : outcome === "failed"
                          ? t("失败")
                          : t("结果待确认")}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
