import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import { X } from "lucide-react";
import { api, playerOperation } from "../../api";
import { useI18n } from "../../i18n";
import { shopApi } from "../BillingPages";

export const MerchantContext = createContext({
  shopCode: "",
  shopId: "",
  billingEnabled: false,
  canWrite: false,
  owner: false,
  timeZone: "",
});
export const useMerchant = () => useContext(MerchantContext);
export const button =
  "focus-ring inline-flex whitespace-nowrap min-h-11 items-center justify-center gap-2 rounded-xl border border-ink/20 px-4 py-2 text-sm font-medium transition-colors hover:bg-ink/5 disabled:opacity-50";
export const primary = `${button} border-transparent bg-mint text-white hover:opacity-90`;
export const input =
  "focus-ring min-h-11 w-full rounded-lg border border-ink/20 bg-panel px-3 py-2 text-sm font-normal disabled:opacity-60";
export const money = (value: number | null | undefined) =>
  value == null
    ? "—"
    : value.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
export const date = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString() : "—";
export const segment = (value: string) => encodeURIComponent(value);
export function useStaffApi() {
  const { shopCode } = useMerchant();
  return useCallback(
    <T,>(path: string, method = "GET", body?: unknown): Promise<T> =>
      method === "POST" && !path.endsWith("/preview")
        ? playerOperation<T>(
            shopApi(shopCode, `staff/${path}`),
            (body ?? {}) as Record<string, unknown>,
          )
        : api<T>(shopApi(shopCode, `staff/${path}`), {
            method,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
    [shopCode],
  );
}
export function useResource<T>(path: string | null) {
  const request = useStaffApi();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let current = true;
    setError("");
    if (path === null) { setData(null); return; }
    request<T>(path)
      .then((result) => {
        if (current) setData(result);
      })
      .catch((error) => {
        if (current) setError(error.message);
      });
    return () => {
      current = false;
    };
  }, [request, path, revision]);
  return { data, error, reload };
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <label className="grid min-w-0 gap-2 text-sm font-medium">
      {t(label)}
      {children}
    </label>
  );
}
export function State({
  error,
  empty = false,
}: {
  error?: string;
  empty?: boolean;
}) {
  const { t } = useI18n();
  return (
    <p
      className="py-10 text-center text-sm text-ink/60"
      role={error ? "alert" : "status"}
    >
      {error || t(empty ? "暂无记录" : "加载中...")}
    </p>
  );
}
export function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useI18n();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={close}
      className="m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-xl bg-panel p-0 text-ink backdrop:bg-black/35"
      aria-label={t(title)}
    >
      <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-ink/10 bg-panel px-5 py-4">
        <h2 className="text-lg font-semibold">{t(title)}</h2>
        <button
          type="button"
          className={button}
          onClick={close}
          aria-label={t("关闭")}
        >
          <X size={18} />
        </button>
      </header>
      <div className="p-5">{children}</div>
    </dialog>
  );
}
export function ActionForm({
  children,
  submit,
  label = "保存",
  done,
}: {
  children: ReactNode;
  submit: (form: FormData) => Promise<unknown>;
  label?: string;
  done: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { t } = useI18n();
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await submit(form);
      done();
    } catch (error) {
      setError(error instanceof Error ? error.message : t("操作失败"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={save}>
      <fieldset disabled={busy} className="grid gap-4">
        {children}
        {error && (
          <p role="alert" className="text-sm text-coral">
            {error}
          </p>
        )}
        <button className={`${primary} justify-self-start`}>{t(busy ? "处理中…" : label)}</button>
      </fieldset>
    </form>
  );
}
export function Table({
  headers,
  children,
}: {
  headers: string[];
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="overflow-x-auto rounded border border-ink/10 bg-panel">
      <table className="w-full min-w-[34rem] text-left text-sm tabular-nums">
        <thead className="border-b border-ink/10 text-xs text-ink/60">
          <tr>
            {headers.map((h) => (
              <th key={h} className="whitespace-nowrap px-4 py-3 font-medium">
                {t(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink/10">{children}</tbody>
      </table>
    </div>
  );
}
export const cell = "px-4 py-4";
export type Player = {
  id: string;
  displayName: string;
  walletTotal: number;
  status: string;
  activeSessionId: string | null;
  hasUnpaidSession?: boolean;
  identities?: { provider: string; subject: string }[];
};
export type LivePlayer = {
  timeline?: import("@prism/core").BillTimeline;
  status: string;
  identities?: { provider: string; subject: string }[];
  playerId: string;
  displayName: string;
  walletTotal: number;
  stayDurationMinutes: number;
  estimatedTotal: number | null;
  globalCapWindows: {
    key: string; ruleLabel: string; windowStartedAt: string; windowEndedAt: string;
    priceCap: number; paidBefore: number; currentAmount: number; amountApplied: number; priceCapReached: boolean;
  }[];
  sessions: {
    id: string; label?: string; startedAt: string; endedAt: string | null;
    status: "active" | "closed"; elapsedMinutes: number; currentImpact: number | null;
    pricingCharges: { pricingConfigId: string; planName: string; ruleLabel: string; amount: number }[];
    pricingSegments: {
      pricingConfigId: string; ruleId: string; planName: string; ruleLabel: string;
      ruleTimeRange: { start: string; end: string } | null;
      actualStartedAt: string; actualEndedAt: string; amount: number;
      intervalCap: number; intervalCapReached: boolean;
    }[];
  }[];
};
export type Asset = {
  type: string;
  code: string;
  name: string;
  status: string;
  stackable: boolean;
  pricingEffectId: string | null;
  activeAt?: string | null;
  expiresAt?: string | null;
  metadata?: Record<string, unknown> | null;
};
export type Preview = {
  timeline?: import("@prism/core").BillTimeline;
  settlementPreview: { total: number };
  chargeItems: { label: string; amount: number }[];
  adjustments: { label: string; amount: number }[];
  wallet: { balanceBefore: number; balanceAfter: number };
};
