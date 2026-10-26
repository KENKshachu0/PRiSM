/**
 * Starting a plan for a player, from anywhere.
 *
 * Every start names its target the same way: a resource (whose plan it bills),
 * a plan, or neither (the shop's default plan). The scan page, the front desk,
 * the cashier and the bot all start through `activate`, so a start everywhere
 * has the same preview, the same placeholder rule for a shop without time
 * plans, and the same answer to whether anything new started.
 *
 * Every resource a player uses, with or without hardware, needs its plan to be
 * running for that player in a shop that bills. This service never decides
 * what a resource's hardware may do; capabilities and their business rules
 * (mahjong seats, door codes) stay where they are.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import type {
  CapProgress,
  PricingActivationResult,
  PricingSessionOrchestrator,
  PricingSessionTransitionItem,
} from "@prism/application";
import { buildPricingRelationGraph, isStartablePricingKind, PLACEHOLDER_PRICING_CONFIG_ID, PrismDomainError, type PricingConfig, type Session, type SessionRepository } from "@prism/core";
import { resolveResourcePlanId, shopDefaultPlanId } from "./billing.js";
import { findBillableResource, findResourceGroup } from "./repository.js";

/** What a start names: a resource's plan, a plan, or neither for the shop's default plan. */
export type BillingTarget = {
  playerId: string;
  resourceId?: string;
  pricingConfigId?: string;
};

export type BillingActivation = PricingActivationResult & {
  /** False when the target plan was already billing and nothing new started for it. */
  created: boolean;
};

export type ResourceBillingPreview = {
  resourceId?: string;
  pricingConfigId: string;
  planName: string;
  /** False when the plan already runs and confirming would change nothing. */
  changed: boolean;
  started: PricingSessionTransitionItem[];
  stopped: PricingSessionTransitionItem[];
  kept: PricingSessionTransitionItem[];
  /** Pass back on confirmation so a changed state is refused, not applied. */
  revision: string;
};

/** One plan the scanned resource bills, as the player's release defines it. */
export type ResourcePlanRule = {
  config: PricingConfig;
  /** The resource's own plan, or a plan it requires (directly or through another). */
  role: "resource" | "required";
  /** For a required plan: the plan that requires it. */
  requiredBy?: string;
};

/** Where the resource's plan comes from, and every plan that will bill with it. */
export type ResourcePlanRules = {
  source: { kind: "resource" | "group" | "default"; groupName?: string };
  plans: ResourcePlanRule[];
  /** How far each cap over these plans is used up now; only when asked for. */
  caps?: CapProgress;
};

export type ResourceBilling = {
  /** The plan admission without a scanned resource starts (front desk, cashier, bot login). */
  defaultPlanId(playerId: string): Promise<string>;
  planOf(input: { resourceId: string; playerId: string }): Promise<string>;
  preview(input: BillingTarget): Promise<ResourceBillingPreview>;
  activate(input: BillingTarget & {
    expectedRevision?: string;
    /** Display text only. */
    label?: string;
    metadata?: Record<string, unknown>;
  }): Promise<BillingActivation>;
  /** The plans scanning this resource bills: its own and what that requires. */
  rulesOf(input: { resourceId: string; playerId: string; withCaps?: boolean }): Promise<ResourcePlanRules | null>;
  /** The running session of the resource's plan, or null when the player must confirm first. */
  activeSession(input: { resourceId: string; playerId: string }): Promise<Session | null>;
};

export function createResourceBilling(dependencies: {
  db: D1DatabaseLike;
  shopId: string;
  /** The shop's default plan setting, as stored. */
  defaultPlanIds: () => readonly string[];
  pricingCatalog(playerId: string): Promise<readonly PricingConfig[]>;
  sessions: Pick<SessionRepository, "findActiveByPlayerId">;
  pricingSessions: PricingSessionOrchestrator;
  /**
   * A shop that bills but has no time plan yet keeps one unpriced placeholder
   * session per visit, as it always has; this starts or reuses it.
   */
  startPlaceholder(input: { playerId: string; label?: string; metadata?: Record<string, unknown> }): Promise<Session & { status: "active" }>;
  /** Runs under the player's billing lock, so the target is resolved against the state it changes. */
  withPlayerLock<T>(playerId: string, action: () => Promise<T>): Promise<T>;
  /** The caps over some plans of the player's release, counting what was charged in their windows so far. */
  capProgress?(input: { playerId: string | null; configs: readonly PricingConfig[]; planIds: readonly string[] }): Promise<CapProgress>;
  now: () => Date;
}): ResourceBilling {
  const unpriced = async (playerId: string) =>
    !(await dependencies.pricingCatalog(playerId)).some((config) => config.kind === "time.priority");
  const placeholderOf = async (playerId: string) =>
    (await dependencies.sessions.findActiveByPlayerId(playerId)).find((session) => !session.pricingConfigId) ?? null;
  const unpricedTransition = (changed: boolean) => ({
    action: "activate" as const,
    targetPricingConfigId: PLACEHOLDER_PRICING_CONFIG_ID,
    started: [],
    stopped: [],
    kept: [],
    revision: "",
    changed,
    at: dependencies.now(),
  });
  const defaultOf = async (playerId: string) =>
    shopDefaultPlanId(dependencies.defaultPlanIds(), await dependencies.pricingCatalog(playerId));

  async function bindingOf(input: { resourceId: string; playerId: string }) {
    const resource = await findBillableResource(dependencies.db, dependencies.shopId, input.resourceId);
    if (!resource) throw new PrismDomainError("没有找到这个资源", "DEVICE_NOT_FOUND");
    const group = resource.groupId ? await findResourceGroup(dependencies.db, dependencies.shopId, resource.groupId) : null;
    // The default plan is only needed, and only computed, for the default group.
    const defaultPlanId = resource.groupId || resource.pricingConfigOverrideId ? null : await defaultOf(input.playerId);
    const planId = resolveResourcePlanId({ resource, group, defaultPlanId });
    const source: ResourcePlanRules["source"] = resource.pricingConfigOverrideId
      ? { kind: "resource" }
      : group
        ? { kind: "group", groupName: group.name }
        : { kind: "default" };
    return { planId, source };
  }

  const planOf = async (input: { resourceId: string; playerId: string }) => (await bindingOf(input)).planId;

  async function defaultPlanId(playerId: string) {
    const planId = await defaultOf(playerId);
    if (!planId) throw new PrismDomainError("请店家先设置默认计费方案", "ENTRY_PRICING_REQUIRED");
    return planId;
  }

  const targetPlanOf = (target: BillingTarget) =>
    target.resourceId
      ? planOf({ resourceId: target.resourceId, playerId: target.playerId })
      : target.pricingConfigId
        ? Promise.resolve(target.pricingConfigId)
        : defaultPlanId(target.playerId);

  return {
    defaultPlanId,

    planOf,

    async preview(input) {
      const resource = input.resourceId ? { resourceId: input.resourceId } : {};
      if (await unpriced(input.playerId)) {
        return {
          ...resource,
          pricingConfigId: PLACEHOLDER_PRICING_CONFIG_ID,
          planName: "计费",
          ...unpricedTransition(!(await placeholderOf(input.playerId))),
        };
      }
      const pricingConfigId = await targetPlanOf(input);
      const transition = await dependencies.pricingSessions.previewActivate({ playerId: input.playerId, pricingConfigId });
      const catalog = await dependencies.pricingCatalog(input.playerId);
      return {
        ...resource,
        pricingConfigId,
        planName: catalog.find((config) => config.id === pricingConfigId)?.name ?? pricingConfigId,
        changed: transition.changed,
        started: transition.started,
        stopped: transition.stopped,
        kept: transition.kept,
        revision: transition.revision,
      };
    },

    activate(input) {
      return dependencies.withPlayerLock(input.playerId, async () => {
        if (await unpriced(input.playerId)) {
          const running = await placeholderOf(input.playerId);
          const session = running
            ? { ...running, status: "active" as const }
            : await dependencies.startPlaceholder({
                playerId: input.playerId,
                ...(input.label ? { label: input.label } : {}),
                ...(input.metadata ? { metadata: input.metadata } : {}),
              });
          return { ...unpricedTransition(!running), session, created: !running };
        }
        const pricingConfigId = await targetPlanOf(input);
        // A session started for a resource remembers it: a mahjong seat ends
        // the waiting session on getting up only when it was started for that table.
        const metadata = input.resourceId ? { ...input.metadata, resourceId: input.resourceId } : input.metadata;
        const result = await dependencies.pricingSessions.activate({
          playerId: input.playerId,
          pricingConfigId,
          ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
          ...(input.label ? { label: input.label } : {}),
          ...(metadata ? { metadata } : {}),
        });
        return { ...result, created: result.started.some((item) => item.planId === pricingConfigId) };
      });
    },

    async rulesOf(input) {
      if (await unpriced(input.playerId)) return null;
      const { planId, source } = await bindingOf(input);
      const catalog = await dependencies.pricingCatalog(input.playerId);
      const graph = buildPricingRelationGraph(catalog.filter((config) => isStartablePricingKind(config.kind)));
      const byId = new Map(catalog.map((config) => [config.id, config]));
      // Dependencies first from the graph; the resource's own plan leads on the page.
      const closure = graph.requireClosure(planId).reverse();
      const caps = input.withCaps && dependencies.capProgress
        ? await dependencies.capProgress({ playerId: input.playerId || null, configs: catalog, planIds: closure })
        : undefined;
      return {
        source,
        ...(caps ? { caps } : {}),
        plans: closure.map((id) => {
          const requiredBy = id === planId ? undefined : closure.find((other) => graph.requiresOf(other).includes(id));
          return {
            config: byId.get(id)!,
            role: id === planId ? "resource" as const : "required" as const,
            ...(requiredBy ? { requiredBy: byId.get(requiredBy)?.name ?? requiredBy } : {}),
          };
        }),
      };
    },

    async activeSession(input) {
      if (await unpriced(input.playerId)) return placeholderOf(input.playerId);
      const pricingConfigId = await planOf(input);
      const active = await dependencies.sessions.findActiveByPlayerId(input.playerId);
      return active.find((session) => session.pricingConfigId === pricingConfigId) ?? null;
    },
  };
}
