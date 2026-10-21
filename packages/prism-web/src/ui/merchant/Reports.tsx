import type {
  ReportArchiveFilter,
  StaffReportCheckout,
  StaffReportCheckoutDetail,
} from "@prism/application";
import { addLocalDays, formatLocalDate, parseLocalDateTime } from "@prism/core";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { api } from "../../api";
import { shopApi } from "../BillingPages";
import { BillTimeline, BillTotal } from "../BillTimeline";
import { displayDateTime } from "../bill-time";
import {
  Field,
  Modal,
  State,
  Table,
  button,
  cell,
  input,
  money,
  primary,
  segment,
  useResource,
  useMerchant,
} from "./shared";

// Explicit state assignment is idempotent; it is not a debit operation.
const setReportArchive = (
  shopCode: string,
  checkoutId: string,
  archived: boolean,
) =>
  api(
    shopApi(shopCode, `staff/reports/checkouts/${segment(checkoutId)}/archive`),
    {
      method: "POST",
      body: JSON.stringify({ archived }),
    },
  );

function payment(record: StaffReportCheckout, t: (key: string) => string) {
  return record.externalPayment
    ? `${t("现场收款")} · ${t(({ wechat: "微信", alipay: "支付宝", cash: "现金", other: "其他" } as Record<string, string>)[record.externalPayment.method] ?? record.externalPayment.method)}`
    : t("资产结算");
}

export function ReportsPage() {
  const { t } = useI18n();
  const { timeZone } = useMerchant();
  const [from, setFrom] = useState(
    () => formatLocalDate(new Date(), timeZone).slice(0, 8) + "01",
  );
  const [to, setTo] = useState(() => formatLocalDate(new Date(), timeZone));
  const [archive, setArchive] = useState<ReportArchiveFilter>("active");
  const [offset, setOffset] = useState(0);
  const start = from
    ? parseLocalDateTime(from, "00:00", timeZone)
    : new Date(NaN);
  const end = to
    ? parseLocalDateTime(addLocalDays(to, 1), "00:00", timeZone)
    : new Date(NaN);
  const valid =
    Number.isFinite(start.getTime()) &&
    Number.isFinite(end.getTime()) &&
    start < end;
  const range = valid
    ? new URLSearchParams({
        from: start.toISOString(),
        to: end.toISOString(),
      }).toString()
    : "";
  return (
    <div className="grid gap-5">
      <h2 className="text-xl font-semibold">{t("营业记录")}</h2>
      <div className="flex flex-wrap gap-3">
        <Field label="从">
          <input
            className={input}
            type="date"
            required
            value={from}
            max={to}
            onChange={(e) => {
              setFrom(e.target.value);
              setOffset(0);
            }}
          />
        </Field>
        <Field label="至">
          <input
            className={input}
            type="date"
            required
            value={to}
            min={from}
            onChange={(e) => {
              setTo(e.target.value);
              setOffset(0);
            }}
          />
        </Field>
        <Field label="归档筛选">
          <select
            className={input}
            value={archive}
            onChange={(e) => {
              setArchive(e.target.value as ReportArchiveFilter);
              setOffset(0);
            }}
          >
            <option value="active">{t("未归档")}</option>
            <option value="archived">{t("已归档")}</option>
            <option value="all">{t("全部账单")}</option>
          </select>
        </Field>
      </div>
      {valid ? (
        <ReportResults
          key={`${range}:${archive}:${offset}`}
          range={range}
          archive={archive}
          offset={offset}
          setOffset={setOffset}
        />
      ) : (
        <State error={t("请选择有效日期")} />
      )}
    </div>
  );
}

function ReportResults({
  range,
  archive,
  offset,
  setOffset,
}: {
  range: string;
  archive: ReportArchiveFilter;
  offset: number;
  setOffset: (offset: number) => void;
}) {
  const { t, errorText } = useI18n();
  const { timeZone } = useMerchant();
  const [selected, setSelected] = useState<string | null>(null);
  const summary = useResource<{
    summary: {
      revenueTotal: number;
      sessionCount: number;
      assetGrantTotal: number;
      coinCommandCount: number;
    };
  }>(`reports/summary?${range}`);
  const checkouts = useResource<{
    records: StaffReportCheckout[];
    page: { hasMore: boolean };
  }>(`reports/checkouts?${range}&archive=${archive}&limit=50&offset=${offset}`);
  function changed() {
    setSelected(null);
    summary.reload();
    checkouts.reload();
    if (offset && archive !== "all" && checkouts.data?.records.length === 1)
      setOffset(Math.max(0, offset - 50));
  }
  const open = (record: StaffReportCheckout) => (
    <button className={button} onClick={() => setSelected(record.checkoutId)}>
      {t("账单详情")}
    </button>
  );
  return (
    <>
      {summary.error ? (
        <State error={errorText(summary.error)} />
      ) : (
        summary.data && (
          <>
            <dl className="grid grid-cols-2 gap-5 border-y border-ink/10 py-5 sm:grid-cols-4">
              {[
                ["营业额", money(summary.data.summary.revenueTotal)],
                ["消费笔数", summary.data.summary.sessionCount],
                ["发放笔数", summary.data.summary.assetGrantTotal],
                ["投币次数", summary.data.summary.coinCommandCount],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-ink/60">{t(String(label))}</dt>
                  <dd className="mt-2 text-2xl font-semibold tabular-nums">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-sm text-ink/60">
              {t("营业额不包含已归档账单；消费笔数等其他统计保持不变。")}
            </p>
          </>
        )
      )}
      {checkouts.error ? (
        <State error={errorText(checkouts.error)} />
      ) : !checkouts.data ? (
        <State />
      ) : !checkouts.data.records.length ? (
        <State empty />
      ) : (
        <>
          <div className="divide-y divide-ink/10 rounded-xl bg-panel md:hidden">
            {checkouts.data.records.map((record) => (
              <div
                key={record.checkoutId}
                className="grid grid-cols-[1fr_auto] gap-2 p-4"
              >
                <strong>{record.playerDisplayName}</strong>
                <strong className="tabular-nums">{money(record.total)}</strong>
                <span className="col-span-2 text-xs text-ink/60">
                  {displayDateTime(record.settledAt, timeZone)} ·{" "}
                  {payment(record, t)}
                </span>
                <span className="text-xs text-ink/60">
                  {record.sessionCount} {t("项计时")} · {record.durationMinutes}{" "}
                  {t("分钟")}
                </span>
                <div className="col-span-2 flex flex-wrap justify-end gap-2">
                  {open(record)}
                  <ReportArchiveAction record={record} changed={changed} />
                </div>
              </div>
            ))}
          </div>
          <div className="hidden md:block">
            <Table
              headers={[
                "玩家",
                "结账时间",
                "累计时长",
                "金额",
                "收款方式",
                "操作",
              ]}
            >
              {checkouts.data.records.map((record) => (
                <tr key={record.checkoutId}>
                  <td className={cell}>
                    <strong>{record.playerDisplayName}</strong>
                    <p className="text-xs text-ink/60">
                      {record.sessionCount} {t("项计时")}
                    </p>
                  </td>
                  <td className={`${cell} whitespace-nowrap`}>
                    {displayDateTime(record.settledAt, timeZone)}
                  </td>
                  <td className={cell}>{record.durationMinutes} {t("分钟")}</td>
                  <td className={cell}>{money(record.total)}</td>
                  <td className={cell}>{payment(record, t)}</td>
                  <td className={cell}>
                    <div className="flex flex-wrap gap-2">
                      {open(record)}
                      <ReportArchiveAction record={record} changed={changed} />
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          </div>
        </>
      )}
      {checkouts.data && (
        <div className="flex justify-end gap-2">
          <button
            className={button}
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            {t("上一页")}
          </button>
          <button
            className={button}
            disabled={!checkouts.data.page.hasMore}
            onClick={() => setOffset(offset + 50)}
          >
            {t("下一页")}
          </button>
        </div>
      )}
      {(summary.error || checkouts.error) && (
        <button
          className={`${button} justify-self-start`}
          onClick={() => {
            summary.reload();
            checkouts.reload();
          }}
        >
          {t("重试")}
        </button>
      )}
      {selected && (
        <ReportDetail
          key={selected}
          checkoutId={selected}
          close={() => setSelected(null)}
          changed={changed}
        />
      )}
    </>
  );
}

function ReportArchiveAction({
  record,
  changed,
}: {
  record: StaffReportCheckout;
  changed: () => void;
}) {
  const { t, errorText } = useI18n();
  const { canWrite, shopCode } = useMerchant();
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    locked.current = false;
    setBusy(false);
  }, [record]);
  async function change() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await setReportArchive(shopCode, record.checkoutId, !record.archived);
      changed();
    } catch (e) {
      locked.current = false;
      setBusy(false);
      setError(errorText(e instanceof Error ? e.message : "操作失败"));
    }
  }
  if (!canWrite) return null;
  return (
    <div className="grid gap-1">
      <button
        className={button}
        disabled={busy}
        onClick={() => void change()}
        title={t(
          record.archived
            ? "恢复此账单后，营业额将增加 {amount}。"
            : "归档此账单后，营业额将减少 {amount}。",
          { amount: money(record.total) },
        )}
      >
        {t(busy ? "处理中…" : record.archived ? "恢复账单" : "归档账单")}
      </button>
      {error && (
        <p className="text-xs text-coral" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ReportDetail({
  checkoutId,
  close,
  changed,
}: {
  checkoutId: string;
  close: () => void;
  changed: () => void;
}) {
  const { t, errorText } = useI18n();
  const { timeZone, canWrite, shopCode } = useMerchant();
  const detail = useResource<StaffReportCheckoutDetail>(
    `reports/checkouts/${segment(checkoutId)}`,
  );
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const at = (value: string | null | undefined) =>
    value ? displayDateTime(value, timeZone) : "—";
  async function changeArchive() {
    if (busy || !detail.data) return;
    setBusy(true);
    setError("");
    try {
      await setReportArchive(
        shopCode,
        checkoutId,
        !detail.data.record.archived,
      );
      changed();
    } catch (e) {
      setError(errorText(e instanceof Error ? e.message : "操作失败"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="账单详情" close={close} dismissDisabled={busy}>
      {detail.error ? (
        <State error={errorText(detail.error)} />
      ) : !detail.data ? (
        <State />
      ) : (
        (() => {
          const { record, receipt } = detail.data;
          const bill = {
            ...receipt,
            settlementPreview: receipt.playerSettlement,
          };
          const fields = [
            ["玩家", record.playerDisplayName],
            ["玩家 ID", record.playerId],
            ["账单 ID", record.checkoutId],
            ["入场时间", at(record.startedAt)],
            ["结束时间", at(record.endedAt)],
            ["结账时间", at(record.settledAt)],
            ["累计时长", `${record.durationMinutes} ${t("分钟")}`],
            ["收款方式", payment(record, t)],
            ["计费小计", money(record.subtotal)],
            ["归档状态", t(record.archived ? "已归档" : "未归档")],
            ...(record.externalPayment
              ? [
                  ["收款员工", record.externalPayment.staffId],
                  ["收款时间", at(record.externalPayment.collectedAt)],
                ]
              : []),
            ...(record.updatedAt
              ? [
                  ["最近归档操作时间", at(record.updatedAt)],
                  ["操作员工", record.updatedBy],
                ]
              : []),
            ...(receipt.wallet
              ? [["结账后余额", money(receipt.wallet.balanceAfter)]]
              : []),
          ];
          return (
            <div className="grid gap-5">
              <dl className="grid grid-cols-2 gap-3">
                {fields.map(([label, value]) => (
                  <div key={String(label)} className="min-w-0">
                    <dt className="text-xs text-ink/60">{t(String(label))}</dt>
                    <dd className="mt-1 break-words text-sm">{value}</dd>
                  </div>
                ))}
              </dl>
              <BillTotal preview={bill} />
              <h3 className="font-semibold">{t("完整时间轴")}</h3>
              <BillTimeline preview={bill} timeZone={timeZone} />
              <details className="rounded-xl border border-ink/10 p-4">
                <summary className="cursor-pointer font-medium">
                  {t("计时与收费明细")}
                </summary>
                <div className="mt-4 grid gap-3 text-sm">
                  {(receipt.settlements ?? []).map(({ settlement }) => (
                    <div key={settlement.sessionId} className="break-words">
                      <p>
                        {t("计时 ID")} · {settlement.sessionId}
                      </p>
                      <p className="text-ink/60">
                        {at(settlement.startedAt)} – {at(settlement.endedAt)}
                      </p>
                    </div>
                  ))}
                  {[...receipt.chargeItems, ...receipt.adjustments].map(
                    (item, i) => (
                      <div key={i} className="flex justify-between gap-4">
                        <span>{item.label}</span>
                        <span className="tabular-nums">
                          {money(item.amount)}
                        </span>
                      </div>
                    ),
                  )}
                </div>
              </details>
              <p className="text-sm text-ink/60">
                {t(
                  "归档会隐藏账单并从营业额中排除；玩家记录、余额和其他统计不变。恢复后重新计入营业额。",
                )}
              </p>
              {canWrite &&
                (!confirming ? (
                  <button
                    className={`${button} justify-self-start`}
                    onClick={() => setConfirming(true)}
                  >
                    {t(record.archived ? "恢复账单" : "归档账单")}
                  </button>
                ) : (
                  <div className="grid gap-3 rounded-xl border border-ink/20 p-4">
                    <p className="text-sm">
                      {t(
                        record.archived
                          ? "恢复此账单后，营业额将增加 {amount}。"
                          : "归档此账单后，营业额将减少 {amount}。",
                        { amount: money(record.total) },
                      )}
                    </p>
                    {error && (
                      <p role="alert" className="text-sm text-coral">
                        {error}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button
                        className={primary}
                        disabled={busy}
                        onClick={() => void changeArchive()}
                      >
                        {t(
                          busy
                            ? "处理中…"
                            : record.archived
                              ? "确认恢复"
                              : "确认归档",
                        )}
                      </button>
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() => setConfirming(false)}
                      >
                        {t("取消")}
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          );
        })()
      )}
    </Modal>
  );
}
