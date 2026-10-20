import { useEffect, useState } from "react";

export type DeviceLive = {
  /** Something in the shop is watching this device's Home Assistant state. */
  watching: boolean;
  power: "on" | "off" | null;
  climate: unknown | null;
};

const RETRY_MS = 5000;

/**
 * Pushed power and air-conditioner state for a device page. While nothing is
 * watching, or the connection is down, `watching` is false and the page keeps
 * polling as before.
 */
export function useDeviceLive(ticket: string, enabled: boolean): DeviceLive {
  const [live, setLive] = useState<DeviceLive>({ watching: false, power: null, climate: null });
  useEffect(() => {
    if (!enabled || typeof WebSocket === "undefined") return;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const connect = () => {
      const url = new URL(`/api/v1/devices/session/ws?ticket=${encodeURIComponent(ticket)}`, window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.onmessage = (event) => {
        let frame: { type?: string; watching?: boolean; power?: string; climate?: unknown };
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const power = frame.power === "on" || frame.power === "off" ? frame.power : undefined;
        if (frame.type === "hello")
          setLive({ watching: !!frame.watching, power: power ?? null, climate: frame.climate ?? null });
        else if (frame.type === "watching")
          setLive((current) => ({ ...current, watching: !!frame.watching, ...(frame.watching ? {} : { power: null }) }));
        else if (frame.type === "state")
          setLive((current) => ({
            ...current,
            ...(power ? { power } : {}),
            ...(frame.climate !== undefined ? { climate: frame.climate } : {}),
          }));
      };
      socket.onclose = () => {
        setLive({ watching: false, power: null, climate: null });
        if (!stopped) retry = setTimeout(connect, RETRY_MS);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [ticket, enabled]);
  return live;
}
