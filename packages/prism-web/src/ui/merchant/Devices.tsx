import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  ChevronRight,
  CreditCard,
  DoorOpen,
  Gamepad2,
  MoreHorizontal,
  Plus,
  Power,
  QrCode,
  Ungroup,
} from "lucide-react";
import { Api, api, playerOperation, type DeviceEvent, type Machine } from "../../api";
import { useI18n } from "../../i18n";
import {
  ActionForm,
  date,
  Modal,
  State,
  button,
  buttonQuiet,
  primary,
  useMerchant,
} from "./shared";
import {
  canOperateCoin,
  capabilityOrder,
  deviceActions,
  deviceCapabilities,
  deviceSummaryKey,
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

export function DevicesPage() {
  const { shopId, canWrite } = useMerchant();
  const { t } = useI18n();
  const [devices, setDevices] = useState<Machine[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Machine | "new" | null>(null);
  const [qr, setQR] = useState<Machine | null>(null);
  const [operating, setOperating] = useState<Machine | null>(null);
  const [editorLocked, setEditorLocked] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const load = useCallback(
    () => Api.machines(shopId).then((r) => setDevices(r.machines)),
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
  const unconfigured = counts.unconfigured ?? 0;
  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{t("店内设备")}</h2>
          <p className="mt-1 text-sm text-ink/55">
            {t("为每台机台、门锁和麻将桌配置对应的能力，再把二维码贴到设备上。")}
          </p>
        </div>
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
          <p className="mx-auto mt-2 max-w-sm text-sm text-ink/55">
            {t("先添加设备，再为它勾选能力：电源、刷卡、门锁或麻将桌。")}
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
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((device) => (
            <DeviceCard
              key={device.id}
              device={device}
              canWrite={canWrite}
              onQR={() => setQR(device)}
              onHistory={() => setOperating(device)}
              onEdit={() => setEditing(device)}
            />
          ))}
        </div>
      )}
      {unconfigured > 0 && filter === "all" && (
        <p className="text-sm text-ink/55">
          {t("有 {count} 台设备还没配置能力，点击卡片上的「配置」开始。", {
            count: unconfigured,
          })}
        </p>
      )}
      {operating && (
        <Modal title={operating.name} close={() => setOperating(null)} wide>
          <DeviceOperations device={operating} />
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
            <p className="text-sm text-ink/60">{t("扫码打开设备")}</p>
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
  onQR,
  onHistory,
  onEdit,
}: {
  device: Machine;
  canWrite: boolean;
  onQR: () => void;
  onHistory: () => void;
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const caps = deviceCapabilities(device);
  const enabled = !!device.enabled;
  const configured = Object.values(caps).some(Boolean);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <article
      className={`group relative flex flex-col overflow-hidden rounded-xl border border-ink/10 bg-panel transition-colors ${
        enabled ? "" : "opacity-60"
      }`}
    >
      <div className="flex items-start gap-3 p-5 pb-4">
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
          <p className="mt-1 text-xs text-ink/50">
            {t(deviceSummaryKey(device))}
            {!enabled && ` · ${t("已停用")}`}
          </p>
        </div>
        <DeviceMenu
          open={menuOpen}
          setOpen={setMenuOpen}
          canWrite={canWrite}
          onQR={onQR}
          onHistory={onHistory}
          onEdit={onEdit}
          name={device.name}
        />
      </div>
      <div className="flex flex-wrap gap-1.5 px-5">
        {capabilityOrder
          .filter((id) => caps[id])
          .map((id) => {
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
      {!configured && canWrite && (
        <div className="px-5 pt-3">
          <button type="button" className={`${primary} min-h-9 px-3 py-1`} onClick={onEdit}>
            {t("配置能力")}
          </button>
        </div>
      )}
      {(caps.power || isDirectConnect(device)) && (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 px-5 pb-4 text-xs">
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
      <footer className="mt-auto flex items-center justify-between gap-2 border-t border-ink/10 px-3 py-1.5">
        <button
          type="button"
          className={`${buttonQuiet} min-h-9 px-2 text-xs`}
          onClick={onQR}
        >
          <QrCode size={15} />
          {t("二维码")}
        </button>
        <button
          type="button"
          className={`${buttonQuiet} min-h-9 px-2 text-xs`}
          onClick={onHistory}
        >
          {t("操作记录")}
          <ChevronRight size={15} className="text-ink/35" />
        </button>
      </footer>
    </article>
  );
}

function DeviceMenu({
  open,
  setOpen,
  canWrite,
  onQR,
  onHistory,
  onEdit,
  name,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  canWrite: boolean;
  onQR: () => void;
  onHistory: () => void;
  onEdit: () => void;
  name: string;
}) {
  const { t } = useI18n();
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-device-menu]")) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open, setOpen]);
  return (
    <div className="relative shrink-0" data-device-menu>
      <button
        type="button"
        className={`${buttonQuiet} grid size-9 place-items-center px-0`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t("更多操作")} ${name}`}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-40 overflow-hidden rounded-lg border border-ink/10 bg-panel py-1 shadow-soft"
        >
          <MenuItem
            onClick={() => {
              setOpen(false);
              onQR();
            }}
          >
            {t("设备二维码")}
          </MenuItem>
          <MenuItem
            onClick={() => {
              setOpen(false);
              onHistory();
            }}
          >
            {t("操作记录")}
          </MenuItem>
          {canWrite && (
            <MenuItem
              onClick={() => {
                setOpen(false);
                onEdit();
              }}
            >
              {t("编辑")}
            </MenuItem>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="block w-full px-3 py-2 text-left text-sm hover:bg-ink/5 focus-ring"
      onClick={onClick}
    >
      {children}
    </button>
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

function DeviceOperations({ device }: { device: Machine }) {
  const { t } = useI18n();
  const { canWrite } = useMerchant();
  const [events, setEvents] = useState<DeviceEvent[]>([]);
  const [action, setAction] = useState("");
  const [result, setResult] = useState("");
  const load = useCallback(
    () =>
      api<{ events: DeviceEvent[] }>(
        `/api/v1/merchant/machines/${device.id}/events`,
      ).then((r) => setEvents(r.events)),
    [device.id],
  );
  useEffect(() => {
    load().catch((e) => setResult(e.message));
  }, [load]);
  const labels: Record<string, string> = {
    "power.on": "开机",
    "power.off": "关机",
    coin: "投币",
    "door.open": "获取开门密码",
    "aime.scan": "刷卡",
    "card.state": "读卡状态变化",
    "card.consumed": "卡片已送入游戏",
    "led.set": "灯光",
  };
  // Actions come from the shared capability adapter, so this panel, the card
  // and the editor cannot disagree about what the device can do.
  const actions = deviceActions(device);
  return (
    <div className="grid gap-5">
      {canWrite && actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {actions.map((key) => (
            <button
              key={key}
              type="button"
              className={button}
              disabled={!device.enabled}
              onClick={() => setAction(key)}
            >
              {t(labels[key]!)}
            </button>
          ))}
        </div>
      )}
      {action && (
        <ActionForm
          label="确认操作"
          done={() => {
            setAction("");
            void load();
          }}
          submit={async () => {
            const r = await playerOperation<{ temporaryPassword?: string }>(
              `/api/v1/merchant/machines/${device.id}/actions`,
              { action },
            );
            setResult(
              r.temporaryPassword
                ? `${t("开门密码")} ${r.temporaryPassword}`
                : t("已发送"),
            );
          }}
        >
          <p className="text-sm">
            {device.name} · {t(labels[action]!)}
          </p>
        </ActionForm>
      )}
      {result && (
        <p role="status" className="select-all text-sm">
          {result}
        </p>
      )}
      <h3 className="text-sm font-semibold">{t("设备事件")}</h3>
      {!events.length && <State empty />}
      <div className="divide-y divide-ink/10">
        {timeline(events).map(({ event: e, result }) => {
          const inbound = e.kind === "signal";
          const outcome = result ? String(result.payload.outcome) : null;
          return (
            <div className="flex justify-between gap-3 py-3 text-sm" key={e.id}>
              <div>
                <span className="flex items-center gap-1.5">
                  {/* Direction is the difference between "we asked" and "the
                      machine reported", which is what makes a card event worth
                      logging at all. */}
                  {e.kind !== "change" && (
                    <span
                      className={inbound ? "text-mint" : "text-ink/45"}
                      title={inbound ? t("机台回报") : t("平台下发")}
                    >
                      {inbound ? "←" : "→"}
                    </span>
                  )}
                  {t(e.kind === "change" ? changeLabel(e) : labels[e.name] ?? e.name)}
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
    </div>
  );
}
