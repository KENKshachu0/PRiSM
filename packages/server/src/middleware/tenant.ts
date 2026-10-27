import type { Context, MiddlewareHandler } from "hono";
import {
  createD1Executor,
  createD1Repositories,
  type D1DatabaseLike,
} from "@prism/adapter-d1";
import {
  createSqlReadModels,
} from "@prism/storage-sql";
import {
  capProgressAt,
  createAssetDefinitionEffectProvider,
  createAvailableAssetReader,
  createBusinessItemOrderService,
  createIntegrationService,
  createPlayerAuthService,
  createPlayerCommandService,
  createRedeemService,
  createSettlementService,
  createSetupService,
  createSettingsService,
  createStaffApiTokenService,
  createStaffAssetDefinitionService,
  createStaffAssetService,
  createStaffBusinessItemService,
  createStaffPlayerService,
  createStaffPricingService,
  createStaffPricingEffectService,
  createStaffRedeemService,
  createStaffOperationsService,
  createStaffReportService,
  createVersionedPricingResolvers,
  createStaffUserService,
  createPricingSessionOrchestrator,
  PLAYER_BILLING_LOCK_SCOPE,
  withOperationLease,
  type StartPlayerSessionCommand,
} from "@prism/application";
import { createResourceBilling } from "../resources/activation.js";
import { createOccupancy } from "../resources/occupancy/service.js";
import { createRoster } from "../resources/roster.js";
import { resourcePlanUsers } from "../resources/repository.js";
import {
  canStartPriorityTimePricingSession,
  PrismDomainError,
  type PricingConfig,
  type Session,
} from "@prism/core";
import type { AppBindings, Env, PrismAppDependencies, TenantShop } from "../bindings.js";
import { jsonError } from "../http.js";
import { sha256Hex, toBase64Url } from "../crypto.js";
import { createDeviceActionService, coinCooldownMs } from "../resources/capabilities/actions.js";
import { listDeviceStates, listMachineConnections } from "../resources/capabilities/legacy-views.js";

type CachedShopDependencies = { settings: string; encryptionKey?: string; deps: PrismAppDependencies };
// A D1 client is request/deployment scoped. Never reuse tenant repositories across databases.
let depsCache = new WeakMap<D1DatabaseLike, Map<string, CachedShopDependencies>>();

export function clearShopDependenciesCache(): void {
  depsCache = new WeakMap();
}

/**
 * The plan a start command names. Several plans in one session are refused
 * rather than silently billed together; none means the caller wants the
 * shop's default plan.
 */
function namedPlanOf(command: StartPlayerSessionCommand): string | null {
  const named = command.pricingConfigIds ?? [];
  if (named.length > 1) {
    throw new PrismDomainError("A session bills exactly one pricing plan.", "PRICING_CONFIG_SINGLE_PLAN_REQUIRED");
  }
  return named[0] ?? null;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

async function pbkdf2(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode(salt),
      iterations: 100_000,
    },
    key,
    256,
  );
  return toHex(new Uint8Array(bits));
}

async function hashPassword(
  password: string,
): Promise<{ hash: string; salt: string }> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = toBase64Url(saltBytes);
  const hash = await pbkdf2(password, salt);
  return { hash, salt };
}

async function verifyPassword(
  password: string,
  user: { passwordHash: string; passwordSalt: string },
): Promise<boolean> {
  const computed = await pbkdf2(password, user.passwordSalt);
  return timingSafeEqual(computed, user.passwordHash);
}

async function createSecret(
  label: "integration" | "machine" | "admin-session" | "player-session",
) {
  const random = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const tokenPrefix =
    label === "admin-session"
      ? "prism_admin"
      : label === "player-session"
        ? "prism_player"
        : label;
  const token = `${tokenPrefix}_${random}`;
  return {
    token,
    tokenPrefix,
    tokenHash: await sha256Hex(token),
  };
}

export function createShopDependencies(input: {
  db: D1DatabaseLike;
  shop: TenantShop;
  encryptionKey?: string;
  now?: () => Date;
  id?: () => string;
  /** Passed to the machine resolver so embedded-relay devices can be executed. */
  env?: Env;
}): PrismAppDependencies {
  const now = input.now ?? (() => new Date());
  const id = input.id ?? (() => crypto.randomUUID());
  const shopId = input.shop.id;

  const repos = createD1Repositories({
    db: input.db,
    shopId,
    id,
    now,
  });

  const queries = createSqlReadModels({
    executor: createD1Executor(input.db, shopId),
    now,
  });

  const availableAssets = createAvailableAssetReader({
    assets: repos.assets,
    assetDefinitions: repos.assetDefinitions,
    now,
  });

  const assetEffectProviders = [
    createAssetDefinitionEffectProvider(repos.assetDefinitions),
  ];

  const sessionPricing = async (session: Session) => {
    if (!session.pricingReleaseId) {
      return {
        configs: await repos.pricingConfigs.listEnabled(),
        timeZone: input.shop.time_zone || "UTC",
      };
    }
    const release = await repos.pricingConfigs.findRelease?.(
      session.pricingReleaseId,
    );
    if (!release) {
      throw new PrismDomainError(
        "Pinned pricing release not found.",
        "PRICING_RELEASE_NOT_FOUND",
      );
    }
    return {
      configs: release.configs.filter(
        (config) => config.enabled && config.status !== "archived",
      ),
      timeZone: release.timeZone,
    };
  };

  const playerPricing = async (playerId: string) => {
    const sessions = [
      ...(await repos.sessions.findActiveByPlayerId(playerId)),
      ...((await repos.sessions.findUnpaidClosedByPlayerId?.(playerId)) ?? []),
    ];
    const first = sessions.sort(
      (a, b) =>
        a.startedAt.getTime() - b.startedAt.getTime() ||
        a.id.localeCompare(b.id),
    )[0];
    return first
      ? sessionPricing(first)
      : {
          configs: await repos.pricingConfigs.listEnabled(),
          timeZone: input.shop.time_zone || "UTC",
        };
  };

  /**
   * Every config of the release a player's next session is pinned to — the one
   * their earliest unsettled session uses, otherwise the current one — disabled
   * and archived configs included, so plan relations always resolve.
   */
  const pricingCatalog = async (playerId: string): Promise<PricingConfig[]> => {
    const sessions = [
      ...(await repos.sessions.findActiveByPlayerId(playerId)),
      ...((await repos.sessions.findUnpaidClosedByPlayerId?.(playerId)) ?? []),
    ].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id));
    const releaseId = sessions[0]?.pricingReleaseId;
    if (!releaseId) return repos.pricingConfigs.listAll();
    const release = await repos.pricingConfigs.findRelease?.(releaseId);
    if (!release) throw new PrismDomainError("Pinned pricing release not found.", "PRICING_RELEASE_NOT_FOUND");
    return release.configs;
  };

  const pricingSessions = createPricingSessionOrchestrator({
    sessions: repos.sessions as typeof repos.sessions & {
      applyTransition: NonNullable<typeof repos.sessions.applyTransition>;
    },
    operationLocks: repos.operationLocks,
    pricingCatalog,
    canStartPlanAt: ({ config, at }) =>
      canStartPriorityTimePricingSession({
        config: { ...config.provider, timeZone: config.provider.timeZone ?? (input.shop.time_zone || "UTC") },
        at,
      }),
    // A seat belongs to its mahjong session: when a switch or a stop ends that
    // session, the player is no longer seated.
    afterClose: async (closed) => {
      await input.db
        .prepare("DELETE FROM mahjong_seats WHERE shop_id = ? AND session_id IN (SELECT value FROM json_each(?))")
        .bind(shopId, JSON.stringify(closed.map((session) => session.id)))
        .run();
    },
    // Display only: a session is labelled by its plan.
    labelOf: (planId, catalog) => catalog.find((config) => config.id === planId)?.name,
    now,
    id,
  });

  const resourceBilling = createResourceBilling({
    db: input.db,
    shopId,
    pricingCatalog,
    sessions: repos.sessions,
    pricingSessions,
    startPlaceholder: (command) => startPlaceholder(command),
    withPlayerLock: (playerId, action) =>
      withOperationLease({ repository: repos.operationLocks, scope: PLAYER_BILLING_LOCK_SCOPE, resourceId: playerId, id, now }, action),
    capProgress: async ({ playerId, configs, planIds }) => {
      // An unsettled bill has charged into the current windows already.
      const unsettled = playerId
        ? (await repos.sessions.findActiveByPlayerId(playerId)).length > 0
          || ((await repos.sessions.findUnpaidClosedByPlayerId?.(playerId)) ?? []).length > 0
        : false;
      const running = playerId && unsettled ? await playerCheckoutCommands.previewCheckout({ playerId }) : null;
      return capProgressAt({
        configs,
        planIds,
        timeZone: input.shop.time_zone || "UTC",
        playerId,
        at: now(),
        pricingHistory: repos.pricingHistory,
        pricingCapHistory: repos.pricingCapHistory,
        running,
      });
    },
    now,
  });

  const deviceActions = createDeviceActionService({
    db: input.db,
    env: input.env ?? ({ DB: input.db, URL_ENCRYPTION_KEY: input.encryptionKey } as Env),
    shopId,
    sessions: repos.sessions,
    resourceAdmits: (target) => resourceBilling.admits(target),
    deviceEvents: repos.deviceEvents,
    playerIdentities: repos.playerIdentities,
    coinCooldownMs: () => coinCooldownMs(input.db, shopId),
    id,
    now,
  });

  const playerAuthCommands = createPlayerAuthService({
    players: repos.players,
    playerIdentities: repos.playerIdentities,
    playerSessions: repos.playerSessions,
    id,
    now,
    createSecret,
    sessionDurationMs: 30 * 24 * 60 * 60 * 1000,
  });

  const staffAssetCommands = createStaffAssetService({
    assets: repos.assets,
    availableAssets,
    assetDefinitions: repos.assetDefinitions,
    operationLocks: repos.operationLocks,
    id,
    now,
  });

  const staffPlayerCommands = createStaffPlayerService({
    players: repos.players,
    assets: repos.assets,
    assetDefinitions: repos.assetDefinitions,
    redeems: repos.redeems,
    playerIdentities: repos.playerIdentities,
    async getDefaultRegistrationPresentId() {
      const registration = await repos.system.getAppSetting<{
        defaultPresentId?: unknown;
      }>("player.registration");
      return typeof registration?.defaultPresentId === "string"
        ? registration.defaultPresentId
        : null;
    },
    id,
    now,
  });

  let playerCommands = createPlayerCommandService({
    sessions: repos.sessions,
    pricingConfigs: repos.pricingConfigs,
    resolvePricingConfigs: async (playerId) =>
      (await playerPricing(playerId)).configs,
    playerIdentities: repos.playerIdentities,
    operationLocks: repos.operationLocks,
    canStartSessionAt: async ({ at, playerId }) => {
      const pinned = await playerPricing(playerId);
      const timeConfigs = pinned.configs.filter(
        (config): config is Extract<PricingConfig, { kind: "time.priority" }> =>
          config.kind === "time.priority",
      );
      if (timeConfigs.length === 0) return true;
      const storeTimeZone = pinned.timeZone ?? "UTC";
      return timeConfigs.some((config) =>
        canStartPriorityTimePricingSession({
          config: {
            ...config.provider,
            timeZone: config.provider.timeZone ?? storeTimeZone,
          },
          at,
        }),
      );
    },
    id,
    now,
  });

  // Every session start goes through `resourceBilling.activate`: one plan per
  // session, a running plan is reused, requirements and conflicts are applied,
  // and only a shop without any time plan keeps the unpriced placeholder.
  const startPlaceholderSession = playerCommands.startSession;
  const startPlanSession: typeof startPlaceholderSession = async (command) => {
    const pricingConfigId = namedPlanOf(command);
    const result = await resourceBilling.activate({
      playerId: command.playerId,
      ...(pricingConfigId ? { pricingConfigId } : {}),
      ...(command.label ? { label: command.label } : {}),
      ...(command.metadata ? { metadata: command.metadata } : {}),
    });
    const stored = await repos.sessions.findById(result.session.id);
    return { ...result.session, ...(stored?.pricingReleaseId ? { pricingReleaseId: stored.pricingReleaseId } : {}) };
  };
  playerCommands = { ...playerCommands, startSession: startPlanSession };

  // A shop billing without any time plan keeps one placeholder session a visit.
  function startPlaceholder(command: Pick<StartPlayerSessionCommand, "playerId" | "label" | "metadata">) {
    return withOperationLease(
      { repository: repos.operationLocks, scope: PLAYER_BILLING_LOCK_SCOPE, resourceId: command.playerId, id, now },
      async () => {
        const running = (await repos.sessions.findActiveByPlayerId(command.playerId)).find((session) => !session.pricingConfigId);
        return running
          ? { ...running, status: "active" as const }
          : startPlaceholderSession({ ...command, label: command.label ?? "entry" });
      },
    );
  }

  let playerCheckoutCommands = createSettlementService({
    players: repos.players,
    commitCheckout: repos.commitCheckout,
    sessions: repos.sessions,
    operationLocks: repos.operationLocks,
    assets: repos.assets,
    settlements: repos.settlements,
    assetDefinitions: repos.assetDefinitions,
    availableAssets,
    system: repos.system,
    pricingHistory: repos.pricingHistory,
    pricingCapHistory: repos.pricingCapHistory,
    deviceOperations: repos.deviceEvents,
    pricingProviders: [],
    ...createVersionedPricingResolvers({
      sessionPricing,
      pricingHistory: repos.pricingHistory,
      fallbackPricingProviders: [],
      pluginPricingProviders: [],
    }),
    assetEffectProviders,
    id,
    now,
  });

  // Stopping a plan's session stops what requires that plan at the same instant.
  const stopLegacySession = playerCheckoutCommands.stopSession;
  playerCheckoutCommands = {
    ...playerCheckoutCommands,
    stopSession: (stopInput) =>
      withOperationLease(
        { repository: repos.operationLocks, scope: PLAYER_BILLING_LOCK_SCOPE, resourceId: stopInput.playerId, id, now },
        async () => {
          const session = await repos.sessions.findById(stopInput.sessionId);
          if (!session || session.playerId !== stopInput.playerId || session.status !== "active" || !session.pricingConfigId) {
            return stopLegacySession(stopInput);
          }
          const result = await pricingSessions.deactivate({
            playerId: stopInput.playerId,
            pricingConfigId: session.pricingConfigId,
          });
          return result.closed.find((closed) => closed.id === session.id)!;
        },
      ),
  };

  const playerRedeemCommands = createRedeemService({
    assets: repos.assets,
    assetDefinitions: repos.assetDefinitions,
    availableAssets,
    redeems: repos.redeems,
    operationLocks: repos.operationLocks,
    id,
    now,
  });

  const staffAssetDefinitionCommands = createStaffAssetDefinitionService({
    assetDefinitions: repos.assetDefinitions,
    pricingEffects: repos.pricingEffects,
  });

  const staffRedeemCommands = createStaffRedeemService({
    redeems: repos.redeems,
    assetDefinitions: repos.assetDefinitions,
    id,
    now,
  });

  const staffPricingEffectCommands = createStaffPricingEffectService({
    pricingEffects: repos.pricingEffects,
    id,
  });

  const staffPricingCommands = createStaffPricingService({
    pricingConfigs: repos.pricingConfigs,
    planUsers: (planId) => resourcePlanUsers(input.db, shopId, planId),
    async getDefaultTimeZone() {
      return input.shop.time_zone || "UTC";
    },
    id,
    now,
  });

  const staffBusinessItemCommands = createStaffBusinessItemService({
    businessItems: repos.businessItems,
    id,
    now,
  });

  const businessItemOrderCommands = createBusinessItemOrderService({
    businessItems: repos.businessItems,
    businessItemOrders: repos.businessItemOrders,
    sessions: repos.sessions,
    assets: repos.assets,
    availableAssets,
    operationLocks: repos.operationLocks,
    id,
    now,
  });

  const staffSettingsCommands = createSettingsService({
    system: repos.system,
  });

  const staffApiTokenCommands = createStaffApiTokenService({
    system: repos.system,
    id,
    now,
    createSecret,
  });

  const staffUserCommands = createStaffUserService({
    system: repos.system,
    id,
    now,
    hashPassword,
  });

  const setupCommands = createSetupService({
    system: repos.system,
    assetDefinitions: repos.assetDefinitions,
    id,
    now,
    hashPassword,
    verifyPassword,
    createSecret,
    sessionDurationMs: 24 * 60 * 60 * 1000,
  });

  let integrationCommands = createIntegrationService({
    players: repos.players,
    playerIdentities: repos.playerIdentities,
    registerPlayer: (player) => staffPlayerCommands.createPlayer(player),
    sessions: repos.sessions,
    playerCommands,
    playerCheckoutCommands,
    playerRedeemCommands,
    deviceActions,
    playerQueries: queries.playerQueries,
    staffAssetCommands,
    staffCheckoutCommands: playerCheckoutCommands,
    id,
    now,
  });

  // Kept for in-process callers only: the bot's HTTP entry starts the bot
  // resource's plan (routes/shops/integration.ts). A start here must name its
  // plan; there is no default plan. An older bot's admission label is dropped
  // so the session is labelled by its plan.
  const origStartByIdentity = integrationCommands.startSessionByIdentity;
  integrationCommands = {
    ...integrationCommands,
    startSessionByIdentity: (startInput) => {
      const admission =
        startInput.entry === true ||
        (startInput.entry !== false &&
          (!startInput.label || ["entry", "音游区间"].includes(startInput.label.trim())));
      return origStartByIdentity({
        ...startInput,
        // The Bot caller cannot bypass the shop-level registration switch.
        autoRegister: !!input.shop.auto_register,
        ...(admission ? { label: undefined } : {}),
      });
    },
  };

  // Wrap playerCheckoutCommands.checkout
  const origCheckout = playerCheckoutCommands.checkout;
  playerCheckoutCommands = {
    ...playerCheckoutCommands,
    checkout: (checkoutInput) =>
      origCheckout({
        ...checkoutInput,
        closeSessionsBeforeBalanceCheck: false,
      }),
  };

  const staffOperations = createStaffOperationsService({
    staffQueries: queries.staffQueries,
    checkout: playerCheckoutCommands,
    listPricingConfigs: () => staffPricingCommands.listPricingConfigs(),
    now,
  });

  // Device state is read live from the hardware, so it cannot be a SQL read model.
  const deviceRuntime = {
    db: input.db,
    env: input.env ?? ({ DB: input.db, URL_ENCRYPTION_KEY: input.encryptionKey } as Env),
    shopId,
    now,
    id,
  };
  const staffQueries = {
    ...queries.staffQueries,
    listDeviceStates: () => listDeviceStates(deviceRuntime),
    listMachineConnections: () => listMachineConnections(deviceRuntime),
  };

  const occupancy = createOccupancy({ db: input.db, shopId, now });
  return {
    repositories: repos,
    playerQueries: queries.playerQueries,
    staffQueries,
    playerCommands,
    pricingSessions,
    resourceBilling,
    occupancy,
    roster: createRoster({
      db: input.db,
      shopId,
      listActiveSessions: () => queries.staffQueries.listActiveSessions(),
      listPlans: () => repos.pricingConfigs.listAll(),
      occupancy,
    }),
    playerCheckoutCommands,
    playerRedeemCommands,
    integrationCommands,
    staffCheckoutCommands: playerCheckoutCommands,
    staffOperations,
    staffLiveBillingSnapshot: repos.readLiveBillingSnapshot
      ? (playerIds) => repos.readLiveBillingSnapshot!(playerIds, now())
      : undefined,
    staffReportCommands: repos.reportArchives
      ? createStaffReportService({ archives: repos.reportArchives, now })
      : undefined,
    staffPlayerCommands,
    staffAssetDefinitionCommands,
    staffPricingEffectCommands,
    staffAssetCommands,
    staffRedeemCommands,
    staffRedeemQueries: queries.staffRedeemQueries,
    staffPricingCommands,
    staffBusinessItemCommands,
    businessItemOrderCommands,
    staffSettingsCommands,
    staffApiTokenCommands,
    staffUserCommands,
    deviceActions,
    setupCommands,
    playerAuthCommands,
  };
}

export function getOrCreateShopDependencies(
  db: D1DatabaseLike,
  shop: TenantShop,
  encryptionKey?: string,
  env?: Env,
): PrismAppDependencies {
  // Service closures capture shop configuration (pricing, auto-registration, timezone).
  // Rebuild them whenever tenant settings change rather than serving stale closures.
  let byShop = depsCache.get(db);
  if (!byShop) {
    byShop = new Map();
    depsCache.set(db, byShop);
  }
  const settings = JSON.stringify(shop);
  const cached = byShop.get(shop.id);
  // `env` is stable per deployment, so it is not part of the cache key beyond
  // the encryption key that already distinguishes local from hosted runtimes.
  if (cached?.settings === settings && cached.encryptionKey === encryptionKey) return cached.deps;
  const deps = createShopDependencies({ db, shop, encryptionKey, env });
  byShop.set(shop.id, { settings, encryptionKey, deps });
  return deps;
}

export const tenantMiddleware: MiddlewareHandler<AppBindings> = async (
  c,
  next,
) => {
  const shopCode = c.req.param("shopCode");
  if (!shopCode) {
    jsonError(400, "缺少店铺代码", "SHOP_CODE_REQUIRED");
  }

  const shopRow = await loadTenantShop(c, shopCode);

  if (!shopRow) {
    jsonError(404, "没有找到这个店铺", "SHOP_NOT_FOUND");
  }

  await setTenantFromShop(c, shopRow);
  await next();
};

/**
 * The same tenant context, resolved from a shop row a route already found: a
 * bot credential names its shop without a shop code in the path.
 */
export async function setTenantFromShop(
  c: Context<AppBindings>,
  shopRow: TenantShop,
): Promise<void> {
  const enabled = +(!!(
    shopRow.checkin_geo ||
    shopRow.checkout_geo ||
    shopRow.machine_geo
  ));
  const shop: TenantShop = {
    ...shopRow,
    checkin_geo: enabled,
    checkout_geo: enabled,
    machine_geo: enabled,
  };
  c.set("shop", shop);
  c.set("responseTimeZone", shop.time_zone);
  c.set("deps", getOrCreateShopDependencies(c.env.DB, shop, c.env.URL_ENCRYPTION_KEY, c.env));
}

/** The shop row every tenant request reads, by code or ID. */
export async function loadTenantShop(
  c: Context<AppBindings>,
  shopCode: string,
): Promise<TenantShop | null> {
  return c.env.DB.prepare(
    `SELECT s.id, s.public_id, s.name, s.latitude, s.longitude, s.radius_meters,
      COALESCE(b.auto_register, 0) AS auto_register,
      COALESCE(b.identity_binding_required, 1) AS identity_binding_required,
      COALESCE((SELECT json_extract(value_json, '$.enabled') FROM app_settings WHERE shop_id = s.id AND key = 'cashier.settings'), 0) AS cashier_enabled,
      COALESCE(b.checkin_geo, 0) AS checkin_geo,
      COALESCE(b.checkout_geo, 0) AS checkout_geo,
      COALESCE(b.machine_geo, 0) AS machine_geo,
      COALESCE(b.bot_contact, '') AS bot_contact,
      CASE WHEN s.hero_data IS NULL OR s.hero_data = '' THEN NULL ELSE '/api/v1/shops/' || s.public_id || '/hero?v=' || COALESCE(s.hero_hash, 'original') END AS hero_url,
      COALESCE((SELECT json_extract(value_json, '$.timeZone') FROM app_settings WHERE shop_id = s.id AND key = 'store.profile'), 'Asia/Shanghai') AS time_zone
    FROM shops s
    LEFT JOIN shop_billing_settings b ON b.shop_id = s.id
    WHERE s.public_id = ? OR s.id = ?`,
  )
    .bind(shopCode, shopCode)
    .first<TenantShop>();
}

export function getShop(c: Context<AppBindings>): TenantShop {
  const shop = c.get("shop");
  if (!shop) jsonError(404, "没有找到这个店铺", "SHOP_NOT_FOUND");
  return shop;
}

export function getShopDeps(c: Context<AppBindings>): PrismAppDependencies {
  const deps = c.get("deps");
  if (!deps) jsonError(500, "店铺依赖未初始化", "DEPS_UNINITIALIZED");
  return deps;
}
