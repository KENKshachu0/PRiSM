import { useEffect, useRef } from "react";
import { parseBoardFrame, type BoardFrame } from "./board-state";

const RETRY_MS = [5000, 10_000, 20_000, 60_000];
/** The hub answers "ping" without waking, so an idle board is not dropped by a proxy. */
const PING_MS = 30_000;

/**
 * The device board's channel to the shop hub: one WebSocket for the whole shop,
 * opened while the board is. The hub sends the shop's state when it connects and
 * every change of a live device after. A dropped connection is reopened with a
 * growing wait, and the hub sends the whole shop again when it is back.
 */
export function useBoardLive(shopId: string, enabled: boolean, onFrame: (frame: BoardFrame) => void): void {
  const latest = useRef(onFrame);
  latest.current = onFrame;
  useEffect(() => {
    if (!enabled || !shopId || typeof WebSocket === "undefined") return;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    let failures = 0;
    const connect = () => {
      const url = new URL(`/api/v1/merchant/machines/ws?shopId=${encodeURIComponent(shopId)}`, window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const opened = new WebSocket(url);
      socket = opened;
      opened.onopen = () => {
        ping = setInterval(() => {
          if (opened.readyState === WebSocket.OPEN) opened.send("ping");
        }, PING_MS);
      };
      opened.onmessage = (event) => {
        const frame = parseBoardFrame(String(event.data));
        if (!frame) return;
        failures = 0;
        latest.current(frame);
      };
      opened.onclose = () => {
        if (socket !== opened) return;
        if (ping) clearInterval(ping);
        if (!stopped) retry = setTimeout(connect, RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      if (ping) clearInterval(ping);
      const closing = socket;
      socket = null;
      closing?.close();
    };
  }, [shopId, enabled]);
}
