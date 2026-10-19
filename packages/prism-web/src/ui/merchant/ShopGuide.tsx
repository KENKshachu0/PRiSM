import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import {
  Bot,
  CheckCircle2,
  Database,
  Gamepad2,
  Gift,
  LogIn,
  MapPin,
  QrCode,
  Receipt,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { Api, api } from "../../api";
import { useI18n } from "../../i18n";
import { shopApi, type Settings } from "../BillingPages";
import { button, buttonQuiet, primary, useMerchant } from "./shared";
import {
  identityPolicySettings,
  setupStatus,
  type IdentityPolicy,
  type SetupStatus,
  type SetupStepId,
} from "./setup-guide";
import { IdentityPolicyPicker } from "./IdentityPolicyPicker";

const trialKey = (shopCode: string) => `prism.setup.trial.${shopCode}`;
const statusCache = new Map<string, SetupStatus>();

function readTrial(shopCode: string) {
  try {
    return window.localStorage.getItem(trialKey(shopCode)) === "1";
  } catch {
    return false;
  }
}

async function loadStatus(shopCode: string, shopId: string) {
  const optional = <T,>(request: Promise<T>) => request.catch(() => null);
  const settings = await api<Settings>(shopApi(shopCode, "settings"));
  const [machines, staffSettings, tokens, players, members, presents] =
    await Promise.all([
      Api.machines(shopId).then((r) => r.machines),
      optional(
        api<{
          settings: {
            ttLockConnection?: Record<string, string | undefined> | null;
            registration?: { defaultPresentId: string | null };
          };
        }>(shopApi(shopCode, "staff/settings")),
      ),
      optional(
        api<{
          apiTokens: { role: string; status: string; lastUsedAt?: string | null }[];
        }>(shopApi(shopCode, "staff/api-tokens")),
      ),
      settings.billingEnabled
        ? optional(
            api<{ players: { walletTotal: number }[] }>(
              shopApi(shopCode, "staff/players"),
            ),
          )
        : null,
      optional(Api.shopMembers(shopId)),
      optional(
        api<{ presents: { status: string }[] }>(
          shopApi(shopCode, "staff/presents"),
        ),
      ),
    ]);
  return setupStatus({
    settings,
    machines,
    tokens: tokens?.apiTokens ?? [],
    ttLock: staffSettings?.settings.ttLockConnection ?? null,
    players: players?.players ?? null,
    defaultPresent: !!staffSettings?.settings.registration?.defaultPresentId,
    members: members?.members.length ?? 0,
    presents:
      presents?.presents.filter((p) => p.status !== "archived").length ?? 0,
    trialConfirmed: readTrial(shopCode),
  });
}

/**
 * Setup progress for the owner. The workspace reads it to decide whether the
 * guide tab is shown and where a bare `/merchant/:shop` lands, so it loads
 * before the tabs render; the guide page reloads it whenever it mounts.
 */
export function useSetupStatus(
  shopCode: string,
  shopId: string,
  enabled: boolean,
) {
  const [status, setStatus] = useState<SetupStatus | null>(
    () => statusCache.get(shopCode) ?? null,
  );
  const [loaded, setLoaded] = useState(() => statusCache.has(shopCode));
  const current = useRef(0);
  const reload = useCallback(async () => {
    if (!enabled) return;
    const request = ++current.current;
    try {
      const next = await loadStatus(shopCode, shopId);
      statusCache.set(shopCode, next);
      if (request === current.current) setStatus(next);
    } catch {
      // The guide is advisory; a failed read must not block the workspace.
    } finally {
      if (request === current.current) setLoaded(true);
    }
  }, [enabled, shopCode, shopId]);
  useEffect(() => {
    if (!enabled) return;
    void reload();
    const refresh = () => void reload();
    window.addEventListener("prism-shop-settings", refresh);
    return () => window.removeEventListener("prism-shop-settings", refresh);
  }, [enabled, reload]);
  return { status, loaded: !enabled || loaded, reload };
}

export const SetupContext = createContext<{
  status: SetupStatus | null;
  reload: () => Promise<void>;
}>({ status: null, reload: async () => {} });

export function ShopGuide() {
  const { t } = useI18n();
  const { shopCode } = useMerchant();
  const { status, reload } = useContext(SetupContext);
  useEffect(() => {
    void reload();
  }, [reload]);
  if (!status)
    return (
      <p role="status" className="py-10 text-center text-sm text-ink/60">
        {t("加载中...")}
      </p>
    );
  const done = status.steps.filter((step) => step.done).length;
  const next = status.steps.find((step) => !step.done)?.id;
  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold">{t("开店指引")}</h2>
        <p className="text-sm text-ink/60" role="status">
          {status.complete
            ? t("基础接入已完成")
            : t("已完成 {done} / {total}", {
                done,
                total: status.steps.length,
              })}
        </p>
      </header>
      <HowItWorks billing={status.billing} />
      <section className="grid gap-3" aria-labelledby="setup-steps">
        <h3 id="setup-steps" className="font-semibold">
          {t("接入步骤")}
        </h3>
        <ol className="grid gap-3">
          {status.steps.map((step, index) => (
            <StepCard
              key={step.id}
              index={index + 1}
              id={step.id}
              done={step.done}
              next={step.id === next}
              status={status}
              shopCode={shopCode}
              reload={reload}
            />
          ))}
        </ol>
      </section>
      <Optional status={status} shopCode={shopCode} />
    </div>
  );
}

function HowItWorks({ billing }: { billing: boolean }) {
  const { t } = useI18n();
  const flow: [LucideIcon, string, string][] = billing
    ? [
        [QrCode, "扫码", "玩家用手机扫设备上的二维码并登录。"],
        [LogIn, "入场", "确认收费标准，开始计时。"],
        [Gamepad2, "用设备", "在手机上开机、刷卡、投币或开门。"],
        [Wallet, "结账", "离店时一键结账，从余额扣款。"],
      ]
    : [
        [QrCode, "扫码", "玩家用手机扫设备上的二维码并登录。"],
        [Gamepad2, "用设备", "直接在手机上开机、刷卡、投币或开门，不计费。"],
      ];
  const tabs: [string, string][] = billing
    ? [
        ["在店", "谁在店里、实时账单，替玩家结账或收款。"],
        ["玩家", "全部玩家档案、余额和绑定的身份。"],
        ["计费", "什么时段、按什么价格收费。"],
        ["资产", "余额种类、优惠、礼物和兑换码。"],
        ["记录", "每一笔结账和营业额。"],
        ["设备", "设备、二维码和远程操作。"],
        ["设置", "店铺资料、玩家身份、Bot 和成员。"],
      ]
    : [
        ["设备", "设备、二维码和远程操作。"],
        ["设置", "店铺资料、玩家身份、Bot 和成员。"],
      ];
  return (
    <section
      className="grid gap-5 rounded-xl border border-ink/10 bg-panel p-5"
      aria-labelledby="how-it-works"
    >
      <h3 id="how-it-works" className="font-semibold">
        {t("玩家在店里怎么用")}
      </h3>
      <ol
        className={`grid gap-3 ${billing ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-2"}`}
      >
        {flow.map(([Icon, title, description], index) => (
          <li key={title} className="flex gap-3 rounded-lg bg-ink/[0.03] p-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-mint/10 text-mint">
              <Icon size={18} aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <strong className="block text-sm">
                {index + 1}. {t(title)}
              </strong>
              <span className="mt-0.5 block text-sm leading-relaxed text-ink/60">
                {t(description)}
              </span>
            </span>
          </li>
        ))}
      </ol>
      <div>
        <h4 className="mb-2 text-sm font-medium">{t("后台各页签")}</h4>
        <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
          {tabs.map(([tab, purpose]) => (
            <div key={tab} className="flex gap-3">
              <dt className="min-w-16 shrink-0 font-medium">{t(tab)}</dt>
              <dd className="text-ink/60">{t(purpose)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function StepCard({
  index,
  id,
  done,
  next,
  status,
  shopCode,
  reload,
}: {
  index: number;
  id: SetupStepId;
  done: boolean;
  next: boolean;
  status: SetupStatus;
  shopCode: string;
  reload: () => Promise<void>;
}) {
  const { t } = useI18n();
  const base = `/merchant/${encodeURIComponent(shopCode)}`;
  const action = next ? primary : button;
  const content: {
    title: string;
    why?: string;
    fact?: string;
    warn?: string;
    actions?: ReactNode;
    body?: ReactNode;
  } =
    id === "pricing"
      ? {
          title: "设定收费标准",
          why: "玩家入场时按选中的入场规则计时；规则没覆盖的时段无法入场。",
          warn:
            status.pricingProblem === "assets"
              ? "缺少可用的余额资产，玩家无法结账。"
              : status.pricingProblem === "entry"
                ? "还没有选中可用的入场规则，玩家无法入场。"
                : undefined,
          actions: (
            <>
              {status.pricingProblem === "assets" && (
                <Link className={action} to={`${base}/assets`}>
                  {t("恢复余额资产")}
                </Link>
              )}
              {status.pricingProblem === "entry" && (
                <Link className={action} to={`${base}/settings?group=billing`}>
                  {t("选择入场规则")}
                </Link>
              )}
              <Link className={done ? buttonQuiet : button} to={`${base}/pricing`}>
                {t("查看计费规则")}
              </Link>
            </>
          ),
        }
      : id === "identity"
        ? {
            title: "决定玩家如何进店",
            why: status.billing
              ? "入场前，平台需要确认玩家是谁。"
              : "开门和上麻将桌前，平台需要确认玩家是本店玩家。",
            warn: done
              ? undefined
              : status.botIssued
                ? "已创建 Bot 凭据，但还没有 Bot 用它连接过。新玩家扫码后会卡在绑定身份这一步。"
                : "当前要求绑定 Bot 身份，但店铺还没有接入 Bot。新玩家扫码后会卡在绑定身份这一步。",
            body: (
              <IdentityStep
                value={status.identity}
                shopCode={shopCode}
                reload={reload}
                next={next}
              />
            ),
          }
        : id === "devices"
          ? {
              title: "添加设备并配置能力",
              why: "设备是玩家扫码后能操作的对象：一台机台、一扇门或一张麻将桌。「能力」决定它能做什么：开关电源、刷卡投币、开门或开桌。",
              fact: !status.devices
                ? "还没有设备"
                : status.unconfigured
                  ? t("{count} 台设备还没有配置能力", {
                      count: status.unconfigured,
                    })
                  : t("已有 {count} 台设备", { count: status.devices }),
              actions: (
                <Link
                  className={done ? buttonQuiet : action}
                  to={status.devices ? `${base}/devices` : `${base}/devices?add=1`}
                >
                  {t(status.devices ? "打开设备页" : "添加设备")}
                </Link>
              ),
            }
          : id === "door"
            ? {
                title: "连接 TTLock 账号",
                why: "开门密码由店铺的 TTLock 开放平台账号生成，没连接时开门会失败。",
                fact: t("{count} 台设备启用了开门密码", {
                  count: status.doorDevices,
                }),
                actions: (
                  <Link
                    className={done ? buttonQuiet : action}
                    to={`${base}/settings?group=devices`}
                  >
                    {t(done ? "查看 TTLock 设置" : "连接 TTLock")}
                  </Link>
                ),
              }
            : id === "payment"
              ? {
                  title: "决定玩家怎么付钱",
                  why: "玩家自助结账从余额扣款，余额不足就结不了账。可以在「玩家」页给玩家充值、设置新玩家礼物，或开启前台收银在店里现场收款。",
                  actions: (
                    <>
                      <Link
                        className={done ? buttonQuiet : action}
                        to={`${base}/settings?group=billing`}
                      >
                        {t("前台收银")}
                      </Link>
                      <Link
                        className={done ? buttonQuiet : button}
                        to={`${base}/settings?group=players`}
                      >
                        {t("新玩家礼物")}
                      </Link>
                    </>
                  ),
                }
              : {
                  title: "贴好二维码，自己试一次",
                  why: status.billing
                    ? "每台设备都有专属二维码，打印后贴在对应设备上。用自己的手机扫一次，走一遍入场、操作设备和结账。"
                    : "每台设备都有专属二维码，打印后贴在对应设备上。用自己的手机扫一次，确认能登录并操作设备。",
                  fact:
                    status.billing && status.players
                      ? t("已有 {count} 位玩家", { count: status.players })
                      : undefined,
                  actions: (
                    <>
                      <Link
                        className={done ? buttonQuiet : action}
                        to={`${base}/devices`}
                      >
                        {t("打开设备二维码")}
                      </Link>
                      <TrialToggle shopCode={shopCode} reload={reload} />
                    </>
                  ),
                };
  return (
    <li
      data-step={id}
      className={`rounded-xl border bg-panel p-5 ${next ? "border-mint/50" : "border-ink/10"}`}
    >
      <div className="flex gap-4">
        <span
          aria-hidden="true"
          className={`grid size-8 shrink-0 place-items-center rounded-full text-sm font-semibold ${done ? "bg-mint/10 text-mint" : next ? "bg-primary text-primary-foreground" : "bg-ink/5 text-ink/60"}`}
        >
          {done ? <CheckCircle2 size={18} /> : index}
        </span>
        <div className="grid min-w-0 flex-1 gap-2">
          <h4 className="flex flex-wrap items-center gap-x-3 gap-y-1 font-semibold">
            {t(content.title)}
            <span
              className={`text-xs font-normal ${done ? "text-mint" : "text-ink/50"}`}
            >
              {t(done ? "已完成" : "待完成")}
            </span>
          </h4>
          {content.why && (
            <p className="text-sm leading-relaxed text-ink/60">
              {t(content.why)}
            </p>
          )}
          {content.fact && <p className="text-sm">{t(content.fact)}</p>}
          {content.warn && (
            <p className="text-sm text-coral">{t(content.warn)}</p>
          )}
          {content.body}
          {content.actions && (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {content.actions}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function IdentityStep({
  value,
  shopCode,
  reload,
  next,
}: {
  value: IdentityPolicy;
  shopCode: string;
  reload: () => Promise<void>;
  next: boolean;
}) {
  const { t } = useI18n();
  const [policy, setPolicy] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => setPolicy(value), [value]);
  async function save() {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const current = await api<Settings>(shopApi(shopCode, "settings"));
      await api(shopApi(shopCode, "settings"), {
        method: "PUT",
        body: JSON.stringify({ ...current, ...identityPolicySettings(policy) }),
      });
      setSaved(true);
      window.dispatchEvent(new Event("prism-shop-settings"));
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("保存失败"));
    } finally {
      setBusy(false);
    }
  }
  const base = `/merchant/${encodeURIComponent(shopCode)}`;
  return (
    <div className="grid gap-3">
      <IdentityPolicyPicker value={policy} change={(next) => { setPolicy(next); setSaved(false); }} />
      {error && (
        <p role="alert" className="text-sm text-coral">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {policy !== value && (
          <button
            type="button"
            className={primary}
            disabled={busy}
            onClick={save}
          >
            {t(busy ? "处理中…" : "保存")}
          </button>
        )}
        {policy !== "web" && (
          <Link className={button} to={`${base}/settings?group=integrations`}>
            {t("接入 Bot")}
          </Link>
        )}
        {saved && (
          <span role="status" className="text-sm text-mint">
            {t("已保存")}
          </span>
        )}
      </div>
    </div>
  );
}

function TrialToggle({
  shopCode,
  reload,
}: {
  shopCode: string;
  reload: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [checked, setChecked] = useState(() => readTrial(shopCode));
  return (
    <label className="flex min-h-11 items-center gap-2 px-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          try {
            if (event.target.checked)
              window.localStorage.setItem(trialKey(shopCode), "1");
            else window.localStorage.removeItem(trialKey(shopCode));
          } catch {
            // Without storage the box still reflects this visit.
          }
          setChecked(event.target.checked);
          void reload();
        }}
      />
      {t("我已试过")}
    </label>
  );
}

function Optional({
  status,
  shopCode,
}: {
  status: SetupStatus;
  shopCode: string;
}) {
  const { t } = useI18n();
  const base = `/merchant/${encodeURIComponent(shopCode)}`;
  const items: {
    icon: LucideIcon;
    title: string;
    description: string;
    state?: string;
    to: string;
  }[] = [
    {
      icon: Bot,
      title: "接入 Bot",
      description: "让玩家在 QQ 等平台绑定身份、查余额和操作设备。",
      state: status.botConnected
        ? "已连接"
        : status.botIssued
          ? "已创建凭据，未连接"
          : undefined,
      to: `${base}/settings?group=integrations`,
    },
    {
      icon: Users,
      title: "邀请店员",
      description: status.billing
        ? "店员可以帮玩家结账、充值和操作设备；计费权限在成员列表里单独设置。"
        : "店员可以查看和远程操作设备。",
      state:
        status.members > 1
          ? t("{count} 位成员", { count: status.members })
          : undefined,
      to: `${base}/settings?group=members`,
    },
    ...(status.billing
      ? [
          {
            icon: Gift,
            title: "优惠、礼物与兑换码",
            description:
              "做活动和会员：优惠在结账时抵扣，礼物打包发放资产，兑换码让玩家自己领礼物。",
            state: status.presents
              ? t("{count} 个礼物", { count: status.presents })
              : undefined,
            to: `${base}/assets`,
          },
        ]
      : [
          {
            icon: Receipt,
            title: "启用入场计费",
            description: "按时长向玩家收费，管理玩家余额和离店结账。",
            to: `${base}/settings?group=billing`,
          },
        ]),
    {
      icon: MapPin,
      title: "到店位置校验",
      description: "要求玩家在店铺范围内才能入场和操作设备，防止远程操作。",
      to: `${base}/settings?group=devices`,
    },
    {
      icon: Database,
      title: "从 prism-neo 迁移",
      description:
        "导入旧系统的玩家、余额和计费规则。导入的计费规则默认停用，核对后再启用。",
      to: `${base}/settings?group=data`,
    },
  ];
  return (
    <section className="grid gap-3" aria-labelledby="setup-optional">
      <h3 id="setup-optional" className="font-semibold">
        {t("按需配置")}
      </h3>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <li key={item.title}>
            <Link
              to={item.to}
              className="focus-ring flex h-full gap-3 rounded-xl border border-ink/10 bg-panel p-4 transition-colors hover:border-ink/25"
            >
              <item.icon
                className="mt-0.5 shrink-0 text-ink/50"
                size={18}
                aria-hidden="true"
              />
              <span className="grid min-w-0 gap-1">
                <strong className="text-sm">{t(item.title)}</strong>
                <span className="text-sm leading-relaxed text-ink/60">
                  {t(item.description)}
                </span>
                {item.state && (
                  <span className="text-xs text-mint">{t(item.state)}</span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
