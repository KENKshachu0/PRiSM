import app from "./app.js";
import {
  deploymentControl,
  isDeploymentMaintenance,
  maintenanceResponse,
} from "./deployment-gate.js";
import { dispatchToRelay, relayGateway } from "./gateway/machine-relay-gateway.js";
import { purgeExpiredPlatformState } from "./tasks/cron-handlers.js";
import { isAssetEligiblePath } from "./routes/web-assets.js";
import type { Env } from "./bindings.js";

export const worker = {
  async scheduled(
    _event: ScheduledController | { scheduledTime?: number; cron?: string },
    env: Env,
  ): Promise<void> {
    if (await isDeploymentMaintenance(env)) return;
    await purgeExpiredPlatformState(env);
  },

  async fetch(
    request: Request,
    env: Env,
    ctx?: ExecutionContext,
  ): Promise<Response> {
    const control = await deploymentControl(
      request,
      env,
      async () =>
        app.fetch(
          new Request(new URL("/api/v1/health", request.url)),
          env,
          ctx,
        ),
    );
    if (control) return control;

    const path = new URL(request.url).pathname;

    if (
      env.ASSETS &&
      env.PRISM_DEPLOY_PHASE !== "maintenance" &&
      env.PRISM_DEPLOY_PHASE !== "verify" &&
      ["GET", "HEAD"].includes(request.method) &&
      isAssetEligiblePath(path)
    ) {
      return env.ASSETS.fetch(request);
    }

    try {
      if (await isDeploymentMaintenance(env)) {
        return maintenanceResponse(request);
      }
    } catch {
      return maintenanceResponse(request);
    }

    // Device relay upgrades. Handled before app.fetch because this is a bare
    // WebSocket upgrade, not a JSON route, and it must win over the static-asset
    // gate above. A device retries on 5xx but treats 401 as permanent, so an
    // offline platform during maintenance is a clean, non-fatal interruption.
    const relay = await relayGateway(request, env);
    if (relay.kind === "rejected") return relay.response;
    if (relay.kind === "dispatch") {
      return dispatchToRelay(request, env, relay);
    }

    const startedAt = performance.now();
    const response = await app.fetch(request, env, ctx);

    if (response.status >= 500 || Math.random() < 0.01) {
      const route = path.startsWith("/t/")
        ? "/t/:shop/:machine"
        : path.startsWith("/api/v1/devices/session/")
        ? path
        : path.startsWith("/api/v1/machines/")
        ? "/api/v1/machines/:action"
        : path.startsWith("/api/v1/shops/")
        ? "/api/v1/shops/:shop"
        : "/other";
      console.log(
        JSON.stringify({
          event: "api_request",
          route,
          method: request.method,
          status: response.status,
          durationMs: Math.round(performance.now() - startedAt),
        }),
      );
    }

    if (
      (path === "/api/v1/health" || path === "/health") &&
      env.PRISM_DEPLOY_REVISION
    ) {
      const headers = new Headers(response.headers);
      headers.set("x-prism-revision", env.PRISM_DEPLOY_REVISION);
      return new Response(response.body, { status: response.status, headers });
    }

    return response;
  },
};

export default worker;
export { LiveBilling } from "./durable-objects/live-billing.js";
export { MachineRelay } from "./durable-objects/machine-relay.js";
export { ShopHub } from "./durable-objects/shop-hub.js";
