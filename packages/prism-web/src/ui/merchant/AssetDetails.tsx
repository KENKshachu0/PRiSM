import type { ReactNode } from "react";
import { useI18n } from "../../i18n";
import { displayDateTime } from "../bill-time";
import { money, useMerchant, useResource, type Asset } from "./shared";
import type { Pricing } from "./Pricing";
import type { Effect, Grant, Present, RedeemCode } from "./asset-types";

type Translate = ReturnType<typeof useI18n>["t"];
type Window = {
  activeAt?: string | null;
  expiresAt?: string | null;
  status?: string;
};

export function assetTypeName(type: string, t: Translate): string {
  return t(
    (
      {
        currency: "余额",
        coupon: "优惠券",
        pass: "通行证",
        ticket: "票券",
      } as Record<string, string>
    )[type] ?? type,
  );
}

export function availabilityLabel(item: Window, t: Translate): string {
  if (item.status === "archived") return t("已归档");
  if (item.expiresAt && Date.parse(item.expiresAt) <= Date.now())
    return t("已过期");
  if (item.activeAt && Date.parse(item.activeAt) > Date.now())
    return t("未生效");
  return t("有效期内");
}

export function effectSummary(effect: Effect, t: Translate): string {
  if (effect.type === "free") return t("免费");
  if (effect.type === "percentage-discount")
    return t("减免 {value}%", { value: effect.value ?? 0 });
  if (effect.type === "discount")
    return t("减免 {value}", { value: money(effect.value ?? 0) });
  if (effect.type === "surcharge")
    return t("加收 {value}", { value: money(effect.value ?? 0) });
  return effect.type;
}

export function DetailRows({ rows }: { rows: [string, ReactNode][] }) {
  const { t } = useI18n();
  return (
    <dl className="grid gap-3 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
          <dt className="text-ink/60">{t(label)}</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Validity({ item }: { item: Window }) {
  const { t } = useI18n();
  const { timeZone } = useMerchant();
  return (
    <DetailRows
      rows={[
        ["状态", availabilityLabel(item, t)],
        [
          "生效时间",
          item.activeAt
            ? displayDateTime(item.activeAt, timeZone)
            : t("立即生效"),
        ],
        [
          "到期时间",
          item.expiresAt
            ? displayDateTime(item.expiresAt, timeZone)
            : t("永久有效"),
        ],
      ]}
    />
  );
}

function ExtraInfo({
  value,
}: {
  value: Record<string, unknown> | null | undefined;
}) {
  const { t } = useI18n();
  if (!value || !Object.keys(value).length) return null;
  return (
    <details className="rounded-lg border border-ink/10 p-3 text-sm">
      <summary className="cursor-pointer font-medium">
        {t("其他保存信息")}
      </summary>
      <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <section className="grid gap-3 border-t border-ink/10 pt-4">
      <h3 className="font-semibold">{t(title)}</h3>
      {children}
    </section>
  );
}

export function AssetDetails({
  asset,
  effects,
}: {
  asset: Asset;
  effects: Effect[];
}) {
  const { t } = useI18n();
  const effect =
    effects.find((e) => e.id === asset.pricingEffectId) ?? asset.pricingEffect;
  const { description, hiddenFromPlayer, system } = asset.metadata ?? {};
  return (
    <div className="grid gap-5">
      <DetailRows
        rows={[
          ["名称", asset.name],
          ["类型", assetTypeName(asset.type, t)],
          ["资产编号", asset.code],
          ["数量可叠加", t(asset.stackable ? "是" : "否")],
          ["玩家可见", t(hiddenFromPlayer === true ? "否" : "是")],
          ["系统资产", t(system === true ? "是" : "否")],
          ...(typeof description === "string"
            ? [["说明", description] as [string, ReactNode]]
            : []),
        ]}
      />
      <Validity item={asset} />
      <Section title="关联优惠">
        {effect ? (
          <EffectDetails effect={effect} />
        ) : (
          <p className="text-sm text-ink/60">
            {asset.pricingEffectId
              ? t("未找到关联记录（{id}）", { id: asset.pricingEffectId })
              : t("无")}
          </p>
        )}
      </Section>
      <ExtraInfo value={asset.metadata} />
    </div>
  );
}

export function EffectDetails({ effect }: { effect: Effect }) {
  const { t } = useI18n();
  const pricing = useResource<{ pricingConfigs: Pricing[] }>("pricing-configs");
  const config = effect.config ?? {};
  const {
    minSubtotal,
    startDate,
    endDate,
    daysOfWeek,
    applicableSessionLabels,
    applicablePricingConfigIds,
    applicableRuleIds,
  } = config;
  const names = (ids: unknown, rule = false) => {
    if (!Array.isArray(ids) || !ids.length) return t("不限");
    return ids
      .map((id) => {
        if (rule) {
          const matches = pricing.data?.pricingConfigs.flatMap(
            (p) =>
              p.provider.rules
                ?.filter((r) => r.id === id)
                .map((r) => `${p.name} · ${r.label}`) ?? [],
          );
          return matches?.length ? matches.join(" / ") : String(id);
        }
        return (
          pricing.data?.pricingConfigs.find((p) => p.id === id)?.name ??
          String(id)
        );
      })
      .join("、");
  };
  const weekdays = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  return (
    <div className="grid gap-4">
      <DetailRows
        rows={[
          ["名称", effect.name],
          ["优惠编号", effect.id],
          ["优惠方式", effectSummary(effect, t)],
          ["范围", t(effect.scope === "session" ? "单项消费" : "整笔账单")],
          ["使用后扣除", t(effect.consumable ? "是" : "否")],
          [
            "每日使用上限",
            effect.limitPerDay == null ? t("不限") : effect.limitPerDay,
          ],
        ]}
      />
      <Validity item={effect} />
      <Section title="使用条件">
        <DetailRows
          rows={[
            [
              "最低消费",
              typeof minSubtotal === "number" ? money(minSubtotal) : t("不限"),
            ],
            [
              "适用计时",
              Array.isArray(applicableSessionLabels) &&
              applicableSessionLabels.length
                ? applicableSessionLabels.join("、")
                : t("不限"),
            ],
            ["适用方案", names(applicablePricingConfigIds)],
            ["适用规则", names(applicableRuleIds, true)],
            [
              "适用日期（UTC）",
              `${typeof startDate === "string" ? startDate : t("不限")} – ${typeof endDate === "string" ? endDate : t("不限")}`,
            ],
            [
              "适用星期（UTC）",
              Array.isArray(daysOfWeek) && daysOfWeek.length
                ? daysOfWeek
                    .map((day) => t(weekdays[Number(day)] ?? String(day)))
                    .join("、")
                : t("不限"),
            ],
          ]}
        />
        {pricing.error && (
          <p className="text-sm text-coral">
            {t("关联名称加载失败，已显示保存的编号")}
          </p>
        )}
      </Section>
      <ExtraInfo value={effect.config} />
    </div>
  );
}

function GrantDetails({ grant, assets }: { grant: Grant; assets: Asset[] }) {
  const { t } = useI18n();
  const asset = assets.find(
    (a) => a.type === grant.assetType && a.code === grant.assetCode,
  );
  const strategies: Record<string, string> = {
    stack: "叠加数量",
    "extend-time": "延长有效期",
    replace: "替换持有",
  };
  return (
    <div className="grid gap-3 rounded-lg border border-ink/10 p-4">
      <DetailRows
        rows={[
          ["资产", asset?.name ?? grant.assetCode],
          ["类型", assetTypeName(grant.assetType, t)],
          ["资产编号", grant.assetCode],
          ["数量", grant.amount],
          [
            "合并方式",
            t(strategies[grant.mergeStrategy] ?? grant.mergeStrategy),
          ],
          ...(grant.durationMs !== undefined
            ? [
                [
                  "延长时长",
                  t("{minutes} 分钟", { minutes: grant.durationMs / 60_000 }),
                ] as [string, ReactNode],
              ]
            : []),
          [
            "每位玩家限领次数",
            grant.maxPerPlayer === undefined ? t("不限") : grant.maxPerPlayer,
          ],
        ]}
      />
      <Validity item={grant} />
    </div>
  );
}

export function PresentDetails({
  present,
  assets,
}: {
  present: Present;
  assets: Asset[];
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-5">
      <DetailRows
        rows={[
          ["名称", present.name],
          ["礼物编号", present.id],
          ["每位玩家仅限一次", t(present.oncePerPlayer ? "是" : "否")],
        ]}
      />
      <Validity item={present} />
      <Section title="发放内容">
        {present.grants.map((grant, index) => (
          <GrantDetails key={index} grant={grant} assets={assets} />
        ))}
      </Section>
    </div>
  );
}

export function RedeemCodeDetails({
  code,
  presents,
  assets,
}: {
  code: RedeemCode;
  presents: Present[];
  assets: Asset[];
}) {
  const { t } = useI18n();
  const { timeZone } = useMerchant();
  const present = presents.find((p) => p.id === code.presentId);
  return (
    <div className="grid gap-5">
      <DetailRows
        rows={[
          ["兑换码", <code className="select-all">{code.code}</code>],
          ["兑换码编号", code.id],
          ["使用次数", `${code.usageCount} / ${code.maxUseCount}`],
          ["剩余次数", Math.max(0, code.maxUseCount - code.usageCount)],
        ]}
      />
      <Validity item={code} />
      <Section title="礼物">
        {present ? (
          <PresentDetails present={present} assets={assets} />
        ) : (
          <p className="text-sm">
            {t("未找到关联记录（{id}）", { id: code.presentId })}
          </p>
        )}
      </Section>
      <Section title="兑换记录">
        {code.redemptions?.length ? (
          code.redemptions.map((r, i) => (
            <p key={i} className="text-sm">
              {r.playerDisplayName} · {displayDateTime(r.redeemedAt, timeZone)}
            </p>
          ))
        ) : (
          <p className="text-sm text-ink/60">{t("暂无兑换记录")}</p>
        )}
      </Section>
    </div>
  );
}
