import { type Cents, centsOfInteger, sumCents, ZERO_CENTS } from "@prism/core";
import { sqlShop } from "./shop-scope";
import type {
  ApplicationQueries,
  PlayerAssets,
  PlayerQueries,
  PlayerRedeemRecordListItem,
  PlayerSummary,
  SessionHistoryDetail,
  SessionHistoryListItem,
  StaffActiveSessionListItem,
  StaffDeviceCommandListItem,
  StaffPlayerListItem,
  StaffQueries,
  StaffRedeemCodeRedemptionListItem,
  StaffRedeemQueries,
  StaffReportPlayerListItem,
  StaffReportSettlementListItem,
  StaffReportsSummary,
} from "@prism/application";
import {
  evaluateAssetHoldingAvailability,
  sumCurrencyHoldings,
  type AssetDefinition,
  type DeviceState,
  type MachineConnection,
} from "@prism/core";
import type { SqlExecutor } from "./repositories";

export type CreateSqlReadModelsInput = {
  executor: SqlExecutor;
  now: () => Date;
};

export function createSqlReadModels(input: CreateSqlReadModelsInput): ApplicationQueries {
  return {
    playerQueries: createPlayerQueries(input),
    staffQueries: createStaffQueries(input),
    staffRedeemQueries: createStaffRedeemQueries(input),
  };
}

function createPlayerQueries(input: CreateSqlReadModelsInput): PlayerQueries {
  return {
    async getPlayerSummary(playerId) {
      const rows = await input.executor.all<PlayerSummaryRow>(
        `SELECT
           p.id,
           p.display_name,
           p.status,
           active_session.id AS active_session_id,
           active_session.started_at AS active_session_started_at,
           h.id AS holding_id,
           h.asset_type,
           h.asset_code,
           h.quantity,
           h.active_at AS holding_active_at,
           h.expires_at AS holding_expires_at,
           d.code AS definition_code,
           d.name AS asset_name,
           d.stackable AS definition_stackable,
           d.status AS definition_status,
           d.active_at AS definition_active_at,
           d.expires_at AS definition_expires_at,
           d.metadata_json
         FROM (SELECT * FROM players WHERE shop_id = ${sqlShop(input.executor)}) p
         LEFT JOIN (SELECT * FROM sessions WHERE shop_id = ${sqlShop(input.executor)}) active_session ON active_session.id = (
           SELECT s.id
           FROM (SELECT * FROM sessions WHERE shop_id = ${sqlShop(input.executor)}) s
           WHERE s.player_id = p.id AND s.status = 'active'
           LIMIT 1
         )
         LEFT JOIN (SELECT * FROM asset_holdings WHERE shop_id = ${sqlShop(input.executor)}) h ON h.player_id = p.id AND h.asset_type = 'currency'
         LEFT JOIN (SELECT * FROM asset_definitions WHERE shop_id = ${sqlShop(input.executor)}) d ON d.type = h.asset_type AND d.code = h.asset_code
         WHERE p.id = ?
         ORDER BY h.asset_type, h.asset_code, h.active_at, h.id`,
        [playerId],
      );
      const first = rows[0];
      if (!first) {
        throw new Error(`Player not found: ${playerId}`);
      }
      const at = input.now();
      const walletByCode = new Map<string, Cents>();
      for (const row of rows) {
        if (!row.holding_id || row.asset_type !== "currency") continue;
        const assessment = assessAssetHoldingRow(row, at, false);
        if (assessment.availability !== "available") continue;
        walletByCode.set(row.asset_code!, sumCents([
          walletByCode.get(row.asset_code!) ?? ZERO_CENTS,
          centsOfInteger(row.quantity!),
        ]));
      }

      return {
        player: toPlayerView(first),
        wallet: [...walletByCode.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([assetCode, quantity]) => ({ assetCode, quantity })),
        activeSession: first.active_session_id && first.active_session_started_at
          ? {
              id: first.active_session_id,
              startedAt: new Date(first.active_session_started_at),
            }
          : null,
      } satisfies PlayerSummary;
    },

    async listPlayerAssets(playerId) {
      return listPlayerAssets(input, playerId, { includeHidden: false });
    },

    async listPlayerSessionHistory(playerId) {
      return listPlayerSessionHistory(input, playerId);
    },

    async getPlayerSessionHistoryDetail(playerId, sessionId) {
      return getPlayerSessionHistoryDetail(input, playerId, sessionId);
    },
  };
}

function createStaffQueries(input: CreateSqlReadModelsInput): StaffQueries {
  return {
    async listPlayers(options) {
      const ids = options?.playerIds;
      if (ids?.length === 0) return [];
      const rows = await input.executor.all<StaffPlayerWithIdentityRow>(
        `WITH wallet_rows AS (
           SELECT
             h.player_id,
             json_group_array(json_object(
               'id', h.id,
               'asset_type', h.asset_type,
               'asset_code', h.asset_code,
               'asset_name', d.name,
               'definition_code', d.code,
               'definition_stackable', d.stackable,
               'definition_status', d.status,
               'definition_active_at', d.active_at,
               'definition_expires_at', d.expires_at,
               'metadata_json', d.metadata_json,
               'quantity', h.quantity,
               'holding_active_at', h.active_at,
               'holding_expires_at', h.expires_at
             )) AS wallet_rows_json
           FROM (SELECT * FROM asset_holdings WHERE shop_id = ${sqlShop(input.executor)}) h
           LEFT JOIN (SELECT * FROM asset_definitions WHERE shop_id = ${sqlShop(input.executor)}) d ON d.type = h.asset_type AND d.code = h.asset_code
           WHERE h.asset_type = 'currency'
             ${ids ? 'AND h.player_id IN (SELECT value FROM json_each(?))' : ''}
           GROUP BY h.player_id
         ), active_sessions AS (
           SELECT player_id, MIN(CASE WHEN status='active' THEN id END) AS active_session_id, MAX(payment_status='unpaid') AS has_unpaid_session
           FROM (SELECT * FROM sessions WHERE shop_id = ${sqlShop(input.executor)})
           WHERE status = 'active' OR payment_status = 'unpaid'
           GROUP BY player_id
         )
         SELECT
           p.id,
           p.display_name,
           p.status,
           wallet_rows.wallet_rows_json,
           active_sessions.active_session_id,
           active_sessions.has_unpaid_session,
           i.provider AS identity_provider,
           i.subject AS identity_subject,
           i.created_at AS identity_created_at
         FROM (SELECT * FROM players WHERE shop_id = ${sqlShop(input.executor)}) p
         LEFT JOIN wallet_rows ON wallet_rows.player_id = p.id
         LEFT JOIN active_sessions ON active_sessions.player_id = p.id
         LEFT JOIN (SELECT * FROM player_identities WHERE shop_id = ${sqlShop(input.executor)}) i ON i.player_id = p.id
         ${ids ? 'WHERE p.id IN (SELECT value FROM json_each(?))' : ''}
         ORDER BY p.created_at DESC, p.id, i.created_at ASC, i.provider, i.subject`,
        ids ? [JSON.stringify(ids), JSON.stringify(ids)] : [],
      );
      return groupStaffPlayers(rows, input.now());
    },

    async listActiveSessions() {
      const rows = await input.executor.all<StaffActiveSessionWithIdentityRow>(
        `SELECT
           s.id,
           s.player_id,
           p.display_name AS player_display_name,
           s.started_at,
           s.label,
           i.provider AS identity_provider,
           i.subject AS identity_subject
         FROM (SELECT * FROM sessions WHERE shop_id = ${sqlShop(input.executor)}) s
         INNER JOIN (SELECT * FROM players WHERE shop_id = ${sqlShop(input.executor)}) p ON p.id = s.player_id
         LEFT JOIN (SELECT * FROM player_identities WHERE shop_id = ${sqlShop(input.executor)}) i ON i.player_id = s.player_id
         WHERE s.status = 'active'
         ORDER BY s.started_at, s.id, i.created_at ASC, i.provider, i.subject`,
      );
      const now = input.now();
      return groupStaffActiveSessions(rows, now);
    },

    async listLiveSessions() {
      const rows = await input.executor.all<StaffActiveSessionRow & { status: string }>(
        `SELECT
           s.id,
           s.player_id,
           p.display_name AS player_display_name,
           s.started_at,
           s.ended_at,
           s.label,
           s.status
         FROM (SELECT * FROM sessions WHERE shop_id = ${sqlShop(input.executor)}) s
         INNER JOIN (SELECT * FROM players WHERE shop_id = ${sqlShop(input.executor)}) p ON p.id = s.player_id
         WHERE s.status = 'active' OR s.payment_status = 'unpaid'
         ORDER BY s.started_at`,
      );
      const now = input.now();

      return rows.map((row): StaffActiveSessionListItem => {
        const startedAt = new Date(row.started_at);
        const endedAt = row.ended_at ? new Date(row.ended_at) : null;
        const effectiveEnd = endedAt ?? now;
        return {
          id: row.id,
          playerId: row.player_id,
          playerDisplayName: row.player_display_name,
          startedAt,
          endedAt,
          elapsedMinutes: Math.floor((effectiveEnd.getTime() - startedAt.getTime()) / 60_000),
          label: row.label,
          status: row.status as "active" | "closed",
        };
      });
    },

    async getPlayerAssets(playerId) {
      return listPlayerAssets(input, playerId, { includeHidden: true });
    },

    async getPlayerSessionHistory(playerId) {
      return listPlayerSessionHistory(input, playerId);
    },

    async getPlayerSessionHistoryDetail(playerId, sessionId) {
      return getPlayerSessionHistoryDetail(input, playerId, sessionId);
    },

    async listPlayerRedeemRecords(playerId) {
      return listPlayerRedeemRecords(input, playerId);
    },

    async listDeviceCommands(query) {
      const rows = await input.executor.all<StaffDeviceCommandRow>(
        `SELECT
           id,
           type,
           device_id,
           target_kind,
           executor_kind,
           player_id,
           staff_id,
           status,
           requested_at,
           acked_at,
           expired_at,
           payload_json
         FROM (SELECT * FROM device_commands WHERE shop_id = ${sqlShop(input.executor)})
         ORDER BY requested_at DESC, id
         LIMIT ?`,
        [query.limit],
      );

      return rows.map(
        (row): StaffDeviceCommandListItem => ({
          id: row.id,
          type: row.type,
          deviceId: row.device_id,
          targetKind: row.target_kind,
          executorKind: row.executor_kind,
          playerId: row.player_id,
          staffId: row.staff_id,
          status: row.status,
          requestedAt: new Date(row.requested_at),
          ackedAt: row.acked_at ? new Date(row.acked_at) : null,
          expiredAt: row.expired_at ? new Date(row.expired_at) : null,
          payload: row.payload_json ? (JSON.parse(row.payload_json) as Record<string, unknown>) : null,
        }),
      );
    },

    async listDeviceStates() {
      return listDeviceStates(input);
    },

    async listMachineConnections() {
      return listMachineConnections(input);
    },

    async getReportsSummary(query) {
      return getReportsSummary(input, query);
    },

    async listReportSettlements(query) {
      return listReportSettlements(input, query);
    },

    async listReportPlayers(query) {
      return listReportPlayers(input, query);
    },
  };
}

function createStaffRedeemQueries(input: CreateSqlReadModelsInput): StaffRedeemQueries {
  return {
    async listRedeemCodeRedemptions(): Promise<StaffRedeemCodeRedemptionListItem[]> {
      const rows = await input.executor.all<StaffRedeemCodeRedemptionRow>(
        `SELECT
           rr.code_id,
           rr.player_id,
           p.display_name AS player_display_name,
           rr.redeemed_at
         FROM (SELECT * FROM redeem_records WHERE shop_id = ${sqlShop(input.executor)}) rr
         INNER JOIN (SELECT * FROM players WHERE shop_id = ${sqlShop(input.executor)}) p ON p.id = rr.player_id
         ORDER BY rr.redeemed_at DESC, rr.code_id`,
      );
      return rows.map((row) => ({
        codeId: row.code_id,
        playerId: row.player_id,
        playerDisplayName: row.player_display_name,
        redeemedAt: new Date(row.redeemed_at),
      }));
    },
  };
}

async function getReportsSummary(
  input: CreateSqlReadModelsInput,
  query: { from: Date; to: Date },
): Promise<StaffReportsSummary> {
  const row = await input.executor.first<StaffReportsSummaryRow>(
    `WITH bounds(from_at, to_at) AS (VALUES (?, ?)),
     settlement_summary AS (
       SELECT
         COALESCE(SUM(pc.total), 0) AS revenue_total,
         (
           SELECT COUNT(*)
           FROM (SELECT * FROM settlements WHERE shop_id = ${sqlShop(input.executor)}) st
           CROSS JOIN bounds
           WHERE st.settled_at >= bounds.from_at AND st.settled_at < bounds.to_at
         ) AS session_count
       FROM (SELECT * FROM player_checkouts WHERE shop_id = ${sqlShop(input.executor)}) pc
       CROSS JOIN bounds
       WHERE pc.settled_at >= bounds.from_at AND pc.settled_at < bounds.to_at
     ), asset_summary AS (
       SELECT COUNT(*) AS asset_grant_total
       FROM (SELECT * FROM asset_ledger_entries WHERE shop_id = ${sqlShop(input.executor)}), bounds
       WHERE delta > 0 AND created_at >= bounds.from_at AND created_at < bounds.to_at
     ), coin_summary AS (
       SELECT COUNT(*) AS coin_command_count
       FROM (SELECT * FROM device_commands WHERE shop_id = ${sqlShop(input.executor)}), bounds
       WHERE type = 'coin' AND requested_at >= bounds.from_at AND requested_at < bounds.to_at
     )
     SELECT
       settlement_summary.revenue_total,
       settlement_summary.session_count,
       asset_summary.asset_grant_total,
       coin_summary.coin_command_count
     FROM settlement_summary, asset_summary, coin_summary`,
    [query.from.toISOString(), query.to.toISOString()],
  );

  return {
    from: query.from,
    to: query.to,
    revenueTotal: centsOfInteger(row?.revenue_total ?? 0),
    sessionCount: row?.session_count ?? 0,
    assetGrantTotal: row?.asset_grant_total ?? 0,
    coinCommandCount: row?.coin_command_count ?? 0,
  };
}

async function listReportSettlements(
  input: CreateSqlReadModelsInput,
  query: { from: Date; to: Date; limit: number; offset?: number },
): Promise<StaffReportSettlementListItem[]> {
  const rows = await input.executor.all<StaffReportSettlementRow>(
    `SELECT
       st.id AS settlement_id,
       st.session_id,
       s.player_id,
       p.display_name AS player_display_name,
       s.started_at,
       s.ended_at,
       st.settled_at,
       st.subtotal,
       st.total
     FROM (SELECT * FROM settlements WHERE shop_id = ${sqlShop(input.executor)}) st
     INNER JOIN (SELECT * FROM sessions WHERE shop_id = ${sqlShop(input.executor)}) s ON s.id = st.session_id
     INNER JOIN (SELECT * FROM players WHERE shop_id = ${sqlShop(input.executor)}) p ON p.id = s.player_id
     WHERE st.settled_at >= ? AND st.settled_at < ?
     ORDER BY st.settled_at DESC, st.id DESC
     LIMIT ? OFFSET ?`,
    [query.from.toISOString(), query.to.toISOString(), query.limit, query.offset ?? 0],
  );

  return rows.map((row): StaffReportSettlementListItem => {
    const startedAt = new Date(row.started_at);
    const endedAt = row.ended_at ? new Date(row.ended_at) : null;

    return {
      settlementId: row.settlement_id,
      sessionId: row.session_id,
      playerId: row.player_id,
      playerDisplayName: row.player_display_name,
      startedAt,
      endedAt,
      settledAt: new Date(row.settled_at),
      durationMinutes: endedAt ? Math.floor((endedAt.getTime() - startedAt.getTime()) / 60_000) : null,
      subtotal: centsOfInteger(row.subtotal),
      total: centsOfInteger(row.total),
    };
  });
}

async function listReportPlayers(
  input: CreateSqlReadModelsInput,
  query: { from: Date; to: Date; limit: number; offset?: number },
): Promise<StaffReportPlayerListItem[]> {
  const rows = await input.executor.all<StaffReportPlayerRow>(
    `WITH bounds(from_at, to_at) AS (VALUES (?, ?)),
     settlement_rows AS (
       SELECT
         s.player_id,
         p.display_name AS player_display_name,
         st.settled_at,
         CASE
           WHEN s.ended_at IS NULL THEN 0
           ELSE CAST((strftime('%s', s.ended_at) - strftime('%s', s.started_at)) / 60 AS INTEGER)
         END AS duration_minutes
       FROM (SELECT * FROM settlements WHERE shop_id = ${sqlShop(input.executor)}) st
       INNER JOIN (SELECT * FROM sessions WHERE shop_id = ${sqlShop(input.executor)}) s ON s.id = st.session_id
       INNER JOIN (SELECT * FROM players WHERE shop_id = ${sqlShop(input.executor)}) p ON p.id = s.player_id
       CROSS JOIN bounds
       WHERE st.settled_at >= bounds.from_at AND st.settled_at < bounds.to_at
     ), player_revenue AS (
       SELECT pc.player_id, COALESCE(SUM(pc.total), 0) AS revenue_total
       FROM (SELECT * FROM player_checkouts WHERE shop_id = ${sqlShop(input.executor)}) pc
       CROSS JOIN bounds
       WHERE pc.settled_at >= bounds.from_at AND pc.settled_at < bounds.to_at
       GROUP BY pc.player_id
     ), player_activity AS (
       SELECT
         player_id,
         player_display_name,
         COUNT(*) AS settlement_count,
         COALESCE(SUM(duration_minutes), 0) AS total_duration_minutes,
         MAX(settled_at) AS last_settled_at
       FROM settlement_rows
       GROUP BY player_id, player_display_name
     )
     SELECT
       player_activity.player_id,
       player_activity.player_display_name,
       player_activity.settlement_count,
       player_revenue.revenue_total,
       player_activity.total_duration_minutes,
       player_activity.last_settled_at
     FROM player_activity
     INNER JOIN player_revenue ON player_revenue.player_id = player_activity.player_id
     ORDER BY revenue_total DESC, settlement_count DESC, last_settled_at DESC, player_activity.player_id
     LIMIT ? OFFSET ?`,
    [query.from.toISOString(), query.to.toISOString(), query.limit, query.offset ?? 0],
  );

  return rows.map(
    (row): StaffReportPlayerListItem => ({
      playerId: row.player_id,
      playerDisplayName: row.player_display_name,
      settlementCount: row.settlement_count,
      totalDurationMinutes: row.total_duration_minutes,
      revenueTotal: centsOfInteger(row.revenue_total),
      lastSettledAt: new Date(row.last_settled_at),
    }),
  );
}

async function listDeviceStates(input: CreateSqlReadModelsInput): Promise<DeviceState[]> {
  const rows = await input.executor.all<DeviceStateRow>(
    `SELECT device_id, type, target_kind, executor_kind, label, status, state, metadata_json, reported_at, reported_by
     FROM (SELECT * FROM device_states WHERE shop_id = ${sqlShop(input.executor)})
     ORDER BY reported_at DESC, device_id`,
  );

  return rows.map((row) => ({
    deviceId: row.device_id,
    type: row.type,
    targetKind: row.target_kind,
    executorKind: row.executor_kind,
    label: row.label,
    status: row.status,
    state: row.state,
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : null,
    reportedAt: new Date(row.reported_at),
    reportedBy: row.reported_by,
  }));
}

async function listMachineConnections(input: CreateSqlReadModelsInput): Promise<MachineConnection[]> {
  const rows = await input.executor.all<MachineConnectionRow>(
    `SELECT machine_id, status, capabilities_json, connected_at, last_seen_at, disconnected_at
     FROM (SELECT * FROM machine_connections WHERE shop_id = ${sqlShop(input.executor)})
     ORDER BY status DESC, last_seen_at DESC, machine_id`,
  );

  return rows.map((row) => ({
    machineId: row.machine_id,
    status: row.status,
    capabilities: row.capabilities_json ? (JSON.parse(row.capabilities_json) as string[]) : [],
    connectedAt: new Date(row.connected_at),
    lastSeenAt: new Date(row.last_seen_at),
    disconnectedAt: row.disconnected_at ? new Date(row.disconnected_at) : undefined,
  }));
}

async function getPlayerSessionHistoryDetail(
  input: CreateSqlReadModelsInput,
  playerId: string,
  sessionId: string,
): Promise<SessionHistoryDetail | null> {
  const rows = await input.executor.all<SessionHistoryDetailRow>(
    `WITH session_detail AS (
       SELECT
         s.id AS session_id,
         s.started_at,
         s.ended_at,
         s.status AS session_status,
         st.subtotal,
         st.total,
         st.status AS settlement_status,
         st.settled_at
       FROM (SELECT * FROM sessions WHERE shop_id = ${sqlShop(input.executor)}) s
       LEFT JOIN (SELECT * FROM settlements WHERE shop_id = ${sqlShop(input.executor)}) st ON st.session_id = s.id
       WHERE s.player_id = ? AND s.id = ?
       LIMIT 1
     ), detail_rows AS (
       SELECT 0 AS row_order, 'session' AS row_kind, sd.*,
              NULL AS item_id, NULL AS item_source, NULL AS item_label, NULL AS item_amount,
              0 AS item_order
       FROM session_detail sd
       UNION ALL
       SELECT 1, 'charge', sd.*,
              ci.id, ci.source, ci.label, ci.amount, ci.item_order
       FROM session_detail sd
       INNER JOIN (SELECT * FROM settlement_charge_items WHERE shop_id = ${sqlShop(input.executor)}) ci ON ci.session_id = sd.session_id
       UNION ALL
       SELECT 2, 'adjustment', sd.*,
              sa.id, sa.source, sa.label, sa.amount, sa.adjustment_order
       FROM session_detail sd
       INNER JOIN (SELECT * FROM settlement_adjustments WHERE shop_id = ${sqlShop(input.executor)}) sa ON sa.session_id = sd.session_id
     )
     SELECT * FROM detail_rows
     ORDER BY row_order, item_order, item_id`,
    [playerId, sessionId],
  );
  const sessionRow = rows[0];
  if (!sessionRow) return null;

  return {
    ...toSessionHistoryListItem(sessionRow),
    chargeItems: rows.flatMap((row) =>
      row.row_kind === "charge" && row.item_id && row.item_amount !== null
        ? [{ id: row.item_id, source: row.item_source!, label: row.item_label!, amount: centsOfInteger(row.item_amount) }]
        : [],
    ),
    adjustments: rows.flatMap((row) =>
      row.row_kind === "adjustment" && row.item_id && row.item_amount !== null
        ? [{ id: row.item_id, source: row.item_source!, label: row.item_label!, amount: centsOfInteger(row.item_amount) }]
        : [],
    ),
  };
}

async function listPlayerSessionHistory(
  input: CreateSqlReadModelsInput,
  playerId: string,
): Promise<SessionHistoryListItem[]> {
  const rows = await input.executor.all<SessionHistoryRow>(
    `SELECT
       s.id AS session_id,
       s.started_at,
       s.ended_at,
       s.status AS session_status,
       st.subtotal,
       st.total,
       st.status AS settlement_status,
       st.settled_at
     FROM (SELECT * FROM sessions WHERE shop_id = ${sqlShop(input.executor)}) s
     LEFT JOIN (SELECT * FROM settlements WHERE shop_id = ${sqlShop(input.executor)}) st ON st.session_id = s.id
     WHERE s.player_id = ?
     ORDER BY COALESCE(s.ended_at, s.started_at) DESC, s.id DESC
     LIMIT 100`,
    [playerId],
  );

  return rows.map(toSessionHistoryListItem);
}

function toSessionHistoryListItem(row: SessionHistoryRow): SessionHistoryListItem {
  const startedAt = new Date(row.started_at);
  const endedAt = row.ended_at ? new Date(row.ended_at) : null;

  return {
    sessionId: row.session_id,
    startedAt,
    endedAt,
    durationMinutes: endedAt ? Math.floor((endedAt.getTime() - startedAt.getTime()) / 60_000) : null,
    subtotal: row.subtotal === null ? null : centsOfInteger(row.subtotal),
    total: row.total === null ? null : centsOfInteger(row.total),
    status: row.settlement_status === "settled" ? "settled" : row.session_status,
    settledAt: row.settled_at ? new Date(row.settled_at) : null,
  };
}

async function listPlayerAssets(
  input: CreateSqlReadModelsInput,
  playerId: string,
  options: { includeHidden: boolean },
): Promise<PlayerAssets> {
  const rows = await input.executor.all<PlayerAssetRow>(
    `WITH holding_rows AS (
       SELECT
         'holding' AS row_kind,
         h.id,
         h.asset_type,
         h.asset_code,
         d.name AS asset_name,
         d.code AS definition_code,
         d.stackable AS definition_stackable,
         d.status AS definition_status,
         d.active_at AS definition_active_at,
         d.expires_at AS definition_expires_at,
         d.metadata_json,
         h.quantity,
         h.active_at AS holding_active_at,
         h.expires_at AS holding_expires_at,
         NULL AS delta,
         NULL AS reason,
         NULL AS ref_id,
         NULL AS transaction_id,
         NULL AS created_at
       FROM (SELECT * FROM asset_holdings WHERE shop_id = ${sqlShop(input.executor)}) h
       LEFT JOIN (SELECT * FROM asset_definitions WHERE shop_id = ${sqlShop(input.executor)}) d ON d.type = h.asset_type AND d.code = h.asset_code
       WHERE h.player_id = ?
     ), ledger_rows AS (
       SELECT
         'ledger' AS row_kind,
         l.id,
         l.asset_type,
         l.asset_code,
         d.name AS asset_name,
         d.code AS definition_code,
         d.stackable AS definition_stackable,
         d.status AS definition_status,
         d.active_at AS definition_active_at,
         d.expires_at AS definition_expires_at,
         d.metadata_json,
         NULL AS quantity,
         NULL AS holding_active_at,
         NULL AS holding_expires_at,
         l.delta,
         l.reason,
         l.ref_id,
         l.transaction_id,
         l.created_at
       FROM (SELECT * FROM asset_ledger_entries WHERE shop_id = ${sqlShop(input.executor)}) l
       INNER JOIN (SELECT * FROM asset_definitions WHERE shop_id = ${sqlShop(input.executor)}) d ON d.type = l.asset_type AND d.code = l.asset_code
       WHERE l.player_id = ?
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT 100
     ), combined AS (
       SELECT * FROM holding_rows
       UNION ALL
       SELECT * FROM ledger_rows
     )
     SELECT * FROM combined
     ORDER BY
       CASE row_kind WHEN 'holding' THEN 0 ELSE 1 END,
       CASE WHEN row_kind = 'holding' THEN asset_type END,
       CASE WHEN row_kind = 'holding' THEN asset_code END,
       CASE WHEN row_kind = 'holding' THEN holding_active_at END,
       CASE WHEN row_kind = 'holding' THEN id END,
       CASE WHEN row_kind = 'ledger' THEN created_at END DESC,
       CASE WHEN row_kind = 'ledger' THEN id END DESC`,
    [playerId, playerId],
  );
  const at = input.now();
  const assessments = rows
    .filter((row): row is PlayerAssetRow & { row_kind: "holding"; quantity: number } => row.row_kind === "holding")
    .map((row) => assessAssetHoldingRow(row, at, options.includeHidden));
  const holdings = assessments.flatMap((assessment) => {
    if (!options.includeHidden && assessment.availability !== "available") return [];
    const base = {
      id: assessment.holding.id!,
      assetType: assessment.holding.assetType,
      assetCode: assessment.holding.assetCode,
      assetName: assessment.definition?.name ?? null,
      quantity: assessment.holding.quantity,
      activeAt: assessment.holding.activeAt ?? null,
      expiresAt: assessment.holding.expiresAt ?? null,
      metadata: assessment.definition?.metadata ?? null,
    };
    return options.includeHidden
      ? [{ ...base, availability: assessment.availability, unavailableReasons: assessment.unavailableReasons }]
      : [base];
  });
  const ledgerEntries = rows
    .filter((row): row is PlayerAssetRow & {
      row_kind: "ledger";
      asset_type: string;
      asset_code: string;
      asset_name: string;
      delta: number;
      reason: string;
      ref_id: string;
      created_at: string;
    } => row.row_kind === "ledger")
    .map((row) => ({
      id: row.id,
      assetType: row.asset_type,
      assetCode: row.asset_code,
      assetName: row.asset_name,
      delta: centsOfInteger(row.delta),
      reason: row.reason,
      refId: row.ref_id,
      transactionId: row.transaction_id,
      createdAt: new Date(row.created_at),
      metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : null,
    }))
    .filter((entry) => options.includeHidden || entry.metadata?.hiddenFromPlayer !== true)
    .map(({ metadata: _metadata, ...entry }) => entry);

  return {
    holdings,
    ledgerEntries,
  };
}

async function listPlayerRedeemRecords(
  input: CreateSqlReadModelsInput,
  playerId: string,
): Promise<PlayerRedeemRecordListItem[]> {
  const rows = await input.executor.all<PlayerRedeemRecordRow>(
    `SELECT
       rr.code_id,
       rc.code,
       rr.present_id,
       pr.name AS present_name,
       rr.redeemed_at
     FROM (SELECT * FROM redeem_records WHERE shop_id = ${sqlShop(input.executor)}) rr
     INNER JOIN (SELECT * FROM redeem_codes WHERE shop_id = ${sqlShop(input.executor)}) rc ON rc.id = rr.code_id
     INNER JOIN (SELECT * FROM presents WHERE shop_id = ${sqlShop(input.executor)}) pr ON pr.id = rr.present_id
     WHERE rr.player_id = ?
     ORDER BY rr.redeemed_at DESC, rr.code_id`,
    [playerId],
  );
  return rows.map((row) => ({
    codeId: row.code_id,
    code: row.code,
    presentId: row.present_id,
    presentName: row.present_name,
    redeemedAt: new Date(row.redeemed_at),
  }));
}

function assessAssetHoldingRow(
  row: AssetHoldingAssessmentRow,
  at: Date,
  includeHidden: boolean,
) {
  const holding = {
    id: row.holding_id ?? row.id,
    assetType: row.asset_type!,
    assetCode: row.asset_code!,
    quantity: centsOfInteger(row.quantity!),
    activeAt: row.holding_active_at ? new Date(row.holding_active_at) : null,
    expiresAt: row.holding_expires_at ? new Date(row.holding_expires_at) : null,
  };
  const definition: AssetDefinition | null = row.definition_code === null
    ? null
    : {
        type: row.asset_type!,
        code: row.definition_code,
        name: row.asset_name!,
        stackable: row.definition_stackable === 1,
        status: row.definition_status ?? "active",
        activeAt: row.definition_active_at ? new Date(row.definition_active_at) : null,
        expiresAt: row.definition_expires_at ? new Date(row.definition_expires_at) : null,
        metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : null,
      };
  const evaluation = evaluateAssetHoldingAvailability({ holding, definition, at, includeHidden });
  return {
    holding,
    definition,
    availability: evaluation.available ? "available" as const : "unavailable" as const,
    unavailableReasons: evaluation.unavailableReasons,
  };
}

function groupStaffPlayers(
  rows: readonly StaffPlayerWithIdentityRow[],
  at: Date,
): StaffPlayerListItem[] {
  const players = new Map<string, StaffPlayerListItem & { identities: NonNullable<StaffPlayerListItem["identities"]> }>();
  for (const row of rows) {
    let player = players.get(row.id);
    if (!player) {
      player = {
        id: row.id,
        displayName: row.display_name,
        status: row.status,
        walletTotal: availableCurrencyTotal(row.wallet_rows_json, at),
        activeSessionId: row.active_session_id,
        hasUnpaidSession: !!row.has_unpaid_session,
        identities: [],
      };
      players.set(row.id, player);
    }
    if (row.identity_provider && row.identity_subject && row.identity_created_at) {
      player.identities.push({
        provider: row.identity_provider,
        subject: row.identity_subject,
        createdAt: new Date(row.identity_created_at),
      });
    }
  }
  return [...players.values()];
}

function availableCurrencyTotal(rowsJson: string | null, at: Date): Cents {
  if (!rowsJson) return ZERO_CENTS;
  const rows = JSON.parse(rowsJson) as AssetHoldingAssessmentRow[];
  const availableHoldings = rows.flatMap((row) => {
    const assessment = assessAssetHoldingRow(row, at, false);
    return assessment.availability === "available" ? [assessment.holding] : [];
  });
  return sumCurrencyHoldings(availableHoldings);
}

function groupStaffActiveSessions(
  rows: readonly StaffActiveSessionWithIdentityRow[],
  now: Date,
): StaffActiveSessionListItem[] {
  const sessions = new Map<string, StaffActiveSessionListItem & { identities: NonNullable<StaffActiveSessionListItem["identities"]> }>();
  for (const row of rows) {
    let session = sessions.get(row.id);
    if (!session) {
      const startedAt = new Date(row.started_at);
      session = {
        id: row.id,
        playerId: row.player_id,
        playerDisplayName: row.player_display_name,
        startedAt,
        elapsedMinutes: Math.floor((now.getTime() - startedAt.getTime()) / 60_000),
        label: row.label,
        identities: [],
      };
      sessions.set(row.id, session);
    }
    if (row.identity_provider && row.identity_subject) {
      session.identities.push({ provider: row.identity_provider, subject: row.identity_subject });
    }
  }
  return [...sessions.values()];
}

type PlayerRow = {
  id: string;
  display_name: string;
  status: PlayerSummary["player"]["status"];
};

type AssetHoldingAssessmentRow = {
  id: string;
  holding_id?: string | null;
  asset_type: string | null;
  asset_code: string | null;
  asset_name: string | null;
  definition_code: string | null;
  definition_stackable: number | null;
  definition_status: AssetDefinition["status"] | null;
  definition_active_at: string | null;
  definition_expires_at: string | null;
  metadata_json: string | null;
  quantity: number | null;
  holding_active_at: string | null;
  holding_expires_at: string | null;
};

type PlayerSummaryRow = PlayerRow & AssetHoldingAssessmentRow & {
  active_session_id: string | null;
  active_session_started_at: string | null;
};

type PlayerAssetRow = AssetHoldingAssessmentRow & {
  row_kind: "holding" | "ledger";
  delta: number | null;
  reason: string | null;
  ref_id: string | null;
  transaction_id: string | null;
  created_at: string | null;
};

type SessionHistoryRow = {
  session_id: string;
  started_at: string;
  ended_at: string | null;
  session_status: "active" | "closed";
  subtotal: number | null;
  total: number | null;
  settlement_status: "settled" | null;
  settled_at: string | null;
};

type SessionHistoryDetailRow = SessionHistoryRow & {
  row_kind: "session" | "charge" | "adjustment";
  item_id: string | null;
  item_source: string | null;
  item_label: string | null;
  item_amount: number | null;
};

type StaffPlayerRow = {
  id: string;
  display_name: string;
  status: StaffPlayerListItem["status"];
  wallet_rows_json: string | null;
  active_session_id: string | null;
  has_unpaid_session: number | null;
};

type StaffPlayerWithIdentityRow = StaffPlayerRow & {
  identity_provider: string | null;
  identity_subject: string | null;
  identity_created_at: string | null;
};

type StaffRedeemCodeRedemptionRow = {
  code_id: string;
  player_id: string;
  player_display_name: string;
  redeemed_at: string;
};

type PlayerRedeemRecordRow = {
  code_id: string;
  code: string;
  present_id: string;
  present_name: string;
  redeemed_at: string;
};

type StaffActiveSessionRow = {
  id: string;
  player_id: string;
  player_display_name: string;
  started_at: string;
  ended_at?: string | null;
  label: string | null;
};

type StaffActiveSessionWithIdentityRow = StaffActiveSessionRow & {
  identity_provider: string | null;
  identity_subject: string | null;
};

type StaffDeviceCommandRow = {
  id: string;
  type: StaffDeviceCommandListItem["type"];
  device_id: string | null;
  target_kind: StaffDeviceCommandListItem["targetKind"];
  executor_kind: StaffDeviceCommandListItem["executorKind"];
  player_id: string | null;
  staff_id: string | null;
  status: StaffDeviceCommandListItem["status"];
  requested_at: string;
  acked_at: string | null;
  expired_at: string | null;
  payload_json: string | null;
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
  capabilities_json: string | null;
  connected_at: string;
  last_seen_at: string;
  disconnected_at: string | null;
};

type StaffReportSettlementRow = {
  settlement_id: string;
  session_id: string;
  player_id: string;
  player_display_name: string;
  started_at: string;
  ended_at: string | null;
  settled_at: string;
  subtotal: number;
  total: number;
};

type StaffReportPlayerRow = {
  player_id: string;
  player_display_name: string;
  settlement_count: number;
  total_duration_minutes: number;
  revenue_total: number;
  last_settled_at: string;
};

type StaffReportsSummaryRow = {
  revenue_total: number;
  session_count: number;
  asset_grant_total: number;
  coin_command_count: number;
};

function toPlayerView(row: PlayerRow): PlayerSummary["player"] {
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
  };
}
