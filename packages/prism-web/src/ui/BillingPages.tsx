import type { Pricing } from "./merchant/Pricing";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useI18n } from "../i18n";

type Settings = {
  billingEnabled: boolean;
  autoRegister: boolean;
  locationEnabled: boolean;
  checkinGeo: boolean;
  checkoutGeo: boolean;
  machineGeo: boolean;
  entryPricingIds: string[];
  botContact: string;
};
export type ShopInfo = {
  entryPricing: Pricing[];
  pricingSchedule: {
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
  shop: Settings & { publicId: string; name: string; timeZone: string };
  membership: { playerId: string } | null;
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
  `/api/v1/shops/${encodeURIComponent(code)}${path ? `/${path}` : ""}`;
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
      () => reject(new Error("未能获取定位，请授权后重试；未结消费仍在计时")),
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
}: {
  shopCode: string;
  embedded?: boolean;
}) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [rules, setRules] = useState<
    { id: string; name: string; enabled: boolean }[]
  >([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    Promise.all([
      api<Settings>(shopApi(shopCode, "settings")),
      api<{ pricingConfigs: typeof rules }>(
        shopApi(shopCode, "staff/pricing-configs"),
      ),
    ])
      .then(([s, r]) => {
        setSettings(s);
        setRules(r.pricingConfigs);
      })
      .catch((e) => setError(e.message));
  }, [shopCode]);
  if (!settings) return <p role="status">{error || t("加载中...")}</p>;
  const flags = {
    billingEnabled: "启用入场计费",
    autoRegister: "允许自动创建玩家档案",
    locationEnabled: "启用位置校验",
  } as const;
  return (
    <form
      className={`${embedded ? "rounded-xl border border-ink/10 bg-panel p-5" : panel} grid gap-4`}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        setSaved(false);
        try {
          await api(shopApi(shopCode, "settings"), {
            method: "PUT",
            body: JSON.stringify(settings),
          });
          setSaved(true);
          window.dispatchEvent(new Event("prism-shop-settings"));
        } catch (e) {
          setError(e instanceof Error ? e.message : t("保存失败"));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3 className="font-semibold">{t("入场与位置校验")}</h3>
      {!settings.billingEnabled && (
        <div className="flex flex-wrap gap-3 text-sm">
          <Link className="underline" to={`/merchant/${shopCode}/assets`}>
            {t("配置基础资产")}
          </Link>
          <Link className="underline" to={`/merchant/${shopCode}/pricing`}>
            {t("配置入场规则")}
          </Link>
        </div>
      )}
      <label className="grid gap-2">
        <span className="flex items-center gap-3"><input type="checkbox" checked={settings.billingEnabled} onChange={(e) => setSettings({ ...settings, billingEnabled: e.target.checked })} />{t(flags.billingEnabled)}</span>
      </label>
      <label className="grid gap-2">
        <span className="flex items-center gap-3"><input type="checkbox" checked={settings.autoRegister} onChange={(e) => setSettings({ ...settings, autoRegister: e.target.checked })} />{t(flags.autoRegister)}</span>
        <span className="pl-7 text-sm leading-relaxed text-ink/60">{t("开启后，验证 QQ 可创建新玩家档案；关闭后，仅可认领已有 QQ 档案。")}</span>
      </label>
      <label className="grid gap-2">
        <span className="flex items-center gap-3"><input type="checkbox" checked={settings.locationEnabled} onChange={(e) => setSettings({ ...settings, locationEnabled: e.target.checked })} />{t(flags.locationEnabled)}</span>
        <span className="pl-7 text-sm leading-relaxed text-ink/60">{t("位置校验开启后，入场、开门、开机、投币和刷卡均须在店内；离场结账须定位确认已在店外。范围使用店铺地图设置。")}</span>
      </label>

      <fieldset>
        <legend>{t("普通入场计费规则")}</legend>
        {rules
          .filter((r) => r.enabled)
          .map((rule) => (
            <label className="mt-2 flex gap-3" key={rule.id}>
              <input
                type="checkbox"
                checked={settings.entryPricingIds.includes(rule.id)}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    entryPricingIds: e.target.checked
                      ? [...settings.entryPricingIds, rule.id]
                      : settings.entryPricingIds.filter((id) => id !== rule.id),
                  })
                }
              />
              {rule.name}
            </label>
          ))}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">{t("已保存")}</p>}
      <button className={`${control} justify-self-start`} disabled={busy}>
        {t("保存设置")}
      </button>
      {!embedded && (
        <Link className="underline" to={`/merchant/${shopCode}/pricing`}>
          {t("打开计费管理")}
        </Link>
      )}
    </form>
  );
}

export function EntryPricing({ info }: { info: ShopInfo }) {
  const { t, locale } = useI18n();
  const weekday = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    timeZone: "UTC",
  });
  const plans = info.entryPricing.filter(
    (plan) => plan.enabled !== false && plan.status !== "archived",
  );
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
                          {rule.pricing.priceCap < Number.MAX_SAFE_INTEGER &&
                            `${t("时段封顶")} ${rule.pricing.priceCap.toFixed(2)}`}
                          {rule.pricing.roundGraceMinutes > 0 &&
                            ` · ${t("每计费单位宽限")} ${rule.pricing.roundGraceMinutes} ${t("分钟")}`}
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
