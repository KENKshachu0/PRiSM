/**
 * The single way pricing sessions start and stop.
 *
 * Every entry point (player scan, front desk, cashier, integration, mahjong)
 * asks this service to activate or deactivate a plan instead of writing sessions
 * itself. The service resolves the relation graph of the release the player is
 * billed under, plans the transition, refuses states the graph does not allow,
 * and writes every change of one transition at one instant in one batch.
 *
 * Prices are never touched here: which sessions are open is orchestrated, what
 * they cost is still the pricing engine's business.
 */
import {
  activePlanSessions,
  buildPricingRelationGraph,
  closeSession,
  planActivation,
  planDeactivation,
  PrismDomainError,
  isStartablePricingKind,
  relationsOf,
  satisfiesPricingRelations,
  startSession,
  transitionRevision,
  type ActivePlanSession,
  type OperationLockRepository,
  type PricingConfig,
  type Session,
  type SessionRepository,
  type TransitionPlan,
} from "@prism/core";
import { PLAYER_BILLING_LOCK_SCOPE, withOperationLease } from "./operation-lock";

export type PricingSessionTransitionItem = {
  planId: string;
  planName: string;
  sessionId?: string;
  startedAt?: Date;
  /** `requested`, `required-by-<plan>`, `conflicts-with-target`, `requires-target`, `kept` */
  reason: string;
};

export type PricingSessionTransition = {
  action: "activate" | "deactivate";
  targetPricingConfigId: string;
  started: PricingSessionTransitionItem[];
  stopped: PricingSessionTransitionItem[];
  kept: PricingSessionTransitionItem[];
  /** Fingerprint of the state the transition was planned from. */
  revision: string;
  /** Whether confirming (or this call) starts or stops at least one session. */
  changed: boolean;
  at: Date;
};

export type PricingActivationResult = PricingSessionTransition & {
  /** The target plan's active session afterwards, reused or newly started. */
  session: Session & { status: "active" };
};

export type PricingSessionState = {
  playerId: string;
  active: { planId: string; planName: string; sessionId: string; startedAt: Date }[];
  /** Plans that may be started right now, with their relations. */
  available: { planId: string; name: string; requires: string[]; conflicts: string[] }[];
  revision: string;
};

export type PricingActivationInput = {
  playerId: string;
  pricingConfigId: string;
  /** The revision the caller previewed; a stale one is refused, not applied. */
  expectedRevision?: string;
  /** Display text only; nothing decides anything from it. */
  label?: string;
  /** Id for the target's session when it starts, for callers that reference it beforehand. */
  sessionId?: string;
  metadata?: Record<string, unknown>;
  /** Shared instant for callers that move several players at once. */
  at?: Date;
};

export type PricingDeactivationInput = {
  playerId: string;
  pricingConfigId: string;
  expectedRevision?: string;
  at?: Date;
};

export type PricingSessionOrchestratorDependencies = {
  sessions: SessionRepository & { applyTransition: NonNullable<SessionRepository["applyTransition"]> };
  operationLocks?: OperationLockRepository;
  /**
   * Every config of the release the player is billed under: the release their
   * unsettled bill is pinned to, otherwise the current one. Disabled and
   * archived configs are included so relation targets always resolve.
   */
  pricingCatalog(playerId: string): Promise<readonly PricingConfig[]>;
  /**
   * Runs after a transition is written, with the sessions it closed, so what
   * hangs off those sessions (a mahjong seat) can be released. Never undoes the
   * transition; a failure only leaves the cleanup for later.
   */
  afterClose?(closed: readonly Session[]): Promise<void>;
  /** Display label for a started session the caller did not label; display only. */
  labelOf?(planId: string, catalog: readonly PricingConfig[]): string | undefined;
  /** False when a plan's own rules do not bill at `at`. */
  canStartPlanAt?(input: {
    playerId: string;
    config: Extract<PricingConfig, { kind: "time.priority" }>;
    at: Date;
  }): Promise<boolean> | boolean;
  now: () => Date;
  id: () => string;
};

export type PricingSessionOrchestrator = {
  getActive(playerId: string): Promise<PricingSessionState>;
  previewActivate(input: PricingActivationInput): Promise<PricingSessionTransition>;
  activate(input: PricingActivationInput): Promise<PricingActivationResult>;
  previewDeactivate(input: PricingDeactivationInput): Promise<PricingSessionTransition>;
  deactivate(input: PricingDeactivationInput): Promise<PricingSessionTransition & { closed: (Session & { status: "closed"; endedAt: Date })[] }>;
};

export function createPricingSessionOrchestrator(
  dependencies: PricingSessionOrchestratorDependencies,
): PricingSessionOrchestrator {
  type LoadedState = {
    configs: readonly PricingConfig[];
    graph: ReturnType<typeof buildPricingRelationGraph>;
    active: ActivePlanSession[];
    byPlan: Map<string, Session>;
  };

  async function load(playerId: string): Promise<LoadedState> {
    const configs = await dependencies.pricingCatalog(playerId);
    const graph = buildPricingRelationGraph(configs.filter((config) => isStartablePricingKind(config.kind)));
    const sessions = await dependencies.sessions.findActiveByPlayerId(playerId);
    const active = activePlanSessions(sessions);
    const byPlan = new Map<string, Session>();
    for (const entry of active) {
      const session = sessions.find((candidate) => candidate.id === entry.sessionId);
      if (session) byPlan.set(entry.planId, session);
    }
    return { configs, graph, active, byPlan };
  }

  function lease<T>(playerId: string, action: () => Promise<T>): Promise<T> {
    return withOperationLease(
      {
        repository: dependencies.operationLocks,
        scope: PLAYER_BILLING_LOCK_SCOPE,
        resourceId: playerId,
        id: dependencies.id,
        now: dependencies.now,
      },
      action,
    );
  }

  function assertRevision(expected: string | undefined, active: readonly ActivePlanSession[]) {
    if (expected !== undefined && expected !== transitionRevision(active)) {
      throw new PrismDomainError("计费状态已变化，请重新确认", "PRICING_STATE_REVISION_MISMATCH");
    }
  }

  async function assertStartableNow(
    playerId: string,
    configs: readonly PricingConfig[],
    planIds: readonly string[],
    at: Date,
  ) {
    if (!dependencies.canStartPlanAt) return;
    for (const planId of planIds) {
      const config = configs.find((candidate) => candidate.id === planId);
      if (config?.kind !== "time.priority") continue;
      if (await dependencies.canStartPlanAt({ playerId, config, at })) continue;
      throw new PrismDomainError(
        "Player cannot start a billing session outside billable business intervals.",
        "PLAYER_SESSION_OUTSIDE_BILLABLE_TIME",
      );
    }
  }

  function describe(input: {
    action: "activate" | "deactivate";
    targetPricingConfigId: string;
    configs: readonly PricingConfig[];
    plan: TransitionPlan;
    byPlan: ReadonlyMap<string, Session>;
    created?: readonly Session[];
    changed: boolean;
    at: Date;
  }): PricingSessionTransition {
    const item = (planId: string): PricingSessionTransitionItem => {
      const session = input.byPlan.get(planId) ?? input.created?.find((candidate) => candidate.pricingConfigId === planId);
      return {
        planId,
        planName: input.configs.find((config) => config.id === planId)?.name ?? planId,
        reason: input.plan.reasonByPlanId[planId] ?? "kept",
        ...(session ? { sessionId: session.id, startedAt: session.startedAt } : {}),
      };
    };
    return {
      action: input.action,
      targetPricingConfigId: input.targetPricingConfigId,
      started: input.plan.startPlanIds.map(item),
      stopped: input.plan.stopPlanIds.map(item),
      kept: input.plan.keepPlanIds.map(item),
      revision: input.plan.revision,
      changed: input.changed,
      at: input.at,
    };
  }

  async function releaseClosed(closed: readonly Session[]) {
    try {
      await dependencies.afterClose?.(closed);
    } catch (error) {
      console.error("Releasing what closed sessions held failed", error);
    }
  }

  /** Refuses a planned end state the graph does not allow, before anything is written. */
  function assertSatisfiedAfter(state: LoadedState, plan: TransitionPlan) {
    const after = new Set([...plan.keepPlanIds, ...plan.startPlanIds]);
    if (!satisfiesPricingRelations(state.graph, after)) {
      throw new PrismDomainError("当前计费状态与方案关系不一致，请联系店员处理", "PRICING_STATE_INCONSISTENT");
    }
  }

  return {
    async getActive(playerId) {
      const { configs, graph, active } = await load(playerId);
      const nameOf = (planId: string) => configs.find((config) => config.id === planId)?.name ?? planId;
      return {
        playerId,
        active: active.map((entry) => ({ ...entry, planName: nameOf(entry.planId) })),
        available: configs
          .filter((config) => graph.isStartable(config.id))
          .map((config) => ({ planId: config.id, name: config.name, ...relationsOf(config) })),
        revision: transitionRevision(active),
      };
    },

    async previewActivate(input) {
      const at = input.at ?? dependencies.now();
      const state = await load(input.playerId);
      const plan = planActivation({ targetPricingConfigId: input.pricingConfigId, active: state.active, graph: state.graph });
      await assertStartableNow(input.playerId, state.configs, plan.startPlanIds, at);
      return describe({
        action: "activate",
        targetPricingConfigId: input.pricingConfigId,
        configs: state.configs,
        plan,
        byPlan: state.byPlan,
        changed: plan.startPlanIds.length > 0 || plan.stopPlanIds.length > 0,
        at,
      });
    },

    activate(input) {
      return lease(input.playerId, async () => {
        const at = input.at ?? dependencies.now();
        const state = await load(input.playerId);
        assertRevision(input.expectedRevision, state.active);
        const plan = planActivation({ targetPricingConfigId: input.pricingConfigId, active: state.active, graph: state.graph });

        // Stopping something while the target already runs means the live state
        // breaks the relations. A plain repeat must not end sessions nobody
        // agreed to end; a caller confirming a preview's revision may.
        const targetRunning = state.byPlan.has(input.pricingConfigId);
        if (targetRunning && plan.stopPlanIds.length > 0 && input.expectedRevision === undefined) {
          throw new PrismDomainError("当前计费状态与方案关系不一致，请联系店员处理", "PRICING_STATE_INCONSISTENT");
        }
        await assertStartableNow(input.playerId, state.configs, plan.startPlanIds, at);
        assertSatisfiedAfter(state, plan);

        const labelFor = (planId: string) => {
          const label = planId === input.pricingConfigId && input.label ? input.label : dependencies.labelOf?.(planId, state.configs);
          return label ? { label } : {};
        };
        const changed = plan.startPlanIds.length > 0 || plan.stopPlanIds.length > 0;
        const close = plan.stopPlanIds.map((planId) => closeSession({ session: state.byPlan.get(planId)!, now: at }));
        const create = plan.startPlanIds.map((planId) =>
          startSession({
            playerId: input.playerId,
            now: at,
            id: planId === input.pricingConfigId && input.sessionId ? input.sessionId : dependencies.id(),
            pricingConfigId: planId,
            ...labelFor(planId),
            ...(input.metadata ? { metadata: input.metadata } : {}),
          }),
        );
        if (changed) {
          await dependencies.sessions.applyTransition({ close, create });
          if (close.length) await releaseClosed(close);
        }

        const session = state.byPlan.get(input.pricingConfigId) ?? create.find((item) => item.pricingConfigId === input.pricingConfigId)!;
        return {
          ...describe({
            action: "activate",
            targetPricingConfigId: input.pricingConfigId,
            configs: state.configs,
            plan,
            byPlan: state.byPlan,
            created: create,
            changed,
            at,
          }),
          session: { ...session, status: "active" as const },
        };
      });
    },

    async previewDeactivate(input) {
      const at = input.at ?? dependencies.now();
      const state = await load(input.playerId);
      const plan = planDeactivation({ targetPricingConfigId: input.pricingConfigId, active: state.active, graph: state.graph });
      return describe({
        action: "deactivate",
        targetPricingConfigId: input.pricingConfigId,
        configs: state.configs,
        plan,
        byPlan: state.byPlan,
        changed: !plan.alreadyInactive,
        at,
      });
    },

    deactivate(input) {
      return lease(input.playerId, async () => {
        const at = input.at ?? dependencies.now();
        const state = await load(input.playerId);
        assertRevision(input.expectedRevision, state.active);
        const plan = planDeactivation({ targetPricingConfigId: input.pricingConfigId, active: state.active, graph: state.graph });
        const closed = plan.stopPlanIds.map((planId) => closeSession({ session: state.byPlan.get(planId)!, now: at }));
        if (closed.length > 0) {
          await dependencies.sessions.applyTransition({ close: closed, create: [] });
          await releaseClosed(closed);
        }
        return {
          ...describe({
            action: "deactivate",
            targetPricingConfigId: input.pricingConfigId,
            configs: state.configs,
            plan,
            byPlan: state.byPlan,
            changed: closed.length > 0,
            at,
          }),
          closed,
        };
      });
    },
  };
}
