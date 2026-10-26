import { PrismDomainError } from "./errors";
import type { PricingRelationGraph } from "./pricing-relations";
import type { Session } from "./session";

/** The one active session a startable plan has for a player. */
export type ActivePlanSession = {
  planId: string;
  sessionId: string;
  startedAt: Date;
};

export type TransitionPlan = {
  targetPricingConfigId: string;
  /** Every plan the caller explicitly asked for. */
  targetPricingConfigIds: string[];
  /** Plans to start, dependencies first. */
  startPlanIds: string[];
  /** Plans to stop, dependents first. */
  stopPlanIds: string[];
  /** Existing plans left untouched, including the target when already active. */
  keepPlanIds: string[];
  /** Why each plan moves, for the preview UI and the audit trail. */
  reasonByPlanId: Record<string, string>;
  /** Opaque fingerprint of the state this plan was computed from. */
  revision: string;
};

export type ActivationPlan = TransitionPlan;

export type DeactivationPlan = TransitionPlan & {
  /** Sessions closed by this plan; the target is included when active. */
  stopSessionIds: string[];
  /** True when nothing was active, so the request changed nothing. */
  alreadyInactive: boolean;
};

/**
 * The plan a session bills, taken from its own field and never inferred from a
 * label, metadata or a plan list. Sessions without one (unpriced placeholders,
 * historical multi-plan rows) take no part in relations.
 */
export function lifecyclePlanIdOf(session: Session): string | null {
  return session.pricingConfigId || null;
}

/** Sessions grouped by plan. Plans with several active sessions keep the earliest. */
export function activePlanSessions(sessions: readonly Session[]): ActivePlanSession[] {
  const byPlan = new Map<string, ActivePlanSession>();
  for (const session of sessions) {
    if (session.status !== "active") continue;
    const planId = lifecyclePlanIdOf(session);
    if (!planId) continue;
    const existing = byPlan.get(planId);
    if (
      !existing ||
      session.startedAt.getTime() < existing.startedAt.getTime() ||
      (session.startedAt.getTime() === existing.startedAt.getTime() &&
        session.id.localeCompare(existing.sessionId) < 0)
    ) {
      byPlan.set(planId, { planId, sessionId: session.id, startedAt: session.startedAt });
    }
  }
  return [...byPlan.values()].sort((a, b) => a.planId.localeCompare(b.planId));
}

/**
 * Fingerprints the active plan set. A caller that previewed a transition and
 * then submits the same revision is planning against the state the player saw.
 */
export function transitionRevision(active: readonly ActivePlanSession[]): string {
  const stable = [...active]
    .map((entry) => `${entry.planId}:${entry.startedAt.toISOString()}:${entry.sessionId}`)
    .sort();
  return stable.join("|");
}

/**
 * Everything that must be true when `targetPlanId` starts.
 *
 * Requires-closure starts first; anything already running is reused, never
 * restarted, so a plan switch cannot reset the base timer. Active plans that
 * conflict with the closure are stopped together with everything that depends on
 * them, unless that would break a requirement of the target.
 */
export function planActivation(input: {
  targetPricingConfigId: string;
  /**
   * Further plans to start at the same instant, for callers whose device or
   * workflow names more than one plan. The whole set is planned as one unit.
   */
  alsoActivate?: readonly string[];
  active: readonly ActivePlanSession[];
  graph: PricingRelationGraph;
}): ActivationPlan {
  const targets = [...new Set([input.targetPricingConfigId, ...(input.alsoActivate ?? [])])];
  if (targets.length === 0 || !targets[0]) {
    throw new PrismDomainError("A pricing plan is required.", "PRICING_CONFIG_REQUIRED");
  }
  const activePlanIds = new Set(input.active.map((entry) => entry.planId));
  const revision = transitionRevision(input.active);

  // R: the union of every target's requirement closure.
  const required: string[] = [];
  for (const target of targets) {
    for (const planId of input.graph.requireClosure(target)) {
      if (!required.includes(planId)) required.push(planId);
    }
  }
  input.graph.assertNoInternalConflicts(required);

  const reasonByPlanId: Record<string, string> = {};
  for (const target of targets) {
    reasonByPlanId[target] ??= target === input.targetPricingConfigId ? "requested" : "requested-together";
  }
  for (const planId of required) {
    if (reasonByPlanId[planId]) continue;
    const requirer = required.find((candidate) => input.graph.requiresOf(candidate).includes(planId));
    reasonByPlanId[planId] = requirer ? `required-by-${requirer}` : "required";
  }

  const conflictingActive = input.graph.findConflictingActive(required, activePlanIds);
  const toStop = new Set<string>();
  for (const planId of conflictingActive) {
    toStop.add(planId);
    for (const dependent of input.graph.activeDependentClosure([planId], activePlanIds)) {
      toStop.add(dependent);
    }
  }

  const requiredSet = new Set(required);
  for (const planId of toStop) {
    if (!requiredSet.has(planId)) continue;
    throw new PrismDomainError(
      `Pricing plan '${planId}' is required by the target but must stop for a conflicting plan.`,
      "PRICING_RELATION_UNSATISFIABLE",
    );
  }

  const startPlanIds = required.filter((planId) => !activePlanIds.has(planId));
  const stopPlanIds = input.graph.reverseTopologicalOrder([...toStop]);

  for (const planId of stopPlanIds) {
    if (!reasonByPlanId[planId]) reasonByPlanId[planId] = "conflicts-with-target";
  }

  const keepPlanIds = input.active
    .map((entry) => entry.planId)
    .filter((planId) => !toStop.has(planId))
    .sort();

  return {
    targetPricingConfigId: input.targetPricingConfigId,
    targetPricingConfigIds: targets,
    startPlanIds: input.graph.topologicalOrder(startPlanIds),
    stopPlanIds,
    keepPlanIds,
    reasonByPlanId,
    revision,
  };
}

/**
 * Everything that must be true when `targetPlanId` stops.
 *
 * Every active plan that requires the target stops with it, at the same instant.
 * Plans the target merely requires are left running: stopping the add-on must
 * never end the base plan.
 */
export function planDeactivation(input: {
  targetPricingConfigId: string;
  active: readonly ActivePlanSession[];
  graph: PricingRelationGraph;
}): DeactivationPlan {
  const activePlanIds = new Set(input.active.map((entry) => entry.planId));
  const revision = transitionRevision(input.active);
  const targetActive = activePlanIds.has(input.targetPricingConfigId);

  if (!targetActive) {
    return {
      targetPricingConfigId: input.targetPricingConfigId,
      targetPricingConfigIds: [input.targetPricingConfigId],
      startPlanIds: [],
      stopPlanIds: [],
      keepPlanIds: [...activePlanIds].sort(),
      reasonByPlanId: {},
      revision,
      stopSessionIds: [],
      alreadyInactive: true,
    };
  }

  const toStop = new Set<string>([input.targetPricingConfigId]);
  for (const dependent of input.graph.dependentClosureOf(input.targetPricingConfigId)) {
    if (activePlanIds.has(dependent)) toStop.add(dependent);
  }

  const reasonByPlanId: Record<string, string> = {
    [input.targetPricingConfigId]: "requested",
  };
  for (const planId of toStop) {
    if (planId !== input.targetPricingConfigId) reasonByPlanId[planId] ??= "requires-target";
  }

  const sessionByPlan = new Map(input.active.map((entry) => [entry.planId, entry.sessionId]));
  const stopPlanIds = input.graph.reverseTopologicalOrder([...toStop]);
  return {
    targetPricingConfigId: input.targetPricingConfigId,
    targetPricingConfigIds: [input.targetPricingConfigId],
    startPlanIds: [],
    stopPlanIds,
    keepPlanIds: [...activePlanIds].filter((planId) => !toStop.has(planId)).sort(),
    reasonByPlanId,
    revision,
    stopSessionIds: stopPlanIds.map((planId) => sessionByPlan.get(planId)!),
    alreadyInactive: false,
  };
}
