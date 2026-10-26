import { describe, expect, it } from "bun:test";
import {
  buildPricingRelationGraph,
  emptyPricingConfigRelations,
  isRelatablePricingKind,
  isStartablePricingKind,
  normalizedConflicts,
  PrismDomainError,
  relationsOf,
  satisfiesPricingRelations,
  type PricingConfig,
  type PricingConfigRelations,
} from "../src/index";

const at = new Date("2026-10-01T00:00:00.000Z");

function plan(
  id: string,
  relations?: PricingConfigRelations,
  overrides: Partial<{ enabled: boolean; status: "active" | "archived" }> = {},
): PricingConfig {
  return {
    id,
    kind: "time.priority",
    name: id,
    enabled: overrides.enabled ?? true,
    status: overrides.status ?? "active",
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

const rel = (requires: string[], conflicts: string[] = []): PricingConfigRelations => ({ requires, conflicts });

const codeOf = (run: () => unknown): string | null => {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof PrismDomainError ? error.code : String(error);
  }
};

describe("pricing relation vocabulary", () => {
  it("runs time plans and fixed charges as sessions, and relates only time plans", () => {
    expect(isRelatablePricingKind("time.priority")).toBe(true);
    expect(isRelatablePricingKind("charge.fixed")).toBe(false);
    expect(isRelatablePricingKind("time.cap")).toBe(false);
    // A fixed charge runs as a session of its own, billed once; a cap never runs.
    expect(isStartablePricingKind("time.priority")).toBe(true);
    expect(isStartablePricingKind("charge.fixed")).toBe(true);
    expect(isStartablePricingKind("time.cap")).toBe(false);

    const fixed: PricingConfig = {
      id: "ticket",
      kind: "charge.fixed",
      name: "门票",
      enabled: true,
      provider: { id: "ticket", label: "门票", amount: 10 },
      createdAt: at,
      updatedAt: at,
    };
    expect(relationsOf(fixed)).toEqual({ requires: [], conflicts: [] });
    expect(emptyPricingConfigRelations()).toEqual({ requires: [], conflicts: [] });
  });

  it("reads a plan's declared relations without defaulting them away", () => {
    expect(relationsOf(plan("a", rel(["b"], ["c"])))).toEqual({ requires: ["b"], conflicts: ["c"] });
    expect(relationsOf(plan("a"))).toEqual({ requires: [], conflicts: [] });
  });
});

describe("buildPricingRelationGraph", () => {
  it("builds the normal-play / mahjong configuration from the design", () => {
    const graph = buildPricingRelationGraph([
      plan("normal-play"),
      plan("mahjong-eight", rel(["normal-play"], ["mahjong-four"])),
      plan("mahjong-four", rel(["normal-play"], ["mahjong-eight"])),
      plan("private-room"),
    ]);

    expect(graph.requireClosure("mahjong-eight")).toEqual(["normal-play", "mahjong-eight"]);
    expect(graph.requireClosure("normal-play")).toEqual(["normal-play"]);
    expect(graph.conflictsOf("mahjong-eight")).toEqual(["mahjong-four"]);
    expect(graph.dependentClosureOf("normal-play")).toEqual(new Set(["mahjong-eight", "mahjong-four"]));
  });

  it("treats a single stored conflict edge as symmetric", () => {
    const graph = buildPricingRelationGraph([
      plan("a"),
      plan("b", rel([], ["a"])),
    ]);
    expect(graph.conflictsOf("a")).toEqual(["b"]);
    expect(graph.conflictsOf("b")).toEqual(["a"]);
    expect(normalizedConflicts(graph).get("a")).toEqual(new Set(["b"]));
    expect(normalizedConflicts(graph).get("b")).toEqual(new Set(["a"]));
  });

  it("rejects self references, duplicates, unknown and unstartable targets", () => {
    expect(codeOf(() => buildPricingRelationGraph([plan("a", rel(["a"]))]))).toBe("PRICING_RELATION_SELF_REFERENCE");
    expect(codeOf(() => buildPricingRelationGraph([plan("a", rel([], ["a"]))]))).toBe("PRICING_RELATION_SELF_REFERENCE");
    expect(codeOf(() => buildPricingRelationGraph([plan("a"), plan("b", rel(["a", "a"]))])))
      .toBe("PRICING_RELATION_DUPLICATE_REFERENCE");
    expect(codeOf(() => buildPricingRelationGraph([plan("a", rel(["missing"]))])))
      .toBe("PRICING_RELATION_UNKNOWN_TARGET");
    expect(codeOf(() => buildPricingRelationGraph([
      { id: "cap", kind: "time.cap", name: "封顶", enabled: true, provider: { id: "cap", includedPricingConfigIds: ["a"], rules: [] }, createdAt: at, updatedAt: at },
      plan("a", rel(["cap"])),
    ]))).toBe("PRICING_RELATION_UNSUPPORTED_TARGET");
  });

  it("rejects relations declared on a kind that cannot be active", () => {
    expect(codeOf(() => buildPricingRelationGraph([
      {
        id: "cap",
        kind: "time.cap",
        name: "封顶",
        enabled: true,
        provider: { id: "cap", includedPricingConfigIds: ["a"], rules: [] },
        relations: { requires: ["a"], conflicts: [] },
        createdAt: at,
        updatedAt: at,
      } as PricingConfig,
      plan("a"),
    ] as unknown as PricingConfig[]))).toBe("PRICING_RELATION_UNSUPPORTED_KIND");
  });

  it("rejects direct and transitive requirement cycles", () => {
    expect(codeOf(() => buildPricingRelationGraph([
      plan("a", rel(["b"])),
      plan("b", rel(["a"])),
    ]))).toBe("PRICING_RELATION_CYCLE");

    expect(codeOf(() => buildPricingRelationGraph([
      plan("a", rel(["b"])),
      plan("b", rel(["c"])),
      plan("c", rel(["a"])),
    ]))).toBe("PRICING_RELATION_CYCLE");
  });

  it("rejects direct and transitive contradictions", () => {
    expect(codeOf(() => buildPricingRelationGraph([
      plan("a", rel(["b"], ["b"])),
      plan("b"),
    ]))).toBe("PRICING_RELATION_CONTRADICTION");

    expect(codeOf(() => buildPricingRelationGraph([
      plan("a", rel(["b"], ["c"])),
      plan("b", rel(["c"])),
      plan("c"),
    ]))).toBe("PRICING_RELATION_CONTRADICTION");
  });

  it("keeps an archived or disabled target resolvable but not startable", () => {
    const graph = buildPricingRelationGraph([
      plan("normal-play", undefined, { enabled: false }),
      plan("mahjong-eight", rel(["normal-play"])),
    ]);
    expect(graph.isDeclared("normal-play")).toBe(true);
    expect(graph.isStartable("normal-play")).toBe(false);
    expect(() => graph.requireClosure("mahjong-eight")).toThrow(
      expect.objectContaining({ code: "PRICING_REQUIREMENT_UNAVAILABLE" }) as PrismDomainError,
    );
  });

  it("refuses to start a plan that does not exist", () => {
    const graph = buildPricingRelationGraph([plan("a")]);
    expect(() => graph.requireClosure("missing")).toThrow(
      expect.objectContaining({ code: "PRICING_PLAN_NOT_FOUND" }) as PrismDomainError,
    );
  });

  it("starts a fixed charge on its own, but keeps it out of relations", () => {
    const ticket = { id: "ticket", kind: "charge.fixed", name: "门票", enabled: true, provider: { id: "ticket", label: "门票", amount: 10 }, createdAt: at, updatedAt: at } as PricingConfig;
    expect(buildPricingRelationGraph([plan("a"), ticket]).requireClosure("ticket")).toEqual(["ticket"]);
    expect(codeOf(() => buildPricingRelationGraph([ticket, plan("a", rel(["ticket"]))]))).toBe("PRICING_RELATION_UNSUPPORTED_TARGET");
  });

  it("orders starts dependencies-first and stops dependents-first", () => {
    const graph = buildPricingRelationGraph([
      plan("a"),
      plan("b", rel(["a"])),
      plan("c", rel(["b"])),
    ]);
    expect(graph.topologicalOrder(["c", "b", "a"])).toEqual(["a", "b", "c"]);
    expect(graph.reverseTopologicalOrder(["a", "b", "c"])).toEqual(["c", "b", "a"]);
  });

  it("reports whether a live plan set still satisfies every relation", () => {
    const graph = buildPricingRelationGraph([
      plan("base"),
      plan("addon", rel(["base"], ["other"])),
      plan("other"),
    ]);
    expect(satisfiesPricingRelations(graph, new Set(["base", "addon"]))).toBe(true);
    expect(satisfiesPricingRelations(graph, new Set(["addon"]))).toBe(false);
    expect(satisfiesPricingRelations(graph, new Set(["base", "addon", "other"]))).toBe(false);
    expect(satisfiesPricingRelations(graph, new Set(["base", "unknown"]))).toBe(false);
  });
});
