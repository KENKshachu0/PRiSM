import type {
  AssetMergeStrategy,
  AssetHolding,
  AssetLedgerEntry,
  AssetDefinition,
  ApiToken,
  ApiTokenRole,
  BusinessItem,
  BusinessItemOrder,
  ChargeItem,
  DeviceCommand,
  DeviceCommandType,
  DeviceReferenceTarget,
  ExternalIdentity,
  GrantAssetsResult,
  Player,
  PlayerIdentity,
  PlayerStatus,
  PricingConfig,
  PricingEffect,
  PricingConfigKind,
  Present,
  PresentGrant,
  PreviewSessionSettlementResult,
  RedeemCode,
  SettlementAdjustment,
  SettlementRecord,
  Session,
  SettleSessionResult,
  StaffUserStatus,
  TimeCapPricingWindow,
} from "@prism/core";
import type {
  LivePlayerView,
  PlayerQueries,
  PlayerSummary,
  PreviewPlayerCheckoutResult,
  RedeemCodeResult,
  SettlePlayerCheckoutResult,
  StaffPricingExtension,
  StaffPricingExtensionProvider,
  StaffOperationsService,
  StaffQueries,
  StaffRedeemQueries,
  HomeAssistantConnectionConfig,
  HomeAssistantDeviceConfig,
  TTLockConnectionConfig,
  TTLockDeviceConfig,
} from "@prism/application";
export type {
  LiveGlobalCapWindowView,
  LivePlayerView,
  LivePricingChargeView,
  LivePricingSegmentView,
  LiveSessionView,
  PlayerAssetHoldingListItem,
  PlayerAssetLedgerListItem,
  PlayerAssets,
  PlayerQueries,
  PlayerRedeemRecordListItem,
  PlayerSummary,
  PreviewPlayerCheckoutResult,
  SettlePlayerCheckoutResult,
  SessionHistoryDetail,
  SessionHistoryListItem,
  StaffActiveSessionListItem,
  StaffDeviceCommandListItem,
  StaffPlayerListItem,
  StaffPricingExtension,
  StaffPricingExtensionProvider,
  StaffPricingExtensionRequiredAsset,
  StaffQueries,
  StaffRedeemCodeRedemptionListItem,
  StaffRedeemQueries,
  StaffReportPlayerListItem,
  StaffReportSettlementListItem,
  StaffReportsSummary,
  StaffReportsSummaryInput,
} from "@prism/application";

export type PrincipalRole = "player" | "staff" | "integration" | "machine" | "player_session";

export type StaffRole = "owner" | "manager" | "viewer";

export type Principal =
  | {
      role: "player";
      playerId: string;
    }
  | {
      role: "staff";
      staffId: string;
      staffRole: StaffRole;
      displayName?: string;
    }
  | {
      role: "integration" | "machine";
    }
  | {
      role: "player_session";
      playerId: string;
    };

export type AdminSessionAuth = {
  authenticateAdminSession(token: string): Promise<{ staffId: string; role: StaffRole; displayName?: string } | null>;
  revokeAdminSession?(token: string): Promise<void>;
};

export type ApiTokenAuth = {
  authenticateApiToken(token: string): Promise<{ role: ApiTokenRole } | null>;
};

export type PlayerSessionAuth = {
  authenticatePlayerSession(token: string): Promise<{ playerId: string } | null>;
};

export type PlayerAuthIdentityBody = {
  identity?: ExternalIdentity;
  identityKey?: string;
};

export type PlayerAuthCommands = {
  loginByIdentity(input: PlayerAuthIdentityBody): Promise<{ token: string; player: Player }>;
};

export type PlayerSummaryView = Omit<PlayerSummary, "activeSession" | "wallet"> & {
  wallet: Array<{ assetCode: string; quantity: number }>;
  activeSession: {
    id: string;
    startedAt: string;
  } | null;
};

export type StaffAssetGrantInput = {
  staffId: string;
  playerId: string;
  reason?: string;
  grants: Array<{
    assetType: string;
    assetCode: string;
    amount: number;
    mergeStrategy: AssetMergeStrategy;
    activeAt: Date | null;
    expiresAt: Date | null;
    durationMs?: number;
  }>;
};

export type StaffAssetCommands = {
  grantAssets(input: StaffAssetGrantInput): Promise<GrantAssetsResult>;
  adjustAssets(input: StaffAssetAdjustmentInput): Promise<GrantAssetsResult>;
  adjustWallet?(input: StaffWalletAdjustmentInput): Promise<GrantAssetsResult>;
};

export type StaffAssetDefinitionCommands = {
  saveAssetDefinition(input: AssetDefinition): Promise<AssetDefinition>;
  archiveAssetDefinition?(input: { type: string; code: string }): Promise<AssetDefinition>;
  restoreAssetDefinition?(input: { type: string; code: string }): Promise<AssetDefinition>;
  listAssetDefinitions(): Promise<AssetDefinition[]>;
};

export type StaffPricingEffectCommands = {
  savePricingEffect(input: Omit<PricingEffect, "id" | "status"> & { id?: string; status?: PricingEffect["status"] }): Promise<PricingEffect>;
  archivePricingEffect(input: { effectId: string }): Promise<PricingEffect>;
  restorePricingEffect(input: { effectId: string }): Promise<PricingEffect>;
  listPricingEffects(): Promise<PricingEffect[]>;
};

export type StaffAssetAdjustmentInput = {
  staffId: string;
  playerId: string;
  adjustments: Array<{
    holdingId?: string;
    assetType: string;
    assetCode: string;
    quantityDelta: number;
    activeAt?: Date | null;
    expiresAt?: Date | null;
    reason: string;
  }>;
};

export type StaffCreatePlayerInput = {
  displayName: string;
  initialGrants?: Array<{
    assetType: string;
    assetCode: string;
    amount: number;
    mergeStrategy: AssetMergeStrategy;
    activeAt: Date | null;
    expiresAt: Date | null;
    durationMs?: number;
  }>;
};

export type StaffUpdatePlayerStatusInput = {
  playerId: string;
  status: PlayerStatus;
};

export type StaffBindPlayerIdentityInput = {
  playerId: string;
  provider: string;
  subject: string;
};

export type ResolvePlayerIdentityInput = {
  provider: string;
  subject: string;
};

export type StaffPlayerCommands = {
  createPlayer(input: StaffCreatePlayerInput): Promise<Player>;
  updatePlayerStatus(input: StaffUpdatePlayerStatusInput): Promise<Player>;
  bindPlayerIdentity?(input: StaffBindPlayerIdentityInput): Promise<PlayerIdentity>;
  deletePlayerIdentity?(input: StaffBindPlayerIdentityInput): Promise<void>;
  resolvePlayerIdentity?(input: ResolvePlayerIdentityInput): Promise<Player | null>;
};

export type StaffCreatePresentInput = {
  name: string;
  oncePerPlayer: boolean;
  activeAt?: Date | null;
  expiresAt?: Date | null;
  grants: readonly PresentGrant[];
};

export type StaffCreateRedeemCodeInput = {
  code: string;
  presentId: string;
  activeAt: Date | null;
  expiresAt: Date | null;
  maxUseCount: number;
};

export type StaffRedeemCommands = {
  createPresent(input: StaffCreatePresentInput): Promise<Present>;
  listPresents?(): Promise<Present[]>;
  archivePresent?(input: { presentId: string }): Promise<Present>;
  restorePresent?(input: { presentId: string }): Promise<Present>;
  createRedeemCode(input: StaffCreateRedeemCodeInput): Promise<RedeemCode>;
  createRedeemCodeBatch(input: StaffCreateRedeemCodeBatchInput): Promise<RedeemCode[]>;
  listRedeemCodes(): Promise<RedeemCode[]>;
  revokeRedeemCode(input: { codeId: string }): Promise<RedeemCode>;
};

export type StaffCreateRedeemCodeBatchInput = Omit<StaffCreateRedeemCodeInput, "code"> & {
  prefix: string;
  count: number;
};

export type StaffCreatePricingConfigInput = {
  kind: PricingConfigKind;
  name: string;
  enabled: boolean;
  provider: PricingConfig["provider"];
};

export type StaffPricingCommands = {
  createPricingConfig(input: StaffCreatePricingConfigInput): Promise<PricingConfig>;
  updatePricingConfig(input: StaffUpdatePricingConfigInput): Promise<PricingConfig>;
  archivePricingConfig?(input: { pricingConfigId: string }): Promise<PricingConfig>;
  restorePricingConfig?(input: { pricingConfigId: string }): Promise<PricingConfig>;
  listPricingConfigs(): Promise<PricingConfig[]>;
  getPricingTimeline?(input: { pricingConfigId: string; localDate: string }): Promise<unknown>;
  previewPricingTimeline?(input: StaffPreviewPricingTimelineInput): Promise<unknown>;
};

export type StaffCreateBusinessItemInput = {
  kind: string;
  name: string;
  price: number;
  assetType: string | null;
  assetCode: string | null;
  activeAt: Date | null;
  expiresAt: Date | null;
  metadata: Record<string, unknown> | null;
};

export type StaffBusinessItemCommands = {
  createBusinessItem(input: StaffCreateBusinessItemInput): Promise<BusinessItem>;
  archiveBusinessItem?(input: { businessItemId: string }): Promise<BusinessItem>;
  restoreBusinessItem?(input: { businessItemId: string }): Promise<BusinessItem>;
  listBusinessItems(): Promise<BusinessItem[]>;
};

export type PurchaseBusinessItemResult = {
  order: BusinessItemOrder;
  assetLedgerEntries: Array<{
    assetType: string;
    assetCode: string;
    delta: import("@prism/core").Cents;
    reason: string;
    refId: string;
    transactionId?: string;
  }>;
};

export type BusinessItemOrderCommands = {
  purchaseBusinessItem(input: {
    playerId: string;
    businessItemId: string;
    metadata: Record<string, unknown> | null;
  }): Promise<PurchaseBusinessItemResult>;
  listPlayerBusinessItemOrders(input: { playerId: string }): Promise<BusinessItemOrder[]>;
  listBusinessItemOrders(): Promise<BusinessItemOrder[]>;
  fulfillBusinessItemOrder(input: { orderId: string }): Promise<BusinessItemOrder>;
  cancelBusinessItemOrder(input: { orderId: string }): Promise<BusinessItemOrder>;
};

export type StaffPreviewPricingTimelineInput = {
  localDate: string;
  provider: Extract<PricingConfig, { kind: "time.priority" | "time.cap" }>["provider"];
};

export type StaffUpdatePricingConfigInput = {
  pricingConfigId: string;
  name: string;
  enabled: boolean;
  provider: PricingConfig["provider"];
};

export type { HomeAssistantConnectionConfig, HomeAssistantDeviceConfig, TTLockConnectionConfig, TTLockDeviceConfig } from "@prism/application";

export type HinataIoDeviceConfig = {
  id: string;
  name: string;
  aliases: string[];
  url: string;
  password: string;
  salt: string;
  coinKey: number;
  cardType: string;
};

export type PlayerRegistrationSettings = {
  defaultPresentId: string | null;
};

export type StaffSettings = {
  store: {
    name: string;
    timeZone: string;
  };
  operations: {
    coinCooldownMs: number;
  };
  homeAssistantConnection: HomeAssistantConnectionConfig;
  homeAssistantDevices: HomeAssistantDeviceConfig[];
  ttLockConnection?: TTLockConnectionConfig;
  ttLockDevices?: TTLockDeviceConfig[];
  hinataIoDevices: HinataIoDeviceConfig[];
  registration: PlayerRegistrationSettings;
};

export type StaffSettingsCommands = {
  getSettings(): Promise<StaffSettings>;
  updateSettings(input: StaffSettings): Promise<StaffSettings>;
};

export type StaffApiTokenView = Omit<ApiToken, "tokenHash">;

export type StaffApiTokenCommands = {
  listApiTokens(): Promise<StaffApiTokenView[]>;
  createApiToken(input: { label: string; role: ApiTokenRole }): Promise<StaffApiTokenView & { token: string }>;
  revokeApiToken(input: { tokenId: string }): Promise<StaffApiTokenView>;
};

export type StaffUserView = {
  id: string;
  username: string;
  displayName: string;
  role: StaffRole;
  status: StaffUserStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type StaffUserCommands = {
  listStaffUsers(): Promise<StaffUserView[]>;
  createStaffUser(input: {
    username: string;
    displayName: string;
    password: string;
    role: StaffRole;
  }): Promise<StaffUserView>;
  updateStaffUser(input: {
    staffUserId: string;
    displayName: string;
    role: StaffRole;
    status: StaffUserStatus;
  }): Promise<StaffUserView>;
  resetStaffUserPassword?(input: {
    staffUserId: string;
    password: string;
  }): Promise<StaffUserView>;
};

export type StartPlayerSessionInput = {
  playerId: string;
  pricingConfigIds?: string[];
  label?: string;
  /** Free-form session metadata. `createdBy: "integration"` marks Bot-owned sessions. */
  metadata?: Record<string, unknown>;
};

export type RequestPlayerDeviceCommandInput = {
  playerId: string;
  type: DeviceCommandType;
  target: DeviceReferenceTarget;
  payload?: Record<string, unknown>;
};

export type PlayerCommands = {
  startSession(input: StartPlayerSessionInput): Promise<Session & { status: "active" }>;
  requestDeviceCommand(input: RequestPlayerDeviceCommandInput): Promise<DeviceCommand>;
};

export type MachineCommandMessage = {
  type: "command";
  commandId: string;
  action: DeviceCommandType;
  payload?: Record<string, unknown>;
  expiresAt: Date;
};

export type MachineConnectionCommands = {
  hello(input: { machineId: string; capabilities: string[] }): Promise<unknown>;
  heartbeat(input: { machineId: string }): Promise<unknown>;
  disconnect(input: { machineId: string }): Promise<unknown>;
  listDeliverableCommands(input: { machineId: string; limit: number }): Promise<MachineCommandMessage[]>;
  ack(input: {
    machineId: string;
    commandId: string;
    status: "success" | "failed";
    message?: string;
  }): Promise<DeviceCommand>;
};

export type PlayerCheckoutInput = {
  closeSessionsBeforeBalanceCheck?: boolean;
  playerId: string;
  sessionId?: string;
};

export type PlayerCheckoutCommands = {
  previewCheckout(input: PlayerCheckoutInput): Promise<PreviewPlayerCheckoutResult>;
  checkout(input: PlayerCheckoutInput): Promise<SettlePlayerCheckoutResult>;
};

export type StaffCheckoutOverrideInput = {
  playerId: string;
  sessionId?: string;
  staffId: string;
  total: number;
  reason: string;
};

export type StaffCheckoutCommands = {
  previewCheckout?(input: PlayerCheckoutInput): Promise<PreviewPlayerCheckoutResult>;
  checkout(input: PlayerCheckoutInput): Promise<SettlePlayerCheckoutResult>;
  checkoutWithOverride?(input: StaffCheckoutOverrideInput): Promise<SettlePlayerCheckoutResult>;
  stopSession?(input: Required<Pick<PlayerCheckoutInput, "playerId" | "sessionId">>): Promise<Session & { status: "closed"; endedAt: Date }>;
};

export type RedeemCodeInput = {
  playerId: string;
  code: string;
};

export type RedeemCommandResult = RedeemCodeResult;

export type PlayerRedeemCommands = {
  redeemCode(input: RedeemCodeInput): Promise<RedeemCommandResult>;
};

export type IntegrationIdentityBody = {
  identity?: ExternalIdentity;
  identityKey?: string;
  autoRegister?: boolean;
  displayName?: string;
};

export type IntegrationStartSessionBody = IntegrationIdentityBody & {
  pricingConfigIds?: string[];
  label?: string;
};

export type IntegrationCheckoutBody = IntegrationIdentityBody & {
  sessionId?: string;
  closeSessionsBeforeBalanceCheck?: boolean;
};

export type IntegrationStopSessionBody = IntegrationIdentityBody;

export type IntegrationRedeemBody = IntegrationIdentityBody & {
  code: string;
};

export type IntegrationAssetAdjustmentBody = IntegrationIdentityBody & {
  adjustments: StaffAdjustAssetsBody["adjustments"];
};

export type IntegrationAssetAdjustmentCommand = Omit<IntegrationAssetAdjustmentBody, "adjustments"> & {
  adjustments: Array<Omit<StaffAdjustAssetsBody["adjustments"][number], "activeAt" | "expiresAt"> & { activeAt?: Date | null; expiresAt?: Date | null }>;
};

export type IntegrationWalletAdjustmentBody = IntegrationIdentityBody & {
  amount: number;
  reason: string;
};

export type IntegrationCheckoutOverrideBody = IntegrationIdentityBody & {
  total: number;
  reason: string;
  closeSessionsBeforeBalanceCheck?: boolean;
};

export type IntegrationDeviceActionBody = IntegrationIdentityBody & {
  staffOverride?: boolean;
  target: DeviceReferenceTarget;
  action: {
    type: DeviceCommandType;
    payload?: Record<string, unknown>;
  };
};

export type IntegrationCommands = {
  resolvePlayerByIdentity(input: IntegrationIdentityBody): Promise<Player>;
  resolveOrRegisterPlayerByIdentity(input: IntegrationIdentityBody): Promise<Player>;
  startSessionByIdentity(input: IntegrationStartSessionBody): Promise<Session & { status: "active" }>;
  previewCheckoutByIdentity(input: IntegrationCheckoutBody): Promise<PreviewPlayerCheckoutResult>;
  confirmCheckoutByIdentity(input: IntegrationCheckoutBody): Promise<SettlePlayerCheckoutResult>;
  stopSessionByIdentity(input: IntegrationStopSessionBody & { sessionId: string }): Promise<Session & { status: "closed"; endedAt: Date }>;
  getWalletByIdentity(input: IntegrationIdentityBody): Promise<PlayerSummary["wallet"]>;
  getAssetsByIdentity(input: IntegrationIdentityBody): Promise<unknown>;
  getHistoryByIdentity(input: IntegrationIdentityBody): Promise<unknown>;
  redeemByIdentity(input: IntegrationRedeemBody): Promise<RedeemCommandResult>;
  adjustAssetsByIdentity(input: IntegrationAssetAdjustmentCommand): Promise<GrantAssetsResult>;
  adjustWalletByIdentity(input: IntegrationWalletAdjustmentBody): Promise<GrantAssetsResult>;
  checkoutWithOverrideByIdentity(input: IntegrationCheckoutOverrideBody): Promise<SettlePlayerCheckoutResult>;
  requestDeviceActionByIdentity(input: IntegrationDeviceActionBody): Promise<DeviceCommand>;
};

export type StaffDeviceActionBody = {
  type: DeviceCommandType;
  target: DeviceReferenceTarget;
  payload?: Record<string, unknown>;
};

export type StaffDeviceActionInput = StaffDeviceActionBody & {
  staffId: string;
};

export type StaffDeviceCommands = {
  requestDeviceAction(input: StaffDeviceActionInput): Promise<DeviceCommand>;
};

export type ServiceVersionInfo = {
  version: string;
  revision: string;
};

export type PrismAppDependencies = {
  /** Set only by the hosted platform after account and shop authorization. */
  authenticatedPrincipal?: Principal;
  versionInfo?: ServiceVersionInfo;
  playerQueries: PlayerQueries;
  staffQueries: StaffQueries;
  playerCommands: PlayerCommands;
  playerCheckoutCommands?: PlayerCheckoutCommands;
  playerRedeemCommands?: PlayerRedeemCommands;
  integrationCommands?: IntegrationCommands;
  staffCheckoutCommands?: StaffCheckoutCommands;
  staffOperations: StaffOperationsService<SettlePlayerCheckoutResult>;
  staffPlayerCommands?: StaffPlayerCommands;
  staffAssetDefinitionCommands?: StaffAssetDefinitionCommands;
  staffPricingEffectCommands?: StaffPricingEffectCommands;
  staffAssetCommands?: StaffAssetCommands;
  staffRedeemCommands?: StaffRedeemCommands;
  staffRedeemQueries?: StaffRedeemQueries;
  staffPricingCommands?: StaffPricingCommands;
  staffBusinessItemCommands?: StaffBusinessItemCommands;
  businessItemOrderCommands?: BusinessItemOrderCommands;
  staffPricingExtensions?: StaffPricingExtensionProvider;
  staffSettingsCommands?: StaffSettingsCommands;
  staffApiTokenCommands?: StaffApiTokenCommands;
  staffUserCommands?: StaffUserCommands;
  staffDeviceCommands?: StaffDeviceCommands;
  machineConnectionCommands?: MachineConnectionCommands;
  setupCommands?: SetupCommands;
  adminAuth?: AdminSessionAuth;
  apiTokenAuth?: ApiTokenAuth;
  playerAuthCommands?: PlayerAuthCommands;
  playerSessionAuth?: PlayerSessionAuth;
};

export type SetupInstallInput = {
  storeName: string;
  timeZone: string;
  owner: {
    username: string;
    displayName: string;
    password: string;
  };
  coinCooldownMs: number;
  baseAssets?: {
    paid?: {
      name?: string;
      displayUnit?: string;
    };
    free?: {
      name?: string;
      displayUnit?: string;
    };
  };
};

export type SetupInstallResult = {
  staffUser: {
    id: string;
    username: string;
    displayName: string;
    role: StaffRole;
  };
  apiTokens: Array<{
    id: string;
    label: string;
    role: ApiTokenRole;
    token: string;
    tokenPrefix: string;
    createdAt: Date;
  }>;
};

export type AdminLoginResult = {
  token: string;
  staff: {
    id: string;
    username: string;
    displayName: string;
    role: StaffRole;
  };
};

export type SetupCommands = {
  getSetupStatus(): Promise<{ installed: boolean }>;
  install(input: SetupInstallInput): Promise<SetupInstallResult>;
  login(input: AdminLoginBody): Promise<AdminLoginResult>;
};

export type RequestDeviceCommandBody = {
  type: DeviceCommandType;
  target: DeviceReferenceTarget;
  payload?: Record<string, unknown>;
};

export type RedeemCodeBody = {
  code: string;
};

export type SetupInstallBody = SetupInstallInput;

export type AdminLoginBody = {
  username: string;
  password: string;
};

export type StaffCheckoutOverrideBody = {
  total: number;
  reason: string;
};

export type StaffGrantAssetsBody = {
  reason?: string;
  grants: Array<{
    assetType: string;
    assetCode: string;
    amount: number;
    mergeStrategy: AssetMergeStrategy;
    activeAt: string | null;
    expiresAt: string | null;
    durationMs?: number;
  }>;
};

export type StaffAdjustAssetsBody = {
  adjustments: Array<{
    holdingId?: string;
    assetType: string;
    assetCode: string;
    quantityDelta: number;
    activeAt?: string | null;
    expiresAt?: string | null;
    reason: string;
  }>;
};

export type StaffWalletAdjustmentBody = {
  amount: number;
  reason: string;
};

export type StaffWalletAdjustmentInput = {
  staffId: string;
  playerId: string;
  amount: number;
  reason: string;
};

export type StaffSaveAssetDefinitionBody = {
  name: string;
  stackable: boolean;
  pricingEffectId?: string | null;
  activeAt?: string | null;
  expiresAt?: string | null;
  metadata: Record<string, unknown> | null;
};

export type StaffSavePricingEffectBody = {
  id?: string;
  name: string;
  type: PricingEffect["type"];
  scope: PricingEffect["scope"];
  value: number | null;
  consumable: boolean;
  limitPerDay: number | null;
  activeAt?: string | null;
  expiresAt?: string | null;
  status?: PricingEffect["status"];
  config: Record<string, unknown> | null;
};

export type StaffCreatePlayerBody = {
  displayName: string;
  initialGrants?: Array<{
    assetType: string;
    assetCode: string;
    amount: number;
    mergeStrategy: AssetMergeStrategy;
    activeAt: string | null;
    expiresAt: string | null;
    durationMs?: number;
  }>;
};

export type StaffUpdatePlayerStatusBody = {
  status: PlayerStatus;
};

export type PlayerIdentityBody = {
  provider: string;
  subject: string;
};

export type StaffCreatePresentBody = {
  name: string;
  oncePerPlayer: boolean;
  activeAt?: string | null;
  expiresAt?: string | null;
  grants: Array<Omit<PresentGrant, "activeAt" | "expiresAt"> & {
    activeAt: string | null;
    expiresAt: string | null;
  }>;
};

export type StaffCreateRedeemCodeBody = {
  code: string;
  presentId: string;
  activeAt: string | null;
  expiresAt: string | null;
  maxUseCount: number;
};

export type StaffCreateRedeemCodeBatchBody = {
  prefix: string;
  presentId: string;
  activeAt: string | null;
  expiresAt: string | null;
  maxUseCount: number;
  count: number;
};

export type StaffCreatePricingConfigBody = {
  kind: PricingConfigKind;
  name: string;
  enabled: boolean;
  provider: PricingConfig["provider"];
};

export type StaffCreateBusinessItemBody = {
  kind: string;
  name: string;
  price: number;
  assetType: string | null;
  assetCode: string | null;
  activeAt: string | null;
  expiresAt: string | null;
  metadata: Record<string, unknown> | null;
};

export type PurchaseBusinessItemBody = {
  metadata?: Record<string, unknown> | null;
};

export type StaffUpdatePricingConfigBody = {
  name: string;
  enabled: boolean;
  provider: PricingConfig["provider"];
};

export type StaffPreviewPricingTimelineBody = {
  localDate: string;
  provider: Extract<PricingConfig, { kind: "time.priority" | "time.cap" }>["provider"];
};

export type StaffUpdateSettingsBody = StaffSettings;

export type StaffCreateApiTokenBody = {
  label: string;
  role: ApiTokenRole;
};

export type StaffCreateUserBody = {
  username: string;
  displayName: string;
  password: string;
  role: StaffRole;
};

export type StaffUpdateUserBody = {
  displayName: string;
  role: StaffRole;
  status: StaffUserStatus;
};

export type StaffResetUserPasswordBody = {
  password: string;
};
