import { buildBillTimeline } from "@prism/application";
import type {
  ChargeItem,
  DeviceCommand,
  DeviceState,
  MachineConnection,
  AssetDefinition,
  ApiToken,
  BusinessItem,
  BusinessItemOrder,
  GrantAssetsResult,
  Player,
  PlayerIdentity,
  PricingConfig,
  PricingEffect,
  Present,
  RedeemCode,
  Session,
  TimeCapPricingWindow,
} from "@prism/core";
import { intOf, yuanOf } from "@prism/core";
import type { StaffUserView } from "./types";
import type {
  PlayerAssets,
  RedeemCommandResult,
  SessionHistoryDetail,
  PlayerSummary,
  PlayerSummaryView,
  SessionHistoryListItem,
  StaffActiveSessionListItem,
  StaffDeviceCommandListItem,
  StaffReportPlayerListItem,
  StaffReportSettlementListItem,
  StaffPricingExtension,
  StaffReportsSummary,
  StaffRedeemCodeRedemptionListItem,
  PlayerRedeemRecordListItem,
  PreviewPlayerCheckoutResult,
  SettlePlayerCheckoutResult,
} from "./types";

export function toPlayerSummaryView(summary: PlayerSummary): PlayerSummaryView {
  return {
    player: summary.player,
    wallet: summary.wallet,
    activeSession: summary.activeSession
      ? {
          id: summary.activeSession.id,
          startedAt: summary.activeSession.startedAt.toISOString(),
        }
      : null,
  };
}

export function toPlayerAssetsView(
  assets: PlayerAssets,
): Record<string, unknown> {
  return {
    holdings: assets.holdings.map((holding) => ({
      ...holding,
      quantity: holding.assetType === "currency" ? yuanOf(holding.quantity) : intOf(holding.quantity),
      activeAt: holding.activeAt?.toISOString() ?? null,
      expiresAt: holding.expiresAt?.toISOString() ?? null,
    })),
    ledgerEntries: assets.ledgerEntries.map((entry) => ({
      ...entry,
      delta: entry.assetType === "currency" ? yuanOf(entry.delta) : intOf(entry.delta),
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}

export function toSessionHistoryView(
  sessions: readonly SessionHistoryListItem[],
): Record<string, unknown> {
  return {
    sessions: sessions.map((session) => ({
      sessionId: session.sessionId,
      startedAt: session.startedAt.toISOString(),
      endedAt: session.endedAt?.toISOString() ?? null,
      durationMinutes: session.durationMinutes,
      subtotal: session.subtotal === null ? null : yuanOf(session.subtotal),
      total: session.total === null ? null : yuanOf(session.total),
      status: session.status,
      settledAt: session.settledAt?.toISOString() ?? null,
    })),
  };
}

export function toPlayerRedeemRecordsView(
  records: readonly PlayerRedeemRecordListItem[],
): Record<string, unknown> {
  return {
    redeemRecords: records.map((record) => ({
      ...record,
      redeemedAt: record.redeemedAt.toISOString(),
    })),
  };
}

export function toSessionHistoryDetailView(
  session: SessionHistoryDetail,
): Record<string, unknown> {
  return {
    session: {
      sessionId: session.sessionId,
      startedAt: session.startedAt.toISOString(),
      endedAt: session.endedAt?.toISOString() ?? null,
      durationMinutes: session.durationMinutes,
      subtotal: session.subtotal === null ? null : yuanOf(session.subtotal),
      total: session.total === null ? null : yuanOf(session.total),
      status: session.status,
      settledAt: session.settledAt?.toISOString() ?? null,
      chargeItems: session.chargeItems,
      adjustments: session.adjustments,
    },
  };
}

export function toSessionView(session: Session & { status: "active" }): {
  id: string;
  playerId: string;
  startedAt: string;
  status: "active";
  label?: string;
} {
  const view = {
    id: session.id,
    playerId: session.playerId,
    startedAt: session.startedAt.toISOString(),
    status: session.status,
  };
  return session.label == null ? view : { ...view, label: session.label };
}

export function toStoppedSessionView(
  session: Session & { status: "closed"; endedAt: Date },
): Record<string, unknown> {
  return {
    session: {
      id: session.id,
      playerId: session.playerId,
      startedAt: session.startedAt.toISOString(),
      endedAt: session.endedAt.toISOString(),
      status: session.status,
      paymentStatus: session.paymentStatus ?? "unpaid",
      label: session.label,
    },
  };
}

export function toDeviceCommandView(
  command: DeviceCommand,
): Record<string, unknown> {
  return {
    id: command.id,
    type: command.type,
    deviceId: command.deviceId,
    target: command.deviceId === null
      ? { kind: command.targetKind, all: true }
      : { kind: command.targetKind, id: command.deviceId },
    executorKind: command.executorKind,
    playerId: command.playerId,
    staffId: command.staffId,
    status: command.status,
    payload: command.payload,
    requestedAt: command.requestedAt.toISOString(),
    ackedAt: command.ackedAt?.toISOString(),
    expiredAt: command.expiredAt?.toISOString(),
  };
}

export function toStaffActiveSessionView(
  session: StaffActiveSessionListItem,
): Record<string, unknown> {
  const view = {
    id: session.id,
    playerId: session.playerId,
    playerDisplayName: session.playerDisplayName,
    startedAt: session.startedAt.toISOString(),
    elapsedMinutes: session.elapsedMinutes,
    label: session.label,
    identities: session.identities ?? [],
  };
  return session.endedAt === undefined ? view : { ...view, endedAt: session.endedAt?.toISOString() ?? null };
}

export function toStaffDeviceCommandView(
  command: StaffDeviceCommandListItem,
): Record<string, unknown> {
  return {
    id: command.id,
    type: command.type,
    deviceId: command.deviceId,
    target: command.deviceId === null
      ? { kind: command.targetKind, all: true }
      : { kind: command.targetKind, id: command.deviceId },
    executorKind: command.executorKind,
    playerId: command.playerId,
    staffId: command.staffId,
    status: command.status,
    requestedAt: command.requestedAt.toISOString(),
    ackedAt: command.ackedAt?.toISOString() ?? null,
    expiredAt: command.expiredAt?.toISOString() ?? null,
    payload: command.payload,
  };
}

export function toDeviceStateView(state: DeviceState): Record<string, unknown> {
  return {
    deviceId: state.deviceId,
    type: state.type,
    targetKind: state.targetKind,
    executorKind: state.executorKind,
    label: state.label,
    status: state.status,
    state: state.state,
    metadata: state.metadata,
    reportedAt: state.reportedAt.toISOString(),
    reportedBy: state.reportedBy,
  };
}

export function toMachineConnectionView(connection: MachineConnection): Record<string, unknown> {
  return {
    machineId: connection.machineId,
    status: connection.status,
    capabilities: connection.capabilities,
    connectedAt: connection.connectedAt.toISOString(),
    lastSeenAt: connection.lastSeenAt.toISOString(),
    disconnectedAt: connection.disconnectedAt?.toISOString() ?? null,
  };
}

export function toStaffReportsSummaryView(
  summary: StaffReportsSummary,
): Record<string, unknown> {
  return {
    summary: {
      from: summary.from.toISOString(),
      to: summary.to.toISOString(),
      revenueTotal: summary.revenueTotal,
      sessionCount: summary.sessionCount,
      assetGrantTotal: summary.assetGrantTotal,
      coinCommandCount: summary.coinCommandCount,
    },
  };
}

export function toStaffReportSettlementView(
  settlement: StaffReportSettlementListItem,
): Record<string, unknown> {
  return {
    settlementId: settlement.settlementId,
    sessionId: settlement.sessionId,
    playerId: settlement.playerId,
    playerDisplayName: settlement.playerDisplayName,
    startedAt: settlement.startedAt.toISOString(),
    endedAt: settlement.endedAt?.toISOString() ?? null,
    settledAt: settlement.settledAt.toISOString(),
    durationMinutes: settlement.durationMinutes,
    subtotal: yuanOf(settlement.subtotal),
    total: yuanOf(settlement.total),
  };
}

export function toStaffReportPlayerView(
  player: StaffReportPlayerListItem,
): Record<string, unknown> {
  return {
    playerId: player.playerId,
    playerDisplayName: player.playerDisplayName,
    settlementCount: player.settlementCount,
    totalDurationMinutes: player.totalDurationMinutes,
    revenueTotal: player.revenueTotal,
    lastSettledAt: player.lastSettledAt.toISOString(),
  };
}

export function toPlayerCheckoutPreviewView(
  result: PreviewPlayerCheckoutResult,
): Record<string, unknown> {
  return {
    timeline: buildBillTimeline({ at: result.settlementPreview.previewedAt, sessions: result.sessionPreviews, adjustments: result.adjustments, globalCapWindows: result.globalCapWindows }),
    settlementPreview: {
      ...result.settlementPreview,
      previewedAt: result.settlementPreview.previewedAt.toISOString(),
    },
    sessionPreviews: result.sessionPreviews.map((preview) => ({
      sessionId: preview.sessionId,
      label: preview.label,
      startedAt: preview.startedAt.toISOString(),
      endedAt: preview.endedAt?.toISOString() ?? null,
      status: preview.status,
      subtotal: preview.subtotal,
      total: preview.total,
      chargeItems: preview.chargeItems.map(toChargeItemView),
      adjustments: preview.adjustments,
    })),
    chargeItems: result.chargeItems.map(toChargeItemView),
    adjustments: result.adjustments,
    checkoutAdjustments: result.checkoutAdjustments,
    pricingCapAdjustments: result.pricingCapAdjustments,
    wallet: result.wallet,
    globalCapWindows: result.globalCapWindows.map(toGlobalCapWindowView),
  };
}

export function toPlayerCheckoutResultView(
  result: SettlePlayerCheckoutResult,
): Record<string, unknown> {
  const detailsBySessionId = new Map(result.sessionDetails.map((detail) => [detail.sessionId, detail]));
  return {
    playerSettlement: {
      ...result.playerSettlement,
      settledAt: result.playerSettlement.settledAt.toISOString(),
    },
    settlements: result.settlements.map((record) => {
      const detail = detailsBySessionId.get(record.settlement.sessionId);
      return ({
      settlement: {
        ...record.settlement,
        settledAt: record.settlement.settledAt.toISOString(),
        ...(detail ? {
          label: detail.label,
          startedAt: detail.startedAt.toISOString(),
          endedAt: detail.endedAt?.toISOString() ?? null,
        } : {}),
      },
      chargeItems: record.chargeItems.map(toChargeItemView),
      adjustments: record.adjustments,
      });
    }),
    chargeItems: result.chargeItems.map(toChargeItemView),
    adjustments: result.adjustments,
    checkoutAdjustments: result.checkoutAdjustments,
    pricingCapAdjustments: result.pricingCapAdjustments,
    globalCapWindows: result.globalCapWindows.map(toGlobalCapWindowView),
    assetLedgerEntries: result.assetLedgerEntries,
    wallet: result.wallet,
  };
}

function toGlobalCapWindowView(window: TimeCapPricingWindow): Record<string, unknown> {
  return {
    ...window,
    windowStartedAt: window.windowStartedAt.toISOString(),
    windowEndedAt: window.windowEndedAt.toISOString(),
  };
}

function toChargeItemView(item: ChargeItem): Record<string, unknown> {
  return {
    id: item.id,
    source: item.source,
    label: item.label,
    amount: item.amount,
    period: item.period,
    pricingExplanation: item.pricingExplanation,
  };
}

export function toRedeemGiftView(
  result: RedeemCommandResult,
): Record<string, unknown> {
  return {
    redeemRecord: {
      ...result.redeemRecord,
      redeemedAt: result.redeemRecord.redeemedAt.toISOString(),
    },
    grantedAssets: result.grantedAssets,
    currentHoldings: result.availableHoldings,
    assetLedgerEntries: result.assetLedgerEntries,
  };
}

export function toGrantAssetsView(
  result: GrantAssetsResult,
): Record<string, unknown> {
  return {
    holdings: result.holdings.map((holding) => ({
      ...holding,
      activeAt: holding.activeAt?.toISOString() ?? null,
      expiresAt: holding.expiresAt?.toISOString() ?? null,
    })),
    assetLedgerEntries: result.assetLedgerEntries,
  };
}

export function toAssetDefinitionManagementView(
  definition: AssetDefinition,
): Record<string, unknown> {
  return {
    type: definition.type,
    code: definition.code,
    name: definition.name,
    stackable: definition.stackable,
    status: definition.status ?? "active",
    pricingEffectId: definition.pricingEffectId ?? null,
    pricingEffect: definition.pricingEffect
      ? toPricingEffectManagementView(definition.pricingEffect)
      : null,
    activeAt: definition.activeAt?.toISOString() ?? null,
    expiresAt: definition.expiresAt?.toISOString() ?? null,
    metadata: definition.metadata,
  };
}

export function toPricingEffectManagementView(
  effect: PricingEffect,
): Record<string, unknown> {
  return {
    id: effect.id,
    name: effect.name,
    type: effect.type,
    scope: effect.scope,
    value: effect.value,
    consumable: effect.consumable,
    limitPerDay: effect.limitPerDay,
    activeAt: effect.activeAt?.toISOString() ?? null,
    expiresAt: effect.expiresAt?.toISOString() ?? null,
    status: effect.status ?? "active",
    config: effect.config,
  };
}

export function toPlayerManagementView(
  player: Player,
): Record<string, unknown> {
  return {
    id: player.id,
    displayName: player.displayName,
    status: player.status,
    createdAt: player.createdAt.toISOString(),
  };
}

export function toPlayerIdentityView(
  identity: PlayerIdentity,
): Record<string, unknown> {
  return {
    playerId: identity.playerId,
    provider: identity.provider,
    subject: identity.subject,
    createdAt: identity.createdAt.toISOString(),
  };
}

export function toPresentManagementView(
  present: Present,
): Record<string, unknown> {
  return {
    id: present.id,
    name: present.name,
    oncePerPlayer: present.oncePerPlayer,
    activeAt: present.activeAt?.toISOString() ?? null,
    expiresAt: present.expiresAt?.toISOString() ?? null,
    status: present.status ?? "active",
    grants: present.grants.map((grant) => ({
      ...grant,
      activeAt: grant.activeAt?.toISOString() ?? null,
      expiresAt: grant.expiresAt?.toISOString() ?? null,
    })),
  };
}

export function toRedeemCodeManagementView(
  code: RedeemCode,
  redemptions: readonly StaffRedeemCodeRedemptionListItem[] = [],
): Record<string, unknown> {
  const view: Record<string, unknown> = {
    id: code.id,
    code: code.code,
    presentId: code.presentId,
    activeAt: code.activeAt?.toISOString() ?? null,
    expiresAt: code.expiresAt?.toISOString() ?? null,
    maxUseCount: code.maxUseCount,
    usageCount: code.usageCount ?? 0,
  };
  if (redemptions.length > 0) {
    view.redemptions = redemptions.map((redemption) => ({
      playerId: redemption.playerId,
      playerDisplayName: redemption.playerDisplayName,
      redeemedAt: redemption.redeemedAt.toISOString(),
    }));
  }
  return view;
}

export function toPricingConfigManagementView(
  config: PricingConfig,
): Record<string, unknown> {
  const provider =
    config.kind === "time.priority" || config.kind === "time.cap"
      ? {
          ...config.provider,
          rules: config.provider.rules.map((rule) => {
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
        }
      : config.provider;

  return {
    id: config.id,
    kind: config.kind,
    name: config.name,
    enabled: config.enabled,
    status: config.status ?? "active",
    provider,
    createdAt: config.createdAt.toISOString(),
    updatedAt: config.updatedAt.toISOString(),
  };
}

export function toBusinessItemManagementView(
  item: BusinessItem,
): Record<string, unknown> {
  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    status: item.status,
    price: item.price,
    assetType: item.assetType,
    assetCode: item.assetCode,
    activeAt: item.activeAt?.toISOString() ?? null,
    expiresAt: item.expiresAt?.toISOString() ?? null,
    metadata: item.metadata,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

export function toBusinessItemOrderView(
  order: BusinessItemOrder,
): Record<string, unknown> {
  return {
    id: order.id,
    businessItemId: order.businessItemId,
    businessItemKind: order.businessItemKind,
    businessItemName: order.businessItemName,
    playerId: order.playerId,
    sessionId: order.sessionId,
    status: order.status,
    price: order.price,
    assetType: order.assetType,
    assetCode: order.assetCode,
    metadata: order.metadata,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    fulfilledAt: order.fulfilledAt?.toISOString() ?? null,
    cancelledAt: order.cancelledAt?.toISOString() ?? null,
  };
}

export function toStaffPricingExtensionView(
  extension: StaffPricingExtension,
): Record<string, unknown> {
  const view: Record<string, unknown> = {
    id: extension.id,
    name: extension.name,
    kind: extension.kind,
    summary: extension.summary,
    status: extension.status,
    configuredBy: extension.configuredBy,
    capabilities: [...extension.capabilities],
  };
  if (extension.configurationStatus) {
    view.configurationStatus = extension.configurationStatus;
  }
  if (extension.requiredAssets) {
    view.requiredAssets = extension.requiredAssets.map((asset) => ({
      type: asset.type,
      code: asset.code,
      name: asset.name,
      status: asset.status ?? "missing",
    }));
  }
  return view;
}

export function toApiTokenManagementView(
  token: Omit<ApiToken, "tokenHash">,
): Record<string, unknown> {
  return {
    id: token.id,
    label: token.label,
    role: token.role,
    tokenPrefix: token.tokenPrefix,
    status: token.status,
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    revokedAt: token.revokedAt?.toISOString() ?? null,
  };
}

export function toStaffUserManagementView(
  user: StaffUserView,
): Record<string, unknown> {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
