/**
 * Requests a shop bot sends over its WebSocket, run through the platform's own
 * routes in-process. The bot's token travels with each request, so every route
 * authenticates and authorizes it exactly as an HTTP request, and a revoked
 * token fails on its next request.
 */
import type { Env } from "../bindings.js";
import { parseHaReport, type HaReport } from "../hardware/aimeio-relay.js";

export type BotFrame =
  /**
   * `ha` says the bot can watch Home Assistant for the shop; `name` is how the board calls it.
   * Neither is sent by a bot that predates watching, which is then never asked to.
   */
  | { type: "hello"; reminderLeadSeconds?: number; ha?: true; name?: string }
  | { type: "request"; id: string; method: "GET" | "POST" | "PUT"; path: string; query?: Record<string, unknown>; body?: unknown }
  /** What a watching bot reports, in the shape an IO reports it: `ha.status` and `ha.states`. */
  | { type: "ha"; report: HaReport };

/** `serverMs` is how long the platform spent on the request, so the Bot can tell the network from the server. */
export type BotResponse = { type: "response"; id: string; status: number; body: unknown; serverMs?: number };

/** What a bot is called on the board when it does not say. */
export const DEFAULT_BOT_NAME = "Bot";

/** A request frame, hello or watcher report, or null for anything malformed. */
export function parseBotFrame(raw: string): BotFrame | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  if (value.type === "hello") {
    const lead = value.reminderLeadSeconds;
    const name = typeof value.name === "string" ? value.name.trim().slice(0, 40) : "";
    return {
      type: "hello",
      ...(typeof lead === "number" && lead >= 0 && lead <= 24 * 3600 ? { reminderLeadSeconds: lead } : {}),
      ...(value.ha === true ? { ha: true as const } : {}),
      ...(name ? { name } : {}),
    };
  }
  if (value.type === "ha") {
    const report = parseHaReport(value);
    return report ? { type: "ha", report } : null;
  }
  if (value.type !== "request") return null;
  const { id, method, path, query, body } = value;
  if (typeof id !== "string" || !id || id.length > 64) return null;
  if (method !== "GET" && method !== "POST" && method !== "PUT") return null;
  if (typeof path !== "string") return null;
  return {
    type: "request",
    id,
    method,
    path,
    ...(query && typeof query === "object" ? { query: query as Record<string, unknown> } : {}),
    ...(body === undefined ? {} : { body }),
  };
}

/**
 * The URL a bot path runs as. Only the shop's integration routes and the
 * version endpoint are reachable; anything else is refused before it runs.
 */
export function botRequestUrl(shopCode: string, path: string, query?: Record<string, unknown>): URL | null {
  const clean = path.replace(/^\/+/, "");
  let url: URL;
  if (clean === "version") url = new URL("https://prism.internal/version");
  else if (/^integration(\/[A-Za-z0-9._:~%-]+)+$/.test(clean)) {
    const prefix = `/api/v1/shops/${encodeURIComponent(shopCode)}/integration/`;
    url = new URL(`https://prism.internal/api/v1/shops/${encodeURIComponent(shopCode)}/${clean}`);
    // Dot segments are resolved by URL; what remains must still be inside.
    if (!url.pathname.startsWith(prefix) || /%2e|%2f/i.test(clean)) return null;
  } else return null;
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

// Hono's own context type is wider than what is passed here; the call site narrows it.
type App = { fetch(request: Request, env: Env, ctx: any): Response | Promise<Response> };

export async function runBotRequest(input: {
  app: App;
  env: Env;
  waitUntil: (promise: Promise<unknown>) => void;
  token: string;
  shopCode: string;
  frame: Extract<BotFrame, { type: "request" }>;
}): Promise<BotResponse> {
  const { frame } = input;
  const url = botRequestUrl(input.shopCode, frame.path, frame.query);
  if (!url) return { type: "response", id: frame.id, status: 404, body: { error: { code: "NOT_FOUND", message: "Bot 不能访问这个接口" } } };
  const response = await input.app.fetch(
    new Request(url, {
      method: frame.method,
      headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      ...(frame.method === "GET" ? {} : { body: JSON.stringify(frame.body ?? {}) }),
    }),
    input.env,
    { waitUntil: input.waitUntil, passThroughOnException() {} },
  );
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  const serverMs = Number.parseFloat(response.headers.get("x-response-time") ?? "");
  return { type: "response", id: frame.id, status: response.status, body, ...(Number.isFinite(serverMs) ? { serverMs } : {}) };
}

/** The bot's credentials stopped working: its connection should end too. */
export function revokedCredentials(response: BotResponse): boolean {
  const error = (response.body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return response.status === 403 && error?.code === "FORBIDDEN" && error.message === "店铺 Bot 凭据无效";
}
