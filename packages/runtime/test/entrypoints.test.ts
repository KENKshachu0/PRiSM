import { centsOf as moneyFixture, centsOfInteger as integerFixture } from "@prism/core";
import { centsOf } from "@prism/core";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { D1BoundStatementLike, D1DatabaseLike, SqlValue } from "@prism/adapter-d1";
import { sqliteSchema } from "@prism/storage-sql";
import { authenticateMachineWebSocketRequest, createPrismApp } from "@prism/server-hono";
import { createPrismLocalApp, createPrismLocalDependencies, createPrismRuntimeDependencies, createPrismWorkerApp, RuntimeRepositories } from "../src/index";

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

function seed(db: Database) {
  db.run("PRAGMA foreign_keys = ON");
  for (const statement of sqliteSchema) db.run(statement);
  db.run("INSERT INTO players (id, display_name, status, created_at) VALUES (?, ?, ?, ?)", [
    "player-1",
    "Neri",
    "active",
    "2026-06-07T09:00:00.000Z",
  ]);
  db.run(
    "INSERT INTO player_identities (player_id, provider, subject, created_at) VALUES (?, ?, ?, ?)",
    ["player-1", "test", "player-1", "2026-06-07T09:00:00.000Z"],
  );
  db.run("INSERT INTO asset_definitions (type, code, name, stackable) VALUES (?, ?, ?, ?)", [
    "currency",
    "currency.paid",
    "Paid balance",
    1,
  ]);
}

function seedStaffSession(db: Database) {
  db.run(
    "INSERT INTO staff_users (id, username, display_name, password_hash, password_salt, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      "staff-1",
      "owner",
      "店主",
      "unused",
      "unused",
      "owner",
      "active",
      "2026-06-07T10:00:00.000Z",
      "2026-06-07T10:00:00.000Z",
    ],
  );
  db.run(
    "INSERT INTO admin_sessions (id, staff_user_id, token_hash, expires_at, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
    [
      "admin-session-1",
      "staff-1",
      "d6a636de5c7ee1632aa0585c29e6449ed4ad10dc15b85d0f0bf76ef74d9357b6",
      "2999-06-08T10:00:00.000Z",
      "2026-06-07T10:00:00.000Z",
      "2026-06-07T10:00:00.000Z",
    ],
  );
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

describe("runtime entrypoints", () => {
  it("creates a Worker app from D1 without PRiSM business environment configuration", async () => {
    const rawDb = new Database(":memory:");
    seed(rawDb);
    const app = createPrismWorkerApp({
      DB: new InMemoryD1Database(rawDb),
    });

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "prism-api",
    });

    const versionResponse = await app.request("/version");
    expect(versionResponse.status).toBe(200);
    await expect(versionResponse.json()).resolves.toEqual({
      service: "prism-api",
      version: "dev",
      revision: "unknown",
    });
  });

  it("creates and authenticates a local app from Bun SQLite", async () => {
    const db = new Database(":memory:");
    seed(db);
    for (const statement of [
      "INSERT INTO staff_users (id, username, display_name, password_hash, password_salt, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "INSERT INTO admin_sessions (id, staff_user_id, token_hash, expires_at, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
    ] as const) {
      if (statement.startsWith("INSERT INTO staff_users")) {
        db.run(statement, [
          "staff-1",
          "owner",
          "店主",
          "unused",
          "unused",
          "owner",
          "active",
          "2026-06-07T10:00:00.000Z",
          "2026-06-07T10:00:00.000Z",
        ]);
      } else {
        db.run(statement, [
          "admin-session-1",
          "staff-1",
          "d6a636de5c7ee1632aa0585c29e6449ed4ad10dc15b85d0f0bf76ef74d9357b6",
      "2999-06-08T10:00:00.000Z",
          "2026-06-07T10:00:00.000Z",
          "2026-06-07T10:00:00.000Z",
        ]);
      }
    }
    const app = createPrismLocalApp({
      db,
    });

    const response = await app.request("/rpc/staff/players", {
      headers: {
        Authorization: "Bearer staff-db-session",
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      players: [
        {
          id: "player-1",
          displayName: "Neri",
        },
      ],
    });
  });

  it("wires store plugins through the local SQLite app factory", async () => {
    const db = new Database(":memory:");
    seed(db);
    seedStaffSession(db);
    db.run("INSERT INTO sessions (id, player_id, started_at, ended_at, status) VALUES (?, ?, ?, ?, ?)", [
      "session-1",
      "player-1",
      "2026-06-07T10:00:00.000Z",
      null,
      "active",
    ]);
    const app = createPrismLocalApp({
      db,
      plugins: [
        {
          id: "plugin.locker",
          pricingProviders: [
            {
              id: "plugin.locker.pricing",
              quote(context) {
                return [
                  {
                    id: `${context.session.id}:locker`,
                    source: "plugin.locker",
                    label: "储物柜",
                    amount: moneyFixture(30),
                  },
                ];
              },
            },
          ],
        },
      ],
    });

    const previewResponse = await app.request("/rpc/staff/players/player-1/checkout/preview", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-db-session",
      },
    });

    expect(previewResponse.status).toBe(200);
    await expect(previewResponse.json()).resolves.toMatchObject({
      settlementPreview: {
        subtotal: 30,
        total: 30,
      },
      chargeItems: [
        {
          source: "plugin.locker",
          label: "储物柜",
          amount: 30,
        },
      ],
    });
  });

  it("exposes deployed plugin pricing capabilities through the local staff extension catalog", async () => {
    const db = new Database(":memory:");
    seed(db);
    const app = createPrismLocalApp({
      db,
      plugins: [
        {
          id: "plugin.reservation",
          staffCatalog: [
            {
              id: "plugin.reservation.pricing",
              name: "预约活动报名",
              kind: "pricing",
              summary: "按报名项目从同一套余额里扣费。",
              status: "enabled",
              configuredBy: "plugin",
              capabilities: ["结账加项", "活动报名", "预约"],
              requiredAssets: [
                {
                  type: "ticket",
                  code: "reservation",
                  name: "预约报名券",
                },
                {
                  type: "currency",
                  code: "paid",
                  name: "余额",
                },
              ],
            },
          ],
          pricingProviders: [
            {
              id: "plugin.reservation.pricing",
              quote() {
                return [];
              },
            },
          ],
        },
      ],
    });

    const installResponse = await app.request("/rpc/setup/install", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        storeName: "音游窝",
        timeZone: "Asia/Tokyo",
        owner: {
          username: "owner",
          displayName: "店主",
          password: "password",
        },
        coinCooldownMs: 20000,
      }),
    });
    expect(installResponse.status).toBe(200);

    const loginResponse = await app.request("/rpc/admin/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: "owner",
        password: "password",
      }),
    });
    expect(loginResponse.status).toBe(200);
    const login = await loginResponse.json() as { session: { token: string } };

    const catalogResponse = await app.request("/rpc/staff/pricing-extensions", {
      headers: {
        Authorization: `Bearer ${login.session.token}`,
      },
    });

    expect(catalogResponse.status).toBe(200);
    await expect(catalogResponse.json()).resolves.toEqual({
      pricingExtensions: [
        {
          id: "plugin.reservation.pricing",
          name: "预约活动报名",
          kind: "pricing",
          summary: "按报名项目从同一套余额里扣费。",
          status: "enabled",
          configuredBy: "plugin",
          capabilities: ["结账加项", "活动报名", "预约"],
          configurationStatus: "needs-setup",
          requiredAssets: [
            {
              type: "ticket",
              code: "reservation",
              name: "预约报名券",
              status: "missing",
            },
            {
              type: "currency",
              code: "paid",
              name: "余额",
              status: "ready",
            },
          ],
        },
      ],
    });
  });

  it("wires store plugins through the Cloudflare D1 Worker app factory", async () => {
    const rawDb = new Database(":memory:");
    seed(rawDb);
    seedStaffSession(rawDb);
    rawDb.run("INSERT INTO sessions (id, player_id, started_at, ended_at, status) VALUES (?, ?, ?, ?, ?)", [
      "session-1",
      "player-1",
      "2026-06-07T10:00:00.000Z",
      null,
      "active",
    ]);
    const app = createPrismWorkerApp(
      {
        DB: new InMemoryD1Database(rawDb),
      },
      {
        plugins: [
          {
            id: "plugin.entry-ticket",
            pricingProviders: [
              {
                id: "plugin.entry-ticket.pricing",
                quote(context) {
                  return [
                    {
                      id: `${context.session.id}:entry-ticket`,
                      source: "plugin.entry-ticket",
                      label: "入场票",
                      amount: moneyFixture(45),
                    },
                  ];
                },
              },
            ],
          },
        ],
      },
    );

    const previewResponse = await app.request("/rpc/staff/players/player-1/checkout/preview", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-db-session",
      },
    });

    expect(previewResponse.status).toBe(200);
    await expect(previewResponse.json()).resolves.toMatchObject({
      settlementPreview: {
        subtotal: 45,
        total: 45,
      },
      chargeItems: [
        {
          source: "plugin.entry-ticket",
          label: "入场票",
          amount: 45,
        },
      ],
    });
  });

  it("creates a local app and supports setup login", async () => {
    const db = new Database(":memory:");
    seed(db);
    const dependencies = createPrismLocalDependencies({
      db,
    });
    const app = createPrismApp(dependencies);

    const statusResponse = await app.request("/rpc/setup/status");
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toEqual({
      installed: false,
    });

    const installResponse = await app.request("/rpc/setup/install", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        storeName: "音游窝",
        timeZone: "Asia/Tokyo",
        owner: {
          username: "owner",
          displayName: "店主",
          password: "password",
        },
        coinCooldownMs: 20000,
      }),
    });
    expect(installResponse.status).toBe(200);
    const install = await installResponse.json() as {
      apiTokens: Array<{ id: string; role: "integration" | "machine"; token: string; createdAt: string }>;
    };
    expect(install).toMatchObject({
      staff: {
        username: "owner",
        displayName: "店主",
        role: "owner",
      },
      apiTokens: [
        {
          label: "机器人/店内入口 API",
          role: "integration",
          createdAt: expect.any(String),
        },
        {
          label: "机器软件接入 API",
          role: "machine",
          createdAt: expect.any(String),
        },
      ],
    });
    const integrationToken = install.apiTokens.find((token) => token.role === "integration");
    const machineToken = install.apiTokens.find((token) => token.role === "machine");
    if (!integrationToken || !machineToken) {
      throw new Error("Setup must return integration and machine API tokens.");
    }
    expect(integrationToken?.token).toStartWith("integration_");
    expect(machineToken?.token).toStartWith("machine_");

    const botApiResponse = await app.request("/rpc/bot/identities/resolve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${integrationToken.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "koishi",
        subject: "missing",
      }),
    });
    expect(botApiResponse.status).toBe(404);

    const machineAuth = await authenticateMachineWebSocketRequest(
      new Request("https://prism.example.com/rpc/machine/ws", {
        headers: {
          Authorization: `Bearer ${machineToken.token}`,
        },
      }),
      dependencies,
    );
    expect(machineAuth).not.toBeInstanceOf(Response);
    const usedAt = db.query("SELECT last_used_at FROM api_tokens WHERE id = ?").get(machineToken.id) as { last_used_at: string | null };
    expect(usedAt.last_used_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    db.run("UPDATE api_tokens SET status = 'revoked', revoked_at = ? WHERE id = ?", [
      "2026-06-08T10:01:00.000Z",
      machineToken.id,
    ]);
    const revokedMachineAuth = await authenticateMachineWebSocketRequest(
      new Request("https://prism.example.com/rpc/machine/ws", {
        headers: {
          Authorization: `Bearer ${machineToken.token}`,
        },
      }),
      dependencies,
    );
    expect(revokedMachineAuth).toBeInstanceOf(Response);
    expect((revokedMachineAuth as Response).status).toBe(403);

    const loginResponse = await app.request("/rpc/admin/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: "owner",
        password: "password",
      }),
    });
    expect(loginResponse.status).toBe(200);
    const login = await loginResponse.json() as { session: { token: string } };
    expect(login.session.token).toStartWith("prism_admin_");

    const settingsResponse = await app.request("/rpc/staff/settings", {
      headers: {
        Authorization: `Bearer ${login.session.token}`,
      },
    });
    expect(settingsResponse.status).toBe(200);
    await expect(settingsResponse.json()).resolves.toEqual({
      settings: {
        store: {
          name: "音游窝",
          timeZone: "Asia/Tokyo",
        },
        operations: {
          coinCooldownMs: 20_000,
        },
        homeAssistantConnection: { url: "", token: "" },
        homeAssistantDevices: [],
        ttLockConnection: {
          baseUrl: "https://api.sciener.com",
          clientId: "",
          clientSecret: "",
          appAccount: "",
          appPwd: "",
          accessToken: "",
          refreshToken: "",
          accessTokenExpiresAt: null,
        },
        ttLockDevices: [],
        hinataIoDevices: [],
        registration: { defaultPresentId: null },
      },
    });

    const updateSettingsResponse = await app.request("/rpc/staff/settings", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${login.session.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        store: {
          name: "PRiSM 店铺",
          timeZone: "Asia/Shanghai",
        },
        operations: {
          coinCooldownMs: 60_000,
        },
      }),
    });
    expect(updateSettingsResponse.status).toBe(200);
    await expect(updateSettingsResponse.json()).resolves.toMatchObject({
      settings: {
        store: {
          name: "PRiSM 店铺",
          timeZone: "Asia/Shanghai",
        },
        operations: {
          coinCooldownMs: 60_000,
        },
      },
    });

    const staffResponse = await app.request("/rpc/staff/players", {
      headers: {
        Authorization: `Bearer ${login.session.token}`,
      },
    });
    expect(staffResponse.status).toBe(200);

    const createApiTokenResponse = await app.request("/rpc/staff/api-tokens", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${login.session.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        label: "备用机器软件接入",
        role: "machine",
      }),
    });
    expect(createApiTokenResponse.status).toBe(200);
    const createdApiToken = await createApiTokenResponse.json() as { apiToken: { id: string; token: string; role: string } };
    expect(createdApiToken.apiToken.role).toBe("machine");
    expect(createdApiToken.apiToken.token).toStartWith("machine_");

    const listApiTokensResponse = await app.request("/rpc/staff/api-tokens", {
      headers: {
        Authorization: `Bearer ${login.session.token}`,
      },
    });
    expect(listApiTokensResponse.status).toBe(200);
    const apiTokenList = await listApiTokensResponse.json();
    expect(JSON.stringify(apiTokenList)).not.toContain("tokenHash");
    expect(JSON.stringify(apiTokenList)).not.toContain(createdApiToken.apiToken.token);

    const revokeApiTokenResponse = await app.request(`/rpc/staff/api-tokens/${createdApiToken.apiToken.id}/revoke`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${login.session.token}`,
      },
    });
    expect(revokeApiTokenResponse.status).toBe(200);
    await expect(revokeApiTokenResponse.json()).resolves.toMatchObject({
      apiToken: {
        id: createdApiToken.apiToken.id,
        status: "revoked",
      },
    });
  });

  it("applies the configured store time zone to runtime time-priority settlement", async () => {
    const db = new Database(":memory:");
    seed(db);
    db.run("INSERT INTO asset_holdings (id, player_id, asset_type, asset_code, quantity) VALUES (?, ?, ?, ?, ?)", [
      "holding-1",
      "player-1",
      "currency",
      "currency.paid", 100000,
    ]);
    const repositories = RuntimeRepositories.fromBunSqlite({
      db,
      id: () => "unused",
      now: () => new Date("2026-06-07T11:30:00.000Z"),
    });
    await repositories.system.setAppSetting("store.profile", {
      name: "音游窝",
      timeZone: "Asia/Tokyo",
    });
    await repositories.pricingConfigs.save({
      id: "pricing-1",
      kind: "time.priority",
      name: "本地晚高峰",
      enabled: true,
      provider: {
        id: "time.local",
        rules: [
          {
            id: "fallback",
            label: "普通",
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
            label: "晚高峰",
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
    });
    db.run("INSERT INTO sessions (id, player_id, started_at, ended_at, status) VALUES (?, ?, ?, ?, ?)", [
      "session-1",
      "player-1",
      "2026-06-07T11:00:00.000Z",
      null,
      "active",
    ]);
    const dependencies = createPrismRuntimeDependencies({
      repositories,
      queries: RuntimeRepositories.queriesFromBunSqlite({
        db,
        now: () => new Date("2026-06-07T11:30:00.000Z"),
      }),
      pricingProviders: [],
      assetEffectProviders: [],
      coinCooldownMs: 60_000,
      id: () => "unused",
      now: () => new Date("2026-06-07T11:30:00.000Z"),
    });
    const app = createPrismApp({ ...dependencies, authenticatedPrincipal: { role: "player_session", playerId: "player-1" } });

    const previewResponse = await app.request("/rpc/player/checkout/preview", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });

    expect(previewResponse.status).toBe(200);
    await expect(previewResponse.json()).resolves.toMatchObject({
      settlementPreview: {
        subtotal: 20,
        total: 20,
      },
      chargeItems: [
        {
          source: "time.local",
          label: "晚高峰",
          amount: 20,
        },
      ],
    });

    await repositories.system.saveStaffUser({
      id: "staff-1",
      username: "owner",
      displayName: "店主",
      passwordHash: "unused",
      passwordSalt: "unused",
      role: "owner",
      status: "active",
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
      updatedAt: new Date("2026-06-07T10:00:00.000Z"),
    });
    await repositories.system.saveAdminSession({
      id: "admin-session-1",
      staffUserId: "staff-1",
      tokenHash: "ef8844297bd9963fd952ef12b8a6c130967b7432060a471d23668a5db8672bbe",
      expiresAt: new Date("2026-06-08T10:00:00.000Z"),
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
      lastUsedAt: new Date("2026-06-07T10:00:00.000Z"),
    });
    const timelineResponse = await createPrismApp(dependencies).request("/rpc/staff/pricing-configs/pricing-1/timeline?date=2026-06-07", {
      headers: {
        Authorization: "Bearer admin-runtime-session",
      },
    });
    expect(timelineResponse.status).toBe(200);
    await expect(timelineResponse.json()).resolves.toMatchObject({
      timeline: {
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
      },
    });
  });

  it("applies enabled fixed charge pricing configs through the runtime settlement resolver", async () => {
    const db = new Database(":memory:");
    seed(db);
    db.run("INSERT INTO asset_holdings (id, player_id, asset_type, asset_code, quantity) VALUES (?, ?, ?, ?, ?)", [
      "holding-1",
      "player-1",
      "currency",
      "currency.paid", 100000,
    ]);
    db.run("INSERT INTO sessions (id, player_id, started_at, ended_at, status) VALUES (?, ?, ?, ?, ?)", [
      "session-1",
      "player-1",
      "2026-06-07T10:00:00.000Z",
      null,
      "active",
    ]);
    const repositories = RuntimeRepositories.fromBunSqlite({
      db,
      id: () => "unused",
      now: () => new Date("2026-06-07T10:30:00.000Z"),
    });
    await repositories.pricingConfigs.save({
      id: "pricing-fixed-1",
      kind: "charge.fixed",
      name: "入场票",
      enabled: true,
      status: "active",
      provider: {
        id: "fixed.entry-ticket",
        label: "入场票",
        amount: 35,
      },
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
      updatedAt: new Date("2026-06-07T10:00:00.000Z"),
    });
    const dependencies = createPrismRuntimeDependencies({
      repositories,
      queries: RuntimeRepositories.queriesFromBunSqlite({
        db,
        now: () => new Date("2026-06-07T10:30:00.000Z"),
      }),
      pricingProviders: [],
      assetEffectProviders: [],
      coinCooldownMs: 60_000,
      id: () => "unused",
      now: () => new Date("2026-06-07T10:30:00.000Z"),
    });
    const app = createPrismApp({ ...dependencies, authenticatedPrincipal: { role: "player_session", playerId: "player-1" } });

    const previewResponse = await app.request("/rpc/player/checkout/preview", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });

    expect(previewResponse.status).toBe(200);
    await expect(previewResponse.json()).resolves.toMatchObject({
      settlementPreview: {
        subtotal: 35,
        total: 35,
      },
      chargeItems: [
        {
          source: "fixed.entry-ticket",
          label: "入场票",
          amount: 35,
        },
      ],
    });
  });
});
