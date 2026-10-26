import { type Cents, type BillTimeline, yuanOf, assetQuantityFromStored, centsOfInteger, sumCents, ZERO_CENTS, operationToLegacyCommand } from "@prism/core";
import { buildBillTimeline } from "@prism/application";
import { sqlShop } from "./shop-scope";
import { createDeviceEventRepository } from "./device-event-repository";
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

async function getPlayerCheckout(input: CreateSqlReadModelsInput, playerId: string, checkoutId?: string): Promise<import("@prism/application").PlayerCheckoutReceipt | null> {
  const [checkout] = await input.executor.all<{ id: string; total: number; settled_at: string; timeline_json: string | null; profile_json: string | null; metadata_json: string | null; payment_method: string | null; collected_by: string | null; collected_at: string | null }>(
    `SELECT c.id, c.total, c.settled_at, t.timeline_json, profile.value_json AS profile_json, tx.metadata_json, payment.method AS payment_method, payment.staff_id AS collected_by, payment.collected_at FROM player_checkouts c
     LEFT JOIN cashier_payments payment ON payment.shop_id=c.shop_id AND payment.checkout_id=c.id
     LEFT JOIN checkout_timelines t ON t.shop_id = c.shop_id AND t.checkout_id = c.id
     LEFT JOIN app_settings profile ON profile.shop_id = c.shop_id AND profile.key = 'store.profile'
     LEFT JOIN asset_transactions tx ON tx.shop_id = c.shop_id AND tx.player_id = c.player_id
       AND tx.kind = 'session.settlement' AND 'player-checkout:' || tx.ref_id = c.id
     WHERE c.shop_id = ${sqlShop(input.executor)} AND c.player_id = ? ${checkoutId === undefined ? "" : "AND c.id = ?"}
     ORDER BY c.settled_at DESC, c.id DESC LIMIT 1`, checkoutId === undefined ? [playerId] : [playerId, checkoutId]);
  if (!checkout) return null;
  const rows = await input.executor.all<{ session_id: string; label: string | null }>(
    `SELECT st.session_id, s.label FROM settlements st JOIN sessions s ON s.shop_id = st.shop_id AND s.id = st.session_id
     WHERE st.shop_id = ${sqlShop(input.executor)} AND st.checkout_id = ? AND s.player_id = ? ORDER BY s.started_at, s.id`, [checkout.id, playerId]);
  const details = await Promise.all(rows.map(row => getPlayerSessionHistoryDetail(input, playerId, row.session_id)));
  const sessions = details.filter((detail): detail is SessionHistoryDetail => detail !== null);
  const plans = await input.executor.all<{ id: string; name: string; session_id: string }>(
    `SELECT DISTINCT p.id, p.name, s.id AS session_id FROM pricing_configs p
     JOIN sessions s ON s.shop_id = p.shop_id
     JOIN settlements st ON st.shop_id = s.shop_id AND st.session_id = s.id
     LEFT JOIN settlement_charge_items ci ON ci.shop_id = s.shop_id AND ci.session_id = s.id
       AND ci.source = p.id
     WHERE p.shop_id = ${sqlShop(input.executor)} AND st.checkout_id = ?
       AND (ci.id IS NOT NULL OR p.id IN (SELECT value FROM json_each(s.pricing_config_ids_json)))`, [checkout.id]);
  const labels = new Map(rows.map(row => [row.session_id, row.label]));
  for (const row of rows) {
    const names = [...new Set(plans.filter(plan => plan.session_id === row.session_id).map(plan => plan.name))];
    if (names.length === 1) labels.set(row.session_id, names[0]!);
  }
  const adjustments = sessions.flatMap(session => session.adjustments);
  const capPlans = await input.executor.all<{ source: string; name: string }>(
    `SELECT DISTINCT a.source, p.name FROM settlement_adjustments a
     JOIN settlements st ON st.shop_id = a.shop_id AND st.session_id = a.session_id
     JOIN pricing_configs p ON p.shop_id = a.shop_id AND p.kind = 'time.cap'
       AND substr(a.source, 1, length(p.id) + 10) = 'time.cap:' || p.id || ':'
     WHERE a.shop_id = ${sqlShop(input.executor)} AND st.checkout_id = ?`, [checkout.id]);
  const capNames = new Map(capPlans.map(plan => [plan.source, plan.name]));
  const money = (item: { id: string; label: string; amount: Cents }) => ({ ...item, amount: yuanOf(item.amount) });
  const balance = checkout.metadata_json ? (JSON.parse(checkout.metadata_json) as { walletBalanceAfter?: unknown }).walletBalanceAfter : undefined;
  const timeline = checkout.timeline_json ? JSON.parse(checkout.timeline_json) as BillTimeline : buildBillTimeline({
      timeZone: checkout.profile_json ? (JSON.parse(checkout.profile_json) as { timeZone?: string }).timeZone : undefined,
      planNames: new Map([...plans.map(plan => [plan.id, plan.name] as const), ...capNames]),
      at: new Date(checkout.settled_at), sessions: sessions.map(session => ({ ...session, label: labels.get(session.sessionId) ?? null, endedAt: session.endedAt ?? new Date(checkout.settled_at) })), adjustments, globalCapWindows: [],
    });
  // Older snapshots may contain the internal admission marker instead of a display name.
  const renamed = new Map<string, string>();
  for (const track of timeline.tracks) {
    if (track.name !== "entry") continue;
    const session = rows.find(row => track.id.startsWith(`${row.session_id}:`));
    const plan = session && plans.find(plan => plan.session_id === session.session_id && track.id === `${session.session_id}:${plan.id}`);
    const label = session && labels.get(session.session_id);
    track.name = plan?.name ?? (label && label !== "entry" ? label : "入场计费");
    renamed.set(track.id, track.name);
  }
  let changed = renamed.size > 0;
  for (const event of timeline.events) for (const entry of event.entries) {
    if (entry.kind === "start" && entry.trackId && !entry.rule) {
      const first = timeline.events.flatMap(event => event.entries.map(item => ({ item, at: item.startedAt ?? event.at })))
        .filter(({ item }) => item.trackId === entry.trackId && item.amount != null && item.rule)
        .sort((a, b) => a.at.localeCompare(b.at))[0];
      entry.rule = first?.item.rule ?? null;
    }
    if (entry.kind === "adjustment" && !entry.trackId) {
      const matches = adjustments.filter(adjustment => (adjustment.label === entry.name || `全局封顶（${adjustment.label}）` === entry.name) && yuanOf(adjustment.amount) === entry.amount);
      if (matches.length && matches.every(adjustment => adjustment.source.startsWith("time.cap:"))) {
        const names = new Set(matches.map(adjustment => `${capNames.get(adjustment.source) ?? "全局封顶"}（${adjustment.label}）`));
        if (names.size === 1) { entry.name = [...names][0]!; changed = true; }
      }
    }
  }
  if (changed) {
    const totals = new Map<string, number>();
    for (const event of timeline.events) for (const entry of event.entries) {
      if (entry.trackId && renamed.has(entry.trackId)) entry.name = renamed.get(entry.trackId)!;
      if (entry.amount != null) totals.set(entry.name, (totals.get(entry.name) ?? 0) + Math.round(entry.amount * 100));
    }
    timeline.totals = [...totals].map(([name, amount]) => ({ name, amount: yuanOf(centsOfInteger(amount)) }));
  }
  return {
    ...(checkout.payment_method ? { externalPayment: { method: checkout.payment_method, staffId: checkout.collected_by!, collectedAt: checkout.collected_at! } } : {}),
    wallet: typeof balance === "number" && Number.isSafeInteger(balance) ? { balanceAfter: yuanOf(centsOfInteger(balance)) } : null,
    playerSettlement: { total: yuanOf(centsOfInteger(checkout.total)), settledAt: checkout.settled_at },
    settlements: sessions.map(session => ({ settlement: { sessionId: session.sessionId,
      startedAt: session.startedAt.toISOString(), endedAt: session.endedAt?.toISOString() ?? null } })),
    timeline,
    chargeItems: sessions.flatMap(session => session.chargeItems).map(money), adjustments: adjustments.map(money),
  };
}

function createPlayerQueries(input: CreateSqlReadModelsInput): PlayerQueries {
  return {
    getLatestPlayerCheckout: playerId => getPlayerCheckout(input, playerId),
    getPlayerCheckout: (playerId, checkoutId) => getPlayerCheckout(input, playerId, checkoutId),
    async listPlayerCheckouts(playerId, offset) {
      const rows = await input.executor.all<{ id: string; total: number; settled_at: string; started_at: string | null; ended_at: string | null; session_count: number }>(
        `SELECT c.id, c.total, c.settled_at, MIN(s.started_at) AS started_at, MAX(s.ended_at) AS ended_at, COUNT(s.id) AS session_count
         FROM player_checkouts c
         LEFT JOIN settlements st ON st.shop_id = c.shop_id AND st.checkout_id = c.id
         LEFT JOIN sessions s ON s.shop_id = st.shop_id AND s.id = st.session_id AND s.player_id = c.player_id
         WHERE c.shop_id = ${sqlShop(input.executor)} AND c.player_id = ?
         GROUP BY c.id ORDER BY c.settled_at DESC, c.id DESC LIMIT 31 OFFSET ?`, [playerId, offset]);
      return { records: rows.slice(0, 30).map(row => ({ id: row.id, total: yuanOf(centsOfInteger(row.total)), settledAt: row.settled_at, startedAt: row.started_at, endedAt: row.ended_at, sessionCount: row.session_count })), nextOffset: rows.length > 30 ? offset + 30 : null };
    },
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
           EXISTS(SELECT 1 FROM cashier_profiles cp WHERE cp.shop_id = ${sqlShop(input.executor)} AND cp.player_id=p.id) AS cashier,
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
           CASE WHEN json_array_length(s.pricing_config_ids_json) = 1 AND json_extract(s.pricing_config_ids_json, '$[0]') != 'default'
             THEN json_extract(s.pricing_config_ids_json, '$[0]') END AS pricing_config_id,
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

    async listLiveSessions(options) {
      const ids = options?.playerIds;
      if (ids?.length === 0) return [];
      const rows = await input.executor.all<StaffActiveSessionRow & { status: string }>(
        `SELECT
           s.id,
           s.player_id,
           p.display_name AS player_display_name,
           s.started_at,
           s.ended_at,
           s.label,
           CASE WHEN json_array_length(s.pricing_config_ids_json) = 1 AND json_extract(s.pricing_config_ids_json, '$[0]') != 'default'
             THEN json_extract(s.pricing_config_ids_json, '$[0]') END AS pricing_config_id,
           s.status
         FROM (SELECT * FROM sessions WHERE shop_id = ${sqlShop(input.executor)}) s
         INNER JOIN (SELECT * FROM players WHERE shop_id = ${sqlShop(input.executor)}) p ON p.id = s.player_id
         WHERE (s.status = 'active' OR s.payment_status = 'unpaid')
           ${ids ? 'AND s.player_id IN (SELECT value FROM json_each(?))' : ''}
         ORDER BY s.started_at`,
        ids ? [JSON.stringify(ids)] : [],
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
          pricingConfigId: row.pricing_config_id,
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
      const operations = await createDeviceEventRepository(input.executor).listRecentOperations(query.limit);
      return operations.map((operation): StaffDeviceCommandListItem => {
        const command = operationToLegacyCommand(operation);
        return {
          id: command.id,
          type: command.type,
          deviceId: command.deviceId,
          targetKind: command.targetKind,
          executorKind: command.executorKind,
          playerId: command.playerId ?? null,
          staffId: command.staffId ?? null,
          status: command.status,
          requestedAt: command.requestedAt,
          ackedAt: command.ackedAt ?? null,
          expiredAt: command.expiredAt ?? null,
          payload: command.payload ?? null,
        };
      });
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
    listReportCheckouts: (query) => listReportCheckouts(input, query),
    async getReportCheckout(checkoutId) {
      const record = (await listReportCheckouts(input, {
        checkoutId, limit: 1, archive: "all",
      }))[0];
      if (!record) return null;
      const receipt = await getPlayerCheckout(input, record.playerId, checkoutId);
      return receipt ? { record, receipt } : null;
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
         AND NOT EXISTS(SELECT 1 FROM checkout_report_states a WHERE a.shop_id=pc.shop_id AND a.checkout_id=pc.id AND a.archived=1)
     ), asset_summary AS (
       SELECT COUNT(*) AS asset_grant_total
       FROM (SELECT * FROM asset_ledger_entries WHERE shop_id = ${sqlShop(input.executor)}), bounds
       WHERE delta > 0 AND created_at >= bounds.from_at AND created_at < bounds.to_at
     ), coin_summary AS (
       SELECT COUNT(*) AS coin_command_count
       FROM (SELECT * FROM device_operations WHERE shop_id = ${sqlShop(input.executor)}), bounds
       WHERE action = 'coin' AND requested_at >= bounds.from_at AND requested_at < bounds.to_at
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
       st.total,
       payment.method AS payment_method, payment.staff_id AS collected_by
     FROM (SELECT * FROM settlements WHERE shop_id = ${sqlShop(input.executor)}) st
     INNER JOIN (SELECT * FROM sessions WHERE shop_id = ${sqlShop(input.executor)}) s ON s.id = st.session_id
     INNER JOIN (SELECT * FROM players WHERE shop_id = ${sqlShop(input.executor)}) p ON p.id = s.player_id
     LEFT JOIN cashier_payments payment ON payment.shop_id = ${sqlShop(input.executor)} AND payment.checkout_id = st.checkout_id
     WHERE st.settled_at >= ? AND st.settled_at < ?
       AND NOT EXISTS(SELECT 1 FROM checkout_report_states a WHERE a.shop_id=st.shop_id AND a.checkout_id=st.checkout_id AND a.archived=1)
     ORDER BY st.settled_at DESC, st.id DESC
     LIMIT ? OFFSET ?`,
    [query.from.toISOString(), query.to.toISOString(), query.limit, query.offset ?? 0],
  );

  return rows.map((row): StaffReportSettlementListItem => {
    const startedAt = new Date(row.started_at);
    const endedAt = row.ended_at ? new Date(row.ended_at) : null;

    return {
      ...(row.payment_method ? { externalPayment: { method: row.payment_method, staffId: row.collected_by! } } : {}),
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
         AND NOT EXISTS(SELECT 1 FROM checkout_report_states a WHERE a.shop_id=pc.shop_id AND a.checkout_id=pc.id AND a.archived=1)
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
       COALESCE(player_revenue.revenue_total, 0) AS revenue_total,
       player_activity.total_duration_minutes,
       player_activity.last_settled_at
     FROM player_activity
     LEFT JOIN player_revenue ON player_revenue.player_id = player_activity.player_id
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
      delta: assetQuantityFromStored(row.asset_type, row.delta),
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
    quantity: assetQuantityFromStored(row.asset_type!, row.quantity!),
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
        ...(row.cashier ? { paymentMode: "cashier" as const } : {}),
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
        pricingConfigId: row.pricing_config_id,
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
  cashier?: number;
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
  /** Null for the unpriced placeholder session. */
  pricing_config_id: string | null;
};

type StaffActiveSessionWithIdentityRow = StaffActiveSessionRow & {
  identity_provider: string | null;
  identity_subject: string | null;
};

type StaffReportSettlementRow = {
  payment_method: string | null;
  collected_by: string | null;
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

async function listReportCheckouts(
  input: CreateSqlReadModelsInput,
  query: {
    from?: Date;
    to?: Date;
    checkoutId?: string;
    limit: number;
    offset?: number;
    archive?: import("@prism/application").ReportArchiveFilter;
  },
): Promise<import("@prism/application").StaffReportCheckout[]> {
  const shop = sqlShop(input.executor);
  const archive = query.archive ?? "active";
  const rows = await input.executor.all<{
    checkout_id: string;
    player_id: string;
    display_name: string;
    started_at: string | null;
    ended_at: string | null;
    settled_at: string;
    subtotal: number;
    total: number;
    session_count: number;
    duration_minutes: number;
    archived: number;
    updated_at: string | null;
    updated_by: string | null;
    method: string | null;
    staff_id: string | null;
    collected_at: string | null;
  }>(
    `SELECT c.id AS checkout_id,c.player_id,p.display_name,MIN(s.started_at) AS started_at,MAX(s.ended_at) AS ended_at,
      c.settled_at,c.subtotal,c.total,COUNT(s.id) AS session_count,
      COALESCE(SUM(CASE WHEN s.ended_at IS NOT NULL THEN MAX(0,CAST(ROUND((julianday(s.ended_at)-julianday(s.started_at))*86400000)/60000 AS INTEGER)) ELSE 0 END),0) AS duration_minutes,
      COALESCE(a.archived,0) AS archived,a.updated_at,a.updated_by,payment.method,payment.staff_id,payment.collected_at
    FROM player_checkouts c JOIN players p ON p.shop_id=c.shop_id AND p.id=c.player_id
    LEFT JOIN settlements st ON st.shop_id=c.shop_id AND st.checkout_id=c.id
    LEFT JOIN sessions s ON s.shop_id=st.shop_id AND s.id=st.session_id AND s.player_id=c.player_id
    LEFT JOIN checkout_report_states a ON a.shop_id=c.shop_id AND a.checkout_id=c.id
    LEFT JOIN cashier_payments payment ON payment.shop_id=c.shop_id AND payment.checkout_id=c.id
    WHERE c.shop_id=${shop} AND ${query.checkoutId ? "c.id=?" : "c.settled_at>=? AND c.settled_at<?"}
      ${archive === "all" ? "" : `AND COALESCE(a.archived,0)=${archive === "archived" ? 1 : 0}`}
    GROUP BY c.id ORDER BY c.settled_at DESC,c.id DESC LIMIT ? OFFSET ?`,
    [
      ...(query.checkoutId
        ? [query.checkoutId]
        : [query.from!.toISOString(), query.to!.toISOString()]),
      query.limit,
      query.offset ?? 0,
    ],
  );
  return rows.map((row) => ({
    checkoutId: row.checkout_id,
    playerId: row.player_id,
    playerDisplayName: row.display_name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    settledAt: row.settled_at,
    durationMinutes: row.duration_minutes,
    sessionCount: row.session_count,
    subtotal: yuanOf(centsOfInteger(row.subtotal)),
    total: yuanOf(centsOfInteger(row.total)),
    archived: !!row.archived,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    ...(row.method
      ? {
          externalPayment: {
            method: row.method,
            staffId: row.staff_id!,
            collectedAt: row.collected_at!,
          },
        }
      : {}),
  }));
}
