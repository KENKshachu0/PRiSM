import { useEffect, useRef, useState } from "react";
import type { ClimateState } from "./ClimateControls";

/**
 * What a device page knows of its Home Assistant state. `watching` says the
 * values are current and the shop hub pushes every change; without it nothing
 * is known and the page asks for the state once.
 */
export type DeviceFacts = {
  watching: boolean;
  power: "on" | "off" | null;
  climate: ClimateState | null;
};

/** A part of the state that came in a frame; a key that is absent was not said. */
export type FactsChange = { power?: "on" | "off" | null; climate?: ClimateState | null };

/** A frame the shop hub pushes to a device page. */
export type LiveFrame =
  | ({ type: "hello" | "watching"; watching: boolean } & FactsChange)
  | ({ type: "state" } & FactsChange)
  | { type: "refresh"; reason?: string };

const powerOf = (value: unknown): "on" | "off" | null => (value === "on" || value === "off" ? value : null);

/** A frame from the hub, or null for anything that is not one. */
export function parseLiveFrame(raw: string): LiveFrame | null {
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!frame || typeof frame !== "object") return null;
  const change: FactsChange = {
    ...("power" in frame ? { power: powerOf(frame.power) } : {}),
    ...("climate" in frame ? { climate: (frame.climate as ClimateState | null) ?? null } : {}),
  };
  if (frame.type === "hello" || frame.type === "watching") return { type: frame.type, watching: frame.watching === true, ...change };
  if (frame.type === "state") return { type: "state", ...change };
  if (frame.type === "refresh") return { type: "refresh", ...(typeof frame.reason === "string" ? { reason: frame.reason } : {}) };
  return null;
}

export type LiveStatus = {
  /** The hub has greeted this connection. */
  connected: boolean;
  /** The hub is pushing this device's state. */
  watching: boolean;
  /** A connection that had been up closed since; what it last said may be out of date. */
  dropped: boolean;
};

export type LiveHandlers = {
  /** The current state, when the connection opens or the device becomes watched. */
  onFacts(facts: FactsChange): void;
  /** A change to the state while it is watched. */
  onChange(change: FactsChange): void;
  /** Something the page shows changed elsewhere (a bot confirmed the binding); read it again. */
  onRefresh(): void;
};

export const idleLive: LiveStatus = { connected: false, watching: false, dropped: false };

/** What a frame does to the connection's status, and what the page is told. */
export function applyLiveFrame(status: LiveStatus, frame: LiveFrame, handlers: LiveHandlers): LiveStatus {
  if (frame.type === "refresh") {
    handlers.onRefresh();
    return status;
  }
  if (frame.type === "state") {
    // The hub only pushes changes for a watched device.
    const { type: _type, ...change } = frame;
    if (status.watching) handlers.onChange(change);
    return status;
  }
  const { type: _type, watching, ...facts } = frame;
  if (watching) handlers.onFacts(facts);
  return { connected: true, watching, dropped: false };
}

const RETRY_MS = [5000, 10_000, 20_000, 60_000];

/**
 * The shop hub's channel for a device page: the device's state while it is
 * watched, and word when the page's own state changed. It is opened only for a
 * device that is watched. A dropped connection is reopened with a growing wait;
 * meanwhile `dropped` tells the page its last state may be stale.
 */
export function useDeviceLive(ticket: string, enabled: boolean, handlers: LiveHandlers): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>(idleLive);
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    if (!enabled || typeof WebSocket === "undefined") return;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let failures = 0;
    let current = idleLive;
    const set = (next: LiveStatus) => {
      current = next;
      setStatus(next);
    };
    const connect = () => {
      const url = new URL(`/api/v1/devices/session/ws?ticket=${encodeURIComponent(ticket)}`, window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const opened = new WebSocket(url);
      socket = opened;
      opened.onmessage = (event) => {
        const frame = parseLiveFrame(String(event.data));
        if (!frame) return;
        if (frame.type === "hello") failures = 0;
        set(applyLiveFrame(current, frame, latest.current));
      };
      opened.onclose = () => {
        if (socket !== opened) return;
        set({ connected: false, watching: false, dropped: current.connected || current.dropped });
        if (!stopped) retry = setTimeout(connect, RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      const closing = socket;
      socket = null;
      closing?.close();
      setStatus(idleLive);
    };
  }, [ticket, enabled]);
  return status;
}
