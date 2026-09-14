import { centsOf, PrismDomainError,
  centsOfInteger,
} from "@prism/core";
import { sqlShop, shopValues } from "./shop-scope";
import type {
  CheckoutCommit,
  AssetHolding,
  AssetDefinition,
  AssetDefinitionRepository,
  AssetLedgerEntry,
  AssetRepository,
  AssetTransaction,
  AdminSession,
  ApiToken,
  BusinessItem,
  BusinessItemOrder,
  BusinessItemOrderRepository,
  OperationLockRepository,
  BusinessItemRepository,
  DeviceCommand,
  DeviceCommandRepository,
  DeviceState,
  DeviceStateRepository,
  MachineConnection,
  MachineConnectionRepository,
  Player,
  PlayerCheckout,
  PlayerIdentity,
  PlayerIdentityRepository,
  PlayerRepository,
  PlayerSession,
  PlayerSessionRepository,
  PlayerStatus,
  PricingConfig,
  PricingCapHistoryEntry,
  PricingCapHistoryLookupKey,
  PricingCapHistoryRepository,
  PricingConfigRepository,
  PricingEffect,
  PricingEffectRepository,
  PricingHistoryEntry,
  PricingHistoryLookupKey,
  PricingHistoryRepository,
  Present,
  RedeemCode,
  RedeemRecord,
  RedeemRepository,
  Session,
  SessionRepository,
  SettlementRecord,
  SettlementRepository,
  StaffUser,
  SystemRepository,
} from "@prism/core";

export type SqlValue = string | number | null;

export type SqlStatement = {
  sql: string;
  params?: readonly SqlValue[];
};

export type SqlExecutor = {
  readonly shopId?: string;
  first<T>(sql: string, params?: readonly SqlValue[]): Promise<T | null>;
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  run(sql: string, params?: readonly SqlValue[]): Promise<void>;
  batch(statements: readonly SqlStatement[]): Promise<void>;
};

export type SqlRepositories = {
  commitCheckout(input: CheckoutCommit): Promise<void>;
  system: SystemRepository;
  players: PlayerRepository;
  playerIdentities: PlayerIdentityRepository;
  playerSessions: PlayerSessionRepository;
  assetDefinitions: AssetDefinitionRepository;
  pricingEffects: PricingEffectRepository;
  sessions: SessionRepository;
  operationLocks: OperationLockRepository;
  assets: AssetRepository;
  deviceCommands: DeviceCommandRepository;
  deviceStates: DeviceStateRepository;
  machineConnections: MachineConnectionRepository;
  redeems: RedeemRepository;
  settlements: SettlementRepository;
  pricingConfigs: PricingConfigRepository;
  pricingHistory: PricingHistoryRepository;
  pricingCapHistory: PricingCapHistoryRepository;
  businessItems: BusinessItemRepository;
  businessItemOrders: BusinessItemOrderRepository;
};

export type CreateSqlRepositoriesInput = {
  executor: SqlExecutor;
  id: () => string;
  now: () => Date;
};

export function createSqlRepositories(
  input: CreateSqlRepositoriesInput,
): SqlRepositories {
  return {
    async commitCheckout(checkout) {
      const statements: SqlStatement[] = [];
      const writer: SqlExecutor = {
        shopId: input.executor.shopId,
        async first() { throw new Error("Checkout commit must not perform reads"); },
        async all() { throw new Error("Checkout commit must not perform reads"); },
        async run(sql, params) { statements.push({ sql, params }); },
        async batch(batch) { statements.push(...batch); },
      };
      const repositories = createSqlRepositories({ ...input, executor: writer });
      await repositories.assets.commitAssetTransaction(checkout.assets);
      await repositories.settlements.saveCheckout!(checkout.checkout, checkout.settlements);
      await repositories.sessions.saveMany!(checkout.sessions);
      await repositories.pricingHistory.appendEntries(checkout.pricingHistory);
      await repositories.pricingCapHistory.appendEntries(checkout.pricingCapHistory);
      await input.executor.batch(statements);
    },
    system: createSystemRepository(input),
    players: createPlayerRepository(input.executor),
    playerIdentities: createPlayerIdentityRepository(input.executor),
    playerSessions: createPlayerSessionRepository(input.executor),
    assetDefinitions: createAssetDefinitionRepository(input.executor),
    pricingEffects: createPricingEffectRepository(input.executor),
    sessions: createSessionRepository(input.executor),
    operationLocks: createOperationLockRepository(input.executor),
    assets: createAssetRepository(input),
    deviceCommands: createDeviceCommandRepository(input.executor),
    deviceStates: createDeviceStateRepository(input.executor),
    machineConnections: createMachineConnectionRepository(input.executor),
    redeems: createRedeemRepository(input),
    settlements: createSettlementRepository(input),
    pricingConfigs: createPricingConfigRepository(input.executor),
    pricingHistory: createPricingHistoryRepository(input.executor),
    pricingCapHistory: createPricingCapHistoryRepository(input.executor),
    businessItems: createBusinessItemRepository(input.executor),
    businessItemOrders: createBusinessItemOrderRepository(input.executor),
  };
}

export const maxSqlParametersPerStatement = 100;

export async function runSqlValuesInBatches(
  executor: SqlExecutor,
  rows: readonly (readonly SqlValue[])[],
  createSql: (valueGroups: string) => string,
): Promise<void> {
  for (const statement of insertStatements(rows, createSql)) {
    await executor.run(statement.sql, statement.params);
  }
}

async function runDeleteByValues(
  executor: SqlExecutor,
  table: string,
  column: string,
  values: readonly string[],
): Promise<void> {
  const uniqueValues = [...new Set(values)];
  for (let offset = 0; offset < uniqueValues.length; offset += maxSqlParametersPerStatement) {
    const chunk = uniqueValues.slice(offset, offset + maxSqlParametersPerStatement);
    await executor.run(
      `DELETE FROM ${table} WHERE shop_id = ${sqlShop(executor)} AND ${column} IN (${chunk.map(() => "?").join(", ")})`,
      chunk,
    );
  }
}

function createOperationLockRepository(executor: SqlExecutor): OperationLockRepository {
  return {
    async acquire(scope, resourceId, lockId, acquiredAt, expiresAt) {
      const row = await executor.first<{ resource_id: string }>(
        `INSERT INTO operation_locks (shop_id, scope, resource_id, lock_id, acquired_at, expires_at)
         VALUES (${sqlShop(executor)}, ?, ?, ?, ?, ?)
         ON CONFLICT(shop_id, scope, resource_id) DO UPDATE SET
           lock_id = excluded.lock_id,
           acquired_at = excluded.acquired_at,
           expires_at = excluded.expires_at
         WHERE operation_locks.expires_at <= excluded.acquired_at
         RETURNING resource_id`,
        [scope, resourceId, lockId, acquiredAt.toISOString(), expiresAt.toISOString()],
      );
      return row != null;
    },
    async release(scope, resourceId, lockId) {
      await executor.run(`DELETE FROM operation_locks WHERE shop_id = ${sqlShop(executor)} AND scope = ? AND resource_id = ? AND lock_id = ?`, [scope, resourceId, lockId]);
    },
  };
}

function createSystemRepository(
  input: CreateSqlRepositoriesInput,
): SystemRepository {
  const setAppSettings = async (settings: readonly { key: string; value: unknown }[]) => {
    const updatedAt = input.now().toISOString();
    await runSqlValuesInBatches(
      input.executor,
      settings.map((setting) => [setting.key, JSON.stringify(setting.value), updatedAt]),
      (values) => `INSERT INTO app_settings (shop_id, key, value_json, updated_at)
                   VALUES ${shopValues(input.executor, values)}
                   ON CONFLICT(shop_id, key) DO UPDATE SET
                     value_json = excluded.value_json,
                     updated_at = excluded.updated_at`,
    );
  };
  const saveApiTokens = async (tokens: readonly ApiToken[]) => {
    await runSqlValuesInBatches(
      input.executor,
      tokens.map((token) => [
        token.id,
        token.label,
        token.role,
        token.tokenPrefix,
        token.tokenHash,
        token.status,
        token.createdAt.toISOString(),
        token.lastUsedAt?.toISOString() ?? null,
        token.revokedAt?.toISOString() ?? null,
      ]),
      (values) => `INSERT INTO api_tokens (shop_id, id, label, role, token_prefix, token_hash, status, created_at, last_used_at, revoked_at)
                   VALUES ${shopValues(input.executor, values)}
                   ON CONFLICT(shop_id, id) DO UPDATE SET
                     label = excluded.label,
                     role = excluded.role,
                     token_prefix = excluded.token_prefix,
                     token_hash = excluded.token_hash,
                     status = excluded.status,
                     last_used_at = excluded.last_used_at,
                     revoked_at = excluded.revoked_at`,
    );
  };

  return {
    async hasOwnerStaffUser() {
      const row = await input.executor.first<{ count: number }>(
        `SELECT COUNT(*) AS count FROM (SELECT * FROM staff_users WHERE shop_id = ${sqlShop(input.executor)}) WHERE role = 'owner' AND status = 'active'`,
      );
      return (row?.count ?? 0) > 0;
    },

    async saveStaffUser(user) {
      await input.executor.run(
        `INSERT INTO staff_users (shop_id, id, username, display_name, password_hash, password_salt, role, status, created_at, updated_at)
         VALUES (${sqlShop(input.executor)}, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shop_id, id) DO UPDATE SET
           username = excluded.username,
           display_name = excluded.display_name,
           password_hash = excluded.password_hash,
           password_salt = excluded.password_salt,
           role = excluded.role,
           status = excluded.status,
           updated_at = excluded.updated_at`,
        [
          user.id,
          user.username,
          user.displayName,
          user.passwordHash,
          user.passwordSalt,
          user.role,
          user.status,
          user.createdAt.toISOString(),
          user.updatedAt.toISOString(),
        ],
      );
    },

    async findStaffUserByUsername(username) {
      const row = await input.executor.first<StaffUserRow>(
        `SELECT id, username, display_name, password_hash, password_salt, role, status, created_at, updated_at
         FROM (SELECT * FROM staff_users WHERE shop_id = ${sqlShop(input.executor)})
         WHERE username = ?
         LIMIT 1`,
        [username],
      );
      return row ? toStaffUser(row) : null;
    },

    async listStaffUsers() {
      const rows = await input.executor.all<StaffUserRow>(
        `SELECT id, username, display_name, password_hash, password_salt, role, status, created_at, updated_at
         FROM (SELECT * FROM staff_users WHERE shop_id = ${sqlShop(input.executor)})
         ORDER BY created_at ASC, id`,
      );
      return rows.map(toStaffUser);
    },

    async findStaffUserById(staffUserId) {
      const row = await input.executor.first<StaffUserRow>(
        `SELECT id, username, display_name, password_hash, password_salt, role, status, created_at, updated_at
         FROM (SELECT * FROM staff_users WHERE shop_id = ${sqlShop(input.executor)})
         WHERE id = ?
         LIMIT 1`,
        [staffUserId],
      );
      return row ? toStaffUser(row) : null;
    },

    async saveAdminSession(session) {
      await input.executor.run(
        `INSERT INTO admin_sessions (shop_id, id, staff_user_id, token_hash, expires_at, created_at, last_used_at)
         VALUES (${sqlShop(input.executor)}, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shop_id, id) DO UPDATE SET
           token_hash = excluded.token_hash,
           expires_at = excluded.expires_at,
           last_used_at = excluded.last_used_at`,
        [
          session.id,
          session.staffUserId,
          session.tokenHash,
          session.expiresAt.toISOString(),
          session.createdAt.toISOString(),
          session.lastUsedAt.toISOString(),
        ],
      );
    },

    async findAdminSessionByTokenHash(tokenHash) {
      const row = await input.executor.first<AdminSessionRow>(
        `SELECT id, staff_user_id, token_hash, expires_at, created_at, last_used_at
         FROM (SELECT * FROM admin_sessions WHERE shop_id = ${sqlShop(input.executor)})
         WHERE token_hash = ?
         LIMIT 1`,
        [tokenHash],
      );
      return row ? toAdminSession(row) : null;
    },

    async revokeAdminSession(sessionId) {
      await input.executor.run(`DELETE FROM admin_sessions WHERE shop_id = ${sqlShop(input.executor)} AND id = ?`, [
        sessionId,
      ]);
    },

    async saveApiToken(token) {
      await saveApiTokens([token]);
    },

    async saveApiTokens(tokens) {
      await saveApiTokens(tokens);
    },

    async listApiTokens() {
      const rows = await input.executor.all<ApiTokenRow>(
        `SELECT id, label, role, token_prefix, token_hash, status, created_at, last_used_at, revoked_at
         FROM (SELECT * FROM api_tokens WHERE shop_id = ${sqlShop(input.executor)})
         ORDER BY created_at DESC, id`,
      );
      return rows.map(toApiToken);
    },

    async findActiveApiTokenByHash(tokenHash) {
      const row = await input.executor.first<ApiTokenRow>(
        `SELECT id, label, role, token_prefix, token_hash, status, created_at, last_used_at, revoked_at
         FROM (SELECT * FROM api_tokens WHERE shop_id = ${sqlShop(input.executor)})
         WHERE token_hash = ? AND status = 'active'
         LIMIT 1`,
        [tokenHash],
      );
      return row ? toApiToken(row) : null;
    },

    async updateApiTokenLastUsed(tokenId, usedAt) {
      await input.executor.run(
        `UPDATE api_tokens SET last_used_at = ? WHERE shop_id = ${sqlShop(input.executor)} AND id = ?`,
        [usedAt.toISOString(), tokenId],
      );
    },

    async revokeApiToken(tokenId, revokedAt) {
      await input.executor.run(
        `UPDATE api_tokens SET status = 'revoked', revoked_at = ? WHERE shop_id = ${sqlShop(input.executor)} AND id = ?`,
        [revokedAt.toISOString(), tokenId],
      );
    },

    async setAppSetting(key, value) {
      await setAppSettings([{ key, value }]);
    },

    async setAppSettings(settings) {
      await setAppSettings(settings);
    },

    async getAppSetting<T = unknown>(key: string): Promise<T | null> {
      const row = await input.executor.first<AppSettingRow>(
        `SELECT key, value_json, updated_at FROM (SELECT * FROM app_settings WHERE shop_id = ${sqlShop(input.executor)}) WHERE key = ? LIMIT 1`,
        [key],
      );
      return row ? (JSON.parse(row.value_json) as T) : null;
    },

    async listAppSettings() {
      const rows = await input.executor.all<AppSettingRow>(
        `SELECT key, value_json, updated_at FROM (SELECT * FROM app_settings WHERE shop_id = ${sqlShop(input.executor)}) ORDER BY key`,
      );
      return rows.map((row) => ({
        key: row.key,
        value: JSON.parse(row.value_json) as unknown,
        updatedAt: new Date(row.updated_at),
      }));
    },
  };
}

function createAssetDefinitionRepository(
  executor: SqlExecutor,
): AssetDefinitionRepository {
  const saveMany = async (definitions: readonly AssetDefinition[]) => {
    await runSqlValuesInBatches(
      executor,
      definitions.map((definition) => [
        definition.type,
        definition.code,
        definition.name,
        definition.stackable ? 1 : 0,
        definition.status ?? "active",
        definition.pricingEffectId ?? null,
        definition.activeAt?.toISOString() ?? null,
        definition.expiresAt?.toISOString() ?? null,
        definition.metadata ? JSON.stringify(definition.metadata) : null,
      ]),
      (values) => `INSERT INTO asset_definitions (shop_id, type, code, name, stackable, status, pricing_effect_id, active_at, expires_at, metadata_json)
                   VALUES ${shopValues(executor, values)}
                   ON CONFLICT(shop_id, type, code) DO UPDATE SET
                     name = excluded.name,
                     stackable = excluded.stackable,
                     status = excluded.status,
                     pricing_effect_id = excluded.pricing_effect_id,
                     active_at = excluded.active_at,
                     expires_at = excluded.expires_at,
                     metadata_json = excluded.metadata_json`,
    );
  };

  return {
    async save(definition) {
      await saveMany([definition]);
    },

    async saveMany(definitions) {
      await saveMany(definitions);
    },

    async findByCode(type, code) {
      const row = await executor.first<AssetDefinitionRow>(
        `${assetDefinitionSelectSql(executor)} WHERE ad.type = ? AND ad.code = ? LIMIT 1`,
        [type, code],
      );
      return row ? toAssetDefinition(row) : null;
    },

    async listAll() {
      const rows = await executor.all<AssetDefinitionRow>(
        `${assetDefinitionSelectSql(executor)} ORDER BY ad.type, ad.code`,
      );
      return rows.map(toAssetDefinition);
    },
  };
}

function createPricingEffectRepository(
  executor: SqlExecutor,
): PricingEffectRepository {
  return {
    async save(effect) {
      await executor.run(
        `INSERT INTO pricing_effects (shop_id, id, name, type, scope, value, consumable, limit_per_day, active_at, expires_at, status, config_json)
         VALUES (${sqlShop(executor)}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shop_id, id) DO UPDATE SET
           name = excluded.name,
           type = excluded.type,
           scope = excluded.scope,
           value = excluded.value,
           consumable = excluded.consumable,
           limit_per_day = excluded.limit_per_day,
           active_at = excluded.active_at,
           expires_at = excluded.expires_at,
           status = excluded.status,
           config_json = excluded.config_json`,
        [
          effect.id,
          effect.name,
          effect.type,
          effect.scope,
          effect.value,
          effect.consumable ? 1 : 0,
          effect.limitPerDay,
          effect.activeAt?.toISOString() ?? null,
          effect.expiresAt?.toISOString() ?? null,
          effect.status ?? "active",
          effect.config ? JSON.stringify(effect.config) : null,
        ],
      );
    },

    async findById(effectId) {
      const row = await executor.first<PricingEffectRow>(
        `SELECT id, name, type, scope, value, consumable, limit_per_day, active_at, expires_at, status, config_json
         FROM (SELECT * FROM pricing_effects WHERE shop_id = ${sqlShop(executor)}) WHERE id = ? LIMIT 1`,
        [effectId],
      );
      return row ? toPricingEffect(row) : null;
    },

    async listAll() {
      const rows = await executor.all<PricingEffectRow>(
        `SELECT id, name, type, scope, value, consumable, limit_per_day, active_at, expires_at, status, config_json
         FROM (SELECT * FROM pricing_effects WHERE shop_id = ${sqlShop(executor)}) ORDER BY name, id`,
      );
      return rows.map(toPricingEffect);
    },
  };
}

function createPlayerRepository(executor: SqlExecutor): PlayerRepository {
  return {
    async findById(playerId) {
      const row = await executor.first<PlayerRow>(
        `SELECT id, display_name, status, created_at FROM (SELECT * FROM players WHERE shop_id = ${sqlShop(executor)}) WHERE id = ? LIMIT 1`,
        [playerId],
      );
      return row ? toPlayer(row) : null;
    },

    async listPlayers() {
      const rows = await executor.all<PlayerRow>(
        `SELECT id, display_name, status, created_at FROM (SELECT * FROM players WHERE shop_id = ${sqlShop(executor)}) ORDER BY created_at DESC, id`,
      );
      return rows.map(toPlayer);
    },

    async save(player) {
      await executor.run(
        `INSERT INTO players (shop_id, id, display_name, status, created_at)
         VALUES (${sqlShop(executor)}, ?, ?, ?, ?)
         ON CONFLICT(shop_id, id) DO UPDATE SET
           display_name = excluded.display_name,
           status = excluded.status`,
        [
          player.id,
          player.displayName,
          player.status,
          player.createdAt.toISOString(),
        ],
      );
    },

    async updateStatus(playerId, status) {
      await executor.run(`UPDATE players SET status = ? WHERE shop_id = ${sqlShop(executor)} AND id = ?`, [
        status,
        playerId,
      ]);
    },
  };
}

function createPlayerIdentityRepository(
  executor: SqlExecutor,
): PlayerIdentityRepository {
  return {
    async save(identity) {
      await executor.run(
        `INSERT INTO player_identities (shop_id, player_id, provider, subject, created_at)
         VALUES (${sqlShop(executor)}, ?, ?, ?, ?)
         ON CONFLICT(shop_id, provider, subject) DO NOTHING`,
        [
          identity.playerId,
          identity.provider,
          identity.subject,
          identity.createdAt.toISOString(),
        ],
      );
      const owner = await executor.first<{ player_id: string }>(
        `SELECT player_id FROM player_identities WHERE shop_id = ${sqlShop(executor)} AND provider = ? AND subject = ?`,
        [identity.provider, identity.subject],
      );
      if (owner?.player_id !== identity.playerId) {
        throw new PrismDomainError("Identity is already bound to another player.", "IDENTITY_ALREADY_BOUND");
      }
    },

    async delete(playerId, provider, subject) {
      await executor.run(
        `DELETE FROM player_identities
         WHERE shop_id = ${sqlShop(executor)} AND player_id = ? AND provider = ? AND subject = ?`,
        [playerId, provider, subject],
      );
    },

    async findPlayerByIdentity(provider, subject) {
      const row = await executor.first<PlayerRow>(
        `SELECT p.id, p.display_name, p.status, p.created_at
         FROM (SELECT * FROM player_identities WHERE shop_id = ${sqlShop(executor)}) i
         INNER JOIN (SELECT * FROM players WHERE shop_id = ${sqlShop(executor)}) p ON p.id = i.player_id
         WHERE i.provider = ? AND i.subject = ?
         LIMIT 1`,
        [provider, subject],
      );
      return row ? toPlayer(row) : null;
    },

    async listByPlayerId(playerId) {
      const rows = await executor.all<PlayerIdentityRow>(
        `SELECT player_id, provider, subject, created_at
         FROM (SELECT * FROM player_identities WHERE shop_id = ${sqlShop(executor)})
         WHERE player_id = ?
         ORDER BY provider, subject`,
        [playerId],
      );
      return rows.map(toPlayerIdentity);
    },
  };
}

function createPlayerSessionRepository(
  executor: SqlExecutor,
): PlayerSessionRepository {
  return {
    async save(session) {
      await executor.run(
        `INSERT INTO player_sessions (shop_id, id, player_id, token_hash, expires_at, created_at, last_used_at, revoked_at)
         VALUES (${sqlShop(executor)}, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shop_id, id) DO UPDATE SET
           token_hash = excluded.token_hash,
           expires_at = excluded.expires_at,
           last_used_at = excluded.last_used_at,
           revoked_at = excluded.revoked_at`,
        [
          session.id,
          session.playerId,
          session.tokenHash,
          session.expiresAt.toISOString(),
          session.createdAt.toISOString(),
          session.lastUsedAt.toISOString(),
          session.revokedAt?.toISOString() ?? null,
        ],
      );
    },

    async findByTokenHash(tokenHash) {
      const row = await executor.first<PlayerSessionRow>(
        `SELECT id, player_id, token_hash, expires_at, created_at, last_used_at, revoked_at
         FROM (SELECT * FROM player_sessions WHERE shop_id = ${sqlShop(executor)})
         WHERE token_hash = ?
         LIMIT 1`,
        [tokenHash],
      );
      return row ? toPlayerSession(row) : null;
    },

    async revoke(sessionId, revokedAt) {
      await executor.run(
        `UPDATE player_sessions SET revoked_at = ? WHERE shop_id = ${sqlShop(executor)} AND id = ?`,
        [revokedAt.toISOString(), sessionId],
      );
    },
  };
}

function createSessionRepository(executor: SqlExecutor): SessionRepository {
  const saveMany = async (sessions: readonly Session[]) => {
    await runSqlValuesInBatches(
      executor,
      sessions.map((session) => [
        session.id,
        session.playerId,
        session.startedAt.toISOString(),
        session.endedAt?.toISOString() ?? null,
        session.status ?? "active",
        JSON.stringify(session.pricingConfigIds ?? []),
        session.paymentStatus ?? "unpaid",
        session.label ?? null,
        session.metadata ? JSON.stringify(session.metadata) : null,
      ]),
      (values) => `INSERT INTO sessions (shop_id, id, player_id, started_at, ended_at, status, pricing_config_ids_json, payment_status, label, metadata_json)
                   VALUES ${shopValues(executor, values)}
                   ON CONFLICT(shop_id, id) DO UPDATE SET
                     player_id = excluded.player_id,
                     started_at = excluded.started_at,
                     ended_at = excluded.ended_at,
                     status = excluded.status,
                     pricing_config_ids_json = excluded.pricing_config_ids_json,
                     payment_status = excluded.payment_status,
                     label = excluded.label,
                     metadata_json = excluded.metadata_json`,
    );
  };

  return {
    async findActiveByPlayerId(playerId) {
      const rows = await executor.all<SessionRow>(
        `SELECT id, player_id, started_at, ended_at, status, pricing_config_ids_json, payment_status, label, metadata_json FROM (SELECT * FROM sessions WHERE shop_id = ${sqlShop(executor)}) WHERE player_id = ? AND status = 'active'`,
        [playerId],
      );
      return rows.map(toSession);
    },

    async findById(sessionId) {
      const row = await executor.first<SessionRow>(
        `SELECT id, player_id, started_at, ended_at, status, pricing_config_ids_json, payment_status, label, metadata_json FROM (SELECT * FROM sessions WHERE shop_id = ${sqlShop(executor)}) WHERE id = ?`,
        [sessionId],
      );
      return row ? toSession(row) : null;
    },

    async findUnpaidClosedByPlayerId(playerId) {
      const rows = await executor.all<SessionRow>(
        `SELECT id, player_id, started_at, ended_at, status, pricing_config_ids_json, payment_status, label, metadata_json FROM (SELECT * FROM sessions WHERE shop_id = ${sqlShop(executor)}) WHERE player_id = ? AND status = 'closed' AND payment_status = 'unpaid'`,
        [playerId],
      );
      return rows.map(toSession);
    },

    async save(session) {
      await saveMany([session]);
    },

    async saveMany(sessions) {
      await saveMany(sessions);
    },
  };
}

function createAssetRepository(
  input: CreateSqlRepositoriesInput,
): AssetRepository {
  return {
    async listAssetHoldings(playerId) {
      const rows = await input.executor.all<AssetHoldingRow>(
        `SELECT id, asset_type, asset_code, quantity, active_at, expires_at FROM (SELECT * FROM asset_holdings WHERE shop_id = ${sqlShop(input.executor)}) WHERE player_id = ? ORDER BY id`,
        [playerId],
      );
      return rows.map(toAssetHolding);
    },

    async commitAssetTransaction({ transaction, holdingChanges, assetLedgerEntries }) {
      const playerId = transaction.playerId;
      const statements: SqlStatement[] = [
        {
          sql: `INSERT INTO asset_transactions (shop_id, id, player_id, kind, ref_id, created_at, metadata_json)
                VALUES (${sqlShop(input.executor)}, ?, ?, ?, ?, ?, ?)`,
          params: [
            transaction.id,
            playerId,
            transaction.kind,
            transaction.refId,
            transaction.createdAt.toISOString(),
            transaction.metadata ? JSON.stringify(transaction.metadata) : null,
          ],
        },
        ...assetHoldingUpsertStatements(input, playerId, holdingChanges.upserts),
        ...assetHoldingDeleteStatements(input.executor, playerId, holdingChanges.deleteIds),
        ...assetLedgerInsertStatements(input, transaction, assetLedgerEntries),
      ];

      await input.executor.batch(statements);
    },

    async listLedgerEntriesByPlayerId(playerId) {
      const rows = await input.executor.all<AssetLedgerEntryRow>(
        `SELECT transaction_id, asset_type, asset_code, delta, reason, ref_id FROM (SELECT * FROM asset_ledger_entries WHERE shop_id = ${sqlShop(input.executor)}) WHERE player_id = ? ORDER BY created_at, id`,
        [playerId],
      );
      return rows.map(toAssetLedgerEntry);
    },

    async listTransactionsByPlayerId(playerId) {
      const rows = await input.executor.all<AssetTransactionRow>(
        `SELECT id, player_id, kind, ref_id, created_at, metadata_json
         FROM (SELECT * FROM asset_transactions WHERE shop_id = ${sqlShop(input.executor)})
         WHERE player_id = ?
         ORDER BY created_at, id`,
        [playerId],
      );
      return rows.map(toAssetTransaction);
    },
  };
}

function assetHoldingUpsertStatements(
  input: CreateSqlRepositoriesInput,
  playerId: string,
  holdings: readonly AssetHolding[],
): SqlStatement[] {
  return insertStatements(
    holdings.map((holding) => [
      holding.id ?? input.id(),
      playerId,
      holding.assetType,
      holding.assetCode,
      holding.quantity,
      holding.activeAt?.toISOString() ?? null,
      holding.expiresAt?.toISOString() ?? null,
    ]),
    (values) => `INSERT INTO asset_holdings (shop_id, id, player_id, asset_type, asset_code, quantity, active_at, expires_at)
                 VALUES ${shopValues(input.executor, values)}
                 ON CONFLICT(shop_id, id) DO UPDATE SET
                   asset_type = excluded.asset_type,
                   asset_code = excluded.asset_code,
                   quantity = excluded.quantity,
                   active_at = excluded.active_at,
                   expires_at = excluded.expires_at
                 WHERE asset_holdings.player_id = excluded.player_id`,
  );
}

function assetHoldingDeleteStatements(executor: SqlExecutor, playerId: string, deleteIds: readonly string[]): SqlStatement[] {
  const ids = [...new Set(deleteIds)];
  const statements: SqlStatement[] = [];
  for (let offset = 0; offset < ids.length; offset += maxSqlParametersPerStatement - 1) {
    const chunk = ids.slice(offset, offset + maxSqlParametersPerStatement - 1);
    statements.push({
      sql: `DELETE FROM asset_holdings
            WHERE shop_id = ${sqlShop(executor)} AND player_id = ? AND id IN (${chunk.map(() => "?").join(", ")})`,
      params: [playerId, ...chunk],
    });
  }
  return statements;
}

function assetLedgerInsertStatements(
  input: CreateSqlRepositoriesInput,
  transaction: AssetTransaction,
  entries: readonly AssetLedgerEntry[],
): SqlStatement[] {
  const createdAt = input.now().toISOString();
  return insertStatements(
    entries.map((entry) => [
      input.id(),
      transaction.playerId,
      entry.transactionId ?? transaction.id,
      entry.assetType,
      entry.assetCode,
      entry.delta,
      entry.reason,
      entry.refId,
      createdAt,
    ]),
    (values) => `INSERT INTO asset_ledger_entries (shop_id, id, player_id, transaction_id, asset_type, asset_code, delta, reason, ref_id, created_at)
                 VALUES ${shopValues(input.executor, values)}`,
  );
}

function insertStatements(
  rows: readonly (readonly SqlValue[])[],
  createSql: (valueGroups: string) => string,
): SqlStatement[] {
  if (rows.length === 0) return [];
  const columnCount = rows[0]!.length;
  const rowsPerStatement = Math.max(1, Math.floor(maxSqlParametersPerStatement / columnCount));
  const statements: SqlStatement[] = [];
  for (let offset = 0; offset < rows.length; offset += rowsPerStatement) {
    const chunk = rows.slice(offset, offset + rowsPerStatement);
    const valueGroups = chunk
      .map(() => `(${Array.from({ length: columnCount }, () => "?").join(", ")})`)
      .join(", ");
    statements.push({ sql: createSql(valueGroups), params: chunk.flat() });
  }
  return statements;
}

function createDeviceCommandRepository(
  executor: SqlExecutor,
): DeviceCommandRepository {
  return {
    async enqueueDeviceCommand(command) {
      await executor.run(
        `INSERT INTO device_commands (shop_id, id, type, device_id, target_kind, executor_kind, player_id, staff_id, status, payload_json, requested_at, acked_at, expired_at)
         VALUES (${sqlShop(executor)}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        [
          command.id,
          command.type,
          command.deviceId,
          command.targetKind,
          command.executorKind,
          command.playerId ?? null,
          command.staffId ?? null,
          command.status,
          command.payload ? JSON.stringify(command.payload) : null,
          command.requestedAt.toISOString(),
          command.ackedAt?.toISOString() ?? null,
          command.expiredAt?.toISOString() ?? null,
        ],
      );
    },

    async getDeviceCommand(commandId) {
      const row = await executor.first<DeviceCommandRow>(
        `SELECT id, type, device_id, target_kind, executor_kind, player_id, staff_id, status, payload_json, requested_at, acked_at, expired_at FROM (SELECT * FROM device_commands WHERE shop_id = ${sqlShop(executor)}) WHERE id = ?`,
        [commandId],
      );
      return row ? toDeviceCommand(row) : null;
    },

    async listByPlayerId(playerId) {
      const rows = await executor.all<DeviceCommandRow>(
        `SELECT id, type, device_id, target_kind, executor_kind, player_id, staff_id, status, payload_json, requested_at, acked_at, expired_at FROM (SELECT * FROM device_commands WHERE shop_id = ${sqlShop(executor)}) WHERE player_id = ? ORDER BY requested_at`,
        [playerId],
      );
      return rows.map(toDeviceCommand);
    },

    async listPending(limit) {
      const rows = await executor.all<DeviceCommandRow>(
        `SELECT id, type, device_id, target_kind, executor_kind, player_id, staff_id, status, payload_json, requested_at, acked_at, expired_at FROM (SELECT * FROM device_commands WHERE shop_id = ${sqlShop(executor)}) WHERE status = 'pending' ORDER BY requested_at, id LIMIT ?`,
        [limit],
      );
      return rows.map(toDeviceCommand);
    },
  };
}

function createDeviceStateRepository(
  executor: SqlExecutor,
): DeviceStateRepository {
  const saveSql = (values: string) => `INSERT INTO device_states (shop_id, device_id, type, target_kind, executor_kind, label, status, state, metadata_json, reported_at, reported_by)
    VALUES ${shopValues(executor, values)}
    ON CONFLICT(shop_id, device_id) DO UPDATE SET
      type = excluded.type,
      target_kind = excluded.target_kind,
      executor_kind = excluded.executor_kind,
      label = excluded.label,
      status = excluded.status,
      state = excluded.state,
      metadata_json = excluded.metadata_json,
      reported_at = excluded.reported_at,
      reported_by = excluded.reported_by`;
  const toValues = (state: DeviceState): SqlValue[] => [
    state.deviceId,
    state.type,
    state.targetKind ?? defaultTargetKindForAction(state.type),
    state.executorKind ?? defaultExecutorKindForAction(state.type),
    state.label,
    state.status,
    state.state,
    state.metadata ? JSON.stringify(state.metadata) : null,
    state.reportedAt.toISOString(),
    state.reportedBy,
  ];

  return {
    async save(state) {
      await executor.run(saveSql("(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"), toValues(state));
    },

    async saveMany(states) {
      await runSqlValuesInBatches(executor, states.map(toValues), saveSql);
    },

    async listAll() {
      const rows = await executor.all<DeviceStateRow>(
        `SELECT device_id, type, target_kind, executor_kind, label, status, state, metadata_json, reported_at, reported_by
         FROM (SELECT * FROM device_states WHERE shop_id = ${sqlShop(executor)})
         ORDER BY reported_at DESC, device_id`,
      );
      return rows.map(toDeviceState);
    },
  };
}

function createMachineConnectionRepository(
  executor: SqlExecutor,
): MachineConnectionRepository {
  return {
    async save(connection) {
      await executor.run(
        `INSERT INTO machine_connections (shop_id, machine_id, status, capabilities_json, connected_at, last_seen_at, disconnected_at)
         VALUES (${sqlShop(executor)}, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shop_id, machine_id) DO UPDATE SET
           status = excluded.status,
           capabilities_json = excluded.capabilities_json,
           connected_at = excluded.connected_at,
           last_seen_at = excluded.last_seen_at,
           disconnected_at = excluded.disconnected_at`,
        [
          connection.machineId,
          connection.status,
          JSON.stringify(connection.capabilities),
          connection.connectedAt.toISOString(),
          connection.lastSeenAt.toISOString(),
          connection.disconnectedAt?.toISOString() ?? null,
        ],
      );
    },

    async findByMachineId(machineId) {
      const row = await executor.first<MachineConnectionRow>(
        `SELECT machine_id, status, capabilities_json, connected_at, last_seen_at, disconnected_at
         FROM (SELECT * FROM machine_connections WHERE shop_id = ${sqlShop(executor)})
         WHERE machine_id = ?`,
        [machineId],
      );
      return row ? toMachineConnection(row) : null;
    },

    async listAll() {
      const rows = await executor.all<MachineConnectionRow>(
        `SELECT machine_id, status, capabilities_json, connected_at, last_seen_at, disconnected_at
         FROM (SELECT * FROM machine_connections WHERE shop_id = ${sqlShop(executor)})
         ORDER BY status DESC, last_seen_at DESC, machine_id`,
      );
      return rows.map(toMachineConnection);
    },
  };
}

const redeemCodeSelectSql = (executor: SqlExecutor) => `SELECT rc.id,
       rc.code,
       rc.present_id,
       rc.active_at,
       rc.expires_at,
       rc.max_use_count,
       COUNT(rr.id) AS usage_count
FROM (SELECT * FROM redeem_codes WHERE shop_id = ${sqlShop(executor)}) rc
LEFT JOIN (SELECT * FROM redeem_records WHERE shop_id = ${sqlShop(executor)}) rr ON rr.code_id = rc.id`;

function createRedeemRepository(
  input: CreateSqlRepositoriesInput,
): RedeemRepository {
  const saveRedeemCodes = async (codes: readonly RedeemCode[]) => {
    await runSqlValuesInBatches(
      input.executor,
      codes.map((code) => [
        code.id,
        code.code,
        code.presentId,
        code.activeAt?.toISOString() ?? null,
        code.expiresAt?.toISOString() ?? null,
        code.maxUseCount,
      ]),
      (values) => `INSERT INTO redeem_codes (shop_id, id, code, present_id, active_at, expires_at, max_use_count)
                   VALUES ${shopValues(input.executor, values)}
                   ON CONFLICT(shop_id, id) DO UPDATE SET
                     code = excluded.code,
                     present_id = excluded.present_id,
                     active_at = excluded.active_at,
                     expires_at = excluded.expires_at,
                     max_use_count = excluded.max_use_count`,
    );
  };

  return {
    async findRedeemCodeByCode(code) {
      const row = await input.executor.first<RedeemCodeRow>(
        `${redeemCodeSelectSql(input.executor)}
         WHERE rc.code = ?
         GROUP BY rc.id, rc.code, rc.present_id, rc.active_at, rc.expires_at, rc.max_use_count`,
        [code],
      );
      return row ? toRedeemCode(row) : null;
    },

    async findRedeemCodeById(codeId) {
      const row = await input.executor.first<RedeemCodeRow>(
        `${redeemCodeSelectSql(input.executor)}
         WHERE rc.id = ?
         GROUP BY rc.id, rc.code, rc.present_id, rc.active_at, rc.expires_at, rc.max_use_count`,
        [codeId],
      );
      return row ? toRedeemCode(row) : null;
    },

    async findPresentById(presentId) {
      const row = await input.executor.first<PresentRow>(
        `SELECT id, name, once_per_player, active_at, expires_at, status, grants_json FROM (SELECT * FROM presents WHERE shop_id = ${sqlShop(input.executor)}) WHERE id = ?`,
        [presentId],
      );
      return row ? toPresent(row) : null;
    },

    async savePresent(present) {
      await input.executor.run(
        `INSERT INTO presents (shop_id, id, name, once_per_player, active_at, expires_at, status, grants_json)
         VALUES (${sqlShop(input.executor)}, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shop_id, id) DO UPDATE SET
           name = excluded.name,
           once_per_player = excluded.once_per_player,
           active_at = excluded.active_at,
           expires_at = excluded.expires_at,
           status = excluded.status,
           grants_json = excluded.grants_json`,
        [
          present.id,
          present.name,
          present.oncePerPlayer ? 1 : 0,
          present.activeAt?.toISOString() ?? null,
          present.expiresAt?.toISOString() ?? null,
          present.status ?? "active",
          JSON.stringify(present.grants),
        ],
      );
    },

    async listPresents() {
      const rows = await input.executor.all<PresentRow>(
        `SELECT id, name, once_per_player, active_at, expires_at, status, grants_json FROM (SELECT * FROM presents WHERE shop_id = ${sqlShop(input.executor)}) ORDER BY id`,
      );
      return rows.map(toPresent);
    },

    async saveRedeemCode(code) {
      await saveRedeemCodes([code]);
    },

    async saveRedeemCodes(codes) {
      await saveRedeemCodes(codes);
    },

    async listRedeemCodes() {
      const rows = await input.executor.all<RedeemCodeRow>(
        `${redeemCodeSelectSql(input.executor)}
         GROUP BY rc.id, rc.code, rc.present_id, rc.active_at, rc.expires_at, rc.max_use_count
         ORDER BY rc.id`,
      );
      return rows.map(toRedeemCode);
    },

    async listRedeemRecords() {
      const rows = await input.executor.all<RedeemRecordRow>(
        `SELECT player_id, code_id, present_id, redeemed_at FROM (SELECT * FROM redeem_records WHERE shop_id = ${sqlShop(input.executor)})`,
      );
      return rows.map(toRedeemRecord);
    },

    async countRedeemCodeUses(codeId) {
      const row = await input.executor.first<{ count: number }>(
        `SELECT COUNT(*) AS count FROM (SELECT * FROM redeem_records WHERE shop_id = ${sqlShop(input.executor)}) WHERE code_id = ?`,
        [codeId],
      );
      return row?.count ?? 0;
    },

    async hasPlayerRedeemedPresent(playerId, presentId) {
      const row = await input.executor.first<{ count: number }>(
        `SELECT COUNT(*) AS count FROM (SELECT * FROM redeem_records WHERE shop_id = ${sqlShop(input.executor)}) WHERE player_id = ? AND present_id = ?`,
        [playerId, presentId],
      );
      return (row?.count ?? 0) > 0;
    },

    async saveRedeemRecord(record) {
      await input.executor.run(
        `INSERT INTO redeem_records (shop_id, id, player_id, code_id, present_id, redeemed_at) VALUES (${sqlShop(input.executor)}, ?, ?, ?, ?, ?)`,
        [
          input.id(),
          record.playerId,
          record.codeId,
          record.presentId,
          record.redeemedAt.toISOString(),
        ],
      );
    },
  };
}

function createSettlementRepository(
  input: CreateSqlRepositoriesInput,
): SettlementRepository {
  const saveSettlements = async (
    records: readonly SettlementRecord[],
    checkoutId: string | null = null,
  ) => {
    if (records.length === 0) return;
    await runSqlValuesInBatches(
      input.executor,
      records.map(({ settlement }) => [
        input.id(),
        settlement.sessionId,
        checkoutId,
        settlement.subtotal,
        settlement.total,
        settlement.status,
        settlement.settledAt.toISOString(),
      ]),
      (values) => `INSERT INTO settlements (shop_id, id, session_id, checkout_id, subtotal, total, status, settled_at)
                   VALUES ${shopValues(input.executor, values)}
                   ON CONFLICT(shop_id, session_id) DO UPDATE SET
                     checkout_id = excluded.checkout_id,
                     subtotal = excluded.subtotal,
                     total = excluded.total,
                     status = excluded.status,
                     settled_at = excluded.settled_at`,
    );
    const sessionIds = records.map(({ settlement }) => settlement.sessionId);
    await runDeleteByValues(input.executor, "settlement_charge_items", "session_id", sessionIds);
    await runDeleteByValues(input.executor, "settlement_adjustments", "session_id", sessionIds);
    await runSqlValuesInBatches(
      input.executor,
      records.flatMap((record) => record.chargeItems.map((item, index) => [
        item.id,
        record.settlement.sessionId,
        index,
        item.source,
        item.label,
        item.amount,
      ])),
      (values) => `INSERT INTO settlement_charge_items (shop_id, id, session_id, item_order, source, label, amount)
                   VALUES ${shopValues(input.executor, values)}`,
    );
    await runSqlValuesInBatches(
      input.executor,
      records.flatMap((record) => record.adjustments.map((adjustment, index) => [
        adjustment.id,
        record.settlement.sessionId,
        index,
        adjustment.source,
        adjustment.label,
        adjustment.amount,
      ])),
      (values) => `INSERT INTO settlement_adjustments (shop_id, id, session_id, adjustment_order, source, label, amount)
                   VALUES ${shopValues(input.executor, values)}`,
    );
  };

  return {
    async saveSettlement(record) {
      await saveSettlements([record]);
    },

    async saveSettlements(records) {
      await saveSettlements(records);
    },

    async saveCheckout(checkout, records) {
      await savePlayerCheckout(input.executor, checkout);
      await saveSettlements(records, checkout.id);
    },

    async findSettlementBySessionId(sessionId) {
      const rows = await input.executor.all<SettlementDetailRow>(
        `WITH settlement_row AS (
           SELECT session_id, subtotal, total, status, settled_at
           FROM (SELECT * FROM settlements WHERE shop_id = ${sqlShop(input.executor)})
           WHERE session_id = ?
         ), detail_rows AS (
           SELECT 0 AS row_order, 'settlement' AS row_kind, sr.*,
                  NULL AS item_id, NULL AS item_source, NULL AS item_label, NULL AS item_amount,
                  0 AS item_order
           FROM settlement_row sr
           UNION ALL
           SELECT 1, 'charge', sr.*,
                  ci.id, ci.source, ci.label, ci.amount, ci.item_order
           FROM settlement_row sr
           INNER JOIN (SELECT * FROM settlement_charge_items WHERE shop_id = ${sqlShop(input.executor)}) ci ON ci.session_id = sr.session_id
           UNION ALL
           SELECT 2, 'adjustment', sr.*,
                  sa.id, sa.source, sa.label, sa.amount, sa.adjustment_order
           FROM settlement_row sr
           INNER JOIN (SELECT * FROM settlement_adjustments WHERE shop_id = ${sqlShop(input.executor)}) sa ON sa.session_id = sr.session_id
         )
         SELECT * FROM detail_rows
         ORDER BY row_order, item_order, item_id`,
        [sessionId],
      );
      const row = rows[0];
      return row
        ? {
            settlement: toSettlement(row),
            chargeItems: rows.flatMap((item) => item.row_kind === "charge" && item.item_id
              ? [{ id: item.item_id, source: item.item_source!, label: item.item_label!, amount: item.item_amount! }]
              : []),
            adjustments: rows.flatMap((item) => item.row_kind === "adjustment" && item.item_id
              ? [{ id: item.item_id, source: item.item_source!, label: item.item_label!, amount: item.item_amount! }]
              : []),
          }
        : null;
    },

    async listPastAppliedAdjustmentsByPlayerId(playerId) {
      type Row = { source: string; started_at: string };
      const rows = await input.executor.all<Row>(
        `SELECT sa.source, s.started_at
         FROM (SELECT * FROM settlement_adjustments WHERE shop_id = ${sqlShop(input.executor)}) sa
         INNER JOIN (SELECT * FROM settlements WHERE shop_id = ${sqlShop(input.executor)}) st ON st.session_id = sa.session_id
         INNER JOIN (SELECT * FROM sessions WHERE shop_id = ${sqlShop(input.executor)}) s ON s.id = st.session_id
         WHERE s.player_id = ?`,
        [playerId],
      );
      return rows.map((r) => ({
        source: r.source,
        sessionStartedAt: new Date(r.started_at),
      }));
    },
  };
}

function createPricingConfigRepository(
  executor: SqlExecutor,
): PricingConfigRepository {
  return {
    async save(config) {
      await executor.run(
        `INSERT INTO pricing_configs (shop_id, id, kind, name, enabled, status, provider_json, created_at, updated_at)
         VALUES (${sqlShop(executor)}, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shop_id, id) DO UPDATE SET
           kind = excluded.kind,
           name = excluded.name,
           enabled = excluded.enabled,
           status = excluded.status,
           provider_json = excluded.provider_json,
           updated_at = excluded.updated_at`,
        [
          config.id,
          config.kind,
          config.name,
          config.enabled ? 1 : 0,
          config.status ?? "active",
          JSON.stringify(serializePricingProviderConfig(config.provider)),
          config.createdAt.toISOString(),
          config.updatedAt.toISOString(),
        ],
      );
    },

    async findById(configId) {
      const row = await executor.first<PricingConfigRow>(
        `SELECT id, kind, name, enabled, status, provider_json, created_at, updated_at FROM (SELECT * FROM pricing_configs WHERE shop_id = ${sqlShop(executor)}) WHERE id = ? LIMIT 1`,
        [configId],
      );
      return row ? toPricingConfig(row) : null;
    },

    async listAll() {
      const rows = await executor.all<PricingConfigRow>(
        `SELECT id, kind, name, enabled, status, provider_json, created_at, updated_at FROM (SELECT * FROM pricing_configs WHERE shop_id = ${sqlShop(executor)}) ORDER BY updated_at DESC, id`,
      );
      return rows.map(toPricingConfig);
    },

    async listEnabled() {
      const rows = await executor.all<PricingConfigRow>(
        `SELECT id, kind, name, enabled, status, provider_json, created_at, updated_at FROM (SELECT * FROM pricing_configs WHERE shop_id = ${sqlShop(executor)}) WHERE enabled = 1 AND status = 'active' ORDER BY updated_at DESC, id`,
      );
      return rows.map(toPricingConfig);
    },
  };
}

function createPricingHistoryRepository(
  executor: SqlExecutor,
): PricingHistoryRepository {
  return {
    async sumByPlayerAndKeys(playerId, keys) {
      if (keys.length === 0) return {};

      const totals: Record<string, number> = {};
      const uniqueKeys = new Map<string, PricingHistoryLookupKey>();
      for (const key of keys) {
        uniqueKeys.set(pricingHistoryKey(key), key);
      }

      const requestedKeys = [...uniqueKeys.values()];
      const keysPerStatement = Math.max(1, Math.floor((maxSqlParametersPerStatement - 1) / 4));
      for (let offset = 0; offset < requestedKeys.length; offset += keysPerStatement) {
        const chunk = requestedKeys.slice(offset, offset + keysPerStatement);
        const rows = await executor.all<PricingHistoryTotalRow>(
          `WITH requested(pricing_config_id, provider_id, rule_id, rule_anchor_at) AS (
             VALUES ${chunk.map(() => "(?, ?, ?, ?)").join(", ")}
           )
           SELECT
             requested.pricing_config_id,
             requested.provider_id,
             requested.rule_id,
             requested.rule_anchor_at,
             COALESCE(SUM(history.amount), 0) AS total
           FROM requested
           LEFT JOIN (SELECT * FROM pricing_history_entries WHERE shop_id = ${sqlShop(executor)}) history
             ON history.player_id = ?
            AND history.pricing_config_id = requested.pricing_config_id
            AND history.provider_id = requested.provider_id
            AND history.rule_id = requested.rule_id
            AND history.rule_anchor_at = requested.rule_anchor_at
           GROUP BY requested.pricing_config_id, requested.provider_id, requested.rule_id, requested.rule_anchor_at`,
          [
            ...chunk.flatMap((key) => [
              key.pricingConfigId,
              key.providerId,
              key.ruleId,
              key.ruleAnchorAt.toISOString(),
            ]),
            playerId,
          ],
        );
        for (const row of rows) {
          totals[pricingHistoryKey({
            pricingConfigId: row.pricing_config_id,
            providerId: row.provider_id,
            ruleId: row.rule_id,
            ruleAnchorAt: new Date(row.rule_anchor_at),
          })] = row.total;
        }
      }

      return totals;
    },

    async appendEntries(entries) {
      await runSqlValuesInBatches(
        executor,
        entries.map((entry) => [
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
    },
  };
}

function createPricingCapHistoryRepository(
  executor: SqlExecutor,
): PricingCapHistoryRepository {
  return {
    async sumByPlayerAndKeys(playerId, keys) {
      if (keys.length === 0) return {};

      const totals: Record<string, number> = {};
      const uniqueKeys = new Map<string, PricingCapHistoryLookupKey>();
      for (const key of keys) {
        uniqueKeys.set(pricingCapHistoryKey(key), key);
      }

      const requestedKeys = [...uniqueKeys.values()];
      const keysPerStatement = Math.max(1, Math.floor((maxSqlParametersPerStatement - 1) / 3));
      for (let offset = 0; offset < requestedKeys.length; offset += keysPerStatement) {
        const chunk = requestedKeys.slice(offset, offset + keysPerStatement);
        const rows = await executor.all<PricingCapHistoryTotalRow>(
          `WITH requested(cap_config_id, cap_rule_id, cap_anchor_at) AS (
             VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}
           )
           SELECT
             requested.cap_config_id,
             requested.cap_rule_id,
             requested.cap_anchor_at,
             COALESCE(SUM(history.amount), 0) AS total
           FROM requested
           LEFT JOIN (SELECT * FROM pricing_cap_history_entries WHERE shop_id = ${sqlShop(executor)}) history
             ON history.player_id = ?
            AND history.cap_config_id = requested.cap_config_id
            AND history.cap_rule_id = requested.cap_rule_id
            AND history.cap_anchor_at = requested.cap_anchor_at
           GROUP BY requested.cap_config_id, requested.cap_rule_id, requested.cap_anchor_at`,
          [
            ...chunk.flatMap((key) => [
              key.capConfigId,
              key.capRuleId,
              key.capAnchorAt.toISOString(),
            ]),
            playerId,
          ],
        );
        for (const row of rows) {
          totals[`${row.cap_config_id}@${row.cap_rule_id}@${new Date(row.cap_anchor_at).toISOString()}`] = row.total;
        }
      }

      return totals;
    },

    async appendEntries(entries) {
      await runSqlValuesInBatches(
        executor,
        entries.map((entry) => [
            entry.id,
            entry.playerId,
            entry.capConfigId,
            entry.capRuleId,
            entry.capAnchorAt.toISOString(),
            JSON.stringify(entry.includedPricingConfigIds),
            JSON.stringify(entry.sessionIds),
            entry.amount,
            entry.createdAt.toISOString(),
            entry.metadata ? JSON.stringify(entry.metadata) : null,
        ]),
        (values) => `INSERT INTO pricing_cap_history_entries (shop_id, id, player_id, cap_config_id, cap_rule_id, cap_anchor_at, included_pricing_config_ids_json, session_ids_json, amount, created_at, metadata_json)
                     VALUES ${shopValues(executor, values)}
                     ON CONFLICT(shop_id, id) DO UPDATE SET
                       player_id = excluded.player_id,
                       cap_config_id = excluded.cap_config_id,
                       cap_rule_id = excluded.cap_rule_id,
                       cap_anchor_at = excluded.cap_anchor_at,
                       included_pricing_config_ids_json = excluded.included_pricing_config_ids_json,
                       session_ids_json = excluded.session_ids_json,
                       amount = excluded.amount,
                       created_at = excluded.created_at,
                       metadata_json = excluded.metadata_json`,
      );
    },
  };
}

function createBusinessItemRepository(
  executor: SqlExecutor,
): BusinessItemRepository {
  return {
    async save(item) {
      await executor.run(
        `INSERT INTO business_items (shop_id, id, kind, name, status, price, asset_type, asset_code, active_at, expires_at, metadata_json, created_at, updated_at)
         VALUES (${sqlShop(executor)}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shop_id, id) DO UPDATE SET
           kind = excluded.kind,
           name = excluded.name,
           status = excluded.status,
           price = excluded.price,
           asset_type = excluded.asset_type,
           asset_code = excluded.asset_code,
           active_at = excluded.active_at,
           expires_at = excluded.expires_at,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
        [
          item.id,
          item.kind,
          item.name,
          item.status,
          item.price,
          item.assetType,
          item.assetCode,
          item.activeAt?.toISOString() ?? null,
          item.expiresAt?.toISOString() ?? null,
          item.metadata ? JSON.stringify(item.metadata) : null,
          item.createdAt.toISOString(),
          item.updatedAt.toISOString(),
        ],
      );
    },

    async findById(itemId) {
      const row = await executor.first<BusinessItemRow>(
        `SELECT id, kind, name, status, price, asset_type, asset_code, active_at, expires_at, metadata_json, created_at, updated_at
         FROM (SELECT * FROM business_items WHERE shop_id = ${sqlShop(executor)})
         WHERE id = ?
         LIMIT 1`,
        [itemId],
      );
      return row ? toBusinessItem(row) : null;
    },

    async listAll() {
      const rows = await executor.all<BusinessItemRow>(
        `SELECT id, kind, name, status, price, asset_type, asset_code, active_at, expires_at, metadata_json, created_at, updated_at
         FROM (SELECT * FROM business_items WHERE shop_id = ${sqlShop(executor)})
         ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC, id`,
      );
      return rows.map(toBusinessItem);
    },
  };
}

function createBusinessItemOrderRepository(
  executor: SqlExecutor,
): BusinessItemOrderRepository {
  return {
    async save(order) {
      await executor.run(
        `INSERT INTO business_item_orders (shop_id,
          id, business_item_id, business_item_kind, business_item_name, player_id, session_id, status,
          price, asset_type, asset_code, metadata_json, created_at, updated_at, fulfilled_at, cancelled_at
        )
         VALUES (${sqlShop(executor)}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shop_id, id) DO UPDATE SET
           business_item_id = excluded.business_item_id,
           business_item_kind = excluded.business_item_kind,
           business_item_name = excluded.business_item_name,
           player_id = excluded.player_id,
           session_id = excluded.session_id,
           status = excluded.status,
           price = excluded.price,
           asset_type = excluded.asset_type,
           asset_code = excluded.asset_code,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at,
           fulfilled_at = excluded.fulfilled_at,
           cancelled_at = excluded.cancelled_at`,
        [
          order.id,
          order.businessItemId,
          order.businessItemKind,
          order.businessItemName,
          order.playerId,
          order.sessionId,
          order.status,
          order.price,
          order.assetType,
          order.assetCode,
          order.metadata ? JSON.stringify(order.metadata) : null,
          order.createdAt.toISOString(),
          order.updatedAt.toISOString(),
          order.fulfilledAt?.toISOString() ?? null,
          order.cancelledAt?.toISOString() ?? null,
        ],
      );
    },

    async findById(orderId) {
      const row = await executor.first<BusinessItemOrderRow>(
        `SELECT id, business_item_id, business_item_kind, business_item_name, player_id, session_id, status,
                price, asset_type, asset_code, metadata_json, created_at, updated_at, fulfilled_at, cancelled_at
         FROM (SELECT * FROM business_item_orders WHERE shop_id = ${sqlShop(executor)})
         WHERE id = ?
         LIMIT 1`,
        [orderId],
      );
      return row ? toBusinessItemOrder(row) : null;
    },

    async listAll() {
      const rows = await executor.all<BusinessItemOrderRow>(
        `SELECT id, business_item_id, business_item_kind, business_item_name, player_id, session_id, status,
                price, asset_type, asset_code, metadata_json, created_at, updated_at, fulfilled_at, cancelled_at
         FROM (SELECT * FROM business_item_orders WHERE shop_id = ${sqlShop(executor)})
         ORDER BY created_at DESC, id`,
      );
      return rows.map(toBusinessItemOrder);
    },

    async listByPlayerId(playerId) {
      const rows = await executor.all<BusinessItemOrderRow>(
        `SELECT id, business_item_id, business_item_kind, business_item_name, player_id, session_id, status,
                price, asset_type, asset_code, metadata_json, created_at, updated_at, fulfilled_at, cancelled_at
         FROM (SELECT * FROM business_item_orders WHERE shop_id = ${sqlShop(executor)})
         WHERE player_id = ?
         ORDER BY created_at DESC, id`,
        [playerId],
      );
      return rows.map(toBusinessItemOrder);
    },

    async countOpenByItemId(itemId) {
      const row = await executor.first<{ count: number }>(
        `SELECT COUNT(*) AS count FROM (SELECT * FROM business_item_orders WHERE shop_id = ${sqlShop(executor)}) WHERE business_item_id = ? AND status != 'cancelled'`,
        [itemId],
      );
      return row?.count ?? 0;
    },
  };
}

type SessionRow = {
  id: string;
  player_id: string;
  started_at: string;
  ended_at: string | null;
  status: "active" | "closed";
  pricing_config_ids_json: string;
  payment_status: "unpaid" | "paid";
  label: string | null;
  metadata_json: string | null;
};

type PlayerRow = {
  id: string;
  display_name: string;
  status: PlayerStatus;
  created_at: string;
};

type PlayerIdentityRow = {
  player_id: string;
  provider: string;
  subject: string;
  created_at: string;
};

type PlayerSessionRow = {
  id: string;
  player_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
  last_used_at: string;
  revoked_at: string | null;
};

type AssetHoldingRow = {
  id: string;
  asset_type: string;
  asset_code: string;
  quantity: number;
  active_at: string | null;
  expires_at: string | null;
};

type AssetDefinitionRow = {
  type: string;
  code: string;
  name: string;
  stackable: number;
  status: AssetDefinition["status"];
  pricing_effect_id: string | null;
  active_at: string | null;
  expires_at: string | null;
  metadata_json: string | null;
  effect_id: string | null;
  effect_name: string | null;
  effect_type: PricingEffect["type"] | null;
  effect_scope: PricingEffect["scope"] | null;
  effect_value: number | null;
  effect_consumable: number | null;
  effect_limit_per_day: number | null;
  effect_active_at: string | null;
  effect_expires_at: string | null;
  effect_status: PricingEffect["status"] | null;
  effect_config_json: string | null;
};

type PricingEffectRow = {
  id: string;
  name: string;
  type: PricingEffect["type"];
  scope: PricingEffect["scope"];
  value: number | null;
  consumable: number;
  limit_per_day: number | null;
  active_at: string | null;
  expires_at: string | null;
  status: PricingEffect["status"];
  config_json: string | null;
};

type AssetLedgerEntryRow = {
  transaction_id: string | null;
  asset_type: string;
  asset_code: string;
  delta: number;
  reason: string;
  ref_id: string;
};

type AssetTransactionRow = {
  id: string;
  player_id: string;
  kind: string;
  ref_id: string;
  created_at: string;
  metadata_json: string | null;
};

type DeviceCommandRow = {
  id: string;
  type: DeviceCommand["type"];
  device_id: string | null;
  target_kind: DeviceCommand["targetKind"];
  executor_kind: DeviceCommand["executorKind"];
  player_id: string | null;
  staff_id: string | null;
  status: DeviceCommand["status"];
  payload_json: string | null;
  requested_at: string;
  acked_at: string | null;
  expired_at: string | null;
};

type DeviceStateRow = {
  device_id: string;
  type: DeviceState["type"];
  target_kind: DeviceState["targetKind"];
  executor_kind: DeviceState["executorKind"];
  label: string;
  status: DeviceState["status"];
  state: string;
  metadata_json: string | null;
  reported_at: string;
  reported_by: string;
};

type MachineConnectionRow = {
  machine_id: string;
  status: MachineConnection["status"];
  capabilities_json: string;
  connected_at: string;
  last_seen_at: string;
  disconnected_at: string | null;
};

type RedeemCodeRow = {
  id: string;
  code: string;
  present_id: string;
  active_at: string | null;
  expires_at: string | null;
  max_use_count: number;
  usage_count: number;
};

type PresentRow = {
  id: string;
  name: string;
  once_per_player: number;
  active_at: string | null;
  expires_at: string | null;
  status: Present["status"];
  grants_json: string;
};

type RedeemRecordRow = {
  player_id: string;
  code_id: string;
  present_id: string;
  redeemed_at: string;
};

type SettlementRow = {
  session_id: string;
  subtotal: number;
  total: number;
  status: "settled";
  settled_at: string;
};

type SettlementDetailRow = SettlementRow & {
  row_kind: "settlement" | "charge" | "adjustment";
  item_id: string | null;
  item_source: string | null;
  item_label: string | null;
  item_amount: number | null;
};

type PricingConfigRow = {
  id: string;
  kind: PricingConfig["kind"];
  name: string;
  enabled: number;
  status: PricingConfig["status"];
  provider_json: string;
  created_at: string;
  updated_at: string;
};

type PricingHistoryTotalRow = {
  pricing_config_id: string;
  provider_id: string;
  rule_id: string;
  rule_anchor_at: string;
  total: number;
};

type PricingCapHistoryTotalRow = {
  cap_config_id: string;
  cap_rule_id: string;
  cap_anchor_at: string;
  total: number;
};

type BusinessItemRow = {
  id: string;
  kind: string;
  name: string;
  status: BusinessItem["status"];
  price: number;
  asset_type: string | null;
  asset_code: string | null;
  active_at: string | null;
  expires_at: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
};

type BusinessItemOrderRow = {
  id: string;
  business_item_id: string;
  business_item_kind: string;
  business_item_name: string;
  player_id: string;
  session_id: string;
  status: BusinessItemOrder["status"];
  price: number;
  asset_type: string | null;
  asset_code: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  fulfilled_at: string | null;
  cancelled_at: string | null;
};

type StaffUserRow = {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  password_salt: string;
  role: StaffUser["role"];
  status: StaffUser["status"];
  created_at: string;
  updated_at: string;
};

type AdminSessionRow = {
  id: string;
  staff_user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
  last_used_at: string;
};

type ApiTokenRow = {
  id: string;
  label: string;
  role: ApiToken["role"];
  token_prefix: string;
  token_hash: string;
  status: ApiToken["status"];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

type AppSettingRow = {
  key: string;
  value_json: string;
  updated_at: string;
};

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    playerId: row.player_id,
    startedAt: new Date(row.started_at),
    endedAt: row.ended_at ? new Date(row.ended_at) : undefined,
    status: row.status,
    pricingConfigIds: JSON.parse(row.pricing_config_ids_json ?? "[]"),
    paymentStatus: row.payment_status,
    label: row.label ?? undefined,
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : undefined,
  };
}

function toPlayer(row: PlayerRow): Player {
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    createdAt: new Date(row.created_at),
  };
}

function toPlayerIdentity(row: PlayerIdentityRow): PlayerIdentity {
  return {
    playerId: row.player_id,
    provider: row.provider,
    subject: row.subject,
    createdAt: new Date(row.created_at),
  };
}

function toPlayerSession(row: PlayerSessionRow): PlayerSession {
  return {
    id: row.id,
    playerId: row.player_id,
    tokenHash: row.token_hash,
    expiresAt: new Date(row.expires_at),
    createdAt: new Date(row.created_at),
    lastUsedAt: new Date(row.last_used_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  };
}

function toAssetHolding(row: AssetHoldingRow): AssetHolding {
  return {
    id: row.id,
    assetType: row.asset_type,
    assetCode: row.asset_code,
    quantity: centsOfInteger(row.quantity),
    activeAt: row.active_at ? new Date(row.active_at) : null,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
  };
}

function toAssetDefinition(row: AssetDefinitionRow): AssetDefinition {
  return {
    type: row.type,
    code: row.code,
    name: row.name,
    stackable: row.stackable === 1,
    status: row.status ?? "active",
    pricingEffectId: row.pricing_effect_id,
    pricingEffect: row.effect_id
      ? toPricingEffect({
          id: row.effect_id,
          name: row.effect_name ?? "",
          type: row.effect_type ?? "free",
          scope: row.effect_scope ?? "session",
          value: row.effect_value,
          consumable: row.effect_consumable ?? 0,
          limit_per_day: row.effect_limit_per_day,
          active_at: row.effect_active_at,
          expires_at: row.effect_expires_at,
          status: row.effect_status ?? "active",
          config_json: row.effect_config_json,
        })
      : null,
    activeAt: row.active_at ? new Date(row.active_at) : null,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
      : null,
  };
}

function toPricingEffect(row: PricingEffectRow): PricingEffect {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    scope: row.scope,
    value: row.value,
    consumable: row.consumable === 1,
    limitPerDay: row.limit_per_day,
    activeAt: row.active_at ? new Date(row.active_at) : null,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    status: row.status ?? "active",
    config: row.config_json
      ? (JSON.parse(row.config_json) as Record<string, unknown>)
      : null,
  };
}

function assetDefinitionSelectSql(executor: SqlExecutor): string {
  return `SELECT
      ad.type,
      ad.code,
      ad.name,
      ad.stackable,
      ad.status,
      ad.pricing_effect_id,
      ad.active_at,
      ad.expires_at,
      ad.metadata_json,
      pe.id AS effect_id,
      pe.name AS effect_name,
      pe.type AS effect_type,
      pe.scope AS effect_scope,
      pe.value AS effect_value,
      pe.consumable AS effect_consumable,
      pe.limit_per_day AS effect_limit_per_day,
      pe.active_at AS effect_active_at,
      pe.expires_at AS effect_expires_at,
      pe.status AS effect_status,
      pe.config_json AS effect_config_json
    FROM (SELECT * FROM asset_definitions WHERE shop_id = ${sqlShop(executor)}) ad
    LEFT JOIN (SELECT * FROM pricing_effects WHERE shop_id = ${sqlShop(executor)}) pe ON pe.id = ad.pricing_effect_id`;
}

function toAssetLedgerEntry(row: AssetLedgerEntryRow): AssetLedgerEntry {
  return {
    assetType: row.asset_type,
    assetCode: row.asset_code,
    delta: centsOfInteger(row.delta),
    reason: row.reason,
    refId: row.ref_id,
    ...(row.transaction_id ? { transactionId: row.transaction_id } : {}),
  };
}

function toAssetTransaction(row: AssetTransactionRow): AssetTransaction {
  return {
    id: row.id,
    playerId: row.player_id,
    kind: row.kind,
    refId: row.ref_id,
    createdAt: new Date(row.created_at),
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
      : null,
  };
}

function defaultTargetKindForAction(type: DeviceState["type"]): NonNullable<DeviceState["targetKind"]> {
  return type === "coin" || type === "aime.scan" ? "game_machine" : "facility";
}

function defaultExecutorKindForAction(type: DeviceState["type"]): NonNullable<DeviceState["executorKind"]> {
  return defaultTargetKindForAction(type) === "game_machine" ? "machine_ws" : "home_assistant";
}

function toDeviceCommand(row: DeviceCommandRow): DeviceCommand {
  return {
    id: row.id,
    type: row.type,
    deviceId: row.device_id,
    targetKind: row.target_kind,
    executorKind: row.executor_kind,
    playerId: row.player_id ?? undefined,
    staffId: row.staff_id ?? undefined,
    status: row.status,
    payload: row.payload_json
      ? (JSON.parse(row.payload_json) as Record<string, unknown>)
      : undefined,
    requestedAt: new Date(row.requested_at),
    ackedAt: row.acked_at ? new Date(row.acked_at) : undefined,
    expiredAt: row.expired_at ? new Date(row.expired_at) : undefined,
  };
}

function toDeviceState(row: DeviceStateRow): DeviceState {
  return {
    deviceId: row.device_id,
    type: row.type,
    targetKind: row.target_kind,
    executorKind: row.executor_kind,
    label: row.label,
    status: row.status,
    state: row.state,
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
      : null,
    reportedAt: new Date(row.reported_at),
    reportedBy: row.reported_by,
  };
}

function toMachineConnection(row: MachineConnectionRow): MachineConnection {
  return {
    machineId: row.machine_id,
    status: row.status,
    capabilities: JSON.parse(row.capabilities_json) as string[],
    connectedAt: new Date(row.connected_at),
    lastSeenAt: new Date(row.last_seen_at),
    disconnectedAt: row.disconnected_at ? new Date(row.disconnected_at) : undefined,
  };
}

function toRedeemCode(row: RedeemCodeRow): RedeemCode {
  return {
    id: row.id,
    code: row.code,
    presentId: row.present_id,
    activeAt: row.active_at ? new Date(row.active_at) : null,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    maxUseCount: row.max_use_count,
    usageCount: row.usage_count ?? 0,
  };
}

function toPresent(row: PresentRow): Present {
  return {
    id: row.id,
    name: row.name,
    oncePerPlayer: row.once_per_player === 1,
    activeAt: row.active_at ? new Date(row.active_at) : null,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    status: row.status ?? "active",
    grants: normalizePresentGrants(JSON.parse(row.grants_json)),
  };
}

function normalizePresentGrants(value: unknown): Present["grants"] {
  if (!Array.isArray(value)) return [];
  return value.map((grant) => {
    const item = grant as Record<string, unknown>;
    return {
      ...item,
      assetType: String(item.assetType ?? ""),
      assetCode: String(item.assetCode ?? ""),
      amount:
        typeof item.amount === "number"
          ? item.amount
          : Number(item.amount ?? 0),
      mergeStrategy:
        item.mergeStrategy === "extend-time" || item.mergeStrategy === "replace"
          ? item.mergeStrategy
          : "stack",
      activeAt: toOptionalDateValue(item.activeAt),
      expiresAt: toOptionalDateValue(item.expiresAt ?? item.expireAt),
    };
  }) as Present["grants"];
}

function toOptionalDateValue(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value !== "string" || value.length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toRedeemRecord(row: RedeemRecordRow): RedeemRecord {
  return {
    playerId: row.player_id,
    codeId: row.code_id,
    presentId: row.present_id,
    redeemedAt: new Date(row.redeemed_at),
  };
}

function toSettlement(row: SettlementRow): SettlementRecord["settlement"] {
  return {
    sessionId: row.session_id,
    subtotal: centsOfInteger(row.subtotal),
    total: centsOfInteger(row.total),
    status: row.status,
    settledAt: new Date(row.settled_at),
  };
}

async function savePlayerCheckout(
  executor: SqlExecutor,
  checkout: PlayerCheckout,
): Promise<void> {
  await executor.run(
    `INSERT INTO player_checkouts (shop_id, id, player_id, subtotal, total, status, settled_at)
     VALUES (${sqlShop(executor)}, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(shop_id, id) DO UPDATE SET
       player_id = excluded.player_id,
       subtotal = excluded.subtotal,
       total = excluded.total,
       status = excluded.status,
       settled_at = excluded.settled_at`,
    [
      checkout.id,
      checkout.playerId,
      checkout.subtotal,
      checkout.total,
      checkout.status,
      checkout.settledAt.toISOString(),
    ],
  );
}

function toPricingConfig(row: PricingConfigRow): PricingConfig {
  const base = {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    status: row.status ?? "active",
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
  const provider = JSON.parse(row.provider_json) as PricingConfig["provider"];

  switch (row.kind) {
    case "time.priority":
      return {
        ...base,
        kind: row.kind,
        provider: deserializeTimePriorityPricingProviderConfig(
          provider as Extract<
            PricingConfig,
            { kind: "time.priority" }
          >["provider"],
        ),
      };
    case "time.cap":
      return {
        ...base,
        kind: row.kind,
        provider: deserializeTimeCapPricingProviderConfig(
          provider as Extract<
            PricingConfig,
            { kind: "time.cap" }
          >["provider"],
        ),
      };
    case "charge.fixed":
      return {
        ...base,
        kind: row.kind,
        provider: provider as Extract<
          PricingConfig,
          { kind: "charge.fixed" }
        >["provider"],
      };
  }
}

function toBusinessItem(row: BusinessItemRow): BusinessItem {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    price: row.price,
    assetType: row.asset_type,
    assetCode: row.asset_code,
    activeAt: row.active_at ? new Date(row.active_at) : null,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
      : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function toBusinessItemOrder(row: BusinessItemOrderRow): BusinessItemOrder {
  return {
    id: row.id,
    businessItemId: row.business_item_id,
    businessItemKind: row.business_item_kind,
    businessItemName: row.business_item_name,
    playerId: row.player_id,
    sessionId: row.session_id,
    status: row.status,
    price: row.price,
    assetType: row.asset_type,
    assetCode: row.asset_code,
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
      : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    fulfilledAt: row.fulfilled_at ? new Date(row.fulfilled_at) : null,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at) : null,
  };
}

function toStaffUser(row: StaffUserRow): StaffUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    role: row.role,
    status: row.status,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function toAdminSession(row: AdminSessionRow): AdminSession {
  return {
    id: row.id,
    staffUserId: row.staff_user_id,
    tokenHash: row.token_hash,
    expiresAt: new Date(row.expires_at),
    createdAt: new Date(row.created_at),
    lastUsedAt: new Date(row.last_used_at),
  };
}

function toApiToken(row: ApiTokenRow): ApiToken {
  return {
    id: row.id,
    label: row.label,
    role: row.role,
    tokenPrefix: row.token_prefix,
    tokenHash: row.token_hash,
    status: row.status,
    createdAt: new Date(row.created_at),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  };
}

function serializePricingProviderConfig(
  provider: PricingConfig["provider"],
): unknown {
  if (!("rules" in provider)) return provider;
  return {
    ...provider,
    rules: provider.rules.map((rule) => {
      const { dateTimeRange, ...rest } = rule;
      return {
        ...rest,
        ...(dateTimeRange
          ? {
              dateTimeRange: {
                start: dateTimeRange.start.toISOString(),
                end: dateTimeRange.end.toISOString(),
              },
            }
          : {}),
      };
    }),
  };
}

function pricingHistoryKey(key: PricingHistoryLookupKey): string {
  return `${key.pricingConfigId}@${key.providerId}@${key.ruleId}@${key.ruleAnchorAt.toISOString()}`;
}

function pricingCapHistoryKey(key: PricingCapHistoryLookupKey): string {
  return `${key.capConfigId}@${key.capRuleId}@${key.capAnchorAt.toISOString()}`;
}

function deserializeTimePriorityPricingProviderConfig(
  provider: Extract<PricingConfig, { kind: "time.priority" }>["provider"],
): Extract<PricingConfig, { kind: "time.priority" }>["provider"] {
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

function deserializeTimeCapPricingProviderConfig(
  provider: Extract<PricingConfig, { kind: "time.cap" }>["provider"],
): Extract<PricingConfig, { kind: "time.cap" }>["provider"] {
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
