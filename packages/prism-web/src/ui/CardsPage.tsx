import { useI18n } from "../i18n";
import { useEffect, useState, type FormEvent } from "react";
import { CreditCard, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Api, type Card } from "../api";
import { useAuth } from "./AuthContext";
import { RequireLogin } from "./RequireLogin";

export function CardsPage() {
  const { t, errorText } = useI18n();
  const { user } = useAuth();
  const [cards, setCards] = useState<Card[]>([]);
  const [label, setLabel] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [authorizationRequired, setAuthorizationRequired] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const canCreate = label.trim().length > 0 && /^\d{20}$/.test(accessCode);

  const load = async () => {
    if (!user) return;
    const result = await Api.cards();
    setCards(result.cards);
    setAuthorizationRequired(result.authorizationRequired);
    setSyncError(result.syncError);
  };

  useEffect(() => {
    void load().catch((caught) => setError(caught instanceof Error ? caught.message : "无法加载卡片"));
  }, [user]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!canCreate) return;
    setError(null);
    setCreating(true);
    try {
      await Api.createCard(label, accessCode);
      setLabel("");
      setAccessCode("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "添加失败");
    } finally {
      setCreating(false);
    }
  };

  const remove = async (cardId: string) => {
    setDeletingId(cardId);
    try {
      await Api.deleteCard(cardId);
      setCards((current) => current.filter((card) => card.id !== cardId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删除失败");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <RequireLogin>
      <div className="grid gap-8">
        <header>
          <h1 className="font-semibold">{t("我的卡片")}</h1>
          <p className="mt-3 text-ink/65">{t("管理用于机台登录的卡片与 MuNET 同步。")}</p>
        </header>
      <section className="grid items-start gap-6 md:grid-cols-[1fr_360px]">
        <form onSubmit={create} className="order-2 rounded border border-ink/10 bg-panel p-5 shadow-soft">
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            <CreditCard size={22} />
            {t("添加卡片")}</h2>
          <div className="mt-5 grid gap-4">
            <label className="grid gap-2 text-sm font-medium">
              {t("显示名称")}<input className="focus-ring min-h-11 rounded border border-ink/10 bg-surface px-3" value={label} onChange={(event) => setLabel(event.target.value)} required />
            </label>
            <label className="grid gap-2 text-sm font-medium">
              {t("卡片号码")}<input
                className="focus-ring min-h-11 rounded border border-ink/10 bg-surface px-3 font-mono"
                value={accessCode}
                onChange={(event) => setAccessCode(event.target.value.replace(/\D/g, "").slice(0, 20))}
                inputMode="numeric"
                placeholder={t("20 位卡号")}
                maxLength={20}
                required
              />
            </label>
            {error && <p className="rounded border border-coral/30 bg-coral/10 px-3 py-2 text-sm text-coral">{errorText(error)}</p>}
            <button
              className="focus-ring flex min-h-11 items-center justify-center gap-2 rounded bg-ink px-4 font-medium text-canvas transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!canCreate || creating}
            >
              <Plus size={18} />
              {t("添加卡片")}</button>
            {syncError && <p className="text-sm text-ink/60">{errorText(syncError)}</p>}
            {authorizationRequired ? (
              <a
                className="focus-ring flex min-h-11 items-center justify-center gap-2 rounded border border-ink/15 bg-surface px-4 font-medium text-ink"
                href="/api/v1/auth/munet?next=/cards"
              >
                <RefreshCw size={18} />
                {t("重新连接 MuNET")}</a>
            ) : (
              <button
                className="focus-ring flex min-h-11 items-center justify-center gap-2 rounded border border-ink/15 bg-surface px-4 font-medium text-ink disabled:opacity-60"
                disabled={syncing}
                type="button"
                onClick={async () => {
                  setSyncing(true);
                  setError(null);
                  try {
                    const result = await Api.syncCards();
                    setCards(result.cards);
                    setAuthorizationRequired(result.authorizationRequired);
                    setSyncError(result.syncError);
                  } catch (caught) {
                    setError(caught instanceof Error ? caught.message : "无法同步 MuNET 卡片");
                  } finally {
                    setSyncing(false);
                  }
                }}
              >
                <RefreshCw size={18} className={syncing ? "animate-spin" : ""} />
                {t("同步 MuNET 卡片")}</button>
            )}
          </div>
        </form>
        <div className="order-1 overflow-hidden rounded-[28px] bg-panel">
          {cards.length === 0 ? (
            <div className="rounded border border-dashed border-ink/20 bg-surface p-6 text-ink/60">{t("还没有添加卡片。")}</div>
          ) : (
            cards.map((card) => (
              <div key={card.id} className="flex min-h-24 items-center justify-between gap-4 border-b border-ink/10 px-6 py-5 last:border-b-0">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xl font-semibold">{card.label}</p>
                    <span className="rounded bg-ink/5 px-2 py-0.5 text-xs text-ink/60">
                      {card.source === "munet" ? t("来自 MuNET 账号同步") : t("手动添加")}
                    </span>
                  </div>
                  <p className="mt-1 break-all font-mono text-sm text-ink/60">{card.accessCode}</p>
                </div>
                <button
                  title={t("删除卡片")}
                  disabled={deletingId === card.id}
                  className="focus-ring grid size-10 shrink-0 place-items-center rounded text-coral hover:bg-coral/10 disabled:opacity-40"
                  onClick={() => void remove(card.id)}
                >
                  <Trash2 size={18} />
                </button>
              </div>
            ))
          )}
        </div>
      </section>
      </div>
    </RequireLogin>
  );
}
