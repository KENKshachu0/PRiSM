import { PricingRing } from "./PricingRing";
import { BillingSimulator } from "./BillingSimulator";
import { pricingInZone } from "./pricing-clock";
import { billTime } from "../bill-time";
import { useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { useI18n } from "../../i18n";
import {
  ActionForm,
  Field,
  Modal,
  State,
  Table,
  button,
  buttonQuiet,
  cell,
  input,
  money,
  primary,
  segment,
  useMerchant,
  useResource,
  useStaffApi,
} from "./shared";

type Unit = {
  unitMinutes: number;
  unitPrice: number;
  roundGraceMinutes: number;
  priceCap: number;
};
type Rule = {
  id: string;
  label: string;
  priority: number;
  status?: string;
  weekdays?: number[];
  specificDates?: string[];
  timeRange?: { start: string; end: string };
  dateTimeRange?: { start: string; end: string };
  displayDateTimeRange?: { start: string; end: string };
  pricing?: Unit;
  priceCap?: number;
};
export type Pricing = {
  id: string;
  kind: "time.priority" | "time.cap" | "charge.fixed";
  name: string;
  enabled: boolean;
  status: string;
  provider: {
    id: string;
    label?: string;
    amount?: number;
    timeZone?: string;
    rules?: Rule[];
    includedPricingConfigIds?: string[];
  };
};
const kinds = {
  "time.priority": "按时计费",
  "charge.fixed": "固定收费",
  "time.cap": "消费封顶",
};
const newRule = (): Rule => ({
  id: crypto.randomUUID(),
  label: "",
  priority: 0,
  timeRange: { start: "00:00", end: "00:00" },
  pricing: {
    unitMinutes: 60,
    unitPrice: 10,
    roundGraceMinutes: 0,
    priceCap: 0,
  },
  priceCap: 0,
});

export function PricingPage() {
  const { t } = useI18n();
  const { canWrite } = useMerchant();
  const resource = useResource<{ pricingConfigs: Pricing[] }>(
    "pricing-configs",
  );
  const request = useStaffApi();
  const [edit, setEdit] = useState<Pricing | null>(null);
  const [archive, setArchive] = useState<Pricing | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showSimulator, setShowSimulator] = useState(false);
  const rows = resource.data?.pricingConfigs.filter(
    (row) => showArchived || row.status !== "archived",
  );
  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold">{t("计费规则")}</h2>
        {canWrite && (
          <button
            className={primary}
            onClick={() =>
              setEdit({
                id: "",
                kind: "time.priority",
                name: "",
                enabled: true,
                status: "active",
                provider: { id: crypto.randomUUID(), rules: [newRule()] },
              })
            }
          >
            <Plus size={16} />
            {t("添加规则")}
          </button>
        )}
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          {t("显示已归档")}
        </label>
        {canWrite && (
          <button
            type="button"
            className={button}
            aria-expanded={showSimulator}
            onClick={() => setShowSimulator((value) => !value)}
          >
            {t("计费模拟器")}
            <ChevronDown
              size={15}
              className={showSimulator ? "rotate-180" : ""}
              aria-hidden="true"
            />
          </button>
        )}
      </div>
      {showSimulator && resource.data && (
        <BillingSimulator pricingConfigs={resource.data.pricingConfigs} />
      )}
      {!rows ? (
        <State error={resource.error} />
      ) : !rows.length ? (
        <div className="rounded-xl border border-dashed border-ink/20 px-6 py-14 text-center">
          <p className="font-medium">{t("还没有计费规则")}</p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-ink/55">
            {t("入场计费需要至少一条按时计费的规则。")}
          </p>
          {canWrite && (
            <button
              className={`${primary} mt-5`}
              onClick={() =>
                setEdit({
                  id: "",
                  kind: "time.priority",
                  name: "",
                  enabled: true,
                  status: "active",
                  provider: { id: crypto.randomUUID(), rules: [newRule()] },
                })
              }
            >
              <Plus size={16} />
              {t("添加规则")}
            </button>
          )}
        </div>
      ) : (
        <Table headers={["名称", "计费方式", "时段", "状态", "操作"]}>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className={`${cell} font-medium`}>{row.name}</td>
              <td className={cell}>
                {t(kinds[row.kind])}
                {row.kind === "charge.fixed" && (
                  <span className="ml-2">{money(row.provider.amount)}</span>
                )}
              </td>
              <td className={`${cell} text-ink/60`}>
                {row.kind === "charge.fixed"
                  ? t("单次收取")
                  : t("{count} 个时段", {
                      count: row.provider.rules?.length ?? 0,
                    })}
              </td>
              <td className={cell}>
                {/* Enabled state decides whether the rule bills anyone, so it
                    is a pill with a dot rather than plain grey text. */}
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                    row.status === "archived"
                      ? "bg-ink/5 text-ink/50"
                      : row.enabled
                        ? "bg-mint/12 text-mint"
                        : "bg-coral/10 text-coral"
                  }`}
                >
                  <span
                    className={`size-1.5 rounded-full ${
                      row.status === "archived"
                        ? "bg-ink/30"
                        : row.enabled
                          ? "bg-mint"
                          : "bg-coral"
                    }`}
                    aria-hidden="true"
                  />
                  {t(
                    row.status === "archived"
                      ? "已归档"
                      : row.enabled
                        ? "启用"
                        : "停用",
                  )}
                </span>
              </td>
              <td className={cell}>
                {canWrite && (
                  <div className="flex gap-2">
                    <button
                      className={button}
                      onClick={() => setEdit(structuredClone(row))}
                    >
                      {t("编辑")}
                    </button>
                    <button className={button} onClick={() => setArchive(row)}>
                      {t(row.status === "archived" ? "恢复" : "归档")}
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {edit && (
        <Modal
          title={edit.id ? "编辑规则" : "添加规则"}
          close={() => setEdit(null)}
          xl
        >
          <PricingEditor
            value={edit}
            all={resource.data?.pricingConfigs ?? []}
            done={() => {
              setEdit(null);
              resource.reload();
            }}
          />
        </Modal>
      )}
      {archive && (
        <Modal
          title={archive.status === "archived" ? "恢复规则" : "归档规则"}
          close={() => setArchive(null)}
        >
          <ActionForm
            label="确认"
            done={() => {
              setArchive(null);
              resource.reload();
            }}
            submit={() =>
              request(
                `pricing-configs/${segment(archive.id)}/${archive.status === "archived" ? "restore" : "archive"}`,
                "POST",
                {},
              )
            }
          >
            <p>{archive.name}</p>
          </ActionForm>
        </Modal>
      )}
    </div>
  );
}

/** The one line a collapsed period shows, so its settings stay readable. */
function ruleSummary(rule: Rule, kind: Pricing["kind"], t: (key: string) => string) {
  const time = rule.timeRange
    ? `${rule.timeRange.start}–${rule.timeRange.end}`
    : null;
  if (kind === "time.cap")
    return [
      rule.label || t("未命名时段"),
      time,
      money(rule.priceCap ?? 0),
    ]
      .filter(Boolean)
      .join(" · ");
  const pricing = rule.pricing;
  return [
    rule.label || t("未命名时段"),
    time,
    pricing
      ? `${money(pricing.unitPrice)} / ${pricing.unitMinutes} ${t("分钟")}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function PricingEditor({
  value,
  all,
  done,
}: {
  value: Pricing;
  all: Pricing[];
  done: () => void;
}) {
  const { t } = useI18n();
  const request = useStaffApi();
  const { timeZone } = useMerchant();
  const displayTimeZone =
    timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [day, setDay] = useState(() =>
    billTime(new Date().toISOString(), displayTimeZone).date,
  );
  const [draft, setDraft] = useState(() =>
    pricingInZone(
      value,
      value.id ? (value.provider.timeZone ?? "UTC") : displayTimeZone,
      displayTimeZone,
      day,
    ),
  );
  // Periods start collapsed: a rule with four periods used to be a 2000px
  // form. Opening one at a time keeps the current period in view.
  const [openRule, setOpenRule] = useState<number | null>(null);
  const rules = draft.provider.rules ?? [];
  const changeDay = (nextDay: string) => {
    setDraft(
      pricingInZone(
        pricingInZone(draft, displayTimeZone, "UTC", day),
        "UTC",
        displayTimeZone,
        nextDay,
      ),
    );
    setDay(nextDay);
  };
  const update = (patch: Partial<Pricing>) => setDraft({ ...draft, ...patch });
  const provider = (patch: Partial<Pricing["provider"]>) =>
    update({ provider: { ...draft.provider, ...patch } });
  const changeRule = (index: number, patch: Partial<Rule>) =>
    provider({
      rules: rules.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    });
  const openPeriod = (index: number) => {
    setOpenRule(index);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document
          .querySelector(`dialog[open] [data-period="${index}"]`)
          ?.scrollIntoView({ block: "nearest" });
      });
    });
  };
  /** Returns the first reason the draft cannot be saved. */
  const firstProblem = (): { message: string; period?: number } | null => {
    if (!draft.name.trim()) return { message: t("请填写规则名称") };
    if (draft.kind === "charge.fixed") {
      if (!draft.provider.label?.trim())
        return { message: t("请填写账单名称") };
      if ((draft.provider.amount ?? 0) < 0)
        return { message: t("金额不能为负数") };
      return null;
    }
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index]!;
      if (!rule.label.trim())
        return { message: t("请填写时段名称"), period: index };
      if (draft.kind === "time.cap") {
        if (!((rule.priceCap ?? 0) > 0))
          return { message: t("封顶金额需要大于 0"), period: index };
      } else if (rule.pricing) {
        if (!(rule.pricing.unitMinutes > 0))
          return { message: t("每隔分钟数需要大于 0"), period: index };
        if (!(rule.pricing.unitPrice >= 0))
          return { message: t("收费金额不能为负数"), period: index };
      }
    }
    return null;
  };
  return (
    <ActionForm
      sticky
      noValidate
      done={done}
      submit={() => {
        const problem = firstProblem();
        if (problem) {
          // Browsers cannot focus a field in a collapsed period, so the check
          // runs here and opens the period that needs attention.
          if (problem.period !== undefined) openPeriod(problem.period);
          throw new Error(problem.message);
        }
        return request(
          `pricing-configs${draft.id ? `/${segment(draft.id)}` : ""}`,
          draft.id ? "PATCH" : "POST",
          {
            kind: draft.kind,
            name: draft.name.trim(),
            enabled: draft.enabled,
            provider: pricingInZone(draft, displayTimeZone, "UTC", day).provider,
          },
        );
      }}
    >
      <section className="grid gap-3">
        <h3 className="text-sm font-semibold">{t("基本信息")}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="名称">
            <input
              className={input}
              required
              maxLength={80}
              value={draft.name}
              onChange={(e) => update({ name: e.target.value })}
            />
          </Field>
          <Field label="计费方式">
            <select
              className={input}
              value={draft.kind}
              disabled={!!draft.id}
              onChange={(e) => {
                const kind = e.target.value as Pricing["kind"];
                update({
                  kind,
                  provider:
                    kind === "charge.fixed"
                      ? { id: draft.provider.id, label: draft.name, amount: 10 }
                      : {
                          id: draft.provider.id,
                          rules: [newRule()],
                          ...(kind === "time.cap"
                            ? { includedPricingConfigIds: [] }
                            : {}),
                        },
                });
                setOpenRule(null);
              }}
            >
              {Object.entries(kinds).map(([key, label]) => (
                <option key={key} value={key}>
                  {t(label)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {/* The switch sits next to its state, because "is this rule billing
            anyone right now" is the question this screen answers. */}
        <label className="flex items-center gap-3 rounded-lg border border-ink/10 px-3 py-2 text-sm">
          <input
            type="checkbox"
            role="switch"
            className="peer sr-only"
            checked={draft.enabled}
            disabled={draft.status === "archived"}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
          <span
            aria-hidden="true"
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              draft.enabled ? "bg-mint" : "bg-ink/20"
            } after:absolute after:left-0.5 after:top-0.5 after:size-5 after:rounded-full after:bg-white after:transition-transform ${
              draft.enabled ? "after:translate-x-5" : ""
            } peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-mint`}
          />
          <span className="font-medium">
            {t(draft.enabled ? "启用规则" : "停用规则")}
          </span>
          <span className="text-xs text-ink/50">
            {t(draft.enabled ? "启用后参与计费" : "停用后不参与计费")}
          </span>
        </label>
      </section>

      {draft.kind === "charge.fixed" ? (
        <section className="grid gap-3">
          <h3 className="text-sm font-semibold">{t("收费")}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="账单名称">
              <input
                className={input}
                required
                value={draft.provider.label ?? ""}
                onChange={(e) => provider({ label: e.target.value })}
              />
            </Field>
            <Field label="金额">
              <input
                className={input}
                type="number"
                required
                min="0"
                step="0.01"
                value={draft.provider.amount ?? 0}
                onChange={(e) => provider({ amount: Number(e.target.value) })}
              />
            </Field>
          </div>
        </section>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:items-start">
          {/* The ring stays on screen while the periods are edited: it is how
              the store sees the day, and clicking a segment opens its period. */}
          <div className="lg:sticky lg:top-0">
            <PricingRing
              value={draft}
              localDate={day}
              onDateChange={changeDay}
              onSelect={(id) => {
                const index = rules.findIndex((r) => r.id === id);
                if (index >= 0) openPeriod(index);
              }}
            />
          </div>
          <section className="grid gap-3">
            <h3 className="text-sm font-semibold">
              {t(draft.kind === "time.cap" ? "封顶设置" : "计费时段")}
            </h3>
          {draft.kind === "time.cap" && (
            <fieldset className="grid gap-2 rounded-xl border border-ink/10 p-4">
              <legend className="px-1 text-sm font-medium">
                {t("计入封顶的规则")}
              </legend>
              {all
                .filter(
                  (p) =>
                    p.id !== draft.id &&
                    p.kind !== "time.cap" &&
                    p.status !== "archived",
                )
                .map((p) => (
                  <label className="flex gap-2 text-sm" key={p.id}>
                    <input
                      type="checkbox"
                      checked={
                        draft.provider.includedPricingConfigIds?.includes(
                          p.id,
                        ) ?? false
                      }
                      onChange={(e) =>
                        provider({
                          includedPricingConfigIds: e.target.checked
                            ? [
                                ...(draft.provider.includedPricingConfigIds ??
                                  []),
                                p.id,
                              ]
                            : draft.provider.includedPricingConfigIds?.filter(
                                (id) => id !== p.id,
                              ),
                        })
                      }
                    />
                    {p.name}
                  </label>
                ))}
              {!all.some(
                (p) =>
                  p.id !== draft.id &&
                  p.kind !== "time.cap" &&
                  p.status !== "archived",
              ) && (
                <p className="text-sm text-ink/55">
                  {t("还没有可计入封顶的规则。")}
                </p>
              )}
            </fieldset>
          )}

          <div className="grid gap-2">
            {rules.map((rule, index) => (
              <PeriodCard
                key={rule.id}
                index={index}
                rule={rule}
                kind={draft.kind}
                open={openRule === index}
                onToggle={() => setOpenRule(openRule === index ? null : index)}
                canRemove={rules.length > 1}
                onRemove={() =>
                  provider({
                    rules: rules.filter((_, i) => i !== index),
                  })
                }
                onChange={(patch) => changeRule(index, patch)}
                weekdaysLabel={(day) => t(["一", "二", "三", "四", "五", "六", "日"][day]!)}
                t={t}
              />
            ))}
            <button
              type="button"
              className={`${buttonQuiet} min-h-10 justify-self-start px-2 text-sm`}
              onClick={() => {
                provider({ rules: [...rules, newRule()] });
                setOpenRule(rules.length);
              }}
            >
              <Plus size={15} />
              {t("添加时段")}
            </button>
          </div>
          </section>
        </div>
      )}
    </ActionForm>
  );
}

/**
 * One period: the header states the rule in one line, and the fields only
 * exist while the period is open.
 */
function PeriodCard({
  index,
  rule,
  kind,
  open,
  onToggle,
  canRemove,
  onRemove,
  onChange,
  weekdaysLabel,
  t,
}: {
  index: number;
  rule: Rule;
  kind: Pricing["kind"];
  open: boolean;
  onToggle: () => void;
  canRemove: boolean;
  onRemove: () => void;
  onChange: (patch: Partial<Rule>) => void;
  weekdaysLabel: (day: number) => string;
  t: (key: string) => string;
}) {
  return (
    <div
      data-period={index}
      className={`rounded-xl border transition-colors ${
        open ? "border-mint/40 bg-mint/[0.03]" : "border-ink/10 bg-panel"
      }`}
    >
      <div className="flex items-start gap-3 p-4">
        <button
          type="button"
          className="focus-ring flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left"
          aria-expanded={open}
          onClick={onToggle}
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">
              {`${t("时段")} ${index + 1}`}
            </span>
            <span className="mt-0.5 block text-xs text-ink/55">
              {ruleSummary(rule, kind, t)}
            </span>
          </span>
          <ChevronDown
            size={16}
            className={`mt-0.5 shrink-0 text-ink/35 transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
        {canRemove && (
          <button
            type="button"
            className={`${buttonQuiet} min-h-9 shrink-0 px-2 text-xs text-coral`}
            onClick={onRemove}
          >
            {t("移除")}
          </button>
        )}
      </div>
      {open && (
        <div className="grid gap-3 border-t border-ink/10 p-4">
          <Field label="名称">
            <input
              className={input}
              required
              value={rule.label}
              onChange={(e) => onChange({ label: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="开始">
              <input
                className={input}
                type="time"
                required
                value={rule.timeRange?.start ?? "00:00"}
                onChange={(e) =>
                  onChange({
                    timeRange: {
                      start: e.target.value,
                      end: rule.timeRange?.end ?? "00:00",
                    },
                  })
                }
              />
            </Field>
            <Field label="结束">
              <input
                className={input}
                type="time"
                required
                value={rule.timeRange?.end ?? "00:00"}
                onChange={(e) =>
                  onChange({
                    timeRange: {
                      start: rule.timeRange?.start ?? "00:00",
                      end: e.target.value,
                    },
                  })
                }
              />
            </Field>
          </div>
          <p className="text-xs text-ink/50">
            {t("开始与结束相同表示全天。")}
          </p>
          {kind === "time.cap" ? (
            <Field label="封顶金额">
              <input
                className={input}
                required
                type="number"
                min="0.01"
                step="0.01"
                value={rule.priceCap ?? 0}
                onChange={(e) =>
                  onChange({ priceCap: Number(e.target.value) })
                }
              />
            </Field>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {(
                [
                  ["unitMinutes", "每隔（分钟）", 1],
                  ["unitPrice", "收费金额", 0],
                  ["roundGraceMinutes", "宽限（分钟）", 0],
                  ["priceCap", "时段封顶（0 为不限）", 0],
                ] as const
              ).map(([key, label, min]) => (
                <Field key={key} label={label}>
                  <input
                    className={input}
                    type="number"
                    required
                    min={min}
                    step={
                      key === "unitPrice" || key === "priceCap" ? "0.01" : "1"
                    }
                    value={rule.pricing?.[key] ?? 0}
                    onChange={(e) =>
                      onChange({
                        pricing: {
                          ...rule.pricing!,
                          [key]: Number(e.target.value),
                        },
                      })
                    }
                  />
                </Field>
              ))}
            </div>
          )}
          <details>
            <summary className="cursor-pointer py-2 text-sm text-ink/60">
              {t("日期与优先级")}
            </summary>
            <div className="mt-3 grid gap-3">
              <Field label="优先级">
                <input
                  className={input}
                  type="number"
                  step="1"
                  required
                  value={rule.priority}
                  onChange={(e) =>
                    onChange({ priority: Number(e.target.value) })
                  }
                />
              </Field>
              <div className="flex flex-wrap gap-3">
                {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                  <label className="flex gap-1 text-sm" key={day}>
                    <input
                      type="checkbox"
                      checked={rule.weekdays?.includes(day) ?? true}
                      onChange={(e) =>
                        onChange({
                          weekdays: e.target.checked
                            ? [...(rule.weekdays ?? []), day]
                            : (rule.weekdays ?? [0, 1, 2, 3, 4, 5, 6]).filter(
                                (d) => d !== day,
                              ),
                        })
                      }
                    />
                    {weekdaysLabel(day)}
                  </label>
                ))}
              </div>
              <Field label="指定日期（逗号分隔）">
                <input
                  className={input}
                  placeholder="2026-10-01, 2026-10-02"
                  value={rule.specificDates?.join(", ") ?? ""}
                  onChange={(e) =>
                    onChange({
                      specificDates: e.target.value
                        ? e.target.value.split(",").map((s) => s.trim())
                        : undefined,
                    })
                  }
                />
              </Field>
              {rule.dateTimeRange && (
                <>
                  <Field label="生效时间">
                    <input
                      className={input}
                      value={rule.dateTimeRange.start}
                      onChange={(e) =>
                        onChange({
                          dateTimeRange: {
                            ...rule.dateTimeRange!,
                            start: e.target.value,
                          },
                        })
                      }
                    />
                  </Field>
                  <Field label="结束时间">
                    <input
                      className={input}
                      value={rule.dateTimeRange.end}
                      onChange={(e) =>
                        onChange({
                          dateTimeRange: {
                            ...rule.dateTimeRange!,
                            end: e.target.value,
                          },
                        })
                      }
                    />
                  </Field>
                </>
              )}
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={rule.status !== "archived"}
                  onChange={(e) =>
                    onChange({
                      status: e.target.checked ? "active" : "archived",
                    })
                  }
                />
                {t("启用时段")}
              </label>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
