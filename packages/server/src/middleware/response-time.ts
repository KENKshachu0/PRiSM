import { errorNotice, requestLocale, type Locale } from "../notices.js";
import type { MiddlewareHandler } from "hono";
import {
  formatOffsetTimestamp,
  isApiInstant,
  timestampDisplayParts,
} from "@prism/core";
import type { AppBindings } from "../bindings.js";

const eventKey = /(?:At|_at)$/;
const boundaryKeys = new Set(["at", "from", "to", "start", "end"]);
// Rule definitions, user-controlled metadata and credentials are not event transport fields.
const untouchedKeys = new Set([
  "billingSnapshot",
  "provider",
  "dateTimeRange",
  "timeRange",
  "ruleTimeRange",
  "metadata",
  "store",
  "homeAssistantConnection",
  "ttLockConnection",
  "hinataIoDevices",
  "pricingExplanation",
]);
const isEventKey = (key: string) => eventKey.test(key) || boundaryKeys.has(key);

export function hasEventTimestamps(value: unknown, key = ""): boolean {
  if (untouchedKeys.has(key)) return false;
  if (isEventKey(key) && isApiInstant(value)) return true;
  if (Array.isArray(value)) return value.some((item) => hasEventTimestamps(item));
  return (
    !!value &&
    typeof value === "object" &&
    Object.entries(value).some(([name, item]) =>
      hasEventTimestamps(item, name),
    )
  );
}

/** Project event instants at the response boundary, without touching saved rules or receipts. */
export function projectApiTimes(
  value: unknown,
  timeZone: string,
  key = "",
): unknown {
  const instants = new Map<string, string>();
  return project(value, key);

  function project(value: unknown, key = ""): unknown {
    if (untouchedKeys.has(key)) return value;
    if (isEventKey(key) && isApiInstant(value)) {
      let formatted = instants.get(value);
      if (formatted === undefined) {
        formatted = formatOffsetTimestamp(value, timeZone);
        instants.set(value, formatted);
      }
      return formatted;
    }
    if (Array.isArray(value)) return value.map((item) => project(item));
    if (!value || typeof value !== "object") return value;
    const result: Record<string, unknown> = Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, project(item, name)]),
    );
    if (isApiInstant(result.at) && Array.isArray(result.entries)) {
      const parts = timestampDisplayParts(result.at);
      if (parts) {
        result.time = parts.time;
        result.date = parts.date;
      }
    }
    if (
      "periodLabel" in result &&
      isApiInstant(result.startedAt) &&
      isApiInstant(result.endedAt)
    ) {
      const start = timestampDisplayParts(result.startedAt);
      const end = timestampDisplayParts(result.endedAt);
      if (start && end) {
        result.periodLabel = `${start.date === end.date ? "" : `${start.date} `}${start.time} – ${start.date === end.date ? "" : `${end.date} `}${end.time}`;
      }
    }
    return result;
  }
}

export type ApiError = { code: string; message: string; details?: unknown };
export type ApiResponse<T> = { data: T } | { error: ApiError };

export function apiErrorCode(status: number): string {
  return (
    ({
      400: "INVALID_REQUEST",
      401: "AUTHENTICATION_REQUIRED",
      403: "FORBIDDEN",
      404: "NOT_FOUND",
      409: "CONFLICT",
      410: "EXPIRED",
      422: "VALIDATION_FAILED",
      429: "RATE_LIMITED",
    } as Record<number, string>)[status] ?? "INTERNAL_ERROR"
  );
}

export async function wrapApiResponse(
  response: Response,
  timeZone?: string | (() => Promise<string>),
  locale: Locale = "zh",
): Promise<Response> {
  // A WebSocket handshake (101) passes through as it is: no Response can be built with that status.
  if (response.status === 101 || response.status === 204 || response.status === 304) return response;
  // Downloadable JSON is a storage artifact: keep its bytes, UTC clocks and root shape intact.
  if (
    response.ok &&
    response.headers.get("content-disposition")?.startsWith("attachment;")
  ) {
    return response;
  }
  const json = response.headers
    .get("content-type")
    ?.includes("application/json");
  if (response.ok && !json) return response;
  const payload: unknown = json ? await response.json() : null;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("cache-control", "no-store");
  let body: ApiResponse<unknown>;
  if (response.ok) {
    const isWrapped =
      payload &&
      typeof payload === "object" &&
      "data" in payload &&
      Object.keys(payload).length === 1;
    const inner = isWrapped
      ? (payload as { data: unknown }).data
      : payload;

    const zone =
      timeZone && hasEventTimestamps(inner)
        ? typeof timeZone === "function"
          ? await timeZone()
          : timeZone
        : undefined;
    body = { data: zone ? projectApiTimes(inner, zone) : inner };
  } else {
    const error =
      payload && typeof payload === "object" && "error" in payload
        ? payload.error
        : null;
    const structured =
      error && typeof error === "object" ? (error as Partial<ApiError>) : null;
    const code =
      typeof structured?.code === "string"
        ? structured.code
        : apiErrorCode(response.status);
    const reason =
      typeof structured?.message === "string"
        ? structured.message
        : typeof error === "string"
          ? error
          : response.statusText || "Request failed";
    // What the player reads, and how, comes from one table; `message` carries
    // the same text so clients that predate `notice` show it too. The original
    // wording stays in `reason` for staff tools and logs.
    const shown = errorNotice({ code, message: reason, status: response.status }, locale);
    body = {
      error: {
        code,
        message: shown.body,
        notice: shown,
        ...(reason !== shown.body ? { reason } : {}),
        ...(structured?.details !== undefined
          ? { details: structured.details }
          : {}),
      },
    } as ApiResponse<unknown>;
  }
  return Response.json(body, { status: response.status, headers });
}

export async function unwrapLegacyResponse(
  response: Response,
): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("deprecation", "true");
  headers.delete("content-length");
  if (
    headers.get("content-disposition")?.startsWith("attachment;") ||
    !headers.get("content-type")?.includes("application/json")
  ) {
    return new Response(response.body, { status: response.status, headers });
  }
  const body = (await response.json()) as ApiResponse<unknown>;
  return Response.json("data" in body ? body.data : body, {
    status: response.status,
    headers,
  });
}

export const responseTimeMiddleware: MiddlewareHandler<AppBindings> = async (
  c,
  next,
) => {
  await next();
  const zone = c.get("responseTimeZone") || c.get("shop")?.time_zone || "UTC";
  c.res = await wrapApiResponse(c.res, zone, requestLocale(c.req.header("accept-language")));
};
