import { useState } from "react";
import { Plus, RotateCcw, Archive, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { useI18n } from "../../i18n";
import {
  Field,
  Modal,
  State,
  button,
  buttonQuiet,
  input,
  money,
  primary,
  segment,
  useMerchant,
  useResource,
  useStaffApi,
  type Asset,
} from "./shared";

type Plan = {
  id: string;
  name: string;
  /** The membership asset definition this plan grants. */
  assetCode: string;
  /** Yuan, as the staff API reports it. */
  price: number;
  durationDays: number;
  status: "active" | "archived";
};

type Program = {
  enabled: boolean;
  plans: Plan[];
};

function effectLabel(asset: Asset | undefined, t: (text: string, values?: Record<string, string | number>) => string): string {
  const effect = asset?.pricingEffect;
  if (!effect) return t("无折扣");
  if (effect.type === "free") return t("免单");
  if (effect.type === "percentage-discount") return t("减免 {value}%", { value: effect.value ?? 0 });
  if (effect.type === "discount") return t("减免 {value}", { value: money(effect.value ?? 0) });
  if (effect.type === "surcharge") return t("加收 {value}", { value: money(effect.value ?? 0) });
  return effect.type;
}

/**
 * Membership cards are ordinary membership assets created on the Assets page;
 * this page only enables the programme and sells durations of those cards.
 */
export function MemberPage() {
  const { t } = useI18n();
  const { canWrite, shopCode } = useMerchant();
  const request = useStaffApi();
  const program = useResource<Program>("member");
  const definitions = useResource<{ assetDefinitions: Asset[] }>("asset-definitions");
  const [editing, setEditing] = useState<Plan | "new" | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!program.data) return <State error={program.error} />;
  const data = program.data;
  const currentEnabled = enabled ?? data.enabled;
  const cards = (definitions.data?.assetDefinitions ?? []).filter(
    (asset) => asset.type === "membership" && asset.status !== "archived",
  );
  const cardByCode = new Map(cards.map((card) => [card.code, card]));

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await program.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6">
      <section className="rounded-xl border border-ink/10 bg-panel p-5">
        <h2 className="text-lg font-semibold">{t("会员")}</h2>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink/60">
          {t("会员卡是资产页里的一种物品；卡片绑定的优惠就是会员折扣。这里负责启用会员并按方案售卖会员卡的时长。")}
        </p>
        <div className="mt-4 grid max-w-xl gap-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={currentEnabled}
              disabled={!canWrite || busy}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t("启用会员体系")}
          </label>
          <p className="text-xs text-ink/50">
            {t("启用后，会员在配置了会员方案的资源上按会员方案计费，会员卡优惠照常结算。")}
          </p>
          {canWrite && (
            <div>
              <button
                type="button"
                className={primary}
                disabled={busy}
                onClick={() => void run(() => request("member", "PUT", {
                  enabled: currentEnabled,
                }))}
              >
                {t("保存会员设置")}
              </button>
            </div>
          )}
          {error && <p role="alert" className="text-sm text-coral">{error}</p>}
        </div>
      </section>

      <section className="rounded-xl border border-ink/10 bg-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">{t("会员卡")}</h3>
            <p className="mt-1 text-sm text-ink/55">
              {t("在资产页创建会员卡，并给它绑定一个优惠；折扣力度由那张卡决定。")}
            </p>
          </div>
          <Link className={button} to={`/merchant/${segment(shopCode)}/assets?tab=assets`}>
            <ExternalLink size={16} aria-hidden="true" />
            {t("去资产页管理会员卡")}
          </Link>
        </div>
        {cards.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink/55">
            {t("还没有会员卡。先在资产页新建一个「会员卡」，再回来添加售卖方案。")}
          </p>
        ) : (
          <div className="mt-4 grid gap-2">
            {cards.map((card) => (
              <div key={card.code} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ink/10 px-4 py-3 text-sm">
                <span className="font-medium">{card.name}</span>
                <span className="text-ink/60">{effectLabel(card, t)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-ink/10 bg-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">{t("会员方案")}</h3>
            <p className="mt-1 text-sm text-ink/55">
              {t("同一张会员卡可以按月、季、年拆成多个价格方案，续费从当前到期日顺延。")}
            </p>
          </div>
          {canWrite && (
            <button type="button" className={primary} disabled={!cards.length} onClick={() => setEditing("new")}>
              <Plus size={16} aria-hidden="true" />
              {t("添加方案")}
            </button>
          )}
        </div>
        {data.plans.length === 0 ? (
          <p className="py-10 text-center text-sm text-ink/55">{t("还没有会员方案")}</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="border-b border-ink/10 text-xs text-ink/55">
                <tr>
                  <th className="px-2 py-2 font-medium">{t("名称")}</th>
                  <th className="px-2 py-2 font-medium">{t("会员卡")}</th>
                  <th className="px-2 py-2 font-medium">{t("价格")}</th>
                  <th className="px-2 py-2 font-medium">{t("时长")}</th>
                  <th className="px-2 py-2 font-medium">{t("状态")}</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {data.plans.map((plan) => (
                  <tr key={plan.id} className="border-b border-ink/5 last:border-0">
                    <td className="px-2 py-3 font-medium">{plan.name}</td>
                    <td className="px-2 py-3 text-ink/65">
                      {cardByCode.get(plan.assetCode)?.name ?? plan.assetCode}
                    </td>
                    <td className="px-2 py-3 tabular-nums">¥{money(plan.price)}</td>
                    <td className="px-2 py-3 tabular-nums">{plan.durationDays} {t("天")}</td>
                    <td className="px-2 py-3 text-ink/60">
                      {plan.status === "archived" ? t("已下架") : t("在售")}
                    </td>
                    <td className="px-2 py-3">
                      {canWrite && (
                        <div className="flex justify-end gap-1">
                          <button type="button" className={buttonQuiet} onClick={() => setEditing(plan)}>
                            {t("编辑")}
                          </button>
                          <button
                            type="button"
                            className={buttonQuiet}
                            disabled={busy}
                            onClick={() => void run(() => request(
                              `member/plans/${encodeURIComponent(plan.id)}/${plan.status === "archived" ? "restore" : "archive"}`,
                              "POST",
                              {},
                            ))}
                          >
                            {plan.status === "archived" ? <RotateCcw size={14} /> : <Archive size={14} />}
                            {plan.status === "archived" ? t("重新上架") : t("下架")}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && (
        <PlanForm
          plan={editing === "new" ? null : editing}
          cards={cards}
          close={() => setEditing(null)}
          done={() => void program.reload()}
        />
      )}
    </div>
  );
}

function PlanForm({
  plan,
  cards,
  close,
  done,
}: {
  plan: Plan | null;
  cards: Asset[];
  close: () => void;
  done: () => void;
}) {
  const { t } = useI18n();
  const request = useStaffApi();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={plan ? "编辑会员方案" : "添加会员方案"} close={close}>
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          setBusy(true);
          setError("");
          const body = {
            ...(plan ? {} : { id: crypto.randomUUID() }),
            name: String(form.get("name") ?? "").trim(),
            assetCode: String(form.get("assetCode") ?? ""),
            price: Number(form.get("price")),
            durationDays: Number(form.get("durationDays")),
          };
          const requestPlan = plan
            ? request(`member/plans/${encodeURIComponent(plan.id)}`, "PUT", body)
            : request("member/plans", "POST", body);
          void requestPlan.then(() => { done(); close(); })
            .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
            .finally(() => setBusy(false));
        }}
      >
        <Field label="名称">
          <input className={input} name="name" required maxLength={40} defaultValue={plan?.name ?? ""} placeholder={t("例如：月卡")} />
        </Field>
        <Field label="会员卡">
          <select className={input} name="assetCode" required defaultValue={plan?.assetCode ?? cards[0]?.code ?? ""}>
            {cards.map((card) => (
              <option key={card.code} value={card.code}>
                {card.name} · {effectLabel(card, t)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="价格" unit="元">
          <input className={input} name="price" type="number" min="0" step="0.01" required defaultValue={plan?.price ?? 0} />
        </Field>
        <Field label="时长" unit="天">
          <input className={input} name="durationDays" type="number" min="1" max="3650" step="1" required defaultValue={plan?.durationDays ?? 30} />
        </Field>
        {error && <p role="alert" className="text-sm text-coral">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={button} onClick={close} disabled={busy}>{t("取消")}</button>
          <button type="submit" className={primary} disabled={busy}>{t("保存")}</button>
        </div>
      </form>
    </Modal>
  );
}
