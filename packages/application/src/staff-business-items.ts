import { isNegativeQuantity, PrismDomainError, quantizeMoney } from "@prism/core";
import type { BusinessItem, BusinessItemRepository } from "@prism/core";

export type StaffCreateBusinessItemInput = {
  kind: string;
  name: string;
  price: number;
  assetType: string | null;
  assetCode: string | null;
  activeAt: Date | null;
  expiresAt: Date | null;
  metadata: Record<string, unknown> | null;
};

export type StaffBusinessItemServiceDependencies = {
  businessItems: BusinessItemRepository;
  id: () => string;
  now: () => Date;
};

export type StaffBusinessItemService = {
  createBusinessItem(input: StaffCreateBusinessItemInput): Promise<BusinessItem>;
  archiveBusinessItem(input: { businessItemId: string }): Promise<BusinessItem>;
  restoreBusinessItem(input: { businessItemId: string }): Promise<BusinessItem>;
  listBusinessItems(): Promise<BusinessItem[]>;
};

export function createStaffBusinessItemService(
  dependencies: StaffBusinessItemServiceDependencies,
): StaffBusinessItemService {
  return {
    async createBusinessItem(input) {
      const price = quantizeMoney(input.price);
      validateBusinessItemInput({ ...input, price });
      const now = dependencies.now();
      const item: BusinessItem = {
        id: dependencies.id(),
        kind: input.kind,
        name: input.name,
        status: "active",
        price,
        assetType: input.assetType,
        assetCode: input.assetCode,
        activeAt: input.activeAt,
        expiresAt: input.expiresAt,
        metadata: input.metadata,
        createdAt: now,
        updatedAt: now,
      };

      await dependencies.businessItems.save(item);
      return item;
    },

    async archiveBusinessItem(input) {
      const existing = await dependencies.businessItems.findById(input.businessItemId);
      if (!existing) {
        throw new PrismDomainError("Business item not found.", "BUSINESS_ITEM_NOT_FOUND");
      }
      const archived: BusinessItem = {
        ...existing,
        status: "archived",
        updatedAt: dependencies.now(),
      };
      await dependencies.businessItems.save(archived);
      return archived;
    },

    async restoreBusinessItem(input) {
      const existing = await dependencies.businessItems.findById(input.businessItemId);
      if (!existing) {
        throw new PrismDomainError("Business item not found.", "BUSINESS_ITEM_NOT_FOUND");
      }
      const restored: BusinessItem = {
        ...existing,
        status: "active",
        updatedAt: dependencies.now(),
      };
      await dependencies.businessItems.save(restored);
      return restored;
    },

    async listBusinessItems() {
      return dependencies.businessItems.listAll();
    },
  };
}

function validateBusinessItemInput(input: StaffCreateBusinessItemInput): void {
  if (!Number.isFinite(input.price) || isNegativeQuantity(input.price)) {
    throw new PrismDomainError("Business item price must be a non-negative finite number.", "INVALID_BUSINESS_ITEM_PRICE");
  }
  if (input.activeAt && input.expiresAt && input.activeAt >= input.expiresAt) {
    throw new PrismDomainError(
      "Business item active time must be earlier than expiry time.",
      "INVALID_BUSINESS_ITEM_TIME_WINDOW",
    );
  }
}
