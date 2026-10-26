import { centsOf as moneyFixture, centsOfInteger as integerFixture } from "@prism/core";
import { centsOf, yuanOf } from "@prism/core";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { sqliteSchema } from "@prism/storage-sql";
import { createSqliteRepositories } from "../src/index";

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
  return db;
}

describe("createSqliteRepositories", () => {
  it("persists setup, staff sessions, API tokens, and app settings", async () => {
    const repositories = createSqliteRepositories({
      db: createDb(),
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await expect(repositories.system.hasOwnerStaffUser()).resolves.toBe(false);

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

    await expect(repositories.system.hasOwnerStaffUser()).resolves.toBe(true);
    await expect(
      repositories.system.findStaffUserByUsername("owner"),
    ).resolves.toMatchObject({
      id: "staff-1",
      username: "owner",
      displayName: "店主",
      role: "owner",
      status: "active",
    });
    await repositories.system.saveStaffUser({
      id: "staff-2",
      username: "manager",
      displayName: "值班店员",
      passwordHash: "password-hash-2",
      passwordSalt: "password-salt-2",
      role: "manager",
      status: "active",
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
        username: "manager",
        displayName: "值班店员",
        role: "manager",
        status: "active",
      },
    ]);

    await repositories.system.saveAdminSession({
      id: "session-1",
      staffUserId: "staff-1",
      tokenHash: "session-hash",
      expiresAt: new Date("2026-06-08T10:00:00.000Z"),
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
      lastUsedAt: new Date("2026-06-07T10:00:00.000Z"),
    });
    await expect(
      repositories.system.findAdminSessionByTokenHash("session-hash"),
    ).resolves.toMatchObject({
      id: "session-1",
      staffUserId: "staff-1",
    });

    await repositories.system.saveApiToken({
      id: "api-token-1",
      label: "机器人/店内入口",
      role: "integration",
      tokenPrefix: "integration",
      tokenHash: "api-token-hash",
      status: "active",
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
      lastUsedAt: null,
      revokedAt: null,
    });
    await expect(
      repositories.system.findActiveApiTokenByHash("api-token-hash"),
    ).resolves.toMatchObject({
      id: "api-token-1",
      label: "机器人/店内入口",
      role: "integration",
      status: "active",
    });
    await expect(repositories.system.listApiTokens()).resolves.toHaveLength(1);
    await repositories.system.revokeApiToken(
      "api-token-1",
      new Date("2026-06-07T11:00:00.000Z"),
    );
    await expect(
      repositories.system.findActiveApiTokenByHash("api-token-hash"),
    ).resolves.toBeNull();

    await repositories.system.setAppSetting("store.profile", {
      name: "PRiSM Test",
      timeZone: "Asia/Tokyo",
    });
    await expect(
      repositories.system.getAppSetting("store.profile"),
    ).resolves.toEqual({
      name: "PRiSM Test",
      timeZone: "Asia/Tokyo",
    });
  });

  it("persists asset definitions for staff-managed asset catalogs", async () => {
    const repositories = createSqliteRepositories({
      db: createDb(),
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await repositories.pricingEffects.save({
      id: "effect-monthly",
      name: "月卡免时费",
      type: "free",
      scope: "session",
      value: null,
      consumable: false,
      limitPerDay: null,
      activeAt: null,
      expiresAt: null,
      status: "active",
      config: {
        applicableSessionLabels: ["music"],
      },
    });
    await repositories.assetDefinitions.save({
      type: "pass",
      code: "pass.monthly",
      name: "Monthly pass",
      stackable: false,
      status: "active",
      pricingEffectId: "effect-monthly",
      activeAt: new Date("2026-07-01T00:00:00.000Z"),
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      metadata: {
        settlementEffect: "time.free",
      },
    });
    await repositories.assetDefinitions.save({
      type: "title",
      code: "title.special",
      name: "Special title",
      stackable: false,
      metadata: {
        rarity: "rare",
      },
    });

    await expect(
      repositories.assetDefinitions.findByCode("pass", "pass.monthly"),
    ).resolves.toEqual({
      type: "pass",
      code: "pass.monthly",
      name: "Monthly pass",
      stackable: false,
      status: "active",
      pricingEffectId: "effect-monthly",
      pricingEffect: {
        id: "effect-monthly",
        name: "月卡免时费",
        type: "free",
        scope: "session",
        value: null,
        consumable: false,
        limitPerDay: null,
        activeAt: null,
        expiresAt: null,
        status: "active",
        config: {
          applicableSessionLabels: ["music"],
        },
      },
      activeAt: new Date("2026-07-01T00:00:00.000Z"),
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      metadata: {
        settlementEffect: "time.free",
      },
    });
    await expect(repositories.assetDefinitions.listAll()).resolves.toEqual([
      {
        type: "currency",
        code: "currency.paid",
        name: "Paid balance",
        stackable: true,
        status: "active",
        pricingEffectId: null,
        pricingEffect: null,
        activeAt: null,
        expiresAt: null,
        metadata: null,
      },
      {
        type: "pass",
        code: "pass.monthly",
        name: "Monthly pass",
        stackable: false,
        status: "active",
        pricingEffectId: "effect-monthly",
        pricingEffect: {
          id: "effect-monthly",
          name: "月卡免时费",
          type: "free",
          scope: "session",
          value: null,
          consumable: false,
          limitPerDay: null,
          activeAt: null,
          expiresAt: null,
          status: "active",
          config: {
            applicableSessionLabels: ["music"],
          },
        },
        activeAt: new Date("2026-07-01T00:00:00.000Z"),
        expiresAt: new Date("2026-08-01T00:00:00.000Z"),
        metadata: {
          settlementEffect: "time.free",
        },
      },
      {
        type: "title",
        code: "title.special",
        name: "Special title",
        stackable: false,
        status: "active",
        pricingEffectId: null,
        pricingEffect: null,
        activeAt: null,
        expiresAt: null,
        metadata: {
          rarity: "rare",
        },
      },
    ]);
    await expect(repositories.pricingEffects.listAll()).resolves.toHaveLength(
      1,
    );
  });

  it("persists pricing configs and lists enabled configs in update order", async () => {
    const repositories = createSqliteRepositories({
      db: createDb(),
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await repositories.pricingConfigs.save({
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
      kind: "time.priority",
      name: "Disabled special",
      enabled: false,
      status: "active",
      provider: {
        id: "time.disabled",
        rules: [
          {
            id: "disabled",
            label: "Disabled",
            priority: 0,
            dateTimeRange: {
              start: new Date("2026-06-07T10:00:00.000Z"),
              end: new Date("2026-06-07T12:00:00.000Z"),
            },
            pricing: {
              unitMinutes: 10,
              unitPrice: 99,
              roundGraceMinutes: 0,
              priceCap: 999,
            },
          },
        ],
      },
      createdAt: new Date("2026-06-07T09:00:00.000Z"),
      updatedAt: new Date("2026-06-07T11:00:00.000Z"),
    });
    await repositories.pricingConfigs.save({
      id: "pricing-3",
      kind: "time.priority",
      name: "Archived but enabled",
      enabled: true,
      status: "archived",
      provider: {
        id: "time.archived",
        rules: [
          {
            id: "archived",
            label: "Archived",
            priority: 0,
            timeRange: {
              start: "00:00",
              end: "00:00",
            },
            pricing: {
              unitMinutes: 30,
              unitPrice: 1,
              roundGraceMinutes: 0,
              priceCap: 10,
            },
          },
        ],
      },
      createdAt: new Date("2026-06-07T08:00:00.000Z"),
      updatedAt: new Date("2026-06-07T12:00:00.000Z"),
    });
    await repositories.pricingConfigs.save({
      id: "pricing-4",
      kind: "charge.fixed",
      name: "Entry ticket",
      enabled: true,
      status: "active",
      provider: {
        id: "fixed.entry-ticket",
        label: "Entry ticket",
        amount: 35,
      },
      createdAt: new Date("2026-06-07T13:00:00.000Z"),
      updatedAt: new Date("2026-06-07T13:00:00.000Z"),
    });

    await expect(
      repositories.pricingConfigs.findById("pricing-1"),
    ).resolves.toEqual({
      id: "pricing-1",
      versionId: expect.any(String), version: 1,
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
    await expect(
      repositories.pricingConfigs.findById("pricing-4"),
    ).resolves.toEqual({
      id: "pricing-4",
      versionId: expect.any(String), version: 1,
      kind: "charge.fixed",
      name: "Entry ticket",
      enabled: true,
      status: "active",
      provider: {
        id: "fixed.entry-ticket",
        label: "Entry ticket",
        amount: 35,
      },
      createdAt: new Date("2026-06-07T13:00:00.000Z"),
      updatedAt: new Date("2026-06-07T13:00:00.000Z"),
    });
    await expect(repositories.pricingConfigs.listEnabled()).resolves.toEqual([
      {
        id: "pricing-4",
        versionId: expect.any(String), version: 1,
        kind: "charge.fixed",
        name: "Entry ticket",
        enabled: true,
        status: "active",
        provider: {
          id: "fixed.entry-ticket",
          label: "Entry ticket",
          amount: 35,
        },
        createdAt: new Date("2026-06-07T13:00:00.000Z"),
        updatedAt: new Date("2026-06-07T13:00:00.000Z"),
      },
      {
        id: "pricing-1",
        versionId: expect.any(String), version: 1,
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
      },
    ]);
    await expect(repositories.pricingConfigs.listAll()).resolves.toHaveLength(
      4,
    );
  });

  it("persists pricing history entries and sums them by player and rule anchor", async () => {
    const db = createDb();
    db.run(
      "INSERT INTO players (id, display_name, status, created_at) VALUES (?, ?, ?, ?)",
      ["player-2", "Rin", "active", "2026-06-07T09:00:00.000Z"],
    );
    const repositories = createSqliteRepositories({
      db,
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
        amount: moneyFixture(24),
        createdAt: new Date("2026-06-07T04:00:00.000Z"),
        metadata: {
          source: "test",
        },
      },
      {
        id: "history-2",
        playerId: "player-1",
        pricingConfigId: "pricing-day-night",
        providerId: "time.day-night",
        ruleId: "day",
        ruleAnchorAt: new Date("2026-06-07T01:00:00.000Z"),
        sessionId: "session-2",
        amount: moneyFixture(16),
        createdAt: new Date("2026-06-07T08:00:00.000Z"),
        metadata: null,
      },
      {
        id: "history-other-player",
        playerId: "player-2",
        pricingConfigId: "pricing-day-night",
        providerId: "time.day-night",
        ruleId: "day",
        ruleAnchorAt: new Date("2026-06-07T01:00:00.000Z"),
        sessionId: "session-3",
        amount: moneyFixture(99),
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
        {
          pricingConfigId: "pricing-day-night",
          providerId: "time.day-night",
          ruleId: "night",
          ruleAnchorAt: new Date("2026-06-07T13:00:00.000Z"),
        },
      ]),
    ).resolves.toEqual({
      "pricing-day-night@time.day-night@day@2026-06-07T01:00:00.000Z": moneyFixture(40),
      "pricing-day-night@time.day-night@night@2026-06-07T13:00:00.000Z": moneyFixture(0),
    });
  });

  it("persists pricing cap history entries and sums them by player and cap anchor", async () => {
    const repositories = createSqliteRepositories({
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
        includedPricingConfigIds: ["pricing-base", "pricing-discount"],
        sessionIds: ["session-1"],
        amount: moneyFixture(40),
        createdAt: new Date("2026-06-07T04:00:00.000Z"),
        metadata: null,
      },
      {
        id: "cap-history-2",
        playerId: "player-1",
        capConfigId: "cap-config",
        capRuleId: "day",
        capAnchorAt: new Date("2026-06-07T01:00:00.000Z"),
        includedPricingConfigIds: ["pricing-base"],
        sessionIds: ["session-2"],
        amount: moneyFixture(20),
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
      "cap-config@day@2026-06-07T01:00:00.000Z": moneyFixture(60),
    });
  });

  it("persists store-managed business items for plugin-backed non-time products", async () => {
    const repositories = createSqliteRepositories({
      db: createDb(),
      id: () => "unused",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await repositories.businessItems.save({
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
    await repositories.businessItems.save({
      id: "business-item-2",
      kind: "room.package",
      name: "夜间包场",
      status: "archived",
      price: moneyFixture(6000),
      assetType: null,
      assetCode: null,
      activeAt: null,
      expiresAt: null,
      metadata: null,
      createdAt: new Date("2026-06-06T10:00:00.000Z"),
      updatedAt: new Date("2026-06-07T11:00:00.000Z"),
    });

    await expect(
      repositories.businessItems.findById("business-item-1"),
    ).resolves.toEqual({
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
    await expect(repositories.businessItems.listAll()).resolves.toEqual([
      {
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
      },
      {
        id: "business-item-2",
        kind: "room.package",
        name: "夜间包场",
        status: "archived",
        price: moneyFixture(6000),
        assetType: null,
        assetCode: null,
        activeAt: null,
        expiresAt: null,
        metadata: null,
        createdAt: new Date("2026-06-06T10:00:00.000Z"),
        updatedAt: new Date("2026-06-07T11:00:00.000Z"),
      },
    ]);
  });

  it("persists business item orders and counts open capacity", async () => {
    const repositories = createSqliteRepositories({
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
      kind: "event.entry",
      name: "周末挑战赛报名",
      status: "active",
      price: moneyFixture(1200),
      assetType: "ticket",
      assetCode: "event.weekend",
      activeAt: null,
      expiresAt: null,
      metadata: { capacity: 1 },
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
      updatedAt: new Date("2026-06-07T10:00:00.000Z"),
    });

    await repositories.businessItemOrders.save({
      id: "order-1",
      businessItemId: "business-item-1",
      businessItemKind: "event.entry",
      businessItemName: "周末挑战赛报名",
      playerId: "player-1",
      sessionId: "session-1",
      status: "paid",
      price: moneyFixture(1200),
      assetType: "ticket",
      assetCode: "event.weekend",
      metadata: { note: "onsite" },
      createdAt: new Date("2026-06-07T10:30:00.000Z"),
      updatedAt: new Date("2026-06-07T10:30:00.000Z"),
      fulfilledAt: null,
      cancelledAt: null,
    });

    await expect(
      repositories.businessItemOrders.findById("order-1"),
    ).resolves.toMatchObject({
      id: "order-1",
      businessItemId: "business-item-1",
      playerId: "player-1",
      status: "paid",
      metadata: { note: "onsite" },
    });
    await expect(
      repositories.businessItemOrders.listByPlayerId("player-1"),
    ).resolves.toHaveLength(1);
    await expect(
      repositories.businessItemOrders.listAll(),
    ).resolves.toHaveLength(1);
    await expect(
      repositories.businessItemOrders.countOpenByItemId("business-item-1"),
    ).resolves.toBe(1);

    const order = await repositories.businessItemOrders.findById("order-1");
    await repositories.businessItemOrders.save({
      ...order!,
      status: "cancelled",
      updatedAt: new Date("2026-06-07T10:40:00.000Z"),
      cancelledAt: new Date("2026-06-07T10:40:00.000Z"),
    });
    await expect(
      repositories.businessItemOrders.countOpenByItemId("business-item-1"),
    ).resolves.toBe(0);
  });

  it("persists players and updates player status", async () => {
    const repositories = createSqliteRepositories({
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
    await repositories.players.updateStatus("player-2", "disabled");

    await expect(repositories.players.findById("player-2")).resolves.toEqual({
      id: "player-2",
      displayName: "Guest",
      status: "disabled",
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
    });
    await expect(repositories.players.listPlayers()).resolves.toEqual([
      {
        id: "player-2",
        displayName: "Guest",
        status: "disabled",
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
      },
      {
        id: "player-1",
        displayName: "Neri",
        status: "active",
        createdAt: new Date("2026-06-07T09:00:00.000Z"),
      },
    ]);
  });

  it("binds external identities to players", async () => {
    const repositories = createSqliteRepositories({
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
    await repositories.playerIdentities.save({
      playerId: "player-1",
      provider: "aime",
      subject: "card-1",
      createdAt: new Date("2026-06-07T10:02:00.000Z"),
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
      repositories.playerIdentities.findPlayerByIdentity("qq", "missing"),
    ).resolves.toBeNull();
    await expect(
      repositories.playerIdentities.listByPlayerId("player-1"),
    ).resolves.toEqual([
      {
        playerId: "player-1",
        provider: "aime",
        subject: "card-1",
        createdAt: new Date("2026-06-07T10:02:00.000Z"),
      },
      {
        playerId: "player-1",
        provider: "qq",
        subject: "10001",
        createdAt: new Date("2026-06-07T10:01:00.000Z"),
      },
    ]);
  });

  it("persists sessions and finds an active session by player id", async () => {
    const repositories = createSqliteRepositories({
      db: createDb(),
      id: () => "unused",
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

    await expect(
      repositories.sessions.findActiveByPlayerId("player-1"),
    ).resolves.toEqual([
      {
        id: "session-1",
        pricingReleaseId: expect.any(String),
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: undefined,
        status: "active",
        pricingConfigIds: ["config-1"],
        pricingConfigId: "config-1",
        paymentStatus: "unpaid",
      },
    ]);
  });

  it("commits changed asset holdings, transaction, and ledger entries together", async () => {
    let nextId = 0;
    const repositories = createSqliteRepositories({
      db: createDb(),
      id: () => `id-${++nextId}`,
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await repositories.assets.commitAssetTransaction({
      transaction: {
        id: "asset-tx-1",
        playerId: "player-1",
        kind: "gift.redeem",
        refId: "code-1",
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        metadata: null,
      },
      holdingChanges: {
        upserts: [{
          id: "holding-1",
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: centsOf(100),
        }],
        deleteIds: [],
      },
      assetLedgerEntries: [{
        assetType: "currency",
        assetCode: "currency.paid",
        delta: centsOf(100),
        reason: "gift.redeem",
        refId: "code-1",
      }],
    });

    await expect(
      repositories.assets.listAssetHoldings("player-1"),
    ).resolves.toEqual([
      {
        id: "holding-1",
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: centsOf(100),
        activeAt: null,
        expiresAt: null,
      },
    ]);
    await expect(
      repositories.assets.listLedgerEntriesByPlayerId("player-1"),
    ).resolves.toEqual([
      {
        assetType: "currency",
        assetCode: "currency.paid",
        delta: centsOf(100),
        reason: "gift.redeem",
        refId: "code-1",
        transactionId: "asset-tx-1",
      },
    ]);
  });

  it("rolls back every asset write when one statement fails", async () => {
    const repositories = createSqliteRepositories({
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

  it("persists asset transactions with their ledger entries", async () => {
    let nextId = 0;
    const repositories = createSqliteRepositories({
      db: createDb(),
      id: () => `id-${++nextId}`,
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });

    await repositories.assets.commitAssetTransaction({
      transaction: {
        id: "asset-tx-1",
        playerId: "player-1",
        kind: "session.settlement",
        refId: "session-1",
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        metadata: {
          total: centsOf(25),
        },
      },
      holdingChanges: { upserts: [], deleteIds: [] },
      assetLedgerEntries: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          delta: centsOf(-25),
          reason: "session.settlement",
          refId: "session-1",
          transactionId: "asset-tx-1",
        },
      ],
    });

    await expect(
      repositories.assets.listTransactionsByPlayerId("player-1"),
    ).resolves.toEqual([
      {
        id: "asset-tx-1",
        playerId: "player-1",
        kind: "session.settlement",
        refId: "session-1",
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        metadata: {
          total: centsOf(25),
        },
      },
    ]);
    await expect(
      repositories.assets.listLedgerEntriesByPlayerId("player-1"),
    ).resolves.toEqual([
      {
        assetType: "currency",
        assetCode: "currency.paid",
        delta: centsOf(-25),
        reason: "session.settlement",
        refId: "session-1",
        transactionId: "asset-tx-1",
      },
    ]);
  });

  it("loads redeem codes and presents and stores redeem records", async () => {
    const db = createDb();
    const repositories = createSqliteRepositories({
      db,
      id: () => "redeem-1",
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
    ).resolves.toEqual({
      id: "present-1",
      name: "Top up",
      oncePerPlayer: true,
      activeAt: null,
      expiresAt: null,
      status: "active",
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
    await repositories.redeems.savePresent({
      id: "present-1",
      name: "Top up",
      oncePerPlayer: true,
      status: "archived",
      grants: [],
    });
    await expect(
      repositories.redeems.findPresentById("present-1"),
    ).resolves.toMatchObject({
      id: "present-1",
      status: "archived",
    });
    await expect(repositories.redeems.listPresents()).resolves.toEqual([
      {
        id: "present-1",
        name: "Top up",
        oncePerPlayer: true,
        activeAt: null,
        expiresAt: null,
        status: "archived",
        grants: [],
      },
    ]);

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

  it("persists settlement charge items and adjustments", async () => {
    const repositories = createSqliteRepositories({
      db: createDb(),
      id: () => "settlement-row-id",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });
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
        subtotal: centsOf(30),
        total: centsOf(20),
        status: "settled",
        settledAt: new Date("2026-06-07T11:00:00.000Z"),
      },
      chargeItems: [
        {
          id: "charge-time",
          source: "time.default",
          label: "Base time",
          amount: moneyFixture(30),
        },
      ],
      adjustments: [
        {
          id: "adjustment-pass",
          source: "pass.monthly",
          label: "Monthly pass",
          amount: moneyFixture(-10),
        },
      ],
    });

    await expect(
      repositories.settlements.findSettlementBySessionId("session-1"),
    ).resolves.toEqual({
      settlement: {
        sessionId: "session-1",
        subtotal: centsOf(30),
        total: centsOf(20),
        status: "settled",
        settledAt: new Date("2026-06-07T11:00:00.000Z"),
      },
      chargeItems: [
        {
          id: "charge-time",
          source: "time.default",
          label: "Base time",
          amount: moneyFixture(30),
        },
      ],
      adjustments: [
        {
          id: "adjustment-pass",
          source: "pass.monthly",
          label: "Monthly pass",
          amount: moneyFixture(-10),
        },
      ],
    });
  });

  it("saves and finds settlements", async () => {
    const db = createDb();
    const repositories = createSqliteRepositories({
      db,
      id: () => "settlement-1",
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });
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
        total: centsOf(20),
        status: "settled",
        settledAt: new Date("2026-06-07T11:00:00.000Z"),
      },
      chargeItems: [],
      adjustments: [],
    });

    await expect(
      repositories.settlements.findSettlementBySessionId("session-1"),
    ).resolves.toEqual({
      settlement: {
        sessionId: "session-1",
        subtotal: centsOf(20),
        total: centsOf(20),
        status: "settled",
        settledAt: new Date("2026-06-07T11:00:00.000Z"),
      },
      chargeItems: [],
      adjustments: [],
    });

    await repositories.settlements.saveCheckout!({
      id: "checkout-1",
      playerId: "player-1",
      subtotal: centsOf(20),
      total: centsOf(20),
      status: "settled",
      settledAt: new Date("2026-06-07T11:00:00.000Z"),
    }, [{
      settlement: {
        sessionId: "session-1",
        subtotal: centsOf(20),
        total: centsOf(20),
        status: "settled",
        settledAt: new Date("2026-06-07T11:00:00.000Z"),
      },
      chargeItems: [],
      adjustments: [],
    }]);
    expect(db.query("SELECT checkout_id FROM settlements WHERE session_id = ?").get("session-1")).toEqual({
      checkout_id: "checkout-1",
    });
    expect(db.query("SELECT player_id, subtotal, total FROM player_checkouts WHERE id = ?").get("checkout-1")).toEqual({
      player_id: "player-1",
      subtotal: centsOf(20),
      total: centsOf(20),
    });
  });

});

it("resolves cashier external identities with the original payment mode", async () => {
  const db = createDb();
  try {
    db.run("INSERT INTO cashier_profiles(player_id,card_kind,card_uid,created_at) VALUES ('player-1','type-a','AABBCCDD','2026-01-01')");
    const repos = createSqliteRepositories({ db, id: () => "unused", now: () => new Date() });
    await repos.playerIdentities.save({ playerId: "player-1", provider: "onebot", subject: "114514", createdAt: new Date() });
    expect(await repos.playerIdentities.findPlayerByIdentity("onebot", "114514"))
      .toMatchObject({ id: "player-1", paymentMode: "cashier" });
  } finally { db.close(); }
});
