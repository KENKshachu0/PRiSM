import { useState } from "react";
import { useI18n } from "../../i18n";
import { displayDateTime } from "../bill-time";
import type { Present, RedeemCode } from "./asset-types";
import {
  codeExportColumns,
  emptyCodeExportFilter,
  filterRedeemCodes,
  redeemCodesToCsv,
  redeemCodesToText,
  type CodeExportColumn,
  type CodeExportFilter,
  type CodeUsage,
  type CodeValidity,
} from "./redeem-code-export";
import { Field, Modal, button, input, primary } from "./shared";

const usageOptions: [CodeUsage, string][] = [
  ["unused", "未使用"],
  ["partial", "部分使用"],
  ["exhausted", "已用完"],
  ["revoked", "已撤销"],
];
const validityOptions: [CodeValidity, string][] = [
  ["valid", "有效"],
  ["pending", "未生效"],
  ["expired", "已过期"],
];
const columnLabels: Record<CodeExportColumn, string> = {
  present: "礼物",
  usageCount: "已使用次数",
  maxUseCount: "可用次数",
  usage: "使用状态",
  validity: "有效状态",
  activeAt: "生效时间",
  expiresAt: "到期时间",
};

function toggle<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((value) => value !== item) : [...list, item];
}

function CheckGroup<T extends string>({
  legend,
  options,
  selected,
  onToggle,
}: {
  legend: string;
  options: readonly (readonly [T, string])[];
  selected: readonly T[];
  onToggle: (value: T) => void;
}) {
  const { t } = useI18n();
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">{t(legend)}</legend>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        {options.map(([value, label]) => (
          <label key={value} className="flex items-center gap-2">
            <input type="checkbox" checked={selected.includes(value)} onChange={() => onToggle(value)} />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function download(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function RedeemCodeExport({
  codes,
  presents,
  timeZone,
  close,
}: {
  codes: RedeemCode[];
  presents: Present[];
  timeZone: string;
  close: () => void;
}) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<CodeExportFilter>(emptyCodeExportFilter);
  const [format, setFormat] = useState<"csv" | "txt">("csv");
  const [columns, setColumns] = useState<CodeExportColumn[]>([...codeExportColumns]);
  const patch = (next: Partial<CodeExportFilter>) => setFilter((current) => ({ ...current, ...next }));

  const now = new Date();
  const matches = filterRedeemCodes(codes, filter, now, timeZone);
  const rangeInverted = !!filter.expiresFrom && !!filter.expiresTo && filter.expiresFrom > filter.expiresTo;
  const shown = (value: string | null | undefined) => (value ? displayDateTime(value, timeZone) : "");

  function run() {
    const stamp = now.toISOString().slice(0, 10).replaceAll("-", "");
    if (format === "txt") {
      download(redeemCodesToText(matches), `redeem-codes-${stamp}.txt`, "text/plain;charset=utf-8");
      return;
    }
    const labels = {
      code: t("兑换码"),
      columns: Object.fromEntries(
        codeExportColumns.map((column) => [column, t(columnLabels[column])]),
      ) as Record<CodeExportColumn, string>,
      usage: Object.fromEntries(usageOptions.map(([value, label]) => [value, t(label)])) as Record<CodeUsage, string>,
      validity: Object.fromEntries(validityOptions.map(([value, label]) => [value, t(label)])) as Record<
        CodeValidity,
        string
      >,
    };
    // The BOM makes Excel read the file as UTF-8 so Chinese present names survive.
    const csv = redeemCodesToCsv(
      matches,
      presents,
      codeExportColumns.filter((column) => columns.includes(column)),
      labels,
      now,
      shown,
    );
    download(`\uFEFF${csv}`, `redeem-codes-${stamp}.csv`, "text/csv;charset=utf-8");
  }

  return (
    <Modal title="导出兑换码" close={close} wide>
      <div className="grid gap-5">
        <CheckGroup
          legend="绑定礼物"
          options={presents.map((present) => [
            present.id,
            present.status === "archived" ? `${present.name}（${t("已归档")}）` : present.name,
          ])}
          selected={filter.presentIds}
          onToggle={(id) => patch({ presentIds: toggle(filter.presentIds, id) })}
        />
        <CheckGroup
          legend="使用状态"
          options={usageOptions.map(([value, label]) => [value, t(label)])}
          selected={filter.usage}
          onToggle={(value) => patch({ usage: toggle(filter.usage, value) })}
        />
        <CheckGroup
          legend="有效状态"
          options={validityOptions.map(([value, label]) => [value, t(label)])}
          selected={filter.validity}
          onToggle={(value) => patch({ validity: toggle(filter.validity, value) })}
        />
        <p className="-mt-3 text-xs text-ink/55">{t("不勾选表示不限制该条件。")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="兑换码包含">
            <input
              className={input}
              value={filter.search}
              placeholder={t("例如批次前缀")}
              onChange={(e) => patch({ search: e.target.value })}
            />
          </Field>
          <Field label="最多导出数量">
            <input
              className={input}
              type="number"
              min="1"
              step="1"
              value={filter.limit}
              placeholder={t("不限")}
              onChange={(e) => patch({ limit: e.target.value })}
            />
          </Field>
          <Field label="到期日期从">
            <input
              className={input}
              type="date"
              value={filter.expiresFrom}
              onChange={(e) => patch({ expiresFrom: e.target.value })}
            />
          </Field>
          <Field label="到期日期至">
            <input
              className={input}
              type="date"
              value={filter.expiresTo}
              onChange={(e) => patch({ expiresTo: e.target.value })}
            />
          </Field>
        </div>
        {rangeInverted && <p className="text-sm text-red-600">{t("起始日期不能晚于结束日期")}</p>}
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">{t("文件格式")}</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name="export-format" checked={format === "csv"} onChange={() => setFormat("csv")} />
              {t("CSV 表格")}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="export-format" checked={format === "txt"} onChange={() => setFormat("txt")} />
              {t("纯文本（每行一个兑换码）")}
            </label>
          </div>
        </fieldset>
        {format === "csv" && (
          <CheckGroup
            legend="导出列"
            options={codeExportColumns.map((column) => [column, t(columnLabels[column])] as const)}
            selected={columns}
            onToggle={(column) => setColumns(toggle(columns, column))}
          />
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink/10 pt-4">
          <p className="text-sm" aria-live="polite">
            {matches.length
              ? t("将导出 {count} 个兑换码", { count: matches.length })
              : t("没有符合条件的兑换码")}
          </p>
          <div className="flex gap-2">
            <button type="button" className={button} onClick={() => setFilter(emptyCodeExportFilter)}>
              {t("重置条件")}
            </button>
            <button type="button" className={primary} disabled={!matches.length || rangeInverted} onClick={run}>
              {t("导出")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
