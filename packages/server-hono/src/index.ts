import { wrapApiResponse, unwrapLegacyResponse } from "./api-contract";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { PrismDomainError } from "@prism/core";
import { authenticate, forbidden } from "./auth";
import type {
  AdminLoginBody,
  IntegrationCheckoutBody,
  IntegrationCheckoutOverrideBody,
  IntegrationDeviceActionBody,
  IntegrationAssetAdjustmentBody,
  IntegrationWalletAdjustmentBody,
  IntegrationIdentityBody,
  IntegrationRedeemBody,
  IntegrationStartSessionBody,
  IntegrationStopSessionBody,
  PlayerIdentityBody,
  PlayerAuthIdentityBody,
  PlayerAssets,
  PurchaseBusinessItemBody,
  PrismAppDependencies,
  RedeemCodeBody,
  RequestDeviceCommandBody,
  StaffCreateApiTokenBody,
  StaffCreateBusinessItemBody,
  StaffCreatePlayerBody,
  StaffCreatePricingConfigBody,
  StaffCreatePresentBody,
  StaffCreateRedeemCodeBody,
  StaffCreateRedeemCodeBatchBody,
  StaffCreateUserBody,
  StaffCheckoutOverrideBody,
  StaffAdjustAssetsBody,
  StaffWalletAdjustmentBody,
  StaffGrantAssetsBody,
  StaffSaveAssetDefinitionBody,
  StaffSavePricingEffectBody,
  StaffUpdateSettingsBody,
  StaffDeviceActionBody,
  StaffUpdatePricingConfigBody,
  StaffUpdatePlayerStatusBody,
  StaffUpdateUserBody,
  StaffResetUserPasswordBody,
  StaffPreviewPricingTimelineBody,
  SetupInstallBody,
  SessionHistoryListItem,
} from "./types";
import {
  toDeviceCommandView,
  toDeviceStateView,
  toAssetDefinitionManagementView,
  toPricingEffectManagementView,
  toPlayerAssetsView,
  toPlayerIdentityView,
  toGrantAssetsView,
  toPlayerManagementView,
  toPlayerSummaryView,
  toPricingConfigManagementView,
  toBusinessItemManagementView,
  toBusinessItemOrderView,
  toPresentManagementView,
  toRedeemCodeManagementView,
  toRedeemGiftView,
  toPlayerCheckoutPreviewView,
  toPlayerCheckoutResultView,
  toSessionHistoryDetailView,
  toSessionHistoryView,
  toPlayerRedeemRecordsView,
  toStaffReportPlayerView,
  toStaffReportSettlementView,
  toStaffPricingExtensionView,
  toSessionView,
  toStoppedSessionView,
  toStaffReportsSummaryView,
  toStaffActiveSessionView,
  toStaffDeviceCommandView,
  toMachineConnectionView,
  toApiTokenManagementView,
  toStaffUserManagementView,
} from "./views";
import type { Context } from "hono";
import type { Principal } from "./types";
import type { PriorityTimePricingProviderConfig } from "@prism/core";

type StaffPrincipal = Extract<Principal, { role: "staff" }>;
type IntegrationPrincipal = { role: "integration" };

export * from "./api-contract";
export * from "./auth";
export * from "./machine-ws";
export * from "./types";
export * from "./views";

export function createPrismApp(dependencies: PrismAppDependencies): Hono {
  const app = new Hono();
  app.use("/api/v1/*", async (context, next) => {
    await next();
    context.res = await wrapApiResponse(context.res);
  });
  app.all("/rpc/*", async (context) => {
    const url = new URL(context.req.url);
    url.pathname = url.pathname.replace(/^\/rpc\//, "/api/v1/");
    return unwrapLegacyResponse(await app.fetch(new Request(url, context.req.raw)));
  });
  const staffOperations = dependencies.staffOperations;
  const versionInfo = dependencies.versionInfo ?? { version: "dev", revision: "unknown" };

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-PRiSM-Player-Id",
      ],
      exposeHeaders: ["Content-Length"],
      maxAge: 600,
      credentials: true,
    }),
  );

  const staffPrincipal = async (context: Context): Promise<StaffPrincipal | Response> => {
    const principal = await authenticate(
      context.req.header("Authorization"),
      context.req.header("X-PRiSM-Player-Id"),
      dependencies,
    );
    if (!principal || principal.role !== "staff") {
      return forbidden(context, "Staff principal required.");
    }
    return principal;
  };

  const staffWritePrincipal = async (context: Context): Promise<StaffPrincipal | Response> => {
    const principal = await staffPrincipal(context);
    if (principal instanceof Response) return principal;
    if (principal.staffRole !== "owner" && principal.staffRole !== "manager") {
      return forbidden(context, "Staff role manager or owner required.");
    }
    return principal;
  };

  const staffOwnerPrincipal = async (context: Context): Promise<StaffPrincipal | Response> => {
    const principal = await staffPrincipal(context);
    if (principal instanceof Response) return principal;
    if (principal.staffRole !== "owner") {
      return forbidden(context, "Staff role owner required.");
    }
    return principal;
  };

  const integrationPrincipal = async (context: Context): Promise<IntegrationPrincipal | Response> => {
    const principal = await authenticate(
      context.req.header("Authorization"),
      context.req.header("X-PRiSM-Player-Id"),
      dependencies,
    );
    if (!principal || principal.role !== "integration") {
      return forbidden(context, "Integration principal required.");
    }
    return { role: "integration" };
  };

  const integrationCommandsOrError = (context: Context) => {
    if (dependencies.integrationCommands) return dependencies.integrationCommands;
    return context.json(
      {
        error: {
          code: "INTEGRATION_COMMANDS_NOT_CONFIGURED",
          message: "Integration commands are not configured.",
        },
      },
      503,
    );
  };

  const withIntegrationDomainErrors = async (
    context: Context,
    action: () => Promise<Response>,
  ): Promise<Response> => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof PrismDomainError && error.code === "PLAYER_IDENTITY_NOT_FOUND") {
        return context.json(
          {
            error: {
              code: error.code,
              message: error.message,
            },
          },
          404,
        );
      }
      if (error instanceof PrismDomainError && error.code === "INTEGRATION_SESSION_NOT_FOUND") {
        return context.json(
          {
            error: {
              code: error.code,
              message: error.message,
            },
          },
          404,
        );
      }
      throw error;
    }
  };

  app.onError((error, context) => {
    if (error instanceof PrismDomainError) {
      return context.json(
        {
          error: {
            code: error.code,
            message: error.message,
          },
        },
        error.code === "INSUFFICIENT_BALANCE" ? 409 : 400,
      );
    }
    console.error("[prism] unhandled route error:", error);
    return context.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred.",
        },
      },
      500,
    );
  });

  app.get("/health", (context) =>
    context.json({
      ok: true,
      service: "prism-api",
    }),
  );

  app.get("/version", (context) =>
    context.json({
      service: "prism-api",
      ...versionInfo,
    }),
  );

  app.get("/favicon.ico", () => new Response(null, { status: 204 }));

  app.get("/admin", (context) =>
    context.html(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>PRiSM API</title>
          <style>
            body { font-family: system-ui, sans-serif; text-align: center; padding: 50px; background: #fafaf9; color: #44403c; }
            h1 { color: #aa3bff; }
            p { max-width: 500px; margin: 20px auto; line-height: 1.6; }
            code { background: #e7e5e4; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
          </style>
        </head>
        <body>
          <h1>PRiSM API is running</h1>
          <p>The management interface is now fully decoupled from this backend API server.</p>
          <p>Please build and deploy the <code>packages/prism-dashboard</code> package (e.g. via Cloudflare Pages or a local static host) and configure it to connect to this API endpoint: <code>${context.req.url.replace(/\/admin$/, "")}</code>.</p>
        </body>
      </html>
    `)
  );

  app.get("/api/v1/setup/status", async (context) => {
    if (!dependencies.setupCommands) {
      return context.json(
        {
          error: {
            code: "SETUP_NOT_CONFIGURED",
            message: "Setup commands are not configured.",
          },
        },
        503,
      );
    }
    return context.json(await dependencies.setupCommands.getSetupStatus());
  });

  app.post("/api/v1/setup/install", async (context) => {
    if (!dependencies.setupCommands) {
      return context.json(
        {
          error: {
            code: "SETUP_NOT_CONFIGURED",
            message: "Setup commands are not configured.",
          },
        },
        503,
      );
    }
    const body = await context.req.json<SetupInstallBody>();
    const result = await dependencies.setupCommands.install(body);
    return context.json({
      staff: {
        id: result.staffUser.id,
        username: result.staffUser.username,
        displayName: result.staffUser.displayName,
        role: result.staffUser.role,
      },
      apiTokens: result.apiTokens,
    });
  });

  app.post("/api/v1/admin/login", async (context) => {
    if (!dependencies.setupCommands) {
      return context.json(
        {
          error: {
            code: "SETUP_NOT_CONFIGURED",
            message: "Setup commands are not configured.",
          },
        },
        503,
      );
    }
    const body = await context.req.json<AdminLoginBody>();
    const result = await dependencies.setupCommands.login(body);
    return context.json({
      session: {
        token: result.token,
      },
      staff: result.staff,
    });
  });

  app.post("/api/v1/admin/logout", async (context) => {
    const authorization = context.req.header("Authorization");
    const principal = await authenticate(authorization, undefined, dependencies);
    if (!principal || principal.role !== "staff") {
      return forbidden(context, "Staff principal required.");
    }
    const token = authorization?.match(/^Bearer (.+)$/)?.[1];
    if (token) await dependencies.adminAuth?.revokeAdminSession?.(token);
    return context.body(null, 204);
  });

  app.get("/api/v1/staff/me", async (context) => {
    const principal = await staffPrincipal(context);
    if (principal instanceof Response) return principal;
    return context.json({
      staff: {
        id: principal.staffId,
        displayName: principal.displayName ?? principal.staffId,
        role: principal.staffRole,
        canWrite: principal.staffRole === "owner" || principal.staffRole === "manager",
      },
    });
  });

  app.get("/api/v1/staff/users", async (context) => {
    const principal = await staffOwnerPrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffUserCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_USER_COMMANDS_NOT_CONFIGURED",
            message: "Staff user commands are not configured.",
          },
        },
        503,
      );
    }

    const staffUsers = await dependencies.staffUserCommands.listStaffUsers();
    return context.json({
      staffUsers: staffUsers.map(toStaffUserManagementView),
    });
  });

  app.post("/api/v1/staff/users", async (context) => {
    const principal = await staffOwnerPrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffUserCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_USER_COMMANDS_NOT_CONFIGURED",
            message: "Staff user commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<StaffCreateUserBody>();
    const staffUser = await dependencies.staffUserCommands.createStaffUser({
      username: body.username,
      displayName: body.displayName,
      password: body.password,
      role: body.role,
    });
    return context.json({
      staffUser: toStaffUserManagementView(staffUser),
    });
  });

  app.patch("/api/v1/staff/users/:staffUserId", async (context) => {
    const principal = await staffOwnerPrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffUserCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_USER_COMMANDS_NOT_CONFIGURED",
            message: "Staff user commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<StaffUpdateUserBody>();
    const staffUser = await dependencies.staffUserCommands.updateStaffUser({
      staffUserId: context.req.param("staffUserId"),
      displayName: body.displayName,
      role: body.role,
      status: body.status,
    });
    return context.json({
      staffUser: toStaffUserManagementView(staffUser),
    });
  });

  app.post("/api/v1/staff/users/:staffUserId/password", async (context) => {
    const principal = await staffOwnerPrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffUserCommands?.resetStaffUserPassword) {
      return context.json(
        {
          error: {
            code: "STAFF_USER_PASSWORD_RESET_NOT_CONFIGURED",
            message: "Staff user password reset commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<StaffResetUserPasswordBody>();
    const staffUser = await dependencies.staffUserCommands.resetStaffUserPassword({
      staffUserId: context.req.param("staffUserId"),
      password: body.password,
    });
    return context.json({
      staffUser: toStaffUserManagementView(staffUser),
    });
  });

  app.post("/api/v1/player-auth/login/by-identity", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), undefined, dependencies);
    if (!principal || (principal.role !== "integration" && !(principal.role === "staff" && principal.staffRole !== "viewer"))) return forbidden(context, "Trusted identity verification required.");
    if (!dependencies.playerAuthCommands) {
      return context.json(
        {
          error: {
            code: "PLAYER_AUTH_NOT_CONFIGURED",
            message: "Player auth commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<PlayerAuthIdentityBody>();
    const result = await dependencies.playerAuthCommands.loginByIdentity(body);
    return context.json({
      session: {
        token: result.token,
      },
      player: {
        id: result.player.id,
        displayName: result.player.displayName,
        status: result.player.status,
      },
    });
  });

  app.get("/api/v1/player/me", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "player_session") {
      return forbidden(context, "Player principal required.");
    }

    const summary = await dependencies.playerQueries.getPlayerSummary(principal.playerId);
    return context.json(toPlayerSummaryView(summary));
  });

  app.get("/api/v1/player/assets", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "player_session") {
      return forbidden(context, "Player principal required.");
    }
    if (!dependencies.playerQueries.listPlayerAssets) {
      return context.json(
        {
          error: {
            code: "PLAYER_ASSET_QUERIES_NOT_CONFIGURED",
            message: "Player asset queries are not configured.",
          },
        },
        503,
      );
    }

    const assets = await dependencies.playerQueries.listPlayerAssets(principal.playerId);
    return context.json(toPlayerAssetsView(assets));
  });

  app.get("/api/v1/player/sessions/history", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "player_session") {
      return forbidden(context, "Player principal required.");
    }
    if (!dependencies.playerQueries.listPlayerSessionHistory) {
      return context.json(
        {
          error: {
            code: "PLAYER_SESSION_HISTORY_QUERIES_NOT_CONFIGURED",
            message: "Player session history queries are not configured.",
          },
        },
        503,
      );
    }

    const sessions = await dependencies.playerQueries.listPlayerSessionHistory(principal.playerId);
    return context.json(toSessionHistoryView(sessions));
  });

  app.get("/api/v1/player/sessions/:sessionId/history", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "player_session") {
      return forbidden(context, "Player principal required.");
    }
    if (!dependencies.playerQueries.getPlayerSessionHistoryDetail) {
      return context.json(
        {
          error: {
            code: "PLAYER_SESSION_HISTORY_DETAIL_QUERIES_NOT_CONFIGURED",
            message: "Player session history detail queries are not configured.",
          },
        },
        503,
      );
    }

    const session = await dependencies.playerQueries.getPlayerSessionHistoryDetail(
      principal.playerId,
      context.req.param("sessionId"),
    );
    if (!session) {
      return context.json(
        {
          error: {
            code: "SESSION_HISTORY_DETAIL_NOT_FOUND",
            message: "Session history detail was not found.",
          },
        },
        404,
      );
    }

    return context.json(toSessionHistoryDetailView(session));
  });

  app.post("/api/v1/player/session/start", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "player_session") {
      return forbidden(context, "Player principal required.");
    }

    let pricingConfigIds: string[] | undefined = undefined;
    let label: string | undefined = undefined;
    try {
      const body = await context.req.json<{ pricingConfigIds?: string[]; label?: string }>();
      pricingConfigIds = body?.pricingConfigIds;
      label = body?.label;
    } catch (e) {
      // Body may be empty
    }

    const session = await dependencies.playerCommands.startSession({
      playerId: principal.playerId,
      pricingConfigIds,
      label,
    });

    return context.json({
      session: toSessionView(session),
    });
  });

  app.post("/api/v1/player/device-commands", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "player_session") {
      return forbidden(context, "Player principal required.");
    }

    const body = await context.req.json<RequestDeviceCommandBody>();
    const command = await dependencies.playerCommands.requestDeviceCommand({
      playerId: principal.playerId,
      type: body.type,
      target: body.target,
      payload: body.payload,
    });

    return context.json({
      command: toDeviceCommandView(command),
    });
  });

  app.post("/api/v1/player/checkout/preview", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "player_session") {
      return forbidden(context, "Player principal required.");
    }
    if (!dependencies.playerCheckoutCommands) {
      return context.json(
        {
          error: {
            code: "CHECKOUT_NOT_CONFIGURED",
            message: "Checkout commands are not configured.",
          },
        },
        503,
      );
    }

    let sessionId: string | undefined = undefined;
    try {
      const body = await context.req.json<{ sessionId?: string }>();
      sessionId = body?.sessionId;
    } catch (e) {
      // Body may be empty
    }

    const result = await dependencies.playerCheckoutCommands.previewCheckout({
      playerId: principal.playerId,
      sessionId,
    });
    return context.json(toPlayerCheckoutPreviewView(result));
  });

  app.post("/api/v1/player/checkout/confirm", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "player_session") {
      return forbidden(context, "Player principal required.");
    }
    if (!dependencies.playerCheckoutCommands) {
      return context.json(
        {
          error: {
            code: "CHECKOUT_NOT_CONFIGURED",
            message: "Checkout commands are not configured.",
          },
        },
        503,
      );
    }

    let sessionId: string | undefined = undefined;
    try {
      const body = await context.req.json<{ sessionId?: string }>();
      sessionId = body?.sessionId;
    } catch (e) {
      // Body may be empty
    }

    const result = await dependencies.playerCheckoutCommands.checkout({
      playerId: principal.playerId,
      sessionId,
    });
    return context.json(toPlayerCheckoutResultView(result));
  });

  app.post("/api/v1/player/redeem", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "player_session") {
      return forbidden(context, "Player principal required.");
    }
    if (!dependencies.playerRedeemCommands) {
      return context.json(
        {
          error: {
            code: "REDEEM_NOT_CONFIGURED",
            message: "Redeem commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<RedeemCodeBody>();
    const result = await dependencies.playerRedeemCommands.redeemCode({
      playerId: principal.playerId,
      code: body.code,
    });

    return context.json(toRedeemGiftView(result));
  });

  app.post("/api/v1/player/business-items/:businessItemId/purchase", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "player_session") {
      return forbidden(context, "Player principal required.");
    }
    if (!dependencies.businessItemOrderCommands) {
      return context.json(
        {
          error: {
            code: "BUSINESS_ITEM_ORDER_COMMANDS_NOT_CONFIGURED",
            message: "Business item order commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<PurchaseBusinessItemBody>();
    const result = await dependencies.businessItemOrderCommands.purchaseBusinessItem({
      playerId: principal.playerId,
      businessItemId: context.req.param("businessItemId"),
      metadata: body.metadata ?? null,
    });
    return context.json({
      businessItemOrder: toBusinessItemOrderView(result.order),
      assetLedgerEntries: result.assetLedgerEntries,
    });
  });

  app.get("/api/v1/player/business-item-orders", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "player_session") {
      return forbidden(context, "Player principal required.");
    }
    if (!dependencies.businessItemOrderCommands) {
      return context.json(
        {
          error: {
            code: "BUSINESS_ITEM_ORDER_COMMANDS_NOT_CONFIGURED",
            message: "Business item order commands are not configured.",
          },
        },
        503,
      );
    }

    const orders = await dependencies.businessItemOrderCommands.listPlayerBusinessItemOrders({
      playerId: principal.playerId,
    });
    return context.json({
      businessItemOrders: orders.map(toBusinessItemOrderView),
    });
  });

  app.post("/api/v1/bot/identities/resolve", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "integration") {
      return forbidden(context, "Bot principal required.");
    }
    if (!dependencies.staffPlayerCommands?.resolvePlayerIdentity) {
      return context.json(
        {
          error: {
            code: "PLAYER_IDENTITY_COMMANDS_NOT_CONFIGURED",
            message: "Player identity commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<PlayerIdentityBody>();
    const player = await dependencies.staffPlayerCommands.resolvePlayerIdentity({
      provider: body.provider,
      subject: body.subject,
    });
    if (!player) {
      return context.json(
        {
          error: {
            code: "PLAYER_IDENTITY_NOT_FOUND",
            message: "Player identity was not found.",
          },
        },
        404,
      );
    }

    return context.json({
      player: toPlayerManagementView(player),
    });
  });

  app.post("/api/v1/integration/players/by-identity/resolve", async (context) => {
    const principal = await integrationPrincipal(context);
    if (principal instanceof Response) return principal;
    const integrationCommands = integrationCommandsOrError(context);
    if (integrationCommands instanceof Response) return integrationCommands;

    const body = await context.req.json<IntegrationIdentityBody>();
    return withIntegrationDomainErrors(context, async () => {
      const player = await integrationCommands.resolvePlayerByIdentity(body);
      return context.json({
        player: toPlayerManagementView(player),
      });
    });
  });

  app.post("/api/v1/integration/players/by-identity/register", async (context) => {
    const principal = await integrationPrincipal(context);
    if (principal instanceof Response) return principal;
    const integrationCommands = integrationCommandsOrError(context);
    if (integrationCommands instanceof Response) return integrationCommands;

    const body = await context.req.json<IntegrationIdentityBody>();
    const player = await integrationCommands.resolveOrRegisterPlayerByIdentity({
      ...body,
      autoRegister: true,
    });
    return context.json({
      player: toPlayerManagementView(player),
    });
  });

  app.post("/api/v1/integration/players/by-identity/session/start", async (context) => {
    const principal = await integrationPrincipal(context);
    if (principal instanceof Response) return principal;
    const integrationCommands = integrationCommandsOrError(context);
    if (integrationCommands instanceof Response) return integrationCommands;

    const body = await context.req.json<IntegrationStartSessionBody>();
    return withIntegrationDomainErrors(context, async () => {
      const session = await integrationCommands.startSessionByIdentity(body);
      return context.json({
        session: toSessionView(session),
      });
    });
  });

  app.post("/api/v1/integration/players/by-identity/checkout/preview", async (context) => {
    const principal = await integrationPrincipal(context);
    if (principal instanceof Response) return principal;
    const integrationCommands = integrationCommandsOrError(context);
    if (integrationCommands instanceof Response) return integrationCommands;

    const body = await context.req.json<IntegrationCheckoutBody>();
    return withIntegrationDomainErrors(context, async () => {
      const result = await integrationCommands.previewCheckoutByIdentity(body);
      return context.json(toPlayerCheckoutPreviewView(result));
    });
  });

  app.post("/api/v1/integration/players/by-identity/checkout/confirm", async (context) => {
    const principal = await integrationPrincipal(context);
    if (principal instanceof Response) return principal;
    const integrationCommands = integrationCommandsOrError(context);
    if (integrationCommands instanceof Response) return integrationCommands;

    const body = await context.req.json<IntegrationCheckoutBody>();
    return withIntegrationDomainErrors(context, async () => {
      const result = await integrationCommands.confirmCheckoutByIdentity(body);
      return context.json(toPlayerCheckoutResultView(result));
    });
  });

  app.post("/api/v1/integration/players/by-identity/sessions/:sessionId/stop", async (context) => {
    const principal = await integrationPrincipal(context);
    if (principal instanceof Response) return principal;
    const integrationCommands = integrationCommandsOrError(context);
    if (integrationCommands instanceof Response) return integrationCommands;

    const body = await context.req.json<IntegrationStopSessionBody>();
    return withIntegrationDomainErrors(context, async () => {
      const session = await integrationCommands.stopSessionByIdentity({
        ...body,
        sessionId: context.req.param("sessionId"),
      });
      return context.json(toStoppedSessionView(session));
    });
  });

  app.post("/api/v1/integration/players/by-identity/wallet", async (context) => {
    const principal = await integrationPrincipal(context);
    if (principal instanceof Response) return principal;
    const integrationCommands = integrationCommandsOrError(context);
    if (integrationCommands instanceof Response) return integrationCommands;

    const body = await context.req.json<IntegrationIdentityBody>();
    return withIntegrationDomainErrors(context, async () => {
      const wallet = await integrationCommands.getWalletByIdentity(body);
      return context.json({ wallet });
    });
  });

  app.post("/api/v1/integration/players/by-identity/assets", async (context) => {
    const principal = await integrationPrincipal(context);
    if (principal instanceof Response) return principal;
    const integrationCommands = integrationCommandsOrError(context);
    if (integrationCommands instanceof Response) return integrationCommands;

    const body = await context.req.json<IntegrationIdentityBody>();
    return withIntegrationDomainErrors(context, async () => {
      const assets = await integrationCommands.getAssetsByIdentity(body);
      return context.json(toPlayerAssetsView(assets as PlayerAssets));
    });
  });

  app.post("/api/v1/integration/players/by-identity/history", async (context) => {
    const principal = await integrationPrincipal(context);
    if (principal instanceof Response) return principal;
    const integrationCommands = integrationCommandsOrError(context);
    if (integrationCommands instanceof Response) return integrationCommands;

    const body = await context.req.json<IntegrationIdentityBody>();
    return withIntegrationDomainErrors(context, async () => {
      const sessions = await integrationCommands.getHistoryByIdentity(body);
      return context.json(toSessionHistoryView(sessions as SessionHistoryListItem[]));
    });
  });

  app.post("/api/v1/integration/players/by-identity/redeem", async (context) => {
    const principal = await integrationPrincipal(context);
    if (principal instanceof Response) return principal;
    const integrationCommands = integrationCommandsOrError(context);
    if (integrationCommands instanceof Response) return integrationCommands;

    const body = await context.req.json<IntegrationRedeemBody>();
    return withIntegrationDomainErrors(context, async () => {
      const result = await integrationCommands.redeemByIdentity(body);
      return context.json(toRedeemGiftView(result));
    });
  });

  app.post("/api/v1/integration/players/by-identity/assets/adjustments", async (context) => {
    const principal = await integrationPrincipal(context);
    if (principal instanceof Response) return principal;
    const integrationCommands = integrationCommandsOrError(context);
    if (integrationCommands instanceof Response) return integrationCommands;
    if (!dependencies.staffAssetCommands) return context.json({ error: { code: "INTEGRATION_ASSET_COMMANDS_NOT_CONFIGURED", message: "Integration asset commands are not configured." } }, 503);
    const body = await context.req.json<IntegrationAssetAdjustmentBody>();
    return withIntegrationDomainErrors(context, async () => {
      const result = await integrationCommands.adjustAssetsByIdentity({
        ...body,
        adjustments: body.adjustments.map((adjustment) => ({
          ...adjustment,
          activeAt: parseOptionalDate(adjustment.activeAt),
          expiresAt: parseOptionalDate(adjustment.expiresAt),
        })),
      });
      return context.json(toGrantAssetsView(result));
    });
  });

  app.post("/api/v1/integration/players/by-identity/wallet/adjustment", async (context) => {
    const principal = await integrationPrincipal(context);
    if (principal instanceof Response) return principal;
    const integrationCommands = integrationCommandsOrError(context);
    if (integrationCommands instanceof Response) return integrationCommands;
    const body = await context.req.json<IntegrationWalletAdjustmentBody>();
    return withIntegrationDomainErrors(context, async () =>
      context.json(await integrationCommands.adjustWalletByIdentity(body)));
  });

  app.post("/api/v1/integration/players/by-identity/checkout/override", async (context) => {
    const principal = await integrationPrincipal(context);
    if (principal instanceof Response) return principal;
    const integrationCommands = integrationCommandsOrError(context);
    if (integrationCommands instanceof Response) return integrationCommands;
    if (!dependencies.staffCheckoutCommands?.checkoutWithOverride) return context.json({ error: { code: "INTEGRATION_CHECKOUT_OVERRIDE_NOT_CONFIGURED", message: "Integration checkout override is not configured." } }, 503);
    const body = await context.req.json<IntegrationCheckoutOverrideBody>();
    return withIntegrationDomainErrors(context, async () => {
      const result = await integrationCommands.checkoutWithOverrideByIdentity(body);
      return context.json(toPlayerCheckoutResultView(result));
    });
  });

  app.post("/api/v1/integration/players/by-identity/device-actions", async (context) => {
    const principal = await integrationPrincipal(context);
    if (principal instanceof Response) return principal;
    const integrationCommands = integrationCommandsOrError(context);
    if (integrationCommands instanceof Response) return integrationCommands;

    const body = await context.req.json<IntegrationDeviceActionBody>();
    return withIntegrationDomainErrors(context, async () => {
      const action = await integrationCommands.requestDeviceActionByIdentity(body);
      return context.json({
        action: toDeviceCommandView(action),
      });
    });
  });

  app.get("/api/v1/integration/sessions/active", async (context) => {
    const principal = await integrationPrincipal(context);
    if (principal instanceof Response) return principal;

    if (!dependencies.staffQueries.listActiveSessions) {
      return context.json(
        {
          error: {
            code: "INTEGRATION_ACTIVE_SESSION_QUERIES_NOT_CONFIGURED",
            message: "Active session queries are not configured.",
          },
        },
        503,
      );
    }

    const sessions = await dependencies.staffQueries.listActiveSessions();
    return context.json({
      sessions: sessions.map(toStaffActiveSessionView),
    });
  });

  app.get("/api/v1/integration/device-states", async (context) => {
    const principal = await integrationPrincipal(context);
    if (principal instanceof Response) return principal;

    if (!dependencies.staffQueries.listDeviceStates) {
      return context.json(
        {
          error: {
            code: "INTEGRATION_DEVICE_STATE_QUERIES_NOT_CONFIGURED",
            message: "Device state queries are not configured.",
          },
        },
        503,
      );
    }

    const states = await dependencies.staffQueries.listDeviceStates();
    return context.json({
      deviceStates: states.map(toDeviceStateView),
    });
  });

  app.get("/api/v1/staff/settings", async (context) => {
    const principal = await staffPrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffSettingsCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_SETTINGS_COMMANDS_NOT_CONFIGURED",
            message: "Staff settings commands are not configured.",
          },
        },
        503,
      );
    }

    return context.json({
      settings: await dependencies.staffSettingsCommands.getSettings(),
    });
  });

  app.put("/api/v1/staff/settings", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffSettingsCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_SETTINGS_COMMANDS_NOT_CONFIGURED",
            message: "Staff settings commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<StaffUpdateSettingsBody>();
    return context.json({
      settings: await dependencies.staffSettingsCommands.updateSettings(body),
    });
  });

  app.get("/api/v1/staff/api-tokens", async (context) => {
    const principal = await staffPrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffApiTokenCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_API_TOKEN_COMMANDS_NOT_CONFIGURED",
            message: "Staff API token commands are not configured.",
          },
        },
        503,
      );
    }

    const apiTokens = await dependencies.staffApiTokenCommands.listApiTokens();
    return context.json({
      apiTokens: apiTokens.map(toApiTokenManagementView),
    });
  });

  app.post("/api/v1/staff/api-tokens", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffApiTokenCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_API_TOKEN_COMMANDS_NOT_CONFIGURED",
            message: "Staff API token commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<StaffCreateApiTokenBody>();
    const apiToken = await dependencies.staffApiTokenCommands.createApiToken({
      label: body.label,
      role: body.role,
    });
    return context.json({
      apiToken: {
        ...toApiTokenManagementView(apiToken),
        token: apiToken.token,
      },
    });
  });

  app.post("/api/v1/staff/api-tokens/:tokenId/revoke", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffApiTokenCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_API_TOKEN_COMMANDS_NOT_CONFIGURED",
            message: "Staff API token commands are not configured.",
          },
        },
        503,
      );
    }

    const apiToken = await dependencies.staffApiTokenCommands.revokeApiToken({
      tokenId: context.req.param("tokenId"),
    });
    return context.json({
      apiToken: toApiTokenManagementView(apiToken),
    });
  });

  app.get("/api/v1/staff/players", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "staff") {
      return forbidden(context, "Staff principal required.");
    }

    const players = await dependencies.staffQueries.listPlayers();
    return context.json({
      players,
    });
  });

  app.get("/api/v1/staff/players/:playerId/assets", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "staff") {
      return forbidden(context, "Staff principal required.");
    }
    if (!dependencies.staffQueries.getPlayerAssets) {
      return context.json(
        {
          error: {
            code: "STAFF_PLAYER_ASSET_QUERIES_NOT_CONFIGURED",
            message: "Staff player asset queries are not configured.",
          },
        },
        503,
      );
    }

    const assets = await dependencies.staffQueries.getPlayerAssets(context.req.param("playerId"));
    return context.json(toPlayerAssetsView(assets));
  });

  app.get("/api/v1/staff/players/:playerId/sessions/history", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "staff") {
      return forbidden(context, "Staff principal required.");
    }
    if (!dependencies.staffQueries.getPlayerSessionHistory) {
      return context.json(
        {
          error: {
            code: "STAFF_PLAYER_SESSION_HISTORY_QUERIES_NOT_CONFIGURED",
            message: "Staff player session history queries are not configured.",
          },
        },
        503,
      );
    }

    const sessions = await dependencies.staffQueries.getPlayerSessionHistory(context.req.param("playerId"));
    return context.json(toSessionHistoryView(sessions));
  });

  app.get("/api/v1/staff/players/:playerId/sessions/:sessionId/history", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "staff") {
      return forbidden(context, "Staff principal required.");
    }
    if (!dependencies.staffQueries.getPlayerSessionHistoryDetail) {
      return context.json(
        {
          error: {
            code: "STAFF_PLAYER_SESSION_HISTORY_DETAIL_QUERIES_NOT_CONFIGURED",
            message: "Staff player session history detail queries are not configured.",
          },
        },
        503,
      );
    }

    const session = await dependencies.staffQueries.getPlayerSessionHistoryDetail(
      context.req.param("playerId"),
      context.req.param("sessionId"),
    );
    if (!session) {
      return context.json(
        {
          error: {
            code: "SESSION_HISTORY_DETAIL_NOT_FOUND",
            message: "Session history detail was not found.",
          },
        },
        404,
      );
    }

    return context.json(toSessionHistoryDetailView(session));
  });

  app.get("/api/v1/staff/players/:playerId/redeem-records", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "staff") {
      return forbidden(context, "Staff principal required.");
    }
    if (!dependencies.staffQueries.listPlayerRedeemRecords) {
      return context.json(
        {
          error: {
            code: "STAFF_PLAYER_REDEEM_RECORD_QUERIES_NOT_CONFIGURED",
            message: "Staff player redeem record queries are not configured.",
          },
        },
        503,
      );
    }

    const records = await dependencies.staffQueries.listPlayerRedeemRecords(context.req.param("playerId"));
    return context.json(toPlayerRedeemRecordsView(records));
  });

  app.post("/api/v1/staff/players", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffPlayerCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_PLAYER_COMMANDS_NOT_CONFIGURED",
            message: "Staff player commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<StaffCreatePlayerBody>();
    const player = await dependencies.staffPlayerCommands.createPlayer({
      displayName: body.displayName,
      initialGrants: body.initialGrants?.map((grant) => ({
        ...grant,
        activeAt: parseOptionalDate(grant.activeAt),
        expiresAt: parseOptionalDate(grant.expiresAt),
      })),
    });
    return context.json({
      player: toPlayerManagementView(player),
    });
  });

  app.patch("/api/v1/staff/players/:playerId/status", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffPlayerCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_PLAYER_COMMANDS_NOT_CONFIGURED",
            message: "Staff player commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<StaffUpdatePlayerStatusBody>();
    const player = await dependencies.staffPlayerCommands.updatePlayerStatus({
      playerId: context.req.param("playerId"),
      status: body.status,
    });
    return context.json({
      player: toPlayerManagementView(player),
    });
  });

  app.post("/api/v1/staff/players/:playerId/identities", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffPlayerCommands?.bindPlayerIdentity) {
      return context.json(
        {
          error: {
            code: "PLAYER_IDENTITY_COMMANDS_NOT_CONFIGURED",
            message: "Player identity commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<PlayerIdentityBody>();
    const identity = await dependencies.staffPlayerCommands.bindPlayerIdentity({
      playerId: context.req.param("playerId"),
      provider: body.provider,
      subject: body.subject,
    });
    return context.json({
      identity: toPlayerIdentityView(identity),
    });
  });

  app.delete("/api/v1/staff/players/:playerId/identities/:provider/:subject", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffPlayerCommands?.deletePlayerIdentity) {
      return context.json(
        {
          error: {
            code: "PLAYER_IDENTITY_COMMANDS_NOT_CONFIGURED",
            message: "Player identity commands are not configured.",
          },
        },
        503,
      );
    }

    await dependencies.staffPlayerCommands.deletePlayerIdentity({
      playerId: context.req.param("playerId"),
      provider: context.req.param("provider"),
      subject: context.req.param("subject"),
    });
    return context.json({ ok: true });
  });

  app.post("/api/v1/staff/players/:playerId/session/start", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;

    const playerId = context.req.param("playerId");
    let pricingConfigIds: string[] | undefined = undefined;
    let label: string | undefined = undefined;
    try {
      const body = await context.req.json<{ pricingConfigIds?: string[]; label?: string }>();
      pricingConfigIds = body?.pricingConfigIds;
      label = body?.label;
    } catch (e) {
      // Body may be empty
    }

    const session = await dependencies.playerCommands.startSession({
      playerId,
      pricingConfigIds,
      label,
    });
    return context.json({
      session: toSessionView(session),
    });
  });

  app.post("/api/v1/staff/players/:playerId/checkout/preview", async (context) => {
    const principal = await staffPrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffCheckoutCommands?.previewCheckout) {
      return context.json(
        {
          error: {
            code: "STAFF_CHECKOUT_PREVIEW_NOT_CONFIGURED",
            message: "Staff checkout preview commands are not configured.",
          },
        },
        503,
      );
    }

    let sessionId: string | undefined = undefined;
    try {
      const body = await context.req.json<{ sessionId?: string }>();
      sessionId = body?.sessionId;
    } catch (e) {
      // Body may be empty
    }

    const result = await dependencies.staffCheckoutCommands.previewCheckout({
      playerId: context.req.param("playerId"),
      sessionId,
    });
    return context.json(toPlayerCheckoutPreviewView(result));
  });

  app.post("/api/v1/staff/players/:playerId/checkout/override", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffCheckoutCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_CHECKOUT_COMMANDS_NOT_CONFIGURED",
            message: "Staff checkout commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<{ total: number; reason: string; sessionId?: string }>();
    const result = await dependencies.staffCheckoutCommands.checkoutWithOverride!({
      playerId: context.req.param("playerId"),
      sessionId: body.sessionId,
      staffId: principal.staffId,
      total: body.total,
      reason: body.reason,
    });
    return context.json(toPlayerCheckoutResultView(result));
  });

  app.post("/api/v1/staff/players/:playerId/checkout/confirm", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffCheckoutCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_CHECKOUT_NOT_CONFIGURED",
            message: "Staff checkout commands are not configured.",
          },
        },
        503,
      );
    }

    let sessionId: string | undefined = undefined;
    try {
      const body = await context.req.json<{ sessionId?: string }>();
      sessionId = body?.sessionId;
    } catch (e) {
      // Body may be empty
    }

    const result = await dependencies.staffCheckoutCommands.checkout({
      playerId: context.req.param("playerId"),
      sessionId,
    });
    return context.json(toPlayerCheckoutResultView(result));
  });

  app.post("/api/v1/staff/players/:playerId/sessions/:sessionId/stop", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffCheckoutCommands?.stopSession) {
      return context.json(
        {
          error: {
            code: "STAFF_SESSION_STOP_COMMANDS_NOT_CONFIGURED",
            message: "Staff session stop commands are not configured.",
          },
        },
        503,
      );
    }

    const session = await dependencies.staffCheckoutCommands.stopSession({
      playerId: context.req.param("playerId"),
      sessionId: context.req.param("sessionId"),
    });
    return context.json(toStoppedSessionView(session));
  });

  app.post("/api/v1/staff/sessions/active/checkout", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffCheckoutCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_CHECKOUT_NOT_CONFIGURED",
            message: "Staff checkout commands are not configured.",
          },
        },
        503,
      );
    }

    const results = await staffOperations.checkoutAllActivePlayers();
    return context.json({
      settlements: results.map(toPlayerCheckoutResultView),
    });
  });

  app.get("/api/v1/staff/live-players", async (context) => {
    const principal = await staffPrincipal(context);
    if (principal instanceof Response) return principal;

    const rows = await staffOperations.listLivePlayers();
    return context.json({
      players: rows,
    });
  });

  app.get("/api/v1/staff/sessions/active", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "staff") {
      return forbidden(context, "Staff principal required.");
    }

    const sessions = await dependencies.staffQueries.listActiveSessions();
    return context.json({
      sessions: sessions.map(toStaffActiveSessionView),
    });
  });


  app.post("/api/v1/staff/device-actions", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffDeviceCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_DEVICE_COMMANDS_NOT_CONFIGURED",
            message: "Staff device commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<StaffDeviceActionBody>();
    const action = await dependencies.staffDeviceCommands.requestDeviceAction({
      staffId: principal.staffId,
      type: body.type,
      target: body.target,
      payload: body.payload,
    });
    return context.json({
      action: toDeviceCommandView(action),
    });
  });

  app.get("/api/v1/staff/device-commands", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "staff") {
      return forbidden(context, "Staff principal required.");
    }
    if (!dependencies.staffQueries.listDeviceCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_DEVICE_COMMAND_QUERIES_NOT_CONFIGURED",
            message: "Staff device command queries are not configured.",
          },
        },
        503,
      );
    }

    const limit = Math.min(Number.parseInt(context.req.query("limit") ?? "50", 10), 200);
    const commands = await dependencies.staffQueries.listDeviceCommands({
      limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
    });
    return context.json({
      commands: commands.map(toStaffDeviceCommandView),
    });
  });

  app.get("/api/v1/staff/device-states", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "staff") {
      return forbidden(context, "Staff principal required.");
    }
    if (!dependencies.staffQueries.listDeviceStates) {
      return context.json(
        {
          error: {
            code: "STAFF_DEVICE_STATE_QUERIES_NOT_CONFIGURED",
            message: "Staff device state queries are not configured.",
          },
        },
        503,
      );
    }

    const states = await dependencies.staffQueries.listDeviceStates();
    return context.json({
      deviceStates: states.map(toDeviceStateView),
    });
  });

  app.get("/api/v1/staff/machine-connections", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "staff") {
      return forbidden(context, "Staff principal required.");
    }
    if (!dependencies.staffQueries.listMachineConnections) {
      return context.json(
        {
          error: {
            code: "STAFF_MACHINE_CONNECTION_QUERIES_NOT_CONFIGURED",
            message: "Staff machine connection queries are not configured.",
          },
        },
        503,
      );
    }

    const connections = await dependencies.staffQueries.listMachineConnections();
    return context.json({
      machineConnections: connections.map(toMachineConnectionView),
    });
  });

  app.get("/api/v1/staff/reports/summary", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "staff") {
      return forbidden(context, "Staff principal required.");
    }
    if (!dependencies.staffQueries.getReportsSummary) {
      return context.json(
        {
          error: {
            code: "STAFF_REPORT_QUERIES_NOT_CONFIGURED",
            message: "Staff report queries are not configured.",
          },
        },
        503,
      );
    }

    const from = parseRequiredDate(context.req.query("from"));
    const to = parseRequiredDate(context.req.query("to"));
    if (!from || !to || from.getTime() >= to.getTime()) {
      return context.json(
        {
          error: {
            code: "INVALID_REPORT_RANGE",
            message: "Report range requires valid from/to ISO dates where from is before to.",
          },
        },
        400,
      );
    }

    const summary = await dependencies.staffQueries.getReportsSummary({ from, to });
    return context.json(toStaffReportsSummaryView(summary));
  });

  app.get("/api/v1/staff/reports/settlements", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "staff") {
      return forbidden(context, "Staff principal required.");
    }
    if (!dependencies.staffQueries.listReportSettlements) {
      return context.json(
        {
          error: {
            code: "STAFF_REPORT_QUERIES_NOT_CONFIGURED",
            message: "Staff settlement report queries are not configured.",
          },
        },
        503,
      );
    }

    const from = parseRequiredDate(context.req.query("from"));
    const to = parseRequiredDate(context.req.query("to"));
    const limit = normalizeLimit(context.req.query("limit"), 50, 200);
    const offset = normalizeOffset(context.req.query("offset"));
    if (!from || !to || from.getTime() >= to.getTime()) {
      return context.json(
        {
          error: {
            code: "INVALID_REPORT_RANGE",
            message: "Report range requires valid from/to ISO dates where from is before to.",
          },
        },
        400,
      );
    }

    const rows = await dependencies.staffQueries.listReportSettlements({ from, to, limit: limit + 1, offset });
    const hasMore = rows.length > limit;
    const settlements = rows.slice(0, limit);
    return context.json({
      settlements: settlements.map(toStaffReportSettlementView),
      page: { limit, offset, hasMore },
    });
  });

  app.get("/api/v1/staff/reports/players", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "staff") {
      return forbidden(context, "Staff principal required.");
    }
    if (!dependencies.staffQueries.listReportPlayers) {
      return context.json(
        {
          error: {
            code: "STAFF_REPORT_QUERIES_NOT_CONFIGURED",
            message: "Staff player report queries are not configured.",
          },
        },
        503,
      );
    }

    const from = parseRequiredDate(context.req.query("from"));
    const to = parseRequiredDate(context.req.query("to"));
    const limit = normalizeLimit(context.req.query("limit"), 20, 100);
    const offset = normalizeOffset(context.req.query("offset"));
    if (!from || !to || from.getTime() >= to.getTime()) {
      return context.json(
        {
          error: {
            code: "INVALID_REPORT_RANGE",
            message: "Report range requires valid from/to ISO dates where from is before to.",
          },
        },
        400,
      );
    }

    const rows = await dependencies.staffQueries.listReportPlayers({ from, to, limit: limit + 1, offset });
    const hasMore = rows.length > limit;
    const players = rows.slice(0, limit);
    return context.json({
      players: players.map(toStaffReportPlayerView),
      page: { limit, offset, hasMore },
    });
  });

  app.get("/api/v1/staff/pricing-configs", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "staff") {
      return forbidden(context, "Staff principal required.");
    }
    if (!dependencies.staffPricingCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_PRICING_COMMANDS_NOT_CONFIGURED",
            message: "Staff pricing commands are not configured.",
          },
        },
        503,
      );
    }

    const pricingConfigs = await dependencies.staffPricingCommands.listPricingConfigs();
    return context.json({
      pricingConfigs: pricingConfigs.map(toPricingConfigManagementView),
    });
  });

  app.get("/api/v1/staff/pricing-extensions", async (context) => {
    const principal = await staffPrincipal(context);
    if (principal instanceof Response) return principal;
    const extensions =
      typeof dependencies.staffPricingExtensions === "function"
        ? await dependencies.staffPricingExtensions()
        : (dependencies.staffPricingExtensions ?? []);

    return context.json({
      pricingExtensions: extensions.map(toStaffPricingExtensionView),
    });
  });

  app.get("/api/v1/staff/pricing-configs/:pricingConfigId/timeline", async (context) => {
    const principal = await staffPrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffPricingCommands?.getPricingTimeline) {
      return context.json(
        {
          error: {
            code: "STAFF_PRICING_TIMELINE_NOT_CONFIGURED",
            message: "Staff pricing timeline commands are not configured.",
          },
        },
        503,
      );
    }
    const localDate = context.req.query("date");
    if (!localDate || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
      return context.json(
        {
          error: {
            code: "INVALID_TIMELINE_DATE",
            message: "Pricing timeline date must use YYYY-MM-DD.",
          },
        },
        400,
      );
    }

    return context.json({
      timeline: await dependencies.staffPricingCommands.getPricingTimeline({
        pricingConfigId: context.req.param("pricingConfigId"),
        localDate,
      }),
    });
  });

  app.post("/api/v1/staff/pricing-timeline/preview", async (context) => {
    const principal = await staffPrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffPricingCommands?.previewPricingTimeline) {
      return context.json(
        {
          error: {
            code: "STAFF_PRICING_TIMELINE_PREVIEW_NOT_CONFIGURED",
            message: "Staff pricing timeline preview commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<StaffPreviewPricingTimelineBody>();
    if (!body.localDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.localDate)) {
      return context.json(
        {
          error: {
            code: "INVALID_TIMELINE_DATE",
            message: "Pricing timeline date must use YYYY-MM-DD.",
          },
        },
        400,
      );
    }

    return context.json({
      timeline: await dependencies.staffPricingCommands.previewPricingTimeline({
        localDate: body.localDate,
        provider: parseRulesProviderBody(body.provider),
      }),
    });
  });

  app.post("/api/v1/staff/pricing-configs", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffPricingCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_PRICING_COMMANDS_NOT_CONFIGURED",
            message: "Staff pricing commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<StaffCreatePricingConfigBody>();
    const pricingConfig = await dependencies.staffPricingCommands.createPricingConfig({
      kind: body.kind,
      name: body.name,
      enabled: body.enabled,
      provider: parsePricingProviderBody(body.provider),
    });
    return context.json({
      pricingConfig: toPricingConfigManagementView(pricingConfig),
    });
  });

  app.patch("/api/v1/staff/pricing-configs/:pricingConfigId", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffPricingCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_PRICING_COMMANDS_NOT_CONFIGURED",
            message: "Staff pricing commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<StaffUpdatePricingConfigBody>();
    const pricingConfig = await dependencies.staffPricingCommands.updatePricingConfig({
      pricingConfigId: context.req.param("pricingConfigId"),
      name: body.name,
      enabled: body.enabled,
      provider: parsePricingProviderBody(body.provider),
    });
    return context.json({
      pricingConfig: toPricingConfigManagementView(pricingConfig),
    });
  });

  app.post("/api/v1/staff/pricing-configs/:pricingConfigId/archive", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffPricingCommands?.archivePricingConfig) {
      return context.json(
        {
          error: {
            code: "STAFF_PRICING_ARCHIVE_NOT_CONFIGURED",
            message: "Staff pricing archive commands are not configured.",
          },
        },
        503,
      );
    }

    const pricingConfig = await dependencies.staffPricingCommands.archivePricingConfig({
      pricingConfigId: context.req.param("pricingConfigId"),
    });
    return context.json({
      pricingConfig: toPricingConfigManagementView(pricingConfig),
    });
  });

  app.post("/api/v1/staff/pricing-configs/:pricingConfigId/restore", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffPricingCommands?.restorePricingConfig) {
      return context.json(
        {
          error: {
            code: "STAFF_PRICING_RESTORE_NOT_CONFIGURED",
            message: "Staff pricing restore commands are not configured.",
          },
        },
        503,
      );
    }

    const pricingConfig = await dependencies.staffPricingCommands.restorePricingConfig({
      pricingConfigId: context.req.param("pricingConfigId"),
    });
    return context.json({
      pricingConfig: toPricingConfigManagementView(pricingConfig),
    });
  });

  app.get("/api/v1/staff/business-items", async (context) => {
    const principal = await staffPrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffBusinessItemCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_BUSINESS_ITEM_COMMANDS_NOT_CONFIGURED",
            message: "Staff business item commands are not configured.",
          },
        },
        503,
      );
    }

    const items = await dependencies.staffBusinessItemCommands.listBusinessItems();
    return context.json({
      businessItems: items.map(toBusinessItemManagementView),
    });
  });

  app.post("/api/v1/staff/business-items", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffBusinessItemCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_BUSINESS_ITEM_COMMANDS_NOT_CONFIGURED",
            message: "Staff business item commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<StaffCreateBusinessItemBody>();
    const item = await dependencies.staffBusinessItemCommands.createBusinessItem({
      kind: body.kind,
      name: body.name,
      price: body.price,
      assetType: body.assetType,
      assetCode: body.assetCode,
      activeAt: parseOptionalDate(body.activeAt),
      expiresAt: parseOptionalDate(body.expiresAt),
      metadata: body.metadata,
    });
    return context.json({
      businessItem: toBusinessItemManagementView(item),
    });
  });

  app.post("/api/v1/staff/business-items/:businessItemId/archive", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffBusinessItemCommands?.archiveBusinessItem) {
      return context.json(
        {
          error: {
            code: "STAFF_BUSINESS_ITEM_ARCHIVE_NOT_CONFIGURED",
            message: "Staff business item archive commands are not configured.",
          },
        },
        503,
      );
    }

    const item = await dependencies.staffBusinessItemCommands.archiveBusinessItem({
      businessItemId: context.req.param("businessItemId"),
    });
    return context.json({
      businessItem: toBusinessItemManagementView(item),
    });
  });

  app.post("/api/v1/staff/business-items/:businessItemId/restore", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffBusinessItemCommands?.restoreBusinessItem) {
      return context.json(
        {
          error: {
            code: "STAFF_BUSINESS_ITEM_RESTORE_NOT_CONFIGURED",
            message: "Staff business item restore commands are not configured.",
          },
        },
        503,
      );
    }

    const item = await dependencies.staffBusinessItemCommands.restoreBusinessItem({
      businessItemId: context.req.param("businessItemId"),
    });
    return context.json({
      businessItem: toBusinessItemManagementView(item),
    });
  });

  app.get("/api/v1/staff/business-item-orders", async (context) => {
    const principal = await staffPrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.businessItemOrderCommands) {
      return context.json(
        {
          error: {
            code: "BUSINESS_ITEM_ORDER_COMMANDS_NOT_CONFIGURED",
            message: "Business item order commands are not configured.",
          },
        },
        503,
      );
    }

    const orders = await dependencies.businessItemOrderCommands.listBusinessItemOrders();
    return context.json({
      businessItemOrders: orders.map(toBusinessItemOrderView),
    });
  });

  app.post("/api/v1/staff/business-item-orders/:orderId/fulfill", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.businessItemOrderCommands) {
      return context.json(
        {
          error: {
            code: "BUSINESS_ITEM_ORDER_COMMANDS_NOT_CONFIGURED",
            message: "Business item order commands are not configured.",
          },
        },
        503,
      );
    }

    const order = await dependencies.businessItemOrderCommands.fulfillBusinessItemOrder({
      orderId: context.req.param("orderId"),
    });
    return context.json({
      businessItemOrder: toBusinessItemOrderView(order),
    });
  });

  app.post("/api/v1/staff/business-item-orders/:orderId/cancel", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.businessItemOrderCommands) {
      return context.json(
        {
          error: {
            code: "BUSINESS_ITEM_ORDER_COMMANDS_NOT_CONFIGURED",
            message: "Business item order commands are not configured.",
          },
        },
        503,
      );
    }

    const order = await dependencies.businessItemOrderCommands.cancelBusinessItemOrder({
      orderId: context.req.param("orderId"),
    });
    return context.json({
      businessItemOrder: toBusinessItemOrderView(order),
    });
  });

  app.get("/api/v1/staff/asset-definitions", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "staff") {
      return forbidden(context, "Staff principal required.");
    }
    if (!dependencies.staffAssetDefinitionCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_ASSET_DEFINITION_COMMANDS_NOT_CONFIGURED",
            message: "Staff asset definition commands are not configured.",
          },
        },
        503,
      );
    }

    const definitions = await dependencies.staffAssetDefinitionCommands.listAssetDefinitions();
    return context.json({
      assetDefinitions: definitions.map(toAssetDefinitionManagementView),
    });
  });

  app.get("/api/v1/staff/pricing-effects", async (context) => {
    const principal = await staffPrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffPricingEffectCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_PRICING_EFFECT_COMMANDS_NOT_CONFIGURED",
            message: "Staff pricing effect commands are not configured.",
          },
        },
        503,
      );
    }

    const effects = await dependencies.staffPricingEffectCommands.listPricingEffects();
    return context.json({
      pricingEffects: effects.map(toPricingEffectManagementView),
    });
  });

  app.put("/api/v1/staff/pricing-effects/:effectId", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffPricingEffectCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_PRICING_EFFECT_COMMANDS_NOT_CONFIGURED",
            message: "Staff pricing effect commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<StaffSavePricingEffectBody>();
    const effect = await dependencies.staffPricingEffectCommands.savePricingEffect({
      id: context.req.param("effectId"),
      name: body.name,
      type: body.type,
      scope: body.scope,
      value: body.value,
      consumable: body.consumable,
      limitPerDay: body.limitPerDay,
      activeAt: parseOptionalDate(body.activeAt),
      expiresAt: parseOptionalDate(body.expiresAt),
      status: body.status,
      config: body.config,
    });
    return context.json({
      pricingEffect: toPricingEffectManagementView(effect),
    });
  });

  app.post("/api/v1/staff/pricing-effects/:effectId/archive", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffPricingEffectCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_PRICING_EFFECT_COMMANDS_NOT_CONFIGURED",
            message: "Staff pricing effect commands are not configured.",
          },
        },
        503,
      );
    }

    const effect = await dependencies.staffPricingEffectCommands.archivePricingEffect({
      effectId: context.req.param("effectId"),
    });
    return context.json({
      pricingEffect: toPricingEffectManagementView(effect),
    });
  });

  app.post("/api/v1/staff/pricing-effects/:effectId/restore", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffPricingEffectCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_PRICING_EFFECT_COMMANDS_NOT_CONFIGURED",
            message: "Staff pricing effect commands are not configured.",
          },
        },
        503,
      );
    }

    const effect = await dependencies.staffPricingEffectCommands.restorePricingEffect({
      effectId: context.req.param("effectId"),
    });
    return context.json({
      pricingEffect: toPricingEffectManagementView(effect),
    });
  });

  app.put("/api/v1/staff/asset-definitions/:assetType/:assetCode", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffAssetDefinitionCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_ASSET_DEFINITION_COMMANDS_NOT_CONFIGURED",
            message: "Staff asset definition commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<StaffSaveAssetDefinitionBody>();
    const definition = await dependencies.staffAssetDefinitionCommands.saveAssetDefinition({
      type: context.req.param("assetType"),
      code: context.req.param("assetCode"),
      name: body.name,
      stackable: body.stackable,
      pricingEffectId: body.pricingEffectId ?? null,
      activeAt: parseOptionalDate(body.activeAt),
      expiresAt: parseOptionalDate(body.expiresAt),
      metadata: body.metadata,
    });
    return context.json({
      assetDefinition: toAssetDefinitionManagementView(definition),
    });
  });

  app.post("/api/v1/staff/asset-definitions/:assetType/:assetCode/archive", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffAssetDefinitionCommands?.archiveAssetDefinition) {
      return context.json(
        {
          error: {
            code: "STAFF_ASSET_DEFINITION_ARCHIVE_NOT_CONFIGURED",
            message: "Staff asset definition archive commands are not configured.",
          },
        },
        503,
      );
    }

    const definition = await dependencies.staffAssetDefinitionCommands.archiveAssetDefinition({
      type: context.req.param("assetType"),
      code: context.req.param("assetCode"),
    });
    return context.json({
      assetDefinition: toAssetDefinitionManagementView(definition),
    });
  });

  app.post("/api/v1/staff/asset-definitions/:assetType/:assetCode/restore", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffAssetDefinitionCommands?.restoreAssetDefinition) {
      return context.json(
        {
          error: {
            code: "STAFF_ASSET_DEFINITION_RESTORE_NOT_CONFIGURED",
            message: "Staff asset definition restore commands are not configured.",
          },
        },
        503,
      );
    }

    const definition = await dependencies.staffAssetDefinitionCommands.restoreAssetDefinition({
      type: context.req.param("assetType"),
      code: context.req.param("assetCode"),
    });
    return context.json({
      assetDefinition: toAssetDefinitionManagementView(definition),
    });
  });

  app.post("/api/v1/staff/players/:playerId/assets/grants", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    const staffAssetCommands = dependencies.staffAssetCommands;
    if (!staffAssetCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_ASSET_COMMANDS_NOT_CONFIGURED",
            message: "Staff asset commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<StaffGrantAssetsBody>();
    if (!Array.isArray(body.grants) || !body.grants.length || body.grants.some(grant => !grant || typeof grant.assetType !== "string" || typeof grant.assetCode !== "string" || !Number.isFinite(grant.amount) || grant.amount <= 0)) {
      return context.json({error:{code:"INVALID_ASSET_GRANT",message:"请选择资产并填写有效数量"}},400);
    }
    const result = await staffAssetCommands.grantAssets({
      staffId: principal.staffId,
      playerId: context.req.param("playerId"),
      reason: body.reason,
      grants: body.grants.map((grant) => ({
        ...grant,
        mergeStrategy: grant.mergeStrategy ?? "stack",
        activeAt: grant.activeAt ? new Date(grant.activeAt) : null,
        expiresAt: grant.expiresAt ? new Date(grant.expiresAt) : null,
      })),
    });

    return context.json(toGrantAssetsView(result));
  });

  app.post("/api/v1/staff/players/:playerId/assets/adjustments", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffAssetCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_ASSET_COMMANDS_NOT_CONFIGURED",
            message: "Staff asset commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<StaffAdjustAssetsBody>();
    const result = await dependencies.staffAssetCommands.adjustAssets({
      staffId: principal.staffId,
      playerId: context.req.param("playerId"),
      adjustments: body.adjustments.map((adjustment) => ({
        ...adjustment,
        activeAt: parseOptionalDate(adjustment.activeAt),
        expiresAt: parseOptionalDate(adjustment.expiresAt),
      })),
    });

    return context.json(toGrantAssetsView(result));
  });

  app.post("/api/v1/staff/players/:playerId/wallet/adjustment", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    const staffAssetCommands = dependencies.staffAssetCommands;
    const adjustWallet = staffAssetCommands?.adjustWallet;
    if (!adjustWallet) {
      return context.json({ error: { code: "STAFF_ASSET_COMMANDS_NOT_CONFIGURED", message: "Staff asset commands are not configured." } }, 503);
    }
    const body = await context.req.json<StaffWalletAdjustmentBody>();
    return withIntegrationDomainErrors(context, async () =>
      context.json(await adjustWallet({
        staffId: principal.staffId,
        playerId: context.req.param("playerId"),
        amount: body.amount,
        reason: body.reason,
      })));
  });

  app.post("/api/v1/staff/presents", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffRedeemCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_REDEEM_COMMANDS_NOT_CONFIGURED",
            message: "Staff redeem commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<StaffCreatePresentBody>();
    const present = await dependencies.staffRedeemCommands.createPresent({
      name: body.name,
      oncePerPlayer: body.oncePerPlayer,
      activeAt: parseOptionalDate(body.activeAt),
      expiresAt: parseOptionalDate(body.expiresAt),
      grants: body.grants.map((grant) => ({
        ...grant,
        activeAt: grant.activeAt ? new Date(grant.activeAt) : null,
        expiresAt: grant.expiresAt ? new Date(grant.expiresAt) : null,
      })),
    });

    return context.json({
      present: toPresentManagementView(present),
    });
  });

  app.get("/api/v1/staff/presents", async (context) => {
    const principal = await staffPrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffRedeemCommands?.listPresents) {
      return context.json(
        {
          error: {
            code: "STAFF_PRESENT_QUERIES_NOT_CONFIGURED",
            message: "Staff present listing commands are not configured.",
          },
        },
        503,
      );
    }

    const presents = await dependencies.staffRedeemCommands.listPresents();
    return context.json({
      presents: presents.map(toPresentManagementView),
    });
  });

  app.post("/api/v1/staff/presents/:presentId/archive", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffRedeemCommands?.archivePresent) {
      return context.json(
        {
          error: {
            code: "STAFF_PRESENT_ARCHIVE_NOT_CONFIGURED",
            message: "Staff present archive commands are not configured.",
          },
        },
        503,
      );
    }

    const present = await dependencies.staffRedeemCommands.archivePresent({
      presentId: context.req.param("presentId"),
    });
    return context.json({
      present: toPresentManagementView(present),
    });
  });

  app.post("/api/v1/staff/presents/:presentId/restore", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffRedeemCommands?.restorePresent) {
      return context.json(
        {
          error: {
            code: "STAFF_PRESENT_RESTORE_NOT_CONFIGURED",
            message: "Staff present restore commands are not configured.",
          },
        },
        503,
      );
    }

    const present = await dependencies.staffRedeemCommands.restorePresent({
      presentId: context.req.param("presentId"),
    });
    return context.json({
      present: toPresentManagementView(present),
    });
  });

  app.post("/api/v1/staff/redeem-codes", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffRedeemCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_REDEEM_COMMANDS_NOT_CONFIGURED",
            message: "Staff redeem commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<StaffCreateRedeemCodeBody>();
    const code = await dependencies.staffRedeemCommands.createRedeemCode({
      code: body.code,
      presentId: body.presentId,
      activeAt: body.activeAt ? new Date(body.activeAt) : null,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      maxUseCount: body.maxUseCount,
    });

    return context.json({
      redeemCode: toRedeemCodeManagementView(code),
    });
  });

  app.get("/api/v1/staff/redeem-codes", async (context) => {
    const principal = await authenticate(context.req.header("Authorization"), context.req.header("X-PRiSM-Player-Id"), dependencies);
    if (!principal || principal.role !== "staff") {
      return forbidden(context, "Staff principal required.");
    }
    if (!dependencies.staffRedeemCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_REDEEM_COMMANDS_NOT_CONFIGURED",
            message: "Staff redeem commands are not configured.",
          },
        },
        503,
      );
    }

    const [codes, redemptions] = await Promise.all([
      dependencies.staffRedeemCommands.listRedeemCodes(),
      dependencies.staffRedeemQueries?.listRedeemCodeRedemptions?.() ?? Promise.resolve([]),
    ]);
    const redemptionsByCodeId = new Map<string, typeof redemptions>();
    for (const redemption of redemptions) {
      const items = redemptionsByCodeId.get(redemption.codeId) ?? [];
      redemptionsByCodeId.set(redemption.codeId, [...items, redemption]);
    }
    return context.json({
      redeemCodes: codes.map((code) => toRedeemCodeManagementView(code, redemptionsByCodeId.get(code.id) ?? [])),
    });
  });

  app.post("/api/v1/staff/redeem-codes/batch", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffRedeemCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_REDEEM_COMMANDS_NOT_CONFIGURED",
            message: "Staff redeem commands are not configured.",
          },
        },
        503,
      );
    }

    const body = await context.req.json<StaffCreateRedeemCodeBatchBody>();
    const codes = await dependencies.staffRedeemCommands.createRedeemCodeBatch({
      prefix: body.prefix,
      presentId: body.presentId,
      activeAt: body.activeAt ? new Date(body.activeAt) : null,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      maxUseCount: body.maxUseCount,
      count: body.count,
    });
    return context.json({
      redeemCodes: codes.map((code) => toRedeemCodeManagementView(code)),
    });
  });

  app.post("/api/v1/staff/redeem-codes/:codeId/revoke", async (context) => {
    const principal = await staffWritePrincipal(context);
    if (principal instanceof Response) return principal;
    if (!dependencies.staffRedeemCommands) {
      return context.json(
        {
          error: {
            code: "STAFF_REDEEM_COMMANDS_NOT_CONFIGURED",
            message: "Staff redeem commands are not configured.",
          },
        },
        503,
      );
    }

    const code = await dependencies.staffRedeemCommands.revokeRedeemCode({
      codeId: context.req.param("codeId"),
    });
    return context.json({
      redeemCode: toRedeemCodeManagementView(code),
    });
  });

  return app;
}

function parseOptionalDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function parseRequiredDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeLimit(value: string | null | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function normalizeOffset(value: string | null | undefined): number {
  const parsed = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parsePricingProviderBody(provider: StaffCreatePricingConfigBody["provider"]): StaffCreatePricingConfigBody["provider"] {
  if (!("rules" in provider)) return provider;

  return parseRulesProviderBody(provider);
}

function parseRulesProviderBody<T extends { rules: readonly { dateTimeRange?: { start: Date | string; end: Date | string } }[] }>(
  provider: T,
): T {
  return {
    ...provider,
    rules: provider.rules.map((rule) => {
      const { dateTimeRange, ...rest } = rule;
      return {
        ...rest,
        ...(dateTimeRange
          ? {
              dateTimeRange: {
                start: new Date(dateTimeRange.start),
                end: new Date(dateTimeRange.end),
              },
            }
          : {}),
      };
    }),
  };
}
