import { Hono } from "hono";
import { z } from "zod";
import { simulateBilling } from "@prism/application";
import type { AppBindings } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { staffPrincipal } from "../../middleware/auth.js";
import { getShop, getShopDeps } from "../../middleware/tenant.js";
import { toPricingConfigManagementView, toStaffPricingExtensionView } from "./views.js";

export const pricingRouter = new Hono<AppBindings>();

const relationsInput = z.object({
  requires: z.array(z.string().min(1)).max(50),
  conflicts: z.array(z.string().min(1)).max(50),
}).strict();

// List Pricing Configs
pricingRouter.get("/", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  const configs = await deps.staffPricingCommands.listPricingConfigs();
  return c.json({ pricingConfigs: configs.map(toPricingConfigManagementView) });
});

// Read-only quote of arbitrary overlapping sessions, using current shop pricing.
pricingRouter.post("/simulate/preview", async (c) => {
  const shop = getShop(c);
  const principal = await staffPrincipal(c, shop);
  if (principal.staffRole === "viewer") {
    jsonError(403, "Write permission required.", "FORBIDDEN");
  }
  const body = z.object({
    sessions: z.array(z.object({
      startedAt: z.string(),
      endedAt: z.string(),
      pricingConfigId: z.string().min(1),
    })).min(1).max(30),
  }).parse(await c.req.json());
  const configs = await getShopDeps(c).staffPricingCommands.listPricingConfigs();
  return c.json(await simulateBilling({
    sessions: body.sessions,
    pricingConfigs: configs,
    timeZone: shop.time_zone || "UTC",
  }));
});

// Create Pricing Config
pricingRouter.post("/", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const config = await deps.staffPricingCommands.createPricingConfig({
    kind: body.kind,
    name: body.name,
    enabled: body.enabled ?? true,
    provider: body.provider,
    relations: relationsInput.optional().parse(body.relations),
  });
  return c.json({ pricingConfig: toPricingConfigManagementView(config) }, 201);
});

// Pricing Extensions
pricingRouter.get("/extensions", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  const commandsWithExtensions = deps.staffPricingCommands as {
    listPricingExtensions?: () => Promise<any[]>;
  };
  const extensions = commandsWithExtensions.listPricingExtensions
    ? await commandsWithExtensions.listPricingExtensions()
    : [];
  return c.json({ pricingExtensions: extensions.map(toStaffPricingExtensionView) });
});

// Single Pricing Config
pricingRouter.get("/:pricingConfigId", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  const config = await deps.repositories.pricingConfigs.findById(c.req.param("pricingConfigId"));
  if (!config) {
    jsonError(404, "Pricing config not found.", "PRICING_CONFIG_NOT_FOUND");
  }
  return c.json({ pricingConfig: toPricingConfigManagementView(config) });
});

// Update Pricing Config
pricingRouter.patch("/:pricingConfigId", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const config = await deps.staffPricingCommands.updatePricingConfig({
    pricingConfigId: c.req.param("pricingConfigId"),
    name: body.name,
    enabled: body.enabled,
    provider: body.provider,
    relations: relationsInput.optional().parse(body.relations),
  });
  return c.json({ pricingConfig: toPricingConfigManagementView(config) });
});

// Archive Pricing Config
pricingRouter.post("/:pricingConfigId/archive", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const config = await deps.staffPricingCommands.archivePricingConfig({
    pricingConfigId: c.req.param("pricingConfigId"),
  });
  return c.json({ pricingConfig: toPricingConfigManagementView(config) });
});

// Restore Pricing Config
pricingRouter.post("/:pricingConfigId/restore", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const config = await deps.staffPricingCommands.restorePricingConfig({
    pricingConfigId: c.req.param("pricingConfigId"),
  });
  return c.json({ pricingConfig: toPricingConfigManagementView(config) });
});

// Pricing Timeline
pricingRouter.get("/:pricingConfigId/timeline", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  const localDate = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    jsonError(400, "Pricing timeline date must use YYYY-MM-DD.", "INVALID_TIMELINE_DATE");
  }
  const timeline = await deps.staffPricingCommands.getPricingTimeline({
    pricingConfigId: c.req.param("pricingConfigId"),
    localDate,
  });
  return c.json({ timeline });
});

// Preview Pricing Timeline
pricingRouter.post("/timeline/preview", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const localDate = body.localDate ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    jsonError(400, "Pricing timeline date must use YYYY-MM-DD.", "INVALID_TIMELINE_DATE");
  }
  const timeline = await deps.staffPricingCommands.previewPricingTimeline({
    localDate,
    displayTimeZone: body.displayTimeZone ?? shop.time_zone,
    provider: body.provider,
  });
  return c.json({ timeline });
});
