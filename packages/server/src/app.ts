import { errorResponse } from "./http-errors.js";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { PrismDomainError } from "@prism/core";
import type { AppBindings } from "./bindings.js";
import { corsMiddleware } from "./middleware/cors.js";
import { attachUser } from "./middleware/auth.js";
import { responseTimeMiddleware, unwrapLegacyResponse } from "./middleware/response-time.js";
import { serveWebAssets } from "./routes/web-assets.js";

// Platform and system routers
import { authRouter } from "./routes/platform/auth.js";
import { passkeysRouter } from "./routes/platform/passkeys.js";
import { userRouter } from "./routes/platform/user.js";
import { shopsRouter } from "./routes/platform/shops.js";
import { adminManagementRouter } from "./routes/platform/admin-management.js";
import { merchantMembersRouter } from "./routes/platform/merchant-members.js";
import { merchantResourceRouter } from "./routes/platform/merchant-resources.js";
import { merchantResourceGroupRouter } from "./routes/platform/merchant-resource-groups.js";
import { merchantHaRouter } from "./routes/platform/merchant-ha.js";
import { merchantIdleRouter } from "./routes/platform/merchant-idle.js";
import { cardsRouter } from "./routes/platform/cards.js";
import { resourceTicketRouter, resourceQrRouter } from "./routes/platform/resource-ticket.js";
import { machineLoginRouter } from "./routes/platform/machine-login.js";
import { resourceSessionRouter, merchantResourceActionRouter } from "./routes/platform/resource-session.js";
import { appleAppSiteAssociationResponse, androidAssetLinksResponse } from "./routes/platform/apple.js";
import { munetAuthRouter, appclipAuthRouter, munetCallbackRouter } from "./routes/platform/munet-routes.js";
import { healthRouter } from "./routes/system/health.js";
import { versionRouter } from "./routes/system/version.js";

// Multi-tenant shop router
import { shopRouter } from "./routes/shops/index.js";
import { integrationSocketRouter } from "./routes/shops/integration.js";
import { shopDataAdminRouter } from "./routes/shops/data/index.js";

// Legacy fallback router
import { legacyRouter } from "./legacy/router.js";

export function createApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  // Centralized error handler
  app.onError((err, c) => errorResponse(c, err, "app"));

  // Preserve original universal-link and Android-app-link association endpoints.
  app.get("/.well-known/apple-app-site-association", (c) => {
    if (!c.env.APPLE_TEAM_ID) return new Response(null, { status: 404 });
    return appleAppSiteAssociationResponse(c.env.APPLE_TEAM_ID);
  });
  app.get("/.well-known/assetlinks.json", (c) => androidAssetLinksResponse(c.env.ANDROID_CERT_FINGERPRINTS));

  // Global middleware
  app.use("*", corsMiddleware);
  // Preserve the public /api/v1 contract: { data } envelopes and shop-local event timestamps.
  app.use("/api/v1/*", responseTimeMiddleware);
  app.use("*", async (c, next) => {
    const start = performance.now();
    await next();
    // Setting a header rebuilds the response, which a WebSocket handshake (101) cannot survive.
    if (c.res.status === 101) return;
    const durationMs = Math.round(performance.now() - start);
    c.header("x-response-time", `${durationMs}ms`);
  });
  app.use("*", attachUser);
  app.use("*", serveWebAssets());

  // Before consolidation, /api/* aliases rewrote to /api/v1/* and returned
  // unwrapped legacy JSON. Preserve that behaviour without shadowing v1 routes.
  app.all("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/v1/")) return next();
    const url = new URL(c.req.url);
    url.pathname = url.pathname.replace(/^\/api\//, "/api/v1/");
    const response = await app.fetch(new Request(url, c.req.raw), c.env, (() => {
      try { return c.executionCtx; } catch { return undefined; }
    })());
    const legacy = await unwrapLegacyResponse(response);
    // The pre-merge /api/* shim returned string errors for non-v1 callers.
    if (!legacy.ok && legacy.headers.get("content-type")?.includes("application/json")) {
      const error = await legacy.json() as { error?: { message?: string } | string };
      const message = typeof error.error === "string"
        ? error.error : error.error?.message ?? "请求失败";
      return c.json({ error: message }, legacy.status as 400);
    }
    return legacy;
  });

  // System routes
  app.route("/health", healthRouter);
  app.route("/api/v1/health", healthRouter);
  app.route("/version", versionRouter);
  app.route("/api/v1/version", versionRouter);

  // Platform routes
  app.route("/api/v1/auth", authRouter);
  app.route("/api/v1/auth", munetAuthRouter);
  app.route("/api/v1/appclip/auth", appclipAuthRouter);
  app.route("/callback", munetCallbackRouter);
  app.route("/api/v1/passkeys", passkeysRouter);
  // Mount /account through /api/v1 only: mounting the entire userRouter at
  // /api/v1/account shadows the account overview with its GET "/" profile route.
  app.route("/api/v1/user", userRouter);
  app.route("/api/v1", userRouter);
  app.route("/api/v1/merchant/shops", shopsRouter);
  app.route("/api/v1/merchant", merchantMembersRouter);
  app.route("/api/v1/merchant", merchantResourceRouter);
  app.route("/api/v1/merchant", merchantResourceGroupRouter);
  app.route("/api/v1/merchant", merchantHaRouter);
  app.route("/api/v1/merchant", merchantIdleRouter);
  app.route("/api/v1/admin", adminManagementRouter);
  app.route("/api/v1/admin", shopDataAdminRouter);
  app.route("/api/v1/cards", cardsRouter);
  app.route("/api/v1/machines", resourceTicketRouter);
  app.route("/api/v1/machines", machineLoginRouter);
  app.route("/api/v1/devices", resourceSessionRouter);
  app.route("/api/v1/merchant", merchantResourceActionRouter);
  app.route("/t", resourceQrRouter);

  // A bot's connection names its shop in its credential, as a device's does.
  app.route("/integration", integrationSocketRouter);

  // Multi-tenant shop routes (/api/v1/shops/:shopCode)
  app.route("/api/v1/shops/:shopCode", shopRouter);

  // Platform shop routes (/api/v1/shops)
  app.route("/api/v1/shops", shopsRouter);

  // Legacy fallback router (/api/v1/player/*, /api/v1/staff/*, /rpc/*, etc.)
  app.route("/", legacyRouter);

  // 404 fallback
  app.notFound((c) => {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "Not found",
        },
      },
      404,
    );
  });

  return app;
}

export const app = createApp();
export default app;
