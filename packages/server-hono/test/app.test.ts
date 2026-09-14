import { describe, expect, it } from "bun:test";
import { PrismDomainError,
  centsOf,
  yuanOf,
} from "@prism/core";
import type { PricingConfig } from "@prism/core";
import { createStaffOperationsService } from "@prism/application";
import { createPrismApp as createPrismAppBase } from "../src/index";
import type { PrismAppDependencies } from "../src/index";

type TestAuthTokens = Partial<Record<"player" | "staff" | "integration" | "machine", string>>;

type TestStaffToken = {
  token: string;
  staffId: string;
  role: "owner" | "manager" | "viewer";
  displayName?: string;
};

type TestPrismAppDependencies = Omit<PrismAppDependencies, "staffOperations"> & {
  staffOperations?: PrismAppDependencies["staffOperations"];
  authTokens?: TestAuthTokens;
  staffTokens?: TestStaffToken[];
};

function createPrismApp(dependencies: TestPrismAppDependencies) {
  const {
    authTokens = {},
    staffTokens = [],
    adminAuth,
    apiTokenAuth,
    playerSessionAuth,
    staffOperations,
    ...applicationDependencies
  } = dependencies;
  return createPrismAppBase({
    ...applicationDependencies,
    staffOperations: staffOperations ?? createStaffOperationsService({
      staffQueries: applicationDependencies.staffQueries,
      checkout: applicationDependencies.staffCheckoutCommands,
      listPricingConfigs: applicationDependencies.staffPricingCommands?.listPricingConfigs
        ? () => applicationDependencies.staffPricingCommands!.listPricingConfigs()
        : undefined,
      now: () => new Date(),
    }),
    adminAuth: {
      async authenticateAdminSession(token) {
        const authenticated = await adminAuth?.authenticateAdminSession(token);
        if (authenticated) return authenticated;
        const staffToken = staffTokens.find((candidate) => candidate.token === token);
        if (staffToken) {
          return {
            staffId: staffToken.staffId,
            role: staffToken.role,
            displayName: staffToken.displayName,
          };
        }
        return token === authTokens.staff
          ? { staffId: "staff", role: "owner" as const }
          : null;
      },
      ...(adminAuth?.revokeAdminSession
        ? { revokeAdminSession: (token: string) => adminAuth.revokeAdminSession!(token) }
        : {}),
    },
    apiTokenAuth: {
      async authenticateApiToken(token) {
        const authenticated = await apiTokenAuth?.authenticateApiToken(token);
        if (authenticated) return authenticated;
        if (token === authTokens.integration) return { role: "integration" };
        if (token === authTokens.machine) return { role: "machine" };
        return null;
      },
    },
    playerSessionAuth: {
      async authenticatePlayerSession(token) {
        return (
          (await playerSessionAuth?.authenticatePlayerSession(token))
          ?? (token === "player-session-token" ? { playerId: "player-1" } : null)
        );
      },
    },
  });
}

describe("createPrismApp", () => {
  it("exposes setup status, install, and admin login routes for zero-env onboarding", async () => {
    const calls: string[] = [];
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("setup routes must not query player data");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("setup routes must not list players");
        },
        async listActiveSessions() {
          throw new Error("setup routes must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("setup routes must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("setup routes must not request device commands");
        },
      },
      setupCommands: {
        async getSetupStatus() {
          return { installed: false };
        },
        async install(input) {
          calls.push(`install:${input.storeName}:${input.timeZone}:${input.owner.username}`);
          return {
            staffUser: {
              id: "staff-1",
              username: input.owner.username,
              displayName: input.owner.displayName,
              passwordHash: "hidden",
              passwordSalt: "hidden",
              role: "owner",
              status: "active",
              createdAt: new Date("2026-06-08T10:00:00.000Z"),
              updatedAt: new Date("2026-06-08T10:00:00.000Z"),
            },
            apiTokens: [
              {
                id: "api-token-1",
        label: "机器人/店内入口 API",
                role: "integration",
                token: "bot-token-plain",
                tokenPrefix: "integration",
                createdAt: new Date("2026-06-08T10:00:00.000Z"),
              },
            ],
          };
        },
        async login(input) {
          calls.push(`login:${input.username}`);
          return {
            token: "admin-session-token",
            staff: {
              id: "staff-1",
              username: input.username,
              displayName: "店主",
              role: "owner",
            },
          };
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const statusResponse = await app.request("/rpc/setup/status");
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toEqual({ installed: false });

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
        coinCooldownMs: 60000,
      }),
    });
    expect(installResponse.status).toBe(200);
    await expect(installResponse.json()).resolves.toEqual({
      staff: {
        id: "staff-1",
        username: "owner",
        displayName: "店主",
        role: "owner",
      },
      apiTokens: [
        {
          id: "api-token-1",
          label: "机器人/店内入口 API",
          role: "integration",
          token: "bot-token-plain",
          tokenPrefix: "integration",
          createdAt: "2026-06-08T10:00:00.000Z",
        },
      ],
    });

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
    await expect(loginResponse.json()).resolves.toEqual({
      session: {
        token: "admin-session-token",
      },
      staff: {
        id: "staff-1",
        username: "owner",
        displayName: "店主",
        role: "owner",
      },
    });
    expect(calls).toEqual(["install:音游窝:Asia/Tokyo:owner", "login:owner"]);
  });

  it("returns a public health view", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("health check must not query player data");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("health check must not list players");
        },
        async listActiveSessions() {
          throw new Error("health check must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("health check must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("health check must not request device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "prism-api",
    });
  });

  it("returns public backend release metadata", async () => {
    const app = createPrismApp({
      versionInfo: { version: "1.2.3", revision: "abc123def456" },
      playerQueries: { async getPlayerSummary() { throw new Error("version route must not query players"); } },
      staffQueries: {
        async listPlayers() { throw new Error("version route must not list players"); },
        async listActiveSessions() { throw new Error("version route must not list sessions"); },
      },
      playerCommands: {
        async startSession() { throw new Error("version route must not start sessions"); },
        async requestDeviceCommand() { throw new Error("version route must not request devices"); },
      },
    });

    const response = await app.request("/version");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "prism-api",
      version: "1.2.3",
      revision: "abc123def456",
    });
  });

  it("returns an empty favicon so browsers do not log a 404 on Staff Web", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("favicon route must not query player data");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("favicon route must not list players");
        },
        async listActiveSessions() {
          throw new Error("favicon route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("favicon route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("favicon route must not request device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/favicon.ico");

    expect(response.status).toBe(204);
  });

  it("allows staff to read and update structured store settings", async () => {
    const settings = {
      store: {
        name: "音游窝",
        timeZone: "Asia/Tokyo",
      },
      operations: {
        coinCooldownMs: 60_000,
      },
      homeAssistantConnection: { url: "", token: "" },
      homeAssistantDevices: [] as any[],
      hinataIoDevices: [] as any[],
      registration: { defaultPresentId: null as string | null },
    };
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("settings routes must not query player data");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("settings routes must not list players");
        },
        async listActiveSessions() {
          throw new Error("settings routes must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("settings routes must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("settings routes must not request device commands");
        },
      },
      staffSettingsCommands: {
        async getSettings() {
          return settings;
        },
        async updateSettings(input) {
          settings.store = input.store;
          settings.operations = input.operations;
          settings.homeAssistantConnection = input.homeAssistantConnection ?? { url: "", token: "" };
          settings.homeAssistantDevices = input.homeAssistantDevices || [];
          settings.hinataIoDevices = input.hinataIoDevices || [];
          settings.registration = input.registration || { defaultPresentId: null };
          return settings;
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const readResponse = await app.request("/rpc/staff/settings", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toEqual({
      settings,
    });

    const updateResponse = await app.request("/rpc/staff/settings", {
      method: "PUT",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        store: {
          name: "PRiSM 店铺",
          timeZone: "Asia/Shanghai",
        },
        operations: {
          coinCooldownMs: 30_000,
        },
        homeAssistantConnection: {
          url: "http://homeassistant.local:8123",
          token: "long-lived-access-token",
        },
        homeAssistantDevices: [
          {
            name: "中二官拆",
            alias: ["chu2"],
            id: "switch.cuco_cn_571514441_v3_on_p_2_1",
          },
        ],
        hinataIoDevices: [
          {
            id: "maimai-left",
            name: "舞萌左机",
            aliases: ["mai-left"],
            url: "https://relay.example/maimai-left",
            password: "test-password",
            salt: "ABEiM0RVZneImaq7zN3u_w",
            coinKey: 32,
            cardType: "aime",
          },
        ],
        registration: {
          defaultPresentId: "present-welcome",
        },
      }),
    });
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toEqual({
      settings: {
        store: {
          name: "PRiSM 店铺",
          timeZone: "Asia/Shanghai",
        },
        operations: {
          coinCooldownMs: 30_000,
        },
        homeAssistantConnection: {
          url: "http://homeassistant.local:8123",
          token: "long-lived-access-token",
        },
        homeAssistantDevices: [
          {
            name: "中二官拆",
            alias: ["chu2"],
            id: "switch.cuco_cn_571514441_v3_on_p_2_1",
          },
        ],
        hinataIoDevices: [
          {
            id: "maimai-left",
            name: "舞萌左机",
            aliases: ["mai-left"],
            url: "https://relay.example/maimai-left",
            password: "test-password",
            salt: "ABEiM0RVZneImaq7zN3u_w",
            coinKey: 32,
            cardType: "aime",
          },
        ],
        registration: {
          defaultPresentId: "present-welcome",
        },
      },
    });
  });

  it("allows staff to manage generated API tokens without exposing token hashes", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("api token routes must not query player data");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("api token routes must not list players");
        },
        async listActiveSessions() {
          throw new Error("api token routes must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("api token routes must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("api token routes must not request device commands");
        },
      },
      staffApiTokenCommands: {
        async listApiTokens() {
          return [
            {
              id: "api-token-1",
              label: "机器人/店内入口 API",
              role: "integration",
              tokenPrefix: "integration",
              status: "active",
              createdAt: new Date("2026-06-08T09:00:00.000Z"),
              lastUsedAt: new Date("2026-06-08T09:30:00.000Z"),
              revokedAt: null,
            },
          ];
        },
        async createApiToken(input) {
          expect(input).toEqual({
            label: "机器软件接入",
            role: "machine",
          });
          return {
            id: "api-token-2",
            label: "机器软件接入",
            role: "machine",
            token: "machine-plain",
            tokenPrefix: "machine",
            status: "active",
            createdAt: new Date("2026-06-08T10:00:00.000Z"),
            lastUsedAt: null,
            revokedAt: null,
          };
        },
        async revokeApiToken(input) {
          expect(input).toEqual({
            tokenId: "api-token-2",
          });
          return {
            id: "api-token-2",
            label: "机器软件接入",
            role: "machine",
            tokenPrefix: "machine",
            status: "revoked",
            createdAt: new Date("2026-06-08T10:00:00.000Z"),
            lastUsedAt: null,
            revokedAt: new Date("2026-06-08T11:00:00.000Z"),
          };
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const listResponse = await app.request("/rpc/staff/api-tokens", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    expect(listBody).toEqual({
      apiTokens: [
        {
          id: "api-token-1",
          label: "机器人/店内入口 API",
          role: "integration",
          tokenPrefix: "integration",
          status: "active",
          createdAt: "2026-06-08T09:00:00.000Z",
          lastUsedAt: "2026-06-08T09:30:00.000Z",
          revokedAt: null,
        },
      ],
    });
    expect(JSON.stringify(listBody)).not.toContain("tokenHash");

    const createResponse = await app.request("/rpc/staff/api-tokens", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        label: "机器软件接入",
        role: "machine",
      }),
    });
    expect(createResponse.status).toBe(200);
    await expect(createResponse.json()).resolves.toEqual({
      apiToken: {
        id: "api-token-2",
        label: "机器软件接入",
        role: "machine",
        token: "machine-plain",
        tokenPrefix: "machine",
        status: "active",
        createdAt: "2026-06-08T10:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
      },
    });

    const revokeResponse = await app.request("/rpc/staff/api-tokens/api-token-2/revoke", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(revokeResponse.status).toBe(200);
    await expect(revokeResponse.json()).resolves.toEqual({
      apiToken: {
        id: "api-token-2",
        label: "机器软件接入",
        role: "machine",
        tokenPrefix: "machine",
        status: "revoked",
        createdAt: "2026-06-08T10:00:00.000Z",
        lastUsedAt: null,
        revokedAt: "2026-06-08T11:00:00.000Z",
      },
    });
  });

  it("allows staff to read a visual pricing timeline for a local day", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("pricing timeline route must not query player data");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("pricing timeline route must not list players");
        },
        async listActiveSessions() {
          throw new Error("pricing timeline route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("pricing timeline route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("pricing timeline route must not request device commands");
        },
      },
      staffPricingCommands: {
        async createPricingConfig() {
          throw new Error("pricing timeline route must not create pricing configs");
        },
        async updatePricingConfig() {
          throw new Error("pricing timeline route must not update pricing configs");
        },
        async listPricingConfigs() {
          throw new Error("pricing timeline route must not list pricing configs");
        },
        async getPricingTimeline(input) {
          return {
            providerId: "time.default",
            localDate: input.localDate,
            timeZone: "Asia/Tokyo",
            segments: [
              {
                ruleId: "fallback",
                label: "Fallback",
                startMinute: 0,
                endMinute: 1440,
                startLabel: "00:00",
                endLabel: "24:00",
              },
            ],
          };
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/pricing-configs/pricing-1/timeline?date=2026-06-07", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      timeline: {
        providerId: "time.default",
        localDate: "2026-06-07",
        timeZone: "Asia/Tokyo",
        segments: [
          {
            ruleId: "fallback",
            label: "Fallback",
            startMinute: 0,
            endMinute: 1440,
            startLabel: "00:00",
            endLabel: "24:00",
          },
        ],
      },
    });
  });

  it("allows staff to preview a visual pricing timeline before saving a pricing config", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("pricing draft timeline route must not query player data");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("pricing draft timeline route must not list players");
        },
        async listActiveSessions() {
          throw new Error("pricing draft timeline route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("pricing draft timeline route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("pricing draft timeline route must not request device commands");
        },
      },
      staffPricingCommands: {
        async createPricingConfig() {
          throw new Error("pricing draft timeline route must not create pricing configs");
        },
        async updatePricingConfig() {
          throw new Error("pricing draft timeline route must not update pricing configs");
        },
        async listPricingConfigs() {
          throw new Error("pricing draft timeline route must not list pricing configs");
        },
        async getPricingTimeline() {
          throw new Error("pricing draft timeline route must not read saved pricing configs");
        },
        async previewPricingTimeline(input) {
          expect(input).toEqual({
            localDate: "2026-06-07",
            provider: {
              id: "draft.time",
              rules: [
                {
                  id: "fallback",
                  label: "普通时段",
                  priority: 0,
                  timeRange: {
                    start: "00:00",
                    end: "00:00",
                  },
                  pricing: {
                    unitMinutes: 30,
                    unitPrice: 5,
                    roundGraceMinutes: 0,
                    priceCap: 100,
                  },
                },
              ],
            },
          });
          return {
            providerId: "draft.time",
            localDate: input.localDate,
            timeZone: "Asia/Tokyo",
            segments: [
              {
                ruleId: "fallback",
                label: "普通时段",
                priority: 0,
                startMinute: 0,
                endMinute: 1440,
                startLabel: "00:00",
                endLabel: "24:00",
                pricing: {
                  unitMinutes: 30,
                  unitPrice: 5,
                  roundGraceMinutes: 0,
                  priceCap: 100,
                },
              },
            ],
          };
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/pricing-timeline/preview", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        localDate: "2026-06-07",
        provider: {
          id: "draft.time",
          rules: [
            {
              id: "fallback",
              label: "普通时段",
              priority: 0,
              timeRange: {
                start: "00:00",
                end: "00:00",
              },
              pricing: {
                unitMinutes: 30,
                unitPrice: 5,
                roundGraceMinutes: 0,
                priceCap: 100,
              },
            },
          ],
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      timeline: {
        providerId: "draft.time",
        localDate: "2026-06-07",
        timeZone: "Asia/Tokyo",
        segments: [
          {
            ruleId: "fallback",
            label: "普通时段",
            priority: 0,
            startMinute: 0,
            endMinute: 1440,
            startLabel: "00:00",
            endLabel: "24:00",
            pricing: {
              unitMinutes: 30,
              unitPrice: 5,
              roundGraceMinutes: 0,
              priceCap: 100,
            },
          },
        ],
      },
    });
  });

  it("serves the decoupled admin UI handoff without embedding credentials", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("admin UI handoff must not query player data");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("admin UI handoff must not query staff data server-side");
        },
        async listActiveSessions() {
          throw new Error("admin UI handoff must not query active sessions server-side");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("admin UI handoff must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("admin UI handoff must not request device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/admin");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("<title>PRiSM API</title>");
    expect(html).toContain("PRiSM API is running");
    expect(html).toContain("The management interface is now fully decoupled from this backend API server.");
  });

  it("returns and revokes the authenticated staff session principal", async () => {
    let revoked = false;
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff me route must not query player data");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff me route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff me route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff me route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff me route must not request device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "owner-token",
        integration: "bot-token",
        machine: "agent-token",
      },
      adminAuth: {
        async authenticateAdminSession(token) {
          if (token !== "manager-token" || revoked) return null;
          return {
            staffId: "manager-1",
            role: "manager",
            displayName: "值班店员",
          };
        },
        async revokeAdminSession(token) {
          expect(token).toBe("manager-token");
          revoked = true;
        },
      },
    });

    const response = await app.request("/rpc/staff/me", {
      headers: {
        Authorization: "Bearer manager-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      staff: {
        id: "manager-1",
        displayName: "值班店员",
        role: "manager",
        canWrite: true,
      },
    });

    const logout = await app.request("/rpc/admin/logout", {
      method: "POST",
      headers: { Authorization: "Bearer manager-token" },
    });
    expect(logout.status).toBe(204);

    const afterLogout = await app.request("/rpc/staff/me", {
      headers: { Authorization: "Bearer manager-token" },
    });
    expect(afterLogout.status).toBe(403);
  });

  it("lets only owners manage staff users", async () => {
    const calls: string[] = [];
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff user routes must not query player data");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff user routes must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff user routes must not list active sessions");
        },
      },
      staffUserCommands: {
        async listStaffUsers() {
          calls.push("list");
          return [
            {
              id: "staff-1",
              username: "owner",
              displayName: "店主",
              role: "owner",
              status: "active",
              createdAt: new Date("2026-06-08T09:00:00.000Z"),
              updatedAt: new Date("2026-06-08T09:00:00.000Z"),
            },
          ];
        },
        async createStaffUser(input) {
          calls.push(`create:${input.username}:${input.role}`);
          return {
            id: "staff-2",
            username: "manager",
            displayName: input.displayName,
            role: input.role,
            status: "active",
            createdAt: new Date("2026-06-08T10:00:00.000Z"),
            updatedAt: new Date("2026-06-08T10:00:00.000Z"),
          };
        },
        async updateStaffUser(input) {
          calls.push(`update:${input.staffUserId}:${input.role}:${input.status}`);
          return {
            id: input.staffUserId,
            username: "manager",
            displayName: input.displayName,
            role: input.role,
            status: input.status,
            createdAt: new Date("2026-06-08T09:30:00.000Z"),
            updatedAt: new Date("2026-06-08T10:00:00.000Z"),
          };
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff user routes must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff user routes must not request device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "owner-token",
        integration: "bot-token",
        machine: "agent-token",
      },
      staffTokens: [
        {
          token: "manager-token",
          staffId: "manager-1",
          role: "manager",
        },
      ],
    });

    const deniedResponse = await app.request("/rpc/staff/users", {
      headers: {
        Authorization: "Bearer manager-token",
      },
    });
    expect(deniedResponse.status).toBe(403);
    await expect(deniedResponse.json()).resolves.toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Staff role owner required.",
      },
    });

    const listResponse = await app.request("/rpc/staff/users", {
      headers: {
        Authorization: "Bearer owner-token",
      },
    });
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({
      staffUsers: [
        {
          id: "staff-1",
          username: "owner",
          displayName: "店主",
          role: "owner",
          status: "active",
          createdAt: "2026-06-08T09:00:00.000Z",
          updatedAt: "2026-06-08T09:00:00.000Z",
        },
      ],
    });

    const createResponse = await app.request("/rpc/staff/users", {
      method: "POST",
      headers: {
        Authorization: "Bearer owner-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: "manager",
        displayName: "值班店员",
        password: "temporary-password",
        role: "manager",
      }),
    });
    expect(createResponse.status).toBe(200);
    await expect(createResponse.json()).resolves.toEqual({
      staffUser: {
        id: "staff-2",
        username: "manager",
        displayName: "值班店员",
        role: "manager",
        status: "active",
        createdAt: "2026-06-08T10:00:00.000Z",
        updatedAt: "2026-06-08T10:00:00.000Z",
      },
    });

    const updateResponse = await app.request("/rpc/staff/users/staff-2", {
      method: "PATCH",
      headers: {
        Authorization: "Bearer owner-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        displayName: "只读人员",
        role: "viewer",
        status: "disabled",
      }),
    });
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toMatchObject({
      staffUser: {
        id: "staff-2",
        username: "manager",
        displayName: "只读人员",
        role: "viewer",
        status: "disabled",
      },
    });
    expect(calls).toEqual([
      "list",
      "create:manager:manager",
      "update:staff-2:viewer:disabled",
    ]);
  });

  it("returns a player summary view model for the authenticated player", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary(playerId) {
          expect(playerId).toBe("player-1");
          return {
            player: {
              id: "player-1",
              displayName: "Neri",
              status: "active",
            },
            wallet: [
              {
                assetCode: "paid",
                quantity: centsOf(100),
              },
            ],
            activeSession: {
              id: "session-1",
              startedAt: new Date("2026-06-07T10:00:00.000Z"),
            },
          };
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("summary route must not list players");
        },
        async listActiveSessions() {
          throw new Error("summary route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("summary route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("summary route must not request device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/player/me", {
      headers: {
        Authorization: "Bearer player-session-token",
        "X-PRiSM-Player-Id": "player-1",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      player: {
        id: "player-1",
        displayName: "Neri",
        status: "active",
      },
      wallet: [
        {
          assetCode: "paid",
          quantity: centsOf(100),
        },
      ],
      activeSession: {
        id: "session-1",
        startedAt: "2026-06-07T10:00:00.000Z",
      },
    });
  });

  it("logs in a player by identity and uses the player session for player routes", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary(playerId) {
          expect(playerId).toBe("player-1");
          return {
            player: {
              id: "player-1",
              displayName: "Neri",
              status: "active",
            },
            wallet: [],
            activeSession: null,
          };
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("player auth route must not list players");
        },
        async listActiveSessions() {
          throw new Error("player auth route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("player auth route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("player auth route must not request device commands");
        },
      },
      playerAuthCommands: {
        async loginByIdentity(input) {
          expect(input).toEqual({
            identity: {
              provider: "qq",
              subject: "123456",
            },
          });
          return {
            token: "player-session-token",
            player: {
              id: "player-1",
              displayName: "Neri",
              status: "active",
              createdAt: new Date("2026-06-07T10:00:00.000Z"),
            },
          };
        },
      },
      playerSessionAuth: {
        async authenticatePlayerSession(token) {
          return token === "player-session-token" ? { playerId: "player-1" } : null;
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const loginResponse = await app.request("/rpc/player-auth/login/by-identity", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      Authorization: "Bearer staff-token",
      },
      body: JSON.stringify({
        identity: {
          provider: "qq",
          subject: "123456",
        },
      }),
    });

    expect(loginResponse.status).toBe(200);
    await expect(loginResponse.json()).resolves.toEqual({
      session: {
        token: "player-session-token",
      },
      player: {
        id: "player-1",
        displayName: "Neri",
        status: "active",
      },
    });

    const meResponse = await app.request("/rpc/player/me", {
      headers: {
        Authorization: "Bearer player-session-token",
      },
    });

    expect(meResponse.status).toBe(200);
    await expect(meResponse.json()).resolves.toMatchObject({
      player: {
        id: "player-1",
      },
    });

    const spoofedPlayerResponse = await app.request("/rpc/player/me", {
      headers: {
        Authorization: "Bearer player-session-token",
        "X-PRiSM-Player-Id": "player-2",
      },
    });

    expect(spoofedPlayerResponse.status).toBe(200);
    await expect(spoofedPlayerResponse.json()).resolves.toMatchObject({
      player: {
        id: "player-1",
      },
    });
  });

  it("rejects the old global player token on browser-facing player routes", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("global player token must not query player data");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("global player token must not list players");
        },
        async listActiveSessions() {
          throw new Error("global player token must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("global player token must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("global player token must not request device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/player/me", {
      headers: {
        Authorization: "Bearer player-token",
        "X-PRiSM-Player-Id": "player-1",
      },
    });

    expect(response.status).toBe(403);
  });

  it("returns player asset inventory and ledger views for the authenticated player", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("player asset route must not query summary");
        },
        async listPlayerAssets(playerId) {
          expect(playerId).toBe("player-1");
          return {
            holdings: [
              {
                id: "holding-1",
                assetType: "pass",
                assetCode: "pass.monthly",
                assetName: "Monthly pass",
                quantity: centsOf(1),
                activeAt: new Date("2026-06-07T10:00:00.000Z"),
                expiresAt: new Date("2026-07-07T10:00:00.000Z"),
                metadata: {
                  settlementEffect: "time.free",
                },
              },
            ],
            ledgerEntries: [
              {
                id: "ledger-1",
                assetType: "pass",
                assetCode: "pass.monthly",
                assetName: "Monthly pass",
                delta: centsOf(1),
                reason: "gift.redeem",
                refId: "code-1",
                transactionId: null,
                createdAt: new Date("2026-06-07T10:05:00.000Z"),
              },
            ],
          };
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("player asset route must not list players");
        },
        async listActiveSessions() {
          throw new Error("player asset route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("player asset route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("player asset route must not request device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/player/assets", {
      headers: {
        Authorization: "Bearer player-session-token",
        "X-PRiSM-Player-Id": "player-1",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      holdings: [
        {
          id: "holding-1",
          assetType: "pass",
          assetCode: "pass.monthly",
          assetName: "Monthly pass",
          quantity: centsOf(1),
          activeAt: "2026-06-07T10:00:00.000Z",
          expiresAt: "2026-07-07T10:00:00.000Z",
          metadata: {
            settlementEffect: "time.free",
          },
        },
      ],
      ledgerEntries: [
        {
          id: "ledger-1",
          assetType: "pass",
          assetCode: "pass.monthly",
          assetName: "Monthly pass",
          delta: centsOf(1),
          reason: "gift.redeem",
          refId: "code-1",
          transactionId: null,
          createdAt: "2026-06-07T10:05:00.000Z",
        },
      ],
    });
  });

  it("returns player session history for the authenticated player", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("player session history route must not query summary");
        },
        async listPlayerSessionHistory(playerId) {
          expect(playerId).toBe("player-1");
          return [
            {
              sessionId: "session-1",
              startedAt: new Date("2026-06-07T10:00:00.000Z"),
              endedAt: new Date("2026-06-07T11:00:00.000Z"),
              durationMinutes: 60,
              subtotal: centsOf(20),
              total: centsOf(20),
              status: "settled",
              settledAt: new Date("2026-06-07T11:00:00.000Z"),
            },
          ];
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("player session history route must not list players");
        },
        async listActiveSessions() {
          throw new Error("player session history route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("player session history route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("player session history route must not request device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/player/sessions/history", {
      headers: {
        Authorization: "Bearer player-session-token",
        "X-PRiSM-Player-Id": "player-1",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      sessions: [
        {
          sessionId: "session-1",
          startedAt: "2026-06-07T10:00:00.000Z",
          endedAt: "2026-06-07T11:00:00.000Z",
          durationMinutes: 60,
          subtotal: centsOf(20),
          total: centsOf(20),
          status: "settled",
          settledAt: "2026-06-07T11:00:00.000Z",
        },
      ],
    });
  });

  it("returns player session history detail for the authenticated player", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("player session history detail route must not query summary");
        },
        async getPlayerSessionHistoryDetail(playerId, sessionId) {
          expect(playerId).toBe("player-1");
          expect(sessionId).toBe("session-1");
          return {
            sessionId: "session-1",
            startedAt: new Date("2026-06-07T10:00:00.000Z"),
            endedAt: new Date("2026-06-07T11:00:00.000Z"),
            durationMinutes: 60,
            subtotal: centsOf(30),
            total: centsOf(20),
            status: "settled",
            settledAt: new Date("2026-06-07T11:00:00.000Z"),
            chargeItems: [
              {
                id: "charge-time",
                source: "time.default",
                label: "Base time",
                amount: 30,
              },
            ],
            adjustments: [
              {
                id: "adjustment-pass",
                source: "pass.monthly",
                label: "Monthly pass",
                amount: -10,
              },
            ],
          };
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("player session history detail route must not list players");
        },
        async listActiveSessions() {
          throw new Error("player session history detail route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("player session history detail route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("player session history detail route must not request device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/player/sessions/session-1/history", {
      headers: {
        Authorization: "Bearer player-session-token",
        "X-PRiSM-Player-Id": "player-1",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      session: {
        sessionId: "session-1",
        startedAt: "2026-06-07T10:00:00.000Z",
        endedAt: "2026-06-07T11:00:00.000Z",
        durationMinutes: 60,
        subtotal: centsOf(30),
        total: centsOf(20),
        status: "settled",
        settledAt: "2026-06-07T11:00:00.000Z",
        chargeItems: [
          {
            id: "charge-time",
            source: "time.default",
            label: "Base time",
            amount: 30,
          },
        ],
        adjustments: [
          {
            id: "adjustment-pass",
            source: "pass.monthly",
            label: "Monthly pass",
            amount: -10,
          },
        ],
      },
    });
  });

  it("rejects player endpoints without a matching player principal", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("unauthorized request must not query player data");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("unauthorized request must not list players");
        },
        async listActiveSessions() {
          throw new Error("unauthorized request must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("unauthorized request must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("unauthorized request must not request device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/player/me", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Player principal required.",
      },
    });
  });

  it("starts a player session through a command view", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("start route must not query summary data");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("start route must not list players");
        },
        async listActiveSessions() {
          throw new Error("start route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession(input) {
          expect(input).toEqual({
            playerId: "player-1",
          });
          return {
            id: "session-1",
            playerId: "player-1",
            startedAt: new Date("2026-06-07T10:00:00.000Z"),
            status: "active",
          };
        },
        async requestDeviceCommand() {
          throw new Error("start route must not request device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/player/session/start", {
      method: "POST",
      headers: {
        Authorization: "Bearer player-session-token",
        "X-PRiSM-Player-Id": "player-1",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      session: {
        id: "session-1",
        playerId: "player-1",
        startedAt: "2026-06-07T10:00:00.000Z",
        status: "active",
      },
    });
  });

  it("requests a player device command through a command view", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("device route must not query summary data");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("device route must not list players");
        },
        async listActiveSessions() {
          throw new Error("device route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("device route must not start sessions");
        },
        async requestDeviceCommand(input) {
          expect(input).toEqual({
            playerId: "player-1",
            type: "coin",
            target: {
              kind: "game_machine",
              id: "machine-1",
            },
            payload: {
              count: 1,
            },
          });
          return {
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
          };
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/player/device-commands", {
      method: "POST",
      headers: {
        Authorization: "Bearer player-session-token",
        "Content-Type": "application/json",
        "X-PRiSM-Player-Id": "player-1",
      },
      body: JSON.stringify({
        type: "coin",
        target: {
          kind: "game_machine",
          id: "machine-1",
        },
        payload: {
          count: 1,
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      command: {
        id: "command-1",
        type: "coin",
        deviceId: "machine-1",
        target: {
          kind: "game_machine",
          id: "machine-1",
        },
        executorKind: "machine_ws",
        playerId: "player-1",
        status: "pending",
        payload: {
          count: 1,
        },
        requestedAt: "2026-06-07T10:05:00.000Z",
      },
    });
  });

  it("previews player checkout through a billing view", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("checkout preview route must not query summary data");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("checkout preview route must not list players");
        },
        async listActiveSessions() {
          throw new Error("checkout preview route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("checkout preview route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("checkout preview route must not request device commands");
        },
      },
      playerCheckoutCommands: {
        async previewCheckout(input) {
          expect(input).toEqual({
            playerId: "player-1",
          });
          return {
            settlementPreview: {
              playerId: "player-1",
              sessionIds: ["session-1"],
              subtotal: centsOf(20),
              total: centsOf(15),
              status: "preview",
              previewedAt: new Date("2026-06-07T11:00:00.000Z"),
            },
            sessionPreviews: [
              {
                sessionId: "session-1",
                label: "Time",
                startedAt: new Date("2026-06-07T10:00:00.000Z"),
                endedAt: new Date("2026-06-07T11:00:00.000Z"),
                status: "closed",
                subtotal: centsOf(20),
                total: centsOf(15),
                chargeItems: [],
                adjustments: [],
              },
            ],
            chargeItems: [
              {
                id: "charge-1",
                source: "time",
                label: "Time",
                amount: 20,
              },
            ],
            adjustments: [
              {
                id: "coupon-1",
                source: "coupon",
                label: "Coupon",
                amount: -5,
              },
            ],
            checkoutAdjustments: [],
            pricingCapAdjustments: [],
            wallet: { balanceBefore: 100, balanceAfter: 85 },
            globalCapWindows: [],
          };
        },
        async checkout() {
          throw new Error("checkout preview route must not confirm checkout");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/player/checkout/preview", {
      method: "POST",
      headers: {
        Authorization: "Bearer player-session-token",
        "X-PRiSM-Player-Id": "player-1",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      settlementPreview: {
        playerId: "player-1",
        sessionIds: ["session-1"],
        subtotal: centsOf(20),
        total: centsOf(15),
        status: "preview",
        previewedAt: "2026-06-07T11:00:00.000Z",
      },
      sessionPreviews: [
        {
          sessionId: "session-1",
          label: "Time",
          startedAt: "2026-06-07T10:00:00.000Z",
          endedAt: "2026-06-07T11:00:00.000Z",
          status: "closed",
          subtotal: centsOf(20),
          total: centsOf(15),
          chargeItems: [],
          adjustments: [],
        },
      ],
      chargeItems: [
        {
          id: "charge-1",
          source: "time",
          label: "Time",
          amount: 20,
        },
      ],
      adjustments: [
        {
          id: "coupon-1",
          source: "coupon",
          label: "Coupon",
          amount: -5,
        },
      ],
      checkoutAdjustments: [],
      pricingCapAdjustments: [],
      globalCapWindows: [],
      wallet: { balanceBefore: 100, balanceAfter: 85 },
    });
  });

  it("confirms player checkout through a billing view", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("checkout route must not query summary data");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("checkout route must not list players");
        },
        async listActiveSessions() {
          throw new Error("checkout route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("checkout route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("checkout route must not request device commands");
        },
      },
      playerCheckoutCommands: {
        async previewCheckout() {
          throw new Error("checkout route must not preview checkout");
        },
        async checkout(input) {
          expect(input).toEqual({
            playerId: "player-1",
          });
          return {
            playerSettlement: {
              playerId: "player-1",
              sessionIds: ["session-1"],
              subtotal: centsOf(20),
              total: centsOf(20),
              status: "settled",
              settledAt: new Date("2026-06-07T11:00:00.000Z"),
            },
            settlements: [
              {
                settlement: {
                  sessionId: "session-1",
                  subtotal: centsOf(20),
                  total: centsOf(20),
                  status: "settled",
                  settledAt: new Date("2026-06-07T11:00:00.000Z"),
                },
                chargeItems: [
                  {
                    id: "charge-1",
                    source: "time",
                    label: "Time",
                    amount: 20,
                  },
                ],
                adjustments: [],
              },
            ],
            sessionDetails: [
              {
                sessionId: "session-1",
                label: "Time",
                startedAt: new Date("2026-06-07T10:00:00.000Z"),
                endedAt: new Date("2026-06-07T11:00:00.000Z"),
              },
            ],
            chargeItems: [
              {
                id: "charge-1",
                source: "time",
                label: "Time",
                amount: 20,
              },
            ],
            adjustments: [],
            checkoutAdjustments: [],
            pricingCapAdjustments: [],
            assetLedgerEntries: [
              {
                assetType: "currency",
                assetCode: "currency.paid",
                delta: centsOf(-20),
                reason: "session.settlement",
                refId: "session-1",
              },
            ],
            wallet: { balanceBefore: 100, balanceAfter: 80 },
            globalCapWindows: [],
          };
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/player/checkout/confirm", {
      method: "POST",
      headers: {
        Authorization: "Bearer player-session-token",
        "X-PRiSM-Player-Id": "player-1",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      playerSettlement: {
        playerId: "player-1",
        sessionIds: ["session-1"],
        subtotal: centsOf(20),
        total: centsOf(20),
        status: "settled",
        settledAt: "2026-06-07T11:00:00.000Z",
      },
      settlements: [
        {
          settlement: {
            sessionId: "session-1",
            label: "Time",
            startedAt: "2026-06-07T10:00:00.000Z",
            endedAt: "2026-06-07T11:00:00.000Z",
            subtotal: centsOf(20),
            total: centsOf(20),
            status: "settled",
            settledAt: "2026-06-07T11:00:00.000Z",
          },
          chargeItems: [
            {
              id: "charge-1",
              source: "time",
              label: "Time",
              amount: 20,
            },
          ],
          adjustments: [],
        },
      ],
      chargeItems: [
        {
          id: "charge-1",
          source: "time",
          label: "Time",
          amount: 20,
        },
      ],
      adjustments: [],
      checkoutAdjustments: [],
      pricingCapAdjustments: [],
      globalCapWindows: [],
      assetLedgerEntries: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          delta: centsOf(-20),
          reason: "session.settlement",
          refId: "session-1",
        },
      ],
      wallet: { balanceBefore: 100, balanceAfter: 80 },
    });
  });

  it("allows staff to checkout a player session with an override", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff override checkout route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff override checkout route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff override checkout route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff override checkout route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff override checkout route must not request device commands");
        },
      },
      playerCheckoutCommands: {
        async previewCheckout() {
          throw new Error("staff override checkout route must not preview checkout");
        },
        async checkout() {
          throw new Error("staff override checkout route must not use player checkout");
        },
      },
      staffCheckoutCommands: {
        async checkout() {
          throw new Error("staff override checkout route must not use plain staff checkout");
        },
        async checkoutWithOverride(input) {
          expect(input).toEqual({
            playerId: "player-1",
            staffId: "staff-1",
            total: centsOf(5),
            reason: "machine fault",
          });
          return {
            playerSettlement: {
              playerId: "player-1",
              sessionIds: ["session-1"],
              subtotal: centsOf(20),
              total: centsOf(5),
              status: "settled",
              settledAt: new Date("2026-06-07T11:00:00.000Z"),
            },
            settlements: [
              {
                settlement: {
                  sessionId: "session-1",
                  subtotal: centsOf(20),
                  total: centsOf(5),
                  status: "settled",
                  settledAt: new Date("2026-06-07T11:00:00.000Z"),
                },
                chargeItems: [
                  {
                    id: "charge-1",
                    source: "time",
                    label: "Time",
                    amount: 20,
                  },
                ],
                adjustments: [
                  {
                    id: "session-1:staff.override",
                    source: "staff.override:staff-1",
                    label: "Staff override: machine fault",
                    amount: -15,
                  },
                ],
              },
            ],
            sessionDetails: [
              {
                sessionId: "session-1",
                label: "Time",
                startedAt: new Date("2026-06-07T10:00:00.000Z"),
                endedAt: new Date("2026-06-07T11:00:00.000Z"),
              },
            ],
            chargeItems: [
              {
                id: "charge-1",
                source: "time",
                label: "Time",
                amount: 20,
              },
            ],
            adjustments: [
              {
                id: "session-1:staff.override",
                source: "staff.override:staff-1",
                label: "Staff override: machine fault",
                amount: -15,
              },
            ],
            checkoutAdjustments: [],
            pricingCapAdjustments: [],
            assetLedgerEntries: [
              {
                assetType: "currency",
                assetCode: "currency.paid",
                delta: centsOf(-5),
                reason: "session.settlement",
                refId: "session-1",
              },
            ],
            wallet: { balanceBefore: 100, balanceAfter: 95 },
            globalCapWindows: [],
          };
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
      staffTokens: [
        {
          token: "staff-1-token",
          staffId: "staff-1",
          role: "manager",
        },
      ],
    });

    const response = await app.request("/rpc/staff/players/player-1/checkout/override", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-1-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        total: centsOf(5),
        reason: "machine fault",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      playerSettlement: {
        playerId: "player-1",
        sessionIds: ["session-1"],
        subtotal: centsOf(20),
        total: centsOf(5),
        status: "settled",
        settledAt: "2026-06-07T11:00:00.000Z",
      },
      settlements: [
        {
          settlement: {
            sessionId: "session-1",
            subtotal: centsOf(20),
            total: centsOf(5),
            status: "settled",
            settledAt: "2026-06-07T11:00:00.000Z",
          },
          chargeItems: [
            {
              id: "charge-1",
              source: "time",
              label: "Time",
              amount: 20,
            },
          ],
          adjustments: [
            {
              id: "session-1:staff.override",
              source: "staff.override:staff-1",
              label: "Staff override: machine fault",
              amount: -15,
            },
          ],
        },
      ],
      adjustments: [
        {
          id: "session-1:staff.override",
          source: "staff.override:staff-1",
          label: "Staff override: machine fault",
          amount: -15,
        },
      ],
      assetLedgerEntries: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          delta: centsOf(-5),
        },
      ],
    });
  });

  it("allows write-capable staff to start a player's billing session", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff start-session route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff start-session route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff start-session route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession(input) {
          expect(input).toEqual({
            playerId: "player-1",
          });
          return {
            id: "session-1",
            playerId: input.playerId,
            startedAt: new Date("2026-06-07T10:00:00.000Z"),
            status: "active",
          };
        },
        async requestDeviceCommand() {
          throw new Error("staff start-session route must not request device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
      staffTokens: [
        {
          token: "manager-token",
          staffId: "staff-1",
          role: "manager",
        },
      ],
    });

    const response = await app.request("/rpc/staff/players/player-1/session/start", {
      method: "POST",
      headers: {
        Authorization: "Bearer manager-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      session: {
        id: "session-1",
        playerId: "player-1",
        startedAt: "2026-06-07T10:00:00.000Z",
        status: "active",
      },
    });
  });

  it("rejects viewer staff when starting a player's billing session", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("viewer staff start-session route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("viewer staff start-session route must not list players");
        },
        async listActiveSessions() {
          throw new Error("viewer staff start-session route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("viewer staff start-session route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("viewer staff start-session route must not request device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
      staffTokens: [
        {
          token: "viewer-token",
          staffId: "staff-1",
          role: "viewer",
        },
      ],
    });

    const response = await app.request("/rpc/staff/players/player-1/session/start", {
      method: "POST",
      headers: {
        Authorization: "Bearer viewer-token",
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Staff role manager or owner required.",
      },
    });
  });

  it("returns domain errors from staff-started billing sessions as structured API errors", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("domain-error staff start-session route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("domain-error staff start-session route must not list players");
        },
        async listActiveSessions() {
          throw new Error("domain-error staff start-session route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new PrismDomainError(
            "Player cannot start a billing session outside billable business intervals.",
            "PLAYER_SESSION_OUTSIDE_BILLABLE_TIME",
          );
        },
        async requestDeviceCommand() {
          throw new Error("domain-error staff start-session route must not request device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/players/player-1/session/start", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "PLAYER_SESSION_OUTSIDE_BILLABLE_TIME",
        message: "Player cannot start a billing session outside billable business intervals.",
      },
    });
  });

  it("allows staff to preview a player's active session checkout", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff preview checkout route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff preview checkout route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff preview checkout route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff preview checkout route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff preview checkout route must not request device commands");
        },
      },
      staffCheckoutCommands: {
        async previewCheckout(input) {
          expect(input).toEqual({
            playerId: "player-1",
          });
          return {
            settlementPreview: {
              playerId: "player-1",
              sessionIds: ["session-1"],
              subtotal: centsOf(20),
              total: centsOf(12),
              status: "preview",
              previewedAt: new Date("2026-06-07T10:55:00.000Z"),
            },
            sessionPreviews: [
              {
                sessionId: "session-1",
                label: "Time",
                startedAt: new Date("2026-06-07T10:00:00.000Z"),
                endedAt: new Date("2026-06-07T10:55:00.000Z"),
                status: "closed",
                subtotal: centsOf(20),
                total: centsOf(12),
                chargeItems: [],
                adjustments: [],
              },
            ],
            chargeItems: [
              {
                id: "charge-1",
                source: "time",
                label: "Time",
                amount: 20,
              },
            ],
            adjustments: [
              {
                id: "discount-1",
                source: "pass",
                label: "Pass",
                amount: -8,
              },
            ],
            checkoutAdjustments: [],
            pricingCapAdjustments: [
              {
                id: "time-cap:cap-1:night:2026-06-06T14:00:00.000Z",
                source: "time.cap:cap-1:night",
                label: "夜间",
                amount: -8,
              },
            ],
            wallet: { balanceBefore: 0, balanceAfter: -12 },
            globalCapWindows: [
              {
                key: "cap-1@night@2026-06-06T14:00:00.000Z",
                capConfigId: "cap-1",
                capRuleId: "night",
                ruleLabel: "夜间",
                windowStartedAt: new Date("2026-06-06T14:00:00.000Z"),
                windowEndedAt: new Date("2026-06-07T02:00:00.000Z"),
                priceCap: 12,
                paidBefore: 0,
                currentAmount: 20,
                amountApplied: 12,
                contributions: [],
              },
            ],
          };
        },
        async checkout() {
          throw new Error("staff preview checkout route must not confirm checkout");
        },
        async checkoutWithOverride() {
          throw new Error("staff preview checkout route must not override checkout");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/players/player-1/checkout/preview", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      settlementPreview: {
        playerId: "player-1",
        sessionIds: ["session-1"],
        subtotal: centsOf(20),
        total: centsOf(12),
        status: "preview",
        previewedAt: "2026-06-07T10:55:00.000Z",
      },
      sessionPreviews: [
        {
          sessionId: "session-1",
          total: centsOf(12),
        },
      ],
      chargeItems: [
        {
          label: "Time",
          amount: 20,
        },
      ],
      checkoutAdjustments: [],
      pricingCapAdjustments: [
        {
          source: "time.cap:cap-1:night",
          amount: -8,
        },
      ],
      globalCapWindows: [
        {
          ruleLabel: "夜间",
          windowStartedAt: "2026-06-06T14:00:00.000Z",
          windowEndedAt: "2026-06-07T02:00:00.000Z",
          currentAmount: 20,
          amountApplied: 12,
        },
      ],
    });
  });

  it("allows staff to confirm a player's active session checkout without override", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff checkout route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff checkout route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff checkout route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff checkout route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff checkout route must not request device commands");
        },
      },
      staffCheckoutCommands: {
        async checkout(input) {
          expect(input).toEqual({
            playerId: "player-1",
          });
          return {
            playerSettlement: {
              playerId: "player-1",
              sessionIds: ["session-1"],
              subtotal: centsOf(20),
              total: centsOf(20),
              status: "settled",
              settledAt: new Date("2026-06-07T11:00:00.000Z"),
            },
            settlements: [
              {
                settlement: {
                  sessionId: "session-1",
                  subtotal: centsOf(20),
                  total: centsOf(20),
                  status: "settled",
                  settledAt: new Date("2026-06-07T11:00:00.000Z"),
                },
                chargeItems: [
                  {
                    id: "charge-1",
                    source: "time",
                    label: "Time",
                    amount: 20,
                  },
                ],
                adjustments: [],
              },
            ],
            sessionDetails: [
              {
                sessionId: "session-1",
                label: "Time",
                startedAt: new Date("2026-06-07T10:00:00.000Z"),
                endedAt: new Date("2026-06-07T11:00:00.000Z"),
              },
            ],
            chargeItems: [
              {
                id: "charge-1",
                source: "time",
                label: "Time",
                amount: 20,
              },
            ],
            adjustments: [],
            checkoutAdjustments: [],
            pricingCapAdjustments: [],
            assetLedgerEntries: [
              {
                assetType: "currency",
                assetCode: "currency.paid",
                delta: centsOf(-20),
                reason: "session.settlement",
                refId: "session-1",
              },
            ],
            wallet: { balanceBefore: 100, balanceAfter: 80 },
            globalCapWindows: [],
          };
        },
        async checkoutWithOverride() {
          throw new Error("staff checkout route must not use override checkout");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/players/player-1/checkout/confirm", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      playerSettlement: {
        playerId: "player-1",
        sessionIds: ["session-1"],
        subtotal: centsOf(20),
        total: centsOf(20),
        status: "settled",
        settledAt: "2026-06-07T11:00:00.000Z",
      },
      settlements: [
        {
          settlement: {
            sessionId: "session-1",
            subtotal: centsOf(20),
            total: centsOf(20),
            status: "settled",
            settledAt: "2026-06-07T11:00:00.000Z",
          },
          adjustments: [],
        },
      ],
      adjustments: [],
      checkoutAdjustments: [],
      pricingCapAdjustments: [],
      globalCapWindows: [],
      assetLedgerEntries: [
        {
          delta: centsOf(-20),
          reason: "session.settlement",
        },
      ],
    });
  });

  it("allows staff to stop one player session without settling the player", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff stop route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff stop route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff stop route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff stop route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff stop route must not request device commands");
        },
      },
      staffCheckoutCommands: {
        async stopSession(input) {
          expect(input).toEqual({
            playerId: "player-1",
            sessionId: "session-2",
          });
          return {
            id: "session-2",
            playerId: "player-1",
            startedAt: new Date("2026-06-07T10:30:00.000Z"),
            endedAt: new Date("2026-06-07T11:00:00.000Z"),
            status: "closed",
            pricingConfigIds: ["time"],
            paymentStatus: "unpaid",
            label: "四口麻将",
          };
        },
        async checkout() {
          throw new Error("staff stop route must not checkout");
        },
        async checkoutWithOverride() {
          throw new Error("staff stop route must not override checkout");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/players/player-1/sessions/session-2/stop", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      session: {
        id: "session-2",
        playerId: "player-1",
        startedAt: "2026-06-07T10:30:00.000Z",
        endedAt: "2026-06-07T11:00:00.000Z",
        status: "closed",
        paymentStatus: "unpaid",
        label: "四口麻将",
      },
    });
  });

  it("returns player-first live operations rows for staff", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("live players route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          return [
            {
              id: "player-1",
              displayName: "A",
              status: "active",
              walletTotal: 132,
              activeSessionId: "session-1",
            },
          ];
        },
        async listLiveSessions() {
          return [
            {
              id: "session-1",
              playerId: "player-1",
              playerDisplayName: "A",
              startedAt: new Date("2026-06-07T10:00:00.000Z"),
              elapsedMinutes: 120,
              status: "active",
            },
          ];
        },
        async listActiveSessions() {
          return [];
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("live players route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("live players route must not request device commands");
        },
      },
      staffCheckoutCommands: {
        async previewCheckout(input: any) {
          expect(input).toEqual({
            playerId: "player-1",
          });
          return {
            settlementPreview: {
              playerId: "player-1",
              sessionIds: ["session-1", "session-2"],
              subtotal: centsOf(64),
              total: centsOf(56),
              status: "preview",
              previewedAt: new Date("2026-06-07T12:00:00.000Z"),
            },
            sessionPreviews: [
              {
                sessionId: "session-1",
                label: "音游区间",
                startedAt: new Date("2026-06-07T10:00:00.000Z"),
                endedAt: null,
                status: "active",
                subtotal: centsOf(64),
                total: centsOf(64),
                chargeItems: [
                  {
                    id: "charge-1",
                    source: "pricing-music",
                    label: "日场",
                    amount: 64,
                    pricingHistory: {
                      pricingConfigId: "pricing-music",
                      providerId: "time.music",
                      ruleId: "rule-day",
                      ruleAnchorAt: new Date("2026-06-07T10:00:00.000Z"),
                      amount: 64,
                    },
                    pricingExplanation: {
                      pricingConfigId: "pricing-music",
                      providerId: "time.music",
                      ruleId: "rule-night",
                      ruleLabel: "平日夜场",
                      period: {
                        startedAt: new Date("2026-06-07T10:00:00.000Z"),
                        endedAt: new Date("2026-06-07T11:00:00.000Z"),
                      },
                      ruleTimeRange: { start: "18:00", end: "02:00" },
                      intervalCap: 100,
                      intervalCapReached: true,
                    },
                  },
                ],
                adjustments: [],
              },
              {
                sessionId: "session-2",
                label: "四口麻将",
                startedAt: new Date("2026-06-07T10:45:00.000Z"),
                endedAt: new Date("2026-06-07T12:00:00.000Z"),
                status: "closed",
                subtotal: centsOf(0),
                total: -8,
                chargeItems: [],
                adjustments: [
                  {
                    id: "adjustment-1",
                    source: "mahjong",
                    label: "麻将折抵",
                    amount: -8,
                  },
                ],
              },
            ],
            chargeItems: [],
            adjustments: [],
            checkoutAdjustments: [],
            pricingCapAdjustments: [],
            wallet: { balanceBefore: 0, balanceAfter: 0 },
            globalCapWindows: [
              {
                key: "night:2026-06-07",
                capConfigId: "cap-night",
                capRuleId: "night",
                ruleLabel: "夜间",
                windowStartedAt: new Date("2026-06-07T10:00:00.000Z"),
                windowEndedAt: new Date("2026-06-07T18:00:00.000Z"),
                priceCap: 79,
                paidBefore: 20,
                currentAmount: 100,
                amountApplied: 79,
                contributions: [
                  { sessionId: "session-1", pricingConfigId: "pricing-music", amount: 79 },
                ],
              },
            ],
          };
        },
        async checkout() {
          throw new Error("live players route must not checkout");
        },
        async checkoutWithOverride() {
          throw new Error("live players route must not override checkout");
        },
      },
      staffPricingCommands: {
        async createPricingConfig() {
          throw new Error("live players route must not create pricing configs");
        },
        async updatePricingConfig() {
          throw new Error("live players route must not update pricing configs");
        },
        async listPricingConfigs() {
          return [
            {
              id: "pricing-music",
              kind: "time.priority",
              name: "音游标准计费",
              enabled: true,
              provider: {
                id: "time.music",
                rules: [],
              },
              createdAt: new Date("2026-06-07T09:00:00.000Z"),
              updatedAt: new Date("2026-06-07T09:00:00.000Z"),
            },
          ];
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/live-players", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      players: [
        {
          playerId: "player-1",
          identities: [],
          displayName: "A",
          status: "active",
          walletTotal: 132,
          stayDurationMinutes: 120,
          estimatedTotal: 56,
          globalCapWindows: [
            {
              key: "night:2026-06-07",
              capConfigId: "cap-night",
              capRuleId: "night",
              ruleLabel: "夜间",
              windowStartedAt: "2026-06-07T10:00:00.000Z",
              windowEndedAt: "2026-06-07T18:00:00.000Z",
              priceCap: 79,
              paidBefore: 20,
              currentAmount: 100,
              amountApplied: 79,
              priceCapReached: true,
              contributions: [
                { sessionId: "session-1", pricingConfigId: "pricing-music", amount: 79 },
              ],
            },
          ],
          sessions: [
            {
              id: "session-1",
              startedAt: "2026-06-07T10:00:00.000Z",
              endedAt: null,
              elapsedMinutes: 120,
              currentImpact: 64,
              pricingSegments: [
                {
                  pricingConfigId: "pricing-music",
                  planName: "音游标准计费",
                  providerId: "time.music",
                  ruleId: "rule-night",
                  ruleLabel: "平日夜场",
                  actualStartedAt: "2026-06-07T10:00:00.000Z",
                  actualEndedAt: "2026-06-07T11:00:00.000Z",
                  ruleTimeRange: { start: "18:00", end: "02:00" },
                  amount: 64,
                  intervalCap: 100,
                  intervalCapReached: true,
                },
              ],
              pricingCharges: [
                {
                  pricingConfigId: "pricing-music",
                  planName: "音游标准计费",
                  ruleLabel: "日场",
                  amount: 64,
                },
              ],
              status: "active",
            },
            {
              id: "session-2",
              label: "四口麻将",
              startedAt: "2026-06-07T10:45:00.000Z",
              endedAt: "2026-06-07T12:00:00.000Z",
              elapsedMinutes: 75,
              currentImpact: -8,
              pricingSegments: [],
              pricingCharges: [],
              status: "closed",
            },
          ],
        },
      ],
    });
  });

  it("allows staff to bulk checkout all active sessions", async () => {
    const checkedOutPlayerIds: string[] = [];
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff bulk checkout route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff bulk checkout route must not list players");
        },
        async listActiveSessions() {
          return [
            {
              id: "session-1",
              playerId: "player-1",
              playerDisplayName: "Neri",
              startedAt: new Date("2026-06-07T10:00:00.000Z"),
              elapsedMinutes: 60,
            },
            {
              id: "session-2",
              playerId: "player-2",
              playerDisplayName: "Mika",
              startedAt: new Date("2026-06-07T10:30:00.000Z"),
              elapsedMinutes: 30,
            },
          ];
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff bulk checkout route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff bulk checkout route must not request device commands");
        },
      },
      staffCheckoutCommands: {
        async checkout(input: any) {
          checkedOutPlayerIds.push(input.playerId);
          const isPlayer1 = input.playerId === "player-1";
          return {
            playerSettlement: {
              playerId: input.playerId,
              sessionIds: [isPlayer1 ? "session-1" : "session-2"],
              subtotal: centsOf(isPlayer1 ? 20 : 10),
              total: centsOf(isPlayer1 ? 20 : 10),
              status: "settled",
              settledAt: new Date("2026-06-07T11:00:00.000Z"),
            },
            settlements: [
              {
                settlement: {
                  sessionId: isPlayer1 ? "session-1" : "session-2",
                  subtotal: centsOf(isPlayer1 ? 20 : 10),
                  total: centsOf(isPlayer1 ? 20 : 10),
                  status: "settled",
                  settledAt: new Date("2026-06-07T11:00:00.000Z"),
                },
                chargeItems: [],
                adjustments: [],
              },
            ],
            sessionDetails: [
              {
                sessionId: isPlayer1 ? "session-1" : "session-2",
                label: null,
                startedAt: new Date("2026-06-07T10:00:00.000Z"),
                endedAt: new Date("2026-06-07T11:00:00.000Z"),
              },
            ],
            chargeItems: [],
            adjustments: [],
            checkoutAdjustments: [],
            pricingCapAdjustments: [],
            assetLedgerEntries: [],
            wallet: {
              balanceBefore: 100,
              balanceAfter: isPlayer1 ? 80 : 90,
            },
            globalCapWindows: [],
          };
        },
        async checkoutWithOverride() {
          throw new Error("staff bulk checkout route must not use override checkout");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/sessions/active/checkout", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
      },
    });

    expect(response.status).toBe(200);
    expect(checkedOutPlayerIds).toEqual(["player-1", "player-2"]);
    await expect(response.json()).resolves.toMatchObject({
      settlements: [
        {
          playerSettlement: {
            playerId: "player-1",
            total: centsOf(20),
          },
        },
        {
          playerSettlement: {
            playerId: "player-2",
            total: centsOf(10),
          },
        },
      ],
    });
  });

  it("redeems a player code through a gift view", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("redeem route must not query summary data");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("redeem route must not list players");
        },
        async listActiveSessions() {
          throw new Error("redeem route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("redeem route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("redeem route must not request device commands");
        },
      },
      playerRedeemCommands: {
        async redeemCode(input) {
          expect(input).toEqual({
            playerId: "player-1",
            code: "PRISM-2026",
          });
          return {
            redeemRecord: {
              playerId: "player-1",
              codeId: "code-1",
              presentId: "present-1",
              redeemedAt: new Date("2026-06-07T10:00:00.000Z"),
            },
            holdings: [
              {
                id: "holding-1",
                assetType: "currency",
                assetCode: "currency.paid",
                quantity: centsOf(179),
                activeAt: null,
                expiresAt: null,
              },
            ],
            grantedAssets: [
              {
                assetType: "currency",
                assetCode: "currency.paid",
                assetName: "猫粮",
                quantity: centsOf(100),
              },
            ],
            availableHoldings: [
              {
                id: "holding-1",
                assetType: "currency",
                assetCode: "currency.paid",
                assetName: "猫粮",
                quantity: centsOf(179),
                activeAt: null,
                expiresAt: null,
                metadata: null,
              },
            ],
            assetLedgerEntries: [
              {
                assetType: "currency",
                assetCode: "currency.paid",
                delta: centsOf(100),
                reason: "gift.redeem",
                refId: "code-1",
              },
            ],
          };
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/player/redeem", {
      method: "POST",
      headers: {
        Authorization: "Bearer player-session-token",
        "Content-Type": "application/json",
        "X-PRiSM-Player-Id": "player-1",
      },
      body: JSON.stringify({
        code: "PRISM-2026",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      redeemRecord: {
        playerId: "player-1",
        codeId: "code-1",
        presentId: "present-1",
        redeemedAt: "2026-06-07T10:00:00.000Z",
      },
      grantedAssets: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          assetName: "猫粮",
          quantity: centsOf(100),
        },
      ],
      currentHoldings: [
        {
          id: "holding-1",
          assetType: "currency",
          assetCode: "currency.paid",
          assetName: "猫粮",
          quantity: centsOf(179),
          activeAt: null,
          expiresAt: null,
          metadata: null,
        },
      ],
      assetLedgerEntries: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          delta: centsOf(100),
          reason: "gift.redeem",
          refId: "code-1",
        },
      ],
    });
  });

  it("lets a player purchase and list business item orders", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("business item order routes must not query player summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("business item order routes must not list staff players");
        },
        async listActiveSessions() {
          throw new Error("business item order routes must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("business item order routes must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("business item order routes must not request device commands");
        },
      },
      businessItemOrderCommands: {
        async purchaseBusinessItem(input) {
          expect(input).toEqual({
            playerId: "player-1",
            businessItemId: "business-item-1",
            metadata: { note: "bot purchase" },
          });
          return {
            order: {
              id: "order-1",
              businessItemId: "business-item-1",
              businessItemKind: "event.entry",
              businessItemName: "周末挑战赛报名",
              playerId: "player-1",
              sessionId: "session-1",
              status: "paid",
              price: 1200,
              assetType: "ticket",
              assetCode: "event.weekend",
              metadata: { note: "bot purchase" },
              createdAt: new Date("2026-06-08T03:00:00.000Z"),
              updatedAt: new Date("2026-06-08T03:00:00.000Z"),
              fulfilledAt: null,
              cancelledAt: null,
            },
            assetLedgerEntries: [
              {
                assetType: "currency",
                assetCode: "paid",
                delta: centsOf(-1200),
                reason: "business-item.purchase",
                refId: "order-1",
              },
            ],
          };
        },
        async listPlayerBusinessItemOrders(input) {
          expect(input).toEqual({ playerId: "player-1" });
          return [
            {
              id: "order-1",
              businessItemId: "business-item-1",
              businessItemKind: "event.entry",
              businessItemName: "周末挑战赛报名",
              playerId: "player-1",
              sessionId: "session-1",
              status: "paid",
              price: 1200,
              assetType: "ticket",
              assetCode: "event.weekend",
              metadata: null,
              createdAt: new Date("2026-06-08T03:00:00.000Z"),
              updatedAt: new Date("2026-06-08T03:00:00.000Z"),
              fulfilledAt: null,
              cancelledAt: null,
            },
          ];
        },
        async listBusinessItemOrders() {
          throw new Error("player route must not list all business item orders");
        },
        async fulfillBusinessItemOrder() {
          throw new Error("player route must not fulfill business item orders");
        },
        async cancelBusinessItemOrder() {
          throw new Error("player route must not cancel business item orders");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const purchaseResponse = await app.request("/rpc/player/business-items/business-item-1/purchase", {
      method: "POST",
      headers: {
        Authorization: "Bearer player-session-token",
        "X-PRiSM-Player-Id": "player-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        metadata: { note: "bot purchase" },
      }),
    });

    expect(purchaseResponse.status).toBe(200);
    await expect(purchaseResponse.json()).resolves.toMatchObject({
      businessItemOrder: {
        id: "order-1",
        businessItemId: "business-item-1",
        status: "paid",
        createdAt: "2026-06-08T03:00:00.000Z",
      },
      assetLedgerEntries: [
        {
          assetCode: "paid",
          delta: centsOf(-1200),
        },
      ],
    });

    const listResponse = await app.request("/rpc/player/business-item-orders", {
      headers: {
        Authorization: "Bearer player-session-token",
        "X-PRiSM-Player-Id": "player-1",
      },
    });
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      businessItemOrders: [
        {
          id: "order-1",
          playerId: "player-1",
          status: "paid",
        },
      ],
    });
  });

  it("lets staff list, fulfill, and cancel business item orders", async () => {
    const calls: string[] = [];
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff business item order routes must not query player summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff business item order routes must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff business item order routes must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff business item order routes must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff business item order routes must not request device commands");
        },
      },
      businessItemOrderCommands: {
        async purchaseBusinessItem() {
          throw new Error("staff route must not purchase business item orders");
        },
        async listPlayerBusinessItemOrders() {
          throw new Error("staff route must not use player-scoped order listing");
        },
        async listBusinessItemOrders() {
          calls.push("list");
          return [
            {
              id: "order-1",
              businessItemId: "business-item-1",
              businessItemKind: "event.entry",
              businessItemName: "周末挑战赛报名",
              playerId: "player-1",
              sessionId: "session-1",
              status: "paid",
              price: 1200,
              assetType: "ticket",
              assetCode: "event.weekend",
              metadata: null,
              createdAt: new Date("2026-06-08T03:00:00.000Z"),
              updatedAt: new Date("2026-06-08T03:00:00.000Z"),
              fulfilledAt: null,
              cancelledAt: null,
            },
          ];
        },
        async fulfillBusinessItemOrder(input) {
          calls.push(`fulfill:${input.orderId}`);
          return {
            id: input.orderId,
            businessItemId: "business-item-1",
            businessItemKind: "event.entry",
            businessItemName: "周末挑战赛报名",
            playerId: "player-1",
            sessionId: "session-1",
            status: "fulfilled",
            price: 1200,
            assetType: "ticket",
            assetCode: "event.weekend",
            metadata: null,
            createdAt: new Date("2026-06-08T03:00:00.000Z"),
            updatedAt: new Date("2026-06-08T03:10:00.000Z"),
            fulfilledAt: new Date("2026-06-08T03:10:00.000Z"),
            cancelledAt: null,
          };
        },
        async cancelBusinessItemOrder(input) {
          calls.push(`cancel:${input.orderId}`);
          return {
            id: input.orderId,
            businessItemId: "business-item-1",
            businessItemKind: "event.entry",
            businessItemName: "周末挑战赛报名",
            playerId: "player-1",
            sessionId: "session-1",
            status: "cancelled",
            price: 1200,
            assetType: "ticket",
            assetCode: "event.weekend",
            metadata: null,
            createdAt: new Date("2026-06-08T03:00:00.000Z"),
            updatedAt: new Date("2026-06-08T03:20:00.000Z"),
            fulfilledAt: null,
            cancelledAt: new Date("2026-06-08T03:20:00.000Z"),
          };
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const listResponse = await app.request("/rpc/staff/business-item-orders", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      businessItemOrders: [
        {
          id: "order-1",
          status: "paid",
        },
      ],
    });

    const fulfillResponse = await app.request("/rpc/staff/business-item-orders/order-1/fulfill", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(fulfillResponse.status).toBe(200);
    await expect(fulfillResponse.json()).resolves.toMatchObject({
      businessItemOrder: {
        id: "order-1",
        status: "fulfilled",
        fulfilledAt: "2026-06-08T03:10:00.000Z",
      },
    });

    const cancelResponse = await app.request("/rpc/staff/business-item-orders/order-2/cancel", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(cancelResponse.status).toBe(200);
    await expect(cancelResponse.json()).resolves.toMatchObject({
      businessItemOrder: {
        id: "order-2",
        status: "cancelled",
        cancelledAt: "2026-06-08T03:20:00.000Z",
      },
    });
    expect(calls).toEqual(["list", "fulfill:order-1", "cancel:order-2"]);
  });

  it("allows staff to list device states", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff device state route must not query player summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff device state route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff device state route must not list active sessions");
        },
        async listDeviceStates() {
          return [
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
              reportedAt: new Date("2026-06-07T10:05:00.000Z"),
              reportedBy: "agent-1",
            },
          ];
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff device state route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff device state route must not request player device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/device-states", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      deviceStates: [
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
          reportedAt: "2026-06-07T10:05:00.000Z",
          reportedBy: "agent-1",
        },
      ],
    });
  });

  it("allows staff to list machine websocket connections", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff machine connection route must not query player summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff machine connection route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff machine connection route must not list active sessions");
        },
        async listMachineConnections() {
          return [
            {
              machineId: "maimai-dx-1",
              status: "online",
              capabilities: ["coin", "aime.scan"],
              connectedAt: new Date("2026-06-07T10:00:00.000Z"),
              lastSeenAt: new Date("2026-06-07T10:05:00.000Z"),
              disconnectedAt: undefined,
            },
          ];
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff machine connection route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff machine connection route must not request player device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "machine-token",
      },
    });

    const response = await app.request("/rpc/staff/machine-connections", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      machineConnections: [
        {
          machineId: "maimai-dx-1",
          status: "online",
          capabilities: ["coin", "aime.scan"],
          connectedAt: "2026-06-07T10:00:00.000Z",
          lastSeenAt: "2026-06-07T10:05:00.000Z",
          disconnectedAt: null,
        },
      ],
    });
  });

  it("allows staff to read basic reports", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff reports route must not query player summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff reports route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff reports route must not list active sessions");
        },
        async getReportsSummary(input) {
          expect(input).toEqual({
            from: new Date("2026-06-07T00:00:00.000Z"),
            to: new Date("2026-06-08T00:00:00.000Z"),
          });
          return {
            from: new Date("2026-06-07T00:00:00.000Z"),
            to: new Date("2026-06-08T00:00:00.000Z"),
            revenueTotal: 120,
            sessionCount: 3,
            assetGrantTotal: 50,
            coinCommandCount: 7,
          };
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff reports route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff reports route must not request player device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request(
      "/rpc/staff/reports/summary?from=2026-06-07T00:00:00.000Z&to=2026-06-08T00:00:00.000Z",
      {
        headers: {
          Authorization: "Bearer staff-token",
        },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      summary: {
        from: "2026-06-07T00:00:00.000Z",
        to: "2026-06-08T00:00:00.000Z",
        revenueTotal: 120,
        sessionCount: 3,
        assetGrantTotal: 50,
        coinCommandCount: 7,
      },
    });
  });

  it("allows staff to read settlement report details", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff settlement report route must not query player summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff settlement report route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff settlement report route must not list active sessions");
        },
        async listReportSettlements(input) {
          expect(input).toEqual({
            from: new Date("2026-06-07T00:00:00.000Z"),
            to: new Date("2026-06-08T00:00:00.000Z"),
            limit: 2,
            offset: 10,
          });
          return [
            {
              settlementId: "settlement-1",
              sessionId: "session-1",
              playerId: "player-1",
              playerDisplayName: "Neri",
              startedAt: new Date("2026-06-07T10:00:00.000Z"),
              endedAt: new Date("2026-06-07T11:30:00.000Z"),
              settledAt: new Date("2026-06-07T11:30:00.000Z"),
              durationMinutes: 90,
              subtotal: centsOf(120),
              total: centsOf(100),
            },
            {
              settlementId: "settlement-2",
              sessionId: "session-2",
              playerId: "player-2",
              playerDisplayName: "Second",
              startedAt: new Date("2026-06-07T09:00:00.000Z"),
              endedAt: new Date("2026-06-07T10:00:00.000Z"),
              settledAt: new Date("2026-06-07T10:00:00.000Z"),
              durationMinutes: 60,
              subtotal: centsOf(80),
              total: centsOf(80),
            },
          ];
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff settlement report route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff settlement report route must not request player device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request(
      "/rpc/staff/reports/settlements?from=2026-06-07T00:00:00.000Z&to=2026-06-08T00:00:00.000Z&limit=1&offset=10",
      {
        headers: {
          Authorization: "Bearer staff-token",
        },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      settlements: [
        {
          settlementId: "settlement-1",
          sessionId: "session-1",
          playerId: "player-1",
          playerDisplayName: "Neri",
          startedAt: "2026-06-07T10:00:00.000Z",
          endedAt: "2026-06-07T11:30:00.000Z",
          settledAt: "2026-06-07T11:30:00.000Z",
          durationMinutes: 90,
          subtotal: centsOf(120),
          total: centsOf(100),
        },
      ],
      page: { limit: 1, offset: 10, hasMore: true },
    });
  });

  it("allows staff to read player report summaries", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff player report route must not query player summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff player report route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff player report route must not list active sessions");
        },
        async listReportPlayers(input) {
          expect(input).toEqual({
            from: new Date("2026-06-07T00:00:00.000Z"),
            to: new Date("2026-06-08T00:00:00.000Z"),
            limit: 21,
            offset: 0,
          });
          return [
            {
              playerId: "player-1",
              playerDisplayName: "Neri",
              settlementCount: 3,
              totalDurationMinutes: 150,
              revenueTotal: 320,
              lastSettledAt: new Date("2026-06-07T22:30:00.000Z"),
            },
          ];
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff player report route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff player report route must not request player device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request(
      "/rpc/staff/reports/players?from=2026-06-07T00:00:00.000Z&to=2026-06-08T00:00:00.000Z&limit=20",
      {
        headers: {
          Authorization: "Bearer staff-token",
        },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      players: [
        {
          playerId: "player-1",
          playerDisplayName: "Neri",
          settlementCount: 3,
          totalDurationMinutes: 150,
          revenueTotal: 320,
          lastSettledAt: "2026-06-07T22:30:00.000Z",
        },
      ],
      page: { limit: 20, offset: 0, hasMore: false },
    });
  });

  it("allows staff to list player management views", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          return [
            {
              id: "player-1",
              displayName: "Neri",
              status: "active",
              walletTotal: 100,
              activeSessionId: "session-1",
            },
            {
              id: "player-2",
              displayName: "Guest",
              status: "disabled",
              walletTotal: 0,
              activeSessionId: null,
            },
          ];
        },
        async listActiveSessions() {
          throw new Error("player list route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff route must not request player device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/players", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      players: [
        {
          id: "player-1",
          displayName: "Neri",
          status: "active",
          walletTotal: 100,
          activeSessionId: "session-1",
        },
        {
          id: "player-2",
          displayName: "Guest",
          status: "disabled",
          walletTotal: 0,
          activeSessionId: null,
        },
      ],
    });
  });

  it("allows staff to inspect a player's asset inventory and ledger", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff player asset route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff player asset route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff player asset route must not list active sessions");
        },
        async getPlayerAssets(playerId) {
          expect(playerId).toBe("player-1");
          return {
            holdings: [
              {
                id: "holding-1",
                assetType: "title",
                assetCode: "title.special",
                assetName: "Special title",
                quantity: centsOf(1),
                activeAt: null,
                expiresAt: null,
                metadata: {
                  rarity: "rare",
                },
              },
            ],
            ledgerEntries: [
              {
                id: "ledger-1",
                assetType: "title",
                assetCode: "title.special",
                assetName: "Special title",
                delta: centsOf(1),
                reason: "staff.asset.grant",
                refId: "staff-1",
                transactionId: null,
                createdAt: new Date("2026-06-07T10:05:00.000Z"),
              },
            ],
          };
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff player asset route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff player asset route must not request player device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/players/player-1/assets", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      holdings: [
        {
          id: "holding-1",
          assetType: "title",
          assetCode: "title.special",
          assetName: "Special title",
          quantity: centsOf(1),
          activeAt: null,
          expiresAt: null,
          metadata: {
            rarity: "rare",
          },
        },
      ],
      ledgerEntries: [
        {
          id: "ledger-1",
          assetType: "title",
          assetCode: "title.special",
          assetName: "Special title",
          delta: centsOf(1),
          reason: "staff.asset.grant",
          refId: "staff-1",
          transactionId: null,
          createdAt: "2026-06-07T10:05:00.000Z",
        },
      ],
    });
  });

  it("allows staff to inspect a player's session history", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff player session history route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff player session history route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff player session history route must not list active sessions");
        },
        async getPlayerSessionHistory(playerId) {
          expect(playerId).toBe("player-1");
          return [
            {
              sessionId: "session-1",
              startedAt: new Date("2026-06-07T10:00:00.000Z"),
              endedAt: new Date("2026-06-07T11:00:00.000Z"),
              durationMinutes: 60,
              subtotal: centsOf(20),
              total: centsOf(20),
              status: "settled",
              settledAt: new Date("2026-06-07T11:00:00.000Z"),
            },
          ];
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff player session history route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff player session history route must not request player device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/players/player-1/sessions/history", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      sessions: [
        {
          sessionId: "session-1",
          startedAt: "2026-06-07T10:00:00.000Z",
          endedAt: "2026-06-07T11:00:00.000Z",
          durationMinutes: 60,
          subtotal: centsOf(20),
          total: centsOf(20),
          status: "settled",
          settledAt: "2026-06-07T11:00:00.000Z",
        },
      ],
    });
  });

  it("allows staff to inspect a player's session history detail", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff player session history detail route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff player session history detail route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff player session history detail route must not list active sessions");
        },
        async getPlayerSessionHistoryDetail(playerId, sessionId) {
          expect(playerId).toBe("player-1");
          expect(sessionId).toBe("session-1");
          return {
            sessionId: "session-1",
            startedAt: new Date("2026-06-07T10:00:00.000Z"),
            endedAt: new Date("2026-06-07T11:00:00.000Z"),
            durationMinutes: 60,
            subtotal: centsOf(30),
            total: centsOf(20),
            status: "settled",
            settledAt: new Date("2026-06-07T11:00:00.000Z"),
            chargeItems: [
              {
                id: "charge-time",
                source: "time.default",
                label: "Base time",
                amount: 30,
              },
            ],
            adjustments: [
              {
                id: "adjustment-pass",
                source: "pass.monthly",
                label: "Monthly pass",
                amount: -10,
              },
            ],
          };
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff player session history detail route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff player session history detail route must not request player device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/players/player-1/sessions/session-1/history", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      session: {
        sessionId: "session-1",
        startedAt: "2026-06-07T10:00:00.000Z",
        endedAt: "2026-06-07T11:00:00.000Z",
        durationMinutes: 60,
        subtotal: centsOf(30),
        total: centsOf(20),
        status: "settled",
        settledAt: "2026-06-07T11:00:00.000Z",
        chargeItems: [
          {
            id: "charge-time",
            source: "time.default",
            label: "Base time",
            amount: 30,
          },
        ],
        adjustments: [
          {
            id: "adjustment-pass",
            source: "pass.monthly",
            label: "Monthly pass",
            amount: -10,
          },
        ],
      },
    });
  });

  it("allows staff to list active session management views", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("active sessions route must not list players");
        },
        async listActiveSessions() {
          return [
            {
              id: "session-1",
              playerId: "player-1",
              playerDisplayName: "Neri",
              startedAt: new Date("2026-06-07T10:00:00.000Z"),
              elapsedMinutes: 30,
            },
          ];
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff route must not request player device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/sessions/active", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      sessions: [
        {
          id: "session-1",
          playerId: "player-1",
          playerDisplayName: "Neri",
          startedAt: "2026-06-07T10:00:00.000Z",
          elapsedMinutes: 30,
          identities: [],
        },
      ],
    });
  });



  it("allows staff to request a facility power action", async () => {
    const calls: unknown[] = [];
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff device action route must not query player summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff device action route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff device action route must not list sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff device action route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff device action route must not use player command path");
        },
      },
      staffDeviceCommands: {
        async requestDeviceAction(input) {
          calls.push(input);
          return {
            id: "command-1",
            type: input.type,
            deviceId: input.target.kind === "facility"
              ? "switch.maimai"
              : ("id" in input.target ? input.target.id ?? "game-machine" : "game-machine"),
            targetKind: input.target.kind,
            executorKind: "home_assistant",
            staffId: input.staffId,
            status: "acked",
            payload: input.payload,
            requestedAt: new Date("2026-06-07T10:05:00.000Z"),
            ackedAt: new Date("2026-06-07T10:05:03.000Z"),
          };
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/device-actions", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "power.on",
        target: { kind: "facility", ref: "wacca" },
        payload: { state: "on" },
      }),
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        staffId: "staff",
        type: "power.on",
        target: { kind: "facility", ref: "wacca" },
        payload: { state: "on" },
      },
    ]);
    await expect(response.json()).resolves.toEqual({
      action: {
        id: "command-1",
        type: "power.on",
        deviceId: "switch.maimai",
        target: { kind: "facility", id: "switch.maimai" },
        executorKind: "home_assistant",
        staffId: "staff",
        status: "acked",
        payload: { state: "on" },
        requestedAt: "2026-06-07T10:05:00.000Z",
        ackedAt: "2026-06-07T10:05:03.000Z",
      },
    });
  });

  it("allows staff to list device command audit views", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff command audit route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff command audit route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff command audit route must not list active sessions");
        },
        async listDeviceCommands(input) {
          expect(input).toEqual({
            limit: 10,
          });
          return [
            {
              id: "command-1",
              type: "door.open",
              deviceId: "door-1",
              targetKind: "facility",
              executorKind: "home_assistant",
              playerId: "player-1",
              staffId: null,
              status: "acked",
              requestedAt: new Date("2026-06-07T10:05:00.000Z"),
              ackedAt: new Date("2026-06-07T10:05:03.000Z"),
              expiredAt: null,
              payload: null,
            },
          ];
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff command audit route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff command audit route must not request player device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/device-commands?limit=10", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      commands: [
        {
          id: "command-1",
          type: "door.open",
          deviceId: "door-1",
          target: {
            kind: "facility",
            id: "door-1",
          },
          executorKind: "home_assistant",
          playerId: "player-1",
          staffId: null,
          status: "acked",
          requestedAt: "2026-06-07T10:05:00.000Z",
          ackedAt: "2026-06-07T10:05:03.000Z",
          expiredAt: null,
          payload: null,
        },
      ],
    });
  });

  it("allows staff to create and list pricing configs", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff pricing route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff pricing route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff pricing route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff pricing route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff pricing route must not request player device commands");
        },
      },
      staffPricingCommands: {
        async createPricingConfig(input) {
          expect(input).toEqual({
            kind: "time.priority",
            name: "Default time pricing",
            enabled: true,
            provider: {
              id: "time.default",
              rules: [
                {
                  id: "base",
                  label: "Base",
                  priority: 0,
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
          });
          if (!("rules" in input.provider)) {
            throw new Error("time pricing route must pass time rules");
          }
          return {
            id: "pricing-1",
            kind: "time.priority",
            name: "Default time pricing",
            enabled: true,
            status: "active",
            provider: input.provider as Extract<PricingConfig, { kind: "time.priority" }>["provider"],
            createdAt: new Date("2026-06-07T10:00:00.000Z"),
            updatedAt: new Date("2026-06-07T10:00:00.000Z"),
          };
        },
        async updatePricingConfig() {
          throw new Error("staff pricing create/list route must not update pricing configs");
        },
        async listPricingConfigs() {
          return [
            {
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
          ];
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const createResponse = await app.request("/rpc/staff/pricing-configs", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        kind: "time.priority",
        name: "Default time pricing",
        enabled: true,
        provider: {
          id: "time.default",
          rules: [
            {
              id: "base",
              label: "Base",
              priority: 0,
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
      }),
    });
    expect(createResponse.status).toBe(200);
    await expect(createResponse.json()).resolves.toEqual({
      pricingConfig: {
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
        createdAt: "2026-06-07T10:00:00.000Z",
        updatedAt: "2026-06-07T10:00:00.000Z",
      },
    });

    const listResponse = await app.request("/rpc/staff/pricing-configs", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({
      pricingConfigs: [
        {
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
          createdAt: "2026-06-07T10:00:00.000Z",
          updatedAt: "2026-06-07T10:00:00.000Z",
        },
      ],
    });
  });

  it("allows staff to create and list fixed charge pricing configs", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("fixed pricing route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("fixed pricing route must not list players");
        },
        async listActiveSessions() {
          throw new Error("fixed pricing route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("fixed pricing route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("fixed pricing route must not request player device commands");
        },
      },
      staffPricingCommands: {
        async createPricingConfig(input) {
          expect(input).toEqual({
            kind: "charge.fixed",
            name: "入场票",
            enabled: true,
            provider: {
              id: "fixed.entry-ticket",
              label: "入场票",
              amount: 35,
            },
          });
          if (!("amount" in input.provider)) {
            throw new Error("fixed pricing route must pass a fixed amount");
          }
          return {
            id: "pricing-fixed-1",
            kind: "charge.fixed",
            name: "入场票",
            enabled: true,
            status: "active",
            provider: input.provider as Extract<PricingConfig, { kind: "charge.fixed" }>["provider"],
            createdAt: new Date("2026-06-07T10:00:00.000Z"),
            updatedAt: new Date("2026-06-07T10:00:00.000Z"),
          };
        },
        async updatePricingConfig() {
          throw new Error("fixed pricing route must not update pricing configs");
        },
        async listPricingConfigs() {
          return [
            {
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
            },
          ];
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const createResponse = await app.request("/rpc/staff/pricing-configs", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        kind: "charge.fixed",
        name: "入场票",
        enabled: true,
        provider: {
          id: "fixed.entry-ticket",
          label: "入场票",
          amount: 35,
        },
      }),
    });
    expect(createResponse.status).toBe(200);
    await expect(createResponse.json()).resolves.toEqual({
      pricingConfig: {
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
        createdAt: "2026-06-07T10:00:00.000Z",
        updatedAt: "2026-06-07T10:00:00.000Z",
      },
    });

    const listResponse = await app.request("/rpc/staff/pricing-configs", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({
      pricingConfigs: [
        {
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
          createdAt: "2026-06-07T10:00:00.000Z",
          updatedAt: "2026-06-07T10:00:00.000Z",
        },
      ],
    });
  });

  it("allows staff to inspect deployed pricing extensions without editing raw plugin config", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("pricing extension catalog must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("pricing extension catalog must not list players");
        },
        async listActiveSessions() {
          throw new Error("pricing extension catalog must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("pricing extension catalog must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("pricing extension catalog must not request player device commands");
        },
      },
      staffPricingExtensions: [
        {
          id: "plugin.reservation",
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
          ],
        },
      ],
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/pricing-extensions", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      pricingExtensions: [
        {
          id: "plugin.reservation",
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
          ],
        },
      ],
    });
  });

  it("allows staff to create complex time pricing scopes without raw provider JSON UI", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("complex pricing route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("complex pricing route must not list players");
        },
        async listActiveSessions() {
          throw new Error("complex pricing route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("complex pricing route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("complex pricing route must not request player device commands");
        },
      },
      staffPricingCommands: {
        async createPricingConfig(input) {
          expect(input).toEqual({
            kind: "time.priority",
            name: "复杂区间",
            enabled: true,
            provider: {
              id: "time.complex",
              rules: [
                {
                  id: "fallback",
                  label: "全天",
                  priority: 0,
                  timeRange: { start: "00:00", end: "00:00" },
                  pricing: { unitMinutes: 30, unitPrice: 10, roundGraceMinutes: 0, priceCap: 100 },
                },
                {
                  id: "weekend",
                  label: "周末高峰",
                  priority: 10,
                  weekdays: [0, 6],
                  timeRange: { start: "14:00", end: "18:00" },
                  pricing: { unitMinutes: 30, unitPrice: 20, roundGraceMinutes: 0, priceCap: 160 },
                },
                {
                  id: "event-day",
                  label: "活动日",
                  priority: 20,
                  specificDates: ["2026-06-08"],
                  timeRange: { start: "18:00", end: "22:00" },
                  pricing: { unitMinutes: 30, unitPrice: 30, roundGraceMinutes: 0, priceCap: 200 },
                },
                {
                  id: "absolute",
                  label: "限时活动",
                  priority: 30,
                  dateTimeRange: {
                    start: new Date("2026-06-08T09:00:00.000Z"),
                    end: new Date("2026-06-08T11:00:00.000Z"),
                  },
                  pricing: { unitMinutes: 30, unitPrice: 40, roundGraceMinutes: 0, priceCap: 240 },
                },
              ],
            },
          });
          if (!("rules" in input.provider)) {
            throw new Error("complex pricing route must pass time rules");
          }
          return {
            id: "pricing-complex-1",
            kind: "time.priority",
            name: "复杂区间",
            enabled: true,
            status: "active",
            provider: input.provider as Extract<PricingConfig, { kind: "time.priority" }>["provider"],
            createdAt: new Date("2026-06-07T10:00:00.000Z"),
            updatedAt: new Date("2026-06-07T10:00:00.000Z"),
          };
        },
        async updatePricingConfig() {
          throw new Error("complex pricing route must not update pricing configs");
        },
        async listPricingConfigs() {
          throw new Error("complex pricing route must not list pricing configs");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/pricing-configs", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        kind: "time.priority",
        name: "复杂区间",
        enabled: true,
        provider: {
          id: "time.complex",
          rules: [
            {
              id: "fallback",
              label: "全天",
              priority: 0,
              timeRange: { start: "00:00", end: "00:00" },
              pricing: { unitMinutes: 30, unitPrice: 10, roundGraceMinutes: 0, priceCap: 100 },
            },
            {
              id: "weekend",
              label: "周末高峰",
              priority: 10,
              weekdays: [0, 6],
              timeRange: { start: "14:00", end: "18:00" },
              pricing: { unitMinutes: 30, unitPrice: 20, roundGraceMinutes: 0, priceCap: 160 },
            },
            {
              id: "event-day",
              label: "活动日",
              priority: 20,
              specificDates: ["2026-06-08"],
              timeRange: { start: "18:00", end: "22:00" },
              pricing: { unitMinutes: 30, unitPrice: 30, roundGraceMinutes: 0, priceCap: 200 },
            },
            {
              id: "absolute",
              label: "限时活动",
              priority: 30,
              dateTimeRange: {
                start: "2026-06-08T09:00:00.000Z",
                end: "2026-06-08T11:00:00.000Z",
              },
              pricing: { unitMinutes: 30, unitPrice: 40, roundGraceMinutes: 0, priceCap: 240 },
            },
          ],
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      pricingConfig: {
        id: "pricing-complex-1",
        provider: {
          rules: [
            { id: "fallback" },
            { id: "weekend", weekdays: [0, 6] },
            { id: "event-day", specificDates: ["2026-06-08"] },
            {
              id: "absolute",
              dateTimeRange: {
                start: "2026-06-08T09:00:00.000Z",
                end: "2026-06-08T11:00:00.000Z",
              },
            },
          ],
        },
      },
    });
  });

  it("allows staff to update pricing configs", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff pricing update route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff pricing update route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff pricing update route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff pricing update route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff pricing update route must not request player device commands");
        },
      },
      staffPricingCommands: {
        async createPricingConfig() {
          throw new Error("staff pricing update route must not create pricing configs");
        },
        async updatePricingConfig(input) {
          expect(input).toEqual({
            pricingConfigId: "pricing-1",
            name: "Disabled time pricing",
            enabled: false,
            provider: {
              id: "time.default",
              rules: [
                {
                  id: "base",
                  label: "Base disabled",
                  priority: 0,
                  timeRange: {
                    start: "00:00",
                    end: "00:00",
                  },
                  pricing: {
                    unitMinutes: 60,
                    unitPrice: 20,
                    roundGraceMinutes: 0,
                    priceCap: 120,
                  },
                },
              ],
            },
          });
          if (!("rules" in input.provider)) {
            throw new Error("staff pricing update route must pass time rules");
          }
          return {
            id: "pricing-1",
            kind: "time.priority",
            name: "Disabled time pricing",
            enabled: false,
            status: "active",
            provider: input.provider as Extract<PricingConfig, { kind: "time.priority" }>["provider"],
            createdAt: new Date("2026-06-07T10:00:00.000Z"),
            updatedAt: new Date("2026-06-07T12:00:00.000Z"),
          };
        },
        async listPricingConfigs() {
          throw new Error("staff pricing update route must not list pricing configs");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/pricing-configs/pricing-1", {
      method: "PATCH",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Disabled time pricing",
        enabled: false,
        provider: {
          id: "time.default",
          rules: [
            {
              id: "base",
              label: "Base disabled",
              priority: 0,
              timeRange: {
                start: "00:00",
                end: "00:00",
              },
              pricing: {
                unitMinutes: 60,
                unitPrice: 20,
                roundGraceMinutes: 0,
                priceCap: 120,
              },
            },
          ],
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      pricingConfig: {
        id: "pricing-1",
        kind: "time.priority",
        name: "Disabled time pricing",
        enabled: false,
        status: "active",
        provider: {
          id: "time.default",
          rules: [
            {
              id: "base",
              label: "Base disabled",
              priority: 0,
              timeRange: {
                start: "00:00",
                end: "00:00",
              },
              pricing: {
                unitMinutes: 60,
                unitPrice: 20,
                roundGraceMinutes: 0,
                priceCap: 120,
              },
            },
          ],
        },
        createdAt: "2026-06-07T10:00:00.000Z",
        updatedAt: "2026-06-07T12:00:00.000Z",
      },
    });
  });

  it("allows staff to archive pricing configs without deleting them", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff pricing archive route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff pricing archive route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff pricing archive route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff pricing archive route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff pricing archive route must not request player device commands");
        },
      },
      staffPricingCommands: {
        async createPricingConfig() {
          throw new Error("staff pricing archive route must not create pricing configs");
        },
        async updatePricingConfig() {
          throw new Error("staff pricing archive route must not update pricing configs");
        },
        async archivePricingConfig(input) {
          expect(input).toEqual({
            pricingConfigId: "pricing-1",
          });
          return {
            id: "pricing-1",
            kind: "time.priority",
            name: "Default time pricing",
            enabled: false,
            status: "archived",
            provider: {
              id: "time.default",
              rules: [
                {
                  id: "base",
                  label: "Base",
                  priority: 0,
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
            updatedAt: new Date("2026-06-07T12:00:00.000Z"),
          };
        },
        async restorePricingConfig(input) {
          expect(input).toEqual({
            pricingConfigId: "pricing-1",
          });
          return {
            id: "pricing-1",
            kind: "time.priority",
            name: "Default time pricing",
            enabled: false,
            status: "active",
            provider: {
              id: "time.default",
              rules: [
                {
                  id: "base",
                  label: "Base",
                  priority: 0,
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
            updatedAt: new Date("2026-06-07T12:30:00.000Z"),
          };
        },
        async listPricingConfigs() {
          throw new Error("staff pricing archive route must not list pricing configs");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/pricing-configs/pricing-1/archive", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      pricingConfig: {
        id: "pricing-1",
        kind: "time.priority",
        name: "Default time pricing",
        enabled: false,
        status: "archived",
        provider: {
          id: "time.default",
          rules: [
            {
              id: "base",
              label: "Base",
              priority: 0,
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
        createdAt: "2026-06-07T10:00:00.000Z",
        updatedAt: "2026-06-07T12:00:00.000Z",
      },
    });

    const restoreResponse = await app.request("/rpc/staff/pricing-configs/pricing-1/restore", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(restoreResponse.status).toBe(200);
    await expect(restoreResponse.json()).resolves.toEqual({
      pricingConfig: {
        id: "pricing-1",
        kind: "time.priority",
        name: "Default time pricing",
        enabled: false,
        status: "active",
        provider: {
          id: "time.default",
          rules: [
            {
              id: "base",
              label: "Base",
              priority: 0,
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
        createdAt: "2026-06-07T10:00:00.000Z",
        updatedAt: "2026-06-07T12:30:00.000Z",
      },
    });
  });

  it("returns a structured error when staff saves a pricing config with no active billable rules", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("invalid pricing route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("invalid pricing route must not list players");
        },
        async listActiveSessions() {
          throw new Error("invalid pricing route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("invalid pricing route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("invalid pricing route must not request player device commands");
        },
      },
      staffPricingCommands: {
        async createPricingConfig(input) {
          expect(input).toEqual({
            kind: "time.priority",
            name: "Broken time pricing",
            enabled: true,
            provider: {
              id: "time.broken",
              rules: [
                {
                  id: "archived-business-hours",
                  label: "Archived business hours",
                  priority: 10,
                  status: "archived",
                  timeRange: {
                    start: "10:00",
                    end: "22:00",
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
          });
          throw new PrismDomainError(
            "Enabled time priority pricing config requires at least one active time rule.",
            "PRICING_CONFIG_REQUIRES_ACTIVE_TIME_RULE",
          );
        },
        async updatePricingConfig() {
          throw new Error("invalid pricing route must not update pricing configs");
        },
        async listPricingConfigs() {
          throw new Error("invalid pricing route must not list pricing configs");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/pricing-configs", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        kind: "time.priority",
        name: "Broken time pricing",
        enabled: true,
        provider: {
          id: "time.broken",
          rules: [
            {
              id: "archived-business-hours",
              label: "Archived business hours",
              priority: 10,
              status: "archived",
              timeRange: {
                start: "10:00",
                end: "22:00",
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
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "PRICING_CONFIG_REQUIRES_ACTIVE_TIME_RULE",
        message: "Enabled time priority pricing config requires at least one active time rule.",
      },
    });
  });

  it("allows staff to save and list asset definitions", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff asset definition route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff asset definition route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff asset definition route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff asset definition route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff asset definition route must not request player device commands");
        },
      },
      staffAssetDefinitionCommands: {
        async saveAssetDefinition(input) {
          expect(input).toEqual({
            type: "pass",
            code: "pass.monthly",
            name: "Monthly pass",
            stackable: false,
            pricingEffectId: null,
            activeAt: null,
            expiresAt: null,
            metadata: {
              settlementEffect: "time.free",
            },
          });
          return {
            ...input,
            status: "active",
          };
        },
        async archiveAssetDefinition(input) {
          expect(input).toEqual({
            type: "pass",
            code: "pass.monthly",
          });
          return {
            type: "pass",
            code: "pass.monthly",
            name: "Monthly pass",
            stackable: false,
            status: "archived",
            metadata: {
              settlementEffect: "time.free",
            },
          };
        },
        async restoreAssetDefinition(input) {
          expect(input).toEqual({
            type: "pass",
            code: "pass.monthly",
          });
          return {
            type: "pass",
            code: "pass.monthly",
            name: "Monthly pass",
            stackable: false,
            status: "active",
            metadata: {
              settlementEffect: "time.free",
            },
          };
        },
        async listAssetDefinitions() {
          return [
            {
              type: "pass",
              code: "pass.monthly",
              name: "Monthly pass",
              stackable: false,
              status: "active",
              metadata: {
                settlementEffect: "time.free",
              },
            },
          ];
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const saveResponse = await app.request("/rpc/staff/asset-definitions/pass/pass.monthly", {
      method: "PUT",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Monthly pass",
        stackable: false,
        metadata: {
          settlementEffect: "time.free",
        },
      }),
    });
    expect(saveResponse.status).toBe(200);
    await expect(saveResponse.json()).resolves.toEqual({
      assetDefinition: {
        type: "pass",
        code: "pass.monthly",
        name: "Monthly pass",
        stackable: false,
        status: "active",
        pricingEffectId: null,
        pricingEffect: null,
        activeAt: null,
        expiresAt: null,
        metadata: {
          settlementEffect: "time.free",
        },
      },
    });

    const listResponse = await app.request("/rpc/staff/asset-definitions", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({
      assetDefinitions: [
        {
          type: "pass",
          code: "pass.monthly",
          name: "Monthly pass",
          stackable: false,
          status: "active",
          pricingEffectId: null,
          pricingEffect: null,
          activeAt: null,
          expiresAt: null,
          metadata: {
            settlementEffect: "time.free",
          },
        },
      ],
    });

    const archiveResponse = await app.request("/rpc/staff/asset-definitions/pass/pass.monthly/archive", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(archiveResponse.status).toBe(200);
    await expect(archiveResponse.json()).resolves.toEqual({
      assetDefinition: {
        type: "pass",
        code: "pass.monthly",
        name: "Monthly pass",
        stackable: false,
        status: "archived",
        pricingEffectId: null,
        pricingEffect: null,
        activeAt: null,
        expiresAt: null,
        metadata: {
          settlementEffect: "time.free",
        },
      },
    });

    const restoreResponse = await app.request("/rpc/staff/asset-definitions/pass/pass.monthly/restore", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(restoreResponse.status).toBe(200);
    await expect(restoreResponse.json()).resolves.toEqual({
      assetDefinition: {
        type: "pass",
        code: "pass.monthly",
        name: "Monthly pass",
        stackable: false,
        status: "active",
        pricingEffectId: null,
        pricingEffect: null,
        activeAt: null,
        expiresAt: null,
        metadata: {
          settlementEffect: "time.free",
        },
      },
    });
  });

  it("allows staff to create, list, archive, and restore store business items", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("business item route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("business item route must not list players");
        },
        async listActiveSessions() {
          throw new Error("business item route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("business item route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("business item route must not request player device commands");
        },
      },
      staffBusinessItemCommands: {
        async createBusinessItem(input) {
          expect(input).toEqual({
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
          return {
            id: "business-item-1",
            ...input,
            status: "active",
            createdAt: new Date("2026-06-07T10:00:00.000Z"),
            updatedAt: new Date("2026-06-07T10:00:00.000Z"),
          };
        },
        async listBusinessItems() {
          return [
            {
              id: "business-item-1",
              kind: "event.entry",
              name: "周末挑战赛报名",
              status: "active",
              price: 1200,
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
          ];
        },
        async archiveBusinessItem(input) {
          expect(input).toEqual({
            businessItemId: "business-item-1",
          });
          return {
            id: "business-item-1",
            kind: "event.entry",
            name: "周末挑战赛报名",
            status: "archived",
            price: 1200,
            assetType: "ticket",
            assetCode: "event.weekend",
            activeAt: new Date("2026-06-08T01:00:00.000Z"),
            expiresAt: new Date("2026-06-09T01:00:00.000Z"),
            metadata: {
              capacity: 24,
              channel: "店内现场",
            },
            createdAt: new Date("2026-06-07T10:00:00.000Z"),
            updatedAt: new Date("2026-06-07T11:00:00.000Z"),
          };
        },
        async restoreBusinessItem(input) {
          expect(input).toEqual({
            businessItemId: "business-item-1",
          });
          return {
            id: "business-item-1",
            kind: "event.entry",
            name: "周末挑战赛报名",
            status: "active",
            price: 1200,
            assetType: "ticket",
            assetCode: "event.weekend",
            activeAt: new Date("2026-06-08T01:00:00.000Z"),
            expiresAt: new Date("2026-06-09T01:00:00.000Z"),
            metadata: {
              capacity: 24,
              channel: "店内现场",
            },
            createdAt: new Date("2026-06-07T10:00:00.000Z"),
            updatedAt: new Date("2026-06-07T12:00:00.000Z"),
          };
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const createResponse = await app.request("/rpc/staff/business-items", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        kind: "event.entry",
        name: "周末挑战赛报名",
        price: 1200,
        assetType: "ticket",
        assetCode: "event.weekend",
        activeAt: "2026-06-08T01:00:00.000Z",
        expiresAt: "2026-06-09T01:00:00.000Z",
        metadata: {
          capacity: 24,
          channel: "店内现场",
        },
      }),
    });
    expect(createResponse.status).toBe(200);
    await expect(createResponse.json()).resolves.toEqual({
      businessItem: {
        id: "business-item-1",
        kind: "event.entry",
        name: "周末挑战赛报名",
        status: "active",
        price: 1200,
        assetType: "ticket",
        assetCode: "event.weekend",
        activeAt: "2026-06-08T01:00:00.000Z",
        expiresAt: "2026-06-09T01:00:00.000Z",
        metadata: {
          capacity: 24,
          channel: "店内现场",
        },
        createdAt: "2026-06-07T10:00:00.000Z",
        updatedAt: "2026-06-07T10:00:00.000Z",
      },
    });

    const listResponse = await app.request("/rpc/staff/business-items", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({
      businessItems: [
        {
          id: "business-item-1",
          kind: "event.entry",
          name: "周末挑战赛报名",
          status: "active",
          price: 1200,
          assetType: "ticket",
          assetCode: "event.weekend",
          activeAt: "2026-06-08T01:00:00.000Z",
          expiresAt: "2026-06-09T01:00:00.000Z",
          metadata: {
            capacity: 24,
            channel: "店内现场",
          },
          createdAt: "2026-06-07T10:00:00.000Z",
          updatedAt: "2026-06-07T10:00:00.000Z",
        },
      ],
    });

    const archiveResponse = await app.request("/rpc/staff/business-items/business-item-1/archive", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(archiveResponse.status).toBe(200);
    await expect(archiveResponse.json()).resolves.toMatchObject({
      businessItem: {
        id: "business-item-1",
        status: "archived",
        updatedAt: "2026-06-07T11:00:00.000Z",
      },
    });

    const restoreResponse = await app.request("/rpc/staff/business-items/business-item-1/restore", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(restoreResponse.status).toBe(200);
    await expect(restoreResponse.json()).resolves.toMatchObject({
      businessItem: {
        id: "business-item-1",
        status: "active",
        updatedAt: "2026-06-07T12:00:00.000Z",
      },
    });
  });

  it("rejects staff routes without a staff principal", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("forbidden staff route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("forbidden staff route must not list players");
        },
        async listActiveSessions() {
          throw new Error("forbidden staff route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("forbidden staff route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("forbidden staff route must not request device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/players", {
      headers: {
        Authorization: "Bearer player-session-token",
        "X-PRiSM-Player-Id": "player-1",
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Staff principal required.",
      },
    });
  });

  it("enforces staff role permissions for read and write routes", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff role route must not query player summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          return [];
        },
        async listActiveSessions() {
          return [];
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff role route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff role route must not request player device commands");
        },
      },
      staffPlayerCommands: {
        async createPlayer() {
          return {
            id: "player-1",
            displayName: "Neri",
            status: "active",
            createdAt: new Date("2026-06-07T10:00:00.000Z"),
          };
        },
        async updatePlayerStatus() {
          throw new Error("staff role route must not update player status");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "owner-token",
        integration: "bot-token",
        machine: "agent-token",
      },
      staffTokens: [
        {
          token: "viewer-token",
          staffId: "viewer-1",
          role: "viewer",
        },
        {
          token: "manager-token",
          staffId: "manager-1",
          role: "manager",
        },
      ],
    });

    const readResponse = await app.request("/rpc/staff/players", {
      headers: {
        Authorization: "Bearer viewer-token",
      },
    });
    expect(readResponse.status).toBe(200);

    const deniedWriteResponse = await app.request("/rpc/staff/players", {
      method: "POST",
      headers: {
        Authorization: "Bearer viewer-token",
      },
      body: JSON.stringify({
        displayName: "Blocked",
      }),
    });
    expect(deniedWriteResponse.status).toBe(403);
    await expect(deniedWriteResponse.json()).resolves.toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Staff role manager or owner required.",
      },
    });

    const allowedWriteResponse = await app.request("/rpc/staff/players", {
      method: "POST",
      headers: {
        Authorization: "Bearer manager-token",
      },
      body: JSON.stringify({
        displayName: "Neri",
      }),
    });
    expect(allowedWriteResponse.status).toBe(200);
  });

  it("allows staff to grant assets to a player", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff grant route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff grant route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff grant route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff grant route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff grant route must not request player device commands");
        },
      },
      staffAssetCommands: {
        async grantAssets(input) {
          expect(input).toEqual({
            staffId: "staff-1",
            playerId: "player-1",
            reason: "现场赠送",
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
          });
          return {
            holdings: [
              {
                id: "holding-1",
                assetType: "currency",
                assetCode: "currency.paid",
                quantity: centsOf(150),
                activeAt: null,
                expiresAt: null,
              },
            ],
            assetLedgerEntries: [
              {
                assetType: "currency",
                assetCode: "currency.paid",
                delta: centsOf(50),
                reason: "staff.asset.grant",
                refId: "staff-1",
              },
            ],
          };
        },
        async adjustAssets() {
          throw new Error("staff grant route must not adjust assets");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
      staffTokens: [
        {
          token: "staff-1-token",
          staffId: "staff-1",
          role: "manager",
        },
      ],
    });

    const response = await app.request("/rpc/staff/players/player-1/assets/grants", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-1-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        reason: "现场赠送",
        grants: [
          {
            assetType: "currency",
            assetCode: "currency.paid",
            amount: 50,
            activeAt: null,
            expiresAt: null,
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      holdings: [
        {
          id: "holding-1",
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: centsOf(150),
          activeAt: null,
          expiresAt: null,
        },
      ],
      assetLedgerEntries: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          delta: centsOf(50),
          reason: "staff.asset.grant",
          refId: "staff-1",
        },
      ],
    });
  });

  it("allows staff to adjust player assets", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff asset adjustment route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff asset adjustment route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff asset adjustment route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff asset adjustment route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff asset adjustment route must not request player device commands");
        },
      },
      staffAssetCommands: {
        async grantAssets() {
          throw new Error("staff asset adjustment route must not grant assets");
        },
        async adjustAssets(input) {
          expect(input).toEqual({
            staffId: "staff-1",
            playerId: "player-1",
            adjustments: [
              {
                assetType: "currency",
                assetCode: "currency.paid",
                quantityDelta: -30,
                activeAt: null,
                expiresAt: null,
                reason: "staff.asset.deduct",
              },
            ],
          });
          return {
            holdings: [
              {
                id: "holding-1",
                assetType: "currency",
                assetCode: "currency.paid",
                quantity: centsOf(70),
                activeAt: null,
                expiresAt: null,
              },
            ],
            assetLedgerEntries: [
              {
                assetType: "currency",
                assetCode: "currency.paid",
                delta: centsOf(-30),
                reason: "staff.asset.deduct",
                refId: "staff-1",
              },
            ],
          };
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
      staffTokens: [
        {
          token: "staff-1-token",
          staffId: "staff-1",
          role: "manager",
        },
      ],
    });

    const response = await app.request("/rpc/staff/players/player-1/assets/adjustments", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-1-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        adjustments: [
          {
            assetType: "currency",
            assetCode: "currency.paid",
            quantityDelta: -30,
            activeAt: null,
            expiresAt: null,
            reason: "staff.asset.deduct",
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      holdings: [
        {
          id: "holding-1",
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: centsOf(70),
          activeAt: null,
          expiresAt: null,
        },
      ],
      assetLedgerEntries: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          delta: centsOf(-30),
          reason: "staff.asset.deduct",
          refId: "staff-1",
        },
      ],
    });
  });

  it("allows staff to create and update players", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff player write route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff player write route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff player write route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff player write route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff player write route must not request player device commands");
        },
      },
      staffPlayerCommands: {
        async createPlayer(input) {
          expect(input).toEqual({
            displayName: "Neri",
          });
          return {
            id: "player-1",
            displayName: "Neri",
            status: "active",
            createdAt: new Date("2026-06-07T10:00:00.000Z"),
          };
        },
        async updatePlayerStatus(input) {
          expect(input).toEqual({
            playerId: "player-1",
            status: "banned",
          });
          return {
            id: "player-1",
            displayName: "Neri",
            status: "banned",
            createdAt: new Date("2026-06-07T10:00:00.000Z"),
          };
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const createResponse = await app.request("/rpc/staff/players", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        displayName: "Neri",
      }),
    });
    expect(createResponse.status).toBe(200);
    await expect(createResponse.json()).resolves.toEqual({
      player: {
        id: "player-1",
        displayName: "Neri",
        status: "active",
        createdAt: "2026-06-07T10:00:00.000Z",
      },
    });

    const statusResponse = await app.request("/rpc/staff/players/player-1/status", {
      method: "PATCH",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: "banned",
      }),
    });
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toEqual({
      player: {
        id: "player-1",
        displayName: "Neri",
        status: "banned",
        createdAt: "2026-06-07T10:00:00.000Z",
      },
    });
  });

  it("passes register-time gift grants when staff creates a player", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff player initial grant route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff player initial grant route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff player initial grant route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff player initial grant route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff player initial grant route must not request player device commands");
        },
      },
      staffPlayerCommands: {
        async createPlayer(input) {
          expect(input).toEqual({
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
          });
          return {
            id: "player-2",
            displayName: "Guest",
            status: "active",
            createdAt: new Date("2026-06-07T10:00:00.000Z"),
          };
        },
        async updatePlayerStatus() {
          throw new Error("staff player initial grant route must not update player status");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/players", {
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

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      player: {
        id: "player-2",
        displayName: "Guest",
        status: "active",
        createdAt: "2026-06-07T10:00:00.000Z",
      },
    });
  });

  it("allows staff to bind and integration token to resolve external player identities", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("identity routes must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("identity routes must not list players");
        },
        async listActiveSessions() {
          throw new Error("identity routes must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("identity routes must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("identity routes must not request device commands");
        },
      },
      staffPlayerCommands: {
        async createPlayer() {
          throw new Error("identity routes must not create players");
        },
        async updatePlayerStatus() {
          throw new Error("identity routes must not update player status");
        },
        async bindPlayerIdentity(input) {
          expect(input).toEqual({
            playerId: "player-1",
            provider: "qq",
            subject: "10001",
          });
          return {
            playerId: "player-1",
            provider: "qq",
            subject: "10001",
            createdAt: new Date("2026-06-07T10:05:00.000Z"),
          };
        },
        async deletePlayerIdentity(input) {
          expect(input).toEqual({
            playerId: "player-1",
            provider: "qq",
            subject: "10001",
          });
        },
        async resolvePlayerIdentity(input) {
          expect(input).toEqual({
            provider: "qq",
            subject: "10001",
          });
          return {
            id: "player-1",
            displayName: "Neri",
            status: "active",
            createdAt: new Date("2026-06-07T10:00:00.000Z"),
          };
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const bindResponse = await app.request("/rpc/staff/players/player-1/identities", {
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
    expect(bindResponse.status).toBe(200);
    await expect(bindResponse.json()).resolves.toEqual({
      identity: {
        playerId: "player-1",
        provider: "qq",
        subject: "10001",
        createdAt: "2026-06-07T10:05:00.000Z",
      },
    });

    const deleteResponse = await app.request("/rpc/staff/players/player-1/identities/qq/10001", {
      method: "DELETE",
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({ ok: true });

    const resolveResponse = await app.request("/rpc/bot/identities/resolve", {
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
    expect(resolveResponse.status).toBe(200);
    await expect(resolveResponse.json()).resolves.toEqual({
      player: {
        id: "player-1",
        displayName: "Neri",
        status: "active",
        createdAt: "2026-06-07T10:00:00.000Z",
      },
    });
  });

  it("allows integration tokens to run player actions by external identity", async () => {
    const calls: unknown[] = [];
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("integration route must use integration commands");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("integration route must not list staff players");
        },
        async listActiveSessions() {
          throw new Error("integration route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("integration route must not call player commands directly");
        },
        async requestDeviceCommand() {
          throw new Error("integration route must not request device commands directly");
        },
      },
      integrationCommands: {
        async startSessionByIdentity(input: unknown) {
          calls.push(input);
          return {
            id: "session-1",
            playerId: "player-1",
            startedAt: new Date("2026-07-07T10:30:00.000Z"),
            status: "active",
            pricingConfigIds: ["music"],
            paymentStatus: "unpaid",
            label: "音游区间",
          };
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    } as any);

    const response = await app.request("/rpc/integration/players/by-identity/session/start", {
      method: "POST",
      headers: {
        Authorization: "Bearer bot-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        identityKey: "QQ:123456",
        autoRegister: true,
        displayName: "QQ 123456",
        pricingConfigIds: ["music"],
        label: "音游区间",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      session: {
        id: "session-1",
        playerId: "player-1",
        startedAt: "2026-07-07T10:30:00.000Z",
        status: "active",
        label: "音游区间",
      },
    });
    expect(calls).toEqual([
      {
        identityKey: "QQ:123456",
        autoRegister: true,
        displayName: "QQ 123456",
        pricingConfigIds: ["music"],
        label: "音游区间",
      },
    ]);

    for (const token of ["player-token", "agent-token", undefined]) {
      const forbiddenResponse = await app.request("/rpc/integration/players/by-identity/session/start", {
        method: "POST",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ identityKey: "QQ:123456" }),
      });
      expect(forbiddenResponse.status).toBe(403);
    }
  });

  it("returns not found when integration identity is missing and auto register is off", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("integration route must use integration commands");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("integration route must not list staff players");
        },
        async listActiveSessions() {
          throw new Error("integration route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("integration route must not call player commands directly");
        },
        async requestDeviceCommand() {
          throw new Error("integration route must not request device commands directly");
        },
      },
      integrationCommands: {
        async startSessionByIdentity() {
          throw new PrismDomainError("Player identity was not found.", "PLAYER_IDENTITY_NOT_FOUND");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    } as any);

    const response = await app.request("/rpc/integration/players/by-identity/session/start", {
      method: "POST",
      headers: {
        Authorization: "Bearer bot-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ identityKey: "QQ:missing" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "PLAYER_IDENTITY_NOT_FOUND",
        message: "Player identity was not found.",
      },
    });
  });

  it("returns a JSON business error when integration checkout has insufficient balance", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("integration checkout route must use integration commands");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("integration checkout route must not list staff players");
        },
        async listActiveSessions() {
          throw new Error("integration checkout route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("integration checkout route must not call player commands directly");
        },
        async requestDeviceCommand() {
          throw new Error("integration checkout route must not request device commands directly");
        },
      },
      integrationCommands: {
        async confirmCheckoutByIdentity() {
          throw new PrismDomainError("Insufficient currency holdings for this operation.", "INSUFFICIENT_BALANCE");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    } as any);

    const response = await app.request("/rpc/integration/players/by-identity/checkout/confirm", {
      method: "POST",
      headers: {
        Authorization: "Bearer bot-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        identity: {
          provider: "qq",
          subject: "123456",
        },
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INSUFFICIENT_BALANCE",
        message: "Insufficient currency holdings for this operation.",
      },
    });
  });

  it("allows integration tokens to request device actions by external identity", async () => {
    const calls: unknown[] = [];
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("integration route must use integration commands");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("integration route must not list staff players");
        },
        async listActiveSessions() {
          throw new Error("integration route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("integration route must not call player commands directly");
        },
        async requestDeviceCommand() {
          throw new Error("integration route must not request device commands directly");
        },
      },
      integrationCommands: {
        async requestDeviceActionByIdentity(input: unknown) {
          calls.push(input);
          return {
            id: "command-1",
            type: "coin",
            deviceId: "maimai-dx-1",
            targetKind: "game_machine",
            executorKind: "machine_ws",
            playerId: "player-1",
            staffId: undefined,
            status: "pending",
            payload: { count: 1 },
            requestedAt: new Date("2026-07-07T10:30:00.000Z"),
          };
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    } as any);

    const response = await app.request("/rpc/integration/players/by-identity/device-actions", {
      method: "POST",
      headers: {
        Authorization: "Bearer bot-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        identityKey: "QQ:123456",
        target: {
          kind: "game_machine",
          id: "maimai-dx-1",
        },
        action: {
          type: "coin",
          payload: {
            count: 1,
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      action: {
        id: "command-1",
        type: "coin",
        deviceId: "maimai-dx-1",
        target: {
          kind: "game_machine",
          id: "maimai-dx-1",
        },
        executorKind: "machine_ws",
        playerId: "player-1",
        status: "pending",
        payload: {
          count: 1,
        },
        requestedAt: "2026-07-07T10:30:00.000Z",
      },
    });
    expect(calls).toEqual([
      {
        identityKey: "QQ:123456",
        target: {
          kind: "game_machine",
          id: "maimai-dx-1",
        },
        action: {
          type: "coin",
          payload: {
            count: 1,
          },
        },
      },
    ]);
  });

  it("allows integration tokens to stop their own active session by external identity", async () => {
    const calls: unknown[] = [];
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("integration stop route must use integration commands");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("integration stop route must not list staff players");
        },
        async listActiveSessions() {
          throw new Error("integration stop route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("integration stop route must not call player commands directly");
        },
        async requestDeviceCommand() {
          throw new Error("integration stop route must not request device commands directly");
        },
      },
      integrationCommands: {
        async stopSessionByIdentity(input: unknown) {
          calls.push(input);
          return {
            id: "session-1",
            playerId: "player-1",
            startedAt: new Date("2026-07-07T10:00:00.000Z"),
            endedAt: new Date("2026-07-07T10:30:00.000Z"),
            status: "closed",
            pricingConfigIds: ["mahjong-a"],
            paymentStatus: "unpaid",
            label: "麻将桌 a",
            metadata: { createdBy: "integration" },
          };
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    } as any);

    const response = await app.request("/rpc/integration/players/by-identity/sessions/session-1/stop", {
      method: "POST",
      headers: {
        Authorization: "Bearer bot-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ identityKey: "QQ:123456" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      session: {
        id: "session-1",
        playerId: "player-1",
        startedAt: "2026-07-07T10:00:00.000Z",
        endedAt: "2026-07-07T10:30:00.000Z",
        status: "closed",
        paymentStatus: "unpaid",
        label: "麻将桌 a",
      },
    });
    expect(calls).toEqual([
      {
        identityKey: "QQ:123456",
        sessionId: "session-1",
      },
    ]);
  });

  it("allows integration to list active sessions and device states", async () => {
    const app = createPrismApp({
      staffQueries: {
        async listActiveSessions() {
          return [
            {
              id: "session-1",
              playerId: "player-1",
              playerDisplayName: "Neri",
              startedAt: new Date("2026-07-07T10:00:00.000Z"),
              elapsedMinutes: 30,
              label: "音游区",
            },
          ];
        },
        async listDeviceStates() {
          return [
            {
              deviceId: "mai-1",
              type: "power",
              targetKind: "facility",
              executorKind: "home_assistant",
              label: "mai-1",
              status: "online",
              state: { state: "on" },
              reportedAt: new Date("2026-07-07T10:00:00.000Z"),
              reportedBy: "agent",
            },
          ];
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    } as any);

    const activeResponse = await app.request("/rpc/integration/sessions/active", {
      method: "GET",
      headers: {
        Authorization: "Bearer bot-token",
      },
    });
    expect(activeResponse.status).toBe(200);
    await expect(activeResponse.json()).resolves.toEqual({
      sessions: [
        {
          id: "session-1",
          playerId: "player-1",
          playerDisplayName: "Neri",
          startedAt: "2026-07-07T10:00:00.000Z",
          elapsedMinutes: 30,
          label: "音游区",
          identities: [],
        },
      ],
    });

    const statesResponse = await app.request("/rpc/integration/device-states", {
      method: "GET",
      headers: {
        Authorization: "Bearer bot-token",
      },
    });
    expect(statesResponse.status).toBe(200);
    await expect(statesResponse.json()).resolves.toEqual({
      deviceStates: [
        {
          deviceId: "mai-1",
          type: "power",
          targetKind: "facility",
          executorKind: "home_assistant",
          label: "mai-1",
          status: "online",
          state: { state: "on" },
          reportedAt: "2026-07-07T10:00:00.000Z",
          reportedBy: "agent",
        },
      ],
    });
  });

  it("allows staff to create presents and redeem codes", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff redeem write route must not query player self summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff redeem write route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff redeem write route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff redeem write route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff redeem write route must not request player device commands");
        },
      },
      staffRedeemCommands: {
        async createPresent(input) {
          expect(input).toEqual({
            name: "Top up",
            oncePerPlayer: true,
            activeAt: null,
            expiresAt: null,
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
          return {
            id: "present-1",
            name: "Top up",
            oncePerPlayer: true,
            status: "active",
            activeAt: null,
            expiresAt: null,
            grants: input.grants,
          };
        },
        async listPresents() {
          return [
            {
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
            },
          ];
        },
        async archivePresent(input) {
          expect(input).toEqual({
            presentId: "present-1",
          });
          return {
            id: "present-1",
            name: "Top up",
            oncePerPlayer: true,
            status: "archived",
            grants: [],
          };
        },
        async restorePresent(input) {
          expect(input).toEqual({
            presentId: "present-1",
          });
          return {
            id: "present-1",
            name: "Top up",
            oncePerPlayer: true,
            status: "active",
            grants: [],
          };
        },
        async createRedeemCode(input) {
          expect(input).toEqual({
            code: "PRISM-2026",
            presentId: "present-1",
            activeAt: new Date("2026-06-07T00:00:00.000Z"),
            expiresAt: new Date("2026-07-07T00:00:00.000Z"),
            maxUseCount: 1,
          });
          return {
            id: "code-1",
            code: "PRISM-2026",
            presentId: "present-1",
            activeAt: new Date("2026-06-07T00:00:00.000Z"),
            expiresAt: new Date("2026-07-07T00:00:00.000Z"),
            maxUseCount: 1,
          };
        },
        async listRedeemCodes() {
          throw new Error("staff redeem write route must not list redeem codes");
        },
        async revokeRedeemCode() {
          throw new Error("staff redeem write route must not revoke redeem codes");
        },
        async createRedeemCodeBatch() {
          throw new Error("staff redeem write route must not create redeem codes in batches");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const listPresentResponse = await app.request("/rpc/staff/presents", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(listPresentResponse.status).toBe(200);
    await expect(listPresentResponse.json()).resolves.toEqual({
      presents: [
        {
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
        },
      ],
    });

    const presentResponse = await app.request("/rpc/staff/presents", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
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
      }),
    });
    expect(presentResponse.status).toBe(200);
    await expect(presentResponse.json()).resolves.toEqual({
      present: {
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
      },
    });

    const archivePresentResponse = await app.request("/rpc/staff/presents/present-1/archive", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(archivePresentResponse.status).toBe(200);
    await expect(archivePresentResponse.json()).resolves.toEqual({
      present: {
        id: "present-1",
        name: "Top up",
        oncePerPlayer: true,
        activeAt: null,
        expiresAt: null,
        status: "archived",
        grants: [],
      },
    });

    const restorePresentResponse = await app.request("/rpc/staff/presents/present-1/restore", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(restorePresentResponse.status).toBe(200);
    await expect(restorePresentResponse.json()).resolves.toEqual({
      present: {
        id: "present-1",
        name: "Top up",
        oncePerPlayer: true,
        activeAt: null,
        expiresAt: null,
        status: "active",
        grants: [],
      },
    });

    const codeResponse = await app.request("/rpc/staff/redeem-codes", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: "PRISM-2026",
        presentId: "present-1",
        activeAt: "2026-06-07T00:00:00.000Z",
        expiresAt: "2026-07-07T00:00:00.000Z",
        maxUseCount: 1,
      }),
    });
    expect(codeResponse.status).toBe(200);
    await expect(codeResponse.json()).resolves.toEqual({
      redeemCode: {
        id: "code-1",
        code: "PRISM-2026",
        presentId: "present-1",
        activeAt: "2026-06-07T00:00:00.000Z",
        expiresAt: "2026-07-07T00:00:00.000Z",
        maxUseCount: 1,
        usageCount: 0,
      },
    });
  });

  it("allows staff to list and revoke redeem codes", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff redeem management route must not query player summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff redeem management route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff redeem management route must not list active sessions");
        },
        async listPlayerRedeemRecords() {
          throw new Error("staff redeem management route must not query one player's redeem records");
        },
      },
      staffRedeemQueries: {
        async listRedeemCodeRedemptions() {
          return [
            {
              codeId: "code-1",
              playerId: "player-1",
              playerDisplayName: "A",
              redeemedAt: new Date("2026-07-05T12:34:00.000Z"),
            },
          ];
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff redeem management route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff redeem management route must not request player device commands");
        },
      },
      staffRedeemCommands: {
        async createPresent() {
          throw new Error("staff redeem management route must not create presents");
        },
        async createRedeemCode() {
          throw new Error("staff redeem management route must not create redeem codes");
        },
        async listRedeemCodes() {
          return [
            {
              id: "code-1",
              code: "PRISM-2026",
              presentId: "present-1",
              activeAt: new Date("2026-06-07T00:00:00.000Z"),
              expiresAt: new Date("2026-07-07T00:00:00.000Z"),
              maxUseCount: 1,
            },
          ];
        },
        async revokeRedeemCode(input) {
          expect(input).toEqual({
            codeId: "code-1",
          });
          return {
            id: "code-1",
            code: "PRISM-2026",
            presentId: "present-1",
            activeAt: new Date("2026-06-07T00:00:00.000Z"),
            expiresAt: new Date("2026-07-07T00:00:00.000Z"),
            maxUseCount: 0,
          };
        },
        async createRedeemCodeBatch() {
          throw new Error("staff redeem management route must not create redeem codes in batches");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const listResponse = await app.request("/rpc/staff/redeem-codes", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({
      redeemCodes: [
        {
          id: "code-1",
          code: "PRISM-2026",
          presentId: "present-1",
          activeAt: "2026-06-07T00:00:00.000Z",
          expiresAt: "2026-07-07T00:00:00.000Z",
          maxUseCount: 1,
          usageCount: 0,
          redemptions: [
            {
              playerId: "player-1",
              playerDisplayName: "A",
              redeemedAt: "2026-07-05T12:34:00.000Z",
            },
          ],
        },
      ],
    });

    const revokeResponse = await app.request("/rpc/staff/redeem-codes/code-1/revoke", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
      },
    });
    expect(revokeResponse.status).toBe(200);
    await expect(revokeResponse.json()).resolves.toEqual({
      redeemCode: {
        id: "code-1",
        code: "PRISM-2026",
        presentId: "present-1",
        activeAt: "2026-06-07T00:00:00.000Z",
        expiresAt: "2026-07-07T00:00:00.000Z",
        maxUseCount: 0,
        usageCount: 0,
      },
    });
  });

  it("allows staff to list a player's redeem records", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff player redeem records route must not query player summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff player redeem records route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff player redeem records route must not list active sessions");
        },
        async listPlayerRedeemRecords(playerId) {
          expect(playerId).toBe("player-1");
          return [
            {
              codeId: "code-1",
              code: "PRISM-2026",
              presentId: "present-1",
              presentName: "月饼礼物",
              redeemedAt: new Date("2026-07-05T12:34:00.000Z"),
            },
          ];
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff player redeem records route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff player redeem records route must not request device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/players/player-1/redeem-records", {
      headers: {
        Authorization: "Bearer staff-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      redeemRecords: [
        {
          codeId: "code-1",
          code: "PRISM-2026",
          presentId: "present-1",
          presentName: "月饼礼物",
          redeemedAt: "2026-07-05T12:34:00.000Z",
        },
      ],
    });
  });

  it("allows staff to create redeem codes in batches", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new Error("staff redeem batch route must not query player summary");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("staff redeem batch route must not list players");
        },
        async listActiveSessions() {
          throw new Error("staff redeem batch route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("staff redeem batch route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("staff redeem batch route must not request player device commands");
        },
      },
      staffRedeemCommands: {
        async createPresent() {
          throw new Error("staff redeem batch route must not create presents");
        },
        async createRedeemCode() {
          throw new Error("staff redeem batch route must not create a single redeem code");
        },
        async listRedeemCodes() {
          throw new Error("staff redeem batch route must not list redeem codes");
        },
        async revokeRedeemCode() {
          throw new Error("staff redeem batch route must not revoke redeem codes");
        },
        async createRedeemCodeBatch(input) {
          expect(input).toEqual({
            prefix: "PRISM",
            presentId: "present-1",
            activeAt: null,
            expiresAt: null,
            maxUseCount: 1,
            count: 2,
          });
          return [
            {
              id: "code-1",
              code: "PRISM-code-1",
              presentId: "present-1",
              activeAt: null,
              expiresAt: null,
              maxUseCount: 1,
            },
            {
              id: "code-2",
              code: "PRISM-code-2",
              presentId: "present-1",
              activeAt: null,
              expiresAt: null,
              maxUseCount: 1,
            },
          ];
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/staff/redeem-codes/batch", {
      method: "POST",
      headers: {
        Authorization: "Bearer staff-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prefix: "PRISM",
        presentId: "present-1",
        activeAt: null,
        expiresAt: null,
        maxUseCount: 1,
        count: 2,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      redeemCodes: [
        {
          id: "code-1",
          code: "PRISM-code-1",
          presentId: "present-1",
          activeAt: null,
          expiresAt: null,
          maxUseCount: 1,
          usageCount: 0,
        },
        {
          id: "code-2",
          code: "PRISM-code-2",
          presentId: "present-1",
          activeAt: null,
          expiresAt: null,
          maxUseCount: 1,
          usageCount: 0,
        },
      ],
    });
  });
});
  it("returns a JSON 500 error instead of crashing when a route throws an unexpected error", async () => {
    const app = createPrismApp({
      playerQueries: {
        async getPlayerSummary() {
          throw new TypeError("database connection lost");
        },
      },
      staffQueries: {
        async listPlayers() {
          throw new Error("unexpected route must not list players");
        },
        async listActiveSessions() {
          throw new Error("unexpected route must not list active sessions");
        },
      },
      playerCommands: {
        async startSession() {
          throw new Error("unexpected route must not start sessions");
        },
        async requestDeviceCommand() {
          throw new Error("unexpected route must not request device commands");
        },
      },
      authTokens: {
        player: "player-token",
        staff: "staff-token",
        integration: "bot-token",
        machine: "agent-token",
      },
    });

    const response = await app.request("/rpc/player/me", {
      headers: {
        Authorization: "Bearer player-session-token",
        "X-PRiSM-Player-Id": "player-1",
      },
    });

    expect(response.status).toBe(500);
    const json = (await response.json()) as any;
    expect(json.error.code).toBe("INTERNAL_ERROR");
    expect(json.error.message).toBe("An unexpected error occurred.");
    expect(json.error.details).toBeUndefined();
  });
