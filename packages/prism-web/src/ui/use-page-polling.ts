import { useEffect, useRef } from "react";
import { PagePolling } from "./page-polling";
import { ApiError } from "../api";

export function isTransientReadFailure(error: unknown) {
  return error instanceof TypeError || error instanceof ApiError
    && (error.status === 408 || error.status === 429 || error.status >= 500);
}

/**
 * `deferFirst`: the page already has what the first read would fetch, so the
 * first read waits one interval (and is skipped if polling is not wanted then).
 */
export function usePagePolling(read: (signal: AbortSignal) => Promise<void>, enabled = true, key = "", shouldPoll = true, deferFirst = false) {
  const latest = useRef(read);
  latest.current = read;
  const pollingNeeded = useRef(shouldPoll);
  pollingNeeded.current = shouldPoll;
  const defer = useRef(deferFirst);
  useEffect(() => {
    if (!enabled) return;
    const polling = new PagePolling(signal => latest.current(signal), 3000, () => pollingNeeded.current);
    if (defer.current) {
      polling.deferFirst();
      defer.current = false;
    }
    const visibility = () => polling.setVisible(!document.hidden);
    const foreground = () => { if (!document.hidden) polling.refresh(); };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", foreground);
    window.addEventListener("pageshow", foreground);
    return () => {
      polling.stop();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", foreground);
      window.removeEventListener("pageshow", foreground);
    };
  }, [enabled, key]);
}
