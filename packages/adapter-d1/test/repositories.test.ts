import { centsOf, yuanOf } from "@prism/core";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { sqliteSchema } from "@prism/storage-sql";
import {
  createD1Repositories,
  type D1BoundStatementLike,
  type D1DatabaseLike,
  type SqlValue,
} from "../src/index";

class InMemoryD1Database implements D1DatabaseLike {
  constructor(private readonly db: Database) {}

  prepare(sql: string) {
    const db = this.db;
    return {
      bind(...values: SqlValue[]) {
        return {
          async first<T = unknown>() {
            return (db.query(sql).get(...values) as T | null) ?? null;
          },
          async all<T = unknown>() {
            return {
              results: db.query(sql).all(...values) as T[],
            };
          },
          async run() {
            db.run(sql, values);
            return {
              success: true,
            };
          },
        };
      },
    };
  }

  async batch(statements: readonly D1BoundStatementLike[]) {
    this.db.run("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.run("COMMIT");
      return results;
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }
}

function createDb() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  for (const statement of sqliteSchema) db.run(statement);
  db.run(
    "INSERT INTO players (id, display_name, status, created_at) VALUES (?, ?, ?, ?)",
    ["player-1", "Neri", "active", "2026-06-07T09:00:00.000Z"],
  );
  db.run(
    "INSERT INTO asset_definitions (type, code, name, stackable) VALUES (?, ?, ?, ?)",
    ["currency", "currency.paid", "Paid balance", 1],
  );
  return new InMemoryD1Database(db);
}

describe("createD1Repositories", () => {
  it("persists and lists staff users through D1", async () => {
    const repositories = createD1Repositories({
      db: createDb(),
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await repositories.system.saveStaffUser({
      id: "staff-1",
      username: "owner",
      displayName: "店主",
      passwordHash: "password-hash",
      passwordSalt: "password-salt",
      role: "owner",
      status: "active",
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
      updatedAt: new Date("2026-06-07T10:00:00.000Z"),
    });
    await repositories.system.saveStaffUser({
      id: "staff-2",
      username: "viewer",
      displayName: "只读人员",
      passwordHash: "password-hash-2",
      passwordSalt: "password-salt-2",
      role: "viewer",
      status: "disabled",
      createdAt: new Date("2026-06-07T10:05:00.000Z"),
      updatedAt: new Date("2026-06-07T10:05:00.000Z"),
    });

    await expect(repositories.system.listStaffUsers()).resolves.toMatchObject([
      {
        id: "staff-1",
        username: "owner",
        displayName: "店主",
        role: "owner",
        status: "active",
      },
      {
        id: "staff-2",
        username: "viewer",
        displayName: "只读人员",
        role: "viewer",
        status: "disabled",
      },
    ]);
  });

  it("persists asset definitions through D1", async () => {
    const repositories = createD1Repositories({
      db: createDb(),
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await repositories.assetDefinitions.save({
      type: "achievement",
      code: "achievement.first-play",
      name: "First play",
      stackable: false,
      status: "active",
      pricingEffectId: null,
      pricingEffect: null,
      activeAt: null,
      expiresAt: null,
      metadata: {
        hidden: false,
      },
    });

    await expect(
      repositories.assetDefinitions.findByCode(
        "achievement",
        "achievement.first-play",
      ),
    ).resolves.toEqual({
      type: "achievement",
      code: "achievement.first-play",
      name: "First play",
      stackable: false,
      status: "active",
      pricingEffectId: null,
      pricingEffect: null,
      activeAt: null,
      expiresAt: null,
      metadata: {
        hidden: false,
      },
    });
  });

  it("persists pricing configs through D1", async () => {
    const repositories = createD1Repositories({
      db: createDb(),
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await repositories.pricingConfigs.save({
      id: "pricing-1",
      kind: "time.priority",
      name: "D1 time pricing",
      enabled: true,
      provider: {
        id: "time.d1",
        rules: [
          {
            id: "base",
            label: "Base",
            priority: 0,
            status: "archived",
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
    await repositories.pricingConfigs.save({
      id: "pricing-2",
      kind: "charge.fixed",
      name: "D1 fixed charge",
      enabled: true,
      status: "active",
      provider: {
        id: "fixed.d1",
        label: "Entry ticket",
        amount: 45,
      },
      createdAt: new Date("2026-06-07T11:00:00.000Z"),
      updatedAt: new Date("2026-06-07T11:00:00.000Z"),
    });

    await expect(repositories.pricingConfigs.listEnabled()).resolves.toEqual([
      {
        id: "pricing-2",
        kind: "charge.fixed",
        name: "D1 fixed charge",
        enabled: true,
        status: "active",
        provider: {
          id: "fixed.d1",
          label: "Entry ticket",
          amount: 45,
        },
        createdAt: new Date("2026-06-07T11:00:00.000Z"),
        updatedAt: new Date("2026-06-07T11:00:00.000Z"),
      },
      {
        id: "pricing-1",
        kind: "time.priority",
        name: "D1 time pricing",
        enabled: true,
        provider: {
          id: "time.d1",
          rules: [
            {
              id: "base",
              label: "Base",
              priority: 0,
              status: "archived",
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
        status: "active",
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        updatedAt: new Date("2026-06-07T10:00:00.000Z"),
      },
    ]);
  });

  it("persists pricing history entries through D1 and sums them by player and rule anchor", async () => {
    const repositories = createD1Repositories({
      db: createDb(),
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await repositories.pricingHistory.appendEntries([
      {
        id: "history-1",
        playerId: "player-1",
        pricingConfigId: "pricing-day-night",
        providerId: "time.day-night",
        ruleId: "day",
        ruleAnchorAt: new Date("2026-06-07T01:00:00.000Z"),
        sessionId: "session-1",
        amount: 24,
        createdAt: new Date("2026-06-07T04:00:00.000Z"),
        metadata: null,
      },
      {
        id: "history-2",
        playerId: "player-1",
        pricingConfigId: "pricing-day-night",
        providerId: "time.day-night",
        ruleId: "day",
        ruleAnchorAt: new Date("2026-06-07T01:00:00.000Z"),
        sessionId: "session-2",
        amount: 16,
        createdAt: new Date("2026-06-07T08:00:00.000Z"),
        metadata: null,
      },
    ]);

    await expect(
      repositories.pricingHistory.sumByPlayerAndKeys("player-1", [
        {
          pricingConfigId: "pricing-day-night",
          providerId: "time.day-night",
          ruleId: "day",
          ruleAnchorAt: new Date("2026-06-07T01:00:00.000Z"),
        },
      ]),
    ).resolves.toEqual({
      "pricing-day-night@time.day-night@day@2026-06-07T01:00:00.000Z": 40,
    });
  });

  it("persists pricing cap history entries through D1 and sums them by player and cap anchor", async () => {
    const repositories = createD1Repositories({
      db: createDb(),
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await repositories.pricingCapHistory.appendEntries([
      {
        id: "cap-history-1",
        playerId: "player-1",
        capConfigId: "cap-config",
        capRuleId: "day",
        capAnchorAt: new Date("2026-06-07T01:00:00.000Z"),
        includedPricingConfigIds: ["pricing-base"],
        sessionIds: ["session-1"],
        amount: 30,
        createdAt: new Date("2026-06-07T04:00:00.000Z"),
        metadata: null,
      },
      {
        id: "cap-history-2",
        playerId: "player-1",
        capConfigId: "cap-config",
        capRuleId: "day",
        capAnchorAt: new Date("2026-06-07T01:00:00.000Z"),
        includedPricingConfigIds: ["pricing-base", "pricing-discount"],
        sessionIds: ["session-2"],
        amount: 10,
        createdAt: new Date("2026-06-07T08:00:00.000Z"),
        metadata: null,
      },
    ]);

    await expect(
      repositories.pricingCapHistory.sumByPlayerAndKeys("player-1", [
        {
          capConfigId: "cap-config",
          capRuleId: "day",
          capAnchorAt: new Date("2026-06-07T01:00:00.000Z"),
          key: "cap-config@day@2026-06-07T01:00:00.000Z",
        },
      ]),
    ).resolves.toEqual({
      "cap-config@day@2026-06-07T01:00:00.000Z": 40,
    });
  });

  it("persists store-managed business items through D1", async () => {
    const repositories = createD1Repositories({
      db: createDb(),
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await repositories.businessItems.save({
      id: "business-item-1",
      kind: "event.entry",
      name: "预约活动报名",
      status: "active",
      price: 900,
      assetType: "ticket",
      assetCode: "reservation",
      activeAt: new Date("2026-06-08T01:00:00.000Z"),
      expiresAt: new Date("2026-06-09T01:00:00.000Z"),
      metadata: {
        capacity: 12,
      },
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
      updatedAt: new Date("2026-06-07T10:00:00.000Z"),
    });
    await repositories.businessItems.save({
      id: "business-item-2",
      kind: "service.fee",
      name: "现场服务费",
      status: "archived",
      price: 300,
      assetType: null,
      assetCode: null,
      activeAt: null,
      expiresAt: null,
      metadata: null,
      createdAt: new Date("2026-06-07T09:00:00.000Z"),
      updatedAt: new Date("2026-06-07T11:00:00.000Z"),
    });

    await expect(
      repositories.businessItems.findById("business-item-1"),
    ).resolves.toEqual({
      id: "business-item-1",
      kind: "event.entry",
      name: "预约活动报名",
      status: "active",
      price: 900,
      assetType: "ticket",
      assetCode: "reservation",
      activeAt: new Date("2026-06-08T01:00:00.000Z"),
      expiresAt: new Date("2026-06-09T01:00:00.000Z"),
      metadata: {
        capacity: 12,
      },
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
      updatedAt: new Date("2026-06-07T10:00:00.000Z"),
    });
    await expect(repositories.businessItems.listAll()).resolves.toEqual([
      {
        id: "business-item-1",
        kind: "event.entry",
        name: "预约活动报名",
        status: "active",
        price: 900,
        assetType: "ticket",
        assetCode: "reservation",
        activeAt: new Date("2026-06-08T01:00:00.000Z"),
        expiresAt: new Date("2026-06-09T01:00:00.000Z"),
        metadata: {
          capacity: 12,
        },
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        updatedAt: new Date("2026-06-07T10:00:00.000Z"),
      },
      {
        id: "business-item-2",
        kind: "service.fee",
        name: "现场服务费",
        status: "archived",
        price: 300,
        assetType: null,
        assetCode: null,
        activeAt: null,
        expiresAt: null,
        metadata: null,
        createdAt: new Date("2026-06-07T09:00:00.000Z"),
        updatedAt: new Date("2026-06-07T11:00:00.000Z"),
      },
    ]);
  });

  it("persists business item orders through D1", async () => {
    const repositories = createD1Repositories({
      db: createDb(),
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });
    await repositories.sessions.save({
      id: "session-1",
      playerId: "player-1",
      startedAt: new Date("2026-06-07T10:00:00.000Z"),
      status: "active",
    });
    await repositories.businessItems.save({
      id: "business-item-1",
      kind: "service.fee",
      name: "现场服务费",
      status: "active",
      price: 300,
      assetType: null,
      assetCode: null,
      activeAt: null,
      expiresAt: null,
      metadata: null,
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
      updatedAt: new Date("2026-06-07T10:00:00.000Z"),
    });

    await repositories.businessItemOrders.save({
      id: "order-1",
      businessItemId: "business-item-1",
      businessItemKind: "service.fee",
      businessItemName: "现场服务费",
      playerId: "player-1",
      sessionId: "session-1",
      status: "fulfilled",
      price: 300,
      assetType: null,
      assetCode: null,
      metadata: null,
      createdAt: new Date("2026-06-07T10:10:00.000Z"),
      updatedAt: new Date("2026-06-07T10:20:00.000Z"),
      fulfilledAt: new Date("2026-06-07T10:20:00.000Z"),
      cancelledAt: null,
    });

    await expect(
      repositories.businessItemOrders.findById("order-1"),
    ).resolves.toMatchObject({
      id: "order-1",
      businessItemId: "business-item-1",
      status: "fulfilled",
      fulfilledAt: new Date("2026-06-07T10:20:00.000Z"),
    });
    await expect(
      repositories.businessItemOrders.listByPlayerId("player-1"),
    ).resolves.toHaveLength(1);
    await expect(
      repositories.businessItemOrders.countOpenByItemId("business-item-1"),
    ).resolves.toBe(1);
  });

  it("persists players and updates player status through D1", async () => {
    const repositories = createD1Repositories({
      db: createDb(),
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await repositories.players.save({
      id: "player-2",
      displayName: "Guest",
      status: "active",
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
    });
    await repositories.players.updateStatus("player-2", "banned");

    await expect(repositories.players.findById("player-2")).resolves.toEqual({
      id: "player-2",
      displayName: "Guest",
      status: "banned",
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
    });
  });

  it("binds external identities to players through D1", async () => {
    const repositories = createD1Repositories({
      db: createDb(),
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await repositories.playerIdentities.save({
      playerId: "player-1",
      provider: "qq",
      subject: "10001",
      createdAt: new Date("2026-06-07T10:01:00.000Z"),
    });

    await expect(
      repositories.playerIdentities.findPlayerByIdentity("qq", "10001"),
    ).resolves.toEqual({
      id: "player-1",
      displayName: "Neri",
      status: "active",
      createdAt: new Date("2026-06-07T09:00:00.000Z"),
    });
    await expect(
      repositories.playerIdentities.listByPlayerId("player-1"),
    ).resolves.toEqual([
      {
        playerId: "player-1",
        provider: "qq",
        subject: "10001",
        createdAt: new Date("2026-06-07T10:01:00.000Z"),
      },
    ]);
  });

  it("persists the core repositories through the Cloudflare D1 prepared statement API", async () => {
    let nextId = 0;
    const repositories = createD1Repositories({
      db: createDb(),
      id: () => `id-${++nextId}`,
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await repositories.sessions.save({
      id: "session-1",
      playerId: "player-1",
      startedAt: new Date("2026-06-07T10:00:00.000Z"),
      status: "active",
      pricingConfigIds: ["config-1"],
      paymentStatus: "unpaid",
    });
    await repositories.assets.commitAssetTransaction({
      transaction: {
        id: "asset-tx-1",
        playerId: "player-1",
        kind: "test",
        refId: "session-1",
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        metadata: null,
      },
      holdingChanges: {
        upserts: [{
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: centsOf(100),
        }],
        deleteIds: [],
      },
      assetLedgerEntries: [],
    });
    await repositories.deviceCommands.enqueueDeviceCommand({
      id: "command-1",
      type: "coin",
      deviceId: "machine-1",
      targetKind: "game_machine",
      executorKind: "machine_ws",
      playerId: "player-1",
      status: "pending",
      payload: {
        count: 1,
      },
      requestedAt: new Date("2026-06-07T10:05:00.000Z"),
    });

    const activeSessions =
      await repositories.sessions.findActiveByPlayerId("player-1");
    expect(activeSessions).toHaveLength(1);
    expect(activeSessions[0]).toMatchObject({
      id: "session-1",
      playerId: "player-1",
      status: "active",
      pricingConfigIds: ["config-1"],
      paymentStatus: "unpaid",
    });
    await expect(
      repositories.assets.listAssetHoldings("player-1"),
    ).resolves.toEqual([
      {
        id: "id-1",
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: centsOf(100),
        activeAt: null,
        expiresAt: null,
      },
    ]);
    await expect(
      repositories.deviceCommands.getDeviceCommand("command-1"),
    ).resolves.toMatchObject({
      id: "command-1",
      type: "coin",
      targetKind: "game_machine",
      executorKind: "machine_ws",
      playerId: "player-1",
      payload: {
        count: 1,
      },
    });
    await expect(
      repositories.deviceCommands.listPending(10),
    ).resolves.toHaveLength(1);
    await repositories.deviceCommands.enqueueDeviceCommand({
      id: "command-all",
      type: "power.off",
      deviceId: null,
      targetKind: "facility",
      executorKind: "home_assistant",
      staffId: "staff-1",
      status: "pending",
      payload: { deviceLabel: "所有设备" },
      requestedAt: new Date("2026-06-07T10:06:00.000Z"),
    });
    await expect(
      repositories.deviceCommands.getDeviceCommand("command-all"),
    ).resolves.toMatchObject({
      deviceId: null,
      targetKind: "facility",
      payload: { deviceLabel: "所有设备" },
    });
    await repositories.deviceStates.save({
      deviceId: "machine-1",
      type: "power.on",
      targetKind: "facility",
      executorKind: "home_assistant",
      label: "Cabinet 1",
      status: "online",
      state: "on",
      metadata: {
        voltage: 220,
      },
      reportedAt: new Date("2026-06-07T10:06:00.000Z"),
      reportedBy: "agent-1",
    });
    await expect(repositories.deviceStates.listAll()).resolves.toEqual([
      {
        deviceId: "machine-1",
        type: "power.on",
        targetKind: "facility",
        executorKind: "home_assistant",
        label: "Cabinet 1",
        status: "online",
        state: "on",
        metadata: {
          voltage: 220,
        },
        reportedAt: new Date("2026-06-07T10:06:00.000Z"),
        reportedBy: "agent-1",
      },
    ]);

    await repositories.sessions.save({
      id: "session-1",
      playerId: "player-1",
      startedAt: new Date("2026-06-07T10:00:00.000Z"),
      endedAt: new Date("2026-06-07T11:00:00.000Z"),
      status: "closed",
    });
    await repositories.settlements.saveSettlement({
      settlement: {
        sessionId: "session-1",
        subtotal: centsOf(20),
        total: centsOf(15),
        status: "settled",
        settledAt: new Date("2026-06-07T11:00:00.000Z"),
      },
      chargeItems: [
        {
          id: "charge-time",
          source: "time.d1",
          label: "D1 time",
          amount: 20,
        },
      ],
      adjustments: [
        {
          id: "adjustment-coupon",
          source: "coupon.d1",
          label: "D1 coupon",
          amount: -5,
        },
      ],
    });
    await expect(
      repositories.settlements.findSettlementBySessionId("session-1"),
    ).resolves.toEqual({
      settlement: {
        sessionId: "session-1",
        subtotal: centsOf(20),
        total: centsOf(15),
        status: "settled",
        settledAt: new Date("2026-06-07T11:00:00.000Z"),
      },
      chargeItems: [
        {
          id: "charge-time",
          source: "time.d1",
          label: "D1 time",
          amount: 20,
        },
      ],
      adjustments: [
        {
          id: "adjustment-coupon",
          source: "coupon.d1",
          label: "D1 coupon",
          amount: -5,
        },
      ],
    });
  });

  it("loads redeem data and records usage through D1", async () => {
    const db = createDb();
    const repositories = createD1Repositories({
      db,
      id: () => "redeem-record-1",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await repositories.redeems.savePresent({
      id: "present-1",
      name: "Top up",
      oncePerPlayer: true,
      grants: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          amount: 100,
          mergeStrategy: "stack",
          activeAt: null,
          expiresAt: null,
        },
      ],
    });
    await repositories.redeems.saveRedeemCode({
      id: "code-1",
      code: "PRISM-2026",
      presentId: "present-1",
      activeAt: null,
      expiresAt: null,
      maxUseCount: 1,
      usageCount: 0,
    });

    await expect(
      repositories.redeems.findRedeemCodeByCode("PRISM-2026"),
    ).resolves.toEqual({
      id: "code-1",
      code: "PRISM-2026",
      presentId: "present-1",
      activeAt: null,
      expiresAt: null,
      maxUseCount: 1,
      usageCount: 0,
    });
    await expect(repositories.redeems.listRedeemCodes()).resolves.toEqual([
      {
        id: "code-1",
        code: "PRISM-2026",
        presentId: "present-1",
        activeAt: null,
        expiresAt: null,
        maxUseCount: 1,
        usageCount: 0,
      },
    ]);
    await expect(
      repositories.redeems.findRedeemCodeById("code-1"),
    ).resolves.toEqual({
      id: "code-1",
      code: "PRISM-2026",
      presentId: "present-1",
      activeAt: null,
      expiresAt: null,
      maxUseCount: 1,
      usageCount: 0,
    });
    await expect(
      repositories.redeems.findPresentById("present-1"),
    ).resolves.toMatchObject({
      id: "present-1",
      name: "Top up",
      oncePerPlayer: true,
    });

    await repositories.redeems.saveRedeemRecord({
      playerId: "player-1",
      codeId: "code-1",
      presentId: "present-1",
      redeemedAt: new Date("2026-06-07T10:00:00.000Z"),
    });

    await expect(
      repositories.redeems.countRedeemCodeUses("code-1"),
    ).resolves.toBe(1);
    await expect(repositories.redeems.listRedeemCodes()).resolves.toMatchObject(
      [
        {
          id: "code-1",
          usageCount: 1,
        },
      ],
    );
    await expect(
      repositories.redeems.hasPlayerRedeemedPresent("player-1", "present-1"),
    ).resolves.toBe(true);
  });

  it("rolls back a D1 asset batch when a ledger statement fails", async () => {
    const repositories = createD1Repositories({
      db: createDb(),
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await expect(repositories.assets.commitAssetTransaction({
      transaction: {
        id: "asset-tx-invalid",
        playerId: "player-1",
        kind: "gift.redeem",
        refId: "code-invalid",
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        metadata: null,
      },
      holdingChanges: {
        upserts: [{
          id: "holding-valid",
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: centsOf(10),
        }],
        deleteIds: [],
      },
      assetLedgerEntries: [{
        assetType: "currency",
        assetCode: "currency.missing",
        delta: centsOf(10),
        reason: "gift.redeem",
        refId: "code-invalid",
      }],
    })).rejects.toThrow();

    await expect(repositories.assets.listAssetHoldings("player-1")).resolves.toEqual([]);
    await expect(repositories.assets.listTransactionsByPlayerId("player-1")).resolves.toEqual([]);
    await expect(repositories.assets.listLedgerEntriesByPlayerId("player-1")).resolves.toEqual([]);
  });

  it("persists machine websocket connection status through D1", async () => {
    const repositories = createD1Repositories({
      db: createDb(),
      id: () => "unused",
      now: () => new Date("2026-07-07T10:00:00.000Z"),
    });

    await repositories.machineConnections.save({
      machineId: "maimai-dx-1",
      status: "online",
      capabilities: ["coin", "aime.scan"],
      connectedAt: new Date("2026-07-07T10:00:00.000Z"),
      lastSeenAt: new Date("2026-07-07T10:01:00.000Z"),
    });

    await expect(repositories.machineConnections.findByMachineId("maimai-dx-1")).resolves.toEqual({
      machineId: "maimai-dx-1",
      status: "online",
      capabilities: ["coin", "aime.scan"],
      connectedAt: new Date("2026-07-07T10:00:00.000Z"),
      lastSeenAt: new Date("2026-07-07T10:01:00.000Z"),
      disconnectedAt: undefined,
    });
  });
});
