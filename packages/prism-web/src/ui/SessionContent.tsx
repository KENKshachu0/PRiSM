import { useLocation, useSearchParams } from "react-router-dom";
import { billTime } from "./bill-time";
import { useEffect, useState } from "react";
import { Fingerprint, Loader2 } from "lucide-react";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { Api, api } from "../api";
import { passkeyErrorMessage } from "../passkeys";
import { useI18n } from "../i18n";
import { useAuth } from "./AuthContext";
import { post, shopApi } from "./BillingPages";
import { bindingPromptLines, defaultBindingCommand } from "../binding-prompt";

export function ShopHero({ name, heroUrl, subtitle }: { name: string; heroUrl?: string | null; subtitle: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [heroUrl]);
  return <header className="machine-hero">
    {heroUrl && !failed && <img src={heroUrl} alt="" decoding="async" onError={() => setFailed(true)} />}
    <div className="machine-hero-info">
      {heroUrl && !failed && <img src={heroUrl} alt="" decoding="async" aria-hidden="true" />}
      <h1>{name}</h1><p>{subtitle}</p>
    </div>
  </header>;
}

export function SessionSignIn() {
  const { t, errorText } = useI18n();
  const { refresh } = useAuth();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [params] = useSearchParams();
  const location = useLocation();
  const nextParams = new URLSearchParams(params);
  nextParams.delete("error"); nextParams.delete("setup");
  const next = location.pathname + (nextParams.size ? `?${nextParams}` : "") + location.hash;
  const queryError = params.get("error");
  const displayedError = error || (queryError === "MuNET 授权已取消" ? "" : queryError);
  async function passkey() {
    setBusy("passkey"); setError("");
    try {
      await Api.loginWithPasskey(await startAuthentication({ optionsJSON: await Api.passkeyOptions() }));
      await refresh();
    } catch (e) { const message = passkeyErrorMessage(e); if (message) setError(message); }
    finally { setBusy(""); }
  }
  return <div className="session-actions">
    <button className="session-action primary" disabled={!!busy} onClick={() => { setBusy("munet"); window.location.assign(`/api/v1/auth/munet?next=${encodeURIComponent(next)}`); }}>
      {busy === "munet" ? <Loader2 size={24} className="animate-spin" /> : <img src="/munet-logo.png" alt="" width={24} height={24} className="size-6 object-contain" />}
      {t(busy === "munet" ? "正在连接 MuNET…" : "使用 MuNET 登录")}
    </button>
    <button className="session-action" disabled={!!busy || !browserSupportsWebAuthn()} onClick={() => void passkey()}>
      {busy === "passkey" ? <Loader2 size={24} className="animate-spin" /> : <Fingerprint size={24} />}
      {t(busy === "passkey" ? "正在验证 Passkey…" : "使用 Passkey 登录")}
    </button>
    {!browserSupportsWebAuthn() && <p className="session-subtitle text-center">{t("当前浏览器不支持 Passkey，请使用 MuNET 登录")}</p>}
    {displayedError && <p role="alert" className="text-coral">{errorText(displayedError)}</p>}
  </div>;
}

export function PlatformBinding({ code }: { code: string }) {
  const { t, errorText } = useI18n();
  const [binding, setBinding] = useState<{ code: string; expiresAt: string; botContact?: string } | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setBinding(null); setError("");
    api<{ code: string; expiresAt: string; botContact?: string }>(shopApi(code, "platform-binding"), post()).then(result => {
      if (cancelled) return;
      setBinding(result);
      timer = setTimeout(() => setAttempt(value => value + 1), Math.max(1000, Date.parse(result.expiresAt) - Date.now()));
    }).catch(e => { if (!cancelled) setError(errorText(e instanceof Error ? e.message : "操作失败")); });
    return () => { cancelled = true; clearTimeout(timer); };
  }, [code, attempt, errorText]);
  return <div className="grid gap-6"><h2>{t("绑定平台身份")}</h2><div className="binding-code">
    {binding ? <>
      <BindingPrompt template={binding.botContact} code={binding.code} />
      <small>{t("有效期至")} {billTime(binding.expiresAt).time}</small>
    </> : error ? <><p role="alert">{error}</p><button className="session-action" onClick={() => setAttempt(value => value + 1)}>{t("重试")}</button></> : <Loader2 className="animate-spin" />}
  </div></div>;
}

/** The shop's own binding instructions, or the standard ones when it wrote none. */
export function BindingPrompt({ template, code }: { template?: string | null; code: string }) {
  const { t } = useI18n();
  const lines = bindingPromptLines(template, code) ?? [
    { text: t("向店铺 Bot 发送"), command: false },
    { text: defaultBindingCommand(code), command: true },
  ];
  return <>{lines.map((line, index) => line.command
    ? <div key={index} className="binding-command"><code className="select-all">{line.text}</code><CopyCommand value={line.text} /></div>
    : <p key={index}>{line.text}</p>)}</>;
}

function CopyCommand({ value }: { value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return <button type="button" className="binding-copy" onClick={async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* The command stays selectable when the clipboard is denied. */ }
  }}>{t(copied ? "已复制" : "复制")}</button>;
}
