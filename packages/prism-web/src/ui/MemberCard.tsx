import { useEffect, useState } from "react";
import { BadgeCheck } from "lucide-react";
import { api, playerOperation } from "../api";
import { useI18n } from "../i18n";
import { shopApi, type MemberInfo, type MemberPlan } from "./BillingPages";
import { button, primary } from "./merchant/shared";

/**
 * The shop's membership cards, shown above the player's bill.
 *
 * Buying extends the same membership asset the checkout reads; the card's own
 * pricing effect is what discounts the bill. There is no second membership
 * state on this page.
 */
export function MemberCard({ shopCode }: { shopCode: string }) {
  const { t } = useI18n();
  const [info, setInfo] = useState<MemberInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<MemberPlan | null>(null);

  async function load() {
    try {
      setInfo(await api<MemberInfo>(shopApi(shopCode, "player/member")));
      setError("");
    } catch (e) {
      // Membership is optional; its read must not hide the bill.
      setError(e instanceof Error ? e.message : t("会员信息读取失败"));
    }
  }

  useEffect(() => {
    void load();
  }, [shopCode]);

  if (!info?.enabled) return null;
  const active = info.member?.active === true;
  const benefit = info.member?.discountPercent != null
    ? t("减免 {value}%", { value: info.member.discountPercent })
    : t("会员权益");

  async function buy(plan: MemberPlan) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await playerOperation<{ member: MemberInfo["member"] }>(
        shopApi(shopCode, "player/member/purchase"),
        { planId: plan.id },
      );
      setInfo((current) => current ? { ...current, member: result.member } : current);
      setNotice(t("会员已开通"));
      setPending(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("开通失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-mint/30 bg-mint/5 px-4 py-3" aria-label={t("会员")}>
      <div className="flex flex-wrap items-center gap-3">
        <BadgeCheck className="text-mint" size={20} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">
            {active
              ? t("会员 · {card} · {benefit}", {
                  card: info.member?.cardName ?? t("会员卡"),
                  benefit,
                })
              : t("开通会员，按会员价计费")}
          </p>
          <p className="mt-0.5 text-xs text-ink/55">
            {active && info.member?.expiresAt
              ? t("有效期至 {date}", { date: new Date(info.member.expiresAt).toLocaleDateString() })
              : t("会员在配置了会员方案的资源上按会员方案计费，会员卡优惠照常结算。")}
          </p>
        </div>
        {active ? (
          <span className="text-sm text-mint">{t("会员生效中")}</span>
        ) : (
          <div className="flex flex-wrap gap-2">
            {info.plans.map((plan) => (
              <button
                key={plan.id}
                type="button"
                className={button}
                disabled={busy}
                onClick={() => { setPending(plan); setError(""); setNotice(""); }}
              >
                {plan.name} ¥{plan.price.toFixed(2)} · {plan.durationDays}
                {t("天")}
              </button>
            ))}
          </div>
        )}
      </div>
      {pending && (
        <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-mint/20 pt-2 text-sm">
          <span>
            {t("确认用余额开通「{name}」：¥{price}，{days} 天。", {
              name: pending.name,
              price: pending.price.toFixed(2),
              days: pending.durationDays,
            })}
          </span>
          <button type="button" className={primary} disabled={busy} onClick={() => void buy(pending)}>
            {t("确认开通")}
          </button>
          <button type="button" className={button} disabled={busy} onClick={() => setPending(null)}>
            {t("取消")}
          </button>
        </div>
      )}
      {notice && <p className="mt-2 text-sm text-mint">{notice}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-coral">{error}</p>}
      {!active && info.plans.length === 0 && (
        <p className="mt-2 text-sm text-ink/55">{t("店里还没有上架会员方案。")}</p>
      )}
    </section>
  );
}
