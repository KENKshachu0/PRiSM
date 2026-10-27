import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
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
  Bot,
  Users,
} from "lucide-react";
import { Api, api, playerOperation, type DeviceEvent, type OccupancyHistoryEntry, type Resource, type ResourceGroup, type ResourceOccupancyView } from "../../api";
import { ClimateControls, climateModeName, climateSummary, type ClimateState } from "../ClimateControls";
import { useI18n } from "../../i18n";
import {
  date,
  input,
  segment,
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
  resourceCapabilities,
  isDirectConnect,
  type CapabilityId,
} from "./resource-capabilities";
import { ResourceEditor } from "./ResourceEditor";
import { ResourceGroupEditor, useBillablePlans, useResourceGroups } from "./ResourceGroups";
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
  bot: { icon: Bot, label: "Bot" },
};

/**
 * The device list is cached per shop so returning to the tab shows the last
 * known cards instead of a loading line. Every mount still refetches.
 */
const machineCache = new Map<string, Resource[]>();

export function ResourcesPage() {
  const { shopId, shopCode, canWrite } = useMerchant();
  const { user } = useAuth();
  const plans = useBillablePlans(shopCode);
  const { t } = useI18n();
  const [devices, setDevices] = useState<Resource[] | null>(
    () => machineCache.get(shopId) ?? null,
  );
  const [error, setError] = useState("");
  // A resource being edited, or the group a new one is added to.
  const [editing, setEditing] = useState<Resource | { groupId: string } | null>(null);
  const [groupEditing, setGroupEditing] = useState<ResourceGroup | "new" | null>(null);
  const [qr, setQR] = useState<Resource | null>(null);
  const [acting, setActing] = useState<Resource | null>(null);
  const [history, setHistory] = useState<Resource | null>(null);
  const [editorLocked, setEditorLocked] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const resourceGroups = useResourceGroups(shopId);
  const [params, setParams] = useSearchParams();
  // The setup guide links here with `?add=1` to open the editor directly.
  useEffect(() => {
    if (params.get("add") !== "1") return;
    if (canWrite) setEditing({ groupId: "default" });
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
  /** Who is on each resource now; read with the states and every half minute. */
  const [occupancy, setOccupancy] = useState<Record<string, ResourceOccupancyView>>({});
  const readOccupancy = useCallback(async () => {
    try {
      const r = await api<{ resources: ResourceOccupancyView[] }>(
        `/api/v1/merchant/machines/occupancy?shopId=${encodeURIComponent(shopId)}`,
      );
      setOccupancy(Object.fromEntries(r.resources.map((resource) => [resource.resourceId, resource])));
    } catch {
      // The cards simply show no occupancy until the next read.
    }
  }, [shopId]);
  useEffect(() => {
    setOccupancy({});
    void readOccupancy();
    const timer = setInterval(() => void readOccupancy(), 30_000);
    return () => clearInterval(timer);
  }, [readOccupancy]);
  /** What the panel read of one device, put where the board shows it. */
  const setDeviceState = useCallback(
    (id: string, next: BoardState) =>
      setStates((previous) => (previous ? { ...previous, [id]: learnBoardState(previous[id], next) } : previous)),
    [],
  );
  async function refresh() {
    setRefreshing(true);
    await Promise.all([readStates(), readOccupancy()]);
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
    const caps = resourceCapabilities(device);
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
  // Card cabinets still behind an external relay: the page suggests moving them to a direct connection.
  const relayed = useMemo(
    () => (devices ?? []).filter((device) => resourceCapabilities(device).hinata_io && !isDirectConnect(device)),
    [devices],
  );
  const counts = useMemo(() => {
    const result: Record<string, number> = { all: devices?.length ?? 0 };
    for (const device of devices ?? []) {
      const caps = resourceCapabilities(device);
      for (const id of capabilityOrder) if (caps[id]) result[id] = (result[id] ?? 0) + 1;
      if (!Object.values(caps).some(Boolean))
        result.unconfigured = (result.unconfigured ?? 0) + 1;
    }
    return result;
  }, [devices]);
  const matches = (device: Resource) => {
    if (filter === "all") return true;
    const caps = resourceCapabilities(device);
    if (filter === "unconfigured") return !Object.values(caps).some(Boolean);
    return caps[filter];
  };
  const planName = (id: string | null) => plans.find((plan) => plan.id === id)?.name ?? null;
  // Every resource sits in its group; the shop's default group comes first. A resource whose
  // group is not listed (the groups could not be read) is shown in the default group.
  const listed = new Set((resourceGroups.groups ?? []).map((group) => group.id));
  const groupOf = (device: Resource) => {
    const id = device.resourceGroupId ?? "default";
    return listed.has(id) ? id : "default";
  };
  const sections = (resourceGroups.groups ?? []).map((group) => ({
    group,
    resources: (devices ?? []).filter((device) => groupOf(device) === group.id && matches(device)),
  }));
  const reloadAll = () => {
    void load();
    void resourceGroups.reload();
  };
  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold">{t("店内资源")}</h2>
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
            <button className={primary} onClick={() => setGroupEditing("new")}>
              <Plus size={17} />
              {t("添加资源组")}
            </button>
          )}
        </div>
      </header>
      {canWrite && relayed.length > 0 && (
        <section className="grid gap-2 rounded-xl border border-mint/30 bg-mint/5 p-4 text-sm" aria-label={t("建议改为直连")}>
          <p className="font-medium">{t("这些刷卡机台还在用外部中继，建议改为直连本平台")}</p>
          <p className="text-ink/60">
            {t("直连不用另外部署和维护中继服务，刷卡、投币和在线状态都由平台直接处理。在资源的「刷卡 · HINATA IO」里选「直连本平台」，签发设备令牌后把它填进机台。")}
          </p>
          <div className="flex flex-wrap gap-2">
            {relayed.map((device) => (
              <button key={device.id} type="button" className={`${button} min-h-9 px-3 py-1`} onClick={() => setEditing(device)}>
                {device.name}
              </button>
            ))}
          </div>
        </section>
      )}
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
        aria-label={t("资源类型")}
      >
        {(
          [
            ["all", "全部"],
            ...capabilityOrder.map((id) => [id, capabilityChips[id].label] as const),
            ["unconfigured", "未配置"],
          ] as [Filter, string][]
        ).filter(([key]) => key === "all" || counts[key]).map(([key, label]) => (
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
      {resourceGroups.error && (
        <p role="alert" className="flex flex-wrap items-center gap-3 text-sm text-coral">
          {t("资源组读取失败，资源暂按默认资源组显示")}
          <button type="button" className="underline" onClick={() => void resourceGroups.reload()}>{t("重试")}</button>
        </p>
      )}
      {!devices || !resourceGroups.groups ? (
        <State error={error} />
      ) : (
        sections
          .filter(({ resources }) => filter === "all" || resources.length > 0)
          .map(({ group, resources }) => {
            const plan = planName(group.defaultPricingConfigId);
            return (
              <section key={group.id} className="grid gap-3" aria-label={t(group.name)}>
                <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink/10 pb-2">
                  <h3 className="text-base font-semibold">{t(group.name)}</h3>
                  {/* Groups that could not be read are not described, nor edited from a stand-in. */}
                  {!resourceGroups.error && <span className="flex flex-wrap items-center gap-x-3 text-xs text-ink/55">
                    <span className={plan ? "" : "text-coral"}>{plan ?? t("未设置计费方案")}</span>
                    <span>{t("{count} 个资源", { count: group.resourceCount })}</span>
                    {!group.enabled && <span className="text-coral">{t("已停用")}</span>}
                  </span>}
                  {canWrite && (
                    <span className="ml-auto flex items-center gap-1">
                      {!resourceGroups.error && <button type="button" className={`${buttonQuiet} min-h-9 px-2 text-xs`} onClick={() => setGroupEditing(group)}>
                        <Pencil size={14} aria-hidden="true" />
                        {t("编辑")}
                      </button>}
                      <button type="button" className={`${button} min-h-9 px-3 py-1 text-xs`} onClick={() => setEditing({ groupId: group.id })}>
                        <Plus size={14} aria-hidden="true" />
                        {t("添加资源")}
                      </button>
                    </span>
                  )}
                </header>
                {resources.length ? (
                  <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {resources.map((device) => (
                      <ResourceCard
                        key={device.id}
                        device={device}
                        canWrite={canWrite}
                        state={states?.[device.id] ?? null}
                        occupancy={occupancy[device.id]}
                        stateFailed={statesFailed && states === null}
                        // The first read of a device with no state of its own is still on its way.
                        pending={!firstRead && !!states?.[device.id] && !states[device.id]!.watching}
                        playerHref={(playerId) => `/merchant/${segment(shopCode)}/live?player=${segment(playerId)}`}
                        onAct={() => setActing(device)}
                        onQR={() => setQR(device)}
                        onHistory={() => setHistory(device)}
                        onEdit={() => setEditing(device)}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="rounded-xl border border-dashed border-ink/15 px-5 py-6 text-center text-sm text-ink/50">
                    {t(group.isDefault && !devices.length
                      ? "一个资源对应店里一样玩家扫码就能用的东西：一台机台、一扇门、一张麻将桌，或者只是墙上的一张二维码。"
                      : "没有资源")}
                  </p>
                )}
              </section>
            );
          })
      )}
      {acting && (
        <Modal
          title={`${acting.name} · ${t("操作")}`}
          close={() => setActing(null)}
        >
          <ResourceActions
            device={acting}
            state={states?.[acting.id] ?? null}
            onState={(next) => setDeviceState(acting.id, next)}
            onChanged={() => void load()}
          />
        </Modal>
      )}
      {history && (
        <Modal
          title={`${history.name} · ${t("记录")}`}
          close={() => setHistory(null)}
          wide
        >
          <ResourceRecords device={history} playerHref={(playerId) => `/merchant/${segment(shopCode)}/live?player=${segment(playerId)}`} />
        </Modal>
      )}
      {editing && (
        <Modal
          title={"id" in editing ? "编辑资源" : "添加资源"}
          close={() => setEditing(null)}
          dismissDisabled={editorLocked}
          wide
        >
          <ResourceEditor
            value={"id" in editing ? editing : undefined}
            groupId={"id" in editing ? undefined : editing.groupId}
            onLockChange={setEditorLocked}
            done={() => {
              setEditing(null);
              reloadAll();
            }}
          />
        </Modal>
      )}
      {groupEditing && (
        <Modal
          title={groupEditing === "new" ? "添加资源组" : t(groupEditing.name)}
          close={() => setGroupEditing(null)}
        >
          <ResourceGroupEditor
            group={groupEditing === "new" ? undefined : groupEditing}
            done={() => {
              setGroupEditing(null);
              reloadAll();
            }}
          />
        </Modal>
      )}
      {qr && (
        <Modal title="资源二维码" close={() => setQR(null)}>
          <ResourceQR device={qr} />
        </Modal>
      )}
    </div>
  );
}

function ResourceQR({ device }: { device: Resource }) {
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
function ResourceCard({
  device,
  canWrite,
  state,
  occupancy,
  stateFailed,
  pending,
  playerHref,
  onAct,
  onQR,
  onHistory,
  onEdit,
}: {
  device: Resource;
  canWrite: boolean;
  /** What the board knows of this device's power and air conditioner; null until it is read. */
  state: BoardState | null;
  /** Who is on it now; absent for a resource nobody occupies (capacity 0). */
  occupancy?: ResourceOccupancyView;
  stateFailed: boolean;
  /** A device with no state of its own whose first read has not come back yet. */
  pending: boolean;
  /** Where a player's own page is: their profile and, while they bill, their bill. */
  playerHref: (playerId: string) => string;
  onAct: () => void;
  onQR: () => void;
  onHistory: () => void;
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const caps = resourceCapabilities(device);
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
          {caps.bot ? <Bot size={22} /> : caps.door ? <DoorOpen size={22} /> : <Gamepad2 size={22} />}
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
      {occupancy && (
        <div className="mb-4 flex min-w-0 flex-wrap items-center gap-1.5 px-5 text-xs">
          <span className="flex shrink-0 items-center gap-1 tabular-nums text-ink/60" title={t("占用")}>
            <Users size={13} aria-hidden="true" />
            {occupancy.occupants.length}/{occupancy.capacity}
          </span>
          {occupancy.occupants.length ? (
            occupancy.occupants.map((occupant) => (
              <Link
                key={occupant.playerId}
                className="focus-ring max-w-[10rem] truncate rounded-md bg-mint/10 px-2 py-1 font-medium text-mint hover:bg-mint/20"
                to={playerHref(occupant.playerId)}
              >
                {occupant.displayName ?? occupant.playerId}
              </Link>
            ))
          ) : (
            <span className="text-ink/45">{t("空闲")}</span>
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
        {/* A bot is not something players scan. */}
        {!device.bot && (
          <button
            type="button"
            className={`${buttonQuiet} grid size-9 shrink-0 place-items-center px-0`}
            aria-label={`${t("资源二维码")} ${device.name}`}
            onClick={onQR}
          >
            <QrCode size={16} />
          </button>
        )}
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
  bot: { icon: Bot, title: "Bot" },
};

/**
 * Sending commands is a separate surface from reading the log: one is an
 * action with consequences, the other is history. Keeping them in one modal
 * made the destructive buttons look like part of the record.
 *
 * Actions are grouped by the capability that owns them, and each group shows
 * the state that decides what those actions will do.
 */
function ResourceActions({
  device,
  state,
  onState,
  onChanged,
}: {
  device: Resource;
  /** Power and air conditioner as the board has them: pushed for a live device, last read otherwise. */
  state: BoardState | null;
  /** Hands the board what this panel read of the device. */
  onState: (next: BoardState) => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const caps = resourceCapabilities(device);
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
          {t("资源已停用，操作不可用。")}
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

const END_REASONS: Record<NonNullable<OccupancyHistoryEntry["endReason"]>, string> = {
  timeout: "超时",
  replaced: "被替换",
  left: "离开",
  billing_ended: "计费结束",
};

/** Who was on the resource, then what the platform asked of it and what it reported. */
function ResourceRecords({ device, playerHref }: { device: Resource; playerHref: (playerId: string) => string }) {
  const { t } = useI18n();
  return (
    <div className="grid gap-6">
      <OccupancyHistory device={device} playerHref={playerHref} />
      <section className="grid gap-2">
        <h3 className="text-sm font-semibold">{t("操作记录")}</h3>
        <ResourceHistory device={device} />
      </section>
    </div>
  );
}

/** Who was on the resource and for how long, newest first. Nothing for a resource nobody occupies. */
function OccupancyHistory({ device, playerHref }: { device: Resource; playerHref: (playerId: string) => string }) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<OccupancyHistoryEntry[] | null>(null);
  useEffect(() => {
    let current = true;
    api<{ entries: OccupancyHistoryEntry[] }>(`/api/v1/merchant/machines/${encodeURIComponent(device.id)}/occupancy`)
      .then((r) => current && setEntries(r.entries))
      .catch(() => current && setEntries([]));
    return () => {
      current = false;
    };
  }, [device.id]);
  if (!entries?.length) return null;
  return (
    <section className="grid gap-2">
      <h3 className="text-sm font-semibold">{t("占用记录")}</h3>
      <div className="divide-y divide-ink/10">
        {entries.map((entry) => (
          <div className="flex justify-between gap-3 py-2 text-sm" key={entry.id}>
            <Link className="truncate underline-offset-2 hover:underline" to={playerHref(entry.playerId)}>
              {entry.displayName ?? entry.playerId}
            </Link>
            <span className="shrink-0 text-ink/60 tabular-nums">
              {date(entry.startedAt)} – {entry.endedAt ? date(entry.endedAt) : t("进行中")}
              {entry.endReason && <span className="ml-2 text-ink/45">{t(END_REASONS[entry.endReason])}</span>}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Read-only history: what the platform asked for and what the device reported. */
function ResourceHistory({ device }: { device: Resource }) {
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
