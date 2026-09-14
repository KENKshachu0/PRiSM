import { centsOf } from "@prism/core";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { sqliteSchema } from "@prism/storage-sql";
import type { D1BoundStatementLike, D1DatabaseLike, SqlValue } from "@prism/adapter-d1";
import { createPrismRuntimeDependencies, RuntimeRepositories } from "../src/index";
import { createPrismApp } from "./test-app";

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
            return { success: true };
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

type InMemoryD1Fixture = {
  d1: InMemoryD1Database;
  sqlite: Database;
};

function createD1Db(): InMemoryD1Fixture {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  for (const statement of sqliteSchema) db.run(statement);
  db.run("INSERT INTO players (id, display_name, status, created_at) VALUES (?, ?, ?, ?)", [
    "player-1",
    "Neri",
    "active",
    "2026-06-07T09:00:00.000Z",
  ]);
  bindTestIdentity(db, "player-1");
  db.run("INSERT INTO asset_definitions (type, code, name, stackable) VALUES (?, ?, ?, ?)", [
    "currency",
    "currency.paid",
    "Paid balance",
    1,
  ]);
  db.run("INSERT INTO asset_holdings (id, player_id, asset_type, asset_code, quantity) VALUES (?, ?, ?, ?, ?)", [
    "holding-1",
    "player-1",
    "currency",
    "currency.paid",
    2000,
  ]);
  return {
    d1: new InMemoryD1Database(db),
    sqlite: db,
  };
}

function createD1Fixture(): InMemoryD1Fixture {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  for (const statement of sqliteSchema) db.run(statement);
  db.run("INSERT INTO players (id, display_name, status, created_at) VALUES (?, ?, ?, ?)", [
    "player-1",
    "Neri",
    "active",
    "2026-06-07T09:00:00.000Z",
  ]);
  bindTestIdentity(db, "player-1");
  db.run("INSERT INTO asset_definitions (type, code, name, stackable) VALUES (?, ?, ?, ?)", [
    "currency",
    "currency.paid",
    "Paid balance",
    1,
  ]);
  db.run("INSERT INTO asset_holdings (id, player_id, asset_type, asset_code, quantity) VALUES (?, ?, ?, ?, ?)", [
    "holding-1",
    "player-1",
    "currency",
    "currency.paid",
    200,
  ]);
  return {
    d1: new InMemoryD1Database(db),
    sqlite: db,
  };
}

function bindTestIdentity(db: Database, playerId: string) {
  db.run(
    "INSERT INTO player_identities (player_id, provider, subject, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(shop_id, provider, subject) DO UPDATE SET player_id = excluded.player_id",
    [playerId, "test", playerId, "2026-06-07T09:00:00.000Z"],
  );
}

function createD1RuntimeForFixture(fixture: InMemoryD1Fixture, now: () => Date) {
  let nextId = 0;
  return createPrismRuntimeDependencies({
    repositories: RuntimeRepositories.fromD1({
      db: fixture.d1,
      id: () => `id-${++nextId}`,
      now,
    }),
    queries: RuntimeRepositories.queriesFromD1({
      db: fixture.d1,
      now,
    }),
    pricingProviders: [],
    assetEffectProviders: [],
    coinCooldownMs: 60_000,
    id: () => `id-${++nextId}`,
    now,
  });
}

function insertActiveSession(db: Database, input: { id: string; playerId: string; startedAt: string }) {
  db.run("INSERT INTO sessions (id, player_id, started_at, ended_at, status) VALUES (?, ?, ?, ?, ?)", [
    input.id,
    input.playerId,
    input.startedAt,
    null,
    "active",
  ]);
}

async function confirmPlayerCheckout(app: ReturnType<typeof createPrismApp>, playerId: string): Promise<unknown> {
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

describe("createPrismRuntimeDependencies with D1", () => {
  it("persists priority time pricing cap history through the D1 repository path", async () => {
    const fixture = createD1Fixture();
    fixture.sqlite.run(
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
    const app = createPrismApp(createD1RuntimeForFixture(fixture, () => currentTime));

    insertActiveSession(fixture.sqlite, {
      id: "session-player-1-first",
      playerId: "player-1",
      startedAt: "2026-06-07T01:00:00.000Z",
    });
    await expect(confirmPlayerCheckout(app, "player-1")).resolves.toMatchObject({
      playerSettlement: {
        subtotal: 40,
        total: 40,
      },
    });

    currentTime = new Date("2026-06-07T09:00:00.000Z");
    insertActiveSession(fixture.sqlite, {
      id: "session-player-1-second",
      playerId: "player-1",
      startedAt: "2026-06-07T07:00:00.000Z",
    });
    await expect(confirmPlayerCheckout(app, "player-1")).resolves.toMatchObject({
      playerSettlement: {
        subtotal: 0,
        total: 0,
      },
    });

    expect(
      fixture.sqlite
        .query<{ total: number }, []>("SELECT COALESCE(SUM(amount), 0) AS total FROM pricing_history_entries")
        .get(),
    ).toEqual({ total: 40 });
  });

  it("composes the Hono app dependencies for a Cloudflare D1 deployment", async () => {
    const fixture = createD1Db();
    const db = fixture.d1;
    let nextId = 0;
    let currentTime = new Date("2026-06-07T10:00:00.000Z");
    const dependencies = createPrismRuntimeDependencies({
      repositories: RuntimeRepositories.fromD1({
        db,
        id: () => `id-${++nextId}`,
        now: () => currentTime,
      }),
      queries: RuntimeRepositories.queriesFromD1({
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
        name: "D1 runtime time pricing",
        enabled: true,
        provider: {
          id: "time.d1",
          rules: [
            {
              id: "base",
              label: "Base D1",
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

    const startResponse = await app.request("/rpc/player/session/start", {
      method: "POST",
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });
    expect(startResponse.status).toBe(200);

    const bindAimeIdentityResponse = await app.request("/rpc/staff/players/player-1/identities", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "aime",
        subject: "card-1",
      }),
    });
    expect(bindAimeIdentityResponse.status).toBe(200);

    const scanCommandResponse = await app.request("/rpc/player/device-commands", {
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
    });
    expect(scanCommandResponse.status).toBe(200);
    await expect(scanCommandResponse.json()).resolves.toMatchObject({
      command: {
        type: "aime.scan",
        deviceId: "aime-reader-1",
        playerId: "player-1",
        status: "pending",
        payload: {
          provider: "aime",
          subject: "card-1",
        },
      },
    });

    currentTime = new Date("2026-06-07T11:00:00.000Z");

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
        total: 20,
        status: "settled",
      },
    });

    const playerSessionHistoryResponse = await app.request("/rpc/player/sessions/history", {
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });
    expect(playerSessionHistoryResponse.status).toBe(200);
    const playerSessionHistory = (await playerSessionHistoryResponse.json()) as { sessions: Array<{ sessionId: string }> };
    expect(playerSessionHistory).toMatchObject({
      sessions: [
        {
          startedAt: "2026-06-07T10:00:00.000Z",
          endedAt: "2026-06-07T11:00:00.000Z",
          durationMinutes: 60,
          subtotal: 20,
          total: 20,
          status: "settled",
          settledAt: "2026-06-07T11:00:00.000Z",
        },
      ],
    });
    const settledSessionId = playerSessionHistory.sessions[0]?.sessionId;
    expect(settledSessionId).toBeString();

    const playerSessionHistoryDetailResponse = await app.request(`/rpc/player/sessions/${settledSessionId}/history`, {
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });
    expect(playerSessionHistoryDetailResponse.status).toBe(200);
    await expect(playerSessionHistoryDetailResponse.json()).resolves.toMatchObject({
      session: {
        sessionId: settledSessionId,
        subtotal: 20,
        total: 20,
        status: "settled",
        chargeItems: [
          {
            source: "time.d1",
            label: "Base D1",
            amount: 20,
          },
        ],
        adjustments: [],
      },
    });

    const staffPlayerSessionHistoryResponse = await app.request("/rpc/staff/players/player-1/sessions/history", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(staffPlayerSessionHistoryResponse.status).toBe(200);
    await expect(staffPlayerSessionHistoryResponse.json()).resolves.toMatchObject({
      sessions: [
        {
          startedAt: "2026-06-07T10:00:00.000Z",
          endedAt: "2026-06-07T11:00:00.000Z",
          durationMinutes: 60,
          subtotal: 20,
          total: 20,
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
    await expect(staffPlayerSessionHistoryDetailResponse.json()).resolves.toMatchObject({
      session: {
        sessionId: settledSessionId,
        subtotal: 20,
        total: 20,
        status: "settled",
        chargeItems: [
          {
            source: "time.d1",
            label: "Base D1",
            amount: 20,
          },
        ],
        adjustments: [],
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
          sessionId: settledSessionId,
          playerId: "player-1",
          playerDisplayName: "Neri",
          startedAt: "2026-06-07T10:00:00.000Z",
          endedAt: "2026-06-07T11:00:00.000Z",
          settledAt: "2026-06-07T11:00:00.000Z",
          durationMinutes: 60,
          subtotal: 20,
          total: 20,
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
          settlementCount: 1,
          totalDurationMinutes: 60,
          revenueTotal: 20,
          lastSettledAt: "2026-06-07T11:00:00.000Z",
        },
      ],
      page: { limit: 10, offset: 0, hasMore: false },
    });

    const staffResponse = await app.request("/rpc/staff/players", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(staffResponse.status).toBe(200);
    await expect(staffResponse.json()).resolves.toMatchObject({
      players: [
        {
          id: "player-1",
          displayName: "Neri",
          walletTotal: centsOf(1980),
          activeSessionId: null,
        },
      ],
    });

    const grantResponse = await app.request("/rpc/staff/players/player-1/assets/grants", {
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
    });
    expect(grantResponse.status).toBe(200);

    const staffAfterGrantResponse = await app.request("/rpc/staff/players", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(staffAfterGrantResponse.status).toBe(200);
    await expect(staffAfterGrantResponse.json()).resolves.toMatchObject({
      players: [
        {
          id: "player-1",
          walletTotal: centsOf(2030),
        },
      ],
    });

    const hiddenTitleDefinitionResponse = await app.request("/rpc/staff/asset-definitions/title/title.secret", {
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
    });
    expect(hiddenTitleDefinitionResponse.status).toBe(200);

    const hiddenTitleGrantResponse = await app.request("/rpc/staff/players/player-1/assets/grants", {
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
    });
    expect(hiddenTitleGrantResponse.status).toBe(200);

    const d1PlayerAssetsResponse = await app.request("/rpc/player/assets", {
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });
    expect(d1PlayerAssetsResponse.status).toBe(200);
    const d1PlayerAssets = (await d1PlayerAssetsResponse.json()) as {
      holdings: Array<{ assetCode: string }>;
      ledgerEntries: Array<Record<string, unknown>>;
    };
    expect(d1PlayerAssets).toMatchObject({
      holdings: [
        {
          id: "holding-1",
          assetType: "currency",
          assetCode: "currency.paid",
          assetName: "Paid balance",
          quantity: 2030,
          activeAt: null,
          expiresAt: null,
          metadata: null,
        },
      ],
    });
    expect(d1PlayerAssets.ledgerEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetType: "currency",
          assetCode: "currency.paid",
          assetName: "Paid balance",
          delta: 50,
          reason: "staff.asset.grant",
          refId: "staff",
          createdAt: "2026-06-07T11:00:00.000Z",
        }),
        expect.objectContaining({
          assetType: "currency",
          assetCode: "currency.paid",
          assetName: "Paid balance",
          delta: -20,
          reason: "session.settlement",
        }),
      ]),
    );
    expect(d1PlayerAssets.holdings.some((holding) => holding.assetCode === "title.secret")).toBe(false);

    const d1StaffPlayerAssetsResponse = await app.request("/rpc/staff/players/player-1/assets", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(d1StaffPlayerAssetsResponse.status).toBe(200);
    await expect(d1StaffPlayerAssetsResponse.json()).resolves.toMatchObject({
      holdings: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          assetName: "Paid balance",
          availability: "available",
          unavailableReasons: [],
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

    fixture.sqlite.run(
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

    const staffDeviceStatesResponse = await app.request("/rpc/staff/device-states", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
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

    const createdPricing = (await pricingResponse.json()) as { pricingConfig: { id: string } };
    currentTime = new Date("2026-06-07T11:05:00.000Z");
    const disablePricingResponse = await app.request(`/rpc/staff/pricing-configs/${createdPricing.pricingConfig.id}`, {
      method: "PATCH",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "D1 runtime time pricing disabled",
        enabled: false,
        provider: {
          id: "time.d1",
          rules: [
            {
              id: "base",
              label: "Base D1 disabled",
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
    expect(disablePricingResponse.status).toBe(200);

    const fallbackStartResponse = await app.request("/rpc/player/session/start", {
      method: "POST",
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });
    expect(fallbackStartResponse.status).toBe(200);
    currentTime = new Date("2026-06-07T11:35:00.000Z");
    const fallbackCheckoutResponse = await app.request("/rpc/player/checkout/confirm", {
      method: "POST",
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });
    expect(fallbackCheckoutResponse.status).toBe(200);
    await expect(fallbackCheckoutResponse.json()).resolves.toMatchObject({
      playerSettlement: {
        subtotal: 999,
        total: 999,
        status: "settled",
      },
      chargeItems: [
        {
          source: "flat-test",
          amount: 999,
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
    const createdPlayer = (await createPlayerResponse.json()) as { player: { id: string } };

    const createdPlayerAssetsResponse = await app.request(`/rpc/staff/players/${createdPlayer.player.id}/assets`, {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
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
    const revokeCreatedHoldingResponse = await app.request(`/rpc/staff/players/${createdPlayer.player.id}/assets/adjustments`, {
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
    });
    expect(revokeCreatedHoldingResponse.status).toBe(200);

    const createdPlayerAssetsAfterRevokeResponse = await app.request(`/rpc/staff/players/${createdPlayer.player.id}/assets`, {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(createdPlayerAssetsAfterRevokeResponse.status).toBe(200);
    await expect(createdPlayerAssetsAfterRevokeResponse.json()).resolves.toMatchObject({
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

    const bindIdentityResponse = await app.request(`/rpc/staff/players/${createdPlayer.player.id}/identities`, {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "qq",
        subject: "10001",
      }),
    });
    expect(bindIdentityResponse.status).toBe(200);

    const resolveIdentityResponse = await app.request("/rpc/bot/identities/resolve", {
      method: "POST",
      headers: {
        Authorization: "Bearer bot-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "qq",
        subject: "10001",
      }),
    });
    expect(resolveIdentityResponse.status).toBe(200);
    await expect(resolveIdentityResponse.json()).resolves.toMatchObject({
      player: {
        id: createdPlayer.player.id,
        displayName: "Guest",
        status: "active",
      },
    });

    const updateStatusResponse = await app.request(`/rpc/staff/players/${createdPlayer.player.id}/status`, {
      method: "PATCH",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: "disabled",
      }),
    });
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
    const present = (await presentResponse.json()) as { present: { id: string } };

    const redeemCodeResponse = await app.request("/rpc/staff/redeem-codes", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: "PRISM-D1",
        presentId: present.present.id,
        activeAt: null,
        expiresAt: null,
        maxUseCount: 1,
      }),
    });
    expect(redeemCodeResponse.status).toBe(200);
    const redeemCode = (await redeemCodeResponse.json()) as { redeemCode: { id: string } };

    const redeemCodesResponse = await app.request("/rpc/staff/redeem-codes", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(redeemCodesResponse.status).toBe(200);
    await expect(redeemCodesResponse.json()).resolves.toMatchObject({
      redeemCodes: [
        {
          code: "PRISM-D1",
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
        code: "PRISM-D1",
      }),
    });
    expect(redeemResponse.status).toBe(200);

    const staffAfterRedeemResponse = await app.request("/rpc/staff/players", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(staffAfterRedeemResponse.status).toBe(200);
    const staffAfterRedeem = (await staffAfterRedeemResponse.json()) as { players: Array<{ id: string; walletTotal: number }> };
    expect(staffAfterRedeem.players.find((player) => player.id === "player-1")).toMatchObject({
      id: "player-1",
      walletTotal: centsOf(1056),
    });

    const revokeResponse = await app.request(`/rpc/staff/redeem-codes/${redeemCode.redeemCode.id}/revoke`, {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(revokeResponse.status).toBe(200);
    await expect(revokeResponse.json()).resolves.toMatchObject({
      redeemCode: {
        code: "PRISM-D1",
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
        prefix: "D1",
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
          code: expect.stringMatching(/^D1-id-/),
          presentId: present.present.id,
          maxUseCount: 1,
        },
        {
          code: expect.stringMatching(/^D1-id-/),
          presentId: present.present.id,
          maxUseCount: 1,
        },
      ],
    });

    const staffCheckoutStartResponse = await app.request("/rpc/player/session/start", {
      method: "POST",
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });
    expect(staffCheckoutStartResponse.status).toBe(200);
    currentTime = new Date("2026-06-07T12:00:00.000Z");

    const staffCheckoutResponse = await app.request("/rpc/staff/players/player-1/checkout/confirm", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(staffCheckoutResponse.status).toBe(200);
    await expect(staffCheckoutResponse.json()).resolves.toMatchObject({
      playerSettlement: {
        subtotal: 999,
        total: 999,
        status: "settled",
      },
      adjustments: [],
      chargeItems: [
        {
          source: "flat-test",
          amount: 999,
        },
      ],
    });

    const overrideStartResponse = await app.request("/rpc/player/session/start", {
      method: "POST",
      headers: {
        ...(await playerSessionHeaders(app, "player-1")),
      },
    });
    expect(overrideStartResponse.status).toBe(200);
    currentTime = new Date("2026-06-07T12:05:00.000Z");

    const staffOverrideCheckoutResponse = await app.request("/rpc/staff/players/player-1/checkout/override", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
        "X-PRiSM-Staff-Id": "staff-1",
      },
      body: JSON.stringify({
        total: 7,
        reason: "manual correction",
      }),
    });
    expect(staffOverrideCheckoutResponse.status).toBe(200);
    const staffOverrideCheckout = (await staffOverrideCheckoutResponse.json()) as {
      playerSettlement: { sessionIds: string[] };
      settlements: Array<{ settlement: { sessionId: string } }>;
    };
    expect(staffOverrideCheckout).toMatchObject({
      playerSettlement: {
        subtotal: 999,
        total: 7,
        status: "settled",
      },
      adjustments: [
        {
          source: "staff.override:staff",
          label: "Staff override: manual correction",
          amount: -992,
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
        subtotal: 999,
        total: 7,
        adjustments: [
          {
            source: "staff.override:staff",
            label: "Staff override: manual correction",
            amount: -992,
          },
        ],
      },
    });

    const adjustResponse = await app.request("/rpc/staff/players/player-1/assets/adjustments", {
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
    });
    expect(adjustResponse.status).toBe(200);

    const staffAfterAdjustResponse = await app.request("/rpc/staff/players", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(staffAfterAdjustResponse.status).toBe(200);
    const staffAfterAdjust = (await staffAfterAdjustResponse.json()) as { players: Array<{ id: string; walletTotal: number }> };
    expect(staffAfterAdjust.players.find((player) => player.id === "player-1")).toMatchObject({
      id: "player-1",
      walletTotal: centsOf(45),
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
        revenueTotal: 2025,
        sessionCount: 4,
        assetGrantTotal: 4,
        coinCommandCount: 0,
      },
    });
  });
});
