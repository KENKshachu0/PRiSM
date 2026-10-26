import { useI18n } from "../i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { Fingerprint, KeyRound, Plus, Store, Trash2 } from "lucide-react";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Api, type AuthIdentity, type Passkey } from "../api";
import { passkeyErrorMessage } from "../passkeys";
import { RequireLogin } from "./RequireLogin";

export function SettingsPage() {
  const { t, errorText } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const [identities, setIdentities] = useState<AuthIdentity[]>([]);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attemptedSetup = useRef(false);
  const setup = new URLSearchParams(location.search).get("setup") === "passkey";
  const next = new URLSearchParams(location.search).get("next") || "/cards";

  const load = useCallback(async () => {
    const account = await Api.account();
    setIdentities(account.identities);
    setPasskeys(account.passkeys);
  }, []);

  const addPasskey = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await startRegistration({ optionsJSON: await Api.passkeyRegistrationOptions() });
      await Api.registerPasskey(response);
      await load();
      if (setup) navigate(next, { replace: true });
    } catch (caught) {
      setError(passkeyErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [load, navigate, next, setup]);

  useEffect(() => {
    void load().catch((caught) => setError(caught instanceof Error ? caught.message : "无法加载账号设置"));
  }, [load]);

  useEffect(() => {
    if (!setup || attemptedSetup.current || !browserSupportsWebAuthn()) return;
    attemptedSetup.current = true;
    void addPasskey();
  }, [addPasskey, setup]);

  return (
    <RequireLogin>
      <section className="mx-auto grid max-w-2xl gap-6">
        <div>
          <h1 className="text-2xl font-semibold">{t("账号设置")}</h1>
          <p className="mt-3 text-ink/65">{t("管理登录身份与设备上的 Passkey。")}</p>
          {error && <p className="mt-4 rounded border border-coral/30 bg-coral/10 px-3 py-2 text-sm text-coral">{errorText(error)}</p>}
        </div>

        <section className="rounded border border-ink/10 bg-panel p-5">
          <h2 className="flex items-center gap-2 font-semibold"><KeyRound size={18} />{t("登录身份")}</h2>
          <div className="mt-5 divide-y divide-ink/10">
            {identities.map((identity) => (
              <div key={identity.id} className="py-4">
                <p className="font-medium">{identity.provider === "munet" ? "MuNET" : identity.provider}</p>
                <p className="mt-1 text-sm text-ink/60">{identity.displayName || identity.username || t("已连接")}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded border border-ink/10 bg-panel p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 font-semibold"><Fingerprint size={18} />Passkey</h2>
            {browserSupportsWebAuthn() && (
              <button
                className="focus-ring flex min-h-9 items-center justify-center gap-1.5 rounded bg-ink px-3 text-sm font-medium text-canvas disabled:opacity-60"
                disabled={busy}
                onClick={addPasskey}
              >
                <Plus size={16} />
                {t("添加 Passkey")}</button>
            )}
          </div>
          <div className="mt-5 divide-y divide-ink/10">
            {passkeys.map((passkey) => (
              <div key={passkey.id} className="flex min-h-20 items-center justify-between gap-3 py-4">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{passkey.name}</p>
                  <p className="mt-1 text-sm text-ink/60">
                    {passkey.providerName && passkey.providerName !== passkey.name ? `${passkey.providerName} · ` : ""}
                    {passkey.backedUp ? t("已同步") : t("此设备")}
                  </p>
                </div>
                <button
                  className="focus-ring grid size-9 shrink-0 place-items-center rounded text-coral hover:bg-coral/10"
                  title={t("删除 Passkey")}
                  onClick={async () => {
                    await Api.deletePasskey(passkey.id);
                    await load();
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
            {!browserSupportsWebAuthn() && <p className="text-sm text-ink/60">{t("当前设备不支持 Passkey。")}</p>}
          </div>
          {setup && <Link className="mt-4 inline-flex text-sm font-medium text-mint" to={next} replace>{t("稍后设置")}</Link>}
        </section>

        <section className="rounded border border-ink/10 bg-panel p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 font-semibold"><Store size={18} />{t("店家管理")}</h2>
              <p className="mt-1 text-sm text-ink/60">{t("管理你的店铺和资源")}</p>
            </div>
            <Link to="/merchant" className="focus-ring inline-flex min-h-9 items-center justify-center rounded bg-ink px-4 text-sm font-medium text-canvas">
              {t("前往管理")}</Link>
          </div>
        </section>
      </section>
    </RequireLogin>
  );
}
