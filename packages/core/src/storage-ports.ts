import type { AssetDefinition, AssetHolding, AssetHoldingChanges, AssetLedgerEntry, AssetTransaction, PricingEffect } from "./assets";
import type { BusinessItem, BusinessItemOrder } from "./business-items";
import type {
  DeviceEvent,
  DeviceOperation,
  DeviceOperationStatus,
  DeviceStateAuthority,
  DeviceStateValue,
} from "./device-events";
import type { PricingConfig } from "./pricing-config";
import type { Present, RedeemCode, RedeemRecord } from "./redeem";
import type { Session } from "./session";
import type { PastAppliedAdjustment, PlayerCheckout, SettlementRecord } from "./settlement";
import type { Cents } from "./money";

export type CheckoutCommit = {
  assets: Parameters<AssetRepository["commitAssetTransaction"]>[0] | null;
  checkout: PlayerCheckout;
  settlements: readonly SettlementRecord[];
  sessions: readonly Session[];
  pricingHistory: readonly PricingHistoryEntry[];
  pricingCapHistory: readonly PricingCapHistoryEntry[];
};

export type PricingHistoryLookupKey = {
  pricingConfigId: string;
  providerId: string;
  ruleId: string;
  ruleAnchorAt: Date;
};

export type PricingHistoryEntry = {
  id: string;
  playerId: string;
  pricingConfigId: string;
  providerId: string;
  ruleId: string;
  ruleAnchorAt: Date;
  sessionId: string;
  amount: Cents;
  createdAt: Date;
  metadata: Record<string, unknown> | null;
};

export type PricingCapHistoryLookupKey = {
  capConfigId: string;
  capRuleId: string;
  capAnchorAt: Date;
  key: string;
};

export type PricingCapHistoryEntry = {
  id: string;
  playerId: string;
  capConfigId: string;
  capRuleId: string;
  capAnchorAt: Date;
  includedPricingConfigIds: string[];
  sessionIds: string[];
  amount: Cents;
  createdAt: Date;
  metadata: Record<string, unknown> | null;
};

export type PlayerStatus = "active" | "disabled" | "banned";

export type StaffRole = "owner" | "manager" | "viewer";

export type StaffUserStatus = "active" | "disabled";

export type StaffUser = {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  passwordSalt: string;
  role: StaffRole;
  status: StaffUserStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type AdminSession = {
  id: string;
  staffUserId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  lastUsedAt: Date;
};

export type PlayerSession = {
  id: string;
  playerId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  lastUsedAt: Date;
  revokedAt: Date | null;
};

export type ApiTokenRole = "integration" | "machine";

export type ApiTokenStatus = "active" | "revoked";

export type ApiToken = {
  id: string;
  label: string;
  role: ApiTokenRole;
  tokenPrefix: string;
  tokenHash: string;
  status: ApiTokenStatus;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

export type SystemRepository = {
  hasOwnerStaffUser(): Promise<boolean>;
  saveStaffUser(user: StaffUser): Promise<void>;
  listStaffUsers(): Promise<StaffUser[]>;
  findStaffUserByUsername(username: string): Promise<StaffUser | null>;
  findStaffUserById(staffUserId: string): Promise<StaffUser | null>;
  saveAdminSession(session: AdminSession): Promise<void>;
  findAdminSessionByTokenHash(tokenHash: string): Promise<AdminSession | null>;
  revokeAdminSession(sessionId: string): Promise<void>;
  saveApiToken(token: ApiToken): Promise<void>;
  saveApiTokens?(tokens: readonly ApiToken[]): Promise<void>;
  listApiTokens(): Promise<ApiToken[]>;
  findActiveApiTokenByHash(tokenHash: string): Promise<ApiToken | null>;
  updateApiTokenLastUsed(tokenId: string, usedAt: Date): Promise<void>;
  revokeApiToken(tokenId: string, revokedAt: Date): Promise<void>;
  setAppSetting(key: string, value: unknown): Promise<void>;
  setAppSettings?(settings: readonly { key: string; value: unknown }[]): Promise<void>;
  getAppSetting<T = unknown>(key: string): Promise<T | null>;
  listAppSettings(): Promise<Array<{ key: string; value: unknown; updatedAt: Date }>>;
};

export type Player = {
  /** Card UID profiles only support staff-collected external payment. */
  paymentMode?: "cashier";
  id: string;
  displayName: string;
  status: PlayerStatus;
  createdAt: Date;
};

export type PlayerIdentity = {
  playerId: string;
  provider: string;
  subject: string;
  createdAt: Date;
};

export type PlayerRepository = {
  findById(playerId: string): Promise<Player | null>;
  listPlayers(): Promise<Player[]>;
  save(player: Player): Promise<void>;
  updateStatus(playerId: string, status: PlayerStatus): Promise<void>;
};

export type PlayerIdentityRepository = {
  save(identity: PlayerIdentity): Promise<void>;
  delete(playerId: string, provider: string, subject: string): Promise<void>;
  findPlayerByIdentity(provider: string, subject: string): Promise<Player | null>;
  listByPlayerId(playerId: string): Promise<PlayerIdentity[]>;
};

export type PlayerSessionRepository = {
  save(session: PlayerSession): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<PlayerSession | null>;
  revoke(sessionId: string, revokedAt: Date): Promise<void>;
};

/**
 * One lifecycle transition: the sessions it closes and opens, written in a
 * single batch so neither half of a plan switch is committed alone. Sessions
 * closed and opened at the same instant are the record of a switch.
 */
export type SessionTransitionWrite = {
  close: readonly Session[];
  create: readonly Session[];
};

export type SessionRepository = {
  findActiveByPlayerId(playerId: string): Promise<Session[]>;
  findById(sessionId: string): Promise<Session | null>;
  findUnpaidClosedByPlayerId(playerId: string): Promise<Session[]>;
  save(session: Session): Promise<void>;
  saveMany?(sessions: readonly Session[]): Promise<void>;
  /**
   * Closes and creates sessions atomically. A close only applies to a session
   * that is still active, and the unique active-plan index refuses a second
   * session for one plan, so a transition planned from stale state fails whole.
   */
  applyTransition?(input: SessionTransitionWrite): Promise<void>;
};

export type OperationLockRepository = {
  acquire(scope: string, resourceId: string, lockId: string, acquiredAt: Date, expiresAt: Date): Promise<boolean>;
  release(scope: string, resourceId: string, lockId: string): Promise<void>;
};

export type AssetRepository = {
  listAssetHoldings(playerId: string): Promise<AssetHolding[]>;
  commitAssetTransaction(input: {
    transaction: AssetTransaction;
    holdingChanges: AssetHoldingChanges;
    assetLedgerEntries: readonly AssetLedgerEntry[];
  }): Promise<void>;
  listLedgerEntriesByPlayerId(playerId: string): Promise<AssetLedgerEntry[]>;
  listTransactionsByPlayerId(playerId: string): Promise<AssetTransaction[]>;
};

export type AssetDefinitionRepository = {
  save(definition: AssetDefinition): Promise<void>;
  saveMany?(definitions: readonly AssetDefinition[]): Promise<void>;
  findByCode(type: string, code: string): Promise<AssetDefinition | null>;
  listAll(): Promise<AssetDefinition[]>;
};

export type PricingEffectRepository = {
  save(effect: PricingEffect): Promise<void>;
  findById(effectId: string): Promise<PricingEffect | null>;
  listAll(): Promise<PricingEffect[]>;
};

export type RedeemRepository = {
  findRedeemCodeByCode(code: string): Promise<RedeemCode | null>;
  findRedeemCodeById(codeId: string): Promise<RedeemCode | null>;
  findPresentById(presentId: string): Promise<Present | null>;
  savePresent(present: Present): Promise<void>;
  listPresents(): Promise<Present[]>;
  saveRedeemCode(code: RedeemCode): Promise<void>;
  saveRedeemCodes?(codes: readonly RedeemCode[]): Promise<void>;
  listRedeemCodes(): Promise<RedeemCode[]>;
  listRedeemRecords(): Promise<RedeemRecord[]>;
  countRedeemCodeUses(codeId: string): Promise<number>;
  hasPlayerRedeemedPresent(playerId: string, presentId: string): Promise<boolean>;
  saveRedeemRecord(record: RedeemRecord): Promise<void>;
};

/** A state value to write only if it differs from what is stored. */
export type DeviceStateWrite = {
  deviceId: string;
  capability: string;
  key: string;
  value: unknown;
  authority: DeviceStateAuthority;
  /** When the value took effect at its source; used when no change event carries a time. */
  at?: Date;
};

/**
 * Everything one device occurrence changes, applied atomically: the events,
 * any operation they create or settle, and any state they move. A state write
 * whose value is unchanged is dropped together with its `change` event, so a
 * repeated observation never grows the log.
 */
export type DeviceRecord = {
  events: readonly DeviceEvent[];
  operation?: DeviceOperation;
  settle?: {
    operationId: string;
    status: DeviceOperationStatus;
    failure: string | null;
    settledAt: Date;
  };
  /** Only an operation aimed at `deviceId` can be confirmed by it. */
  confirm?: { operationId: string; deviceId: string; confirmedAt: Date };
  /**
   * Without `event` the state is only stored: a view that changes too often to
   * be worth a log row, such as an air conditioner's room temperature.
   */
  states?: readonly { write: DeviceStateWrite; event?: DeviceEvent }[];
};

export type DeviceEventRepository = {
  record(input: DeviceRecord): Promise<void>;
  listEvents(input: { deviceId: string; limit: number }): Promise<DeviceEvent[]>;
  getOperation(id: string): Promise<DeviceOperation | null>;
  listOperationsByPlayer(playerId: string): Promise<DeviceOperation[]>;
  listRecentOperations(limit: number): Promise<DeviceOperation[]>;
  listState(deviceIds?: readonly string[]): Promise<DeviceStateValue[]>;
};

export type MachineConnectionStatus = "online" | "offline";

export type MachineConnection = {
  machineId: string;
  status: MachineConnectionStatus;
  capabilities: string[];
  connectedAt: Date;
  lastSeenAt: Date;
  disconnectedAt?: Date;
};

export type SettlementRepository = {
  saveSettlement(record: SettlementRecord): Promise<void>;
  saveSettlements?(records: readonly SettlementRecord[]): Promise<void>;
  saveCheckout(checkout: PlayerCheckout, records: readonly SettlementRecord[]): Promise<void>;
  findSettlementBySessionId(sessionId: string): Promise<SettlementRecord | null>;
  listPastAppliedAdjustmentsByPlayerId(playerId: string): Promise<PastAppliedAdjustment[]>;
};

export type ReportArchiveRepository = {
  setArchived(input: {
    checkoutId: string;
    archived: boolean;
    staffId: string;
    at: Date;
  }): Promise<boolean>;
};

export type PricingConfigRepository = {
  findRelease?(releaseId: string): Promise<import("./pricing-config").PricingRelease | null>;
  save(config: PricingConfig): Promise<void>;
  findById(configId: string): Promise<PricingConfig | null>;
  listAll(): Promise<PricingConfig[]>;
  listEnabled(): Promise<PricingConfig[]>;
};

export type PricingHistoryRepository = {
  sumByPlayerAndKeys(
    playerId: string,
    keys: readonly PricingHistoryLookupKey[],
  ): Promise<Record<string, Cents>>;
  appendEntries(entries: readonly PricingHistoryEntry[]): Promise<void>;
};

export type PricingCapHistoryRepository = {
  sumByPlayerAndKeys(
    playerId: string,
    keys: readonly PricingCapHistoryLookupKey[],
  ): Promise<Record<string, Cents>>;
  appendEntries(entries: readonly PricingCapHistoryEntry[]): Promise<void>;
};

export type BusinessItemRepository = {
  save(item: BusinessItem): Promise<void>;
  findById(itemId: string): Promise<BusinessItem | null>;
  listAll(): Promise<BusinessItem[]>;
};

export type BusinessItemOrderRepository = {
  save(order: BusinessItemOrder): Promise<void>;
  findById(orderId: string): Promise<BusinessItemOrder | null>;
  listAll(): Promise<BusinessItemOrder[]>;
  listByPlayerId(playerId: string): Promise<BusinessItemOrder[]>;
  countOpenByItemId(itemId: string): Promise<number>;
};
