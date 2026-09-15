import { assetQuantityOf, centsOf, subCents, sumCents } from "@prism/core";
import { sqlShop, shopValues, serializePricingProviderConfig, serializePresentGrants } from "@prism/storage-sql";
import type {
  AssetDefinition,
  AssetHolding,
  AssetLedgerEntry,
  DeviceCommand,
  Player,
  PlayerIdentity,
  PricingConfig,
  PricingHistoryEntry,
  Present,
  RedeemCode,
  RedeemRecord,
  SettlementRecord,
  Session,
} from "@prism/core";
import { maxSqlParametersPerStatement, runSqlValuesInBatches, type SqlExecutor } from "@prism/storage-sql";
import {
  optionalBoolean,
  optionalJson,
  optionalNumber,
  optionalString,
  requiredBoolean,
  requiredJson,
  requiredNumber,
  requiredString,
  requiredValue,
} from "./legacy-row";

export type PrismNeoUser = {
  id: number;
  createdAt: Date;
  isBanned: boolean;
};

export type PrismNeoBind = {
  id: number;
  userId: number;
  type: string;
  bid: string;
};

export type PrismNeoAssetDefinition = {
  id: number;
  type: string;
  assetId: number;
  name: string;
  valid: boolean;
  description?: string | null;
  activeAt?: Date | null;
  expireAt?: Date | null;
  billingEffect?: unknown;
};

export type PrismNeoUserAsset = {
  id: number;
  userId: number;
  assetDefId: number;
  assetType: string;
  count: number;
  activeAt?: Date | null;
  expireAt?: Date | null;
  hide?: boolean;
};

export type PrismNeoUserAssetLog = {
  id: number;
  userId: number;
  userAssetId?: number | null;
  assetId: number;
  assetType: string;
  changeAmount: number;
  action: string;
  comment?: string | null;
  createdAt?: Date;
};

export type PrismNeoSession = {
  id: number;
  userId: number;
  createdAt: Date;
  closedAt?: Date | null;
  isActive?: boolean | null;
  billingCost?: number | null;
  finalCost?: number | null;
  costOverwrite?: number | null;
};

export type PrismNeoBillingRule = {
  id: number;
  name: string;
  available: boolean;
  priority: number;
  matchDate?: {
    specificDates?: string[];
    weekdays?: number[];
  } | null;
  timeRange:
    | {
        start: string;
        end: string;
      }
    | {
        isDateTimeRange: true;
        start: string | Date;
        end: string | Date;
      };
  pricing: {
    unitMinutes: number;
    unitPrice: number;
    priceCap: number;
    roundGraceMinutes: number;
  };
};

export type PrismNeoBillingRecord = {
  id: number;
  userId: number;
  ruleId: number;
  ruleStartTimeStamp: number | bigint;
  cost: number;
  billingStart: Date;
  billingEnd: Date;
  durationMin: number;
};

export type PrismNeoPresent = {
  id: number;
  name: string;
  oncePerUser: boolean;
  body: PrismNeoPresentGrant[];
};

export type PrismNeoPresentGrant = {
  id?: number;
  name?: string;
  assetType?: string;
  assetId?: number;
  count?: number;
  mergeStrategy?: "STACK" | "EXTEND_TIME" | "REPLACE" | string;
  activeAt?: Date | string | null;
  expireAt?: Date | string | null;
  durationMs?: number;
};

export type PrismNeoRedeem = {
  id: number;
  code: string;
  presentId: number;
  activeAt?: Date | null;
  expireAt?: Date | null;
  maxUseCount: number;
};

export type PrismNeoRedeemRecord = {
  id: number;
  userId: number;
  redeemId: number;
  presentId: number;
  date: Date;
};

export type PrismNeoCoinRecord = {
  id: number;
  userId: number;
  machineName: string;
  count: number;
  createAt: Date;
};

export type CreatePrismNeoMigrationPlanInput = {
  exportedAt: Date;
  users?: readonly PrismNeoUser[];
  binds?: readonly PrismNeoBind[];
  assetDefinitions?: readonly PrismNeoAssetDefinition[];
  userAssets?: readonly PrismNeoUserAsset[];
  userAssetLogs?: readonly PrismNeoUserAssetLog[];
  sessions?: readonly PrismNeoSession[];
  billingRules?: readonly PrismNeoBillingRule[];
  billingRecords?: readonly PrismNeoBillingRecord[];
  presents?: readonly PrismNeoPresent[];
  redeems?: readonly PrismNeoRedeem[];
  redeemRecords?: readonly PrismNeoRedeemRecord[];
  coinRecords?: readonly PrismNeoCoinRecord[];
};

export type PrismNeoPostgresSql = (strings: TemplateStringsArray) => Promise<readonly Record<string, unknown>[]>;

export type ExportPrismNeoPostgresSnapshotInput = {
  sql: PrismNeoPostgresSql;
  exportedAt?: Date;
};

export type MigratedAssetHolding = AssetHolding & {
  playerId: string;
};

export type MigratedAssetLedgerEntry = AssetLedgerEntry & {
  id: string;
  playerId: string;
  createdAt: Date;
};

export type MigratedDeviceCommand = DeviceCommand & {
  playerId: string;
};

export type PrismNeoMigrationPlan = {
  players: Player[];
  playerIdentities: PlayerIdentity[];
  assetDefinitions: AssetDefinition[];
  assetHoldings: MigratedAssetHolding[];
  assetLedgerEntries: MigratedAssetLedgerEntry[];
  sessions: Session[];
  settlements: SettlementRecord[];
  pricingConfigs: PricingConfig[];
  pricingHistoryEntries: PricingHistoryEntry[];
  presents: Present[];
  redeemCodes: RedeemCode[];
  redeemRecords: RedeemRecord[];
  deviceCommands: MigratedDeviceCommand[];
};

export type ImportPrismNeoMigrationPlanInput = {
  executor: SqlExecutor;
  plan: PrismNeoMigrationPlan;
};

export async function exportPrismNeoPostgresSnapshot(
  input: ExportPrismNeoPostgresSnapshotInput,
): Promise<CreatePrismNeoMigrationPlanInput> {
  return {
    exportedAt: input.exportedAt ?? new Date(),
    users: await readPostgresUsers(input.sql),
    binds: await readPostgresBinds(input.sql),
    assetDefinitions: await readPostgresAssetDefinitions(input.sql),
    userAssets: await readPostgresUserAssets(input.sql),
    userAssetLogs: await readPostgresUserAssetLogs(input.sql),
    sessions: await readPostgresSessions(input.sql),
    billingRules: await readPostgresBillingRules(input.sql),
    billingRecords: await readPostgresBillingRecords(input.sql),
    presents: await readPostgresPresents(input.sql),
    redeems: await readPostgresRedeems(input.sql),
    redeemRecords: await readPostgresRedeemRecords(input.sql),
    coinRecords: await readPostgresCoinRecords(input.sql),
  };
}

async function deleteMigrationRowsBySessionIds(
  executor: SqlExecutor,
  table: string,
  sessionIds: readonly string[],
): Promise<void> {
  const uniqueIds = [...new Set(sessionIds)];
  for (let offset = 0; offset < uniqueIds.length; offset += maxSqlParametersPerStatement) {
    const chunk = uniqueIds.slice(offset, offset + maxSqlParametersPerStatement);
    await executor.run(
      `DELETE FROM ${table} WHERE shop_id = ${sqlShop(executor)} AND session_id IN (${chunk.map(() => "?").join(", ")})`,
      chunk,
    );
  }
}

export async function importPrismNeoMigrationPlan(input: ImportPrismNeoMigrationPlanInput): Promise<void> {
  const { executor, plan } = input;

  await runSqlValuesInBatches(
    executor,
    plan.players.map((player) => [player.id, player.displayName, player.status, player.createdAt.toISOString()]),
    (values) => `INSERT INTO players (shop_id, id, display_name, status, created_at)
       VALUES ${shopValues(executor, values)}
       ON CONFLICT(shop_id, id) DO UPDATE SET
         display_name = excluded.display_name,
         status = excluded.status,
         created_at = excluded.created_at`,
  );

  await runSqlValuesInBatches(
    executor,
    plan.assetDefinitions.map((definition) => [
      definition.type,
      definition.code,
      definition.name,
      definition.stackable ? 1 : 0,
      definition.metadata ? JSON.stringify(definition.metadata) : null,
    ]),
    (values) => `INSERT INTO asset_definitions (shop_id, type, code, name, stackable, metadata_json)
       VALUES ${shopValues(executor, values)}
       ON CONFLICT(shop_id, type, code) DO UPDATE SET
         name = excluded.name,
         stackable = excluded.stackable,
         metadata_json = excluded.metadata_json`,
  );

  await runSqlValuesInBatches(
    executor,
    plan.playerIdentities.map((identity) => [
      identity.playerId,
      identity.provider,
      identity.subject,
      identity.createdAt.toISOString(),
    ]),
    (values) => `INSERT INTO player_identities (shop_id, player_id, provider, subject, created_at)
       VALUES ${shopValues(executor, values)}
       ON CONFLICT(shop_id, provider, subject) DO UPDATE SET
         player_id = excluded.player_id,
         created_at = excluded.created_at`,
  );

  await runSqlValuesInBatches(
    executor,
    plan.assetHoldings.map((holding) => [
      holding.id ?? null,
      holding.playerId,
      holding.assetType,
      holding.assetCode,
      holding.quantity,
      holding.activeAt?.toISOString() ?? null,
      holding.expiresAt?.toISOString() ?? null,
    ]),
    (values) => `INSERT INTO asset_holdings (shop_id, id, player_id, asset_type, asset_code, quantity, active_at, expires_at)
       VALUES ${shopValues(executor, values)}
       ON CONFLICT(shop_id, id) DO UPDATE SET
         player_id = excluded.player_id,
         asset_type = excluded.asset_type,
         asset_code = excluded.asset_code,
         quantity = excluded.quantity,
         active_at = excluded.active_at,
         expires_at = excluded.expires_at`,
  );

  await runSqlValuesInBatches(
    executor,
    plan.assetLedgerEntries.map((entry) => [
      entry.id,
      entry.playerId,
      entry.assetType,
      entry.assetCode,
      entry.delta,
      entry.reason,
      entry.refId,
      entry.createdAt.toISOString(),
    ]),
    (values) => `INSERT INTO asset_ledger_entries (shop_id, id, player_id, asset_type, asset_code, delta, reason, ref_id, created_at)
       VALUES ${shopValues(executor, values)}
       ON CONFLICT(shop_id, id) DO UPDATE SET
         player_id = excluded.player_id,
         asset_type = excluded.asset_type,
         asset_code = excluded.asset_code,
         delta = excluded.delta,
         reason = excluded.reason,
         ref_id = excluded.ref_id,
         created_at = excluded.created_at`,
  );

  await runSqlValuesInBatches(
    executor,
    plan.sessions.map((session) => [
      session.id,
      session.playerId,
      session.startedAt.toISOString(),
      session.endedAt?.toISOString() ?? null,
      session.status ?? "active",
      session.paymentStatus ?? "unpaid",
    ]),
    (values) => `INSERT INTO sessions (shop_id, id, player_id, started_at, ended_at, status, payment_status)
       VALUES ${shopValues(executor, values)}
       ON CONFLICT(shop_id, id) DO UPDATE SET
         player_id = excluded.player_id,
         started_at = excluded.started_at,
         ended_at = excluded.ended_at,
         status = excluded.status,
         payment_status = excluded.payment_status`,
  );

  await runSqlValuesInBatches(
    executor,
    plan.settlements.map(({ settlement }) => [
      `legacy:settlement:${settlement.sessionId}`,
      settlement.sessionId,
      settlement.subtotal,
      settlement.total,
      settlement.status,
      settlement.settledAt.toISOString(),
    ]),
    (values) => `INSERT INTO settlements (shop_id, id, session_id, subtotal, total, status, settled_at)
       VALUES ${shopValues(executor, values)}
       ON CONFLICT(shop_id, session_id) DO UPDATE SET
         subtotal = excluded.subtotal,
         total = excluded.total,
         status = excluded.status,
         settled_at = excluded.settled_at`,
  );
  const settlementSessionIds = plan.settlements.map(({ settlement }) => settlement.sessionId);
  await deleteMigrationRowsBySessionIds(executor, "settlement_charge_items", settlementSessionIds);
  await deleteMigrationRowsBySessionIds(executor, "settlement_adjustments", settlementSessionIds);
  await runSqlValuesInBatches(
    executor,
    plan.settlements.flatMap((record) => record.chargeItems.map((item, index) => [
      item.id,
      record.settlement.sessionId,
      index,
      item.source,
      item.label,
      item.amount,
    ])),
    (values) => `INSERT INTO settlement_charge_items (shop_id, id, session_id, item_order, source, label, amount)
                 VALUES ${shopValues(executor, values)}`,
  );
  await runSqlValuesInBatches(
    executor,
    plan.settlements.flatMap((record) => record.adjustments.map((adjustment, index) => [
      adjustment.id,
      record.settlement.sessionId,
      index,
      adjustment.source,
      adjustment.label,
      adjustment.amount,
    ])),
    (values) => `INSERT INTO settlement_adjustments (shop_id, id, session_id, adjustment_order, source, label, amount)
                 VALUES ${shopValues(executor, values)}`,
  );

  await runSqlValuesInBatches(
    executor,
    plan.pricingConfigs.map((config) => [
      config.id,
      config.kind,
      config.name,
      config.enabled ? 1 : 0,
      JSON.stringify(serializePricingProviderConfig(config.provider)),
      config.createdAt.toISOString(),
      config.updatedAt.toISOString(),
    ]),
    (values) => `INSERT INTO pricing_configs (shop_id, id, kind, name, enabled, provider_json, created_at, updated_at)
       VALUES ${shopValues(executor, values)}
       ON CONFLICT(shop_id, id) DO UPDATE SET
         kind = excluded.kind,
         name = excluded.name,
         enabled = excluded.enabled,
         provider_json = excluded.provider_json,
         updated_at = excluded.updated_at`,
  );

  await runSqlValuesInBatches(
    executor,
    plan.pricingHistoryEntries.map((entry) => [
      entry.id,
      entry.playerId,
      entry.pricingConfigId,
      entry.providerId,
      entry.ruleId,
      entry.ruleAnchorAt.toISOString(),
      entry.sessionId,
      entry.amount,
      entry.createdAt.toISOString(),
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    ]),
    (values) => `INSERT INTO pricing_history_entries (shop_id, id, player_id, pricing_config_id, provider_id, rule_id, rule_anchor_at, session_id, amount, created_at, metadata_json)
       VALUES ${shopValues(executor, values)}
       ON CONFLICT(shop_id, id) DO UPDATE SET
         player_id = excluded.player_id,
         pricing_config_id = excluded.pricing_config_id,
         provider_id = excluded.provider_id,
         rule_id = excluded.rule_id,
         rule_anchor_at = excluded.rule_anchor_at,
         session_id = excluded.session_id,
         amount = excluded.amount,
         created_at = excluded.created_at,
         metadata_json = excluded.metadata_json`,
  );

  await runSqlValuesInBatches(
    executor,
    plan.presents.map((present) => [
      present.id,
      present.name,
      present.oncePerPlayer ? 1 : 0,
      JSON.stringify(serializePresentGrants(present.grants)),
    ]),
    (values) => `INSERT INTO presents (shop_id, id, name, once_per_player, grants_json)
       VALUES ${shopValues(executor, values)}
       ON CONFLICT(shop_id, id) DO UPDATE SET
         name = excluded.name,
         once_per_player = excluded.once_per_player,
         grants_json = excluded.grants_json`,
  );

  await runSqlValuesInBatches(
    executor,
    plan.redeemCodes.map((code) => [
      code.id,
      code.code,
      code.presentId,
      code.activeAt?.toISOString() ?? null,
      code.expiresAt?.toISOString() ?? null,
      code.maxUseCount,
    ]),
    (values) => `INSERT INTO redeem_codes (shop_id, id, code, present_id, active_at, expires_at, max_use_count)
       VALUES ${shopValues(executor, values)}
       ON CONFLICT(shop_id, id) DO UPDATE SET
         code = excluded.code,
         present_id = excluded.present_id,
         active_at = excluded.active_at,
         expires_at = excluded.expires_at,
         max_use_count = excluded.max_use_count`,
  );

  await runSqlValuesInBatches(
    executor,
    plan.redeemRecords.map((record) => [
      `legacy:redeem-record:${record.playerId}:${record.codeId}`,
      record.playerId,
      record.codeId,
      record.presentId,
      record.redeemedAt.toISOString(),
    ]),
    (values) => `INSERT INTO redeem_records (shop_id, id, player_id, code_id, present_id, redeemed_at)
       VALUES ${shopValues(executor, values)}
       ON CONFLICT(shop_id, id) DO UPDATE SET
         player_id = excluded.player_id,
         code_id = excluded.code_id,
         present_id = excluded.present_id,
         redeemed_at = excluded.redeemed_at`,
  );

  await runSqlValuesInBatches(
    executor,
    plan.deviceCommands.map((command) => [
      command.id,
      command.type,
      command.deviceId,
      command.targetKind,
      command.executorKind,
      command.playerId,
      command.staffId ?? null,
      command.status,
      command.payload ? JSON.stringify(command.payload) : null,
      command.requestedAt.toISOString(),
      command.ackedAt?.toISOString() ?? null,
      command.expiredAt?.toISOString() ?? null,
    ]),
    (values) => `INSERT INTO device_commands (shop_id, id, type, device_id, target_kind, executor_kind, player_id, staff_id, status, payload_json, requested_at, acked_at, expired_at)
       VALUES ${shopValues(executor, values)}
       ON CONFLICT(shop_id, id) DO UPDATE SET
         type = excluded.type,
         device_id = excluded.device_id,
         target_kind = excluded.target_kind,
         executor_kind = excluded.executor_kind,
         player_id = excluded.player_id,
         staff_id = excluded.staff_id,
         status = excluded.status,
         payload_json = excluded.payload_json,
         requested_at = excluded.requested_at,
         acked_at = excluded.acked_at,
         expired_at = excluded.expired_at`,
  );
}

export function createPrismNeoMigrationPlan(input: CreatePrismNeoMigrationPlanInput): PrismNeoMigrationPlan {
  const sessions = input.sessions ?? [];
  const assetDefinitions = input.assetDefinitions ?? [];
  const billingRecordsByUser = groupBy(input.billingRecords ?? [], (record) => legacyUserId(record.userId));
  const assetDefinitionsByLegacyId = new Map(assetDefinitions.map((definition) => [definition.id, definition]));

  return {
    players: (input.users ?? []).map(toPlayer),
    playerIdentities: (input.binds ?? []).map((bind) => toPlayerIdentity(bind, input.exportedAt)),
    assetDefinitions: toAssetDefinitions(
      assetDefinitions,
      input.userAssets ?? [],
      input.userAssetLogs ?? [],
    ),
    assetHoldings: (input.userAssets ?? []).map(toAssetHolding),
    assetLedgerEntries: (input.userAssetLogs ?? []).map((entry) => toAssetLedgerEntry(entry, input.exportedAt)),
    sessions: sessions.map(toSession),
    settlements: toSettlements(sessions, billingRecordsByUser),
    pricingConfigs: toPricingConfigs(input.billingRules ?? [], input.exportedAt),
    pricingHistoryEntries: toPricingHistoryEntries(input.billingRecords ?? []),
    presents: (input.presents ?? []).map((present) => toPresent(present, assetDefinitionsByLegacyId)),
    redeemCodes: (input.redeems ?? []).map(toRedeemCode),
    redeemRecords: (input.redeemRecords ?? []).map(toRedeemRecord),
    deviceCommands: (input.coinRecords ?? []).map(toCoinDeviceCommand),
  };
}

async function readPostgresUsers(sql: PrismNeoPostgresSql): Promise<PrismNeoUser[]> {
  const rows = await sql`SELECT "id", "createdAt", "isBanned" FROM "User" ORDER BY "id"`;
  return rows.map((row) => ({
    id: requiredNumber(row, "id"),
    createdAt: requiredDate(row, "createdAt"),
    isBanned: requiredBoolean(row, "isBanned"),
  }));
}

async function readPostgresBinds(sql: PrismNeoPostgresSql): Promise<PrismNeoBind[]> {
  const rows = await sql`SELECT "id", "userId", "type", "bid" FROM "Bind" ORDER BY "id"`;
  return rows.map((row) => ({
    id: requiredNumber(row, "id"),
    userId: requiredNumber(row, "userId"),
    type: requiredString(row, "type"),
    bid: requiredString(row, "bid"),
  }));
}

async function readPostgresAssetDefinitions(sql: PrismNeoPostgresSql): Promise<PrismNeoAssetDefinition[]> {
  const rows =
    await sql`SELECT "id", "assetId", "type", "name", "description", "valid", "activeAt", "expireAt", "billingEffect" FROM "Asset" ORDER BY "id"`;
  return rows.map((row) => ({
    id: requiredNumber(row, "id"),
    assetId: requiredNumber(row, "assetId"),
    type: requiredString(row, "type"),
    name: requiredString(row, "name"),
    description: optionalString(row, "description"),
    valid: requiredBoolean(row, "valid"),
    activeAt: optionalDate(row, "activeAt"),
    expireAt: optionalDate(row, "expireAt"),
    billingEffect: optionalJson(row, "billingEffect"),
  }));
}

async function readPostgresUserAssets(sql: PrismNeoPostgresSql): Promise<PrismNeoUserAsset[]> {
  const rows =
    await sql`SELECT "id", "userId", "assetDefId", "assetType", "count", "activeAt", "expireAt", "hide" FROM "UserAsset" ORDER BY "id"`;
  return rows.map((row) => ({
    id: requiredNumber(row, "id"),
    userId: requiredNumber(row, "userId"),
    assetDefId: requiredNumber(row, "assetDefId"),
    assetType: requiredString(row, "assetType"),
    count: requiredNumber(row, "count"),
    activeAt: optionalDate(row, "activeAt"),
    expireAt: optionalDate(row, "expireAt"),
    hide: optionalBoolean(row, "hide") ?? false,
  }));
}

async function readPostgresUserAssetLogs(sql: PrismNeoPostgresSql): Promise<PrismNeoUserAssetLog[]> {
  const rows =
    await sql`SELECT "id", "userId", "userAssetId", "assetId", "assetType", "changeAmount", "action", "comment", "createdAt" FROM "UserAssetLog" ORDER BY "id"`;
  return rows.map((row) => ({
    id: requiredNumber(row, "id"),
    userId: requiredNumber(row, "userId"),
    userAssetId: optionalNumber(row, "userAssetId"),
    assetId: requiredNumber(row, "assetId"),
    assetType: requiredString(row, "assetType"),
    changeAmount: requiredNumber(row, "changeAmount"),
    action: requiredString(row, "action"),
    comment: optionalString(row, "comment"),
    createdAt: optionalDate(row, "createdAt") ?? undefined,
  }));
}

async function readPostgresSessions(sql: PrismNeoPostgresSql): Promise<PrismNeoSession[]> {
  const rows =
    await sql`SELECT "id", "userId", "createdAt", "closedAt", "isActive", "billingCost", "finalCost", "costOverwrite" FROM "Session" ORDER BY "id"`;
  return rows.map((row) => ({
    id: requiredNumber(row, "id"),
    userId: requiredNumber(row, "userId"),
    createdAt: requiredDate(row, "createdAt"),
    closedAt: optionalDate(row, "closedAt"),
    isActive: optionalBoolean(row, "isActive"),
    billingCost: optionalNumber(row, "billingCost"),
    finalCost: optionalNumber(row, "finalCost"),
    costOverwrite: optionalNumber(row, "costOverwrite"),
  }));
}

async function readPostgresBillingRules(sql: PrismNeoPostgresSql): Promise<PrismNeoBillingRule[]> {
  const rows = await sql`SELECT "id", "name", "available", "priority", "matchDate", "timeRange", "pricing" FROM "BillingRule" ORDER BY "id"`;
  return rows.map((row) => ({
    id: requiredNumber(row, "id"),
    name: requiredString(row, "name"),
    available: requiredBoolean(row, "available"),
    priority: requiredNumber(row, "priority"),
    matchDate: optionalJson(row, "matchDate") as PrismNeoBillingRule["matchDate"],
    timeRange: requiredJson(row, "timeRange") as PrismNeoBillingRule["timeRange"],
    pricing: requiredJson(row, "pricing") as PrismNeoBillingRule["pricing"],
  }));
}

async function readPostgresBillingRecords(sql: PrismNeoPostgresSql): Promise<PrismNeoBillingRecord[]> {
  const rows =
    await sql`SELECT "id", "userId", "ruleId", "ruleStartTimeStamp", "cost", "billingStart", "billingEnd", "durationMin" FROM "BillingRecord" ORDER BY "id"`;
  return rows.map((row) => ({
    id: requiredNumber(row, "id"),
    userId: requiredNumber(row, "userId"),
    ruleId: requiredNumber(row, "ruleId"),
    ruleStartTimeStamp: requiredNumber(row, "ruleStartTimeStamp"),
    cost: requiredNumber(row, "cost"),
    billingStart: requiredDate(row, "billingStart"),
    billingEnd: requiredDate(row, "billingEnd"),
    durationMin: requiredNumber(row, "durationMin"),
  }));
}

async function readPostgresPresents(sql: PrismNeoPostgresSql): Promise<PrismNeoPresent[]> {
  const rows = await sql`SELECT "id", "name", "oncePerUser", "body" FROM "Present" ORDER BY "id"`;
  return rows.map((row) => ({
    id: requiredNumber(row, "id"),
    name: requiredString(row, "name"),
    oncePerUser: requiredBoolean(row, "oncePerUser"),
    body: requiredJson(row, "body") as PrismNeoPresent["body"],
  }));
}

async function readPostgresRedeems(sql: PrismNeoPostgresSql): Promise<PrismNeoRedeem[]> {
  const rows = await sql`SELECT "id", "code", "presentId", "activeAt", "expireAt", "maxUseCount" FROM "Redeem" ORDER BY "id"`;
  return rows.map((row) => ({
    id: requiredNumber(row, "id"),
    code: requiredString(row, "code"),
    presentId: requiredNumber(row, "presentId"),
    activeAt: optionalDate(row, "activeAt"),
    expireAt: optionalDate(row, "expireAt"),
    maxUseCount: requiredNumber(row, "maxUseCount"),
  }));
}

async function readPostgresRedeemRecords(sql: PrismNeoPostgresSql): Promise<PrismNeoRedeemRecord[]> {
  const rows = await sql`SELECT "id", "userId", "redeemId", "presentId", "date" FROM "RedeemRecord" ORDER BY "id"`;
  return rows.map((row) => ({
    id: requiredNumber(row, "id"),
    userId: requiredNumber(row, "userId"),
    redeemId: requiredNumber(row, "redeemId"),
    presentId: requiredNumber(row, "presentId"),
    date: requiredDate(row, "date"),
  }));
}

async function readPostgresCoinRecords(sql: PrismNeoPostgresSql): Promise<PrismNeoCoinRecord[]> {
  const rows = await sql`SELECT "id", "userId", "machineName", "count", "createAt" FROM "CoinRecord" ORDER BY "id"`;
  return rows.map((row) => ({
    id: requiredNumber(row, "id"),
    userId: requiredNumber(row, "userId"),
    machineName: requiredString(row, "machineName"),
    count: requiredNumber(row, "count"),
    createAt: requiredDate(row, "createAt"),
  }));
}

function requiredDate(row: Record<string, unknown>, key: string): Date {
  const date = toDate(requiredValue(row, key), key);
  if (!date) throw new Error(`Legacy column ${key} is required.`);
  return date;
}

function optionalDate(row: Record<string, unknown>, key: string): Date | null {
  return toDate(row[key], key);
}

function toDate(value: unknown, key: string): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value;

  const date =
    typeof value === "number" || typeof value === "bigint"
      ? new Date(Number(value))
      : typeof value === "string"
        ? new Date(value)
        : null;
  if (!date || Number.isNaN(date.getTime())) throw new Error(`Legacy column ${key} must be a date-like value.`);
  return date;
}

function toPlayer(user: PrismNeoUser): Player {
  return {
    id: legacyUserId(user.id),
    displayName: `Player ${user.id}`,
    status: user.isBanned ? "banned" : "active",
    createdAt: user.createdAt,
  };
}

function toPlayerIdentity(bind: PrismNeoBind, exportedAt: Date): PlayerIdentity {
  return {
    playerId: legacyUserId(bind.userId),
    provider: bind.type.toLowerCase(),
    subject: bind.bid,
    createdAt: exportedAt,
  };
}

function toAssetDefinitions(
  definitions: readonly PrismNeoAssetDefinition[],
  holdings: readonly PrismNeoUserAsset[],
  ledgerEntries: readonly PrismNeoUserAssetLog[] = [],
): AssetDefinition[] {
  const hiddenKeys = new Set(
    holdings.filter((holding) => holding.hide === true).map((holding) => assetKey(holding.assetType, holding.assetDefId)),
  );

  const existingDefinitionKeys = new Set(
    definitions.map((definition) => assetKey(definition.type, definition.assetId)),
  );

  const result = definitions.map((definition) => {
    const mapped = mapLegacyAsset(definition.type, definition.assetId);
    const metadata: Record<string, unknown> = {
      legacy: {
        type: definition.type,
        assetId: definition.assetId,
        id: definition.id,
      },
      valid: definition.valid,
    };

    if (definition.billingEffect !== undefined) metadata.billingEffect = definition.billingEffect;
    if (hiddenKeys.has(assetKey(definition.type, definition.assetId))) metadata.hiddenFromPlayer = true;

    return {
      type: mapped.type,
      code: mapped.code,
      name: definition.name,
      stackable: true,
      metadata,
    };
  });

  const synthesizeIfMissing = (type: string, assetId: number) => {
    const key = assetKey(type, assetId);
    if (!existingDefinitionKeys.has(key)) {
      const mapped = mapLegacyAsset(type, assetId);
      const name = `Legacy ${type} ${assetId}`;
      result.push({
        type: mapped.type,
        code: mapped.code,
        name,
        stackable: true,
        metadata: {
          legacy: {
            type,
            assetId,
          },
          valid: true,
          synthesized: true,
        },
      });
      existingDefinitionKeys.add(key);
      console.warn(
        `[Migration Warning] Synthesized missing asset definition: type=${type}, assetId=${assetId}`,
      );
    }
  };

  for (const holding of holdings) {
    synthesizeIfMissing(holding.assetType, holding.assetDefId);
  }

  for (const log of ledgerEntries) {
    synthesizeIfMissing(log.assetType, log.assetId);
  }

  return result;
}

function toAssetHolding(holding: PrismNeoUserAsset): MigratedAssetHolding {
  const mapped = mapLegacyAsset(holding.assetType, holding.assetDefId);
  return {
    id: `legacy:user-asset:${holding.id}`,
    playerId: legacyUserId(holding.userId),
    assetType: mapped.type,
    assetCode: mapped.code,
    quantity: assetQuantityOf(mapped.type, holding.count),
    activeAt: holding.activeAt ?? null,
    expiresAt: holding.expireAt ?? null,
  };
}

function toAssetLedgerEntry(entry: PrismNeoUserAssetLog, exportedAt: Date): MigratedAssetLedgerEntry {
  const mapped = mapLegacyAsset(entry.assetType, entry.assetId);
  return {
    id: `legacy:user-asset-log:${entry.id}`,
    playerId: legacyUserId(entry.userId),
    assetType: mapped.type,
    assetCode: mapped.code,
    delta: assetQuantityOf(mapped.type, entry.changeAmount),
    reason: `legacy.${entry.action}`,
    refId: entry.userAssetId ? `legacy:user-asset:${entry.userAssetId}` : entry.comment ?? `legacy:user-asset-log:${entry.id}`,
    createdAt: entry.createdAt ?? exportedAt,
  };
}

function toSession(session: PrismNeoSession): Session {
  if (session.closedAt) {
    return {
      id: legacySessionId(session.id),
      playerId: legacyUserId(session.userId),
      startedAt: session.createdAt,
      endedAt: session.closedAt,
      status: "closed",
      paymentStatus: "paid",
    };
  }

  return {
    id: legacySessionId(session.id),
    playerId: legacyUserId(session.userId),
    startedAt: session.createdAt,
    status: session.isActive === true ? "active" : "closed",
    paymentStatus: session.isActive === true ? "unpaid" : "paid",
  };
}

function toSettlements(
  sessions: readonly PrismNeoSession[],
  billingRecordsByUser: Map<string, PrismNeoBillingRecord[]>,
): SettlementRecord[] {
  return sessions.flatMap((session) => {
    if (!session.closedAt || session.finalCost === null || session.finalCost === undefined) return [];

    const sessionRecords = (billingRecordsByUser.get(legacyUserId(session.userId)) ?? []).filter(
      (record) => record.billingStart >= session.createdAt && record.billingEnd <= session.closedAt!,
    );
    const subtotal = session.billingCost == null ? sumCents(sessionRecords.map((record) => centsOf(record.cost))) : centsOf(session.billingCost);
    const total = centsOf(session.finalCost);
    const chargeItems =
      sessionRecords.length > 0
        ? sessionRecords.map((record) => ({
            id: `legacy:billing-record:${record.id}`,
            source: `legacy.billing-rule.${record.ruleId}`,
            label: `Legacy billing record ${record.id}`,
            amount: centsOf(record.cost),
          }))
        : [
            {
              id: `legacy:session-charge:${session.id}`,
              source: "legacy.session",
              label: "Legacy session charge",
              amount: subtotal,
            },
          ];
    const delta = subCents(total, subtotal);

    return [
      {
        settlement: {
          sessionId: legacySessionId(session.id),
          subtotal,
          total,
          status: "settled",
          settledAt: session.closedAt,
        },
        chargeItems,
        adjustments:
          delta === 0
            ? []
            : [
                {
                  id: `legacy:session-cost-delta:${session.id}`,
                  source: "legacy.session",
                  label: "Legacy final cost delta",
                  amount: delta,
                },
              ],
      },
    ];
  });
}

function toPricingConfigs(
  rules: readonly PrismNeoBillingRule[],
  exportedAt: Date,
): PricingConfig[] {
  if (rules.length === 0) return [];

  return [
    {
      id: "legacy:pricing-config:time-priority",
      kind: "time.priority",
      name: "Legacy time priority pricing",
      enabled: false,
      provider: {
        id: "legacy.time-priority",
        rules: rules.map(toPricingRule),
      },
      createdAt: exportedAt,
      updatedAt: exportedAt,
    },
  ];
}

function toPricingHistoryEntries(records: readonly PrismNeoBillingRecord[]): PricingHistoryEntry[] {
  return records.map((record) => ({
    id: `legacy:billing-record:${record.id}`,
    playerId: legacyUserId(record.userId),
    pricingConfigId: "legacy:pricing-config:time-priority",
    providerId: "legacy.time-priority",
    ruleId: `legacy.rule.${record.ruleId}`,
    ruleAnchorAt: toLegacyRuleAnchorDate(record.ruleStartTimeStamp),
    sessionId: `legacy:billing-record:${record.id}`,
    amount: centsOf(record.cost),
    createdAt: record.billingEnd,
    metadata: {
      legacy: {
        billingStart: record.billingStart.toISOString(),
        billingEnd: record.billingEnd.toISOString(),
        durationMin: record.durationMin,
        ruleStartTimeStamp: record.ruleStartTimeStamp,
      },
    },
  }));
}

function toLegacyRuleAnchorDate(timestamp: number | bigint): Date {
  const value = Number(timestamp);
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  return new Date(milliseconds);
}

type TimePriorityPricingProvider = Extract<PricingConfig, { kind: "time.priority" }>["provider"];

function toPricingRule(rule: PrismNeoBillingRule): TimePriorityPricingProvider["rules"][number] {
  const base = {
    id: `legacy.rule.${rule.id}`,
    label: rule.name,
    priority: rule.priority,
    specificDates: rule.matchDate?.specificDates,
    weekdays: rule.matchDate?.weekdays,
    pricing: rule.pricing,
  };

  if (isDateTimeRange(rule.timeRange)) {
    return {
      ...base,
      dateTimeRange: {
        start: new Date(rule.timeRange.start),
        end: new Date(rule.timeRange.end),
      },
    };
  }

  return {
    ...base,
    timeRange: {
      start: rule.timeRange.start,
      end: rule.timeRange.end,
    },
  };
}

function isDateTimeRange(
  range: PrismNeoBillingRule["timeRange"],
): range is Extract<PrismNeoBillingRule["timeRange"], { isDateTimeRange: true }> {
  return "isDateTimeRange" in range && range.isDateTimeRange === true;
}

function toPresent(present: PrismNeoPresent, assetDefinitionsByLegacyId: ReadonlyMap<number, PrismNeoAssetDefinition>): Present {
  return {
    id: `legacy:present:${present.id}`,
    name: present.name,
    oncePerPlayer: present.oncePerUser,
    grants: present.body.map((grant) => {
      const asset = resolvePresentGrantAsset(grant, assetDefinitionsByLegacyId);
      const mapped = mapLegacyAsset(asset.assetType, asset.assetId);
      return {
        assetType: mapped.type,
        assetCode: mapped.code,
        amount: grant.count ?? 1,
        mergeStrategy: toMergeStrategy(grant.mergeStrategy),
        activeAt: toOptionalDate(grant.activeAt),
        expiresAt: toOptionalDate(grant.expireAt),
        durationMs: grant.durationMs,
      };
    }),
  };
}

function resolvePresentGrantAsset(
  grant: PrismNeoPresentGrant,
  assetDefinitionsByLegacyId: ReadonlyMap<number, PrismNeoAssetDefinition>,
): { assetType: string; assetId: number } {
  if (grant.assetType && grant.assetId !== undefined) {
    return { assetType: grant.assetType, assetId: grant.assetId };
  }

  if (grant.id !== undefined) {
    const definition = assetDefinitionsByLegacyId.get(grant.id);
    if (definition) return { assetType: definition.type, assetId: definition.assetId };

    if (grant.name) {
      const fallbackDefinition = Array.from(assetDefinitionsByLegacyId.values()).find(
        (d) => d.name === grant.name,
      );
      if (fallbackDefinition) {
        console.warn(
          `[Migration Warning] Asset definition with legacy ID ${grant.id} not found. Fallback to name "${grant.name}" succeeded (type=${fallbackDefinition.type}, assetId=${fallbackDefinition.assetId}).`,
        );
        return { assetType: fallbackDefinition.type, assetId: fallbackDefinition.assetId };
      }
    }
  }

  throw new Error(
    `Legacy present grant is missing assetType/assetId and cannot be resolved from Asset.id=${grant.id ?? "<missing>"}.`,
  );
}

function toRedeemCode(redeem: PrismNeoRedeem): RedeemCode {
  return {
    id: `legacy:redeem:${redeem.id}`,
    code: redeem.code,
    presentId: `legacy:present:${redeem.presentId}`,
    activeAt: redeem.activeAt ?? null,
    expiresAt: redeem.expireAt ?? null,
    maxUseCount: redeem.maxUseCount,
  };
}

function toRedeemRecord(record: PrismNeoRedeemRecord): RedeemRecord {
  return {
    playerId: legacyUserId(record.userId),
    codeId: `legacy:redeem:${record.redeemId}`,
    presentId: `legacy:present:${record.presentId}`,
    redeemedAt: record.date,
  };
}

function toCoinDeviceCommand(record: PrismNeoCoinRecord): MigratedDeviceCommand {
  return {
    id: `legacy:coin-record:${record.id}`,
    type: "coin",
    deviceId: record.machineName,
    targetKind: "game_machine",
    executorKind: "machine_ws",
    playerId: legacyUserId(record.userId),
    status: "acked",
    payload: { count: record.count, legacyCoinRecordId: record.id },
    requestedAt: record.createAt,
    ackedAt: record.createAt,
  };
}

function mapLegacyAsset(type: string, assetId: number): { type: string; code: string } {
  const normalizedType = type.toLowerCase();
  if (type === "CURRENCY" && assetId === 10001) return { type: "currency", code: "paid" };
  if (type === "CURRENCY" && assetId === 10002) return { type: "currency", code: "free" };
  return { type: normalizedType, code: `legacy.${normalizedType}.${assetId}` };
}

function toMergeStrategy(strategy: PrismNeoPresentGrant["mergeStrategy"]): Present["grants"][number]["mergeStrategy"] {
  if (strategy === "EXTEND_TIME") return "extend-time";
  if (strategy === "REPLACE") return "replace";
  return "stack";
}

function toOptionalDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function legacyUserId(id: number): string {
  return `legacy:user:${id}`;
}

function legacySessionId(id: number): string {
  return `legacy:session:${id}`;
}

function assetKey(type: string, assetId: number): string {
  return `${type}:${assetId}`;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const groupKey = key(item);
    const group = groups.get(groupKey) ?? [];
    group.push(item);
    groups.set(groupKey, group);
  }
  return groups;
}
