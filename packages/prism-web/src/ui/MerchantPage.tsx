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
  Field,
  button,
  input,
  primary,
} from "./merchant/shared";
import { PlayerWorkspace } from "./merchant/PlayerWorkspace";
import { PricingPage } from "./merchant/Pricing";
import { AssetsPage } from "./merchant/Assets";
import { ReportsPage } from "./merchant/Reports";
import { SettingsPage } from "./merchant/Settings";
import { BillingSetupFields, defaultBillingSetup } from "./merchant/BillingSetup";
import { DevicesPage } from "./merchant/Devices";
import { ShopForm, MembersPanel } from "./merchant/ShopDetails";
import type { StaffMeView } from "@prism/core";

export function MerchantPage() {
  return (
    <RequireLogin>
      <MerchantContent />
    </RequireLogin>
  );
}
function MerchantContent() {
  const { shopCode, section = "devices" } = useParams();
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
            {t("从扫码使用设备开始，也可以同时管理入场计费。")}
          </p>
          <button className={primary} onClick={() => setCreating(true)}>
            <Plus size={18} />
            {t("新建店铺")}
          </button>
        </div>
      )}
      {creating && (
        <Modal title="新建店铺" close={() => setCreating(false)}>
          <ShopWizard
            done={async (newShop) => {
              await load();
              setCreating(false);
              navigate(`/merchant/${newShop.publicId}`);
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
  section,
  create,
  reload,
}: {
  shop: Shop;
  shops: Shop[];
  section: string;
  create: () => void;
  reload: () => Promise<void>;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const navRef = useScrollFade<HTMLElement>();
  const [state, setState] = useState<{
    billingEnabled: boolean;
    cashierEnabled: boolean;
    timeZone: string;
    canWrite: boolean;
    owner: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const [info, me] = await Promise.all([
      api<{ shop: { billingEnabled: boolean; cashierEnabled: boolean; timeZone: string } }>(
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
  if (!state) return <State error={error} />;
  const tabs = [
    ["devices", "设备"],
    ...(state.billingEnabled
      ? [
          ["live", "在店"],
          ["players", "玩家"],
          ["pricing", "计费"],
          ["assets", "资产"],
          ["reports", "记录"],
        ]
      : []),
    ...(!state.billingEnabled &&
    state.owner &&
    ["pricing", "assets"].includes(section)
      ? [[section, section === "pricing" ? "计费" : "资产"]]
      : []),
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
        billingEnabled: state.billingEnabled,
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
        {section === "devices" ? (
          <DevicesPage />
        ) : state.billingEnabled && section === "cashier" ? (
          <CashierRedirect shopCode={shop.publicId} />
        ) : state.billingEnabled && section === "live" ? (
          <PlayerWorkspace live />
        ) : state.billingEnabled && section === "players" ? (
          <PlayerWorkspace />
        ) : (state.billingEnabled || state.owner) && section === "pricing" ? (
          <PricingPage />
        ) : (state.billingEnabled || state.owner) && section === "assets" ? (
          <AssetsPage />
        ) : state.billingEnabled && section === "reports" ? (
          <ReportsPage />
        ) : section === "settings" && state.owner ? (
          <div className="mx-auto w-full max-w-5xl">
            <SettingsPage
              shopDetails={<section className="rounded-xl border border-ink/10 bg-panel p-5">
                <ShopForm shop={shop} onSaved={async () => { await reload(); }} />
              </section>}
              members={<StaffMembers shopId={shop.id} />}
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
function ShopWizard({ done }: { done: (shop: Shop) => Promise<void> }) {
  const { t } = useI18n();
  const { refresh } = useAuth();
  const [step, setStep] = useState(0);
  const [billing, setBilling] = useState(false);
  const [setup, setSetup] = useState({
    ...defaultBillingSetup,
    createBotToken: false,
    botContact: "",
    autoRegister: false,
  });
  const [created, setCreated] = useState<{ shop: Shop; token: string } | null>(
    null,
  );
  if (created)
    return (
      <div className="grid gap-5">
        <h3 className="font-semibold">{t("连接 Bot")}</h3>
        <p className="text-sm text-ink/60">
          {t(
            "基础资产与入场规则已创建。将以下凭据填入店铺 Bot 后，玩家即可绑定平台身份。凭据仅显示一次。",
          )}
        </p>
        <code className="select-all break-all rounded bg-ink/5 p-3 text-sm">
          {created.token}
        </code>
        <p className="break-all text-sm">
          {window.location.origin}/api/v1/shops/{created.shop.publicId}
        </p>
        <button className={primary} onClick={() => done(created.shop)}>
          {t("进入工作台")}
        </button>
      </div>
    );
  const steps = billing
    ? ["经营方式", "基础计费", "店铺信息"]
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
              {t("是否使用入场计费？")}
            </legend>
            {[
              [false, "仅使用设备", "扫码开机、投币、刷卡或开门。"],
              [
                true,
                "设备与入场计费",
                "同时管理玩家余额、计费规则与离店结账。",
              ],
            ].map(([value, title, description]) => (
              <label
                key={String(value)}
                className={`flex cursor-pointer gap-3 rounded-lg border p-4 ${billing === value ? "border-mint bg-mint/5" : "border-ink/15"}`}
              >
                <input
                  className="mt-1"
                  type="radio"
                  name="mode"
                  checked={billing === value}
                  onChange={() => setBilling(value as boolean)}
                />
                <span>
                  <strong className="block text-sm">
                    {t(title as string)}
                  </strong>
                  <span className="mt-1 block text-sm text-ink/60">
                    {t(description as string)}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <button className={`${primary} mt-3`} onClick={() => setStep(1)}>
            {t("下一步")}
          </button>
        </div>
      ) : step === finalStep ? (
        <>
          <ShopForm
            billingSetup={billing ? setup : undefined}
            onSaved={async (shop, token) => {
              await refresh();
              if (token) setCreated({ shop, token });
              else await done(shop);
            }}
          />
          <button className={button} onClick={() => setStep(step - 1)}>
            {t("上一步")}
          </button>
        </>
      ) : (
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setStep(2);
          }}
        >
          <h3 className="font-semibold">{t("基础资产与计费")}</h3>
          <BillingSetupFields value={setup} change={value => setSetup({ ...setup, ...value })} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={setup.createBotToken} onChange={event => setSetup({ ...setup, createBotToken: event.target.checked })} />
            {t("创建 Bot 接入凭据（可选）")}
          </label>
          <p className="text-sm text-ink/60">{t("无需创建 Bot 凭据；需要连接 Bot 时，可在「接入凭据」单独配置。")}</p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={setup.autoRegister}
              onChange={(e) =>
                setSetup({ ...setup, autoRegister: e.target.checked })
              }
            />
            {t("平台身份验证后允许新玩家注册")}
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
