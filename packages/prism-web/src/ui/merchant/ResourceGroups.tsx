import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Api, api, type ResourceGroup } from "../../api";
import { useI18n } from "../../i18n";
import { Field, buttonQuiet, input, primary, useMerchant } from "./shared";

type BillablePlan = { id: string; name: string; kind: string; status: string; enabled: boolean };

/**
 * The shop's plans a group or a resource may bill: those a session can run, a
 * time plan or a fixed charge billed once per session.
 */
export function useBillablePlans(shopCode: string) {
  const [plans, setPlans] = useState<BillablePlan[]>([]);
  useEffect(() => {
    api<{ pricingConfigs: BillablePlan[] }>(`/api/v1/shops/${encodeURIComponent(shopCode)}/staff/pricing-configs`)
      .then((r) => setPlans(r.pricingConfigs.filter((plan) => (plan.kind === "time.priority" || plan.kind === "charge.fixed") && plan.status !== "archived")))
      .catch(() => setPlans([]));
  }, [shopCode]);
  return plans;
}

/**
 * The shop's resource groups. If they cannot be read, every resource is shown
 * in the default group, as it bills without other groups, and `error` says so.
 */
export function useResourceGroups(shopId: string) {
  const [groups, setGroups] = useState<ResourceGroup[] | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(
    () => Api.resourceGroups(shopId)
      .then((r) => { setGroups(r.resourceGroups); setError(""); })
      .catch((e: unknown) => {
        setGroups([{ id: "default", name: "默认资源组", enabled: true, isDefault: true, defaultPricingConfigId: null, resourceCount: 0 }]);
        setError(e instanceof Error ? e.message : "资源组读取失败");
      }),
    [shopId],
  );
  useEffect(() => { void reload(); }, [reload]);
  return { groups, error, reload };
}

/**
 * One resource group: its name, the plan its resources bill, and whether it
 * is in use. The default group is edited like any other; it only cannot be
 * deleted, because resources without a group of their own are in it.
 */
export function ResourceGroupEditor({ group, done }: { group?: ResourceGroup; done: () => void }) {
  const { t } = useI18n();
  const { shopId, shopCode } = useMerchant();
  const plans = useBillablePlans(shopCode);
  const [name, setName] = useState(group?.name ?? "");
  const [planId, setPlanId] = useState(group?.defaultPricingConfigId ?? "");
  const [enabled, setEnabled] = useState(group?.enabled ?? true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      done();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() =>
          group
            ? Api.updateResourceGroup(group.id, {
                shopId,
                name: name.trim(),
                enabled,
                defaultPricingConfigId: planId || null,
              })
            : Api.createResourceGroup({ shopId, name: name.trim(), defaultPricingConfigId: planId || null }),
        );
      }}
    >
      <Field label="名称">
        <input
          className={input}
          maxLength={40}
          required
          placeholder={t("例如：休息区、麻将包间")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="计费方案">
        <select className={input} value={planId} onChange={(e) => setPlanId(e.target.value)}>
          <option value="">{t("不计费")}</option>
          {plans.map((plan) => (
            <option key={plan.id} value={plan.id}>
              {plan.name}{plan.enabled ? "" : ` (${t("已停用")})`}
            </option>
          ))}
        </select>
      </Field>
      {group && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t("启用")}
        </label>
      )}
      {error && <p role="alert" className="text-sm text-coral">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={primary} disabled={busy || !name.trim()}>
          {t(group ? "保存" : "添加资源组")}
        </button>
        {group && !group.isDefault && (
          <button
            type="button"
            className={`${buttonQuiet} ml-auto`}
            disabled={busy || group.resourceCount > 0}
            title={group.resourceCount > 0 ? t("请先把组内资源移到其他资源组") : undefined}
            onClick={() => void run(() => Api.deleteResourceGroup(shopId, group.id))}
          >
            <Trash2 size={15} aria-hidden="true" />
            {t("删除资源组")}
          </button>
        )}
      </div>
    </form>
  );
}
