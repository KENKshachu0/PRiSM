/**
 * Declarative relations between startable pricing plans.
 *
 * A plan's `requires` and `conflicts` describe how sessions may run together;
 * they say nothing about price or about minutes. The graph answers the questions
 * the orchestrator needs — which plans must run together, which may not, and
 * whether a shop's configuration can be satisfied at all.
 *
 * Two kinds of problem are deliberately separated:
 *
 * - A *broken configuration* (self reference, duplicate reference, cycle,
 *   contradiction, reference to something that can never run) is rejected when
 *   the graph is built, so an unusable relation set never reaches a player.
 * - A *temporarily unavailable plan* (disabled, or archived while another plan
 *   still requires it) is not a broken configuration. Archiving stays possible;
 *   starting the plan that depends on it fails with a precise reason instead.
 */
import { PrismDomainError } from "./errors";
import type { PricingConfig, PricingConfigKind, PricingConfigRelations } from "./pricing-config";

export type { PricingConfigRelations };

export function emptyPricingConfigRelations(): PricingConfigRelations {
  return { requires: [], conflicts: [] };
}

/**
 * Plans a session can run: a time plan, or a fixed charge billed once for the
 * session. `time.cap` stays a settlement adjustment and never runs.
 */
export function isStartablePricingKind(kind: PricingConfigKind): boolean {
  return kind === "time.priority" || kind === "charge.fixed";
}

/** Only time plans declare relations or are referenced by them. */
export function isRelatablePricingKind(kind: PricingConfigKind): boolean {
  return kind === "time.priority";
}

export function isStartablePlan(config: PricingConfig): boolean {
  return (
    isStartablePricingKind(config.kind) &&
    config.enabled &&
    (config.status ?? "active") === "active"
  );
}

/** Relations are only meaningful on startable kinds; others answer with none. */
export function relationsOf(config: PricingConfig): PricingConfigRelations {
  if (!isRelatablePricingKind(config.kind)) return emptyPricingConfigRelations();
  const relations = (config as { relations?: PricingConfigRelations }).relations;
  return {
    requires: [...(relations?.requires ?? [])],
    conflicts: [...(relations?.conflicts ?? [])],
  };
}

export type PricingRelationGraph = {
  /** Every declared plan, startable or not. Relation targets resolve against this. */
  readonly ids: readonly string[];
  /** Declared plans that may be started right now. */
  readonly startableIds: readonly string[];
  isDeclared(planId: string): boolean;
  isStartable(planId: string): boolean;
  requiresOf(planId: string): readonly string[];
  conflictsOf(planId: string): readonly string[];
  /**
   * The plan and everything it transitively requires, dependencies first.
   * Refuses when the plan, or anything it requires, cannot be started now.
   */
  requireClosure(planId: string): string[];
  /** Every declared plan that transitively requires `planId`, startable or not. */
  dependentClosureOf(planId: string): ReadonlySet<string>;
  /** Every active plan that directly or indirectly requires one of `seeds`. */
  activeDependentClosure(seeds: readonly string[], activePlanIds: ReadonlySet<string>): string[];
  /** Active plans that conflict with any of `planIds`. */
  findConflictingActive(planIds: readonly string[], activePlanIds: ReadonlySet<string>): string[];
  /** Throws unless no two of `planIds` conflict. */
  assertNoInternalConflicts(planIds: readonly string[]): void;
  /** Dependencies first, so an activation can start them in order. */
  topologicalOrder(planIds: readonly string[]): string[];
  /** Dependents first, so a stop can close them in order. */
  reverseTopologicalOrder(planIds: readonly string[]): string[];
};

class RelationGraph implements PricingRelationGraph {
  readonly ids: readonly string[];
  readonly startableIds: readonly string[];
  private readonly byId: ReadonlyMap<string, PricingConfig>;
  private readonly requires: ReadonlyMap<string, readonly string[]>;
  private readonly conflicts: ReadonlyMap<string, ReadonlySet<string>>;
  private readonly dependents: ReadonlyMap<string, readonly string[]>;

  constructor(
    configs: readonly PricingConfig[],
    requires: ReadonlyMap<string, readonly string[]>,
    conflicts: ReadonlyMap<string, ReadonlySet<string>>,
  ) {
    this.byId = new Map(configs.map((config) => [config.id, config]));
    this.ids = [...this.byId.keys()];
    this.startableIds = configs.filter(isStartablePlan).map((config) => config.id);
    this.requires = requires;
    this.conflicts = conflicts;
    const dependents = new Map<string, string[]>();
    for (const [planId, dependencies] of requires) {
      for (const dependency of dependencies) {
        dependents.set(dependency, [...(dependents.get(dependency) ?? []), planId]);
      }
    }
    for (const [planId, list] of dependents) dependents.set(planId, list.sort());
    this.dependents = dependents;
  }

  isDeclared(planId: string): boolean {
    return this.byId.has(planId);
  }

  isStartable(planId: string): boolean {
    const config = this.byId.get(planId);
    return !!config && isStartablePlan(config);
  }

  requiresOf(planId: string): readonly string[] {
    return this.requires.get(planId) ?? [];
  }

  conflictsOf(planId: string): readonly string[] {
    return [...(this.conflicts.get(planId) ?? [])].sort();
  }

  requireClosure(planId: string): string[] {
    const root = this.byId.get(planId);
    if (!root) {
      throw new PrismDomainError(`Pricing plan '${planId}' does not exist.`, "PRICING_PLAN_NOT_FOUND");
    }
    if (!isStartablePricingKind(root.kind)) {
      throw new PrismDomainError(
        `Pricing plan '${planId}' is not a plan a session can run.`,
        "PRICING_PLAN_NOT_STARTABLE",
      );
    }

    const ordered: string[] = [];
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const config = this.byId.get(id);
      if (!config) {
        throw new PrismDomainError(
          `Required pricing plan '${id}' does not exist.`,
          "PRICING_RELATION_UNKNOWN_TARGET",
        );
      }
      if (!isStartablePlan(config)) {
        throw new PrismDomainError(
          `Required pricing plan '${id}' is not available.`,
          "PRICING_REQUIREMENT_UNAVAILABLE",
        );
      }
      for (const dependency of this.requiresOf(id)) visit(dependency);
      ordered.push(id);
    };
    visit(planId);
    return ordered;
  }

  dependentClosureOf(planId: string): ReadonlySet<string> {
    const result = new Set<string>();
    const queue = [planId];
    while (queue.length) {
      const current = queue.shift()!;
      for (const dependent of this.dependents.get(current) ?? []) {
        if (result.has(dependent)) continue;
        result.add(dependent);
        queue.push(dependent);
      }
    }
    return result;
  }

  activeDependentClosure(seeds: readonly string[], activePlanIds: ReadonlySet<string>): string[] {
    const result = new Set<string>();
    const queue = seeds.filter((seed) => activePlanIds.has(seed));
    while (queue.length) {
      const current = queue.shift()!;
      for (const dependent of this.dependents.get(current) ?? []) {
        if (!activePlanIds.has(dependent) || result.has(dependent)) continue;
        result.add(dependent);
        queue.push(dependent);
      }
    }
    return [...result];
  }

  findConflictingActive(planIds: readonly string[], activePlanIds: ReadonlySet<string>): string[] {
    const wanted = new Set(planIds);
    return [...activePlanIds]
      .filter((activeId) => [...(this.conflicts.get(activeId) ?? [])].some((other) => wanted.has(other)))
      .sort();
  }

  assertNoInternalConflicts(planIds: readonly string[]): void {
    const set = new Set(planIds);
    for (const planId of planIds) {
      for (const other of this.conflicts.get(planId) ?? []) {
        if (!set.has(other)) continue;
        throw new PrismDomainError(
          `Pricing plans '${planId}' and '${other}' cannot run at the same time.`,
          "PRICING_RELATION_CONTRADICTION",
        );
      }
    }
  }

  topologicalOrder(planIds: readonly string[]): string[] {
    const requested = new Set(planIds);
    const ordered: string[] = [];
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      for (const dependency of this.requiresOf(id)) {
        if (requested.has(dependency)) visit(dependency);
      }
      ordered.push(id);
    };
    for (const id of planIds) visit(id);
    return ordered;
  }

  reverseTopologicalOrder(planIds: readonly string[]): string[] {
    return this.topologicalOrder(planIds).reverse();
  }
}

/**
 * Builds the graph for one pricing version. Pass every `time.priority` config of
 * the version, enabled or not: relation targets must resolve even when the
 * target is currently switched off.
 */
export function buildPricingRelationGraph(configs: readonly PricingConfig[]): PricingRelationGraph {
  const byId = new Map<string, PricingConfig>();
  for (const config of configs) {
    if (byId.has(config.id)) {
      throw new PrismDomainError(
        `Pricing plan '${config.id}' is declared twice.`,
        "PRICING_RELATION_DUPLICATE_PLAN",
      );
    }
    byId.set(config.id, config);
  }

  const requires = new Map<string, readonly string[]>();
  const conflicts = new Map<string, Set<string>>();

  for (const config of configs) {
    const declared = (config as { relations?: PricingConfigRelations }).relations;
    const hasRelations =
      !!declared && ((declared.requires?.length ?? 0) > 0 || (declared.conflicts?.length ?? 0) > 0);
    if (hasRelations && !isRelatablePricingKind(config.kind)) {
      throw new PrismDomainError(
        `Pricing plan '${config.id}' of kind '${config.kind}' cannot declare relations.`,
        "PRICING_RELATION_UNSUPPORTED_KIND",
      );
    }

    const relations = relationsOf(config);
    for (const field of ["requires", "conflicts"] as const) {
      const values = relations[field];
      if (!Array.isArray(values)) {
        throw new PrismDomainError(
          `Pricing plan '${config.id}' has an invalid ${field} list.`,
          "PRICING_RELATION_INVALID",
        );
      }
      if (new Set(values).size !== values.length) {
        throw new PrismDomainError(
          `Pricing plan '${config.id}' repeats an entry in ${field}.`,
          "PRICING_RELATION_DUPLICATE_REFERENCE",
        );
      }
      for (const target of values) {
        if (target === config.id) {
          throw new PrismDomainError(
            `Pricing plan '${config.id}' references itself in ${field}.`,
            "PRICING_RELATION_SELF_REFERENCE",
          );
        }
        const targetConfig = byId.get(target);
        if (!targetConfig) {
          throw new PrismDomainError(
            `Pricing plan '${config.id}' references unknown plan '${target}'.`,
            "PRICING_RELATION_UNKNOWN_TARGET",
          );
        }
        if (!isRelatablePricingKind(targetConfig.kind)) {
          throw new PrismDomainError(
            `Pricing plan '${config.id}' references '${target}', which is not a time plan.`,
            "PRICING_RELATION_UNSUPPORTED_TARGET",
          );
        }
      }
    }

    requires.set(config.id, relations.requires);
    for (const target of relations.conflicts) {
      const set = conflicts.get(target) ?? new Set<string>();
      set.add(config.id);
      conflicts.set(target, set);
      const own = conflicts.get(config.id) ?? new Set<string>();
      own.add(target);
      conflicts.set(config.id, own);
    }
  }

  detectCycles(requires, byId);
  const graph = new RelationGraph(configs, requires, conflicts);
  assertNoContradictions(graph);
  return graph;
}

function detectCycles(
  requires: ReadonlyMap<string, readonly string[]>,
  byId: ReadonlyMap<string, PricingConfig>,
): void {
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (planId: string) => {
    const current = state.get(planId);
    if (current === "done") return;
    if (current === "visiting") {
      const cycle = [...path.slice(path.indexOf(planId)), planId];
      throw new PrismDomainError(
        `Pricing plans form a requirement cycle: ${cycle.join(" -> ")}.`,
        "PRICING_RELATION_CYCLE",
      );
    }
    state.set(planId, "visiting");
    path.push(planId);
    for (const dependency of requires.get(planId) ?? []) {
      if (byId.has(dependency)) visit(dependency);
    }
    path.pop();
    state.set(planId, "done");
  };
  for (const planId of requires.keys()) visit(planId);
}

/**
 * Rejects a plan whose requirement closure contains two conflicting plans.
 *
 * The closure is the declared one, not the currently startable one: a
 * contradiction must be caught when the configuration is published, even if one
 * of the plans is switched off today.
 */
function assertNoContradictions(graph: PricingRelationGraph): void {
  for (const planId of graph.ids) {
    const closure = new Set<string>();
    const visit = (id: string) => {
      if (closure.has(id)) return;
      closure.add(id);
      for (const dependency of graph.requiresOf(id)) visit(dependency);
    };
    visit(planId);
    for (const id of closure) {
      for (const other of graph.conflictsOf(id)) {
        if (!closure.has(other)) continue;
        throw new PrismDomainError(
          `Pricing plan '${planId}' requires both '${id}' and conflicting plan '${other}'.`,
          "PRICING_RELATION_CONTRADICTION",
        );
      }
    }
  }
}

/** Relations are symmetric: one stored edge forbids both directions. */
export function normalizedConflicts(graph: PricingRelationGraph): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map(graph.ids.map((planId) => [planId, new Set(graph.conflictsOf(planId))]));
}

/** True when every running plan satisfies its own relations. */
export function satisfiesPricingRelations(
  graph: PricingRelationGraph,
  activePlanIds: ReadonlySet<string>,
): boolean {
  for (const planId of activePlanIds) {
    if (!graph.isDeclared(planId)) return false;
    for (const dependency of graph.requiresOf(planId)) {
      if (!activePlanIds.has(dependency)) return false;
    }
    for (const conflict of graph.conflictsOf(planId)) {
      if (activePlanIds.has(conflict)) return false;
    }
  }
  return true;
}
