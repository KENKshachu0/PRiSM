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
  ArrowRight,
  Bot,
  CheckCircle2,
  CreditCard,
  Database,
  Gamepad2,
  Gift,
  LogIn,
  MapPin,
  Nfc,
  Receipt,
  ShieldCheck,
  Ticket,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { Api, api } from "../../api";
import { browserHid } from "../../card-reader";
import { useI18n } from "../../i18n";
import { shopApi, type Settings } from "../BillingPages";
import { BindingPrompt } from "../SessionContent";
import { BillingExplainer } from "./BillingExplainer";
import { IdentityPolicyPicker } from "./IdentityPolicyPicker";
import { Modal, button, buttonQuiet, primary, useMerchant } from "./shared";
import {
  identityPolicySettings,
  setupStatus,
  type IdentityPolicy,
  type OperatingMode,
  type SetupStatus,
  type SetupStepId,
} from "./setup-guide";

const trialKey = (shopCode: string) => `prism.setup.trial.${shopCode}`;
const statusCache = new Map<string, SetupStatus>();

function readTrial(shopCode: string) {
  try {
    return window.localStorage.getItem(trialKey(shopCode)) === "1";
  } catch {
    return false;
  }
}

/** Whether this browser has already been allowed to use a HINATA reader. */
async function readerAuthorized(): Promise<boolean | null> {
  const hid = browserHid();
  if (!hid) return null;
  try {
    return (await hid.getDevices()).some((device) => device.vendorId === 0xf822);
  } catch {
    return null;
  }
}

async function loadStatus(shopCode: string, shopId: string) {
  const optional = <T,>(request: Promise<T>) => request.catch(() => null);
  const settings = await api<Settings>(shopApi(shopCode, "settings"));
  const billing = settings.billingEnabled;
  const [machines, staffSettings, tokens, players, members, presents, codes, reader] =
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
      billing
        ? optional(api<{ players: { walletTotal: number }[] }>(shopApi(shopCode, "staff/players")))
        : null,
      optional(Api.shopMembers(shopId)),
      optional(api<{ presents: { status: string }[] }>(shopApi(shopCode, "staff/presents"))),
      billing
        ? optional(
            api<{
              redeemCodes: { usageCount: number; maxUseCount: number; expiresAt: string | null }[];
            }>(shopApi(shopCode, "staff/redeem-codes")),
          )
        : null,
      settings.cashierEnabled ? readerAuthorized() : Promise.resolve(null),
    ]);
  const now = Date.now();
  return setupStatus({
    settings,
    machines,
    tokens: tokens?.apiTokens ?? [],
    ttLock: staffSettings?.settings.ttLockConnection ?? null,
    players: players?.players ?? null,
    redeemCodes:
      codes?.redeemCodes.filter(
        (code) =>
          code.usageCount < code.maxUseCount &&
          (!code.expiresAt || Date.parse(code.expiresAt) > now),
      ).length ?? 0,
    reader,
    defaultPresent: !!staffSettings?.settings.registration?.defaultPresentId,
    members: members?.members.length ?? 0,
    presents: presents?.presents.filter((p) => p.status !== "archived").length ?? 0,
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

const modeNames: Record<OperatingMode, [string, string]> = {
  self: ["自助计费（无前台）", "玩家在手机上入场计时、离店自助结账，从预存余额扣款。"],
  desk: ["前台收银", "玩家在前台刷实体卡入场，离店时在前台现场付款；带手机的玩家也可以自助。"],
  devices: ["不使用计费", "只用 PRiSM 的设备功能，收费在你自己的其它经营平台完成。"],
};

export function ShopGuide() {
  const { t } = useI18n();
  const { shopCode } = useMerchant();
  const { status, reload } = useContext(SetupContext);
  const [explaining, setExplaining] = useState(false);
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
  const base = `/merchant/${encodeURIComponent(shopCode)}`;
  const [modeTitle, modeDescription] = modeNames[status.mode];
  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold">{t("开店指引")}</h2>
        <p className="text-sm text-ink/60" role="status">
          {status.complete
            ? t("基础接入已完成")
            : t("已完成 {done} / {total}", { done, total: status.steps.length })}
        </p>
      </header>
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink/10 bg-panel p-5">
        <div className="min-w-0">
          <p className="text-xs text-ink/50">{t("经营方式")}</p>
          <p className="mt-1 font-semibold">{t(modeTitle)}</p>
          <p className="mt-1 text-sm leading-relaxed text-ink/60">{t(modeDescription)}</p>
        </div>
        <Link className={buttonQuiet + " px-3 py-2"} to={`${base}/settings?group=billing`}>
          {t("更改")}
        </Link>
      </section>
      <PlayerJourney mode={status.mode} identity={status.identity !== "web" && status.identityMatters} />
      <OwnerDaily mode={status.mode} />
      {status.billing && (
        <>
          <MoneyFlow mode={status.mode} />
          <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-ink/10 bg-panel p-5">
            <div className="min-w-0">
              <h3 className="font-semibold">{t("计费说明书")}</h3>
              <p className="mt-1 text-sm leading-relaxed text-ink/60">
                {t("计费图解、字段说明与配置注意事项。")}
              </p>
            </div>
            <button type="button" className={button} onClick={() => setExplaining(true)}>
              {t("查看说明书")}
            </button>
          </section>
        </>
      )}
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
      {explaining && (
        <Modal title="计费说明书" close={() => setExplaining(false)} xl>
          <BillingExplainer />
        </Modal>
      )}
    </div>
  );
}

type Stage = [LucideIcon, string, string];

function Flow({ stages }: { stages: Stage[] }) {
  const { t } = useI18n();
  return (
    <ol className="grid gap-2 sm:grid-cols-2 lg:grid-flow-col lg:grid-cols-none lg:auto-cols-fr">
      {stages.map(([Icon, title, description], index) => (
        <li key={title} className="relative flex gap-3 rounded-lg bg-ink/[0.03] p-3 lg:flex-col lg:gap-2">
          <span className="flex items-center gap-2">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-mint/10 text-mint">
              <Icon size={16} aria-hidden="true" />
            </span>
            {index < stages.length - 1 && (
              <ArrowRight className="hidden text-ink/25 lg:block" size={16} aria-hidden="true" />
            )}
          </span>
          <span className="min-w-0">
            <strong className="block text-sm">
              {index + 1}. {t(title)}
            </strong>
            <span className="mt-0.5 block text-sm leading-relaxed text-ink/60">{t(description)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function PlayerJourney({ mode, identity }: { mode: OperatingMode; identity: boolean }) {
  const { t } = useI18n();
  const scan: Stage = [Nfc, "碰 NFC 或扫码", "设备上的 NFC 标签和二维码是同一个链接。iPhone 碰一下直接打开 PRiSM Link（App Clip，免安装），其它手机用浏览器打开。"];
  const login: Stage = [LogIn, "登录", "用 MuNET 或 Passkey 登录。"];
  const bind: Stage = [ShieldCheck, "第一次来：绑定身份", "按你写的绑定提示，把绑定码发给店铺 Bot。以后不用再绑。"];
  const stages: Stage[] =
    mode === "desk"
      ? [
          [CreditCard, "前台刷卡", "第一次来由店员登记一个昵称，之后刷卡就能认出。"],
          [Receipt, "店员点入场", "按店铺的入场规则开始计时。"],
          [Gamepad2, "游玩", "计时进行中，店员可以在「在店」页随时看账单。"],
          [Wallet, "回前台付款", "店员按屏幕金额收微信、支付宝或现金，确认收款后结账。"],
        ]
      : mode === "self"
        ? [
            scan,
            login,
            ...(identity ? [bind] : []),
            [Receipt, "确认收费并入场", "看到当天的收费标准，确认后开始计时。"],
            [Gamepad2, "用设备", "在手机上开机、刷卡、投币、开门或上麻将桌。"],
            [Wallet, "离店结账", "一键结账，从余额扣款，计时停止。"],
          ]
        : [
            scan,
            login,
            ...(identity ? [bind] : []),
            [Gamepad2, "操作设备", "开机、刷卡、投币或开门，不计费。"],
          ];
  return (
    <section className="grid gap-3 rounded-xl border border-ink/10 bg-panel p-5" aria-labelledby="player-journey">
      <h3 id="player-journey" className="font-semibold">{t("正常营业时，玩家这样用")}</h3>
      <Flow stages={stages} />
      {mode === "desk" && (
        <p className="text-sm leading-relaxed text-ink/60">
          {t("带手机的玩家也可以不经过前台：扫设备上的码或碰 NFC 入场，离店时用余额自助结账。")}
        </p>
      )}
    </section>
  );
}

function OwnerDaily({ mode }: { mode: OperatingMode }) {
  const { t } = useI18n();
  const items: [string, string][] =
    mode === "desk"
      ? [
          ["在店", "前台电脑用桌面版 Chrome 或 Edge 打开，连上读卡器。玩家刷卡入场，离店再刷卡收款。"],
          ["玩家", "查玩家档案、余额和绑定的身份；给预存余额的玩家充值。"],
          ["记录", "每笔结账和营业额，现场收款和余额结算分开统计。"],
          ["设备", "看设备状态、远程开关机、查操作记录。"],
        ]
      : mode === "self"
        ? [
            ["在店", "谁在店里、实时账单，必要时替玩家结账。"],
            ["玩家", "玩家余额不够时在这里充值；查档案和绑定的身份。"],
            ["资产", "建充值礼物、生成兑换码，拿到群里或网店售卖。"],
            ["记录", "每笔结账和营业额。"],
            ["设备", "看设备状态、远程开关机、查操作记录。"],
          ]
        : [
            ["设备", "看设备状态、远程开关机、开门、查操作记录。"],
            ["设置", "玩家身份要求、Bot、门锁账号和成员。"],
          ];
  return (
    <section className="grid gap-3 rounded-xl border border-ink/10 bg-panel p-5" aria-labelledby="owner-daily">
      <h3 id="owner-daily" className="font-semibold">{t("你每天在后台做什么")}</h3>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {items.map(([tab, purpose]) => (
          <div key={tab} className="flex gap-3">
            <dt className="min-w-12 shrink-0 font-medium">{t(tab)}</dt>
            <dd className="leading-relaxed text-ink/60">{t(purpose)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function MoneyFlow({ mode }: { mode: OperatingMode }) {
  const { t } = useI18n();
  const sources: [LucideIcon, string, string][] = [
    [Ticket, "兑换码", "在「资产」建充值礼物、生成兑换码，拿到任何渠道售卖。玩家在网页、App Clip 或 Bot 里兑换后到账。"],
    [Users, "店员充值", "在「玩家」页给玩家充值或扣款，可选充值余额或赠送余额。"],
    [Gift, "礼物与活动", "新玩家礼物、活动兑换码，发放赠送余额或优惠券。"],
  ];
  return (
    <section className="grid gap-4 rounded-xl border border-ink/10 bg-panel p-5" aria-labelledby="money-flow">
      <h3 id="money-flow" className="font-semibold">{t("钱从哪来、怎么扣")}</h3>
      {mode === "desk" && (
        <div className="flex gap-3 rounded-lg border border-mint/30 bg-mint/5 p-3 text-sm">
          <CreditCard className="mt-0.5 shrink-0 text-mint" size={18} aria-hidden="true" />
          <p className="leading-relaxed">
            <strong>{t("前台收银")}</strong>
            {"："}
            {t("刷卡入场的玩家在前台用微信、支付宝或现金付款，店员勾选「已收款」后结账。这笔钱不进玩家余额，系统只记录金额、收款方式和收银员。")}
          </p>
        </div>
      )}
      <p className="text-sm leading-relaxed text-ink/60">
        {t(mode === "desk"
          ? "用手机自助的玩家走预存余额。系统没有接入在线支付，余额只有下面几种来源："
          : "系统没有接入在线支付，玩家先预存余额，结账时从余额扣款。余额只有下面几种来源：")}
      </p>
      <div className="grid items-stretch gap-3 lg:grid-cols-[minmax(0,1.4fr)_auto_minmax(0,0.8fr)_auto_minmax(0,1fr)]">
        <ul className="grid gap-2">
          {sources.map(([Icon, title, description]) => (
            <li key={title} className="flex gap-3 rounded-lg bg-ink/[0.03] p-3 text-sm">
              <Icon className="mt-0.5 shrink-0 text-ink/50" size={16} aria-hidden="true" />
              <span>
                <strong className="block">{t(title)}</strong>
                <span className="mt-0.5 block leading-relaxed text-ink/60">{t(description)}</span>
              </span>
            </li>
          ))}
        </ul>
        <ArrowRight className="hidden self-center text-ink/25 lg:block" size={20} aria-hidden="true" />
        <div className="grid content-center gap-2 rounded-lg bg-ink/[0.03] p-3 text-sm">
          <strong>{t("玩家余额")}</strong>
          <span className="rounded-md bg-mint/10 px-3 py-2">{t("赠送余额")}</span>
          <span className="rounded-md bg-mint/20 px-3 py-2">{t("充值余额")}</span>
        </div>
        <ArrowRight className="hidden self-center text-ink/25 lg:block" size={20} aria-hidden="true" />
        <div className="grid content-center gap-2 rounded-lg bg-ink/[0.03] p-3 text-sm">
          <strong>{t("结账时")}</strong>
          <span className="leading-relaxed text-ink/70">{t("先扣赠送余额，再扣充值余额。")}</span>
          <span className="leading-relaxed text-coral">{t("余额不够：结不了账，计时继续。店员可以在「在店」页用「充值结账」现场补款。")}</span>
        </div>
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
  const go = (to: string, text: string, quiet = done) => (
    <Link className={quiet ? buttonQuiet + " px-3 py-2" : action} to={to}>
      {t(text)}
    </Link>
  );
  const content: {
    title: string;
    why?: string;
    points?: string[];
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
              {status.pricingProblem === "assets" && go(`${base}/assets`, "恢复余额资产")}
              {status.pricingProblem === "entry" && go(`${base}/settings?group=billing`, "选择入场规则")}
              {go(`${base}/pricing`, "查看计费规则", true)}
            </>
          ),
        }
      : id === "reader"
        ? {
            title: "准备前台读卡器",
            why: "前台用 HINATA 读卡器读玩家的实体卡（IC 卡或 FeliCa 卡）。在前台电脑上用桌面版 Chrome 或 Edge 打开「在店」页，点「连接读卡器」授权一次，之后会自动连接。",
            fact:
              status.reader === null
                ? "这个浏览器不支持读卡器，需要桌面版 Chrome 或 Edge。"
                : status.reader
                  ? "这台电脑的浏览器已授权读卡器。"
                  : "这台电脑的浏览器还没有授权读卡器。",
            actions: go(`${base}/live`, "打开「在店」页"),
          }
        : id === "staff"
          ? {
              title: "给前台店员开账号",
              why: "店员用自己的 MuNET 账号登录后台。要在前台收款，店员的计费权限需要设为「管理」；「只读」只能查看。",
              fact: t("成员：{count}", { count: status.members }),
              actions: go(`${base}/settings?group=members`, "邀请店员"),
            }
          : id === "identity"
            ? {
                title: "确认玩家身份与 Bot",
                why:
                  status.mode === "devices"
                    ? "开门前，平台需要确认玩家是本店玩家。"
                    : status.mode === "desk"
                      ? "前台刷卡的玩家不需要绑定；用手机自助入场的玩家需要先确认身份。"
                      : "入场前，平台需要确认玩家是谁。",
                warn: done
                  ? undefined
                  : status.botIssued
                    ? "已创建 Bot 凭据，但还没有 Bot 用它连接过。新玩家扫码后会卡在绑定身份这一步。"
                    : "当前要求绑定 Bot 身份，但店铺还没有接入 Bot。新玩家扫码后会卡在绑定身份这一步。",
                body: (
                  <IdentityStep
                    value={status.identity}
                    prompt={status.bindingPrompt}
                    shopCode={shopCode}
                    reload={reload}
                  />
                ),
              }
            : id === "prepaid"
              ? {
                  title: "准备玩家储值",
                  why: "玩家自助结账从余额扣款，余额不够就结不了账。系统没有接入在线支付，余额靠这两种方式充进去：",
                  points: [
                    "兑换码：在「资产 → 礼物」建一个充值礼物（例如花 50 元得 52 元余额），再批量生成兑换码，拿到任何渠道售卖。",
                    "店员充值：在「玩家」页直接给玩家加余额，适合线上转账后手动到账。",
                  ],
                  fact:
                    status.redeemCodes || status.fundedPlayers
                      ? [
                          status.redeemCodes ? t("可用兑换码：{count}", { count: status.redeemCodes }) : "",
                          status.fundedPlayers ? t("有余额的玩家：{count}", { count: status.fundedPlayers }) : "",
                        ].filter(Boolean).join(" · ")
                      : undefined,
                  actions: (
                    <>
                      {go(`${base}/assets?tab=gifts`, "建充值礼物")}
                      {go(`${base}/assets?tab=codes`, "生成兑换码", true)}
                      {go(`${base}/players`, "打开玩家页", true)}
                    </>
                  ),
                }
              : id === "devices"
                ? {
                    title: "添加设备并配置能力",
                    why: "设备是玩家扫码后能操作的对象：一台机台、一扇门或一张麻将桌。「能力」决定它能做什么：开关电源、刷卡投币、开门或开桌。",
                    fact: !status.devices
                      ? "还没有设备"
                      : status.unconfigured
                        ? t("{count} 台设备还没有配置能力", { count: status.unconfigured })
                        : t("已有 {count} 台设备", { count: status.devices }),
                    actions: go(
                      status.devices ? `${base}/devices` : `${base}/devices?add=1`,
                      status.devices ? "打开设备页" : "添加设备",
                    ),
                  }
                : id === "door"
                  ? {
                      title: "连接 TTLock 账号",
                      why: "开门密码由店铺的 TTLock 开放平台账号生成，没连接时开门会失败。",
                      fact: t("{count} 台设备启用了开门密码", { count: status.doorDevices }),
                      actions: go(`${base}/settings?group=devices`, done ? "查看 TTLock 设置" : "连接 TTLock"),
                    }
                  : {
                      title: "贴好二维码或 NFC，自己试一次",
                      why: "每台设备都有专属二维码，打印后贴在设备上；同一个链接也可以写进 NFC 标签（NDEF 网址记录），玩家碰一下就能打开。",
                      points: [
                        status.mode === "desk"
                          ? "在前台刷一张卡，入场后再收一次款；再用手机扫一次码，走一遍自助流程。"
                          : status.mode === "self"
                            ? "用自己的手机走一遍：登录、绑定身份、入场、操作设备、结账。"
                            : "用自己的手机走一遍：登录并操作设备。",
                      ],
                      fact:
                        status.billing && status.players
                          ? t("已有 {count} 位玩家", { count: status.players })
                          : undefined,
                      actions: (
                        <>
                          {go(`${base}/devices`, "打开设备二维码")}
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
            <span className={`text-xs font-normal ${done ? "text-mint" : "text-ink/50"}`}>
              {t(done ? "已完成" : "待完成")}
            </span>
          </h4>
          {content.why && <p className="text-sm leading-relaxed text-ink/60">{t(content.why)}</p>}
          {content.points && (
            <ul className="grid list-disc gap-1 pl-5 text-sm leading-relaxed text-ink/60">
              {content.points.map((point) => (
                <li key={point}>{t(point)}</li>
              ))}
            </ul>
          )}
          {content.fact && <p className="text-sm">{t(content.fact)}</p>}
          {content.warn && <p className="text-sm text-coral">{t(content.warn)}</p>}
          {content.body}
          {content.actions && (
            <div className="mt-1 flex flex-wrap items-center gap-2">{content.actions}</div>
          )}
        </div>
      </div>
    </li>
  );
}

function IdentityStep({
  value,
  prompt,
  shopCode,
  reload,
}: {
  value: IdentityPolicy;
  prompt: string;
  shopCode: string;
  reload: () => Promise<void>;
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
      {policy !== "web" && (
        <div className="grid gap-2 rounded-lg bg-ink/[0.03] p-3 text-sm">
          <span className="text-xs text-ink/50">{t("玩家绑定时看到的提示")}</span>
          <div className="binding-code !p-3 text-ink">
            <BindingPrompt template={prompt} code="AB23CD45" />
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-coral">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {policy !== value && (
          <button type="button" className={primary} disabled={busy} onClick={save}>
            {t(busy ? "处理中…" : "保存")}
          </button>
        )}
        {policy !== "web" && (
          <Link className={button} to={`${base}/settings?group=integrations`}>
            {t("接入 Bot 与绑定提示")}
          </Link>
        )}
        {saved && <span role="status" className="text-sm text-mint">{t("已保存")}</span>}
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
            if (event.target.checked) window.localStorage.setItem(trialKey(shopCode), "1");
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
      description: "玩家在群里绑定身份、查余额和账单；插件也可以设为只读，入场和结账都在网页或 App Clip 里完成。",
      state: status.botConnected ? "已连接" : status.botIssued ? "已创建凭据，未连接" : undefined,
      to: `${base}/settings?group=integrations`,
    },
    ...(status.mode !== "desk"
      ? [
          {
            icon: Users,
            title: "邀请店员",
            description:
              status.mode === "self"
                ? "无前台的店也可以有店员：帮玩家充值、处理问题、远程操作设备。"
                : "店员可以查看和远程操作设备。",
            state: status.members > 1 ? t("成员：{count}", { count: status.members }) : undefined,
            to: `${base}/settings?group=members`,
          },
        ]
      : []),
    ...(status.billing
      ? [
          {
            icon: Gift,
            title: "新玩家礼物",
            description: "玩家第一次建档时自动发放，例如一张满 10 减 6 的券或一点体验余额，用来拉新。",
            state: status.defaultPresent ? "已设置" : undefined,
            to: `${base}/settings?group=players`,
          },
          {
            icon: Ticket,
            title: "优惠与活动",
            description: "优惠券在结账时自动抵扣；活动礼物可以通过兑换码发放。",
            to: `${base}/assets?tab=effects`,
          },
        ]
      : []),
    ...(status.mode === "self"
      ? [
          {
            icon: CreditCard,
            title: "开启前台收银",
            description: "店里有前台时，可以让玩家刷实体卡入场、在前台现场付款。",
            to: `${base}/settings?group=billing`,
          },
        ]
      : status.mode === "devices"
        ? [
            {
              icon: Receipt,
              title: "改用 PRiSM 计费",
              description: "按时长向玩家收费，管理玩家余额和离店结账。",
              to: `${base}/settings?group=billing`,
            },
          ]
        : []),
    {
      icon: MapPin,
      title: "到店位置校验",
      description: "要求玩家在店铺范围内才能入场和操作设备，防止远程操作。",
      state: status.locationEnabled ? "已开启" : undefined,
      to: `${base}/settings?group=devices`,
    },
    {
      icon: Database,
      title: "从 prism-neo 迁移",
      description: "导入旧系统的玩家、余额和计费规则。导入的计费规则默认停用，核对后再启用。",
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
              <item.icon className="mt-0.5 shrink-0 text-ink/50" size={18} aria-hidden="true" />
              <span className="grid min-w-0 content-start gap-1">
                <strong className="text-sm">{t(item.title)}</strong>
                <span className="text-sm leading-relaxed text-ink/60">{t(item.description)}</span>
                {item.state && <span className="text-xs text-mint">{t(item.state)}</span>}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
