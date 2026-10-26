import { describe, expect, it } from "bun:test";
import type { PricingConfig, PricingConfigRepository } from "@prism/core";
import { createStaffPricingService } from "../src/index";

class MemoryPricingConfigRepository implements PricingConfigRepository {
  saved: PricingConfig[] = [];

  async save(config: PricingConfig): Promise<void> {
    this.saved = [config, ...this.saved.filter((existing) => existing.id !== config.id)];
  }

  async findById(configId: string): Promise<PricingConfig | null> {
    return this.saved.find((config) => config.id === configId) ?? null;
  }

  async listAll(): Promise<PricingConfig[]> {
    return this.saved.map((config) => ({ ...config }));
  }

  async listEnabled(): Promise<PricingConfig[]> {
    return this.saved
      .filter((config) => config.enabled && (config.status ?? "active") === "active")
      .map((config) => ({ ...config }));
  }
}

describe("createStaffPricingService", () => {
  it("creates and lists configurable pricing providers for staff management", async () => {
    const pricingConfigs = new MemoryPricingConfigRepository();
    const service = createStaffPricingService({
      pricingConfigs,
      id: () => "pricing-1",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    const config = await service.createPricingConfig({
      kind: "time.priority",
      name: "Default time pricing",
      enabled: true,
      provider: {
        id: "time.default",
        rules: [
          {
            id: "base",
            label: "Base",
            priority: 0,
            timeRange: {
              start: "00:00",
              end: "00:00",
            },
            pricing: {
              unitMinutes: 30,
              unitPrice: 10,
              roundGraceMinutes: 5,
              priceCap: 80,
            },
          },
        ],
      },
    });

    expect(config).toEqual({
      id: "pricing-1",
      kind: "time.priority",
      name: "Default time pricing",
      enabled: true,
      status: "active",
      provider: {
        id: "time.default",
        timeZone: "UTC",
        rules: [
          {
            id: "base",
            label: "Base",
            priority: 0,
            timeRange: {
              start: "00:00",
              end: "00:00",
            },
            pricing: {
              unitMinutes: 30,
              unitPrice: 10,
              roundGraceMinutes: 5,
              priceCap: 80,
            },
          },
        ],
      },
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
      updatedAt: new Date("2026-06-07T10:00:00.000Z"),
    });
    expect(pricingConfigs.saved).toEqual([config]);
    await expect(service.listPricingConfigs()).resolves.toEqual([config]);
  });

  it("updates an existing pricing config while preserving its creation timestamp", async () => {
    const pricingConfigs = new MemoryPricingConfigRepository();
    pricingConfigs.saved = [
      {
        id: "pricing-1",
        kind: "time.priority",
        name: "Default time pricing",
        enabled: true,
        status: "active",
        provider: {
          id: "time.default",
          rules: [
            {
              id: "base",
              label: "Base",
              priority: 0,
              timeRange: {
                start: "00:00",
                end: "00:00",
              },
              pricing: {
                unitMinutes: 30,
                unitPrice: 10,
                roundGraceMinutes: 5,
                priceCap: 80,
              },
            },
          ],
        },
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        updatedAt: new Date("2026-06-07T10:00:00.000Z"),
      },
    ];
    const service = createStaffPricingService({
      pricingConfigs,
      id: () => "unused",
      now: () => new Date("2026-06-07T12:00:00.000Z"),
    });

    const updated = await service.updatePricingConfig({
      pricingConfigId: "pricing-1",
      name: "Disabled time pricing",
      enabled: false,
      provider: {
        id: "time.default",
        rules: [
          {
            id: "base",
            label: "Base disabled",
            priority: 0,
            timeRange: {
              start: "00:00",
              end: "00:00",
            },
            pricing: {
              unitMinutes: 60,
              unitPrice: 20,
              roundGraceMinutes: 0,
              priceCap: 120,
            },
          },
        ],
      },
    });

    expect(updated).toEqual({
      id: "pricing-1",
      kind: "time.priority",
      name: "Disabled time pricing",
      enabled: false,
      status: "active",
      provider: {
        id: "time.default",
        timeZone: "UTC",
        rules: [
          {
            id: "base",
            label: "Base disabled",
            priority: 0,
            timeRange: {
              start: "00:00",
              end: "00:00",
            },
            pricing: {
              unitMinutes: 60,
              unitPrice: 20,
              roundGraceMinutes: 0,
              priceCap: 120,
            },
          },
        ],
      },
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
      updatedAt: new Date("2026-06-07T12:00:00.000Z"),
    });
    expect(pricingConfigs.saved).toEqual([updated]);
  });

  it("accepts enabled pricing configs with closed non-billable gaps", async () => {
    const pricingConfigs = new MemoryPricingConfigRepository();
    const service = createStaffPricingService({
      pricingConfigs,
      id: () => "pricing-1",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await expect(
      service.createPricingConfig({
        kind: "time.priority",
        name: "Business hours pricing",
        enabled: true,
        provider: {
          id: "time.business-hours",
          rules: [
            {
              id: "business-hours",
              label: "Business hours",
              priority: 10,
              timeRange: {
                start: "10:00",
                end: "22:00",
              },
              pricing: {
                unitMinutes: 30,
                unitPrice: 10,
                roundGraceMinutes: 5,
                priceCap: 80,
              },
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      name: "Business hours pricing",
      provider: {
        id: "time.business-hours",
      },
    });
    expect(pricingConfigs.saved).toHaveLength(1);
  });

  it("creates fixed charge pricing configs without requiring time fallback rules", async () => {
    const pricingConfigs = new MemoryPricingConfigRepository();
    const service = createStaffPricingService({
      pricingConfigs,
      id: () => "pricing-fixed-1",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    const config = await service.createPricingConfig({
      kind: "charge.fixed",
      name: "入场费",
      enabled: true,
      provider: {
        id: "cover-charge",
        label: "入场费",
        amount: 500,
      },
    });

    expect(config).toEqual({
      id: "pricing-fixed-1",
      kind: "charge.fixed",
      name: "入场费",
      enabled: true,
      status: "active",
      provider: {
        id: "cover-charge",
        label: "入场费",
        amount: 500,
      },
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
      updatedAt: new Date("2026-06-07T10:00:00.000Z"),
    });
    await expect(pricingConfigs.listEnabled()).resolves.toEqual([config]);
  });

  it("builds a visual timeline for a saved time priority pricing config", async () => {
    const pricingConfigs = new MemoryPricingConfigRepository();
    pricingConfigs.saved = [
      {
        id: "pricing-1",
        kind: "time.priority",
        name: "Default",
        enabled: true,
        status: "active",
        provider: {
          id: "time.default",
          timeZone: "Asia/Tokyo",
          rules: [
            {
              id: "fallback",
              label: "Fallback",
              priority: 0,
              timeRange: { start: "00:00", end: "00:00" },
              pricing: {
                unitMinutes: 30,
                unitPrice: 5,
                roundGraceMinutes: 0,
                priceCap: 100,
              },
            },
            {
              id: "peak",
              label: "Peak",
              priority: 10,
              timeRange: { start: "20:00", end: "22:00" },
              pricing: {
                unitMinutes: 30,
                unitPrice: 20,
                roundGraceMinutes: 0,
                priceCap: 100,
              },
            },
          ],
        },
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        updatedAt: new Date("2026-06-07T10:00:00.000Z"),
      },
    ];
    const service = createStaffPricingService({
      pricingConfigs,
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await expect(
      service.getPricingTimeline({
        pricingConfigId: "pricing-1",
        localDate: "2026-06-07",
      }),
    ).resolves.toMatchObject({
      providerId: "time.default",
      localDate: "2026-06-07",
      timeZone: "Asia/Tokyo",
      segments: [
        {
          ruleId: "fallback",
          startLabel: "00:00",
          endLabel: "20:00",
        },
        {
          ruleId: "peak",
          startLabel: "20:00",
          endLabel: "22:00",
        },
        {
          ruleId: "fallback",
          startLabel: "22:00",
          endLabel: "24:00",
        },
      ],
    });
  });

  it("creates global time cap configs over every time plan, naming none", async () => {
    const pricingConfigs = new MemoryPricingConfigRepository();
    pricingConfigs.saved = [
      {
        id: "pricing-base",
        kind: "time.priority",
        name: "音游",
        enabled: true,
        status: "active",
        provider: {
          id: "time.base",
          rules: [
            {
              id: "day",
              label: "日场",
              priority: 1,
              timeRange: { start: "10:00", end: "22:00" },
              pricing: {
                unitMinutes: 30,
                unitPrice: 6,
                roundGraceMinutes: 0,
                priceCap: 999,
              },
            },
          ],
        },
        createdAt: new Date("2026-06-07T09:00:00.000Z"),
        updatedAt: new Date("2026-06-07T09:00:00.000Z"),
      },
    ];
    const service = createStaffPricingService({
      pricingConfigs,
      id: () => "cap-config",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    const config = await service.createPricingConfig({
      kind: "time.cap",
      name: "全局封顶",
      enabled: true,
      provider: {
        id: "cap.global",
        includedPricingConfigIds: ["pricing-base"],
        rules: [
          {
            id: "day",
            label: "日场全局封顶",
            priority: 1,
            timeRange: { start: "10:00", end: "22:00" },
            priceCap: 69,
          },
        ],
      },
    });

    expect(config).toMatchObject({
      id: "cap-config",
      kind: "time.cap",
      provider: {
        id: "cap.global",
        // A cap across plans holds every time plan: a list sent in is dropped.
        includedPricingConfigIds: [],
        rules: [
          {
            id: "day",
            label: "日场全局封顶",
            priority: 1,
            timeRange: { start: "10:00", end: "22:00" },
            priceCap: 69,
          },
        ],
      },
    });
  });

  it("refuses a cap period that carries a unit price, with a reason a shopkeeper can read", async () => {
    const pricingConfigs = new MemoryPricingConfigRepository();
    const service = createStaffPricingService({
      pricingConfigs,
      id: () => "cap-config",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });
    // The shape the editor used to send when switching a new rule to a cap.
    await expect(service.createPricingConfig({
      kind: "time.cap",
      name: "消费封顶",
      enabled: true,
      provider: {
        id: "cap.global",
        rules: [{
          id: "day", label: "全天", priority: 0,
          timeRange: { start: "00:00", end: "00:00" }, priceCap: 10,
          pricing: { unitMinutes: 60, unitPrice: 10, roundGraceMinutes: 0, priceCap: 0 },
        }],
      } as never,
    })).rejects.toMatchObject({
      code: "INVALID_TIME_CAP_PROVIDER",
      message: "封顶规则的每个时段只需要封顶金额，不能带单价。",
    });
  });

  it("rejects updating a time priority config with a global cap provider shape", async () => {
    const pricingConfigs = new MemoryPricingConfigRepository();
    pricingConfigs.saved = [
      {
        id: "pricing-base",
        kind: "time.priority",
        name: "音游",
        enabled: true,
        status: "active",
        provider: {
          id: "time.base",
          rules: [
            {
              id: "day",
              label: "日场",
              priority: 1,
              timeRange: { start: "10:00", end: "22:00" },
              pricing: {
                unitMinutes: 30,
                unitPrice: 6,
                roundGraceMinutes: 0,
                priceCap: 999,
              },
            },
          ],
        },
        createdAt: new Date("2026-06-07T09:00:00.000Z"),
        updatedAt: new Date("2026-06-07T09:00:00.000Z"),
      },
    ];
    const service = createStaffPricingService({
      pricingConfigs,
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await expect(
      service.updatePricingConfig({
        pricingConfigId: "pricing-base",
        name: "误切全局封顶",
        enabled: true,
        provider: {
          id: "cap.global",
          includedPricingConfigIds: ["pricing-base"],
          rules: [
            {
              id: "day",
              label: "日场全局封顶",
              priority: 1,
              timeRange: { start: "10:00", end: "22:00" },
              priceCap: 69,
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_TIME_PRIORITY_PROVIDER",
    });
  });

  it("uses the store time zone as the default timeline time zone", async () => {
    const pricingConfigs = new MemoryPricingConfigRepository();
    pricingConfigs.saved = [
      {
        id: "pricing-1",
        kind: "time.priority",
        name: "Default",
        enabled: true,
        status: "active",
        provider: {
          id: "time.default",
          rules: [
            {
              id: "fallback",
              label: "Fallback",
              priority: 0,
              timeRange: { start: "00:00", end: "00:00" },
              pricing: {
                unitMinutes: 30,
                unitPrice: 5,
                roundGraceMinutes: 0,
                priceCap: 100,
              },
            },
          ],
        },
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        updatedAt: new Date("2026-06-07T10:00:00.000Z"),
      },
    ];
    const service = createStaffPricingService({
      pricingConfigs,
      getDefaultTimeZone: async () => "Asia/Shanghai",
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await expect(
      service.getPricingTimeline({
        pricingConfigId: "pricing-1",
        localDate: "2026-06-07",
      }),
    ).resolves.toMatchObject({
      timeZone: "Asia/Shanghai",
    });
  });

  it("builds a visual timeline from an unsaved staff pricing draft through the same engine", async () => {
    const service = createStaffPricingService({
      pricingConfigs: new MemoryPricingConfigRepository(),
      getDefaultTimeZone: async () => "Asia/Tokyo",
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await expect(
      service.previewPricingTimeline({
        localDate: "2026-06-07",
        provider: {
          id: "draft.time",
          timeZone: "Asia/Tokyo",
          rules: [
            {
              id: "fallback",
              label: "普通时段",
              priority: 0,
              timeRange: { start: "00:00", end: "00:00" },
              pricing: {
                unitMinutes: 30,
                unitPrice: 5,
                roundGraceMinutes: 0,
                priceCap: 100,
              },
            },
            {
              id: "peak",
              label: "高峰时段",
              priority: 10,
              timeRange: { start: "20:00", end: "22:00" },
              pricing: {
                unitMinutes: 30,
                unitPrice: 20,
                roundGraceMinutes: 0,
                priceCap: 100,
              },
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      providerId: "draft.time",
      localDate: "2026-06-07",
      timeZone: "Asia/Tokyo",
      segments: [
        { ruleId: "fallback", startLabel: "00:00", endLabel: "20:00" },
        { ruleId: "peak", startLabel: "20:00", endLabel: "22:00" },
        { ruleId: "fallback", startLabel: "22:00", endLabel: "24:00" },
      ],
    });
  });

  it("builds a visual timeline from an unsaved global cap pricing draft", async () => {
    const service = createStaffPricingService({
      pricingConfigs: new MemoryPricingConfigRepository(),
      getDefaultTimeZone: async () => "Asia/Shanghai",
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await expect(
      service.previewPricingTimeline({
        localDate: "2026-06-07",
        provider: {
          id: "draft.cap",
          timeZone: "Asia/Shanghai",
          includedPricingConfigIds: ["pricing-base"],
          rules: [
            {
              id: "day-cap",
              label: "日场全局封顶",
              priority: 10,
              timeRange: { start: "10:00", end: "22:00" },
              priceCap: 69,
            },
            {
              id: "night-cap",
              label: "夜场全局封顶",
              priority: 0,
              timeRange: { start: "22:00", end: "10:00" },
              priceCap: 49,
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      providerId: "draft.cap",
      localDate: "2026-06-07",
      timeZone: "Asia/Shanghai",
      segments: [
        { ruleId: "night-cap", startLabel: "00:00", endLabel: "10:00", priceCap: 49 },
        { ruleId: "day-cap", startLabel: "10:00", endLabel: "22:00", priceCap: 69 },
        { ruleId: "night-cap", startLabel: "22:00", endLabel: "24:00", priceCap: 49 },
      ],
    });
  });

  it("keeps archived draft rules in staff pricing configs while excluding them from timeline output", async () => {
    const service = createStaffPricingService({
      pricingConfigs: new MemoryPricingConfigRepository(),
      getDefaultTimeZone: async () => "Asia/Tokyo",
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await expect(
      service.previewPricingTimeline({
        localDate: "2026-06-07",
        provider: {
          id: "draft.time",
          rules: [
            {
              id: "fallback",
              label: "普通时段",
              priority: 0,
              timeRange: { start: "00:00", end: "00:00" },
              pricing: {
                unitMinutes: 30,
                unitPrice: 5,
                roundGraceMinutes: 0,
                priceCap: 100,
              },
            },
            {
              id: "archived-peak",
              label: "旧高峰价",
              priority: 10,
              status: "archived",
              timeRange: { start: "20:00", end: "22:00" },
              pricing: {
                unitMinutes: 30,
                unitPrice: 20,
                roundGraceMinutes: 0,
                priceCap: 100,
              },
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      // The rule's day runs on UTC, so in Tokyo its window resets at 09:00.
      segments: [
        { ruleId: "fallback", startLabel: "00:00", endLabel: "09:00" },
        { ruleId: "fallback", startLabel: "09:00", endLabel: "24:00" },
      ],
    });
  });

  it("archives pricing configs without deleting historical configuration records", async () => {
    const pricingConfigs = new MemoryPricingConfigRepository();
    pricingConfigs.saved = [
      {
        id: "pricing-1",
        kind: "time.priority",
        name: "Default",
        enabled: true,
        status: "active",
        provider: {
          id: "time.default",
          rules: [
            {
              id: "fallback",
              label: "Fallback",
              priority: 0,
              timeRange: { start: "00:00", end: "00:00" },
              pricing: {
                unitMinutes: 30,
                unitPrice: 5,
                roundGraceMinutes: 0,
                priceCap: 100,
              },
            },
          ],
        },
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        updatedAt: new Date("2026-06-07T10:00:00.000Z"),
      },
    ];
    const service = createStaffPricingService({
      pricingConfigs,
      id: () => "unused",
      now: () => new Date("2026-06-07T12:00:00.000Z"),
    });

    await expect(service.archivePricingConfig({ pricingConfigId: "pricing-1" })).resolves.toMatchObject({
      id: "pricing-1",
      enabled: false,
      status: "archived",
      updatedAt: new Date("2026-06-07T12:00:00.000Z"),
    });
    await expect(service.listPricingConfigs()).resolves.toHaveLength(1);
    await expect(pricingConfigs.listEnabled()).resolves.toEqual([]);
  });

  it("updates archived pricing configs without restoring or enabling them", async () => {
    const pricingConfigs = new MemoryPricingConfigRepository();
    const archived: PricingConfig = {
      id: "pricing-1",
      kind: "charge.fixed",
      name: "Old ticket",
      enabled: false,
      status: "archived",
      provider: {
        id: "fixed.old",
        label: "Old ticket",
        amount: 300,
      },
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
      updatedAt: new Date("2026-06-07T10:30:00.000Z"),
    };
    pricingConfigs.saved = [archived];
    const service = createStaffPricingService({
      pricingConfigs,
      id: () => "unused",
      now: () => new Date("2026-06-07T12:00:00.000Z"),
    });

    await expect(
      service.updatePricingConfig({
        pricingConfigId: "pricing-1",
        name: "Re-enabled ticket",
        enabled: true,
        provider: {
          id: "fixed.old",
          label: "Re-enabled ticket",
          amount: 500,
        },
      }),
    ).resolves.toMatchObject({
      id: "pricing-1",
      name: "Re-enabled ticket",
      enabled: false,
      status: "archived",
      provider: {
        id: "fixed.old",
        label: "Re-enabled ticket",
        amount: 500,
      },
      createdAt: archived.createdAt,
      updatedAt: new Date("2026-06-07T12:00:00.000Z"),
    });
  });

  it("restores archived pricing configs but keeps them disabled until staff re-enables them", async () => {
    const pricingConfigs = new MemoryPricingConfigRepository();
    pricingConfigs.saved = [
      {
        id: "pricing-1",
        kind: "charge.fixed",
        name: "Event ticket",
        enabled: true,
        status: "archived",
        provider: {
          id: "fixed.event",
          label: "Event ticket",
          amount: 300,
        },
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        updatedAt: new Date("2026-06-07T10:30:00.000Z"),
      },
    ];
    const service = createStaffPricingService({
      pricingConfigs,
      id: () => "unused",
      now: () => new Date("2026-06-07T12:00:00.000Z"),
    });

    await expect(service.restorePricingConfig({ pricingConfigId: "pricing-1" })).resolves.toMatchObject({
      id: "pricing-1",
      enabled: false,
      status: "active",
      updatedAt: new Date("2026-06-07T12:00:00.000Z"),
    });
    await expect(pricingConfigs.listEnabled()).resolves.toEqual([]);
  });
});

describe("pricing relations on save", () => {
  const provider = (id: string) => ({
    id: `time.${id}`,
    rules: [{
      id: "all-day",
      label: "All day",
      priority: 0,
      timeRange: { start: "00:00", end: "00:00" },
      pricing: { unitMinutes: 60, unitPrice: 2, roundGraceMinutes: 0, priceCap: 100 },
    }],
  });

  function service() {
    const pricingConfigs = new MemoryPricingConfigRepository();
    let n = 0;
    const commands = createStaffPricingService({
      pricingConfigs,
      id: () => `plan-${++n}`,
      now: () => new Date("2026-10-24T00:00:00.000Z"),
    });
    const create = (relations?: { requires: string[]; conflicts: string[] }) =>
      commands.createPricingConfig({ kind: "time.priority", name: "plan", enabled: true, provider: provider("p"), ...(relations ? { relations } : {}) });
    return { commands, create };
  }

  it("stores a plan's relations and keeps them when an edit leaves them out", async () => {
    const { commands, create } = service();
    const base = await create();
    const eight = await create({ requires: [base.id], conflicts: [] });
    expect(eight).toMatchObject({ relations: { requires: [base.id], conflicts: [] } });

    const renamed = await commands.updatePricingConfig({ pricingConfigId: eight.id, name: "八口机", enabled: true, provider: provider("p") });
    expect(renamed).toMatchObject({ name: "八口机", relations: { requires: [base.id], conflicts: [] } });
  });

  it("refuses relations that could never be satisfied", async () => {
    const { commands, create } = service();
    const a = await create();
    const b = await create({ requires: [a.id], conflicts: [] });

    await expect(create({ requires: ["missing"], conflicts: [] })).rejects.toMatchObject({ code: "PRICING_RELATION_UNKNOWN_TARGET" });
    await expect(
      commands.updatePricingConfig({ pricingConfigId: a.id, name: "a", enabled: true, provider: provider("p"), relations: { requires: [b.id], conflicts: [] } }),
    ).rejects.toMatchObject({ code: "PRICING_RELATION_CYCLE" });
    await expect(create({ requires: [b.id], conflicts: [a.id] })).rejects.toMatchObject({ code: "PRICING_RELATION_CONTRADICTION" });
    await expect(
      commands.createPricingConfig({
        kind: "charge.fixed", name: "ticket", enabled: true,
        provider: { id: "ticket", label: "Ticket", amount: 5 },
        relations: { requires: [a.id], conflicts: [] },
      }),
    ).rejects.toMatchObject({ code: "PRICING_RELATION_UNSUPPORTED_KIND" });
  });

  it("refuses archiving a plan another plan requires, until that plan lets go", async () => {
    const { commands, create } = service();
    const base = await create();
    const eight = await create({ requires: [base.id], conflicts: [] });
    await expect(commands.archivePricingConfig({ pricingConfigId: base.id })).rejects.toMatchObject({ code: "PRICING_CONFIG_IN_USE" });
    await commands.archivePricingConfig({ pricingConfigId: eight.id });
    await expect(commands.archivePricingConfig({ pricingConfigId: base.id })).resolves.toMatchObject({ status: "archived" });
  });
});
