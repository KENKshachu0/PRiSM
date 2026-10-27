import { pricingPreview } from "./merchant/pricing-preview";
import { billTime } from "./bill-time";
import { pricingInZone } from "./merchant/pricing-clock";
import type { Pricing } from "./merchant/Pricing";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Api, api, InlineError } from "../api";
import { useI18n } from "../i18n";
import { BillingConversionWizard } from "./merchant/BillingSetup";
import { IdentityPolicyPicker } from "./merchant/IdentityPolicyPicker";
import { identityPolicy, identityPolicySettings } from "./merchant/setup-guide";
import { primary, useMerchant } from "./merchant/shared";

export type Settings = {
  cashierEnabled: boolean;
  autoRegister: boolean;
  identityBindingRequired: boolean;
  locationEnabled: boolean;
  checkinGeo: boolean;
  checkoutGeo: boolean;
  machineGeo: boolean;
  /** The resource a front-desk check-in bills through: its group's plan, or its own. */
  cashierResourceId?: string | null;
  /** The binding instructions shown to players; the line with `{code}` is the command. */
  botContact: string;
  billingConfiguration?: {
    ready: boolean;
    balanceAssetsReady: boolean;
  };
};
type EntryRule = Pick<Pricing, "id" | "name" | "kind" | "enabled" | "status">;
const availableEntryRule = (rule: EntryRule) =>
  rule.enabled && rule.status !== "archived" && rule.kind !== "time.cap";
export type ShopInfo = {
  entryPricing: Pricing[];
  pricingSchedule: {
    clientCalculation?: boolean;
    localDate: string;
    timeZone: string;
    groups: {
      id: string;
      name: string;
      kind: string;
      amount?: number;
      timeZone?: string;
      segments: {
        startLabel: string;
        endLabel: string;
        label: string;
        isClosed?: boolean;
        priceCap?: number;
        pricing?: {
          unitPrice: number;
          unitMinutes: number;
          roundGraceMinutes: number;
          priceCap: number;
        };
      }[];
    }[];
  };
  shop: Settings & {
    publicId: string;
    name: string;
    timeZone: string;
    heroUrl?: string | null;
  };
  membership: { playerId: string; identityBound: boolean } | null;
};
export type Summary = {
  player: { displayName: string };
  wallet: { assetCode: string; quantity: number }[];
  activeSession: { id: string; startedAt: string } | null;
};
export type Preview = {
  timeline?: import("@prism/core").BillTimeline;
  settlementPreview: { total: number };
  chargeItems: { id: string; label: string; amount: number }[];
  adjustments: { id: string; label: string; amount: number }[];
  wallet: { balanceBefore: number; balanceAfter: number };
};
export type History = {
  sessions: {
    sessionId: string;
    startedAt: string;
    endedAt: string | null;
    total: number | null;
    status: string;
  }[];
};
export type Assets = {
  holdings: {
    id: string;
    assetName?: string;
    assetCode: string;
    quantity: number;
    availability?: string;
  }[];
};
export const control =
  "focus-ring rounded border border-ink/15 bg-panel px-4 py-3 disabled:opacity-50";
export const panel = "rounded border border-ink/10 bg-panel p-5";
export const shopApi = (code: string, path = "") =>
  `/api/v1/shops/${encodeURIComponent(code)}${path ? `/${path}` : "?pricing=raw"}`;
export const post = (body: unknown = {}) => ({
  method: "POST",
  body: JSON.stringify(body),
});

export async function operationLocation(required: boolean) {
  if (!required) return undefined;
  if (!navigator.geolocation)
    throw new Error("当前浏览器不支持定位，请联系店员");
  const position = await new Promise<GeolocationPosition>((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(
      resolve,
      (error) => reject(error.code === error.PERMISSION_DENIED
        ? new Error("需要定位权限才能确认你在店内")
        : new InlineError("定位获取失败，请重试")),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    ),
  );
  return {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy: position.coords.accuracy,
  };
}

export function BillingSettings({
  shopCode,
  embedded = false,
  section = "billing",
}: {
  shopCode: string;
  embedded?: boolean;
  section?: "billing" | "players" | "devices" | null;
}) {
  const { t } = useI18n();
  const { shopId } = useMerchant();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [rules, setRules] = useState<EntryRule[]>([]);
  const [resources, setResources] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [savedSection, setSavedSection] = useState<typeof section>(null);
  const [errorSection, setErrorSection] = useState<typeof section>(null);
  const [converting, setConverting] = useState(false);
  const load = useCallback(async () => {
    const [s, r, m] = await Promise.all([
      api<Settings>(shopApi(shopCode, "settings")),
      api<{ pricingConfigs: EntryRule[] }>(
        shopApi(shopCode, "staff/pricing-configs"),
      ),
      shopId ? Api.machines(shopId).then((result) => result.machines).catch(() => []) : Promise.resolve([]),
    ]);
    setResources(m.map((machine) => ({ id: machine.id, name: machine.name })));
    setSettings({
      ...s,
      cashierEnabled: s.cashierEnabled ?? false,
      identityBindingRequired: s.identityBindingRequired ?? true,
    });
    setRules(r.pricingConfigs);
  }, [shopCode, shopId]);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  if (!settings)
    return section ? <p role="status">{error || t("加载中...")}</p> : null;
  const flags = {
    locationEnabled: "启用位置校验",
  } as const;
  // A shop bills wherever a resource group or resource has a plan. Without a
  // balance asset nothing can bill yet, so quick setup creates one together
  // with a full-day plan for the default group.
  const needsConversion = !settings.billingConfiguration?.balanceAssetsReady;
  return (
    <>
      <form
        style={section ? undefined : { display: "none" }}
        className={`${embedded ? "rounded-xl border border-ink/10 bg-panel p-5" : panel} grid gap-4`}
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || !section) return;
          const savingSection = section;
          setBusy(true);
          setError("");
          setSavedSection(null);
          setErrorSection(savingSection);
          try {
            const current = await api<Settings>(shopApi(shopCode, "settings"));
            const patch =
              savingSection === "billing"
                ? {
                    cashierEnabled: settings.cashierEnabled,
                    cashierResourceId: settings.cashierResourceId ?? null,
                  }
                : savingSection === "players"
                  ? {
                      identityBindingRequired: settings.identityBindingRequired,
                      autoRegister: settings.autoRegister,
                    }
                  : { locationEnabled: settings.locationEnabled };
            const result = await api<Settings>(shopApi(shopCode, "settings"), {
              method: "PUT",
              body: JSON.stringify({ ...current, ...patch }),
            });
            setSettings(previous => previous && { ...previous, billingConfiguration: result.billingConfiguration });
            setSavedSection(savingSection);
            window.dispatchEvent(new Event("prism-shop-settings"));
          } catch (e) {
            setError(e instanceof Error ? e.message : t("保存失败"));
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy} className="grid gap-4">
          <h4 className="font-semibold">
            {t(
              section === "players"
                ? "玩家如何进店"
                : section === "devices"
                  ? "位置校验"
                  : "入场与收银",
            )}
          </h4>
          {section === "billing" && needsConversion && (
            <div className="grid gap-3 rounded-lg bg-ink/5 p-4 text-sm">
              <p>{t("按时长向玩家收费，管理玩家余额和离店结账。向导会一次建好余额资产和一条全天计费方案，并设为默认资源组的方案。")}</p>
              <button
                type="button"
                className={`${primary} justify-self-start`}
                onClick={() => setConverting(true)}
              >
                {t("快速创建计费")}
              </button>
            </div>
          )}
          {section === "billing" && !needsConversion && (
            <>
              <p className="text-sm leading-relaxed text-ink/60">
                {t("给资源组或资源设置计费方案，那里就开始计费；不设置方案的资源免费使用。")}{" "}
                <Link className="underline" to={`/merchant/${encodeURIComponent(shopCode)}/resources`}>
                  {t("资源组与计费")}
                </Link>
              </p>
              <label className="grid gap-2">
                <span className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={settings.cashierEnabled}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        cashierEnabled: e.target.checked,
                      })
                    }
                  />
                  {t("启用前台收银")}
                </span>
                <span className="pl-7 text-sm leading-relaxed text-ink/60">
                  {t(
                    "默认关闭。开启后，在「在店」页面连接读卡器，使用卡片昵称档案计时并现场收款。关闭前须结清前台账单。",
                  )}
                </span>
              </label>
              {settings.cashierEnabled && (
                <label className="grid gap-2 pl-7 text-sm">
                  <span className="font-medium">{t("前台资源")}</span>
                  <select
                    className="focus-ring min-h-11 rounded-lg border border-ink/20 bg-panel px-3 py-2"
                    value={settings.cashierResourceId ?? ""}
                    onChange={(e) => setSettings({ ...settings, cashierResourceId: e.target.value || null })}
                  >
                    <option value="">{t("请选择")}</option>
                    {resources.map((resource) => (
                      <option key={resource.id} value={resource.id}>{resource.name}</option>
                    ))}
                  </select>
                  <span className="text-ink/60">
                    {t("前台刷卡入场按这个资源计费：它自己的方案，否则是它所在资源组的方案。")}
                  </span>
                </label>
              )}
            </>
          )}
          {section === "players" && (
            <IdentityPolicyPicker
              name="settings-identity-policy"
              value={identityPolicy(settings)}
              change={(policy) =>
                setSettings({ ...settings, ...identityPolicySettings(policy) })
              }
            />
          )}
          {section === "devices" && (
            <label className="grid gap-2">
              <span className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={settings.locationEnabled}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      locationEnabled: e.target.checked,
                    })
                  }
                />
                {t(flags.locationEnabled)}
              </span>
              <span className="pl-7 text-sm leading-relaxed text-ink/60">
                {t(
                  "位置校验开启后，入场、开门、开机、投币和刷卡均须在店内；离场结账须定位确认已在店外。",
                )}{" "}
                <Link className="underline" to="?group=general">
                  {t("调整店铺范围")}
                </Link>
              </span>
            </label>
          )}

          {error && errorSection === section && <p role="alert" className="text-sm text-coral">{error}</p>}
          {savedSection === section && <p role="status" className="text-sm text-mint">{t("已保存")}</p>}
          {!(section === "billing" && needsConversion) && (
            <button className={`${primary} justify-self-start`} disabled={busy}>
              {t(
                section === "players"
                  ? "保存身份设置"
                  : section === "devices"
                    ? "保存位置校验"
                    : "保存计费设置",
              )}
            </button>
          )}
        </fieldset>
      </form>
      {converting && (
        <BillingConversionWizard
          shopCode={shopCode}
          close={() => setConverting(false)}
          done={async (value) => {
            setSettings((previous) => ({
              ...value,
              autoRegister: previous?.autoRegister ?? value.autoRegister,
              identityBindingRequired:
                previous?.identityBindingRequired ??
                value.identityBindingRequired,
              locationEnabled:
                previous?.locationEnabled ?? value.locationEnabled,
            }));
            setConverting(false);
            setSavedSection("billing");
            setError("");
            const result = await api<{
              pricingConfigs: EntryRule[];
            }>(shopApi(shopCode, "staff/pricing-configs"));
            setRules(result.pricingConfigs);
          }}
        />
      )}
    </>
  );
}

export function EntryPricing({ info }: { info: ShopInfo }) {
  const { t, locale } = useI18n();
  const weekday = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    timeZone: "UTC",
  });
  const plans = useMemo(() => {
    const zone = info.shop.timeZone ?? "UTC",
      day = info.pricingSchedule.localDate;
    const displayRuleTime = (instant: string) => {
      const parts = billTime(instant, zone);
      return `${parts.date} ${parts.seconds}`;
    };
    return info.entryPricing
      .map((plan) => {
        if (
          !info.pricingSchedule.clientCalculation ||
          plan.kind === "charge.fixed"
        )
          return plan;
        const timeline = pricingPreview(plan, day, zone);
        const active = new Set(
          timeline?.segments
            .filter((segment) => !segment.isClosed)
            .map((segment) => segment.ruleId),
        );
        return {
          ...plan,
          provider: {
            ...plan.provider,
            rules: plan.provider.rules
              ?.filter(
                (rule) => rule.status !== "archived" && active.has(rule.id),
              )
              .sort((a, b) => b.priority - a.priority),
          },
        };
      })
      .filter(
        (plan) => plan.kind === "charge.fixed" || plan.provider.rules?.length,
      )
      .map((plan) =>
        pricingInZone(
          plan,
          plan.kind === "charge.fixed"
            ? "UTC"
            : (plan.provider.timeZone ?? "UTC"),
          zone,
          day,
        ),
      )
      .map((plan) => ({
        ...plan,
        provider: {
          ...plan.provider,
          rules: plan.provider.rules?.map((rule) => ({
            ...rule,
            ...(rule.dateTimeRange
              ? {
                  displayDateTimeRange: {
                    start: displayRuleTime(rule.dateTimeRange.start),
                    end: displayRuleTime(rule.dateTimeRange.end),
                  },
                }
              : {}),
          })),
        },
      }))
      .filter((plan) => plan.enabled !== false && plan.status !== "archived");
  }, [info]);
  return (
    <div className="entry-pricing">
      {plans.map((plan) => (
        <div key={plan.id} className="pricing-group">
          <h3>{plan.name}</h3>
          {plan.kind === "charge.fixed" ? (
            <p>
              {t("每次入场")} · {plan.provider.amount?.toFixed(2)}
            </p>
          ) : (
            <>
              <p className="text-xs leading-relaxed text-ink/60">
                {t("时段重叠时，按下方从上到下的顺序采用规则。")}
              </p>
              {plan.provider.rules
                ?.filter((rule) => rule.status !== "archived")
                .map((rule) => (
                  <div className="pricing-segment" key={rule.id}>
                    <span className="font-mono text-sm text-ink/60">
                      {!rule.timeRange
                        ? t("连续时段")
                        : rule.timeRange.start === rule.timeRange.end
                          ? t("全天")
                          : `${rule.timeRange.start}–${rule.timeRange.start > rule.timeRange.end ? t("次日") : ""}${rule.timeRange.end}`}
                    </span>
                    <div>
                      <strong>{rule.label}</strong>
                      {!!rule.weekdays?.length && (
                        <p className="text-xs text-ink/60">
                          {rule.weekdays
                            .map((day) =>
                              weekday.format(
                                new Date(Date.UTC(2026, 0, 4 + day)),
                              ),
                            )
                            .join(" · ")}
                        </p>
                      )}
                      {!!rule.specificDates?.length && (
                        <p className="text-xs text-ink/60">
                          {rule.specificDates.join(" · ")}
                        </p>
                      )}
                      {rule.displayDateTimeRange && (
                        <p className="text-xs text-ink/60">
                          {rule.displayDateTimeRange.start} –{" "}
                          {rule.displayDateTimeRange.end}
                        </p>
                      )}
                      <p>
                        {rule.pricing
                          ? `${rule.pricing.unitPrice.toFixed(2)} / ${rule.pricing.unitMinutes} ${t("分钟")}`
                          : `${t("合计封顶")} ${rule.priceCap?.toFixed(2)}`}
                      </p>
                      {rule.pricing && (
                        <p className="text-xs text-ink/60">
                          {[
                            // A cap of 0 leaves the period uncapped.
                            rule.pricing.priceCap > 0 && rule.pricing.priceCap < Number.MAX_SAFE_INTEGER &&
                              `${t("时段封顶")} ${rule.pricing.priceCap.toFixed(2)}`,
                            rule.pricing.roundGraceMinutes > 0 &&
                              `${t("每计费单位宽限")} ${rule.pricing.roundGraceMinutes} ${t("分钟")}`,
                          ].filter(Boolean).join(" · ")}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
            </>
          )}
        </div>
      ))}
      {plans.some((plan) => plan.kind !== "charge.fixed") && (
        <p className="text-xs leading-relaxed text-ink/50">
          {t(
            "按时段分别计费，不足一个单位向上取整，宽限内不计下一单位。封顶按规则时段累计，跨午夜的同一时段连续累计。",
          )}
        </p>
      )}
    </div>
  );
}
