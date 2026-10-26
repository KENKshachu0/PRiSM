import { useState } from "react";
import { Bot, Gamepad2 } from "lucide-react";
import { api, type Resource } from "../../api";
import { useI18n } from "../../i18n";
import type { BoardWatcher, BoardWatchers, WatcherPhase } from "./board-state";

const phaseText: Record<WatcherPhase, string> = {
  watching: "监听中",
  subscribing: "正在订阅…",
  starting: "正在启动…",
  unreachable: "连不上 Home Assistant",
};
const phaseColor: Record<WatcherPhase, string> = {
  watching: "text-mint",
  subscribing: "text-ink/35",
  starting: "text-ink/35",
  unreachable: "text-coral",
};

/**
 * Who is watching the shop's Home Assistant right now: each bot by the name it gave and each HINATA IO by
 * its device's name, how far it has got, and how many slots the shop has. Bots come first because the
 * platform prefers them. The number of slots is the platform administrator's to change, for this shop only;
 * everyone else just sees it.
 */
export function HaWatchersPanel({
  shopId,
  watchers,
  devices,
  canEdit,
  onLimit,
}: {
  shopId: string;
  watchers: BoardWatchers;
  devices: readonly Resource[];
  canEdit: boolean;
  /** The platform took the new number; the hub's own frame follows. */
  onLimit(count: number): void;
}) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const nameOf = (watcher: BoardWatcher) =>
    watcher.kind === "bot" ? watcher.name : (devices.find((device) => device.id === watcher.deviceId)?.name ?? t("未知资源"));
  async function change(count: number) {
    setSaving(true);
    setError("");
    try {
      await api(`/api/v1/merchant/ha-watchers?shopId=${encodeURIComponent(shopId)}`, { method: "PUT", body: JSON.stringify({ count }) });
      onLimit(count);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("操作失败"));
    }
    setSaving(false);
  }
  return (
    <section className="grid gap-2 rounded-xl border border-ink/10 px-4 py-3" aria-label={t("HA 监听器")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {t("HA 监听器")}
          <span className="ml-2 font-normal text-ink/55">
            {t("{count} / {limit} 个监听器", { count: watchers.watchers.length, limit: watchers.limit })}
          </span>
        </h3>
        {canEdit ? (
          <label className="flex items-center gap-2 text-xs text-ink/65">
            {t("监听器数量")}
            <select
              className="focus-ring min-h-9 rounded-lg border border-ink/20 bg-panel px-2 py-1 text-sm disabled:opacity-60"
              value={watchers.limit}
              disabled={saving}
              onChange={(event) => void change(Number(event.target.value))}
            >
              {Array.from({ length: watchers.max }, (_, index) => index + 1).map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="text-xs text-ink/45">{t("由平台管理员设置")}</span>
        )}
      </div>
      {watchers.watchers.length ? (
        <ul className="grid gap-1.5">
          {watchers.watchers.map((watcher) => (
            <li key={watcher.id} className="flex flex-wrap items-center gap-x-2 text-sm">
              {watcher.kind === "bot" ? (
                <Bot size={16} className="text-ink/55" aria-hidden="true" />
              ) : (
                <Gamepad2 size={16} className="text-ink/55" aria-hidden="true" />
              )}
              <span className="font-medium">{nameOf(watcher)}</span>
              <span className="text-xs text-ink/45">{t(watcher.kind === "bot" ? "Bot" : "机台")}</span>
              <span className={`${phaseColor[watcher.state]} text-xs`} aria-hidden="true">
                ●
              </span>
              <span className="text-xs text-ink/65">{t(phaseText[watcher.state])}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink/55">{t("没有监听器在线：设备状态为非实时，进入页面和点「刷新设备状态」时才读取。")}</p>
      )}
      <p className="text-xs text-ink/45">
        {t("Bot 优先，不够的名额由店里的机台补上。")}
        {watchers.standby > 0 && ` ${t("另有 {count} 个在线，等待空位", { count: watchers.standby })}`}
      </p>
      {error && (
        <p role="alert" className="text-xs text-coral">
          {error}
        </p>
      )}
    </section>
  );
}
