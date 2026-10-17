import { useCallback, useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  ChevronRight,
  CreditCard,
  DoorOpen,
  Gamepad2,
  Pencil,
  Plus,
  Power,
  QrCode,
  Ungroup,
} from "lucide-react";
import { Api, api, playerOperation, type DeviceEvent, type Machine } from "../../api";
import { useI18n } from "../../i18n";
import {
  date,
  input,
  Modal,
  State,
  button,
  buttonQuiet,
  primary,
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

type Filter = "all" | CapabilityId | "unconfigured";

/** Capability pills get one icon and one accent each, so a card reads at a glance. */
const capabilityChips: Record<
  CapabilityId,
  { icon: typeof Power; label: string }
> = {
  power: { icon: Power, label: "电源" },
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
        {canWrite && (
          <button className={primary} onClick={() => setEditing("new")}>
            <Plus size={17} />
            {t("添加设备")}
          </button>
        )}
      </header>
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
          <div className="grid justify-items-center gap-5">
            <div className="bg-white p-4">
              <QRCodeSVG
                value={`${window.location.origin}/t/${qr.shopPublicId}/${qr.publicId}`}
                size={224}
                level="M"
              />
            </div>
            <h3 className="text-lg font-semibold">{qr.name}</h3>
            <a
              className={button}
              href={`/t/${qr.shopPublicId}/${qr.publicId}`}
              target="_blank"
              rel="noreferrer"
            >
              {t("测试扫码入口")}
            </a>
            <button
              className={button}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    `${window.location.origin}/t/${qr.shopPublicId}/${qr.publicId}`,
                  );
                } catch {
                  setError(t("复制失败"));
                }
              }}
            >
              {t("复制链接 / 写入 NFC")}
            </button>
          </div>
        </Modal>
      )}
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
  onAct,
  onQR,
  onHistory,
  onEdit,
}: {
  device: Machine;
  canWrite: boolean;
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
      {(caps.power || isDirectConnect(device)) && (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 px-5 text-xs">
          {caps.power && <PowerStatus device={device} />}
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

function PowerStatus({ device }: { device: Machine }) {
  const { t } = useI18n();
  const [power, setPower] = useState("loading");
  useEffect(() => {
    let current = true;
    api<{ power: string }>(`/api/v1/merchant/machines/${device.id}/state`)
      .then((r) => {
        if (current) setPower(r.power);
      })
      .catch(() => {
        if (current) setPower("unknown");
      });
    return () => {
      current = false;
    };
  }, [device]);
  return (
    <span
      className={`flex items-center gap-1.5 ${power === "on" ? "text-mint" : "text-ink/50"}`}
    >
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

function changeLabel(event: DeviceEvent): string {
  const to = event.payload.to;
  if (event.name === "power") return to === "on" ? "电源已开启" : "电源已关闭";
  if (event.name === "link") return to === "online" ? "机台已连接" : "机台已断开";
  return event.name;
}

const actionLabels: Record<string, string> = {
  "power.on": "开机",
  "power.off": "关机",
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
  onChanged,
}: {
  device: Machine;
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
  const [power, setPower] = useState<string | null>(null);
  const [table, setTable] = useState<MahjongTable | null>(null);
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const refreshState = useCallback(() => {
    api<{ power: string; mahjong: MahjongTable | null }>(
      `/api/v1/merchant/machines/${device.id}/state`,
    )
      .then((r) => {
        setPower(r.power);
        setTable(r.mahjong);
      })
      .catch(() => {});
  }, [device.id]);
  useEffect(refreshState, [refreshState]);
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
      refreshState();
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
              {id === "hinata_io" && actionNames.includes("aime.scan") && (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className={`${input} min-h-9 w-56 font-mono`}
                    inputMode="numeric"
                    maxLength={20}
                    placeholder={t("输入 20 位卡号")}
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
                    {t(
                      e.kind === "change"
                        ? changeLabel(e)
                        : (actionLabels[e.name] ?? e.name),
                    )}
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
