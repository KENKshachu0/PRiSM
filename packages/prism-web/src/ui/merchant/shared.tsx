import { formatApiDateTime } from "@prism/core";
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
  cashierEnabled: false,
  canWrite: false,
  owner: false,
  timeZone: "",
});
export const useMerchant = () => useContext(MerchantContext);
export const button =
  "focus-ring inline-flex whitespace-nowrap min-h-11 items-center justify-center gap-2 rounded-xl border border-ink/20 px-4 py-2 text-sm font-medium transition-colors hover:bg-ink/5 disabled:opacity-50";
/** A borderless button for dense rows, where a full outline reads as a primary action. */
export const buttonQuiet =
  "focus-ring inline-flex whitespace-nowrap items-center gap-1.5 rounded-lg border border-transparent text-sm text-ink/65 transition-colors hover:bg-ink/5 hover:text-ink disabled:opacity-50";
export const primary = `${button} border-transparent bg-primary text-primary-foreground hover:opacity-90`;
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
  value ? formatApiDateTime(value) : "—";
export const segment = (value: string) => encodeURIComponent(value);
export function useStaffApi() {
  const { shopCode } = useMerchant();
  return useCallback(
    <T,>(path: string, method = "GET", body?: unknown): Promise<T> => {
      const write = method !== "GET";
      const result =
        method === "POST" && !path.endsWith("/preview")
          ? playerOperation<T>(
              shopApi(shopCode, `staff/${path}`),
              (body ?? {}) as Record<string, unknown>,
            )
          : api<T>(shopApi(shopCode, `staff/${path}`), {
              method,
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
      // A write invalidates every cached read for this merchant session; the
      // pages reload what they need right after a successful mutation.
      return write ? result.finally(() => resourceCache.clear()) : result;
    },
    [shopCode],
  );
}

/**
 * Reads are cached per shop and path so switching tabs shows the last known
 * data instead of blanking the panel behind a "loading" line while the request
 * runs. Every mount still refetches, so the cache only removes the flash.
 */
const resourceCache = new Map<string, unknown>();

export function useResource<T>(path: string | null) {
  const request = useStaffApi();
  const { shopCode } = useMerchant();
  const key = path === null ? null : `${shopCode}:${path}`;
  const [data, setData] = useState<T | null>(() =>
    key ? ((resourceCache.get(key) as T | undefined) ?? null) : null,
  );
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let current = true;
    setError("");
    if (path === null || key === null) {
      setData(null);
      return;
    }
    const cached = resourceCache.get(key) as T | undefined;
    if (cached !== undefined) setData(cached);
    request<T>(path)
      .then((result) => {
        resourceCache.set(key, result);
        if (current) setData(result);
      })
      .catch((error) => {
        if (current) setError(error.message);
      });
    return () => {
      current = false;
    };
    // `key` covers path and shop; depending on the request itself would refetch
    // whenever the merchant context re-renders.
  }, [request, path, key, revision]);
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
  dismissDisabled = false,
  wide = false,
  xl = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  dismissDisabled?: boolean;
  /** Room for a multi-section form rather than a single short confirmation. */
  wide?: boolean;
  /** A two-column layout: side content plus the form it controls. */
  xl?: boolean;
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
      onCancel={event => { if (dismissDisabled) event.preventDefault(); else close(); }}
      className={`m-auto max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto rounded-xl bg-panel p-0 text-ink backdrop:bg-black/35 ${xl ? "max-w-5xl" : wide ? "max-w-2xl" : "max-w-xl"}`}
      aria-label={t(title)}
    >
      <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-ink/10 bg-panel px-5 py-4">
        <h2 className="text-lg font-semibold">{t(title)}</h2>
        <button
          type="button"
          className={button}
          onClick={close}
          disabled={dismissDisabled}
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
  onResult,
  sticky = false,
  noValidate = false,
}: {
  children: ReactNode;
  submit: (form: FormData) => Promise<unknown>;
  label?: string;
  done: () => void;
  /**
   * Return `true` to keep the form open after a successful submit. Used where
   * the response carries something that can only be shown once, such as a
   * freshly minted device token.
   */
  onResult?: (result: unknown) => boolean;
  /**
   * Keep the submit button in view while the form is longer than the dialog.
   * A long form whose only button sits past the fold looks unsaveable.
   */
  sticky?: boolean;
  /**
   * Let the caller validate instead of the browser. Required when part of the
   * form lives in a collapsed container: the browser cannot focus a hidden
   * field, so it would block submit with no visible message.
   */
  noValidate?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { t } = useI18n();
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    // `new FormData(form)` drops the button that submitted the form, so a
    // second submit button cannot tell the handler what it was asked to do.
    // Passing the submitter keeps that intent in the payload.
    const submitter =
      event.nativeEvent instanceof SubmitEvent
        ? event.nativeEvent.submitter
        : null;
    const form = new FormData(event.currentTarget, submitter);
    setBusy(true);
    setError("");
    try {
      const result = await submit(form);
      if (!onResult?.(result)) done();
    } catch (error) {
      setError(error instanceof Error ? error.message : t("操作失败"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={save} noValidate={noValidate || undefined}>
      <fieldset disabled={busy} className="grid gap-4">
        {children}
        {!sticky && error && (
          <p role="alert" className="text-sm text-coral">
            {error}
          </p>
        )}
        <div
          className={
            sticky
              ? "sticky bottom-0 -mx-5 -mb-5 mt-1 border-t border-ink/10 bg-panel px-5 py-4"
              : undefined
          }
        >
          {/* A sticky submit button stays visible past the fold; its error has
              to travel with it, or the user presses Save and sees nothing. */}
          {sticky && error && (
            <p role="alert" className="mb-3 text-sm text-coral">
              {error}
            </p>
          )}
          <button className={`${primary} justify-self-start`}>{t(busy ? "处理中…" : label)}</button>
        </div>
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
  paymentMode?: "cashier";
  id: string;
  displayName: string;
  walletTotal: number;
  status: string;
  activeSessionId: string | null;
  hasUnpaidSession?: boolean;
  identities?: { provider: string; subject: string; displayName?: string }[];
};
export type LivePlayer = {
  quoteState?: "loading" | "ready" | "error";
  quoteError?: string;
  paymentMode?: "cashier";
  timeline?: import("@prism/core").BillTimeline;
  status: string;
  identities?: { provider: string; subject: string; displayName?: string }[];
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
  pricingEffect?: import("./asset-types").Effect | null;
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
