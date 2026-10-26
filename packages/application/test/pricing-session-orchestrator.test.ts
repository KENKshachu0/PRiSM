import { describe, expect, it } from "bun:test";
import {
  PrismDomainError,
  type PricingConfig,
  type PricingConfigRelations,
  type Session,
  type SessionRepository,
  type SessionTransitionWrite,
} from "@prism/core";
import { createPricingSessionOrchestrator } from "../src/index";

const T0 = new Date("2026-10-24T00:00:00.000Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

/** Sessions with the two guarantees the SQL repository gives: one batch, one active session per plan. */
class MemorySessions implements SessionRepository {
  rows = new Map<string, Session>();
  transitions: SessionTransitionWrite[] = [];

  async findActiveByPlayerId(playerId: string) {
    return [...this.rows.values()].filter((s) => s.playerId === playerId && s.status === "active").map((s) => ({ ...s }));
  }
  async findById(id: string) {
    return this.rows.get(id) ?? null;
  }
  async findUnpaidClosedByPlayerId(playerId: string) {
    return [...this.rows.values()].filter((s) => s.playerId === playerId && s.status === "closed" && s.paymentStatus === "unpaid");
  }
  async save(session: Session) {
    this.rows.set(session.id, { ...session });
  }
  async applyTransition(write: SessionTransitionWrite) {
    const next = new Map(this.rows);
    for (const session of write.close) {
      if (next.get(session.id)?.status === "active") next.set(session.id, { ...session });
    }
    for (const session of write.create) {
      const duplicate = [...next.values()].some(
        (s) => s.status === "active" && s.playerId === session.playerId && s.pricingConfigId === session.pricingConfigId,
      );
      if (duplicate) throw new PrismDomainError("duplicate", "PRICING_PLAN_ALREADY_ACTIVE");
      next.set(session.id, { ...session });
    }
    this.rows = next;
    this.transitions.push(write);
  }
  active() {
    return [...this.rows.values()].filter((s) => s.status === "active");
  }
}

function plan(id: string, relations?: Partial<PricingConfigRelations>, enabled = true): PricingConfig {
  return {
    id,
    kind: "time.priority",
    name: id,
    enabled,
    status: "active",
    provider: {
      id: `time.${id}`,
      rules: [{
        id: "all-day",
        label: "All day",
        priority: 0,
        timeRange: { start: "00:00", end: "00:00" },
        pricing: { unitMinutes: 60, unitPrice: 1, roundGraceMinutes: 0, priceCap: 100 },
      }],
    },
    relations: { requires: relations?.requires ?? [], conflicts: relations?.conflicts ?? [] },
    createdAt: T0,
    updatedAt: T0,
  };
}

const mahjongShop = [
  plan("base"),
  plan("eight", { requires: ["base"], conflicts: ["four"] }),
  plan("four", { requires: ["base"] }),
  plan("rest", { requires: ["base"], conflicts: ["eight"] }),
];

function setup(configs: PricingConfig[] = mahjongShop, options: { canStart?: (id: string) => boolean } = {}) {
  const sessions = new MemorySessions();
  let clock = T0;
  let seq = 0;
  const orchestrator = createPricingSessionOrchestrator({
    sessions,
    pricingCatalog: async () => configs,
    canStartPlanAt: options.canStart ? ({ config }) => options.canStart!(config.id) : undefined,
    now: () => clock,
    id: () => `id-${++seq}`,
  });
  return { sessions, orchestrator, at: (date: Date) => (clock = date) };
}

const plans = (sessions: Session[]) => sessions.map((s) => s.pricingConfigId).sort();

describe("pricing session orchestrator", () => {
  it("starts what a plan requires, dependencies first, in one transition", async () => {
    const { sessions, orchestrator } = setup();
    const result = await orchestrator.activate({ playerId: "p", pricingConfigId: "eight", label: "八口机" });

    expect(result.started.map((item) => item.planId)).toEqual(["base", "eight"]);
    expect(result.started[0]!.reason).toBe("required-by-eight");
    expect(result.session.pricingConfigId).toBe("eight");
    expect(plans(sessions.active())).toEqual(["base", "eight"]);
    expect(sessions.transitions).toHaveLength(1);
    expect(sessions.active().find((s) => s.pricingConfigId === "base")?.label).toBeUndefined();
  });

  it("reuses a running requirement without restarting its clock", async () => {
    const { sessions, orchestrator, at } = setup();
    await orchestrator.activate({ playerId: "p", pricingConfigId: "base" });
    at(minutes(70));
    await orchestrator.activate({ playerId: "p", pricingConfigId: "eight" });

    expect(sessions.active().find((s) => s.pricingConfigId === "base")?.startedAt).toEqual(T0);
    expect(sessions.active().find((s) => s.pricingConfigId === "eight")?.startedAt).toEqual(minutes(70));
  });

  it("switches between conflicting add-ons at one instant and keeps the base running", async () => {
    const { sessions, orchestrator, at } = setup();
    await orchestrator.activate({ playerId: "p", pricingConfigId: "eight" });
    at(minutes(50));
    const result = await orchestrator.activate({ playerId: "p", pricingConfigId: "four" });

    expect(result.stopped.map((item) => item.planId)).toEqual(["eight"]);
    expect(result.kept.map((item) => item.planId)).toEqual(["base"]);
    const eight = [...sessions.rows.values()].find((s) => s.pricingConfigId === "eight")!;
    const four = sessions.active().find((s) => s.pricingConfigId === "four")!;
    expect(eight).toMatchObject({ status: "closed", paymentStatus: "unpaid", endedAt: minutes(50) });
    expect(four.startedAt).toEqual(minutes(50));
    expect(sessions.active().find((s) => s.pricingConfigId === "base")?.startedAt).toEqual(T0);
  });

  it("treats a conflict declared on one side as forbidding both directions", async () => {
    const { sessions, orchestrator } = setup();
    await orchestrator.activate({ playerId: "p", pricingConfigId: "rest" });
    await orchestrator.activate({ playerId: "p", pricingConfigId: "eight" });
    expect(plans(sessions.active())).toEqual(["base", "eight"]);
    await orchestrator.activate({ playerId: "p", pricingConfigId: "rest" });
    expect(plans(sessions.active())).toEqual(["base", "rest"]);
  });

  it("does nothing on a repeated activation", async () => {
    const { sessions, orchestrator } = setup();
    const first = await orchestrator.activate({ playerId: "p", pricingConfigId: "eight" });
    const again = await orchestrator.activate({ playerId: "p", pricingConfigId: "eight" });

    expect(again.changed).toBe(false);
    expect(again.session.id).toBe(first.session.id);
    expect(sessions.transitions).toHaveLength(1);
  });

  it("stops an add-on alone, but stopping the base stops what requires it", async () => {
    const { sessions, orchestrator } = setup();
    await orchestrator.activate({ playerId: "p", pricingConfigId: "eight" });

    await orchestrator.deactivate({ playerId: "p", pricingConfigId: "eight" });
    expect(plans(sessions.active())).toEqual(["base"]);

    await orchestrator.activate({ playerId: "p", pricingConfigId: "four" });
    const stopped = await orchestrator.deactivate({ playerId: "p", pricingConfigId: "base" });
    expect(stopped.stopped.map((item) => item.planId)).toEqual(["four", "base"]);
    expect(sessions.active()).toEqual([]);
    expect(stopped.closed.every((s) => s.paymentStatus === "unpaid")).toBe(true);

    const idle = await orchestrator.deactivate({ playerId: "p", pricingConfigId: "base" });
    expect(idle.changed).toBe(false);
  });

  it("previews without writing and refuses a confirmation planned from a stale state", async () => {
    const { sessions, orchestrator } = setup();
    const preview = await orchestrator.previewActivate({ playerId: "p", pricingConfigId: "eight" });
    expect(preview.started.map((item) => item.planId)).toEqual(["base", "eight"]);
    expect(sessions.rows.size).toBe(0);

    await orchestrator.activate({ playerId: "p", pricingConfigId: "base" });
    await expect(
      orchestrator.activate({ playerId: "p", pricingConfigId: "eight", expectedRevision: preview.revision }),
    ).rejects.toMatchObject({ code: "PRICING_STATE_REVISION_MISMATCH" });
    expect(plans(sessions.active())).toEqual(["base"]);
  });

  it("refuses a plan outside the player's release or one whose requirement is unavailable", async () => {
    const { orchestrator } = setup([plan("base", {}, false), plan("eight", { requires: ["base"] })]);
    await expect(orchestrator.activate({ playerId: "p", pricingConfigId: "missing" })).rejects.toMatchObject({
      code: "PRICING_PLAN_NOT_FOUND",
    });
    await expect(orchestrator.activate({ playerId: "p", pricingConfigId: "eight" })).rejects.toMatchObject({
      code: "PRICING_REQUIREMENT_UNAVAILABLE",
    });
  });

  it("refuses to start a plan outside its billable hours and writes nothing", async () => {
    const { sessions, orchestrator } = setup(mahjongShop, { canStart: (id) => id !== "eight" });
    await expect(orchestrator.activate({ playerId: "p", pricingConfigId: "eight" })).rejects.toMatchObject({
      code: "PLAYER_SESSION_OUTSIDE_BILLABLE_TIME",
    });
    expect(sessions.rows.size).toBe(0);
  });

  it("repairs a state that breaks the relations only when the caller confirms the preview", async () => {
    const { sessions, orchestrator } = setup();
    // Two conflicting plans running at once, as after a relation was added mid-visit.
    for (const [id, planId] of [["b", "base"], ["e", "eight"], ["r", "rest"]] as const) {
      await sessions.save({ id, playerId: "p", startedAt: T0, status: "active", paymentStatus: "unpaid", pricingConfigIds: [planId], pricingConfigId: planId });
    }
    await expect(orchestrator.activate({ playerId: "p", pricingConfigId: "rest" })).rejects.toMatchObject({
      code: "PRICING_STATE_INCONSISTENT",
    });
    const preview = await orchestrator.previewActivate({ playerId: "p", pricingConfigId: "rest" });
    await orchestrator.activate({ playerId: "p", pricingConfigId: "rest", expectedRevision: preview.revision });
    expect(plans(sessions.active())).toEqual(["base", "rest"]);
  });

  it("writes a switch as sessions closed and opened at one instant", async () => {
    const { sessions, orchestrator, at } = setup();
    await orchestrator.activate({ playerId: "p", pricingConfigId: "eight" });
    at(minutes(30));
    await orchestrator.activate({ playerId: "p", pricingConfigId: "four" });
    const write = sessions.transitions.at(-1)!;
    expect(write.close.map((s) => [s.pricingConfigId, s.endedAt])).toEqual([["eight", minutes(30)]]);
    expect(write.create.map((s) => [s.pricingConfigId, s.startedAt])).toEqual([["four", minutes(30)]]);
  });

  it("lists running plans and what may start", async () => {
    const { orchestrator } = setup();
    await orchestrator.activate({ playerId: "p", pricingConfigId: "four" });
    const state = await orchestrator.getActive("p");
    expect(state.active.map((entry) => entry.planId)).toEqual(["base", "four"]);
    expect(state.available.find((entry) => entry.planId === "eight")).toMatchObject({ requires: ["base"], conflicts: ["four"] });
  });
});
