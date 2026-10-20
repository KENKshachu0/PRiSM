import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { ApiError, InlineError, type Notice } from "../api";
import { useI18n } from "../i18n";
import { PlayerDialog } from "./PlayerAccount";

/** What a caller can do for the flows a notice may ask for. */
export type NoticeHandlers = {
  onExpired?: () => void;
  onRefresh?: () => void;
  retry?: () => void;
  /** A read the player did not ask for (polling, a reload after an action): run the flow, never open a dialog. */
  quiet?: boolean;
};

type Show = (error: unknown, handlers?: NoticeHandlers) => Notice;

const NoticeContext = createContext<Show | null>(null);

/**
 * The one place player-facing problems are presented. The server decides how
 * each one is shown; this runs its flow and shows the dialogs. An inline notice
 * is returned to the caller to show next to what the player touched.
 */
export function NoticeProvider({ children }: { children: ReactNode }) {
  const { t, errorText } = useI18n();
  const [open, setOpen] = useState<{ notice: Notice; retry?: () => void } | null>(null);
  const show = useCallback<Show>((error, handlers = {}) => {
    const notice: Notice = error instanceof ApiError && error.notice
      ? error.notice
      : isNotice(error)
        ? error
        : {
            // Problems found on this device (no location, no network) have no server notice.
            code: "CLIENT",
            level: error instanceof InlineError ? "warning" : "error",
            display: error instanceof InlineError ? "inline" : "dialog",
            flow: error instanceof ApiError && error.sessionExpired ? "expired" : "none",
            title: null,
            body: errorText(error),
            actions: [{ kind: "dismiss", label: t("知道了") }],
          };
    if (notice.flow === "expired") handlers.onExpired?.();
    else if (notice.flow === "refresh") handlers.onRefresh?.();
    else if (notice.flow === "signin") window.location.reload();
    if (notice.display === "dialog" && !handlers.quiet) setOpen({ notice, retry: handlers.retry });
    return notice;
  }, [errorText, t]);
  const close = () => setOpen(null);
  return (
    <NoticeContext.Provider value={show}>
      {children}
      {open && (
        <PlayerDialog title={open.notice.title ?? t("操作失败")} onClose={close}>
          <p className="text-sm leading-relaxed">{open.notice.body}</p>
          <div className="mt-5 flex justify-end gap-2">
            {open.notice.actions
              .filter((action) => action.kind !== "retry" || open.retry)
              .map((action) => (
                <button
                  key={action.kind}
                  className={`session-action ${action.kind === "retry" ? "primary" : ""}`}
                  onClick={() => {
                    close();
                    if (action.kind === "retry") open.retry?.();
                  }}
                >
                  {action.label}
                </button>
              ))}
          </div>
        </PlayerDialog>
      )}
    </NoticeContext.Provider>
  );
}

function isNotice(value: unknown): value is Notice {
  return !!value && typeof value === "object" && "display" in value && "body" in value && "level" in value;
}

export function useNotice(): Show {
  const show = useContext(NoticeContext);
  if (!show) throw new Error("useNotice must be used inside NoticeProvider");
  return show;
}

/** A notice kept briefly next to a control, then cleared: 3 s for a success, 5 s otherwise. */
export function useInlineNotice() {
  const [note, setNote] = useState<Notice | null>(null);
  const timer = useMemo(() => ({ id: 0 as ReturnType<typeof setTimeout> | 0 }), []);
  const showNote = useCallback((next: Notice | null) => {
    if (timer.id) clearTimeout(timer.id);
    setNote(next);
    if (next) timer.id = setTimeout(() => setNote(null), next.level === "success" ? 3000 : 5000);
  }, [timer]);
  return [note, showNote] as const;
}
