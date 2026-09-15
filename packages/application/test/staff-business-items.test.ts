import { centsOf as moneyFixture, centsOfInteger as integerFixture } from "@prism/core";
import { describe, expect, it } from "bun:test";
import type { BusinessItem, BusinessItemRepository } from "@prism/core";
import { createStaffBusinessItemService } from "../src/index";

class MemoryBusinessItemRepository implements BusinessItemRepository {
  saved: BusinessItem[] = [];

  async save(item: BusinessItem): Promise<void> {
    this.saved = [item, ...this.saved.filter((existing) => existing.id !== item.id)];
  }

  async findById(itemId: string): Promise<BusinessItem | null> {
    return this.saved.find((item) => item.id === itemId) ?? null;
  }

  async listAll(): Promise<BusinessItem[]> {
    return [...this.saved].sort((a, b) => {
      if (a.status !== b.status) return a.status === "active" ? -1 : 1;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });
  }
}

describe("createStaffBusinessItemService", () => {
  it("creates and lists staff-managed plugin-backed business items", async () => {
    const businessItems = new MemoryBusinessItemRepository();
    const service = createStaffBusinessItemService({
      businessItems,
      id: () => "business-item-1",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    const item = await service.createBusinessItem({
      kind: "event.entry",
      name: "周末挑战赛报名",
      price: 1200,
      assetType: "ticket",
      assetCode: "event.weekend",
      activeAt: new Date("2026-06-08T01:00:00.000Z"),
      expiresAt: new Date("2026-06-09T01:00:00.000Z"),
      metadata: {
        capacity: 24,
        channel: "店内现场",
      },
    });

    expect(item).toEqual({
      id: "business-item-1",
      kind: "event.entry",
      name: "周末挑战赛报名",
      status: "active",
      price: moneyFixture(1200),
      assetType: "ticket",
      assetCode: "event.weekend",
      activeAt: new Date("2026-06-08T01:00:00.000Z"),
      expiresAt: new Date("2026-06-09T01:00:00.000Z"),
      metadata: {
        capacity: 24,
        channel: "店内现场",
      },
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
      updatedAt: new Date("2026-06-07T10:00:00.000Z"),
    });
    expect(businessItems.saved).toEqual([item]);
    await expect(service.listBusinessItems()).resolves.toEqual([item]);
  });

  it("archives and restores business items instead of deleting referenced project definitions", async () => {
    const businessItems = new MemoryBusinessItemRepository();
    const service = createStaffBusinessItemService({
      businessItems,
      id: () => "unused",
      now: () => new Date("2026-06-07T12:00:00.000Z"),
    });
    await businessItems.save({
      id: "business-item-1",
      kind: "room.package",
      name: "夜间包场",
      status: "active",
      price: moneyFixture(6000),
      assetType: null,
      assetCode: null,
      activeAt: null,
      expiresAt: null,
      metadata: null,
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
      updatedAt: new Date("2026-06-07T10:00:00.000Z"),
    });

    await expect(service.archiveBusinessItem({ businessItemId: "business-item-1" })).resolves.toMatchObject({
      id: "business-item-1",
      status: "archived",
      updatedAt: new Date("2026-06-07T12:00:00.000Z"),
    });
    await expect(service.restoreBusinessItem({ businessItemId: "business-item-1" })).resolves.toMatchObject({
      id: "business-item-1",
      status: "active",
      updatedAt: new Date("2026-06-07T12:00:00.000Z"),
    });
    await expect(service.listBusinessItems()).resolves.toHaveLength(1);
  });

  it("rejects invalid business item prices and time windows", async () => {
    const businessItems = new MemoryBusinessItemRepository();
    const service = createStaffBusinessItemService({
      businessItems,
      id: () => "business-item-1",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await expect(
      service.createBusinessItem({
        kind: "service.fee",
        name: "现场服务费",
        price: -1,
        assetType: null,
        assetCode: null,
        activeAt: null,
        expiresAt: null,
        metadata: null,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_BUSINESS_ITEM_PRICE",
    });
    await expect(
      service.createBusinessItem({
        kind: "event.entry",
        name: "过期活动",
        price: 900,
        assetType: null,
        assetCode: null,
        activeAt: new Date("2026-06-09T01:00:00.000Z"),
        expiresAt: new Date("2026-06-08T01:00:00.000Z"),
        metadata: null,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_BUSINESS_ITEM_TIME_WINDOW",
    });
    expect(businessItems.saved).toEqual([]);
  });
});
