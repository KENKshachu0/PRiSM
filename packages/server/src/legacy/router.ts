import { errorResponse } from "../http-errors.js";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { PrismDomainError } from "@prism/core";
import type { AppBindings } from "../bindings.js";
import { attachUser } from "../middleware/auth.js";
import { legacyDeprecationMiddleware } from "./middleware.js";
import { legacyTenantMiddleware } from "./tenant-resolver.js";
import { legacyPlayerRouter } from "./handlers/player.js";
import { legacyStaffRouter } from "./handlers/staff.js";
import { legacyIntegrationRouter } from "./handlers/integration.js";
import { legacySetupRouter } from "./handlers/setup.js";
import { legacyAdminRouter, legacyPlayerAuthRouter } from "./handlers/admin.js";
import { legacyBotRouter } from "./handlers/bot.js";
import { createLegacyRpcRouter } from "./rpc-fallback.js";

export const legacyRouter = new Hono<AppBindings>();

// Centralized error mapping for domain and HTTP exceptions
legacyRouter.onError((err, c) => errorResponse(c, err, "legacyRouter"));

// Middleware stack for all legacy endpoints
legacyRouter.use("*", attachUser);
legacyRouter.use("*", legacyDeprecationMiddleware);
legacyRouter.use("*", legacyTenantMiddleware);

// Assemble modular sub-routes
const legacySubRouter = new Hono<AppBindings>();
legacySubRouter.route("/player", legacyPlayerRouter);
legacySubRouter.route("/staff", legacyStaffRouter);
legacySubRouter.route("/integration", legacyIntegrationRouter);
legacySubRouter.route("/setup", legacySetupRouter);
legacySubRouter.route("/admin", legacyAdminRouter);
legacySubRouter.route("/player-auth", legacyPlayerAuthRouter);
legacySubRouter.route("/bot", legacyBotRouter);

// Support both /api/v1/* path prefix and root-mounted /player, /staff, etc.
legacyRouter.route("/api/v1", legacySubRouter);
legacyRouter.route("/", legacySubRouter);

// Mount /rpc/* fallback router
legacyRouter.route("/rpc", createLegacyRpcRouter(legacyRouter));
