import { useRef, useState, type FormEvent } from "react";
import { playerOperation } from "../../api";
import { useI18n } from "../../i18n";
import { shopApi, type Settings } from "../BillingPages";
import { Field, Modal, button, input, money, primary } from "./shared";

export const defaultBillingSetup = {
  paidName: "余额", freeName: "赠送余额", hourlyPrice: 12, graceMinutes: 5, dailyCap: 60,
};
type Setup = typeof defaultBillingSetup;

export function BillingSetupFields({ value, change }: { value: Setup; change: (value: Setup) => void }) {
  const { t } = useI18n();
  return <>
    <div className="grid grid-cols-2 gap-3">
      {([["paidName", "充值余额名称"], ["freeName", "赠送余额名称"]] as const).map(([key, label]) =>
        <Field key={key} label={label}><input className={input} required maxLength={40} value={value[key]}
          onChange={event => change({ ...value, [key]: event.target.value })} /></Field>)}
    </div>
    <div className="grid grid-cols-3 gap-3">
      {([["hourlyPrice", "每小时", "元"], ["graceMinutes", "宽限时长", "分钟"], ["dailyCap", "全天封顶", "元"]] as const).map(([key, label, unit]) =>
        <Field key={key} label={label} unit={key === "dailyCap" && value.dailyCap === 0 ? "不封顶" : unit}><input className={input} type="number" required min={key === "hourlyPrice" ? ".01" : "0"}
          max={key === "graceMinutes" ? 59 : 100000} step={key === "graceMinutes" ? "1" : ".01"} value={value[key]}
          onChange={event => change({ ...value, [key]: Number(event.target.value) })} /></Field>)}
    </div>
  </>;
}

export function BillingConversionWizard({ shopCode, close, done }: {
  shopCode: string; close: () => void; done: (settings: Settings) => Promise<void>;
}) {
  const { t } = useI18n();
  const [setup, setSetup] = useState(defaultBillingSetup);
  const [cashier, setCashier] = useState(false);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    if (step === 0) { setStep(1); return; }
    submitting.current = true; setBusy(true); setError("");
    try {
      const settings = await playerOperation<Settings>(shopApi(shopCode, "billing/setup"), { ...setup, cashierEnabled: cashier });
      window.dispatchEvent(new Event("prism-shop-settings"));
      await done(settings);
    } catch (error) {
      setError(error instanceof Error ? error.message : t("操作失败"));
    } finally { submitting.current = false; setBusy(false); }
  }
  return <Modal title="快速创建计费" close={() => { if (!submitting.current) close(); }}>
    <form onSubmit={submit}>
      <fieldset disabled={busy} className="grid gap-4">
        <ol className="flex gap-4 text-sm text-ink/60">
          {["收费标准", "确认创建"].map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined}
            className={step === index ? "font-semibold text-ink" : ""}>{index + 1} · {t(label)}</li>)}
        </ol>
        {step === 0 ? <>
          <BillingSetupFields value={setup} change={setSetup} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={cashier}
            onChange={event => setCashier(event.target.checked)} />{t("同时启用前台收银")}</label>
          <p className="text-sm text-ink/60">{t("前台收银默认关闭，开启后可在「在店」页面刷卡计时并现场收款。")}</p>
        </> : <>
          <dl className="grid grid-cols-2 gap-3 rounded-lg bg-ink/5 p-4 text-sm">
            <dt>{t("每小时")}</dt><dd>{money(setup.hourlyPrice)}</dd>
            <dt>{t("宽限时长")}</dt><dd>{setup.graceMinutes} {t("分钟")}</dd>
            <dt>{t("全天封顶")}</dt><dd>{setup.dailyCap === 0 ? t("不封顶") : money(setup.dailyCap)}</dd>
            <dt>{t("前台收银")}</dt><dd>{t(cashier ? "启用" : "停用")}</dd>
          </dl>
          <p className="text-sm">{t("将补齐基础余额资产，创建新的标准入场方案并设为默认资源组的方案。默认资源组里的资源从此开始计费；其他资源组保持各自的方案。已有资源、玩家、资产和计费方案会保留。")}</p>
        </>}
        {error && <p role="alert" className="text-sm text-coral">{error}</p>}
        <div className="flex flex-wrap justify-between gap-3">
          <button type="button" className={button} onClick={() => step === 0 ? close() : setStep(0)}>{t(step === 0 ? "取消" : "上一步")}</button>
          <button className={primary}>{t(busy ? "正在处理，请稍候" : step === 0 ? "下一步" : "确认创建")}</button>
        </div>
      </fieldset>
    </form>
  </Modal>;
}
