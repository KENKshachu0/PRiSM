import { describe, expect, it } from "bun:test";
import {
  activePlanSessions,
  buildPricingRelationGraph,
  lifecyclePlanIdOf,
  planActivation,
  planDeactivation,
  PrismDomainError,
  transitionRevision,
  type ActivePlanSession,
  type PricingConfig,
  type PricingConfigRelations,
  type Session,
} from "../src/index";

const at = new Date("2026-10-01T00:00:00.000Z");

function plan(id: string, relations?: PricingConfigRelations, enabled = true): PricingConfig {
  return {
    id,
    kind: "time.priority",
    name: id,
    enabled,
    status: "active",
    provider: {
      id: `provider-${id}`,
      rules: [
        {
          id: "rule",
          label: "全天",
          priority: 0,
          timeRange: { start: "00:00", end: "00:00" },
          pricing: { unitMinutes: 60, unitPrice: 13, roundGraceMinutes: 0, priceCap: 1000 },
        },
      ],
    },
    ...(relations ? { relations } : {}),
    createdAt: at,
    updatedAt: at,
  };
}

/** normal-play, eight-seat and four-seat mahjong as in the design document. */
const mahjongGraph = () =>
  buildPricingRelationGraph([
    plan("normal-play"),
    plan("mahjong-eight", { requires: ["normal-play"], conflicts: ["mahjong-four"] }),
    plan("mahjong-four", { requires: ["normal-play"], conflicts: ["mahjong-eight"] }),
    plan("private-room"),
  ]);

const active = (planId: string, minutes = 0): ActivePlanSession => ({
  planId,
  sessionId: `session-${planId}`,
  startedAt: new Date(at.getTime() + minutes * 60_000),
});

const session = (planId: string, overrides: Partial<Session> = {}): Session => ({
  id: `session-${planId}`,
  playerId: "player-1",
  startedAt: at,
  status: "active",
  pricingConfigId: planId,
  ...overrides,
});

const codeOf = (run: () => unknown): string | null => {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof PrismDomainError ? error.code : String(error);
  }
};

describe("session ownership", () => {
  it("is the session's own plan, never inferred from anything else", () => {
    expect(lifecyclePlanIdOf({ id: "s", playerId: "p", startedAt: at, pricingConfigId: "plan" })).toBe("plan");
    expect(lifecyclePlanIdOf({ id: "s", playerId: "p", startedAt: at, pricingConfigId: "" })).toBeNull();
    expect(lifecyclePlanIdOf({ id: "s", playerId: "p", startedAt: at })).toBeNull();
    // A label never names a plan.
    expect(lifecyclePlanIdOf({
      id: "s", playerId: "p", startedAt: at, label: "entry", metadata: { entry: true },
    })).toBeNull();
  });

  it("groups active sessions by plan, keeping the earliest and ignoring closed sessions", () => {
    const grouped = activePlanSessions([
      session("base", { id: "late", startedAt: new Date(at.getTime() + 60_000) }),
      session("base", { id: "early", startedAt: at }),
      session("addon"),
      session("closed", { status: "closed", endedAt: at }),
    ]);
    expect(grouped).toEqual([
      { planId: "addon", sessionId: "session-addon", startedAt: at },
      { planId: "base", sessionId: "early", startedAt: at },
    ]);
  });
});

describe("transitionRevision", () => {
  it("is stable under ordering but changes with the state", () => {
    expect(transitionRevision([active("b"), active("a")])).toBe(transitionRevision([active("a"), active("b")]));
    expect(transitionRevision([active("a")])).not.toBe(transitionRevision([active("a", 5)]));
  });
});

describe("planActivation", () => {
  it("starts a plan and its dependencies when nothing runs", () => {
    const result = planActivation({
      targetPricingConfigId: "mahjong-eight",
      active: [],
      graph: mahjongGraph(),
    });
    expect(result.startPlanIds).toEqual(["normal-play", "mahjong-eight"]);
    expect(result.stopPlanIds).toEqual([]);
    expect(result.keepPlanIds).toEqual([]);
    expect(result.reasonByPlanId["normal-play"]).toBe("required-by-mahjong-eight");
  });

  it("reuses a running dependency instead of restarting it", () => {
    const result = planActivation({
      targetPricingConfigId: "mahjong-eight",
      active: [active("normal-play")],
      graph: mahjongGraph(),
    });
    expect(result.startPlanIds).toEqual(["mahjong-eight"]);
    expect(result.keepPlanIds).toEqual(["normal-play"]);
    expect(result.stopPlanIds).toEqual([]);
  });

  it("switches conflicting plans and keeps the shared base running", () => {
    const result = planActivation({
      targetPricingConfigId: "mahjong-four",
      active: [active("normal-play"), active("mahjong-eight", 70)],
      graph: mahjongGraph(),
    });
    expect(result.startPlanIds).toEqual(["mahjong-four"]);
    expect(result.stopPlanIds).toEqual(["mahjong-eight"]);
    expect(result.keepPlanIds).toEqual(["normal-play"]);
  });

  it("stops the dependents of a conflicting plan too", () => {
    const graph = buildPricingRelationGraph([
      plan("base"),
      plan("mid", { requires: ["base"], conflicts: [] }),
      plan("top", { requires: ["mid"], conflicts: ["other"] }),
      plan("other"),
    ]);
    const result = planActivation({
      targetPricingConfigId: "other",
      active: [active("base"), active("mid"), active("top")],
      graph,
    });
    expect(result.startPlanIds).toEqual(["other"]);
    expect(result.stopPlanIds).toEqual(["top"]);
    // `mid` depends on nothing that stops, so it keeps running.
    expect(result.keepPlanIds).toEqual(["base", "mid"]);
  });

  it("stops a conflicting plan together with everything that depends on it", () => {
    const graph = buildPricingRelationGraph([
      plan("base"),
      plan("addon", { requires: ["base"], conflicts: [] }),
      plan("rival", { requires: [], conflicts: ["base"] }),
    ]);
    const result = planActivation({
      targetPricingConfigId: "rival",
      active: [active("base"), active("addon")],
      graph,
    });
    expect(result.startPlanIds).toEqual(["rival"]);
    expect(result.stopPlanIds).toEqual(["addon", "base"]);
  });

  it("starts shared dependencies once for several requested plans", () => {
    const graph = buildPricingRelationGraph([
      plan("base"),
      plan("left", { requires: ["base"], conflicts: [] }),
      plan("right", { requires: ["base"], conflicts: [] }),
    ]);
    const result = planActivation({
      targetPricingConfigId: "left",
      alsoActivate: ["right"],
      active: [],
      graph,
    });
    expect(result.startPlanIds).toEqual(["base", "left", "right"]);
    expect(result.targetPricingConfigIds).toEqual(["left", "right"]);
  });

  it("is a no-op when the target already runs", () => {
    const result = planActivation({
      targetPricingConfigId: "mahjong-eight",
      active: [active("normal-play"), active("mahjong-eight")],
      graph: mahjongGraph(),
    });
    expect(result.startPlanIds).toEqual([]);
    expect(result.stopPlanIds).toEqual([]);
    expect(result.keepPlanIds).toEqual(["mahjong-eight", "normal-play"]);
  });

  it("lets two independent plans run together", () => {
    const result = planActivation({
      targetPricingConfigId: "private-room",
      active: [active("normal-play")],
      graph: mahjongGraph(),
    });
    expect(result.startPlanIds).toEqual(["private-room"]);
    expect(result.keepPlanIds).toEqual(["normal-play"]);
  });

  it("refuses an unknown target and an unavailable dependency", () => {
    const graph = mahjongGraph();
    expect(codeOf(() => planActivation({ targetPricingConfigId: "missing", active: [], graph })))
      .toBe("PRICING_PLAN_NOT_FOUND");

    const disabled = buildPricingRelationGraph([
      plan("base", undefined, false),
      plan("addon", { requires: ["base"], conflicts: [] }),
    ]);
    expect(codeOf(() => planActivation({ targetPricingConfigId: "addon", active: [], graph: disabled })))
      .toBe("PRICING_REQUIREMENT_UNAVAILABLE");
  });
});

describe("planDeactivation", () => {
  it("stops dependents with the target and leaves unrelated plans running", () => {
    const result = planDeactivation({
      targetPricingConfigId: "normal-play",
      active: [active("normal-play"), active("mahjong-eight"), active("private-room")],
      graph: mahjongGraph(),
    });
    expect(result.stopPlanIds).toEqual(["mahjong-eight", "normal-play"]);
    expect(result.stopSessionIds).toEqual(["session-mahjong-eight", "session-normal-play"]);
    expect(result.keepPlanIds).toEqual(["private-room"]);
    expect(result.alreadyInactive).toBe(false);
  });

  it("stops only the add-on, never the plan it requires", () => {
    const result = planDeactivation({
      targetPricingConfigId: "mahjong-eight",
      active: [active("normal-play"), active("mahjong-eight")],
      graph: mahjongGraph(),
    });
    expect(result.stopPlanIds).toEqual(["mahjong-eight"]);
    expect(result.keepPlanIds).toEqual(["normal-play"]);
  });

  it("stops every transitive dependent", () => {
    const graph = buildPricingRelationGraph([
      plan("a"),
      plan("b", { requires: ["a"], conflicts: [] }),
      plan("c", { requires: ["b"], conflicts: [] }),
    ]);
    const result = planDeactivation({
      targetPricingConfigId: "a",
      active: [active("a"), active("b"), active("c")],
      graph,
    });
    expect(result.stopPlanIds).toEqual(["c", "b", "a"]);
  });

  it("is idempotent when nothing is running", () => {
    const result = planDeactivation({
      targetPricingConfigId: "mahjong-eight",
      active: [],
      graph: mahjongGraph(),
    });
    expect(result.alreadyInactive).toBe(true);
    expect(result.stopSessionIds).toEqual([]);
    expect(result.startPlanIds).toEqual([]);
  });
});
