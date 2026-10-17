import type { D1DatabaseLike } from "@prism/adapter-d1";
import type {
  PlayerQueries,
  StaffQueries,
  StaffRedeemQueries,
  PlayerCommandService,
  SettlementService,
  RedeemService,
  IntegrationService,
  StaffOperationsService,
  StaffPlayerService,
  StaffAssetDefinitionService,
  StaffPricingEffectService,
  StaffAssetService,
  StaffRedeemService,
  StaffPricingService,
  StaffBusinessItemService,
  BusinessItemOrderService,
  createSettingsService,
  createSetupService,
  StaffApiTokenService,
  StaffUserService,
  DeviceActionService,
  PlayerAuthService,
  StaffReportService,
  SettlePlayerCheckoutResult,
} from "@prism/application";
import type { LiveBillingSnapshot } from "@prism/core";
import type { SqlRepositories } from "@prism/storage-sql";

export type SettingsService = ReturnType<typeof createSettingsService>;
export type SetupService = ReturnType<typeof createSetupService>;

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  role: "user" | "admin";
  bannedAt: string | null;
};

export type StaffPrincipal = {
  role: "staff";
  staffId: string;
  staffRole: "owner" | "manager" | "viewer";
};

export type TenantShop = {
  id: string;
  public_id: string;
  name: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
  billing_enabled: number;
  cashier_enabled: number;
  auto_register: number;
  identity_binding_required: number;
  checkin_geo: number;
  checkout_geo: number;
  machine_geo: number;
  entry_pricing_ids_json: string;
  bot_contact: string;
  time_zone: string;
  hero_url: string | null;
};

export type PrismAppDependencies = {
  authenticatedPrincipal?: StaffPrincipal | { role: "user"; userId: string };
  versionInfo?: { version: string; revision?: string };
  repositories: SqlRepositories;
  playerQueries: PlayerQueries;
  staffQueries: StaffQueries;
  playerCommands: PlayerCommandService;
  playerCheckoutCommands: SettlementService;
  playerRedeemCommands: RedeemService;
  integrationCommands: IntegrationService;
  staffCheckoutCommands: SettlementService;
  staffOperations: StaffOperationsService<SettlePlayerCheckoutResult>;
  staffReportCommands?: StaffReportService;
  staffLiveBillingSnapshot?: (
    playerIds: readonly string[],
  ) => Promise<LiveBillingSnapshot>;
  staffPlayerCommands: StaffPlayerService;
  staffAssetDefinitionCommands: StaffAssetDefinitionService;
  staffPricingEffectCommands: StaffPricingEffectService;
  staffAssetCommands: StaffAssetService;
  staffRedeemCommands: StaffRedeemService;
  staffRedeemQueries?: StaffRedeemQueries;
  staffPricingCommands: StaffPricingService;
  staffBusinessItemCommands: StaffBusinessItemService;
  businessItemOrderCommands: BusinessItemOrderService;
  staffSettingsCommands: SettingsService;
  staffApiTokenCommands: StaffApiTokenService;
  staffUserCommands: StaffUserService;
  deviceActions: DeviceActionService;
  setupCommands: SetupService;
  playerAuthCommands: PlayerAuthService;
};

export type Env = {
  DB: D1DatabaseLike;
  RATE_LIMIT_3?: RateLimit;
  RATE_LIMIT_5?: RateLimit;
  RATE_LIMIT_10?: RateLimit;
  RATE_LIMIT_20?: RateLimit;
  RATE_LIMIT_30?: RateLimit;
  RATE_LIMIT_60?: RateLimit;

  APP_ORIGIN: string;
  SESSION_SECRET?: string;
  // SHA-256 hex of the one-time installation secret; required by setup/install.
  PRISM_BOOTSTRAP_TOKEN_HASH?: string;
  URL_ENCRYPTION_KEY?: string;
  MUNET_CLIENT_ID?: string;
  MUNET_CLIENT_SECRET?: string;
  APPLE_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_PRIVATE_KEY?: string;
  LIVE_BILLING?: DurableObjectNamespace<any>;
  MACHINE_RELAY?: DurableObjectNamespace<any>;
  EXTRA_ALLOWED_ORIGINS?: string;
  ANDROID_CERT_FINGERPRINTS?: string;
  PRISM_DEPLOY_GUARD?: string;
  PRISM_DEPLOY_PHASE?: "maintenance" | "verify" | "live";
  PRISM_DEPLOY_TOKEN_HASH?: string;
  PRISM_DEPLOY_REVISION?: string;
  ASSETS?: Fetcher;
  PRISM_SQLITE_PATH?: string;
};

export type Variables = {
  user: AuthUser | null;
  sessionId: string | null;
  shop?: TenantShop;
  deps?: PrismAppDependencies;
  responseTimeZone?: string;
};

export type AppBindings = {
  Bindings: Env;
  Variables: Variables;
};
