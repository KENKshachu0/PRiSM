import { useCallback, useEffect, useState } from "react";
import {
  NavLink,
  Navigate,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { Plus, Store } from "lucide-react";
import { Api, api, type Shop } from "../api";
import { useI18n } from "../i18n";
import { useAuth } from "./AuthContext";
import { RequireLogin } from "./RequireLogin";
import { useScrollFade } from "./use-scroll-fade";
import { shopApi } from "./BillingPages";
import {
  MerchantContext,
  State,
  Modal,
  CopyValue,
  button,
  primary,
} from "./merchant/shared";
import { PlayerWorkspace } from "./merchant/PlayerWorkspace";
import { PricingPage } from "./merchant/Pricing";
import { AssetsPage } from "./merchant/Assets";
import { ReportsPage } from "./merchant/Reports";
import { SettingsPage } from "./merchant/Settings";
import { BillingSetupFields, defaultBillingSetup } from "./merchant/BillingSetup";
import { ResourcesPage } from "./merchant/Resources";
import { ShopForm, MembersPanel } from "./merchant/ShopDetails";
import { SetupContext, ShopGuide, useSetupStatus } from "./merchant/ShopGuide";
import type { StaffMeView } from "@prism/core";

export function MerchantPage() {
  return (
    <RequireLogin>
      <MerchantContent />
    </RequireLogin>
  );
}
function MerchantContent() {
  const { shopCode, section } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useI18n();
  const [shops, setShops] = useState<Shop[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(
    () => Api.shops().then((r) => setShops(r.shops)),
    [],
  );
  useEffect(() => {
    const refresh = () => { void load().catch((e) => setError(e.message)); };
    refresh();
    window.addEventListener("prism-shop-settings", refresh);
    return () => window.removeEventListener("prism-shop-settings", refresh);
  }, [load]);
  if (!shops) return <State error={error} />;
  const shop = shops.find((s) => s.publicId === shopCode);
  if (!shopCode && shops.length && !creating)
    return (
      <Navigate
        replace
        to={`/merchant/${shops.find((s) => s.publicId === params.get("shop"))?.publicId ?? shops[0]!.publicId}`}
      />
    );
  return (
    <section className="merchant-workspace mx-auto grid w-full max-w-6xl min-w-0 gap-6">
      {shop ? (
        <Workspace
          key={shop.id}
          shop={shop}
          shops={shops}
          section={section}
          create={() => setCreating(true)}
          reload={load}
        />
      ) : (
        <div className="mx-auto grid max-w-lg gap-5 py-16 text-center">
          <Store className="mx-auto text-mint" size={36} />
          <h1 className="text-2xl font-semibold">{t("创建你的店铺")}</h1>
          <p className="text-sm text-ink/60">
            {t("创建后，开店指引会带你一步步把资源和计费接入店里。")}
          </p>
          <button className={primary} onClick={() => setCreating(true)}>
            <Plus size={18} />
            {t("新建店铺")}
          </button>
        </div>
      )}
      {creating && (
        <Modal title="新建店铺" close={() => setCreating(false)} wide>
          <ShopWizard
            done={async (newShop) => {
              await load();
              setCreating(false);
              navigate(`/merchant/${newShop.publicId}/guide`);
            }}
          />
        </Modal>
      )}
    </section>
  );
}
function Workspace({
  shop,
  shops,
  section: requested,
  create,
  reload,
}: {
  shop: Shop;
  shops: Shop[];
  section: string | undefined;
  create: () => void;
  reload: () => Promise<void>;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const navRef = useScrollFade<HTMLElement>();
  const [state, setState] = useState<{
    cashierEnabled: boolean;
    timeZone: string;
    canWrite: boolean;
    owner: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const [info, me] = await Promise.all([
      api<{ shop: { cashierEnabled: boolean; timeZone: string } }>(
        shopApi(shop.publicId),
      ),
      api<{ staff: StaffMeView }>(
        shopApi(shop.publicId, "staff/me"),
      ),
    ]);
    setState({
      ...info.shop,
      canWrite: me.staff.canWrite,
      owner: me.staff.role === "owner",
    });
  }, [shop.publicId]);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);
  // Settings updates can change the store's operating mode without leaving the workspace.
  useEffect(() => {
    const refresh = () => {
      void load();
    };
    window.addEventListener("prism-shop-settings", refresh);
    return () => window.removeEventListener("prism-shop-settings", refresh);
  }, [load]);
  const setup = useSetupStatus(shop.publicId, shop.id, !!state?.owner);
  if (!state || !setup.loaded) return <State error={error} />;
  // A bare shop URL opens where the owner has work left, otherwise on the
  // screen used every day: who is in the shop.
  if (!requested)
    return (
      <Navigate
        replace
        to={`/merchant/${shop.publicId}/${
          setup.status && !setup.status.complete ? "guide" : "live"
        }`}
      />
    );
  // Older links and printed guides point at the page under its former name.
  if (requested === "devices")
    return <Navigate replace to={`/merchant/${shop.publicId}/resources${window.location.search}`} />;
  const section = requested;
  const tabs = [
    ...(state.owner && setup.status && (!setup.status.complete || section === "guide")
      ? [["guide", "开店指引"]]
      : []),
    ["live", "在店"],
    ["players", "玩家"],
    ["resources", "资源"],
    ["pricing", "计费"],
    ["assets", "资产"],
    ["reports", "记录"],
    ...(state.owner ? [["settings", "设置"]] : []),
  ];
  return (
    <MerchantContext.Provider
      value={{
        shopCode: shop.publicId,
        shopId: shop.id,
        canWrite: state.canWrite,
        owner: state.owner,
        timeZone: state.timeZone,
        cashierEnabled: state.cashierEnabled,
      }}
    >
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            <select
              aria-label={t("切换店铺")}
              className="focus-ring max-w-full bg-transparent pr-7 text-2xl font-semibold"
              value={shop.publicId}
              onChange={(e) => navigate(`/merchant/${e.target.value}`)}
            >
              {shops.map((s) => (
                <option value={s.publicId} key={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className={`${button} px-3`}
            aria-label={t("新建店铺")}
            onClick={create}
          >
            <Plus size={18} />
          </button>
        </div>

      </header>
      {/* The fade lives on the wrapper: a pseudo-element inside a scrolling box
          is painted at the scroll origin, so it would slide away with the tabs. */}
      <div className="scroll-fade">
        <nav
          ref={navRef}
          aria-label={t("店家导航")}
          className="flex gap-1 overflow-x-auto border-b border-ink/10"
        >
          {tabs.map(([key, label]) => (
            <NavLink
              key={key}
              to={`/merchant/${shop.publicId}/${key}`}
              aria-current={section === key ? "page" : undefined}
              className={`focus-ring whitespace-nowrap border-b-2 px-4 py-3 text-sm ${section === key ? "border-mint font-semibold text-ink" : "border-transparent text-ink/55 hover:text-ink"}`}
            >
              {t(label!)}
            </NavLink>
          ))}
        </nav>
      </div>
      <div key={section}>
        {section === "guide" && state.owner ? (
          <SetupContext.Provider value={setup}>
            <ShopGuide />
          </SetupContext.Provider>
        ) : section === "resources" ? (
          <ResourcesPage />
        ) : section === "cashier" ? (
          <CashierRedirect shopCode={shop.publicId} />
        ) : section === "live" ? (
          <PlayerWorkspace live />
        ) : section === "players" ? (
          <PlayerWorkspace />
        ) : section === "pricing" ? (
          <PricingPage />
        ) : section === "assets" ? (
          <AssetsPage />
        ) : section === "reports" ? (
          <ReportsPage />
        ) : section === "settings" && state.owner ? (
          <div className="mx-auto w-full max-w-5xl">
            <SettingsPage
              shopDetails={<section className="rounded-xl border border-ink/10 bg-panel p-5">
                <ShopForm shop={shop} onSaved={async () => { await reload(); }} />
              </section>}
              members={<StaffMembers shopId={shop.id} />}
              guide={!!setup.status}
            />
          </div>
        ) : (
          <Navigate to={`/merchant/${shop.publicId}`} replace />
        )}
      </div>
    </MerchantContext.Provider>
  );
}
function CashierRedirect({ shopCode }: { shopCode: string }) {
  const [params] = useSearchParams();
  const next = new URLSearchParams(params);
  const player = next.get("player");
  if (player) { next.set("cashierPlayer", player); next.delete("player"); }
  return <Navigate replace to={`/merchant/${encodeURIComponent(shopCode)}/live?${next}`} />;
}
function StaffMembers({ shopId }: { shopId: string }) {
  const [members, setMembers] = useState<
    Awaited<ReturnType<typeof Api.shopMembers>>["members"]
  >([]);
  const [error, setError] = useState("");
  const load = useCallback(
    () => Api.shopMembers(shopId).then((r) => setMembers(r.members)),
    [shopId],
  );
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);
  return (
    <div>
      {error && <p role="alert">{error}</p>}
      <MembersPanel shopId={shopId} members={members} onChanged={load} />
    </div>
  );
}
type OperatingMode = "devices" | "self" | "desk";
const operatingModes: [OperatingMode, string, string][] = [
  [
    "self",
    "自助计费（无前台）",
    "玩家在手机上入场计时、离店自助结账，从预存余额扣款。余额来自你售卖的兑换码或店员手动充值。适合无人值守、在线上群里运营的店。",
  ],
  [
    "desk",
    "前台收银",
    "玩家在前台刷实体卡入场，离店时在前台现场付款（微信、支付宝、现金）。也可以同时让玩家预存余额自助结账。",
  ],
  [
    "devices",
    "不使用计费",
    "只用 PRiSM 的设备功能：扫码或碰 NFC 开机、刷卡、投币、开门。收费在你自己的其它经营平台完成。以后给哪个资源组设置计费方案，哪里就开始计费。",
  ],
];
function ShopWizard({ done }: { done: (shop: Shop) => Promise<void> }) {
  const { t } = useI18n();
  const { refresh } = useAuth();
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<OperatingMode>("self");
  const billing = mode !== "devices";
  const [setup, setSetup] = useState({
    ...defaultBillingSetup,
    createBotToken: false,
    botContact: "",
    // New shops require a bound identity and let the first binding create the player.
    autoRegister: true,
  });
  const [created, setCreated] = useState<{ shop: Shop; token: string } | null>(
    null,
  );
  if (created)
    return (
      <div className="grid gap-5">
        <h3 className="font-semibold">{t("连接 Bot")}</h3>
        <p className="text-sm text-ink/60">
          {t("把下面三项填进店铺 Bot 的 PRiSM 插件配置。凭据只显示这一次。")}
        </p>
        <CopyValue label="接入凭据" value={created.token} />
        <CopyValue label="店铺编号" value={created.shop.publicId} />
        <CopyValue label="API 地址" value={window.location.origin} />
        <button className={primary} onClick={() => done(created.shop)}>
          {t("进入开店指引")}
        </button>
      </div>
    );
  const steps = billing
    ? ["经营方式", "收费标准", "店铺信息"]
    : ["经营方式", "店铺信息"];
  const finalStep = billing ? 2 : 1;
  return (
    <div className="grid gap-5">
      <ol className="flex gap-4 text-xs text-ink/50">
        {steps.map((label, i) => (
          <li
            key={label}
            className={i === step ? "font-semibold text-mint" : ""}
            aria-current={i === step ? "step" : undefined}
          >
            {i + 1} · {t(label)}
          </li>
        ))}
      </ol>
      {step === 0 ? (
        <div className="grid gap-3">
          <fieldset className="grid gap-3">
            <legend className="mb-4 text-lg font-semibold">
              {t("店里怎么收费？")}
            </legend>
            {operatingModes.map(([value, title, description]) => (
              <label
                key={value}
                className={`flex cursor-pointer gap-3 rounded-lg border p-4 ${mode === value ? "border-mint bg-mint/5" : "border-ink/15"}`}
              >
                <input
                  className="mt-1"
                  type="radio"
                  name="mode"
                  checked={mode === value}
                  onChange={() => setMode(value)}
                />
                <span>
                  <strong className="block text-sm">{t(title)}</strong>
                  <span className="mt-1 block text-sm leading-relaxed text-ink/60">
                    {t(description)}
                  </span>
                </span>
              </label>
            ))}
            <p className="text-xs leading-relaxed text-ink/50">
              {t("之后可以在「设置 → 营业与计费」里切换。")}
            </p>
          </fieldset>
          <button className={`${primary} mt-3`} onClick={() => setStep(1)}>
            {t("下一步")}
          </button>
        </div>
      ) : step === finalStep ? (
        <ShopForm
          billingSetup={billing ? { ...setup, cashierEnabled: mode === "desk" } : undefined}
          back={() => setStep(step - 1)}
          onSaved={async (shop, token) => {
            await refresh();
            if (token) setCreated({ shop, token });
            else await done(shop);
          }}
        />
      ) : (
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setStep(2);
          }}
        >
          <h3 className="font-semibold">{t("收费标准")}</h3>
          <p className="text-sm text-ink/60">
            {t("先用一条全天规则开张，之后可以在「计费」页按时段细调。")}
          </p>
          <BillingSetupFields value={setup} change={value => setSetup({ ...setup, ...value })} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={setup.createBotToken} onChange={event => setSetup({ ...setup, createBotToken: event.target.checked })} />
            {t("同时创建 Bot 接入凭据")}
          </label>
          <div className="flex justify-between gap-3">
            <button type="button" className={button} onClick={() => setStep(0)}>
              {t("上一步")}
            </button>
            <button className={primary}>{t("下一步")}</button>
          </div>
        </form>
      )}
    </div>
  );
}
