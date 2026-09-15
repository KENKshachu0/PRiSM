import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { adjustAssets, assetQuantityOf, centsOf, unitsOf, type AssetHolding, type Cents, type Units } from "@prism/core";
import { createSqliteRepositories } from "@prism/adapter-sqlite";
import { sqliteSchema } from "@prism/storage-sql";
import { createStaffPricingService, createStaffPricingEffectService } from "@prism/application";

test("asset units are distinct and holding IDs cannot change the requested asset identity", () => {
  const money: Cents = assetQuantityOf("currency", 10);
  const tickets: Units = assetQuantityOf("ticket", 2);
  const wallet: AssetHolding<"currency"> = { id: "wallet", assetType: "currency", assetCode: "paid", quantity: money };
  const ticket: AssetHolding<"ticket"> = { id: "ticket", assetType: "ticket", assetCode: "entry", quantity: tickets };
  // @ts-expect-error ticket counts cannot be assigned to a money holding
  const wrongMoney: AssetHolding<"currency"> = { ...wallet, quantity: unitsOf(2) };
  // @ts-expect-error cents cannot be assigned to a ticket holding
  const wrongTicket: AssetHolding<"ticket"> = { ...ticket, quantity: centsOf(2) };
  void wrongMoney;
  void wrongTicket;
  for (const [holdingId, assetType, assetCode] of [["wallet", "ticket", "entry"], ["wallet", "currency", "other"], ["ticket", "currency", "paid"]]) {
    expect(() => adjustAssets({ playerId: "p", existingHoldings: [wallet, ticket], adjustments: [{
      holdingId, assetType: assetType!, assetCode: assetCode!, quantityDelta: 1, reason: "test", refId: "staff",
    }] })).toThrow("must match the holding");
  }
  const result = adjustAssets({ playerId: "p", existingHoldings: [wallet, ticket], adjustments: [
    { holdingId: "wallet", assetType: "currency", assetCode: "paid", quantityDelta: 1, reason: "test", refId: "staff" },
    { holdingId: "ticket", assetType: "ticket", assetCode: "entry", quantityDelta: 1, reason: "test", refId: "staff" },
  ] });
  expect(result.holdings.map(holding => Number(holding.quantity))).toEqual([1100, 3]);
  expect(result.assetLedgerEntries.map(entry => Number(entry.delta))).toEqual([100, 1]);
  expect(() => assetQuantityOf("ticket", 0.5)).toThrow();
});

test("pricing rejects negative input before rounding and effects roundtrip at stored precision", async () => {
  const db = new Database(":memory:");
  try {
    for (const sql of sqliteSchema) db.run(sql);
    const now = () => new Date("2026-09-16T00:00:00Z");
    const repositories = createSqliteRepositories({ db, id: () => "id", now });
    const pricing = createStaffPricingService({ pricingConfigs: repositories.pricingConfigs, id: () => "pricing", now });
    await expect(pricing.createPricingConfig({ kind: "charge.fixed", name: "Invalid", enabled: true,
      provider: { id: "fixed", label: "Fixed", amount: -0.004 },
    })).rejects.toThrow("non-negative");
    expect(await repositories.pricingConfigs.listAll()).toEqual([]);
    const effects = createStaffPricingEffectService({ pricingEffects: repositories.pricingEffects, id: () => "effect" });
    const saved = await effects.savePricingEffect({ name: "Discount", type: "percentage-discount", scope: "session",
      value: 12.345, consumable: false, limitPerDay: null, config: { minSubtotal: 1.005 },
    });
    expect(saved.value).toBe(12.35);
    expect(saved.config).toEqual({ minSubtotal: 1.01 });
    expect(await repositories.pricingEffects.findById(saved.id)).toEqual(saved);
    expect(db.query("SELECT value, json_extract(config_json,'$.minSubtotal') AS minimum FROM pricing_effects").get())
      .toEqual({ value: 1235, minimum: 101 });
  } finally {
    db.close();
  }
});
