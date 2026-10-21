import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../bindings.js";

export function allowedOrigins(env: {
  APP_ORIGIN?: string;
  EXTRA_ALLOWED_ORIGINS?: string;
}): Set<string> {
  const values = [
    env.APP_ORIGIN,
    ...(env.EXTRA_ALLOWED_ORIGINS?.split(",") ?? []),
  ];
  return new Set(
    values
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  );
}

export function assertAllowedOrigin(
  request: Request,
  env: { APP_ORIGIN?: string; EXTRA_ALLOWED_ORIGINS?: string },
): void {
  if (
    request.method === "GET" ||
    request.method === "HEAD" ||
    request.method === "OPTIONS"
  ) {
    return;
  }
  const origin = request.headers.get("origin");
  if (!origin) return;
  if (!allowedOrigins(env).has(origin)) {
    throw new Response(
      JSON.stringify({
        error: { code: "FORBIDDEN", message: "请求来源无效" },
      }),
      {
        status: 403,
        headers: { "content-type": "application/json" },
      },
    );
  }
}

export const corsMiddleware: MiddlewareHandler<AppBindings> = async (
  c,
  next,
) => {
  const origin = c.req.header("origin");
  const allowed = allowedOrigins(c.env);
  const isAllowed = origin ? allowed.has(origin) : false;

  if (c.req.method === "OPTIONS") {
    if (!origin || isAllowed) {
      const targetOrigin = origin || c.env.APP_ORIGIN;
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": targetOrigin,
          "access-control-allow-credentials": "true",
          "access-control-allow-methods":
            "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "access-control-allow-headers":
            c.req.header("access-control-request-headers") ||
            "content-type, authorization, x-requested-with",
          "access-control-max-age": "86400",
          vary: "Origin",
        },
      });
    }
    return new Response(
      JSON.stringify({
        error: { code: "FORBIDDEN", message: "请求来源无效" },
      }),
      {
        status: 403,
        headers: { "content-type": "application/json" },
      },
    );
  }

  // Mutation requests with invalid origin are strictly rejected
  if (origin && !isAllowed) {
    if (
      c.req.method === "POST" ||
      c.req.method === "PUT" ||
      c.req.method === "PATCH" ||
      c.req.method === "DELETE"
    ) {
      return c.json(
        {
          error: { code: "FORBIDDEN", message: "请求来源无效" },
        },
        403,
      );
    }
  }

  await next();

  // A WebSocket handshake carries no CORS headers, and its headers cannot be changed.
  if (origin && isAllowed && c.res.status !== 101) {
    c.res.headers.set("access-control-allow-origin", origin);
    c.res.headers.set("access-control-allow-credentials", "true");
    c.res.headers.set(
      "access-control-allow-methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    c.res.headers.set(
      "access-control-allow-headers",
      "content-type, authorization, x-requested-with",
    );
    c.res.headers.append("vary", "Origin");
  }
};
