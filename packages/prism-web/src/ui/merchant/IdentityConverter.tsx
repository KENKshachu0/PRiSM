import { useRef, useState } from "react";
import { api } from "../../api";
import { useI18n } from "../../i18n";
import { shopApi, post } from "../BillingPages";
import { Field, input, button, primary } from "./shared";

type Conversion = { sourceProvider:string;targetProvider:string;playerCount:number;identityCount:number;bindingCount:number;
  fingerprint:string;conflicts:{subject:string;reason:string}[];samples:{playerId:string;displayName:string;from:string;to:string}[] };
export function IdentityConverter({ shopCode, embedded = false }: { shopCode:string; embedded?:boolean }) {
  const { t,errorText } = useI18n();
  const [source,setSource] = useState("");
  const [target,setTarget] = useState("");
  const [preview,setPreview] = useState<Conversion|null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [done,setDone] = useState(false);
  const operationId = useRef<string|null>(null);
  async function run(apply:boolean) {
    setBusy(true);setError("");setDone(false);
    try {
      const result = await api<Conversion>(shopApi(shopCode,`identity-conversion/${apply ? "apply" : "preview"}`),post({
        sourceProvider:source,targetProvider:target,
        ...(apply && preview ? {fingerprint:preview.fingerprint,operationId:operationId.current} : {}),
      }));
      if (apply) { setDone(true);setPreview(null);window.dispatchEvent(new Event("prism-player-identities")); }
      else { setPreview(result);operationId.current=crypto.randomUUID(); }
    } catch (e) { setError(errorText(e instanceof Error ? e.message : "操作失败")); }
    finally { setBusy(false); }
  }
  return <section className={embedded ? "grid gap-4" : "grid gap-4 rounded-xl border border-ink/10 bg-panel p-5"}>
    {!embedded && <h3 className="font-semibold">{t("平台身份转换")}</h3>}
    <p className="text-sm text-ink/60">{t("批量替换本店玩家的平台标识，身份值、玩家、余额和账单保持不变。转换前先预览影响和冲突。")}</p>
    <form className="grid gap-4" onSubmit={e=>{e.preventDefault();void run(false);}}>
      <Field label="原平台标识"><input className={input} value={source} required pattern="[a-z][a-z0-9_-]{0,63}" disabled={busy}
        onChange={e=>{setSource(e.target.value);setPreview(null);setDone(false);}} /></Field>
      <Field label="目标平台标识"><input className={input} value={target} required pattern="[a-z][a-z0-9_-]{0,63}" placeholder="onebot" disabled={busy}
        onChange={e=>{setTarget(e.target.value);setPreview(null);setDone(false);}} /></Field>
      <button className={`${button} justify-self-start`} disabled={busy}>{t("预览转换")}</button>
    </form>
    {preview && <div className="grid gap-3 text-sm">
      <p>{t("受影响玩家")}：{preview.playerCount} · {t("平台身份")}：{preview.identityCount} · {t("网页账号绑定")}：{preview.bindingCount}</p>
      {preview.samples.map(row=><p key={`${row.playerId}:${row.from}`}>{row.displayName} · {row.from} → {row.to}</p>)}
      {preview.conflicts.map((conflict,i)=><p key={i} className="text-coral">{conflict.subject} · {t(conflict.reason)}</p>)}
      <button className={`${primary} justify-self-start`} disabled={busy || !!preview.conflicts.length || !preview.identityCount && !preview.bindingCount}
        onClick={()=>void run(true)}>{t("确认批量转换")}</button>
    </div>}
    {error && <p role="alert" className="text-coral">{error}</p>}
    {done && <p role="status">{t("身份转换完成")}</p>}
  </section>;
}
