import { buildBillTimeline } from "./bill-timeline";
import { settleSessionsWithCaps } from "./session-billing";
import type {
  BillTimeline,
  CheckoutCommit,
  AssetDefinitionRepository,
  AssetDefinition,
  AssetEffectProvider,
  AssetHolding,
  AssetLedgerEntry,
  AssetRepository,
  ChargeItem,
  DeviceOperation,
  PricingCapHistoryEntry,
  PricingCapHistoryRepository,
  PricingHistoryEntry,
  PricingHistoryRepository,
  PreviewSessionSettlementResult,
  PricingProvider,
  PlayerCheckout,
  PlayerRepository,
  SettlementAdjustment,
  SettlementRecord,
  SettlementRepository,
  SettleSessionResult,
  Session,
  SessionRepository,
  OperationLockRepository,
  SystemRepository,
  TimeCapPricingWindow,
  TimeCapPricingProviderConfig,
} from "@prism/core";
import {
  operatedWithin,
  addCents,
  assetQuantityFromStored,
  allocate,
  closeSession,
  collectTimeCapPricingHistoryLookupKeys,
  settleTimeCaps,
  type Cents,
  centsOf,
  compareCents,
  assetQuantityOf,
  isPositiveCents,
  maxCents,
  minCents,
  negCents,
  subCents,
  deductCurrency,
  diffAssetHoldings,
  grantAssets,
  isActiveInWindow,
  previewSessionSettlement,
  PrismDomainError,
  settleSession,
  sumCurrencyHoldings,
  sumCents,
  ZERO_CENTS,
} from "@prism/core";
import { PLAYER_BILLING_LOCK_SCOPE, withOperationLease } from "./operation-lock";
import { sumAvailableWalletBalance, type AvailableAssetReader } from "./available-assets";
import {
  assetDefinitionEffectSource,
  calculateAssetEffectDiscount,
  calendarDayAt,
  isAssetEffectConfigAvailable,
  resolveAssetDefinitionEffectConfig,
} from "./asset-definition-effects";

export type SettlementServiceDependencies = {
  players?: PlayerRepository;
  commitCheckout?: (input: CheckoutCommit) => Promise<void>;
  sessions: SessionRepository;
  operationLocks?: OperationLockRepository;
  assets: AssetRepository;
  settlements: SettlementRepository;
  assetDefinitions?: AssetDefinitionRepository;
  availableAssets?: AvailableAssetReader;
  system?: SystemRepository;
  pricingHistory?: PricingHistoryRepository;
  pricingCapHistory?: PricingCapHistoryRepository;
  /** A player's device operations; billing treats a non-failed play as device use. */
  deviceOperations?: { listOperationsByPlayer(playerId: string): Promise<DeviceOperation[]> };
  pricingProviders: readonly PricingProvider[];
  pricingProviderResolver?: (context: PricingProviderResolverContext) => Promise<readonly PricingProvider[]>;
  globalCapResolver?: (context: GlobalCapResolverContext) => Promise<readonly TimeCapPricingProviderConfig[]>;
  assetEffectProviders: readonly AssetEffectProvider[];
  id?: () => string;
  now: () => Date;
};

export type PricingProviderResolverContext = {
  playerId: string;
  session: Session;
  now: Date;
};

export type GlobalCapResolverContext = {
  playerId: string;
  sessions: readonly Session[];
  chargeItems: readonly ChargeItem[];
  now: Date;
  timeZone: string;
};

export type PlayerCheckoutInput = {
  playerId: string;
  closeSessionsBeforeBalanceCheck?: boolean;
};

export type StaffCheckoutOverrideInput = {
  playerId: string;
  staffId: string;
  total: number;
  reason: string;
  closeSessionsBeforeBalanceCheck?: boolean;
};

export type StaffRechargeCheckoutInput = {
  playerId: string;
  staffId: string;
  amount: number;
};

export type CheckoutWallet = {
  balanceBefore: Cents;
  balanceAfter: Cents;
};

export type PreviewPlayerCheckoutResult = {
  settlementPreview: {
    playerId: string;
    sessionIds: string[];
    subtotal: Cents;
    total: Cents;
    status: "preview";
    previewedAt: Date;
  };
  sessionPreviews: Array<{
    sessionId: string;
    label: string | null;
    startedAt: Date;
    endedAt: Date | null;
    status: Session["status"];
    subtotal: Cents;
    total: Cents;
    chargeItems: ChargeItem[];
    adjustments: SettlementAdjustment[];
  }>;
  chargeItems: ChargeItem[];
  adjustments: SettlementAdjustment[];
  checkoutAdjustments: SettlementAdjustment[];
  pricingCapAdjustments: SettlementAdjustment[];
  wallet: CheckoutWallet;
  globalCapWindows: TimeCapPricingWindow[];
};

export type SettlePlayerCheckoutResult = {
  playerSettlement: {
    playerId: string;
    sessionIds: string[];
    subtotal: Cents;
    total: Cents;
    status: "settled";
    settledAt: Date;
  };
  settlements: SettlementRecord[];
  sessionDetails: Array<{
    sessionId: string;
    label: string | null;
    startedAt: Date;
    endedAt: Date | null;
  }>;
  chargeItems: ChargeItem[];
  adjustments: SettlementAdjustment[];
  checkoutAdjustments: SettlementAdjustment[];
  pricingCapAdjustments: SettlementAdjustment[];
  assetLedgerEntries: AssetLedgerEntry[];
  wallet: CheckoutWallet;
  globalCapWindows: TimeCapPricingWindow[];
  /** The bill as it was persisted with the checkout; receipts read this same timeline back. */
  timeline: BillTimeline;
};

export type ExternalCheckoutInput = {
  playerId: string; staffId: string; method: "wechat" | "alipay" | "cash" | "other";
  previewedAt: Date; expectedTotal: number; sessionIds: string[];
};

export type SettlementService = {
  checkoutExternal(input: ExternalCheckoutInput): Promise<SettlePlayerCheckoutResult>;
  previewCheckout(input: PlayerCheckoutInput): Promise<PreviewPlayerCheckoutResult>;
  checkout(input: PlayerCheckoutInput): Promise<SettlePlayerCheckoutResult>;
  stopSession(input: { playerId: string; sessionId: string }): Promise<Session & { status: "closed"; endedAt: Date }>;
  checkoutWithOverride(input: StaffCheckoutOverrideInput): Promise<SettlePlayerCheckoutResult>;
  checkoutWithRecharge(input: StaffRechargeCheckoutInput): Promise<SettlePlayerCheckoutResult>;
};

const playerLocks = new Map<string, Promise<any>>();

async function acquireCheckoutLock<T>(dependencies: SettlementServiceDependencies, playerId: string, fn: () => Promise<T>): Promise<T> {
  if (!dependencies.operationLocks) return acquireLock(playerId, fn);
  return withOperationLease({ repository: dependencies.operationLocks, scope: PLAYER_BILLING_LOCK_SCOPE, resourceId: playerId, id: dependencies.id, now: dependencies.now }, fn);
}

async function acquireLock<T>(playerId: string, fn: () => Promise<T>): Promise<T> {
  const previous = playerLocks.get(playerId) ?? Promise.resolve();
  const next = (async () => {
    try {
      await previous;
    } catch {}
    return fn();
  })();
  playerLocks.set(playerId, next);
  const release = () => {
    if (playerLocks.get(playerId) === next) {
      playerLocks.delete(playerId);
    }
  };
  void next.then(release, release);
  return next;
}

export function createSettlementService(dependencies: SettlementServiceDependencies): SettlementService {
  return {
    async previewCheckout(input) {
      const now = dependencies.now();
      const [activeSessions, unpaidClosedSessions, assetHoldings] = await Promise.all([
        dependencies.sessions.findActiveByPlayerId(input.playerId),
        dependencies.sessions.findUnpaidClosedByPlayerId(input.playerId),
        dependencies.assets.listAssetHoldings(input.playerId),
      ]);
      const closedSessions = sessionsForUnifiedCheckout(unpaidClosedSessions, activeSessions);
      const details = await calculateUnifiedCheckoutDetails(dependencies, input.playerId, closedSessions, assetHoldings, now);
      return toPlayerCheckoutPreview(input.playerId, details, now);
    },

    async checkout(input) {
      return acquireCheckoutLock(dependencies, input.playerId, async () => {
        await assertWalletPlayer(dependencies, input.playerId);
        const now = dependencies.now();
        const [activeSessions, unpaidClosedSessions, assetHoldings] = await Promise.all([
          dependencies.sessions.findActiveByPlayerId(input.playerId),
          dependencies.sessions.findUnpaidClosedByPlayerId(input.playerId),
          dependencies.assets.listAssetHoldings(input.playerId),
        ]);
        const closedActiveSessions = activeSessions.map((session) => closeSession({ session, now }));
        const closedSessions = uniqueSessionsById([
          ...unpaidClosedSessions.map((session) => ({
            ...session,
            status: "closed" as const,
            endedAt: session.endedAt ?? now,
            paymentStatus: session.paymentStatus ?? "unpaid",
          })),
          ...closedActiveSessions,
        ]);
        const details = await calculateUnifiedCheckoutDetails(dependencies, input.playerId, closedSessions, assetHoldings, now);
        if (input.closeSessionsBeforeBalanceCheck === false) assertCheckoutBalance(details.availableHoldings, details.total, now);
        for (const session of closedActiveSessions) session.paymentStatus = "unpaid";
        if (input.closeSessionsBeforeBalanceCheck !== false) await saveSessions(dependencies.sessions, closedActiveSessions);
        return persistUnifiedPlayerCheckout(dependencies, input.playerId, details, now);
      });
    },

    async checkoutExternal(input) {
      return acquireCheckoutLock(dependencies, input.playerId, async () => {
        const player = await dependencies.players?.findById(input.playerId);
        if (player?.paymentMode !== "cashier" || player.status !== "active")
          throw new PrismDomainError("仅前台卡片档案可现场收款", "CASHIER_PROFILE_REQUIRED");
        const now = dependencies.now();
        const at = input.previewedAt;
        if (!Number.isFinite(at.getTime()) || at > now || now.getTime() - at.getTime() > 600_000)
          throw new PrismDomainError("账单已过期，请重新预览", "CASHIER_PREVIEW_EXPIRED");
        const [active, unpaid, holdings] = await Promise.all([
          dependencies.sessions.findActiveByPlayerId(input.playerId),
          dependencies.sessions.findUnpaidClosedByPlayerId(input.playerId),
          dependencies.assets.listAssetHoldings(input.playerId),
        ]);
        if (holdings.length) throw new PrismDomainError("前台卡片档案不能保存资产", "CASHIER_PROFILE_RESTRICTED");
        const sessions = uniqueSessionsById([...unpaid, ...active.map(session => closeSession({ session, now: at }))]);
        const ids = sessions.map(session => session.id).sort();
        if (sessions.some(session => session.startedAt > at || (session.endedAt && session.endedAt > at)) ||
            JSON.stringify(ids) !== JSON.stringify([...input.sessionIds].sort()))
          throw new PrismDomainError("计时已变化，请重新预览账单", "CASHIER_PREVIEW_CHANGED");
        const details = await calculateUnifiedCheckoutDetails(dependencies, input.playerId, sessions, [], at);
        if (details.total !== centsOf(input.expectedTotal))
          throw new PrismDomainError("金额已变化，请重新预览账单", "CASHIER_PREVIEW_CHANGED");
        return persistUnifiedPlayerCheckout(dependencies, input.playerId, details, now, undefined,
          { staffId: input.staffId, method: input.method, collectedAt: now });
      });
    },

    async stopSession(input) {
      return acquireCheckoutLock(dependencies, input.playerId, async () => {
        const now = dependencies.now();
        const session = await findSessionOrThrow(dependencies.sessions, input.playerId, input.sessionId);
        const closedSession = closeSession({ session, now });
        closedSession.paymentStatus = "unpaid";
        await dependencies.sessions.save(closedSession);
        return closedSession;
      });
    },


    async checkoutWithRecharge(input) {
      // Validate the requested recharge before acquiring the player-wide asset lock.
      const cents = Math.round(input.amount * 100);
      if (!Number.isFinite(input.amount) || input.amount <= 0 ||
          !Number.isSafeInteger(cents) || cents / 100 !== input.amount) {
        throw new PrismDomainError("Recharge amount must be positive with at most two decimal places.", "INVALID_CHECKOUT_RECHARGE_AMOUNT");
      }
      return acquireCheckoutLock(dependencies, input.playerId, async () => {
        await assertWalletPlayer(dependencies, input.playerId);
        // A two-operation top-up followed by checkout can leave money behind if
        // checkout fails. Require the atomic checkout writer for this flow.
        if (!dependencies.commitCheckout || !dependencies.assetDefinitions) {
          throw new PrismDomainError("Atomic recharge checkout is not configured.", "RECHARGE_CHECKOUT_NOT_CONFIGURED");
        }
        const now = dependencies.now();
        const paid = await dependencies.assetDefinitions.findByCode("currency", "paid");
        if (!paid || paid.status === "archived" || !isActiveInWindow(paid, now)) {
          throw new PrismDomainError("Recharge balance asset is unavailable.", "RECHARGE_ASSET_UNAVAILABLE");
        }
        const [active, unpaid, originalHoldings] = await Promise.all([
          dependencies.sessions.findActiveByPlayerId(input.playerId),
          dependencies.sessions.findUnpaidClosedByPlayerId(input.playerId),
          dependencies.assets.listAssetHoldings(input.playerId),
        ]);
        const sessions = uniqueSessionsById([
          ...unpaid.map(session => ({
            ...session, status: "closed" as const,
            endedAt: session.endedAt ?? now,
            paymentStatus: session.paymentStatus ?? "unpaid",
          })),
          ...active.map(session => ({ ...closeSession({ session, now }), paymentStatus: "unpaid" as const })),
        ]);
        // The grant is only in memory until commitCheckout performs the whole
        // checkout (grant + debit + session close + settlement) in one transaction.
        const recharged = grantAssets({
          playerId: input.playerId,
          existingHoldings: originalHoldings,
          grants: [{
            assetType: "currency",
            assetCode: "paid",
            amount: input.amount,
            mergeStrategy: "stack",
            activeAt: null,
            expiresAt: null,
            reason: "staff.checkout.recharge",
            refId: input.staffId,
          }],
          idFactory: dependencies.id ?? (() => crypto.randomUUID()),
          now,
        });
        const details = await calculateUnifiedCheckoutDetails(
          dependencies, input.playerId, sessions, recharged.holdings, now,
        );
        // Re-evaluate pricing at checkout time under the same player lock.
        // Insufficient funds must fail before any asset/session write.
        if (compareCents(details.walletBalanceBefore, details.total) < 0) {
          throw new PrismDomainError("充值后的可用余额不足以支付当前账单。", "INSUFFICIENT_RECHARGE_BALANCE");
        }
        assertCheckoutBalance(details.availableHoldings, details.total, now);
        details.originalHoldings = originalHoldings;
        return persistUnifiedPlayerCheckout(dependencies, input.playerId, details, now, undefined, undefined, {
          staffId: input.staffId,
          amount: centsOf(input.amount),
          ledgerEntries: recharged.assetLedgerEntries,
        });
      });
    },

    async checkoutWithOverride(input) {
      if (!Number.isFinite(input.total) || input.total < 0)
        throw new PrismDomainError("Override total must be finite and nonnegative.", "INVALID_OVERRIDE_TOTAL");
      return acquireCheckoutLock(dependencies, input.playerId, async () => {
        await assertWalletPlayer(dependencies, input.playerId);
        const now = dependencies.now();
        const [activeSessions, unpaidClosedSessions, assetHoldings] = await Promise.all([
          dependencies.sessions.findActiveByPlayerId(input.playerId),
          dependencies.sessions.findUnpaidClosedByPlayerId(input.playerId),
          dependencies.assets.listAssetHoldings(input.playerId),
        ]);
        const closedActiveSessions = activeSessions.map((session) => closeSession({ session, now }));
        const closedSessions = uniqueSessionsById([
          ...unpaidClosedSessions.map((session) => ({
            ...session,
            status: "closed" as const,
            endedAt: session.endedAt ?? now,
            paymentStatus: session.paymentStatus ?? "unpaid",
          })),
          ...closedActiveSessions,
        ]);
        const details = await calculateUnifiedCheckoutDetails(dependencies, input.playerId, closedSessions, assetHoldings, now);
        if (input.closeSessionsBeforeBalanceCheck === false) assertCheckoutBalance(details.availableHoldings, centsOf(input.total), now);
        for (const session of closedActiveSessions) session.paymentStatus = "unpaid";
        if (input.closeSessionsBeforeBalanceCheck !== false) await saveSessions(dependencies.sessions, closedActiveSessions);
        return persistUnifiedPlayerCheckout(dependencies, input.playerId, details, now, {
          total: input.total,
          id: "staff.override",
          source: `staff.override:${input.staffId}`,
          label: `Staff override: ${input.reason}`,
        });
      });
    },
  };
}

async function assertWalletPlayer(dependencies: SettlementServiceDependencies, playerId: string): Promise<void> {
  if ((await dependencies.players?.findById(playerId))?.paymentMode === "cashier")
    throw new PrismDomainError("请在前台确认现场收款", "CASHIER_PAYMENT_REQUIRED");
}

function assertCheckoutBalance(holdings: readonly AssetHolding[], amount: Cents, now: Date): void {
  deductCurrency(holdings.map((holding) => ({ ...holding })), {
    amount,
    reason: "checkout.balance-check",
    refId: "preflight",
    now,
  });
}

async function calculateUnifiedCheckoutDetails(
  dependencies: SettlementServiceDependencies,
  playerId: string,
  closedSessions: readonly Session[],
  assetHoldings: readonly AssetHolding[],
  now: Date,
) {
  if (closedSessions.length === 0) {
    throw new PrismDomainError("Player has no sessions to settle.", "PLAYER_HAS_NO_UNSETTLED_SESSIONS");
  }

  const timeZone = "UTC";

  const pastAppliedAdjustments = dependencies.settlements.listPastAppliedAdjustmentsByPlayerId
    ? await dependencies.settlements.listPastAppliedAdjustmentsByPlayerId(playerId)
    : [];

  const orderedSessions = uniqueSessionsById(closedSessions).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const anchorSession = [...orderedSessions].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
  let currentHoldings = assetHoldings.map((h) => ({ ...h }));
  const resolvedAvailableAssets = dependencies.availableAssets
    ? await dependencies.availableAssets.resolveAvailableHoldings(currentHoldings, {
        at: now,
        includeHidden: true,
      })
    : null;
  const definitionsForSettlement = resolvedAvailableAssets
    ? resolvedAvailableAssets.map((asset) => asset.definition)
    : dependencies.assetDefinitions
      ? await dependencies.assetDefinitions.listAll()
      : [];
  const availableDefinitions = new Map(
    definitionsForSettlement.map((definition) => [
      `${definition.type}\u0000${definition.code}`,
      definition,
    ]),
  );
  const availableHoldings = resolvedAvailableAssets
    ? resolvedAvailableAssets.map((asset) => asset.holding)
    : currentHoldings.filter((holding) => holding.quantity > 0 && isActiveInWindow(holding, now));
  const walletBalanceBefore = resolvedAvailableAssets
    ? sumAvailableWalletBalance(resolvedAvailableAssets)
    : sumCurrencyHoldings(availableHoldings);
  let totalAmount = ZERO_CENTS;
  let overallSubtotal = ZERO_CENTS;
  const accumulatedAdjustments = [...pastAppliedAdjustments];
  const sessionResults: Array<{
    session: Session;
    chargeItems: ChargeItem[];
    adjustments: SettlementAdjustment[];
    extraLedgerEntries: AssetLedgerEntry[];
  }> = [];

  const playerOperations = dependencies.deviceOperations
    ? await dependencies.deviceOperations.listOperationsByPlayer(playerId)
    : [];

  for (const session of orderedSessions) {
    const hasDeviceActivity = Boolean(
      session.metadata?.deviceOperated ||
      operatedWithin(playerOperations, session.playerId, session.startedAt, session.endedAt ?? now),
    );
    if (hasDeviceActivity) {
      session.metadata = {
        ...(session.metadata ?? {}),
        deviceOperated: true,
      };
    }

    const pricingProviders = await resolvePricingProviders(dependencies, {
      playerId,
      session,
      now,
    });
    const preview = await previewSessionSettlement({
      session,
      pricingProviders,
      assetEffectProviders: dependencies.assetEffectProviders,
      assetHoldings: availableHoldings,
      now,
      timeZone,
      pastAppliedAdjustments: accumulatedAdjustments,
    });

    const sessionRawSubtotal = sumCents(preview.chargeItems.map((item) => item.amount));
    const sessionRawTotal = addCents(
      sessionRawSubtotal,
      sumCents(preview.adjustments.map((adj) => adj.amount)),
    );
    overallSubtotal = addCents(overallSubtotal, sessionRawSubtotal);
    totalAmount = addCents(totalAmount, sessionRawTotal);

    const extraLedgerEntries: AssetLedgerEntry[] = [];
    for (const adj of preview.adjustments) {
      const match = adj.id.match(/:asset-definition:([^:]+):([^:]+)(?::([^:]+))?:/);
      if (match && dependencies.assetDefinitions) {
        const assetType = match[1];
        const assetCode = match[2];
        const holdingKey = match[3];
        const definition = availableDefinitions.get(`${assetType}\u0000${assetCode}`);
        const effectiveAt = definition && isActiveInWindow(definition, session.startedAt)
          ? session.startedAt
          : definition && isActiveInWindow(definition, now)
            ? now
            : null;
        if (definition && definition.status !== "archived" && effectiveAt) {
          const effectConfig = resolveAssetDefinitionEffectConfig(definition, effectiveAt);
          const consumable = effectConfig?.consumable === true;
          if (consumable) {
            const holding = availableHoldings.find(
              (h) => (holdingKey ? h.id === holdingKey : h.assetType === assetType && h.assetCode === assetCode) && h.quantity > 0,
            ) ?? availableHoldings.find(
              (h) => h.assetType === assetType && h.assetCode === assetCode && h.quantity > 0,
            );
            if (holding) {
              const consumed = assetQuantityOf(holding.assetType, 1);
              holding.quantity = assetQuantityFromStored(holding.assetType, holding.quantity - consumed);
              extraLedgerEntries.push({
                assetType,
                assetCode,
                delta: assetQuantityFromStored(holding.assetType, -consumed),
                reason: "session.settlement.coupon",
                refId: session.id,
              });
            }
          }
        }
      }
    }

    for (const adj of preview.adjustments) {
      accumulatedAdjustments.push({
        source: adj.source,
        sessionStartedAt: session.startedAt,
      });
    }

    sessionResults.push({
      session,
      chargeItems: preview.chargeItems,
      adjustments: preview.adjustments,
      extraLedgerEntries,
    });
  }

  const unifiedAdjustments: SettlementAdjustment[] = [];
  const globalCapAdjustments: SettlementAdjustment[] = [];
  const globalCapWindows: TimeCapPricingWindow[] = [];
  const unifiedLedgerEntries: AssetLedgerEntry[] = [];

  const chargeItemsBeforeUnifiedEffects = sessionResults.flatMap((result) => result.chargeItems);
  const chargeItemsForGlobalCaps = sessionResults.flatMap((result) =>
    result.chargeItems.map((item) => item.sessionId ? item : { ...item, sessionId: result.session.id }),
  );
  const globalCapConfigs = dependencies.globalCapResolver
    ? await dependencies.globalCapResolver({
        playerId,
        sessions: orderedSessions,
        chargeItems: chargeItemsBeforeUnifiedEffects,
        now,
        timeZone,
      })
    : [];
  const globalCapHistoryKeys = globalCapConfigs.flatMap((config) =>
    collectTimeCapPricingHistoryLookupKeys({ config, chargeItems: chargeItemsForGlobalCaps }));
  const globalCapPaidHistory = dependencies.pricingCapHistory
    ? await dependencies.pricingCapHistory.sumByPlayerAndKeys(playerId, globalCapHistoryKeys)
    : {};
  // Every cap across plans limits the same charges together: one settlement, the
  // same one the simulator uses.
  const capSettlement = settleSessionsWithCaps({
    sessions: sessionResults.map((result) => ({ sessionId: result.session.id, chargeItems: result.chargeItems })),
    caps: globalCapConfigs,
    paidHistory: globalCapPaidHistory,
  });
  globalCapWindows.push(...capSettlement.windows);
  const chargedByItem = capSettlement.chargedByItem;
  for (const adjustment of capSettlement.adjustments) {
    globalCapAdjustments.push(adjustment);
    unifiedAdjustments.push(adjustment);
    totalAmount = addCents(totalAmount, adjustment.amount);
  }

  if (dependencies.assetDefinitions) {
    const unifiedHoldings = availableHoldings.filter((h) => h.quantity > 0);
    for (let holdingIndex = 0; holdingIndex < unifiedHoldings.length; holdingIndex++) {
      const holding = unifiedHoldings[holdingIndex];
      if (holding.quantity <= 0 || !isPositiveCents(totalAmount)) break;

      const definition = availableDefinitions.get(`${holding.assetType}\u0000${holding.assetCode}`);
      const effectiveAt = definition && isActiveInWindow(definition, anchorSession.startedAt)
        ? anchorSession.startedAt
        : definition && isActiveInWindow(definition, now)
          ? now
          : null;
      if (!definition || definition.status === "archived" || !effectiveAt) continue;

      const effectConfig = resolveAssetDefinitionEffectConfig(definition, effectiveAt);
      if (!effectConfig || effectConfig.scope !== "unified") continue;
      if (!isAssetEffectConfigAvailable(effectConfig, effectiveAt, timeZone)) continue;
      if (effectConfig.minSubtotal && compareCents(totalAmount, centsOf(effectConfig.minSubtotal)) < 0) continue;

      if (effectConfig.limitPerDay) {
        const todayStr = calendarDayAt(effectiveAt, timeZone);
        const assetSource = assetDefinitionEffectSource(holding.assetType, holding.assetCode);
        const usesToday = accumulatedAdjustments
          .filter((adj) => adj.source === assetSource)
          .filter((adj) => calendarDayAt(adj.sessionStartedAt, timeZone) === todayStr)
          .length;
        if (usesToday >= effectConfig.limitPerDay) continue;
      }

      const discountAmount = calculateAssetEffectDiscount(totalAmount, effectConfig);

      if (!isPositiveCents(discountAmount)) continue;

      const adjSource = assetDefinitionEffectSource(holding.assetType, holding.assetCode);
      const holdingKey = holding.id ?? (holdingIndex > 0 ? String(holdingIndex) : "");
      const adjId = holdingKey
        ? `${anchorSession.id}:asset-definition:${holding.assetType}:${holding.assetCode}:${holdingKey}:${effectConfig.type}`
        : `${anchorSession.id}:asset-definition:${holding.assetType}:${holding.assetCode}:${effectConfig.type}`;

      unifiedAdjustments.push({
        id: adjId,
        source: adjSource,
        label: definition.name,
        amount: negCents(discountAmount),
      });

      totalAmount = subCents(totalAmount, discountAmount);
      accumulatedAdjustments.push({
        source: adjSource,
        sessionStartedAt: anchorSession.startedAt,
      });

      if (effectConfig.consumable === true) {
        const consumed = assetQuantityOf(holding.assetType, 1);
        holding.quantity = assetQuantityFromStored(holding.assetType, holding.quantity - consumed);
        unifiedLedgerEntries.push({
          assetType: holding.assetType,
          assetCode: holding.assetCode,
          delta: assetQuantityFromStored(holding.assetType, -consumed),
          reason: "session.settlement.coupon",
          refId: anchorSession.id,
        });
      }
    }
  }

  return {
    subtotal: maxCents(ZERO_CENTS, overallSubtotal),
    total: maxCents(ZERO_CENTS, totalAmount),
    sessionResults,
    unifiedAdjustments,
    unifiedLedgerEntries,
    originalHoldings: assetHoldings,
    currentHoldings,
    availableHoldings,
    resolvedAvailableAssets,
    walletBalanceBefore,
    globalCapAdjustments,
    globalCapWindows,
    chargedByItem,
    timeZone,
    pastAppliedAdjustments: accumulatedAdjustments,
    anchorSession,
  };
}

function sessionsForUnifiedCheckout(
  unpaidClosedSessions: readonly Session[],
  activeSessions: readonly Session[],
): Session[] {
  return uniqueSessionsById([
    ...unpaidClosedSessions,
    ...activeSessions,
  ]);
}

function uniqueSessionsById<T extends Session>(sessions: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const session of sessions) {
    byId.set(session.id, session);
  }
  return [...byId.values()];
}

function toPlayerCheckoutPreview(
  playerId: string,
  details: Awaited<ReturnType<typeof calculateUnifiedCheckoutDetails>>,
  now: Date,
): PreviewPlayerCheckoutResult {
  const sessionIds = details.sessionResults.map((result) => result.session.id);
  return {
    settlementPreview: {
      playerId,
      sessionIds,
      subtotal: details.subtotal,
      total: details.total,
      status: "preview",
      previewedAt: now,
    },
    sessionPreviews: details.sessionResults.map((result) => {
      const subtotal = sumCents(result.chargeItems.map((item) => item.amount));
      const total = addCents(subtotal, sumCents(result.adjustments.map((adj) => adj.amount)));
      return {
        sessionId: result.session.id,
        label: result.session.label ?? null,
        startedAt: result.session.startedAt,
        endedAt: result.session.endedAt ?? null,
        status: result.session.status,
        subtotal,
        total,
        chargeItems: result.chargeItems,
        adjustments: result.adjustments,
      };
    }),
    chargeItems: details.sessionResults.flatMap((result) => result.chargeItems),
    adjustments: [
      ...details.sessionResults.flatMap((result) => result.adjustments),
      ...details.unifiedAdjustments,
    ],
    checkoutAdjustments: details.unifiedAdjustments.filter(
      (adjustment) => adjustment.pricingCapHistory == null,
    ),
    pricingCapAdjustments: details.globalCapAdjustments,
    wallet: {
      balanceBefore: details.walletBalanceBefore,
      balanceAfter: subCents(details.walletBalanceBefore, details.total),
    },
    globalCapWindows: details.globalCapWindows,
  };
}

async function persistUnifiedPlayerCheckout(
  dependencies: SettlementServiceDependencies,
  playerId: string,
  details: Awaited<ReturnType<typeof calculateUnifiedCheckoutDetails>>,
  now: Date,
  overrideTotal?: {
    total: number;
    id: string;
    source: string;
    label: string;
  },
  externalPayment?: PlayerCheckout["externalPayment"],
  recharge?: { staffId: string; amount: Cents; ledgerEntries: AssetLedgerEntry[] },
): Promise<SettlePlayerCheckoutResult> {
  const anchorSession = details.anchorSession;
  const sessionIds = details.sessionResults.map((result) => result.session.id);
  const extraLedgerEntries = [
    ...details.sessionResults.flatMap((result) => result.extraLedgerEntries),
    ...details.unifiedLedgerEntries,
    ...(recharge?.ledgerEntries ?? []),
  ];

  let finalTotal = details.total;
  let overrideAdjustment: SettlementAdjustment | undefined;
  if (overrideTotal) {
    if (!Number.isFinite(overrideTotal.total) || overrideTotal.total < 0)
      throw new PrismDomainError("Override total must be finite and nonnegative.", "INVALID_OVERRIDE_TOTAL");
    const overrideTotalAmount = centsOf(overrideTotal.total);
    const diff = subCents(overrideTotalAmount, details.total);
    finalTotal = overrideTotalAmount;
    overrideAdjustment = {
      id: `${anchorSession.id}:${overrideTotal.id}`,
      source: overrideTotal.source,
      label: overrideTotal.label,
      amount: diff,
    };
  }

  const currencyLedgerEntries = externalPayment ? [] : deductCurrency(details.availableHoldings, {
    amount: finalTotal,
    reason: "session.settlement",
    refId: anchorSession.id,
    now,
  });
  const assetLedgerEntries = externalPayment ? [] : [
    ...currencyLedgerEntries,
    ...extraLedgerEntries,
  ];

  const nextHoldings = details.currentHoldings.filter((holding) => holding.quantity > 0);
  const walletBalanceAfter = details.resolvedAvailableAssets
    ? sumAvailableWalletBalance(details.resolvedAvailableAssets)
    : sumCurrencyHoldings(details.availableHoldings);
  const assetCommit: CheckoutCommit["assets"] = {
    transaction: {
      id: `asset-tx:session.settlement:${anchorSession.id}`,
      playerId,
      kind: "session.settlement",
      refId: anchorSession.id,
      createdAt: now,
      metadata: {
        sessions: sessionIds,
        total: finalTotal,
        walletBalanceAfter,
        ...(recharge ? { rechargeAmount: recharge.amount, rechargeStaffId: recharge.staffId } : {}),
      },
    },
    holdingChanges: diffAssetHoldings(details.originalHoldings, nextHoldings),
    assetLedgerEntries,
  };

  const settlements: SettlementRecord[] = [];
  const checkout: PlayerCheckout = {
    ...(externalPayment ? { externalPayment } : {}),
    id: `player-checkout:${anchorSession.id}`,
    playerId,
    subtotal: details.subtotal,
    total: finalTotal,
    status: "settled",
    settledAt: now,
  };
  const pricingHistoryEntries: PricingHistoryEntry[] = [];
  for (const result of details.sessionResults) {
    const adjustments = [
      ...result.adjustments,
      ...(result.session.id === anchorSession.id ? details.unifiedAdjustments : []),
      ...(overrideAdjustment && result.session.id === anchorSession.id ? [overrideAdjustment] : []),
    ];
    const subtotal = sumCents(result.chargeItems.map((item) => item.amount));
    const total = addCents(subtotal, sumCents(adjustments.map((adjustment) => adjustment.amount)));
    const record: SettlementRecord = {
      settlement: {
        sessionId: result.session.id,
        subtotal,
        total,
        status: "settled",
        settledAt: now,
      },
      chargeItems: result.chargeItems,
      adjustments,
    };

    result.session.paymentStatus = "paid";
    pricingHistoryEntries.push(...toPricingHistoryEntries(result.chargeItems, {
      playerId,
      sessionId: result.session.id,
      createdAt: now,
    }, details.chargedByItem));
    settlements.push(record);
  }
  const pricingCapHistory = toPricingCapHistoryEntries(details.globalCapAdjustments, {
    playerId,
    sessionIds,
    createdAt: now,
    anchorSessionId: anchorSession.id,
  });
  const sessions = details.sessionResults.map((result) => result.session);
  const timeline = buildBillTimeline({
    at: now,
    sessions: details.sessionResults.map(({ session, chargeItems }) => ({ sessionId: session.id, label: session.label ?? null, startedAt: session.startedAt, endedAt: session.endedAt ?? now, chargeItems })),
    adjustments: settlements.flatMap(record => record.adjustments),
    globalCapWindows: details.globalCapWindows,
  });
  timeline.pricingReleaseIds = [...new Set(sessions.flatMap(session => session.pricingReleaseId ? [session.pricingReleaseId] : []))];
  checkout.timeline = timeline;
  if (dependencies.commitCheckout) {
    await dependencies.commitCheckout({ assets: externalPayment ? null : assetCommit, checkout, settlements, sessions, pricingHistory: pricingHistoryEntries, pricingCapHistory });
  } else {
    if (!externalPayment) await dependencies.assets.commitAssetTransaction(assetCommit);
    await savePlayerCheckout(dependencies.settlements, checkout, settlements);
    await saveSessions(dependencies.sessions, sessions);
    await dependencies.pricingHistory?.appendEntries(pricingHistoryEntries);
    await dependencies.pricingCapHistory?.appendEntries(pricingCapHistory);
  }

  return {
    playerSettlement: {
      playerId,
      sessionIds,
      subtotal: details.subtotal,
      total: finalTotal,
      status: "settled",
      settledAt: now,
    },
    settlements,
    sessionDetails: details.sessionResults.map((result) => ({
      sessionId: result.session.id,
      label: result.session.label ?? null,
      startedAt: result.session.startedAt,
      endedAt: result.session.endedAt ?? null,
    })),
    chargeItems: details.sessionResults.flatMap((result) => result.chargeItems),
    adjustments: [
      ...details.sessionResults.flatMap((result) => result.adjustments),
      ...details.unifiedAdjustments,
      ...(overrideAdjustment ? [overrideAdjustment] : []),
    ],
    checkoutAdjustments: [
      ...details.unifiedAdjustments.filter(
        (adjustment) => adjustment.pricingCapHistory == null,
      ),
      ...(overrideAdjustment ? [overrideAdjustment] : []),
    ],
    pricingCapAdjustments: details.globalCapAdjustments,
    timeline,
    assetLedgerEntries,
    wallet: {
      balanceBefore: details.walletBalanceBefore,
      balanceAfter: walletBalanceAfter,
    },
    globalCapWindows: details.globalCapWindows,
  };
}

function toPricingCapHistoryEntries(
  adjustments: readonly SettlementAdjustment[],
  input: {
    playerId: string;
    sessionIds: readonly string[];
    createdAt: Date;
    anchorSessionId: string;
  },
): PricingCapHistoryEntry[] {
  return adjustments.flatMap((adjustment, index) => {
    const history = adjustment.pricingCapHistory;
    if (!history || !isPositiveCents(history.amount)) return [];
    return [
      {
        id: `pricing-cap-history:${input.anchorSessionId}:${index}`,
        playerId: input.playerId,
        capConfigId: history.capConfigId,
        capRuleId: history.capRuleId,
        capAnchorAt: history.capAnchorAt,
        includedPricingConfigIds: history.includedPricingConfigIds,
        sessionIds: [...input.sessionIds],
        amount: history.amount,
        createdAt: input.createdAt,
        metadata: null,
      },
    ];
  });
}

async function findSessionOrThrow(sessions: SessionRepository, playerId: string, sessionId?: string) {
  if (sessionId) {
    const session = await sessions.findById(sessionId);
    if (!session || session.playerId !== playerId) {
      throw new PrismDomainError("Session not found for player.", "SESSION_NOT_FOUND");
    }
    return session;
  }
  const activeSessions = await sessions.findActiveByPlayerId(playerId);
  const latestActive = activeSessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
  if (!latestActive) {
    throw new PrismDomainError("Player has no active session.", "ACTIVE_SESSION_NOT_FOUND");
  }
  return latestActive;
}

async function saveSessions(
  sessions: SessionRepository,
  records: readonly Session[],
): Promise<void> {
  if (records.length === 0) return;
  if (sessions.saveMany) {
    await sessions.saveMany(records);
    return;
  }
  for (const record of records) await sessions.save(record);
}

async function savePlayerCheckout(
  settlements: SettlementRepository,
  checkout: PlayerCheckout,
  records: readonly SettlementRecord[],
): Promise<void> {
  await settlements.saveCheckout(checkout, records);
}

async function resolvePricingProviders(
  dependencies: SettlementServiceDependencies,
  context: PricingProviderResolverContext,
): Promise<readonly PricingProvider[]> {
  return dependencies.pricingProviderResolver
    ? dependencies.pricingProviderResolver(context)
    : dependencies.pricingProviders;
}

function toPricingHistoryEntries(
  chargeItems: readonly ChargeItem[],
  input: {
    playerId: string;
    sessionId: string;
    createdAt: Date;
  },
  /** What each charge was actually charged after every cap, by charge id. */
  chargedByItem?: ReadonlyMap<string, Cents>,
): PricingHistoryEntry[] {
  return chargeItems.flatMap((item, index) => {
    if (!item.pricingHistory) return [];
    const history = item.pricingHistory;
    return [
      {
        id: `pricing-history:${input.sessionId}:${index}`,
        playerId: input.playerId,
        pricingConfigId: history.pricingConfigId,
        providerId: history.providerId,
        ruleId: history.ruleId,
        ruleAnchorAt: history.ruleAnchorAt,
        sessionId: input.sessionId,
        amount: chargedByItem?.get(item.id) ?? history.amount,
        createdAt: input.createdAt,
        metadata: null,
      },
    ];
  });
}

