import type {
  CheckoutCommit,
  AssetDefinitionRepository,
  AssetDefinition,
  AssetEffectProvider,
  AssetHolding,
  AssetLedgerEntry,
  AssetRepository,
  ChargeItem,
  DeviceCommand,
  DeviceCommandRepository,
  PricingCapHistoryEntry,
  PricingCapHistoryRepository,
  PricingHistoryEntry,
  PricingHistoryRepository,
  PreviewSessionSettlementResult,
  PricingProvider,
  PlayerCheckout,
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
  addCents,
  assetQuantityFromStored,
  applyTimeCapPricing,
  allocate,
  closeSession,
  collectTimeCapPricingHistoryLookupKeys,
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
  explainTimeCapPricing,
  isActiveInWindow,
  previewSessionSettlement,
  PrismDomainError,
  settleSession,
  sumCurrencyHoldings,
  sumCents,
  ZERO_CENTS,
} from "@prism/core";
import { withOperationLease } from "./operation-lock";
import { sumAvailableWalletBalance, type AvailableAssetReader } from "./available-assets";
import {
  assetDefinitionEffectSource,
  calculateAssetEffectDiscount,
  calendarDayAt,
  isAssetEffectConfigAvailable,
  resolveAssetDefinitionEffectConfig,
} from "./asset-definition-effects";

export type SettlementServiceDependencies = {
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
  deviceCommands?: DeviceCommandRepository;
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
};

export type SettlementService = {
  previewCheckout(input: PlayerCheckoutInput): Promise<PreviewPlayerCheckoutResult>;
  checkout(input: PlayerCheckoutInput): Promise<SettlePlayerCheckoutResult>;
  stopSession(input: { playerId: string; sessionId: string }): Promise<Session & { status: "closed"; endedAt: Date }>;
  checkoutWithOverride(input: StaffCheckoutOverrideInput): Promise<SettlePlayerCheckoutResult>;
};

const playerLocks = new Map<string, Promise<any>>();

async function acquireCheckoutLock<T>(dependencies: SettlementServiceDependencies, playerId: string, fn: () => Promise<T>): Promise<T> {
  if (!dependencies.operationLocks) return acquireLock(playerId, fn);
  return withOperationLease({ repository: dependencies.operationLocks, scope: "player.assets", resourceId: playerId, id: dependencies.id, now: dependencies.now }, fn);
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

    async stopSession(input) {
      return acquireLock(input.playerId, async () => {
        const now = dependencies.now();
        const session = await findSessionOrThrow(dependencies.sessions, input.playerId, input.sessionId);
        const closedSession = closeSession({ session, now });
        closedSession.paymentStatus = "unpaid";
        await dependencies.sessions.save(closedSession);
        return closedSession;
      });
    },

    async checkoutWithOverride(input) {
      return acquireCheckoutLock(dependencies, input.playerId, async () => {
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

  const [operations, storeProfile] = dependencies.system
    ? await Promise.all([
        dependencies.system.getAppSetting<{ timeZone?: unknown }>("venue.operations"),
        dependencies.system.getAppSetting<{ timeZone?: unknown }>("store.profile"),
      ])
    : [null, null];
  const timeZone =
    (typeof operations?.timeZone === "string" && operations.timeZone.trim() ? operations.timeZone.trim() : null) ??
    (typeof storeProfile?.timeZone === "string" && storeProfile.timeZone.trim() ? storeProfile.timeZone.trim() : null) ??
    "Asia/Shanghai";

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

  const playerCommands = dependencies.deviceCommands
    ? await dependencies.deviceCommands.listByPlayerId(playerId)
    : [];

  for (const session of orderedSessions) {
    const hasDeviceActivity = Boolean(
      session.metadata?.deviceOperated ||
      hasMatchingMachineCommand(session, playerCommands, now),
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
    collectTimeCapPricingHistoryLookupKeys({
      config,
      chargeItems: chargeItemsForGlobalCaps,
    }),
  );
  const globalCapPaidHistory = dependencies.pricingCapHistory
    ? await dependencies.pricingCapHistory.sumByPlayerAndKeys(playerId, globalCapHistoryKeys)
    : {};
  for (const config of globalCapConfigs) {
    const windows = explainTimeCapPricing({
      config: {
        ...config,
        paidHistory: globalCapPaidHistory,
      },
      chargeItems: chargeItemsForGlobalCaps,
    });
    globalCapWindows.push(...allocateGlobalCapWindowContributions(windows));
    const adjustments = applyTimeCapPricing({
      config: {
        ...config,
        paidHistory: globalCapPaidHistory,
      },
      chargeItems: chargeItemsForGlobalCaps,
    });
    for (const adjustment of adjustments) {
      globalCapAdjustments.push(adjustment);
      unifiedAdjustments.push(adjustment);
        totalAmount = addCents(totalAmount, adjustment.amount);
    }
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

function allocateGlobalCapWindowContributions(
  windows: readonly TimeCapPricingWindow[],
): TimeCapPricingWindow[] {
  return windows.map((window) => {
    const contributions = [...window.contributions].sort((a, b) =>
      a.sessionId.localeCompare(b.sessionId) || a.pricingConfigId.localeCompare(b.pricingConfigId),
    );
    const discounts = allocate(subCents(window.currentAmount, window.amountApplied),
      contributions.map((contribution) => Math.max(0, contribution.amount)));

    return {
      ...window,
      contributions: contributions.map((contribution, index) =>
        ({ ...contribution, amount: subCents(contribution.amount, discounts[index] ?? ZERO_CENTS) }),
      ),
    };
  });
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
): Promise<SettlePlayerCheckoutResult> {
  const anchorSession = details.anchorSession;
  const sessionIds = details.sessionResults.map((result) => result.session.id);
  const extraLedgerEntries = [
    ...details.sessionResults.flatMap((result) => result.extraLedgerEntries),
    ...details.unifiedLedgerEntries,
  ];

  let finalTotal = details.total;
  let overrideAdjustment: SettlementAdjustment | undefined;
  if (overrideTotal) {
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

  const currencyLedgerEntries = deductCurrency(details.availableHoldings, {
    amount: finalTotal,
    reason: "session.settlement",
    refId: anchorSession.id,
    now,
  });
  const assetLedgerEntries = [
    ...currencyLedgerEntries,
    ...extraLedgerEntries,
  ];

  const nextHoldings = details.currentHoldings.filter((holding) => holding.quantity > 0);
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
      },
    },
    holdingChanges: diffAssetHoldings(details.originalHoldings, nextHoldings),
    assetLedgerEntries,
  };
  const walletBalanceAfter = details.resolvedAvailableAssets
    ? sumAvailableWalletBalance(details.resolvedAvailableAssets)
    : sumCurrencyHoldings(details.availableHoldings);

  const settlements: SettlementRecord[] = [];
  const checkout: PlayerCheckout = {
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
    }));
    settlements.push(record);
  }
  const pricingCapHistory = toPricingCapHistoryEntries(details.globalCapAdjustments, {
    playerId,
    sessionIds,
    createdAt: now,
    anchorSessionId: anchorSession.id,
  });
  const sessions = details.sessionResults.map((result) => result.session);
  if (dependencies.commitCheckout) {
    await dependencies.commitCheckout({ assets: assetCommit, checkout, settlements, sessions, pricingHistory: pricingHistoryEntries, pricingCapHistory });
  } else {
    await dependencies.assets.commitAssetTransaction(assetCommit);
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
        amount: history.amount,
        createdAt: input.createdAt,
        metadata: null,
      },
    ];
  });
}

function hasMatchingMachineCommand(
  session: Session,
  commands: readonly DeviceCommand[],
  now: Date,
): boolean {
  const started = session.startedAt.getTime();
  const ended = (session.endedAt ?? now).getTime();
  return commands.some((cmd) => {
    if (cmd.playerId !== session.playerId) return false;
    if (cmd.type === "door.open") return false;
    if (cmd.status === "expired" || cmd.status === "rejected") return false;
    const req = (cmd.requestedAt ?? (cmd as any).createdAt)?.getTime?.();
    if (req === undefined) return false;
    return req >= started && req <= ended;
  });
}
