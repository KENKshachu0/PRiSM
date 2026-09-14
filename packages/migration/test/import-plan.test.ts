import { centsOf, yuanOf } from "@prism/core";
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createBunSqliteExecutor, createSqliteRepositories } from "@prism/adapter-sqlite";
import { initializeSqliteSchema, createRuntimeQueries } from "@prism/runtime";
import { createPrismNeoMigrationPlan, importPrismNeoMigrationPlan, type PrismNeoMigrationPlan } from "../src";

describe("importPrismNeoMigrationPlan", () => {
  it("resolves legacy present grants that reference asset definitions by old primary id", () => {
    const plan = createPrismNeoMigrationPlan({
      exportedAt: new Date("2026-06-01T00:00:00.000Z"),
      assetDefinitions: [
        {
          id: 6,
          type: "TICKET",
          assetId: 10003,
          name: "Special ticket",
          valid: true,
        },
      ],
      presents: [
        {
          id: 24,
          name: "Old grant shape",
          oncePerUser: true,
          body: [{ id: 6, name: "Special ticket", count: 1, mergeStrategy: "STACK" }],
        },
      ],
    });

    expect(plan.presents[0]).toEqual({
      id: "legacy:present:24",
      name: "Old grant shape",
      oncePerPlayer: true,
      grants: [
        {
          assetType: "ticket",
          assetCode: "legacy.ticket.10003",
          amount: 1,
          mergeStrategy: "stack",
          activeAt: null,
          expiresAt: null,
          durationMs: undefined,
        },
      ],
    });
  });

  it("writes a migration plan into the SQLite/D1-compatible schema", async () => {
    const db = new Database(":memory:");
    initializeSqliteSchema(db);
    const executor = createBunSqliteExecutor(db);
    const repositories = createSqliteRepositories({
      db,
      id: () => "generated-id",
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    });

    const plan: PrismNeoMigrationPlan = {
      players: [
        {
          id: "legacy:user:7",
          displayName: "Player 7",
          status: "active",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      playerIdentities: [
        {
          playerId: "legacy:user:7",
          provider: "qq",
          subject: "123456",
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      ],
      assetDefinitions: [
        {
          type: "currency",
          code: "paid",
          name: "Paid balance",
          stackable: true,
          metadata: { legacy: { type: "CURRENCY", assetId: 10001, id: 1 }, valid: true },
        },
      ],
      assetHoldings: [
        {
          id: "legacy:user-asset:101",
          playerId: "legacy:user:7",
          assetType: "currency",
          assetCode: "paid",
          quantity: centsOf(500),
          activeAt: null,
          expiresAt: null,
        },
      ],
      assetLedgerEntries: [
        {
          id: "legacy:user-asset-log:301",
          playerId: "legacy:user:7",
          assetType: "currency",
          assetCode: "paid",
          delta: centsOf(500),
          reason: "legacy.ADMIN_GRANT",
          refId: "legacy:user-asset:101",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      sessions: [
        {
          id: "legacy:session:51",
          playerId: "legacy:user:7",
          startedAt: new Date("2026-01-03T10:00:00.000Z"),
          endedAt: new Date("2026-01-03T11:30:00.000Z"),
          status: "closed",
          paymentStatus: "paid",
        },
      ],
      settlements: [
        {
          settlement: {
            sessionId: "legacy:session:51",
            subtotal: centsOf(120),
            total: centsOf(90),
            status: "settled",
            settledAt: new Date("2026-01-03T11:30:00.000Z"),
          },
          chargeItems: [
            {
              id: "legacy:billing-record:401",
              source: "legacy.billing-rule.2",
              label: "Legacy billing record 401",
              amount: 90,
            },
          ],
          adjustments: [
            {
              id: "legacy:session-cost-delta:51",
              source: "legacy.session",
              label: "Legacy final cost delta",
              amount: -30,
            },
          ],
        },
      ],
      pricingConfigs: [
        {
          id: "legacy:pricing-config:time-priority",
          kind: "time.priority",
          name: "Legacy time priority pricing",
          enabled: false,
          provider: {
            id: "legacy.time-priority",
            rules: [
              {
                id: "legacy.rule.2",
                label: "Night",
                priority: 20,
                weekdays: [5, 6],
                timeRange: { start: "20:00", end: "04:00" },
                pricing: { unitMinutes: 30, unitPrice: 40, priceCap: 160, roundGraceMinutes: 5 },
              },
            ],
          },
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
          updatedAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      ],
      pricingHistoryEntries: [
        {
          id: "legacy:billing-record:401",
          playerId: "legacy:user:7",
          pricingConfigId: "legacy:pricing-config:time-priority",
          providerId: "legacy.time-priority",
          ruleId: "legacy.rule.2",
          ruleAnchorAt: new Date("2026-01-01T00:00:00.000Z"),
          sessionId: "legacy:billing-record:401",
          amount: 90,
          createdAt: new Date("2026-01-03T11:30:00.000Z"),
          metadata: null,
        },
      ],
      presents: [
        {
          id: "legacy:present:61",
          name: "Recharge pack",
          oncePerPlayer: true,
          grants: [
            {
              assetType: "currency",
              assetCode: "paid",
              amount: 1000,
              mergeStrategy: "stack",
              activeAt: null,
              expiresAt: null,
            },
          ],
        },
      ],
      redeemCodes: [
        {
          id: "legacy:redeem:71",
          code: "ABC123",
          presentId: "legacy:present:61",
          activeAt: null,
          expiresAt: null,
          maxUseCount: 1,
        },
      ],
      redeemRecords: [
        {
          playerId: "legacy:user:7",
          codeId: "legacy:redeem:71",
          presentId: "legacy:present:61",
          redeemedAt: new Date("2026-01-04T00:00:00.000Z"),
        },
      ],
      deviceCommands: [
        {
          id: "legacy:coin-record:91",
          type: "coin",
          deviceId: "mai-1",
          targetKind: "game_machine",
          executorKind: "machine_ws",
          playerId: "legacy:user:7",
          status: "acked",
          payload: { count: 2, legacyCoinRecordId: 91 },
          requestedAt: new Date("2026-01-05T00:00:00.000Z"),
          ackedAt: new Date("2026-01-05T00:00:00.000Z"),
        },
      ],
    };

    await importPrismNeoMigrationPlan({ executor, plan });

    const queries = createRuntimeQueries({
      executor,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    });
    const [player, identityPlayer, holdings, ledger, session, settlement, pricingConfigs, redeemCodes, present, records, commands] =
      await Promise.all([
        repositories.players.findById("legacy:user:7"),
        repositories.playerIdentities.findPlayerByIdentity("qq", "123456"),
        repositories.assets.listAssetHoldings("legacy:user:7"),
        repositories.assets.listLedgerEntriesByPlayerId("legacy:user:7"),
        repositories.sessions.findById("legacy:session:51"),
        repositories.settlements.findSettlementBySessionId("legacy:session:51"),
        repositories.pricingConfigs.listAll(),
        repositories.redeems.listRedeemCodes(),
        repositories.redeems.findPresentById("legacy:present:61"),
        repositories.redeems.listRedeemRecords(),
        repositories.deviceCommands.listByPlayerId("legacy:user:7"),
      ]);

    expect(player?.displayName).toBe("Player 7");
    expect(identityPlayer?.id).toBe("legacy:user:7");
    expect(holdings).toEqual([
      {
        id: "legacy:user-asset:101",
        assetType: "currency",
        assetCode: "paid",
        quantity: centsOf(500),
        activeAt: null,
        expiresAt: null,
      },
    ]);
    expect(ledger).toEqual([
      {
        assetType: "currency",
        assetCode: "paid",
        delta: centsOf(500),
        reason: "legacy.ADMIN_GRANT",
        refId: "legacy:user-asset:101",
      },
    ]);
    expect(session?.paymentStatus).toBe("paid");
    expect(yuanOf(settlement!.settlement.total)).toBe(90);
    expect(settlement?.chargeItems).toHaveLength(1);
    expect(settlement?.adjustments).toHaveLength(1);
    const legacyPricingConfig = pricingConfigs[0];
    if (!legacyPricingConfig || legacyPricingConfig.kind !== "time.priority") {
      throw new Error("Expected legacy migration to create a time priority pricing config.");
    }
    await expect(
      repositories.pricingHistory.sumByPlayerAndKeys("legacy:user:7", [
        {
          pricingConfigId: legacyPricingConfig.id,
          providerId: "legacy.time-priority",
          ruleId: "legacy.rule.2",
          ruleAnchorAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ]),
    ).resolves.toEqual({
      [`${legacyPricingConfig.id}@legacy.time-priority@legacy.rule.2@2026-01-01T00:00:00.000Z`]: 90,
    });
    expect(redeemCodes[0]?.code).toBe("ABC123");
    expect(present?.grants[0]?.assetCode).toBe("paid");
    expect(records).toEqual([
      {
        playerId: "legacy:user:7",
        codeId: "legacy:redeem:71",
        presentId: "legacy:present:61",
        redeemedAt: new Date("2026-01-04T00:00:00.000Z"),
      },
    ]);
    expect(commands[0]?.payload).toEqual({ count: 2, legacyCoinRecordId: 91 });

    const summary = await queries.playerQueries.getPlayerSummary("legacy:user:7");
    expect(summary.wallet).toEqual([{ assetCode: "paid", quantity: centsOf(500) }]);
    const getHistoryDetail = queries.playerQueries.getPlayerSessionHistoryDetail;
    if (!getHistoryDetail) throw new Error("Expected session history detail query to be configured.");
    const history = await getHistoryDetail("legacy:user:7", "legacy:session:51");
    expect(yuanOf(history!.total!)).toBe(90);
  });
});
