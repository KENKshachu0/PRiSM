import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { api, ApiError } from "../../api";
import {
  downloadShopBackup,
  cancelShopExport,
  recoverInterruptedShopExport,
  uploadShopBackup,
  verifyShopBackup,
  convertPrismNeoFile,
  type ExportInfo,
  type ShopBackupDigest,
} from "../../shop-data-transfer";
import { useI18n } from "../../i18n";
import { button, primary, input, Field, Modal, useMerchant } from "./shared";

type Preview = {
  canImport: boolean;
  fingerprint: string;
  scope: "business" | "configuration";
  source: { name: string; publicId: string; origin?: string };
  counts: Record<string, number>;
  target?: { records: number; mode: "replace" | "merge" };
  warnings: string[];
  errors: string[];
};
const labels: Record<string, string> = {
  pricing_effects: "计费效果",
  asset_definitions: "资产定义",
  pricing_configs: "计费方案",
  presents: "礼物",
  business_items: "商品",
  pricing_config_versions: "历史规则版本",
  pricing_releases: "计费发布版本",
  pricing_release_heads: "当前计费发布版本",
  players: "玩家",
  player_identities: "平台身份",
  cashier_profiles: "前台玩家",
  sessions: "计费会话",
  session_pricing_releases: "会话计费版本",
  asset_holdings: "资产余额",
  asset_transactions: "资产交易",
  asset_ledger_entries: "资产流水",
  redeem_codes: "兑换码",
  redeem_records: "兑换记录",
  player_checkouts: "结账记录",
  checkout_timelines: "账单时间轴",
  checkout_report_states: "账单归档状态",
  settlements: "会话账单",
  settlement_charge_items: "收费明细",
  settlement_adjustments: "费用调整",
  pricing_history_entries: "收费历史",
  pricing_cap_history_entries: "封顶历史",
  business_item_orders: "商品订单",
  cashier_payments: "前台收款",
  staff_users: "员工资料",
  app_settings: "店铺设置",
  shop_billing_settings: "计费设置",
  api_tokens: "接入凭据",
  machines: "设备",
  device_capabilities: "设备能力与连接",
  mahjong_seats: "麻将座位",
  device_operations: "设备操作记录",
  device_events: "设备事件",
  device_state: "设备状态",
  // Tables of v2 backups, converted on import.
  device_commands: "设备操作记录",
  device_states: "设备状态记录",
  machine_connections: "设备连接记录",
  account_links: "账号关联",
};
export function ShopDataTransfer() {
  const { shopCode, timeZone } = useMerchant();
  const { t, errorText } = useI18n();
  const [scope, setScope] = useState<"business" | "configuration">("business");
  const [importSource, setImportSource] = useState<"prism" | "prism-neo">("prism");
  const [file, setFile] = useState<File>();
  const [jobId, setJobId] = useState("");
  const stagedImport = useRef<Awaited<
    ReturnType<typeof uploadShopBackup>
  > | null>(null);
  const [pending, setPending] = useState<ShopBackupDigest | null>(null);
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  const [progress, setProgress] = useState<number>();
  const [exported, setExported] = useState<ExportInfo>();
  const [exporting, setExporting] = useState(false);
  const exportController = useRef<AbortController | null>(null);
  const [filename, setFilename] = useState("");
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [operationId, setOperationId] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [allowance, setAllowance] = useState<{
    remaining: number;
    used: number;
    locked: boolean;
    importRemaining: number;
    activeExport?: { jobId: string; expiresAt: string } | null;
  }>();
  const path = `/api/v1/shops/${encodeURIComponent(shopCode)}/data`;
  async function loadAllowance() {
    setAllowance(await api(`${path}/export-status`));
  }
  useEffect(() => {
    let disposed = false;
    setAllowance(undefined);
    async function refresh() {
      const value = await api<NonNullable<typeof allowance>>(
        `${path}/export-status`,
      );
      if (!disposed) setAllowance(value);
    }
    const wake = () => {
      void refresh().catch(failed);
    };
    const visible = () => {
      if (document.visibilityState === "visible") wake();
    };
    void recoverInterruptedShopExport(path)
      .catch(failed)
      .then(() => {
        if (!disposed) wake();
      });
    window.addEventListener("focus", wake);
    window.addEventListener("pageshow", wake);
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      exportController.current?.abort();
      window.removeEventListener("focus", wake);
      window.removeEventListener("pageshow", wake);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [shopCode]);
  useEffect(() => {
    if (!allowance?.locked) return;
    // Recheck the actual lease, rather than keeping the initial locked response forever.
    let disposed = false;
    let timer: number;
    async function poll() {
      try {
        await loadAllowance();
      } catch (value) {
        if (!disposed) failed(value);
      } finally {
        if (!disposed) timer = window.setTimeout(poll, 5000);
      }
    }
    timer = window.setTimeout(poll, 5000);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [allowance?.locked, shopCode]);
  function failed(value: unknown) {
    setError(
      errorText(
        value instanceof Error ? value.message : "操作失败，请稍后重试",
      ),
    );
  }
  async function download() {
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    setBusy(true);
    setError("");
    try {
      setProgress(0);
      setExported(undefined);
      const { info, blob } = await downloadShopBackup(
        path,
        scope,
        setProgress,
        {
          signal: controller.signal,
          onStart: setExported,
        },
      );
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = info.filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (value) {
      if (!controller.signal.aborted) failed(value);
    } finally {
      await loadAllowance().catch(failed);
      setBusy(false);
      setExporting(false);
      if (exportController.current === controller)
        exportController.current = null;
      setProgress(undefined);
    }
  }
  async function cancelExport() {
    if (exportController.current) {
      exportController.current.abort();
      return;
    }
    if (!allowance?.activeExport) return;
    setBusy(true);
    setError("");
    try {
      await cancelShopExport(path, allowance.activeExport.jobId);
    } catch (value) {
      failed(value);
    } finally {
      await loadAllowance().catch(failed);
      setBusy(false);
    }
  }
  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    setFile(selected);
    setJobId("");
    stagedImport.current = null;
    setPending(null);
    setOverwriteConfirmed(false);
    setServerErrors([]);
    setFilename(selected?.name ?? "");
    setError("");
    setSuccess(false);
    setOperationId(crypto.randomUUID());
  }
  /** 浏览器内校验整份文件；通过后弹出确认，取消不会发出任何请求。 */
  async function startImport() {
    setBusy(true);
    setError("");
    setServerErrors([]);
    try {
      if (!file) return;
      if (!pending) {
        setProgress(0);
        const digest = await verifyShopBackup(
          importSource === "prism-neo"
            ? await convertPrismNeoFile(file, timeZone)
            : file,
          setProgress,
        );
        setPending(digest);
      }
      setOverwriteConfirmed(false);
      setConfirm(true);
    } catch (value) {
      failed(value);
    } finally {
      setBusy(false);
      setProgress(undefined);
    }
  }
  /** 用户确认后才上传；服务端检查通过即导入，失败时保留已上传任务供重试。 */
  async function apply() {
    if (!pending) return;
    const scope = pending.header.scope as "business" | "configuration";
    if (scope === "business" && !overwriteConfirmed) return;
    setBusy(true);
    setError("");
    setServerErrors([]);
    try {
      setProgress(0);
      const upload =
        stagedImport.current ??
        (await uploadShopBackup(path, pending, setProgress));
      stagedImport.current = upload;
      setJobId(upload.jobId);
      const preview = await api<Preview>(
        `${path}/imports/${upload.jobId}/preview`,
        {
          method: "POST",
          body: JSON.stringify({ counts: upload.counts, parts: upload.parts }),
        },
      );
      if (!preview.canImport) {
        setConfirm(false);
        setServerErrors(preview.errors);
        return;
      }
      await api(`${path}/imports/${upload.jobId}/apply`, {
        method: "POST",
        body: JSON.stringify({
          fingerprint: preview.fingerprint,
          operationId,
          overwrite: preview.scope === "business",
        }),
      });
      setConfirm(false);
      setSuccess(true);
      setFile(undefined);
      stagedImport.current = null;
      setPending(null);
      window.dispatchEvent(new Event("prism-shop-settings"));
    } catch (value) {
      setConfirm(false);
      if (value instanceof ApiError && value.code === "TRANSFER_NOT_FOUND") {
        stagedImport.current = null;
        setJobId("");
      }
      failed(value);
    } finally {
      setBusy(false);
      setProgress(undefined);
      await loadAllowance().catch(failed);
    }
  }
  return (
    <div className="grid gap-5">
      <section className="grid gap-4 rounded-xl border border-ink/10 bg-panel p-5">
        <h4 className="font-semibold">{t("导出 JSON 备份")}</h4>
        <p className="text-sm leading-relaxed text-ink/60">
          {t(
            "用于数据备份，以及 beta 与正式版之间的店铺业务数据迁移。金额和时间保留原值。",
          )}
        </p>
        <p className="text-sm leading-relaxed text-ink/60">
          {t(
            "跨环境迁移时，请先停止旧环境营业，核对导入结果后再在新环境营业，避免两边同时计费。",
          )}
        </p>
        <Field label="导出范围">
          <select
            className={input}
            value={scope}
            disabled={busy}
            onChange={(event) => setScope(event.target.value as typeof scope)}
          >
            <option value="business">
              {t("业务备份（玩家、余额、账单和配置）")}
            </option>
            <option value="configuration">
              {t("仅店铺配置（不含玩家和账单）")}
            </option>
          </select>
        </Field>
        <p className="text-sm leading-relaxed text-ink/60">
          {t(
            "每店每月可导出一次，需要更多次数请联系平台管理员。开始导出即使用次数；导出期间暂停本店业务操作，完成或取消后恢复，断线后最多 5 分钟自动解锁。",
          )}
        </p>
        {allowance && (
          <p className="text-sm">
            {t("本月剩余导出次数")}: {allowance.remaining}
          </p>
        )}
        {allowance?.locked && (
          <p className="text-sm text-amber-600">
            {t("店铺正在导出数据，暂时不能进行业务操作，请稍后重试")}
          </p>
        )}
        <button
          className={`${button} justify-self-start`}
          disabled={
            busy || !allowance || allowance.remaining === 0 || allowance.locked
          }
          onClick={download}
        >
          {t("下载 JSON 文件")}
        </button>
        {exporting && (
          <div className="grid gap-2 text-sm" role="status">
            {exported ? (
              <>
                <p>
                  {t("已导出记录")}: {progress ?? 0} /{" "}
                  {Object.values(exported.counts).reduce(
                    (sum, n) => sum + n,
                    0,
                  )}
                </p>
                <progress
                  className="h-2 w-full"
                  aria-label={t("导出进度")}
                  value={progress ?? 0}
                  max={Math.max(
                    1,
                    Object.values(exported.counts).reduce(
                      (sum, n) => sum + n,
                      0,
                    ),
                  )}
                />
              </>
            ) : (
              <p>{t("正在统计备份数据…")}</p>
            )}
          </div>
        )}
        {(exporting || allowance?.activeExport) && (
          <button
            className={`${button} justify-self-start`}
            disabled={busy && !exporting}
            onClick={cancelExport}
          >
            {t("取消导出，恢复营业")}
          </button>
        )}
        {exported && (
          <div className="grid gap-2 text-sm" role="status">
            <p>
              {t("来源环境")}:{" "}
              {String(JSON.parse(exported.headerJson).source.origin)}
            </p>
            <p>
              {t("来源店铺")}:{" "}
              {String(JSON.parse(exported.headerJson).source.name)} · {shopCode}
            </p>
            <p>
              {t("玩家")}: {exported.counts.players ?? 0} · {t("前台玩家")}:{" "}
              {exported.counts.cashier_profiles ?? 0} · {t("结账记录")}:{" "}
              {exported.counts.player_checkouts ?? 0} · {t("设备")}:{" "}
              {exported.counts.machines ?? 0}
            </p>
            {JSON.parse(exported.headerJson).scope === "business" &&
              !exported.counts.players && (
                <p className="text-amber-600">
                  {t("导出文件没有玩家，请核对来源环境和店铺。")}
                </p>
              )}
          </div>
        )}
      </section>
      <section className="grid gap-4 rounded-xl border border-ink/10 bg-panel p-5">
        <h4 className="font-semibold">{t("从 JSON 导入")}</h4>
        <p className="text-sm text-ink/60">
          {t(
            "每店每月可导入一次，需要更多次数请联系平台管理员。开始上传即使用次数，同一任务内重试不重复计数。",
          )}
        </p>
        {allowance && (
          <p className="text-sm">
            {t("本月剩余导入次数")}: {allowance.importRemaining}
          </p>
        )}
        <p className="text-sm leading-relaxed text-ink/60">
          {t(
            "业务备份覆盖现有数据；仅配置备份保留玩家和账单。目标店铺编号和当前管理员保留。",
          )}
        </p>
        <p className="text-sm leading-relaxed text-ink/60">
          {t(
            "备份包含设备连接密钥、玩家身份和财务数据，请妥善保管。跨环境账号通过已验证的登录身份恢复关联，不复制 Passkey、OAuth 密钥或登录会话。",
          )}
        </p>
        <Field label={t("备份来源")}>
          <select
            className={input}
            value={importSource}
            disabled={busy}
            onChange={(event) => {
              setImportSource(event.target.value as typeof importSource);
              setFile(undefined);
              setJobId("");
              stagedImport.current = null;
              setPending(null);
              setServerErrors([]);
              setFilename("");
              setError("");
              setSuccess(false);
            }}
          >
            <option value="prism">{t("PRiSM 备份（v1／v2／v3 JSON）")}</option>
            <option value="prism-neo">{t("prism-neo 导出（pg_dump 文本或 JSON 快照）")}</option>
          </select>
        </Field>
        <Field label={importSource === "prism-neo" ? "备份文件（.sql 或 .json）" : "JSON 备份文件"}>
          <input
            className={input}
            type="file"
            // iOS filters unknown extensions like .sql out of the picker even
            // with an explicit text/plain accept; only restrict PRiSM JSON.
            accept={importSource === "prism-neo" ? undefined : ".json,application/json"}
            disabled={busy}
            onChange={selectFile}
          />
        </Field>
        <p className="text-xs text-ink/60">
          {t(
            importSource === "prism-neo"
              ? "支持 prism-neo 的 pg_dump 备份（.sql）或 CLI 导出的 JSON 快照，上传前在浏览器转换为 PRiSM 备份；旧计费规则将以停用状态导入，请先在计费设置中核对时区再启用。"
              : "支持 PRiSM v1／v2 JSON 备份，分片传输，无 10 MiB 文件大小限制。",
          )}
        </p>
        <button
          className={`${button} justify-self-start`}
          disabled={
            busy ||
            !file ||
            success ||
            !allowance ||
            (allowance.importRemaining === 0 && !jobId) ||
            allowance.locked
          }
          onClick={startImport}
        >
          {t(busy ? "处理中…" : "开始导入")}
        </button>
      </section>
      {!exporting && progress !== undefined && (
        <p role="status" className="text-sm text-ink/60">
          {t("已处理记录")}: {progress}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-rose-600">
          {error}
        </p>
      )}
      {serverErrors.length > 0 && (
        <ul
          role="alert"
          className="list-disc space-y-1 pl-5 text-sm text-rose-600"
        >
          {serverErrors.map((message, index) => (
            <li key={index}>{t(message)}</li>
          ))}
        </ul>
      )}
      {success && (
        <p role="status" className="text-sm text-mint">
          {t("导入完成，请核对玩家、余额、账单及设备设置后再营业。")}
        </p>
      )}
      {confirm && pending && (() => {
        const scope = pending.header.scope as "business" | "configuration";
        const source = (pending.header.source ?? {}) as {
          name?: string;
          publicId?: string;
        };
        return (
          <Modal
            title="确认导入店铺数据"
            close={() => setConfirm(false)}
            dismissDisabled={busy}
          >
            <div className="grid gap-4 p-5">
              <p>
                {t(
                  scope === "business"
                    ? "业务备份将覆盖目标店铺现有数据，而不是追加。"
                    : "将覆盖同编号配置并补充新配置，保留玩家和账单。",
                )}
              </p>
              <p className="font-medium">
                {source.name ?? "prism-neo"}
                {source.publicId ? ` · ${source.publicId}` : ""}
              </p>
              <p className="break-all text-xs text-ink/60">{filename}</p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                {Object.entries(pending.counts)
                  .filter(([, count]) => count > 0)
                  .map(([table, count]) => (
                    <div key={table} className="flex justify-between gap-2">
                      <dt>{t(labels[table] ?? table)}</dt>
                      <dd className="tabular-nums">{count}</dd>
                    </div>
                  ))}
              </dl>
              {scope === "business" && (
                <label className="flex items-start gap-2 text-sm text-rose-600">
                  <input
                    type="checkbox"
                    checked={overwriteConfirmed}
                    onChange={(event) =>
                      setOverwriteConfirmed(event.target.checked)
                    }
                    disabled={busy}
                  />
                  {t("我确认覆盖目标店铺现有数据，并已保留所需备份")}
                </label>
              )}
              <button
                className={primary}
                disabled={
                  busy || (scope === "business" && !overwriteConfirmed)
                }
                onClick={apply}
              >
                {t(busy ? "正在导入…" : "确认导入")}
              </button>
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}
