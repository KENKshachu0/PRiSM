import { centsOf, yuanOf } from "@prism/core";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { sqliteSchema } from "@prism/storage-sql";
import {
  createPrismRuntimeDependencies,
  RuntimeRepositories,
} from "../src/index";
import { createPrismApp } from "./test-app";

function createDb() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  for (const statement of sqliteSchema) db.run(statement);
  db.run(
    "INSERT INTO players (id, display_name, status, created_at) VALUES (?, ?, ?, ?)",
    ["player-1", "Neri", "active", "2026-06-07T09:00:00.000Z"],
  );
  bindTestIdentity(db, "player-1");
  db.run(
    "INSERT INTO asset_definitions (type, code, name, stackable) VALUES (?, ?, ?, ?)",
    ["currency", "currency.paid", "Paid balance", 1],
  );
  db.run(
    "INSERT INTO asset_definitions (type, code, name, stackable) VALUES (?, ?, ?, ?)",
    ["currency", "currency.free", "Free balance", 1],
  );
  db.run(
    "INSERT INTO asset_holdings (id, player_id, asset_type, asset_code, quantity) VALUES (?, ?, ?, ?, ?)",
    ["holding-1", "player-1", "currency", "currency.paid", 100],
  );
  db.run(
    "INSERT INTO asset_holdings (id, player_id, asset_type, asset_code, quantity, active_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      "future-free",
      "player-1",
      "currency",
      "currency.free",
      999,
      "2026-06-08T00:00:00.000Z",
      null,
    ],
  );
  db.run(
    "INSERT INTO asset_holdings (id, player_id, asset_type, asset_code, quantity, active_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      "expired-free",
      "player-1",
      "currency",
      "currency.free",
      999,
      "2026-06-01T00:00:00.000Z",
      "2026-06-07T09:59:59.000Z",
    ],
  );
  return db;
}

function bindTestIdentity(db: Database, playerId: string) {
  db.run(
    "INSERT INTO player_identities (player_id, provider, subject, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(shop_id, provider, subject) DO UPDATE SET player_id = excluded.player_id",
    [playerId, "test", playerId, "2026-06-07T09:00:00.000Z"],
  );
}

function insertEffectAssetDefinition(
  db: Database,
  input: {
    assetType: string;
    assetCode: string;
    assetName: string;
    effectType: "free" | "discount" | "percentage-discount" | "surcharge";
    scope: "session" | "unified";
    value?: number | null;
    consumable?: boolean;
    limitPerDay?: number | null;
    config?: Record<string, unknown> | null;
  },
) {
  const effectId = `effect:${input.assetType}:${input.assetCode}`;
  db.run(
    "INSERT INTO pricing_effects (id, name, type, scope, value, consumable, limit_per_day, status, config_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      effectId,
      input.assetName,
      input.effectType,
      input.scope,
      input.value ?? null,
      input.consumable ? 1 : 0,
      input.limitPerDay ?? null,
      "active",
      input.config ? JSON.stringify(input.config) : null,
    ],
  );
  db.run(
    "INSERT INTO asset_definitions (type, code, name, stackable, pricing_effect_id) VALUES (?, ?, ?, ?, ?)",
    [input.assetType, input.assetCode, input.assetName, 0, effectId],
  );
}

function insertActiveSession(
  db: Database,
  input: {
    id: string;
    playerId: string;
    startedAt: string;
  },
) {
  db.run(
    "INSERT INTO sessions (id, player_id, started_at, ended_at, status) VALUES (?, ?, ?, ?, ?)",
    [input.id, input.playerId, input.startedAt, null, "active"],
  );
}

function createRuntimeForDb(db: Database, now: () => Date) {
  let nextId = 0;
  return createPrismRuntimeDependencies({
    repositories: RuntimeRepositories.fromBunSqlite({
      db,
      id: () => `id-${++nextId}`,
      now,
    }),
    queries: RuntimeRepositories.queriesFromBunSqlite({
      db,
      now,
    }),
    pricingProviders: [],
    assetEffectProviders: [],
    coinCooldownMs: 60_000,
    id: () => `id-${++nextId}`,
    now,
  });
}

async function confirmPlayerCheckout(
  app: ReturnType<typeof createPrismApp>,
  playerId: string,
): Promise<unknown> {
  const response = await app.request("/rpc/player/checkout/confirm", {
    method: "POST",
    headers: {
      ...(await playerSessionHeaders(app, playerId)),
    },
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function playerSessionHeaders(app: ReturnType<typeof createPrismApp>, playerId: string) {
  const response = await app.request("/rpc/player-auth/login/by-identity", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer staff-token",
    },
    body: JSON.stringify({
      identity: {
        provider: "test",
        subject: playerId,
      },
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { session: { token: string } };
  return {
    Authorization: `Bearer ${body.session.token}`,
  };
}

describe("createPrismRuntimeDependencies", () => {
  it("grants the configured present when integration registers a player", async () => {
    const db = createDb();
    const now = new Date("2026-06-07T10:00:00.000Z");
    db.run(
      "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)",
      [
        "player.registration",
        JSON.stringify({ defaultPresentId: "present-welcome" }),
        now.toISOString(),
      ],
    );
    db.run(
      "INSERT INTO presents (id, name, once_per_player, active_at, expires_at, status, grants_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "present-welcome",
        "新用户欢迎包",
        0,
        null,
        null,
        "active",
        JSON.stringify([
          {
            assetType: "currency",
            assetCode: "currency.paid",
            amount: 80,
            mergeStrategy: "stack",
            activeAt: null,
            expiresAt: null,
          },
        ]),
      ],
    );

    const runtime = createRuntimeForDb(db, () => now);
    const player = await runtime.integrationCommands!.resolveOrRegisterPlayerByIdentity({
      identity: { provider: "qq", subject: "10001" },
      autoRegister: true,
      displayName: "Guest",
    });

    expect(player).toMatchObject({
      id: "id-1",
      displayName: "Guest",
      status: "active",
    });
    expect(db
      .query("SELECT asset_type, asset_code, quantity FROM asset_holdings WHERE player_id = ?")
      .all(player.id)).toEqual([
        {
          asset_type: "currency",
          asset_code: "currency.paid",
          quantity: 80,
        },
      ]);
  });

  it("persists priority time pricing cap history per player and rule anchor during checkout", async () => {
    const db = createDb();
    db.run(
      "INSERT INTO players (id, display_name, status, created_at) VALUES (?, ?, ?, ?)",
      ["player-2", "Rin", "active", "2026-06-07T09:00:00.000Z"],
    );
    bindTestIdentity(db, "player-2");
    db.run(
      "INSERT INTO asset_holdings (id, player_id, asset_type, asset_code, quantity) VALUES (?, ?, ?, ?, ?)",
      ["holding-player-2", "player-2", "currency", "currency.paid", 100],
    );
    db.run(
      `INSERT INTO pricing_configs (id, kind, name, enabled, provider_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "pricing-day-night",
        "time.priority",
        "标准日夜计费",
        1,
        JSON.stringify({
          id: "time.day-night",
          timeZone: "Asia/Tokyo",
          rules: [
            {
              id: "day",
              label: "日间",
              priority: 1,
              timeRange: {
                start: "10:00",
                end: "22:00",
              },
              pricing: {
                unitMinutes: 30,
                unitPrice: 4,
                roundGraceMinutes: 0,
                priceCap: 40,
              },
            },
            {
              id: "night",
              label: "夜间",
              priority: 1,
              timeRange: {
                start: "22:00",
                end: "10:00",
              },
              pricing: {
                unitMinutes: 30,
                unitPrice: 4,
                roundGraceMinutes: 0,
                priceCap: 40,
              },
            },
          ],
        }),
        "2026-06-07T00:00:00.000Z",
        "2026-06-07T00:00:00.000Z",
      ],
    );

    let currentTime = new Date("2026-06-07T06:00:00.000Z");
    const app = createPrismApp(createRuntimeForDb(db, () => currentTime));

    insertActiveSession(db, {
      id: "session-player-1-first",
      playerId: "player-1",
      startedAt: "2026-06-07T01:00:00.000Z",
    });
    const firstCheckout = await confirmPlayerCheckout(app, "player-1");
    expect(firstCheckout).toMatchObject({
      playerSettlement: {
        subtotal: 40,
        total: 40,
      },
      chargeItems: [
        {
          source: "time.day-night",
          label: "日间",
          amount: 40,
        },
      ],
    });

    currentTime = new Date("2026-06-07T09:00:00.000Z");
    insertActiveSession(db, {
      id: "session-player-1-second",
      playerId: "player-1",
      startedAt: "2026-06-07T07:00:00.000Z",
    });
    const secondCheckout = await confirmPlayerCheckout(app, "player-1");
    expect(secondCheckout).toMatchObject({
      playerSettlement: {
        subtotal: 0,
        total: 0,
      },
      chargeItems: [
        {
          source: "time.day-night",
          label: "日间",
          amount: 0,
        },
      ],
    });

    insertActiveSession(db, {
      id: "session-player-2-first",
      playerId: "player-2",
      startedAt: "2026-06-07T07:00:00.000Z",
    });
    const otherPlayerCheckout = await confirmPlayerCheckout(app, "player-2");
    expect(otherPlayerCheckout).toMatchObject({
      playerSettlement: {
        subtotal: 16,
        total: 16,
      },
      chargeItems: [
        {
          source: "time.day-night",
          label: "日间",
          amount: 16,
        },
      ],
    });

    const historyRows = db
      .query<
        {
          player_id: string;
          rule_id: string;
          rule_anchor_at: string;
          amount: number;
        },
        []
      >(
        `SELECT player_id, rule_id, rule_anchor_at, amount
         FROM pricing_history_entries
         ORDER BY player_id, session_id`,
      )
      .all();
    expect(historyRows).toEqual([
      {
        player_id: "player-1",
        rule_id: "day",
        rule_anchor_at: "2026-06-07T01:00:00.000Z",
        amount: 40,
      },
      {
        player_id: "player-1",
        rule_id: "day",
        rule_anchor_at: "2026-06-07T01:00:00.000Z",
        amount: 0,
      },
      {
        player_id: "player-2",
        rule_id: "day",
        rule_anchor_at: "2026-06-07T01:00:00.000Z",
        amount: 16,
      },
    ]);
  });

  it("lets store plugins quote from active persisted business items", async () => {
    const db = createDb();
    db.run(
      "INSERT INTO sessions (id, player_id, started_at, ended_at, status) VALUES (?, ?, ?, ?, ?)",
      ["session-1", "player-1", "2026-06-07T10:00:00.000Z", null, "active"],
    );
    for (const item of [
      {
        id: "business-item-active",
        kind: "event.entry",
        name: "周末活动入场",
        status: "active",
        price: 80,
        activeAt: "2026-06-07T00:00:00.000Z",
        expiresAt: "2026-06-08T00:00:00.000Z",
      },
      {
        id: "business-item-archived",
        kind: "event.entry",
        name: "已归档活动",
        status: "archived",
        price: 999,
        activeAt: "2026-06-07T00:00:00.000Z",
        expiresAt: "2026-06-08T00:00:00.000Z",
      },
      {
        id: "business-item-future",
        kind: "event.entry",
        name: "未开始活动",
        status: "active",
        price: 999,
        activeAt: "2026-06-08T00:00:00.000Z",
        expiresAt: null,
      },
      {
        id: "business-item-expired",
        kind: "event.entry",
        name: "已结束活动",
        status: "active",
        price: 999,
        activeAt: "2026-06-01T00:00:00.000Z",
        expiresAt: "2026-06-07T09:59:59.000Z",
      },
      {
        id: "business-item-other",
        kind: "room.package",
        name: "包间套餐",
        status: "active",
        price: 999,
        activeAt: "2026-06-07T00:00:00.000Z",
        expiresAt: null,
      },
    ] as const) {
      db.run(
        `INSERT INTO business_items (id, kind, name, status, price, asset_type, asset_code, active_at, expires_at, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id,
          item.kind,
          item.name,
          item.status,
          item.price,
          null,
          null,
          item.activeAt,
          item.expiresAt,
          JSON.stringify({ channel: "webui" }),
          "2026-06-07T09:00:00.000Z",
          "2026-06-07T09:00:00.000Z",
        ],
      );
    }

    let nextId = 0;
    let currentTime = new Date("2026-06-07T10:00:00.000Z");
    const dependencies = createPrismRuntimeDependencies({
      repositories: RuntimeRepositories.fromBunSqlite({
        db,
        id: () => `id-${++nextId}`,
        now: () => currentTime,
      }),
      queries: RuntimeRepositories.queriesFromBunSqlite({
        db,
        now: () => currentTime,
      }),
      pricingProviders: [],
      assetEffectProviders: [],
      plugins: [
        {
          id: "plugin.event-entry",
          createPricingProviders(context) {
            return [
              {
                id: "plugin.event-entry.pricing",
                async quote(quoteContext) {
                  const items = await context.businessItems.listActive({
                    kind: "event.entry",
                    now: quoteContext.now,
                  });
                  return items.map((item) => ({
                    id: `${quoteContext.session.id}:${item.id}`,
                    source: "plugin.event-entry",
                    label: item.name,
                    amount: item.price,
                  }));
                },
              },
            ];
          },
        },
      ],
      coinCooldownMs: 60_000,
      id: () => `id-${++nextId}`,
      now: () => currentTime,
    });
    const app = createPrismApp(dependencies);

    const previewResponse = await app.request("/rpc/player/checkout/preview", {
      method: "POST",
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });

    expect(previewResponse.status).toBe(200);
    await expect(previewResponse.json()).resolves.toMatchObject({
      settlementPreview: {
        subtotal: 80,
        total: 80,
      },
      chargeItems: [
        {
          source: "plugin.event-entry",
          label: "周末活动入场",
          amount: 80,
        },
      ],
    });
  });

  it("applies time-free asset definitions as built-in settlement effects", async () => {
    const db = createDb();
    insertEffectAssetDefinition(db, {
      assetType: "pass",
      assetCode: "pass.monthly",
      assetName: "月卡",
      effectType: "free",
      scope: "session",
    });
    db.run(
      "INSERT INTO asset_holdings (id, player_id, asset_type, asset_code, quantity, active_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "holding-pass",
        "player-1",
        "pass",
        "pass.monthly",
        1,
        "2026-06-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z",
      ],
    );
    db.run(
      "INSERT INTO sessions (id, player_id, started_at, ended_at, status) VALUES (?, ?, ?, ?, ?)",
      ["session-1", "player-1", "2026-06-07T10:00:00.000Z", null, "active"],
    );

    let nextId = 0;
    let currentTime = new Date("2026-06-07T11:00:00.000Z");
    const dependencies = createPrismRuntimeDependencies({
      repositories: RuntimeRepositories.fromBunSqlite({
        db,
        id: () => `id-${++nextId}`,
        now: () => currentTime,
      }),
      queries: RuntimeRepositories.queriesFromBunSqlite({
        db,
        now: () => currentTime,
      }),
      pricingProviders: [
        {
          id: "manual-time",
          quote(context) {
            return [
              {
                id: `${context.session.id}:manual-time`,
                source: "manual-time",
                label: "按时计费",
                amount: 80,
              },
            ];
          },
        },
      ],
      assetEffectProviders: [],
      coinCooldownMs: 60_000,
      id: () => `id-${++nextId}`,
      now: () => currentTime,
    });
    const app = createPrismApp(dependencies);

    const previewResponse = await app.request("/rpc/player/checkout/preview", {
      method: "POST",
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });

    expect(previewResponse.status).toBe(200);
    await expect(previewResponse.json()).resolves.toMatchObject({
      settlementPreview: {
        subtotal: 80,
        total: 0,
      },
      adjustments: [
        {
          source: "pass.monthly",
          label: "月卡",
          amount: -80,
        },
      ],
    });
  });

  it("applies configurable session-scope coupons with label, config and day constraints", async () => {
    const db = createDb();
    insertEffectAssetDefinition(db, {
      assetType: "coupon",
      assetCode: "coupon.weekday-gold",
      assetName: "黄金工作日券",
      effectType: "discount",
      scope: "session",
      value: 30,
      consumable: true,
      config: {
        daysOfWeek: [1, 2, 3, 4, 5],
        applicableSessionLabels: ["gaming"],
        applicablePricingConfigIds: ["pc-gaming"],
      },
    });

    db.run(
      "INSERT INTO asset_holdings (id, player_id, asset_type, asset_code, quantity, active_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "holding-coupon",
        "player-1",
        "coupon",
        "coupon.weekday-gold",
        2,
        "2026-06-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z",
      ],
    );

    db.run(
      "INSERT INTO sessions (id, player_id, started_at, ended_at, status, label, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "session-1",
        "player-1",
        "2026-06-10T10:00:00.000Z",
        null,
        "active",
        "gaming",
        "unpaid",
      ],
    );

    let nextId = 0;
    let currentTime = new Date("2026-06-10T11:00:00.000Z");
    const dependencies = createPrismRuntimeDependencies({
      repositories: RuntimeRepositories.fromBunSqlite({
        db,
        id: () => `id-${++nextId}`,
        now: () => currentTime,
      }),
      queries: RuntimeRepositories.queriesFromBunSqlite({
        db,
        now: () => currentTime,
      }),
      pricingProviders: [
        {
          id: "pc-gaming",
          quote(context) {
            return [
              {
                id: `${context.session.id}:gaming-charge`,
                source: "pc-gaming",
                label: "游戏计费",
                amount: 80,
                pricingHistory: {
                  pricingConfigId: "pc-gaming",
                  providerId: "pc-gaming",
                  ruleId: "pc-gaming-rule",
                  ruleAnchorAt: context.session.startedAt,
                  amount: 80,
                },
              },
            ];
          },
        },
      ],
      assetEffectProviders: [],
      coinCooldownMs: 60_000,
      id: () => `id-${++nextId}`,
      now: () => currentTime,
    });
    const app = createPrismApp(dependencies);

    const previewResponse = await app.request("/rpc/player/checkout/preview", {
      method: "POST",
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });

    expect(previewResponse.status).toBe(200);
    const json = await previewResponse.json();
    expect(json.settlementPreview.total).toBe(50);
    expect(json.adjustments).toContainEqual(
      expect.objectContaining({
        source: "coupon.weekday-gold",
        amount: -30,
      }),
    );

    const checkoutResponse = await app.request("/rpc/player/checkout/confirm", {
      method: "POST",
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });
    expect(checkoutResponse.status).toBe(200);

    const holdingRow = db
      .query("SELECT quantity FROM asset_holdings WHERE id = ?")
      .get("holding-coupon") as any;
    expect(yuanOf(holdingRow.quantity)).toBe(1);
  });

  it("applies configurable session-scope coupons with date range constraints", async () => {
    const db = createDb();
    insertEffectAssetDefinition(db, {
      assetType: "coupon",
      assetCode: "coupon.date-limited",
      assetName: "日期限定券",
      effectType: "discount",
      scope: "session",
      value: 30,
      consumable: true,
      config: {
        startDate: "2026-06-05",
        endDate: "2026-06-15",
      },
    });

    db.run(
      "INSERT INTO asset_holdings (id, player_id, asset_type, asset_code, quantity, active_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "holding-coupon",
        "player-1",
        "coupon",
        "coupon.date-limited",
        2,
        "2026-06-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z",
      ],
    );

    db.run(
      "INSERT INTO sessions (id, player_id, started_at, ended_at, status, payment_status) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "session-valid",
        "player-1",
        "2026-06-10T10:00:00.000Z",
        null,
        "active",
        "unpaid",
      ],
    );

    let nextId = 0;
    let currentTime = new Date("2026-06-10T11:00:00.000Z");
    const dependencies = createPrismRuntimeDependencies({
      repositories: RuntimeRepositories.fromBunSqlite({
        db,
        id: () => `id-${++nextId}`,
        now: () => currentTime,
      }),
      queries: RuntimeRepositories.queriesFromBunSqlite({
        db,
        now: () => currentTime,
      }),
      pricingProviders: [
        {
          id: "pc-gaming",
          quote(context) {
            return [
              {
                id: `${context.session.id}:gaming-charge`,
                source: "pc-gaming",
                label: "游戏计费",
                amount: 80,
              },
            ];
          },
        },
      ],
      assetEffectProviders: [],
      coinCooldownMs: 60_000,
      id: () => `id-${++nextId}`,
      now: () => currentTime,
    });
    const app = createPrismApp(dependencies);

    const preview1 = await app.request("/rpc/player/checkout/preview", {
      method: "POST",
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
      body: JSON.stringify({ sessionId: "session-valid" }),
    });
    expect(preview1.status).toBe(200);
    const json1 = await preview1.json();
    expect(json1.settlementPreview.total).toBe(50);

    await app.request("/rpc/player/checkout/confirm", {
      method: "POST",
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
      body: JSON.stringify({ sessionId: "session-valid" }),
    });

    db.run(
      "INSERT INTO sessions (id, player_id, started_at, ended_at, status, payment_status) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "session-invalid",
        "player-1",
        "2026-06-20T10:00:00.000Z",
        null,
        "active",
        "unpaid",
      ],
    );
    currentTime = new Date("2026-06-20T11:00:00.000Z");

    const preview2 = await app.request("/rpc/player/checkout/preview", {
      method: "POST",
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
      body: JSON.stringify({ sessionId: "session-invalid" }),
    });
    expect(preview2.status).toBe(200);
    const json2 = await preview2.json();
    expect(json2.settlementPreview.total).toBe(80);
  });

  it("applies configurable unified-scope monthly card with daily limits across checkouts", async () => {
    const db = createDb();
    db.run(
      "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)",
      [
        "venue.operations",
        JSON.stringify({ timeZone: "Asia/Tokyo" }),
        "2026-06-10T10:00:00.000Z",
      ],
    );

    insertEffectAssetDefinition(db, {
      assetType: "pass",
      assetCode: "pass.vip-monthly",
      assetName: "VIP月卡",
      effectType: "free",
      scope: "unified",
      limitPerDay: 1,
    });

    db.run(
      "INSERT INTO asset_holdings (id, player_id, asset_type, asset_code, quantity, active_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "holding-vip",
        "player-1",
        "pass",
        "pass.vip-monthly",
        1,
        "2026-06-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z",
      ],
    );

    db.run(
      "INSERT INTO asset_holdings (id, player_id, asset_type, asset_code, quantity, active_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "holding-coin",
        "player-1",
        "currency",
        "currency.paid",
        1000,
        "2026-06-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z",
      ],
    );

    db.run(
      "INSERT INTO sessions (id, player_id, started_at, ended_at, status, pricing_config_ids_json, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "session-1",
        "player-1",
        "2026-06-10T10:00:00.000Z",
        null,
        "active",
        JSON.stringify(["pc-gaming"]),
        "unpaid",
      ],
    );

    let nextId = 0;
    let currentTime = new Date("2026-06-10T11:00:00.000Z");
    const dependencies = createPrismRuntimeDependencies({
      repositories: RuntimeRepositories.fromBunSqlite({
        db,
        id: () => `id-${++nextId}`,
        now: () => currentTime,
      }),
      queries: RuntimeRepositories.queriesFromBunSqlite({
        db,
        now: () => currentTime,
      }),
      pricingProviders: [
        {
          id: "pc-gaming",
          quote(context) {
            return [
              {
                id: `${context.session.id}:gaming-charge`,
                source: "pc-gaming",
                label: "游戏计费",
                amount: 80,
                pricingHistory: {
                  pricingConfigId: "pc-gaming",
                  providerId: "pc-gaming",
                  ruleId: "pc-gaming-rule",
                  ruleAnchorAt: context.session.startedAt,
                  amount: 80,
                },
              },
            ];
          },
        },
      ],
      assetEffectProviders: [],
      coinCooldownMs: 60_000,
      id: () => `id-${++nextId}`,
      now: () => currentTime,
    });
    const app = createPrismApp(dependencies);

    const checkout1 = await app.request("/rpc/player/checkout/confirm", {
      method: "POST",
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
      body: JSON.stringify({ sessionId: "session-1" }),
    });
    expect(checkout1.status).toBe(200);
    const result1 = await checkout1.json();
    expect(result1.playerSettlement.total).toBe(0);

    db.run(
      "INSERT INTO sessions (id, player_id, started_at, ended_at, status, pricing_config_ids_json, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "session-2",
        "player-1",
        "2026-06-10T12:00:00.000Z",
        null,
        "active",
        JSON.stringify(["pc-gaming"]),
        "unpaid",
      ],
    );
    currentTime = new Date("2026-06-10T13:00:00.000Z");

    const checkout2 = await app.request("/rpc/player/checkout/confirm", {
      method: "POST",
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
      body: JSON.stringify({ sessionId: "session-2" }),
    });
    expect(checkout2.status).toBe(200);
    const result2 = await checkout2.json();
    expect(result2.playerSettlement.total).toBe(80);
  });

  it("composes store plugins into pricing and asset effect providers for custom non-time products", async () => {
    const db = createDb();
    let nextId = 0;
    let currentTime = new Date("2026-06-07T10:00:00.000Z");
    const dependencies = createPrismRuntimeDependencies({
      repositories: RuntimeRepositories.fromBunSqlite({
        db,
        id: () => `id-${++nextId}`,
        now: () => currentTime,
      }),
      queries: RuntimeRepositories.queriesFromBunSqlite({
        db,
        now: () => currentTime,
      }),
      pricingProviders: [],
      assetEffectProviders: [],
      plugins: [
        {
          id: "plugin.exam-ticket",
          pricingProviders: [
            {
              id: "plugin.exam-ticket.pricing",
              quote(context) {
                return [
                  {
                    id: `${context.session.id}:exam-ticket`,
                    source: "plugin.exam-ticket",
                    label: "准考证活动",
                    amount: 120,
                  },
                ];
              },
            },
          ],
          assetEffectProviders: [
            {
              id: "plugin.exam-ticket.discount",
              apply(context) {
                const hasCoupon = context.assetHoldings.some(
                  (holding) =>
                    holding.assetType === "coupon" &&
                    holding.assetCode === "exam",
                );
                if (!hasCoupon) return [];
                return [
                  {
                    id: `${context.session.id}:exam-ticket-discount`,
                    source: "plugin.exam-ticket",
                    label: "准考证活动券",
                    amount: -20,
                  },
                ];
              },
            },
          ],
        },
      ],
      coinCooldownMs: 60_000,
      id: () => `id-${++nextId}`,
      now: () => currentTime,
    });
    const app = createPrismApp(dependencies);

    await app.request("/rpc/staff/asset-definitions/coupon/exam", {
      method: "PUT",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "准考证活动券",
        stackable: true,
        metadata: null,
      }),
    });
    const grantResponse = await app.request(
      "/rpc/staff/players/player-1/assets/grants",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer staff-token",
          "Content-Type": "application/json",
          "X-PRiSM-Staff-Id": "staff-1",
        },
        body: JSON.stringify({
          grants: [
            {
              assetType: "coupon",
              assetCode: "exam",
              amount: 1,
              mergeStrategy: "stack",
              activeAt: null,
              expiresAt: null,
            },
          ],
        }),
      },
    );
    expect(grantResponse.status).toBe(200);
    const startResponse = await app.request("/rpc/player/session/start", {
      method: "POST",
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });
    expect(startResponse.status).toBe(200);

    const previewResponse = await app.request("/rpc/player/checkout/preview", {
      method: "POST",
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });

    expect(previewResponse.status).toBe(200);
    await expect(previewResponse.json()).resolves.toMatchObject({
      settlementPreview: {
        subtotal: 120,
        total: 100,
      },
      chargeItems: [
        {
          source: "plugin.exam-ticket",
          label: "准考证活动",
          amount: 120,
        },
      ],
      adjustments: [
        {
          source: "plugin.exam-ticket",
          label: "准考证活动券",
          amount: -20,
        },
      ],
    });
  });

  it("composes the Hono app dependencies for a local SQLite deployment", async () => {
    const db = createDb();
    db.run(
      "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)",
      [
        "devices.homeassistant",
        JSON.stringify([{ name: "Front Door", alias: ["door"], id: "lock.front_door" }]),
        "2026-06-07T10:00:00.000Z",
      ],
    );
    let nextId = 0;
    let currentTime = new Date("2026-06-07T10:00:00.000Z");
    const dependencies = createPrismRuntimeDependencies({
      repositories: RuntimeRepositories.fromBunSqlite({
        db,
        id: () => `id-${++nextId}`,
        now: () => currentTime,
      }),
      queries: RuntimeRepositories.queriesFromBunSqlite({
        db,
        now: () => new Date("2026-06-07T10:30:00.000Z"),
      }),
      pricingProviders: [
        {
          id: "flat-test",
          quote(context) {
            return [
              {
                id: `${context.session.id}:flat-test`,
                source: "flat-test",
                label: "Flat test",
                amount: 999,
              },
            ];
          },
        },
      ],
      assetEffectProviders: [],
      coinCooldownMs: 60_000,
      id: () => `id-${++nextId}`,
      now: () => currentTime,
    });
    const app = createPrismApp(dependencies);

    const pricingResponse = await app.request("/rpc/staff/pricing-configs", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        kind: "time.priority",
        name: "Runtime time pricing",
        enabled: true,
        provider: {
          id: "time.runtime",
          rules: [
            {
              id: "base",
              label: "Base runtime",
              priority: 0,
              timeRange: {
                start: "00:00",
                end: "00:00",
              },
              pricing: {
                unitMinutes: 30,
                unitPrice: 10,
                roundGraceMinutes: 0,
                priceCap: 100,
              },
            },
          ],
        },
      }),
    });
    expect(pricingResponse.status).toBe(200);

    const pricingEffectResponse = await app.request(
      "/rpc/staff/pricing-effects/effect-monthly-pass",
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer staff-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Monthly pass",
          type: "free",
          scope: "session",
          value: null,
          consumable: false,
          limitPerDay: null,
          config: null,
        }),
      },
    );
    expect(pricingEffectResponse.status).toBe(200);

    const assetDefinitionResponse = await app.request(
      "/rpc/staff/asset-definitions/pass/pass.monthly",
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer staff-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Monthly pass",
          stackable: false,
          pricingEffectId: "effect-monthly-pass",
          metadata: null,
        }),
      },
    );
    expect(assetDefinitionResponse.status).toBe(200);
    const hiddenTitleDefinitionResponse = await app.request(
      "/rpc/staff/asset-definitions/title/title.secret",
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer staff-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Secret title",
          stackable: false,
          metadata: {
            hiddenFromPlayer: true,
          },
        }),
      },
    );
    expect(hiddenTitleDefinitionResponse.status).toBe(200);
    const assetDefinitionsResponse = await app.request(
      "/rpc/staff/asset-definitions",
      {
        headers: {
          Authorization: "Bearer staff-token",
        },
      },
    );
    expect(assetDefinitionsResponse.status).toBe(200);
    await expect(assetDefinitionsResponse.json()).resolves.toMatchObject({
      assetDefinitions: [
        {
          type: "currency",
          code: "currency.free",
          name: "Free balance",
          stackable: true,
          metadata: null,
        },
        {
          type: "currency",
          code: "currency.paid",
          name: "Paid balance",
          stackable: true,
          metadata: null,
        },
        {
          type: "pass",
          code: "pass.monthly",
          name: "Monthly pass",
          stackable: false,
          pricingEffectId: "effect-monthly-pass",
          metadata: null,
        },
        {
          type: "title",
          code: "title.secret",
          name: "Secret title",
          stackable: false,
          metadata: {
            hiddenFromPlayer: true,
          },
        },
      ],
    });

    const passGrantResponse = await app.request(
      "/rpc/staff/players/player-1/assets/grants",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer staff-token",
          "Content-Type": "application/json",
          "X-PRiSM-Staff-Id": "staff-1",
        },
        body: JSON.stringify({
          grants: [
            {
              assetType: "pass",
              assetCode: "pass.monthly",
              amount: 1,
              mergeStrategy: "replace",
              activeAt: "2026-06-07T10:00:00.000Z",
              expiresAt: "2026-07-07T10:00:00.000Z",
            },
          ],
        }),
      },
    );
    expect(passGrantResponse.status).toBe(200);

    const hiddenTitleGrantResponse = await app.request(
      "/rpc/staff/players/player-1/assets/grants",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer staff-token",
          "Content-Type": "application/json",
          "X-PRiSM-Staff-Id": "staff-1",
        },
        body: JSON.stringify({
          grants: [
            {
              assetType: "title",
              assetCode: "title.secret",
              amount: 1,
              mergeStrategy: "replace",
              activeAt: null,
              expiresAt: null,
            },
          ],
        }),
      },
    );
    expect(hiddenTitleGrantResponse.status).toBe(200);

    const playerAssetsResponse = await app.request("/rpc/player/assets", {
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });
    expect(playerAssetsResponse.status).toBe(200);
    const playerAssets = (await playerAssetsResponse.json()) as {
      holdings: Array<{ assetCode: string }>;
      ledgerEntries: Array<{ assetCode: string }>;
    };
    expect(playerAssets).toMatchObject({
      holdings: [
        {
          id: "holding-1",
          assetType: "currency",
          assetCode: "currency.paid",
          assetName: "Paid balance",
          quantity: 100,
          activeAt: null,
          expiresAt: null,
          metadata: null,
        },
        {
          assetType: "pass",
          assetCode: "pass.monthly",
          assetName: "Monthly pass",
          quantity: 1,
          activeAt: "2026-06-07T10:00:00.000Z",
          expiresAt: "2026-07-07T10:00:00.000Z",
          metadata: null,
        },
      ],
      ledgerEntries: [
        {
          assetType: "pass",
          assetCode: "pass.monthly",
          assetName: "Monthly pass",
          delta: 1,
          reason: "staff.asset.grant",
          refId: "staff",
          createdAt: "2026-06-07T10:00:00.000Z",
        },
      ],
    });
    expect(
      playerAssets.holdings.some(
        (holding) => holding.assetCode === "title.secret",
      ),
    ).toBe(false);

    const staffPlayerAssetsResponse = await app.request(
      "/rpc/staff/players/player-1/assets",
      {
        headers: {
          Authorization: "Bearer staff-token",
        },
      },
    );
    expect(staffPlayerAssetsResponse.status).toBe(200);
    await expect(staffPlayerAssetsResponse.json()).resolves.toMatchObject({
      holdings: [
        {
          assetType: "currency",
          assetCode: "currency.free",
          assetName: "Free balance",
          availability: "unavailable",
          unavailableReasons: ["holding_expired"],
        },
        {
          assetType: "currency",
          assetCode: "currency.free",
          assetName: "Free balance",
          availability: "unavailable",
          unavailableReasons: ["holding_not_active"],
        },
        {
          assetType: "currency",
          assetCode: "currency.paid",
          assetName: "Paid balance",
          availability: "available",
          unavailableReasons: [],
        },
        {
          assetType: "pass",
          assetCode: "pass.monthly",
          assetName: "Monthly pass",
        },
        {
          assetType: "title",
          assetCode: "title.secret",
          assetName: "Secret title",
          availability: "available",
          unavailableReasons: [],
        },
      ],
    });

    const startResponse = await app.request("/rpc/player/session/start", {
      method: "POST",
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });
    expect(startResponse.status).toBe(200);

    const bindAimeIdentityResponse = await app.request(
      "/rpc/staff/players/player-1/identities",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer staff-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "aime",
          subject: "card-1",
        }),
      },
    );
    expect(bindAimeIdentityResponse.status).toBe(200);

    const doorCommandResponse = await app.request(
      "/rpc/player/device-commands",
      {
        method: "POST",
        headers: {
          ...(await playerSessionHeaders(app, "player-1")),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "door.open",
          target: {
            kind: "facility",
            ref: "door",
          },
        }),
      },
    );
    expect(doorCommandResponse.status).toBe(200);

    const rawHomeAssistantIdResponse = await app.request(
      "/rpc/player/device-commands",
      {
        method: "POST",
        headers: {
          ...(await playerSessionHeaders(app, "player-1")),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "door.open",
          target: {
            kind: "facility",
            ref: "lock.front_door",
          },
        }),
      },
    );
    expect(rawHomeAssistantIdResponse.status).toBe(400);
    await expect(rawHomeAssistantIdResponse.json()).resolves.toEqual({
      error: {
        code: "DEVICE_NOT_FOUND",
        message: "设备不存在",
      },
    });

    const scanCommandResponse = await app.request(
      "/rpc/player/device-commands",
      {
        method: "POST",
        headers: {
          ...(await playerSessionHeaders(app, "player-1")),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "aime.scan",
          target: {
            kind: "game_machine",
            id: "aime-reader-1",
          },
          payload: {
            provider: "aime",
            subject: "card-1",
          },
        }),
      },
    );
    expect(scanCommandResponse.status).toBe(200);

    const commandAuditResponse = await app.request(
      "/rpc/staff/device-commands?limit=10",
      {
        headers: {
          Authorization: "Bearer staff-token",
        },
      },
    );
    expect(commandAuditResponse.status).toBe(200);
    await expect(commandAuditResponse.json()).resolves.toMatchObject({
      commands: [
        {
          type: "door.open",
          deviceId: "lock.front_door",
          playerId: "player-1",
          status: "pending",
        },
        {
          type: "aime.scan",
          deviceId: "aime-reader-1",
          playerId: "player-1",
          status: "pending",
        },
      ],
    });

    db.run(
      "INSERT INTO device_states (device_id, type, target_kind, executor_kind, label, status, state, metadata_json, reported_at, reported_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "machine-1",
        "power.on",
        "facility",
        "home_assistant",
        "Cabinet 1",
        "online",
        "on",
        JSON.stringify({ voltage: 220 }),
        "2026-06-07T10:00:00.000Z",
        "test_fixture",
      ],
    );

    const staffDeviceStatesResponse = await app.request(
      "/rpc/staff/device-states",
      {
        headers: {
          Authorization: "Bearer staff-token",
        },
      },
    );
    expect(staffDeviceStatesResponse.status).toBe(200);
    await expect(staffDeviceStatesResponse.json()).resolves.toMatchObject({
      deviceStates: [
        {
          deviceId: "machine-1",
          type: "power.on",
          label: "Cabinet 1",
          status: "online",
          state: "on",
          metadata: {
            voltage: 220,
          },
          reportedBy: "test_fixture",
        },
      ],
    });

    currentTime = new Date("2026-06-07T11:00:00.000Z");

    const previewResponse = await app.request("/rpc/player/checkout/preview", {
      method: "POST",
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });
    expect(previewResponse.status).toBe(200);
    await expect(previewResponse.json()).resolves.toMatchObject({
      settlementPreview: {
        subtotal: 20,
        total: 0,
        status: "preview",
      },
      adjustments: [
        {
          source: "pass.monthly",
          label: "Monthly pass",
          amount: -20,
        },
      ],
    });

    const checkoutResponse = await app.request("/rpc/player/checkout/confirm", {
      method: "POST",
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });
    expect(checkoutResponse.status).toBe(200);
    await expect(checkoutResponse.json()).resolves.toMatchObject({
      playerSettlement: {
        subtotal: 20,
        total: 0,
        status: "settled",
      },
      adjustments: [
        {
          source: "pass.monthly",
          label: "Monthly pass",
          amount: -20,
        },
      ],
      assetLedgerEntries: [],
    });

    const playerSessionHistoryResponse = await app.request(
      "/rpc/player/sessions/history",
      {
        headers: {
          ...(await playerSessionHeaders(app, "player-1")),
        },
      },
    );
    expect(playerSessionHistoryResponse.status).toBe(200);
    const playerSessionHistory =
      (await playerSessionHistoryResponse.json()) as {
        sessions: Array<{ sessionId: string }>;
      };
    expect(playerSessionHistory).toMatchObject({
      sessions: [
        {
          startedAt: "2026-06-07T10:00:00.000Z",
          endedAt: "2026-06-07T11:00:00.000Z",
          durationMinutes: 60,
          subtotal: 20,
          total: 0,
          status: "settled",
          settledAt: "2026-06-07T11:00:00.000Z",
        },
      ],
    });
    const settledSessionId = playerSessionHistory.sessions[0]?.sessionId;
    expect(settledSessionId).toBeString();

    const playerSessionHistoryDetailResponse = await app.request(
      `/rpc/player/sessions/${settledSessionId}/history`,
      {
        headers: {
          ...(await playerSessionHeaders(app, "player-1")),
        },
      },
    );
    expect(playerSessionHistoryDetailResponse.status).toBe(200);
    await expect(
      playerSessionHistoryDetailResponse.json(),
    ).resolves.toMatchObject({
      session: {
        sessionId: settledSessionId,
        subtotal: 20,
        total: 0,
        status: "settled",
        chargeItems: [
          {
            source: "time.runtime",
            label: "Base runtime",
            amount: 20,
          },
        ],
        adjustments: [
          {
            source: "pass.monthly",
            label: "Monthly pass",
            amount: -20,
          },
        ],
      },
    });

    const staffPlayerSessionHistoryResponse = await app.request(
      "/rpc/staff/players/player-1/sessions/history",
      {
        headers: {
          Authorization: "Bearer staff-token",
        },
      },
    );
    expect(staffPlayerSessionHistoryResponse.status).toBe(200);
    await expect(
      staffPlayerSessionHistoryResponse.json(),
    ).resolves.toMatchObject({
      sessions: [
        {
          startedAt: "2026-06-07T10:00:00.000Z",
          endedAt: "2026-06-07T11:00:00.000Z",
          durationMinutes: 60,
          subtotal: 20,
          total: 0,
          status: "settled",
          settledAt: "2026-06-07T11:00:00.000Z",
        },
      ],
    });

    const staffPlayerSessionHistoryDetailResponse = await app.request(
      `/rpc/staff/players/player-1/sessions/${settledSessionId}/history`,
      {
        headers: {
          Authorization: "Bearer staff-token",
        },
      },
    );
    expect(staffPlayerSessionHistoryDetailResponse.status).toBe(200);
    await expect(
      staffPlayerSessionHistoryDetailResponse.json(),
    ).resolves.toMatchObject({
      session: {
        sessionId: settledSessionId,
        subtotal: 20,
        total: 0,
        status: "settled",
        chargeItems: [
          {
            source: "time.runtime",
            label: "Base runtime",
            amount: 20,
          },
        ],
        adjustments: [
          {
            source: "pass.monthly",
            label: "Monthly pass",
            amount: -20,
          },
        ],
      },
    });

    const meResponse = await app.request("/rpc/player/me", {
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });
    expect(meResponse.status).toBe(200);
    const me = (await meResponse.json()) as {
      wallet: Array<{ assetCode: string; quantity: number }>;
    };
    expect(me).toMatchObject({
      wallet: [
        {
          assetCode: "currency.paid",
          quantity: 100,
        },
      ],
      activeSession: null,
    });
    expect(
      me.wallet.some((holding) => holding.assetCode === "currency.free"),
    ).toBe(false);

    const grantResponse = await app.request(
      "/rpc/staff/players/player-1/assets/grants",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer staff-token",
          "Content-Type": "application/json",
          "X-PRiSM-Staff-Id": "staff-1",
        },
        body: JSON.stringify({
          grants: [
            {
              assetType: "currency",
              assetCode: "currency.paid",
              amount: 50,
              mergeStrategy: "stack",
              activeAt: null,
              expiresAt: null,
            },
          ],
        }),
      },
    );
    expect(grantResponse.status).toBe(200);

    const afterGrantResponse = await app.request("/rpc/player/me", {
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });
    expect(afterGrantResponse.status).toBe(200);
    await expect(afterGrantResponse.json()).resolves.toMatchObject({
      wallet: [
        {
          assetCode: "currency.paid",
          quantity: 150,
        },
      ],
    });

    const createPlayerResponse = await app.request("/rpc/staff/players", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        displayName: "Guest",
        initialGrants: [
          {
            assetType: "currency",
            assetCode: "currency.paid",
            amount: 80,
            mergeStrategy: "stack",
            activeAt: null,
            expiresAt: null,
          },
        ],
      }),
    });
    expect(createPlayerResponse.status).toBe(200);
    const createdPlayer = (await createPlayerResponse.json()) as {
      player: { id: string };
    };

    const createdPlayerAssetsResponse = await app.request(
      `/rpc/staff/players/${createdPlayer.player.id}/assets`,
      {
        headers: {
          Authorization: "Bearer staff-token",
        },
      },
    );
    expect(createdPlayerAssetsResponse.status).toBe(200);
    const createdPlayerAssets = (await createdPlayerAssetsResponse.json()) as {
      holdings: Array<{ id: string }>;
    };
    expect(createdPlayerAssets).toMatchObject({
      holdings: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          assetName: "Paid balance",
          quantity: 80,
        },
      ],
      ledgerEntries: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          delta: 80,
          reason: "player.register.grant",
          refId: createdPlayer.player.id,
        },
      ],
    });
    const revokeCreatedHoldingResponse = await app.request(
      `/rpc/staff/players/${createdPlayer.player.id}/assets/adjustments`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer staff-token",
          "Content-Type": "application/json",
          "X-PRiSM-Staff-Id": "staff-1",
        },
        body: JSON.stringify({
          adjustments: [
            {
              holdingId: createdPlayerAssets.holdings[0].id,
              assetType: "currency",
              assetCode: "currency.paid",
              quantityDelta: -80,
              reason: "staff.asset.revoke",
            },
          ],
        }),
      },
    );
    expect(revokeCreatedHoldingResponse.status).toBe(200);

    const createdPlayerAssetsAfterRevokeResponse = await app.request(
      `/rpc/staff/players/${createdPlayer.player.id}/assets`,
      {
        headers: {
          Authorization: "Bearer staff-token",
        },
      },
    );
    expect(createdPlayerAssetsAfterRevokeResponse.status).toBe(200);
    await expect(
      createdPlayerAssetsAfterRevokeResponse.json(),
    ).resolves.toMatchObject({
      holdings: [],
      ledgerEntries: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          delta: -80,
          reason: "staff.asset.revoke",
          refId: "staff",
        },
        {
          assetType: "currency",
          assetCode: "currency.paid",
          delta: 80,
          reason: "player.register.grant",
          refId: createdPlayer.player.id,
        },
      ],
    });

    const bindIdentityResponse = await app.request(
      `/rpc/staff/players/${createdPlayer.player.id}/identities`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer staff-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "qq",
          subject: "10001",
        }),
      },
    );
    expect(bindIdentityResponse.status).toBe(200);

    const resolveIdentityResponse = await app.request(
      "/rpc/bot/identities/resolve",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer bot-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "qq",
          subject: "10001",
        }),
      },
    );
    expect(resolveIdentityResponse.status).toBe(200);
    await expect(resolveIdentityResponse.json()).resolves.toMatchObject({
      player: {
        id: createdPlayer.player.id,
        displayName: "Guest",
        status: "active",
      },
    });

    const deleteIdentityResponse = await app.request(
      `/rpc/staff/players/${createdPlayer.player.id}/identities/qq/10001`,
      {
        method: "DELETE",
        headers: {
          Authorization: "Bearer staff-token",
        },
      },
    );
    expect(deleteIdentityResponse.status).toBe(200);

    const resolveDeletedIdentityResponse = await app.request(
      "/rpc/bot/identities/resolve",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer bot-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "qq",
          subject: "10001",
        }),
      },
    );
    expect(resolveDeletedIdentityResponse.status).toBe(404);

    const updateStatusResponse = await app.request(
      `/rpc/staff/players/${createdPlayer.player.id}/status`,
      {
        method: "PATCH",
        headers: {
          Authorization: "Bearer staff-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          status: "disabled",
        }),
      },
    );
    expect(updateStatusResponse.status).toBe(200);
    await expect(updateStatusResponse.json()).resolves.toMatchObject({
      player: {
        displayName: "Guest",
        status: "disabled",
      },
    });

    const presentResponse = await app.request("/rpc/staff/presents", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Recharge",
        oncePerPlayer: false,
        grants: [
          {
            assetType: "currency",
            assetCode: "currency.paid",
            amount: 25,
            mergeStrategy: "stack",
            activeAt: null,
            expiresAt: null,
          },
        ],
      }),
    });
    expect(presentResponse.status).toBe(200);
    const present = (await presentResponse.json()) as {
      present: { id: string };
    };

    const redeemCodeResponse = await app.request("/rpc/staff/redeem-codes", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: "PRISM-LOCAL",
        presentId: present.present.id,
        activeAt: null,
        expiresAt: null,
        maxUseCount: 1,
      }),
    });
    expect(redeemCodeResponse.status).toBe(200);
    const redeemCode = (await redeemCodeResponse.json()) as {
      redeemCode: { id: string };
    };

    const redeemCodesResponse = await app.request("/rpc/staff/redeem-codes", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(redeemCodesResponse.status).toBe(200);
    await expect(redeemCodesResponse.json()).resolves.toMatchObject({
      redeemCodes: [
        {
          code: "PRISM-LOCAL",
          maxUseCount: 1,
        },
      ],
    });

    const redeemResponse = await app.request("/rpc/player/redeem", {
      method: "POST",
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: "PRISM-LOCAL",
      }),
    });
    expect(redeemResponse.status).toBe(200);

    const afterRedeemResponse = await app.request("/rpc/player/me", {
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });
    expect(afterRedeemResponse.status).toBe(200);
    await expect(afterRedeemResponse.json()).resolves.toMatchObject({
      wallet: [
        {
          assetCode: "currency.paid",
          quantity: 175,
        },
      ],
    });

    const staffCodesAfterRedeemResponse = await app.request("/rpc/staff/redeem-codes", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(staffCodesAfterRedeemResponse.status).toBe(200);
    await expect(staffCodesAfterRedeemResponse.json()).resolves.toMatchObject({
      redeemCodes: [
        {
          code: "PRISM-LOCAL",
          usageCount: 1,
          redemptions: [
            {
              playerId: "player-1",
              playerDisplayName: "Neri",
            },
          ],
        },
      ],
    });

    const playerRedeemRecordsResponse = await app.request("/rpc/staff/players/player-1/redeem-records", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(playerRedeemRecordsResponse.status).toBe(200);
    await expect(playerRedeemRecordsResponse.json()).resolves.toMatchObject({
      redeemRecords: [
        {
          code: "PRISM-LOCAL",
          presentId: present.present.id,
          presentName: "Recharge",
        },
      ],
    });

    const revokeResponse = await app.request(
      `/rpc/staff/redeem-codes/${redeemCode.redeemCode.id}/revoke`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer staff-token",
        },
      },
    );
    expect(revokeResponse.status).toBe(200);
    await expect(revokeResponse.json()).resolves.toMatchObject({
      redeemCode: {
        code: "PRISM-LOCAL",
        maxUseCount: 0,
      },
    });

    const batchResponse = await app.request("/rpc/staff/redeem-codes/batch", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prefix: "LOCAL",
        presentId: present.present.id,
        activeAt: null,
        expiresAt: null,
        maxUseCount: 1,
        count: 2,
      }),
    });
    expect(batchResponse.status).toBe(200);
    await expect(batchResponse.json()).resolves.toMatchObject({
      redeemCodes: [
        {
          code: expect.stringMatching(/^LOCAL-id-/),
          presentId: present.present.id,
          maxUseCount: 1,
        },
        {
          code: expect.stringMatching(/^LOCAL-id-/),
          presentId: present.present.id,
          maxUseCount: 1,
        },
      ],
    });

    const staffCheckoutStartResponse = await app.request(
      "/rpc/player/session/start",
      {
        method: "POST",
        headers: {
          ...(await playerSessionHeaders(app, "player-1")),
        },
      },
    );
    expect(staffCheckoutStartResponse.status).toBe(200);
    currentTime = new Date("2026-06-07T11:25:00.000Z");

    const staffCheckoutResponse = await app.request(
      "/rpc/staff/players/player-1/checkout/confirm",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer staff-token",
        },
      },
    );
    expect(staffCheckoutResponse.status).toBe(200);
    await expect(staffCheckoutResponse.json()).resolves.toMatchObject({
      playerSettlement: {
        subtotal: 10,
        total: 0,
        status: "settled",
      },
      adjustments: [
        {
          source: "pass.monthly",
          label: "Monthly pass",
          amount: -10,
        },
      ],
      chargeItems: [
        {
          source: "time.runtime",
          amount: 10,
        },
      ],
    });

    const overrideStartResponse = await app.request(
      "/rpc/player/session/start",
      {
        method: "POST",
        headers: {
          ...(await playerSessionHeaders(app, "player-1")),
        },
      },
    );
    expect(overrideStartResponse.status).toBe(200);
    currentTime = new Date("2026-06-07T11:30:00.000Z");

    const staffOverrideCheckoutResponse = await app.request(
      "/rpc/staff/players/player-1/checkout/override",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer staff-token",
          "Content-Type": "application/json",
          "X-PRiSM-Staff-Id": "staff-1",
        },
        body: JSON.stringify({
          total: 5,
          reason: "machine fault",
        }),
      },
    );
    expect(staffOverrideCheckoutResponse.status).toBe(200);
    const staffOverrideCheckout =
      (await staffOverrideCheckoutResponse.json()) as {
        playerSettlement: { sessionIds: string[] };
        settlements: Array<{ settlement: { sessionId: string } }>;
      };
    expect(staffOverrideCheckout).toMatchObject({
      playerSettlement: {
        subtotal: 10,
        total: 5,
        status: "settled",
      },
      adjustments: [
        {
          source: "pass.monthly",
          label: "Monthly pass",
          amount: -10,
        },
        {
          source: "staff.override:staff",
          label: "Staff override: machine fault",
          amount: 5,
        },
      ],
      assetLedgerEntries: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          delta: -5,
        },
      ],
    });

    const overrideDetailResponse = await app.request(
      `/rpc/staff/players/player-1/sessions/${staffOverrideCheckout.settlements[0].settlement.sessionId}/history`,
      {
        headers: {
          Authorization: "Bearer staff-token",
        },
      },
    );
    expect(overrideDetailResponse.status).toBe(200);
    await expect(overrideDetailResponse.json()).resolves.toMatchObject({
      session: {
        sessionId: staffOverrideCheckout.settlements[0].settlement.sessionId,
        subtotal: 10,
        total: 5,
        adjustments: [
          {
            source: "pass.monthly",
            label: "Monthly pass",
            amount: -10,
          },
          {
            source: "staff.override:staff",
            label: "Staff override: machine fault",
            amount: 5,
          },
        ],
      },
    });

    const adjustResponse = await app.request(
      "/rpc/staff/players/player-1/assets/adjustments",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer staff-token",
          "Content-Type": "application/json",
          "X-PRiSM-Staff-Id": "staff-1",
        },
        body: JSON.stringify({
          adjustments: [
            {
              assetType: "currency",
              assetCode: "currency.paid",
              quantityDelta: -5,
              activeAt: null,
              expiresAt: null,
              reason: "staff.asset.deduct",
            },
          ],
        }),
      },
    );
    expect(adjustResponse.status).toBe(200);

    const afterAdjustResponse = await app.request("/rpc/player/me", {
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });
    expect(afterAdjustResponse.status).toBe(200);
    await expect(afterAdjustResponse.json()).resolves.toMatchObject({
      wallet: [
        {
          assetCode: "currency.paid",
          quantity: 165,
        },
      ],
    });

    const reportsResponse = await app.request(
      "/rpc/staff/reports/summary?from=2026-06-07T00:00:00.000Z&to=2026-06-08T00:00:00.000Z",
      {
        headers: {
          Authorization: "Bearer staff-token",
        },
      },
    );
    expect(reportsResponse.status).toBe(200);
    await expect(reportsResponse.json()).resolves.toEqual({
      summary: {
        from: "2026-06-07T00:00:00.000Z",
        to: "2026-06-08T00:00:00.000Z",
        revenueTotal: 5,
        sessionCount: 3,
        assetGrantTotal: 5,
        coinCommandCount: 0,
      },
    });

    const reportSettlementsResponse = await app.request(
      "/rpc/staff/reports/settlements?from=2026-06-07T00:00:00.000Z&to=2026-06-08T00:00:00.000Z&limit=10",
      {
        headers: {
          Authorization: "Bearer staff-token",
        },
      },
    );
    expect(reportSettlementsResponse.status).toBe(200);
    await expect(reportSettlementsResponse.json()).resolves.toMatchObject({
      settlements: [
        {
          playerId: "player-1",
          playerDisplayName: "Neri",
          subtotal: 10,
          total: 5,
          durationMinutes: 5,
          settledAt: "2026-06-07T11:30:00.000Z",
        },
        {
          playerId: "player-1",
          playerDisplayName: "Neri",
          subtotal: 10,
          total: 0,
          durationMinutes: 25,
          settledAt: "2026-06-07T11:25:00.000Z",
        },
        {
          playerId: "player-1",
          playerDisplayName: "Neri",
          subtotal: 20,
          total: 0,
          durationMinutes: 60,
          settledAt: "2026-06-07T11:00:00.000Z",
        },
      ],
    });

    const reportPlayersResponse = await app.request(
      "/rpc/staff/reports/players?from=2026-06-07T00:00:00.000Z&to=2026-06-08T00:00:00.000Z&limit=10",
      {
        headers: {
          Authorization: "Bearer staff-token",
        },
      },
    );
    expect(reportPlayersResponse.status).toBe(200);
    await expect(reportPlayersResponse.json()).resolves.toEqual({
      players: [
        {
          playerId: "player-1",
          playerDisplayName: "Neri",
          settlementCount: 3,
          totalDurationMinutes: 90,
          revenueTotal: 5,
          lastSettledAt: "2026-06-07T11:30:00.000Z",
        },
      ],
      page: { limit: 10, offset: 0, hasMore: false },
    });
  });

  it("purchases business items through the runtime order service and wallet ledger", async () => {
    const db = createDb();
    db.run(
      "INSERT INTO sessions (id, player_id, started_at, ended_at, status) VALUES (?, ?, ?, ?, ?)",
      ["session-1", "player-1", "2026-06-07T10:00:00.000Z", null, "active"],
    );
    db.run(
      "INSERT INTO asset_holdings (id, player_id, asset_type, asset_code, quantity) VALUES (?, ?, ?, ?, ?)",
      ["holding-free-active", "player-1", "currency", "currency.free", 50],
    );
    db.run(
      `INSERT INTO business_items (id, kind, name, status, price, asset_type, asset_code, active_at, expires_at, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "business-item-1",
        "event.entry",
        "周末挑战赛报名",
        "active",
        120,
        "ticket",
        "event.weekend",
        "2026-06-07T00:00:00.000Z",
        "2026-06-08T00:00:00.000Z",
        JSON.stringify({ capacity: 8 }),
        "2026-06-07T09:00:00.000Z",
        "2026-06-07T09:00:00.000Z",
      ],
    );

    let nextId = 0;
    const dependencies = createPrismRuntimeDependencies({
      repositories: RuntimeRepositories.fromBunSqlite({
        db,
        id: () => `id-${++nextId}`,
        now: () => new Date("2026-06-07T10:30:00.000Z"),
      }),
      queries: RuntimeRepositories.queriesFromBunSqlite({
        db,
        now: () => new Date("2026-06-07T10:30:00.000Z"),
      }),
      pricingProviders: [],
      assetEffectProviders: [],
      coinCooldownMs: 60_000,
      id: () => `id-${++nextId}`,
      now: () => new Date("2026-06-07T10:30:00.000Z"),
    });
    const app = createPrismApp(dependencies);

    const purchaseResponse = await app.request(
      "/rpc/player/business-items/business-item-1/purchase",
      {
        method: "POST",
        headers: {
          ...(await playerSessionHeaders(app, "player-1")),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          metadata: {
            note: "runtime",
          },
        }),
      },
    );
    expect(purchaseResponse.status).toBe(200);
    const purchase = await purchaseResponse.json();
    expect(purchase).toMatchObject({
      businessItemOrder: {
        businessItemId: "business-item-1",
        businessItemName: "周末挑战赛报名",
        playerId: "player-1",
        sessionId: "session-1",
        status: "paid",
        price: 120,
      },
      assetLedgerEntries: [
        {
          assetCode: "currency.free",
          delta: -50,
        },
        {
          assetCode: "currency.paid",
          delta: -70,
        },
      ],
    });

    const playerAssetsResponse = await app.request("/rpc/player/assets", {
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });
    expect(playerAssetsResponse.status).toBe(200);
    await expect(playerAssetsResponse.json()).resolves.toEqual(
      expect.objectContaining({
        holdings: expect.arrayContaining([
          expect.objectContaining({
            assetCode: "currency.paid",
            quantity: 30,
          }),
        ]),
        ledgerEntries: expect.arrayContaining([
          expect.objectContaining({
            assetCode: "currency.free",
            delta: -50,
            reason: "business-item.purchase",
          }),
          expect.objectContaining({
            assetCode: "currency.paid",
            delta: -70,
            reason: "business-item.purchase",
          }),
        ]),
      }),
    );

    const staffOrdersResponse = await app.request(
      "/rpc/staff/business-item-orders",
      {
        headers: {
          Authorization: "Bearer staff-token",
        },
      },
    );
    expect(staffOrdersResponse.status).toBe(200);
    await expect(staffOrdersResponse.json()).resolves.toMatchObject({
      businessItemOrders: [
        {
          businessItemId: "business-item-1",
          status: "paid",
        },
      ],
    });
  });

  it("returns migrated present grants with date fields and player identities for staff views", async () => {
    const db = createDb();
    db.run(
      "INSERT INTO player_identities (player_id, provider, subject, created_at) VALUES (?, ?, ?, ?)",
      ["player-1", "qq", "826225045", "2026-06-07T09:00:00.000Z"],
    );
    db.run(
      "INSERT INTO presents (id, name, once_per_player, status, grants_json) VALUES (?, ?, ?, ?, ?)",
      [
        "present-legacy",
        "迁移礼物",
        0,
        "active",
        JSON.stringify([
          {
            assetType: "currency",
            assetCode: "currency.free",
            amount: 10,
            mergeStrategy: "stack",
            activeAt: null,
            expiresAt: "2026-06-30T00:00:00.000Z",
          },
        ]),
      ],
    );
    const app = createPrismApp(
      createRuntimeForDb(db, () => new Date("2026-06-07T10:00:00.000Z")),
    );

    const playersResponse = await app.request("/rpc/staff/players", {
      headers: { Authorization: "Bearer staff-token" },
    });
    expect(playersResponse.status).toBe(200);
    expect(await playersResponse.json()).toMatchObject({
      players: [
        {
          id: "player-1",
          identities: expect.arrayContaining([
            expect.objectContaining({ provider: "qq", subject: "826225045" }),
          ]),
        },
      ],
    });

    const presentsResponse = await app.request("/rpc/staff/presents", {
      headers: { Authorization: "Bearer staff-token" },
    });
    expect(presentsResponse.status).toBe(200);
    expect(await presentsResponse.json()).toMatchObject({
      presents: [
        {
          id: "present-legacy",
          grants: [{ expiresAt: "2026-06-30T00:00:00.000Z" }],
        },
      ],
    });
  });

  it("resolves an integration game-machine alias, loads the bound Aime card, and persists a redacted ACK", async () => {
    const db = createDb();
    insertActiveSession(db, {
      id: "session-hinata",
      playerId: "player-1",
      startedAt: "2026-08-15T09:00:00.000Z",
    });
    db.run(
      "INSERT INTO player_identities (player_id, provider, subject, created_at) VALUES (?, ?, ?, ?)",
      ["player-1", "aime", "01234567890123456789", "2026-08-15T09:00:00.000Z"],
    );
    const now = () => new Date("2026-08-15T10:00:00.000Z");
    let nextId = 0;
    const repositories = RuntimeRepositories.fromBunSqlite({
      db,
      id: () => `remote-id-${++nextId}`,
      now,
    });
    let hinataIoSettingReads = 0;
    const getAppSetting = repositories.system.getAppSetting.bind(repositories.system);
    repositories.system.getAppSetting = async <T = unknown>(key: string) => {
      if (key === "devices.hinata_io") hinataIoSettingReads += 1;
      return getAppSetting<T>(key);
    };
    let executedPayload: Record<string, unknown> | undefined;
    const dependencies = createPrismRuntimeDependencies({
      repositories,
      queries: RuntimeRepositories.queriesFromBunSqlite({ db, now }),
      pricingProviders: [],
      assetEffectProviders: [],
      coinCooldownMs: 60_000,
      deviceActionExecutors: {
        hinataIo: {
          async execute({ command }) {
            executedPayload = command.payload;
            return { status: "success" };
          },
        },
      },
      id: () => `command-${++nextId}`,
      now,
    });
    await repositories.system.setAppSetting("devices.hinata_io", [{
      id: "maimai-left",
      name: "舞萌 DX 左机",
      aliases: ["舞萌左机"],
      url: "https://relay.example/maimai-left",
      password: "test-password",
      salt: "ABEiM0RVZneImaq7zN3u_w",
      coinKey: 32,
      cardType: "aime",
    }]);

    const command = await dependencies.integrationCommands!.requestDeviceActionByIdentity({
      identity: { provider: "test", subject: "player-1" },
      target: { kind: "game_machine", ref: "舞萌左机" },
      action: { type: "aime.scan", payload: { provider: "aime" } },
    });

    expect(executedPayload).toEqual({
      provider: "aime",
      subject: "01234567890123456789",
      deviceLabel: "舞萌 DX 左机",
    });
    expect(command).toMatchObject({
      deviceId: "maimai-left",
      executorKind: "hinata_io",
      status: "acked",
      payload: {
        provider: "aime",
        deviceLabel: "舞萌 DX 左机",
      },
    });
    expect(command.payload).not.toHaveProperty("subject");
    expect(hinataIoSettingReads).toBe(1);
    await expect(repositories.deviceCommands.getDeviceCommand(command.id)).resolves.toEqual(command);
  });
});

it("rolls back wallet, checkout records and session closure when a checkout batch fails", async () => {
  const db=createDb();
  const now=()=>new Date("2026-06-07T11:00:00Z");
  const deps=createRuntimeForDb(db,now);
  const rule=await deps.staffPricingCommands!.createPricingConfig({kind:"charge.fixed",name:"Entry",enabled:true,provider:{id:"fixed",label:"Entry",amount:12}});
  await deps.playerCommands.startSession({playerId:"player-1",pricingConfigIds:[rule.id],label:"entry"});
  const before=db.query("SELECT * FROM asset_holdings ORDER BY id").all();
  db.run("CREATE TRIGGER fail_settlement BEFORE INSERT ON settlements BEGIN SELECT RAISE(ABORT, 'injected checkout failure'); END");
  await expect(deps.playerCheckoutCommands!.checkout({playerId:"player-1",closeSessionsBeforeBalanceCheck:false})).rejects.toThrow("injected checkout failure");
  expect(db.query("SELECT * FROM asset_holdings ORDER BY id").all()).toEqual(before);
  expect(db.query("SELECT status FROM sessions WHERE player_id='player-1'").get()).toEqual({status:"active"});
  expect(db.query("SELECT COUNT(*) AS n FROM player_checkouts").get()).toEqual({n:0});
  expect(db.query("SELECT COUNT(*) AS n FROM asset_transactions").get()).toEqual({n:0});
  db.close();
});
