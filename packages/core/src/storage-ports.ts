import type { AssetDefinition, AssetHolding, AssetHoldingChanges, AssetLedgerEntry, AssetTransaction, PricingEffect } from "./assets";
import type { BusinessItem, BusinessItemOrder } from "./business-items";
import type { DeviceCommand, DeviceState } from "./device-command";
import type { PricingConfig } from "./pricing-config";
import type { Present, RedeemCode, RedeemRecord } from "./redeem";
import type { Session } from "./session";
import type { PastAppliedAdjustment, PlayerCheckout, SettlementRecord } from "./settlement";
import type { Cents } from "./money";

export type CheckoutCommit = {
  assets: Parameters<AssetRepository["commitAssetTransaction"]>[0];
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

export type SessionRepository = {
  findActiveByPlayerId(playerId: string): Promise<Session[]>;
  findById(sessionId: string): Promise<Session | null>;
  findUnpaidClosedByPlayerId(playerId: string): Promise<Session[]>;
  save(session: Session): Promise<void>;
  saveMany?(sessions: readonly Session[]): Promise<void>;
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

export type DeviceCommandRepository = {
  enqueueDeviceCommand(command: DeviceCommand): Promise<void>;
  getDeviceCommand(commandId: string): Promise<DeviceCommand | null>;
  listByPlayerId(playerId: string): Promise<DeviceCommand[]>;
  listPending(limit: number): Promise<DeviceCommand[]>;
};

export type DeviceStateRepository = {
  save(state: DeviceState): Promise<void>;
  saveMany(states: readonly DeviceState[]): Promise<void>;
  listAll(): Promise<DeviceState[]>;
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

export type MachineConnectionRepository = {
  save(connection: MachineConnection): Promise<void>;
  findByMachineId(machineId: string): Promise<MachineConnection | null>;
  listAll(): Promise<MachineConnection[]>;
};

export type SettlementRepository = {
  saveSettlement(record: SettlementRecord): Promise<void>;
  saveSettlements?(records: readonly SettlementRecord[]): Promise<void>;
  saveCheckout(checkout: PlayerCheckout, records: readonly SettlementRecord[]): Promise<void>;
  findSettlementBySessionId(sessionId: string): Promise<SettlementRecord | null>;
  listPastAppliedAdjustmentsByPlayerId(playerId: string): Promise<PastAppliedAdjustment[]>;
};

export type PricingConfigRepository = {
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
