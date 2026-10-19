import { Hono } from "hono";
import type { AppBindings } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { getShop, getShopDeps } from "../../middleware/tenant.js";
import {
  botRequest,
  guardIntegration,
  integrationRouter,
} from "../../routes/shops/integration.js";
import {
  toDeviceCommandView,
  toPlayerCheckoutResultView,
} from "../../routes/shops/views.js";

export const legacyIntegrationRouter = new Hono<AppBindings>();

// Enforce bot integration authentication and billing verification on all legacy integration routes
legacyIntegrationRouter.use("*", async (c, next) => {
  await guardIntegration(c);
  await next();
});

// Legacy-specific integration overrides and device actions
legacyIntegrationRouter.post(
  "/players/by-identity/checkout/override",
  async (c) => {
    const deps = getShopDeps(c);
    const body = await c.req.json<any>();
    if (!deps.staffCheckoutCommands?.checkoutWithOverride) {
      jsonError(
        503,
        "Integration checkout override is not configured.",
        "INTEGRATION_CHECKOUT_OVERRIDE_NOT_CONFIGURED",
      );
    }
    const result = await deps.integrationCommands.checkoutWithOverrideByIdentity({
      ...botRequest(c, body),
    });
    return c.json(toPlayerCheckoutResultView(result));
  },
);

legacyIntegrationRouter.post(
  "/players/by-identity/device-actions",
  async (c) => {
    const deps = getShopDeps(c);
    const body = await c.req.json<any>();
    const action = await deps.integrationCommands.requestDeviceActionByIdentity({
      ...botRequest(c, body),
    });
    return c.json({
      action: toDeviceCommandView(action),
    });
  },
);

// Alias /devices/states to /device-states
legacyIntegrationRouter.get("/devices/states", async (c) => {
  const deps = getShopDeps(c);
  const states = deps.staffQueries.listDeviceStates
    ? await deps.staffQueries.listDeviceStates()
    : [];
  return c.json({ deviceStates: states });
});

// Mount the canonical integration router
legacyIntegrationRouter.route("/", integrationRouter);
