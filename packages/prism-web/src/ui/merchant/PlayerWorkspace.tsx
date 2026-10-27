import { browserCheckoutPreview } from "../../browser-billing";
import { shopApi } from "../BillingPages";
import { BillLegend, BillTimeline, BillTotal } from "../BillTimeline";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { RefreshCw, Search } from "lucide-react";
import { useI18n } from "../../i18n";
import {
  ActionForm,
  Field,
  Modal,
  State,
  button,
  buttonQuiet,
  date,
  input,
  money,
  primary,
  segment,
  useMerchant,
  useResource,
  useStaffApi,
  staffMessage,
  type Asset,
  type LivePlayer,
  type Roster,
  type Player,
  type Preview,
} from "./shared";
import { liveBilling, stayDuration } from "./live-billing";
import { useLiveBilling } from "./use-live-billing";
import { billTime } from "../bill-time";

type EntryPlan = {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  status: string;
  /** Live-only: the status word shown on the right of the row. */
  billStatus?: string;
};

/** Stable identity for the tabs that have no live players. */
const NO_PLAYERS: LivePlayer[] = [];

type Row = Player & {
  /** Live-only: the figures the list shows for a checked-in player. */
  stayMinutes?: number;
  estimatedTotal?: number | null;
  planNames?: string[];
  startedAt?: string;
  sessionCount?: number;
  billStatus?: string;
};

type Holdings = {
  holdings: {
    id: string;
    assetName: string;
    quantity: number;
    expiresAt: string | null;
  }[];
  ledgerEntries: {
    id: string;
    assetName: string;
    delta: number;
    reason: string;
    createdAt: string;
  }[];
};
type History = {
  sessions: {
    sessionId: string;
    startedAt: string;
    endedAt: string | null;
    total: number | null;
  }[];
};

/**
 * The player surface shared by both tabs: a list of players on the left and
 * the selected player's management on the right. "In shop" narrows the list to
 * players with an entry and adds billing actions; "Players" is the full roster.
 *
 * Selection is a modifier-gated multi-select: checkboxes only exist while a
 * modifier is held, so the normal case stays a plain click-to-open list.
 */
export function PlayerWorkspace({ live = false }: { live?: boolean }) {
  const { t } = useI18n();
  const { canWrite, shopCode, cashierEnabled, timeZone } = useMerchant();
  const request = useStaffApi();
  const identityText = (identity: NonNullable<Player["identities"]>[number]) =>
    identity.provider === "web-account"
      ? `${t("PRiSM 账号")}: ${identity.displayName ? `${identity.displayName} · ` : ""}${identity.subject}`
      : `${identity.provider}:${identity.subject}`;
  const list = useResource<{ players: Player[] }>(live ? null : "players");
  const onSite = useResource<{
    players: LivePlayer[];
    roster?: Roster;
    billingSnapshot?: unknown;
  }>(live ? "live-players" : null);
  const roster = onSite.data?.roster;
  const [search, setSearch] = useState("");
  const [groupBy, setGroupBy] = useState("none");
  // A link to one player (`?player=`) opens them; someone who bills nothing is
  // shown on the players tab instead of the in-shop one.
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<string | undefined>(() => params.get("player") ?? undefined);
  const linked = params.get("player");
  useEffect(() => {
    if (!linked) return;
    const players = live ? onSite.data?.players.map((player) => player.playerId) : list.data?.players.map((player) => player.id);
    if (!players) return;
    if (live && !players.includes(linked)) {
      navigate(`/merchant/${segment(shopCode)}/players?player=${segment(linked)}`, { replace: true });
      return;
    }
    setSelectedId(linked);
    const next = new URLSearchParams(params);
    next.delete("player");
    setParams(next, { replace: true });
  }, [linked, live, onSite.data, list.data, navigate, params, setParams, shopCode]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [bulk, setBulk] = useState<null | "checkout" | "override">(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [binding, setBinding] = useState(false);
  const panel = useRef<HTMLElement>(null);

  // A held modifier is what turns the list into a selection surface.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === "Meta" || event.key === "Control" || event.key === "Shift")
        setSelecting(true);
    };
    const up = (event: KeyboardEvent) => {
      if (
        event.key === "Meta" ||
        event.key === "Control" ||
        event.key === "Shift"
      ) {
        setSelecting(false);
        setPicked(new Set());
      }
    };
    const blur = () => {
      setSelecting(false);
      setPicked(new Set());
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // Rows come straight from the live response; the worker only adds quotes, so
  // the list is stable while a bill is being recalculated.
  const liveRows: Row[] | undefined = onSite.data?.players.map((player) => {
    const bill = liveBilling(player);
    return {
      id: player.playerId,
      paymentMode: player.paymentMode,
      displayName: player.displayName,
      status: player.status,
      walletTotal: player.walletTotal,
      identities: player.identities,
      activeSessionId:
        (player.sessions ?? []).find((session) => !session.endedAt)?.id ?? null,
      stayMinutes: player.stayDurationMinutes,
      estimatedTotal: player.estimatedTotal,
      planNames: bill.plans,
      billStatus: bill.status,
      startedAt: player.sessions?.[0]?.startedAt,
      sessionCount: player.sessions?.length ?? 0,
    };
  });
  const clockAt = (value: string) =>
    billTime(value, timeZone || undefined).time;
  const dayAt = (value: string) =>
    billTime(value, timeZone || undefined).date.slice(5);
  const rows: Row[] | undefined = live ? liveRows : list.data?.players;

  const matched = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (rows ?? []).filter((player) =>
      needle
        ? `${player.displayName} ${player.identities?.map(identityText).join(" ")}`
            .toLowerCase()
            .includes(needle)
        : true,
    );
  }, [rows, search]);

  // The quote worker needs the resolved player, not the raw click state.
  const activeId = matched.find((row) => row.id === selectedId)?.id ?? matched[0]?.id;
  const liveSource = onSite.data?.players;
  const calculation = useLiveBilling(
    live && liveSource ? liveSource : NO_PLAYERS,
    onSite.data?.billingSnapshot,
    activeId,
  );
  const quoted = new Map(
    calculation.players.map((player) => [player.playerId, player]),
  );
  const visible = matched.map((row) => {
    const quote = quoted.get(row.id);
    if (!quote) return row;
    const bill = liveBilling(quote);
    return {
      ...row,
      stayMinutes: quote.stayDurationMinutes,
      estimatedTotal: quote.estimatedTotal,
      status: quote.status,
      billStatus: bill.status,
      planNames: bill.plans,
      startedAt: quote.sessions?.[0]?.startedAt ?? row.startedAt,
      sessionCount: quote.sessions?.length ?? row.sessionCount,
    };
  });
  const liveSelection = activeId ? quoted.get(activeId) ?? null : null;
  // In the shop is playing or billing anything; an unpaid bill alone is not.
  const present = roster?.total ?? visible.filter((player) => player.activeSessionId).length;
  const unpaid = visible.filter((player) => !player.activeSessionId).length;

  const groups = useMemo(() => {
    const result = new Map<string, { label: string; players: Row[]; count?: string }>();
    if (groupBy === "place" && roster) {
      // Each person is in one place; an occupied resource shows its head count
      // against its capacity, unknown card holders included.
      const byId = new Map(visible.map((player) => [player.id, player]));
      const listed = new Set<string>();
      roster.groups.forEach((group, index) => {
        const players = group.members.flatMap((member) => {
          const row = member.playerId ? byId.get(member.playerId) : undefined;
          if (row) listed.add(row.id);
          return row ? [row] : [];
        });
        result.set(`${group.kind}:${group.id ?? index}`, {
          label: group.name,
          players,
          ...(group.kind === "resource" ? { count: `${group.members.length}/${group.capacity}` } : {}),
        });
      });
      result.set(":unpaid", { label: t("待结账"), players: visible.filter((player) => !listed.has(player.id) && !player.activeSessionId) });
      return [...result].filter(([, group]) => group.players.length > 0 || group.count);
    }
    for (const player of visible) {
      const key =
        groupBy === "none"
          ? ""
          : groupBy === "status"
            ? player.status
            : (player.planNames ?? []).join(" + ") || "";
      const label =
        groupBy === "none"
          ? ""
          : groupBy === "status"
            ? t(
                player.status !== "active"
                  ? "已停用"
                  : player.activeSessionId
                    ? "计费中"
                    : "正常",
              )
            : (player.planNames ?? []).join(" + ") || t("无进行中计费方案");
      const group = result.get(key) ?? { label, players: [] };
      group.players.push(player);
      result.set(key, group);
    }
    return [...result];
  }, [visible, groupBy, roster, t]);

  // Opening the tab shows the first player rather than an empty right column.
  const selected =
    visible.find((player) => player.id === activeId) ?? visible[0];
  const pickedRows = visible.filter((player) => picked.has(player.id));
  const allPicked = visible.length > 0 && pickedRows.length === visible.length;
  const refresh = () => {
    list.reload();
    onSite.reload();
  };

  const togglePick = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  const openPlayer = (id: string) => {
    setSelectedId(id);
    setNotice("");
    setError("");
    if (window.innerWidth < 1280)
      panel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  /** Batch checkout runs one request per player so each bill settles alone. */
  async function runBulk(mode: "checkout" | "override", finalTotal?: number) {
    if (!pickedRows.length) return;
    setBusy(mode);
    setError("");
    setNotice("");
    const failed: string[] = [];
    let done = 0;
    for (const player of pickedRows) {
      const base = `players/${segment(player.id)}/checkout`;
      try {
        if (mode === "override")
          await request(`${base}/override`, "POST", {
            finalTotal: finalTotal ?? 0,
            reason: t("批量改价结账"),
          });
        else await request(`${base}/confirm`, "POST", {});
        done += 1;
      } catch (e) {
        failed.push(
          `${player.displayName}: ${e instanceof Error ? e.message : t("操作失败")}`,
        );
      }
    }
    setBusy("");
    setBulk(null);
    setPicked(new Set());
    refresh();
    if (failed.length) setError(failed.join(" · "));
    else setNotice(t("已结账 {count} 位玩家", { count: done }));
  }

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold">
          {t(live ? "在店玩家" : "玩家")}
          {rows && (
            <span className="ml-2 text-base font-normal text-ink/50">
              {live ? present : visible.length}
            </span>
          )}
          {live && rows && unpaid > 0 && (
            <span className="ml-3 text-sm font-normal text-ink/50">
              {t("待结账")} {unpaid}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={button}
            onClick={refresh}
            aria-label={t("刷新")}
          >
            <RefreshCw size={16} />
          </button>
          {canWrite && (
            <button type="button" className={button} onClick={() => setBinding(true)}>
              {t("绑定账号")}
            </button>
          )}
        </div>
      </header>
      {/* Search and grouping share one row so the list starts higher. */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink/35"
            aria-hidden="true"
          />
          <input
            className={`${input} pl-9`}
            type="search"
            placeholder={t("搜索昵称或平台身份")}
            aria-label={t("搜索玩家")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <select
          className={`${input} !w-auto shrink-0`}
          aria-label={t("玩家分组")}
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value)}
        >
          <option value="none">{t("不分组")}</option>
          <option value="status">{t("按状态分组")}</option>
          {live && <option value="plan">{t("按计费方案分组")}</option>}
          {live && <option value="place">{t("按位置分组")}</option>}
        </select>
      </div>
      {live && cashierEnabled && <CashierSlot onChanged={refresh} />}
      {pickedRows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-mint/40 bg-mint/[0.04] px-3 py-2">
          <span className="text-sm">{t("已选 {count} 人", { count: pickedRows.length })}</span>
          <button
            type="button"
            className={buttonQuiet}
            onClick={() =>
              setPicked(allPicked ? new Set() : new Set(visible.map((p) => p.id)))
            }
          >
            {t(allPicked ? "取消全选" : "全选")}
          </button>
          <span className="flex-1" />
          <button
            type="button"
            className={primary}
            disabled={!!busy}
            onClick={() => setBulk("checkout")}
          >
            {t("批量结账")}
          </button>
          <button
            type="button"
            className={button}
            disabled={!!busy}
            onClick={() => setBulk("override")}
          >
            {t("批量改价结账")}
          </button>
        </div>
      )}
      {list.error || onSite.error ? (
        <State error={list.error || onSite.error} />
      ) : !rows ? (
        <State />
      ) : !rows.length ? (
        <div className="rounded-xl border border-dashed border-ink/20 px-6 py-14 text-center">
          <p className="font-medium">{t(live ? "现在没有在店玩家" : "还没有玩家")}</p>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink/55">
            {t(
              live
                ? "玩家扫码并确认开始计费后会出现在这里，可以看实时账单、替他们结账。"
                : "玩家第一次扫码登录后自动建档。从旧系统迁移的玩家可以在「设置 → 数据管理」导入。",
            )}
          </p>
          <Link
            className={`${button} mt-5`}
            to={`/merchant/${encodeURIComponent(shopCode)}/resources`}
          >
            {t("打开资源二维码")}
          </Link>
        </div>
      ) : (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
          <div className="max-h-[70vh] overflow-y-auto rounded-xl border border-ink/10 bg-panel">
            {!visible.length && <State empty />}
            {groups.map(([key, group]) => (
              <div key={key}>
                {groupBy !== "none" && (
                  <h3 className="border-b border-ink/10 bg-ink/[0.025] px-4 py-2 text-xs font-semibold">
                    {group.label}
                    <span className="ml-2 text-ink/50">
                      {group.count ?? group.players.length}
                    </span>
                  </h3>
                )}
                {group.players.map((player) => {
                  const isPicked = picked.has(player.id);
                  const active = player.id === selectedId;
                  return (
                    <div
                      key={player.id}
                      // The theme-coloured bar replaces a checkbox: it reads as
                      // a selection without adding another control to the row.
                      className={`relative border-b border-ink/10 last:border-b-0 ${
                        isPicked ? "bg-mint/[0.06]" : ""
                      }`}
                    >
                      {isPicked && (
                        <span
                          className="absolute inset-y-0 left-0 w-1 bg-mint"
                          aria-hidden="true"
                        />
                      )}
                      <button
                        type="button"
                        className={`focus-ring block w-full px-4 py-4 text-left ${
                          active ? "bg-ink/[0.06]" : "hover:bg-ink/[0.025]"
                        }`}
                        aria-pressed={active}
                        onClick={(event) => {
                          if (
                            selecting ||
                            event.metaKey ||
                            event.ctrlKey ||
                            event.shiftKey
                          ) {
                            setSelecting(true);
                            togglePick(player.id);
                            return;
                          }
                          openPlayer(player.id);
                        }}
                      >
                        <span className="flex items-baseline justify-between gap-3">
                          <span className="truncate text-base font-semibold">
                            {player.displayName}
                          </span>
                          {/* Short on funds is the one state a staff member has
                              to act on, so it is the only red line here. */}
                          <span
                            className={`shrink-0 text-xs ${
                              player.paymentMode !== "cashier" &&
                              (player.estimatedTotal ?? 0) !== null &&
                              player.walletTotal < (player.estimatedTotal ?? 0)
                                ? "text-coral"
                                : "text-ink/60"
                            }`}
                          >
                            {live
                              ? t(player.billStatus ?? "计费中")
                              : money(player.walletTotal)}
                          </span>
                        </span>
                        {live ? (
                          <span className="mt-3 grid grid-cols-3 gap-3">
                            <span>
                              <span className="block text-xs text-ink/60">
                                {t("入场时间")}
                              </span>
                              <span className="mt-1 block text-xl font-semibold leading-tight tabular-nums">
                                {player.startedAt ? (
                                  <time dateTime={player.startedAt}>
                                    {clockAt(player.startedAt)}
                                  </time>
                                ) : (
                                  "—"
                                )}
                              </span>
                              <span className="mt-1 block text-xs text-ink/50">
                                {player.startedAt && dayAt(player.startedAt)}
                              </span>
                            </span>
                            <span>
                              <span className="block text-xs text-ink/60">
                                {t("时长")}
                              </span>
                              <strong className="mt-1 block text-xl font-semibold leading-tight tabular-nums">
                                {stayDuration(player.stayMinutes ?? 0)}
                              </strong>
                            </span>
                            <span className="text-right">
                              <span className="block text-xs text-ink/60">
                                {t("应付")}
                              </span>
                              <strong className="mt-1 block break-all text-xl font-semibold leading-tight tabular-nums">
                                {money(player.estimatedTotal)}
                              </strong>
                              <span className="mt-1 block text-xs text-ink/50">
                                {player.sessionCount ?? 0} {t("项")}
                              </span>
                            </span>
                          </span>
                        ) : (
                          <span className="mt-1 block truncate text-xs text-ink/50">
                            {player.identities
                              ?.map(identityText)
                              .join(" · ") || t("无绑定身份")}
                          </span>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {selected ? (
            <PlayerPanel
              key={selected.id}
              player={selected}
              livePlayer={
                live && selected.id === activeId ? liveSelection : null
              }
              panelRef={panel}
              onChanged={refresh}
            />
          ) : (
            <div className="rounded-xl border border-dashed border-ink/15 px-6 py-16 text-center text-sm text-ink/50">
              {t("选择左侧玩家查看余额、资产和计费")}
            </div>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm text-mint">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-coral">
          {error}
        </p>
      )}
      {bulk && (
        <Modal
          title={bulk === "checkout" ? "批量结账" : "批量改价结账"}
          close={() => setBulk(null)}
        >
          <ActionForm
            sticky
            label={bulk === "checkout" ? "确认结账" : "确认改价结账"}
            done={() => setBulk(null)}
            submit={async (form) => {
              await runBulk(
                bulk,
                bulk === "override" ? Number(form.get("amount")) : undefined,
              );
            }}
          >
            <p className="text-sm">
              {t("将对 {count} 位玩家逐个结账。", {
                count: pickedRows.length,
              })}
            </p>
            {bulk === "override" && (
              <Field label="每人应付金额">
                <input
                  className={input}
                  name="amount"
                  type="number"
                  min="0"
                  step="0.01"
                  required
                  defaultValue="0"
                />
              </Field>
            )}
            <p className="text-xs text-ink/50">
              {pickedRows.map((player) => player.displayName).join("、")}
            </p>
          </ActionForm>
        </Modal>
      )}
      {binding && (
        <Modal title="绑定账号" close={() => setBinding(false)}>
          <BindForm
            done={() => {
              setBinding(false);
              refresh();
            }}
          />
        </Modal>
      )}
    </div>
  );
}

/** The cashier strip only exists on the in-shop tab. */
function CashierSlot({ onChanged }: { onChanged: () => void }) {
  const [cashier, setCashier] = useState<ReactNode>(null);
  useEffect(() => {
    void import("./Cashier").then((module) => {
      const Component = module.Cashier;
      setCashier(<Component onChanged={onChanged} />);
    });
  }, [onChanged]);
  return <>{cashier}</>;
}

function BindForm({ done }: { done: () => void }) {
  const { t } = useI18n();
  const request = useStaffApi();
  return (
    <ActionForm
      label="确认绑定"
      done={done}
      submit={(form) =>
        request("platform-binding/confirm", "POST", {
          code: String(form.get("code")).trim().toUpperCase(),
          provider: String(form.get("provider")).trim(),
          subject: String(form.get("subject")).trim(),
        })
      }
    >
      <Field label="玩家验证码">
        <input
          className={input}
          name="code"
          required
          maxLength={8}
          autoCapitalize="characters"
          autoComplete="off"
          pattern="[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjklmnpqrstuvwxyz]{8}"
        />
      </Field>
      <Field label="平台标识">
        <input
          className={input}
          name="provider"
          required
          pattern="[a-z][a-z0-9_-]{0,63}"
          placeholder="onebot"
        />
      </Field>
      <Field label="身份值">
        <input className={input} name="subject" required maxLength={256} />
      </Field>
    </ActionForm>
  );
}

/**
 * The right-hand panel: money, entry, checkout and the player's own records.
 * It replaces the previous modal so the list stays visible while managing
 * someone.
 */
function PlayerPanel({
  player,
  livePlayer,
  panelRef,
  onChanged,
}: {
  player: Row;
  /** Present on the in-shop tab: the live quote for this player. */
  livePlayer: LivePlayer | null;
  panelRef: React.RefObject<HTMLElement | null>;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const { canWrite, shopCode, cashierEnabled, timeZone } = useMerchant();
  const request = useStaffApi();
  const base = `players/${segment(player.id)}`;
  const assets = useResource<Holdings>(`${base}/assets`);
  const history = useResource<History>(`${base}/sessions/history`);
  const definitions = useResource<{ assetDefinitions: Asset[] }>(
    "asset-definitions",
  );
  const plans = useResource<{ pricingConfigs: EntryPlan[] }>(
    "pricing-configs",
  );
  const [action, setAction] = useState<
    "wallet" | "entry" | "checkout" | "override" | "recharge" | "grant" | null
  >(null);
  const [overrideTotal, setOverrideTotal] = useState("");
  const [rechargeAmount, setRechargeAmount] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const quoteRequest = useRef<AbortController | null>(null);
  useEffect(() => () => quoteRequest.current?.abort(), []);
  const done = () => {
    setAction(null);
    setPreview(null);
    assets.reload();
    history.reload();
    onChanged();
  };
  const billing = !!player.activeSessionId || !!livePlayer;
  const entryPlans = (plans.data?.pricingConfigs ?? []).filter(
    // Time plans and fixed charges run as sessions; a cap never does.
    (plan) => plan.enabled && plan.status !== "archived" && (plan.kind === "time.priority" || plan.kind === "charge.fixed"),
  );

  async function checkout() {
    if (busy) return;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    quoteRequest.current = controller;
    try {
      const result = await browserCheckoutPreview(
        shopApi(shopCode, `staff/${base}/billing-inputs`),
        shopApi(shopCode, `staff/${base}/checkout/preview`),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setPreview(result);
      setAction("checkout");
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <section
      ref={panelRef}
      className="min-w-0 overflow-hidden rounded-xl border border-ink/10 bg-panel"
      aria-label={t("玩家资料")}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-ink/10 px-4 py-3">
        <div className="min-w-0">
          <h3 className="truncate font-semibold">{player.displayName}</h3>
          <p className="mt-0.5 truncate text-xs text-ink/50">
            {player.identities?.map((i) => i.displayName || i.subject).join(" · ") ||
              t("无绑定身份")}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-ink/55">
            {t(player.paymentMode === "cashier" ? "现场收款" : "余额")}
          </p>
          <p className="text-xl font-semibold tabular-nums">
            {money(player.walletTotal)}
          </p>
        </div>
      </header>
      {error && (
        <p role="alert" className="border-b border-ink/10 px-4 py-2 text-sm text-coral">
          {error}
        </p>
      )}
      {canWrite && (
        <div className="flex flex-wrap gap-2 border-b border-ink/10 px-4 py-3">
          {player.paymentMode === "cashier" ? (
            cashierEnabled && (
              <Link
                className={primary}
                to={`/merchant/${segment(shopCode)}/live?cashierPlayer=${segment(player.id)}`}
              >
                {t("前台收款")}
              </Link>
            )
          ) : (
            <>
              <button
                type="button"
                className={primary}
                disabled={busy || player.status !== "active"}
                onClick={() => {
                  if (billing) void checkout();
                  else setAction("entry");
                }}
              >
                {t(billing ? "结账" : "开启计费")}
              </button>
              {billing && (
                <>
                  <button
                    type="button"
                    className={button}
                    disabled={busy || player.status !== "active"}
                    onClick={() => {
                      setOverrideTotal((player.estimatedTotal ?? 0).toFixed(2));
                      setAction("override");
                    }}
                  >
                    {t("改价结账")}
                  </button>
                  <button
                    type="button"
                    className={button}
                    disabled={busy || player.status !== "active"}
                    onClick={() => {
                      // The default covers what this player still owes.
                      const due = Math.max(
                        0,
                        (player.estimatedTotal ?? 0) - player.walletTotal,
                      );
                      setRechargeAmount(due.toFixed(2));
                      setAction("recharge");
                    }}
                  >
                    {t("充值结账")}
                  </button>
                </>
              )}
              <button
                type="button"
                className={button}
                onClick={() => setAction("wallet")}
              >
                {t("充值 / 扣款")}
              </button>
              <button
                type="button"
                className={button}
                onClick={() => setAction("grant")}
              >
                {t("发放资产")}
              </button>
            </>
          )}
        </div>
      )}
      {livePlayer && (
        <div className="grid gap-3 border-b border-ink/10 px-4 py-3">
          <dl className="grid grid-cols-3 gap-3">
            <div>
              <dt className="text-xs text-ink/60">{t("入场时间")}</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums">
                {livePlayer.sessions[0] ? (
                  <time dateTime={livePlayer.sessions[0].startedAt}>
                    {billTime(
                      livePlayer.sessions[0].startedAt,
                      timeZone || undefined,
                    ).time}
                  </time>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink/60">{t("时长")}</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums">
                {stayDuration(livePlayer.stayDurationMinutes)}
              </dd>
            </div>
            <div className="text-right">
              <dt className="text-xs text-ink/60">{t("应付")}</dt>
              <dd className="mt-1 break-all text-lg font-semibold tabular-nums">
                {money(livePlayer.estimatedTotal)}
              </dd>
            </div>
          </dl>
          {livePlayer.quoteState === "loading" && (
            <p role="status" className="text-sm text-ink/60">
              {t("正在计算账单")}
            </p>
          )}
          {livePlayer.quoteState === "error" && (
            <div role="alert" className="flex items-center gap-3 text-sm text-coral">
              <span>{t(livePlayer.quoteError || "账单预估失败，请刷新后重试")}</span>
              <button type="button" className={button} onClick={onChanged}>
                {t("重试")}
              </button>
            </div>
          )}
          {livePlayer.timeline && <BillLegend timeline={livePlayer.timeline} />}
          {livePlayer.timeline && (
            <BillTimeline
              timeZone={timeZone || undefined}
              preview={{
                settlementPreview: { total: livePlayer.estimatedTotal ?? 0 },
                timeline: livePlayer.timeline,
                chargeItems: [],
                adjustments: [],
              }}
            />
          )}
          {canWrite &&
            livePlayer.sessions
              .filter((session) => session.status === "active")
              .map((session) => (
                <div
                  key={session.id}
                  className="flex items-center justify-between gap-3 border-t border-ink/10 pt-2 text-sm"
                >
                  <span>
                    {(plans.data?.pricingConfigs ?? []).find((plan) => plan.id === session.pricingConfigId)?.name ??
                      ([...new Set(session.pricingCharges.map((c) => c.planName))].join(" + ") || t("计费"))}
                  </span>
                  <button
                    type="button"
                    className={button}
                    onClick={() =>
                      void request(
                        `players/${segment(player.id)}/sessions/${segment(session.id)}/stop`,
                        "POST",
                        {},
                      ).then(done)
                    }
                  >
                    {t("停止计费")}
                  </button>
                </div>
              ))}
        </div>
      )}
      <div className="grid gap-3 px-4 py-3">
        {action === "entry" && (
          <PlanStart base={base} plans={entryPlans} done={done} />
        )}
        {action === "wallet" && (
          <ActionForm
            done={done}
            label="确认调整"
            submit={(f) =>
              f.get("direction") === "minus"
                ? request(`${base}/wallet/adjustment`, "POST", {
                    amount: -Number(f.get("amount")),
                    reason: f.get("reason"),
                  })
                : request(`${base}/assets/grants`, "POST", {
                    reason: f.get("reason"),
                    grants: [
                      {
                        assetType: "currency",
                        assetCode: f.get("account"),
                        amount: Number(f.get("amount")),
                        mergeStrategy: "stack",
                        activeAt: null,
                        expiresAt: null,
                      },
                    ],
                  })
            }
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label="操作">
                <select className={input} name="direction">
                  <option value="plus">{t("充值")}</option>
                  <option value="minus">{t("扣款")}</option>
                </select>
              </Field>
              <Field label="金额">
                <input
                  className={input}
                  name="amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                />
              </Field>
            </div>
            <Field label="充值账户">
              <select className={input} name="account" required defaultValue="paid">
                {(definitions.data?.assetDefinitions ?? [])
                  .filter((a) => a.type === "currency" && a.status !== "archived")
                  .map((a) => (
                    <option value={a.code} key={a.code}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="备注">
              <input className={input} name="reason" required maxLength={200} />
            </Field>
          </ActionForm>
        )}

        {action === "grant" && (
          <ActionForm
            done={done}
            label="确认发放"
            submit={(f) => {
              const [assetType, assetCode] = String(f.get("asset")).split("|");
              return request(`${base}/assets/grants`, "POST", {
                reason: f.get("reason"),
                grants: [
                  {
                    assetType,
                    assetCode,
                    amount: Number(f.get("amount")),
                    mergeStrategy: "stack",
                    activeAt: null,
                    expiresAt: null,
                  },
                ],
              });
            }}
          >
            <Field label="资产">
              <select name="asset" className={input} required>
                {(definitions.data?.assetDefinitions ?? [])
                  .filter((a) => a.status !== "archived")
                  .map((a) => (
                    <option key={`${a.type}:${a.code}`} value={`${a.type}|${a.code}`}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="数量">
              <input
                className={input}
                type="number"
                name="amount"
                min="0.01"
                step="0.01"
                required
                defaultValue="1"
              />
            </Field>
            <Field label="备注">
              <input className={input} name="reason" required />
            </Field>
          </ActionForm>
        )}
        {action && (
          <button
            type="button"
            className={`${buttonQuiet} justify-self-start`}
            onClick={() => {
              setAction(null);
              setPreview(null);
            }}
          >
            {t("取消")}
          </button>
        )}
      </div>
      {/* Settling someone is a full-page decision, so it gets its own dialog
          rather than a form squeezed into the side column. */}
      {action === "checkout" && preview && (
        <Modal title="结账" close={() => setAction(null)}>
          <ActionForm
            sticky
            label="确认结账"
            done={done}
            submit={() => request(`${base}/checkout/confirm`, "POST", {})}
          >
            <BillTotal preview={preview} />
            <BillTimeline preview={preview} timeZone={timeZone || undefined} />
            <p className="text-sm text-ink/60">
              {t("结账后余额")} {money(preview.wallet.balanceAfter)}
            </p>
          </ActionForm>
        </Modal>
      )}
      {action === "override" && (
        <Modal title="改价结账" close={() => setAction(null)}>
          <ActionForm
            sticky
            label="确认改价结账"
            done={done}
            submit={(form) =>
              request(`${base}/checkout/override`, "POST", {
                finalTotal: Number(form.get("amount")),
                reason: String(form.get("reason") ?? "").trim(),
              })
            }
          >
            <Field label="最终应收金额">
              <input
                className={input}
                name="amount"
                type="number"
                required
                min="0"
                step="0.01"
                defaultValue={overrideTotal}
              />
            </Field>
            <Field label="改价原因">
              <input className={input} name="reason" required maxLength={200} />
            </Field>
          </ActionForm>
        </Modal>
      )}
      {action === "recharge" && (
        <Modal title="充值结账" close={() => setAction(null)}>
          <ActionForm
            sticky
            label="确认充值并结账"
            done={done}
            // The server commits the top-up and the checkout atomically.
            submit={(form) =>
              request(`${base}/checkout/recharge`, "POST", {
                amount: Number(form.get("amount")),
              })
            }
          >
            <Field label="充值金额">
              <input
                className={input}
                name="amount"
                type="number"
                required
                min="0.01"
                step="0.01"
                defaultValue={rechargeAmount}
              />
            </Field>
            <p className="text-sm text-ink/60">
              {t("当前可用余额")} {money(player.walletTotal)}
            </p>
          </ActionForm>
        </Modal>
      )}
      <div className="grid gap-1 border-t border-ink/10 px-4 py-3">
        <details open>
          <summary className="cursor-pointer py-2 text-sm font-medium">
            {t("资产")}
          </summary>
          {assets.error ? (
            <State error={assets.error} />
          ) : !(assets.data?.holdings?.length ?? 0) ? (
            <p className="pb-2 text-sm text-ink/50">{t("暂无资产")}</p>
          ) : (
            (assets.data?.holdings ?? []).map((h) => (
              <div
                key={h.id}
                className="flex justify-between gap-3 border-b border-ink/10 py-2 text-sm last:border-b-0"
              >
                <span>
                  {h.assetName}
                  {h.expiresAt && (
                    <small className="block text-xs text-ink/50">
                      {date(h.expiresAt)}
                    </small>
                  )}
                </span>
                <span className="tabular-nums">{h.quantity}</span>
              </div>
            ))
          )}
        </details>
        <details>
          <summary className="cursor-pointer py-2 text-sm font-medium">
            {t("消费记录")}
          </summary>
          {!(history.data?.sessions?.length ?? 0) ? (
            <p className="pb-2 text-sm text-ink/50">{t("暂无记录")}</p>
          ) : (
            (history.data?.sessions ?? []).map((s) => (
              <div
                key={s.sessionId}
                className="flex justify-between gap-3 border-b border-ink/10 py-2 text-sm last:border-b-0"
              >
                <span>{date(s.startedAt)}</span>
                <span className="tabular-nums">
                  {s.endedAt ? money(s.total) : t("进行中")}
                </span>
              </div>
            ))
          )}
          {history.error && <State error={history.error} />}
        </details>
        <details>
          <summary className="cursor-pointer py-2 text-sm font-medium">
            {t("资产流水")}
          </summary>
          {!(assets.data?.ledgerEntries?.length ?? 0) ? (
            <p className="pb-2 text-sm text-ink/50">{t("暂无流水")}</p>
          ) : (
            (assets.data?.ledgerEntries ?? []).map((e) => (
              <div
                key={e.id}
                className="grid grid-cols-[1fr_auto] gap-1 border-b border-ink/10 py-2 text-sm last:border-b-0"
              >
                <span className="min-w-0 truncate">
                  {e.assetName} · {e.reason}
                </span>
                <span className="tabular-nums">
                  {e.delta > 0 ? "+" : ""}
                  {money(e.delta)}
                </span>
                <small className="text-xs text-ink/50">{date(e.createdAt)}</small>
              </div>
            ))
          )}
        </details>
        <details>
          <summary className="cursor-pointer py-2 text-sm font-medium">
            {t("身份与状态")}
          </summary>
          {(player.identities ?? []).map((i) => (
            <p className="my-1 text-sm" key={`${i.provider}:${i.subject}`}>
              {i.provider === "web-account" ? t("PRiSM 账号") : i.provider}:
              {i.displayName && <span> {i.displayName} · </span>}
              {i.subject}
            </p>
          ))}
          {canWrite && (
            <div className="mt-2 grid gap-4">
              <ActionForm
                done={done}
                label="绑定平台身份"
                submit={(f) =>
                  request(`${base}/identities`, "POST", {
                    provider: String(f.get("provider")).trim(),
                    subject: String(f.get("subject")).trim(),
                  })
                }
              >
                <Field label="平台标识">
                  <input
                    className={input}
                    name="provider"
                    required
                    pattern="[a-z][a-z0-9_-]{0,63}"
                    placeholder="onebot"
                  />
                </Field>
                <Field label="身份值">
                  <input className={input} name="subject" required maxLength={256} />
                </Field>
              </ActionForm>
              <ActionForm
                done={done}
                label="更新状态"
                submit={(f) =>
                  request(`${base}/status`, "PATCH", { status: f.get("status") })
                }
              >
                <Field label="状态">
                  <select className={input} name="status" defaultValue={player.status}>
                    <option value="active">{t("正常")}</option>
                    <option value="disabled">{t("停用")}</option>
                    <option value="banned">{t("封禁")}</option>
                  </select>
                </Field>
              </ActionForm>
            </div>
          )}
        </details>
      </div>
    </section>
  );
}

type PlanStartPreview = { changed: boolean; revision: string; started: string[]; stopped: string[]; kept: string[] };

/** Staff start one plan; what it starts, stops and keeps is shown before confirming. */
function PlanStart({ base, plans, done }: { base: string; plans: readonly { id: string; name: string }[]; done: () => void }) {
  const { t } = useI18n();
  const request = useStaffApi();
  const [planId, setPlanId] = useState(plans[0]?.id ?? "");
  const [preview, setPreview] = useState<PlanStartPreview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!planId) return;
    let cancelled = false;
    setPreview(null);
    setError("");
    request<PlanStartPreview>(`${base}/session/preview`, "POST", { pricingConfigId: planId })
      .then((result) => { if (!cancelled) setPreview(result); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? staffMessage(e) : t("操作失败")); });
    return () => { cancelled = true; };
  }, [base, planId, request, t]);
  const rows: [string, string[]][] = preview
    ? [[t("新增方案"), preview.started], [t("结束方案"), preview.stopped], [t("保留方案"), preview.kept]]
    : [];
  return (
    <ActionForm
      done={done}
      label="开始计费"
      submitDisabled={!preview?.changed}
      submit={() => request(`${base}/session/start`, "POST", { pricingConfigId: planId, expectedRevision: preview!.revision })}
    >
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{t("计费方案")}</legend>
        {plans.length ? (
          plans.map((plan) => (
            <label className="flex items-center gap-2 text-sm" key={plan.id}>
              <input type="radio" name="plan" value={plan.id} checked={plan.id === planId} onChange={() => setPlanId(plan.id)} />
              {plan.name}
            </label>
          ))
        ) : (
          <p className="text-sm text-ink/55">{t("没有可用的计费方案")}</p>
        )}
      </fieldset>
      {error && <p role="alert" className="text-sm text-coral">{error}</p>}
      {rows.some(([, names]) => names.length) && (
        <dl className="grid gap-2 text-sm">
          {rows.filter(([, names]) => names.length).map(([label, names]) => (
            <div className="flex flex-wrap gap-x-3" key={label}>
              <dt className="text-ink/60">{label}</dt>
              <dd className="font-medium">{names.join("、")}</dd>
            </div>
          ))}
        </dl>
      )}
    </ActionForm>
  );
}
