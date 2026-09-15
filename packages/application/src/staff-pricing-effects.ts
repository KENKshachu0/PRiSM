import type { PricingEffect, PricingEffectRepository } from "@prism/core";
import { PrismDomainError, quantizeMoney } from "@prism/core";

export type StaffPricingEffectServiceDependencies = {
  pricingEffects: PricingEffectRepository;
  id: () => string;
};

export type StaffSavePricingEffectInput = Omit<PricingEffect, "id" | "status"> & {
  id?: string;
  status?: PricingEffect["status"];
};

export type StaffPricingEffectService = {
  savePricingEffect(input: StaffSavePricingEffectInput): Promise<PricingEffect>;
  archivePricingEffect(input: { effectId: string }): Promise<PricingEffect>;
  restorePricingEffect(input: { effectId: string }): Promise<PricingEffect>;
  listPricingEffects(): Promise<PricingEffect[]>;
};

export function createStaffPricingEffectService(
  dependencies: StaffPricingEffectServiceDependencies,
): StaffPricingEffectService {
  return {
    async savePricingEffect(input) {
      const existing = input.id ? await dependencies.pricingEffects.findById(input.id) : null;
      if ((existing?.status ?? "active") === "archived") {
        throw new PrismDomainError("Pricing effect has been archived.", "PRICING_EFFECT_ARCHIVED");
      }
      const effect: PricingEffect = {
        id: input.id ?? dependencies.id(),
        name: input.name,
        type: input.type,
        scope: input.scope,
        value: input.value === null ? null : quantizeMoney(input.value),
        consumable: input.consumable,
        limitPerDay: input.limitPerDay,
        activeAt: input.activeAt ?? null,
        expiresAt: input.expiresAt ?? null,
        status: input.status ?? "active",
        config: input.config && typeof input.config.minSubtotal === "number"
          ? { ...input.config, minSubtotal: quantizeMoney(input.config.minSubtotal) }
          : input.config,
      };

      await dependencies.pricingEffects.save(effect);
      return effect;
    },

    async archivePricingEffect(input) {
      const existing = await dependencies.pricingEffects.findById(input.effectId);
      if (!existing) {
        throw new PrismDomainError("Pricing effect not found.", "PRICING_EFFECT_NOT_FOUND");
      }
      const archived: PricingEffect = { ...existing, status: "archived" };
      await dependencies.pricingEffects.save(archived);
      return archived;
    },

    async restorePricingEffect(input) {
      const existing = await dependencies.pricingEffects.findById(input.effectId);
      if (!existing) {
        throw new PrismDomainError("Pricing effect not found.", "PRICING_EFFECT_NOT_FOUND");
      }
      const restored: PricingEffect = { ...existing, status: "active" };
      await dependencies.pricingEffects.save(restored);
      return restored;
    },

    async listPricingEffects() {
      return dependencies.pricingEffects.listAll();
    },
  };
}
