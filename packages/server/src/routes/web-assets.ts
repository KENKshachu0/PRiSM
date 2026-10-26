import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { AppBindings } from "../bindings.js";
import { machineRelayPath } from "../gateway/relay-path.js";

export function isAssetEligiblePath(path: string): boolean {
  return (
    !path.startsWith("/api/") &&
    !path.startsWith("/rpc") &&
    // The relay upgrade is a GET, so without this it is served as a static asset
    // and the WebSocket handshake never happens.
    !path.startsWith(machineRelayPath) &&
    // A bot's connection upgrade is a GET too, at one fixed path.
    !path.startsWith("/integration/") &&
    !path.startsWith("/.well-known/") &&
    !path.startsWith("/callback") &&
    !path.startsWith("/__prism_deploy") &&
    !path.startsWith("/health") &&
    !path.startsWith("/version") &&
    !/^\/t\/[^/]+\/[^/]+/.test(path)
  );
}

export function serveWebAssets(options: { spaFallback?: boolean } = {}): MiddlewareHandler<AppBindings> {
  const spaFallback = options.spaFallback ?? true;

  return async (c, next) => {
    const assets = c.env.ASSETS;
    if (!assets) {
      await next();
      return;
    }

    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD") {
      await next();
      return;
    }

    const deployPhase = c.env.PRISM_DEPLOY_PHASE;
    if (deployPhase === "maintenance" || deployPhase === "verify") {
      await next();
      return;
    }

    const url = new URL(c.req.url);
    if (!isAssetEligiblePath(url.pathname)) {
      await next();
      return;
    }

    const response = await assets.fetch(c.req.raw);
    if (response.status === 404 && spaFallback && method === "GET") {
      const accept = c.req.header("accept") || "";
      if (accept.includes("text/html")) {
        const rootRequest = new Request(new URL("/", c.req.url), c.req.raw);
        return assets.fetch(rootRequest);
      }
    }

    return response;
  };
}

export const webAssetsRouter = new Hono<AppBindings>();

webAssetsRouter.get("*", async (c) => {
  const assets = c.env.ASSETS;
  if (!assets) {
    return new Response(null, { status: 404 });
  }

  const deployPhase = c.env.PRISM_DEPLOY_PHASE;
  if (deployPhase === "maintenance" || deployPhase === "verify") {
    return new Response(null, { status: 503 });
  }

  const url = new URL(c.req.url);
  if (!isAssetEligiblePath(url.pathname)) {
    return new Response(null, { status: 404 });
  }

  const response = await assets.fetch(c.req.raw);
  if (response.status === 404 && c.req.header("accept")?.includes("text/html")) {
    const rootRequest = new Request(new URL("/", c.req.url), c.req.raw);
    return assets.fetch(rootRequest);
  }

  return response;
});
