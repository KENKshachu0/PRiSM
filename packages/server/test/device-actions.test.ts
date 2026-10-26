import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createD1Executor } from "@prism/adapter-d1";
import type { PlayerIdentity, Session } from "@prism/core";
import { createDeviceEventRepository, sqliteSchema } from "@prism/storage-sql";
import type { Env } from "../src/bindings.js";
import { encryptSecret } from "../src/crypto.js";
import { createCardStore } from "../src/resources/cards.js";
import { createDeviceActionService } from "../src/resources/capabilities/actions.js";
import { listDeviceStates } from "../src/resources/capabilities/legacy-views.js";
import { createD1DatabaseFromSqlite, platformSchema } from "../src/local-server.js";

const KEY = "unit-test-encryption-key";
const SHOP = "shop-1";
const NOW = new Date("2026-10-17T10:00:00.000Z");

type HaCall = { url: string; body: unknown };

async function fixture(options: { activeSession?: boolean; identities?: PlayerIdentity[] } = {}) {
  const sqlite = new Database(":memory:");
  for (const statement of [...sqliteSchema, ...platformSchema]) sqlite.run(statement);
  const db = createD1DatabaseFromSqlite(sqlite);
  const ha: HaCall[] = [];
  const io: string[] = [];
  let power = "off";
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/services/")) {
      ha.push({ url, body: JSON.parse(String(init?.body)) });
      power = url.endsWith("turn_on") ? "on" : "off";
      return Response.json([]);
    }
    if (url.includes("/api/states/")) return Response.json({ state: power });
    io.push(url);
    return new Response("ok");
  }) as typeof fetch;

  let ids = 0;
  const sessions: Session[] = options.activeSession
    ? [{ id: "s1", playerId: "p1", startedAt: NOW, status: "active", paymentStatus: "unpaid" } as Session]
    : [];
  const service = createDeviceActionService({
    db,
    env: { DB: db, URL_ENCRYPTION_KEY: KEY } as unknown as Env,
    shopId: SHOP,
    sessions: {
      async findActiveByPlayerId(playerId: string) {
        return sessions.filter((session) => session.playerId === playerId);
      },
    } as never,
    deviceEvents: createDeviceEventRepository(createD1Executor(db, SHOP)),
    playerIdentities: {
      async listByPlayerId(playerId: string) {
        return (options.identities ?? []).filter((identity) => identity.playerId === playerId);
      },
    } as never,
    coinCooldownMs: async () => 60_000,
    now: () => NOW,
    id: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    fetcher,
  });

  async function machine(id: string, name: string, capabilities: Record<string, { config?: object; secrets?: Record<string, string> }>, aliases: string[] = []) {
    sqlite.run("INSERT INTO machines(id, public_id, shop_id, name, aliases_json) VALUES (?,?,?,?,?)", [id, `pub-${id}`, SHOP, name, JSON.stringify(aliases)]);
    for (const [capability, value] of Object.entries(capabilities)) {
      const secrets: Record<string, string> = {};
      for (const [secret, plain] of Object.entries(value.secrets ?? {})) secrets[secret] = await encryptSecret(plain, KEY);
      sqlite.run(
        `INSERT INTO device_capabilities(shop_id, device_id, capability, config_json, secret_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
        [SHOP, id, capability, JSON.stringify(value.config ?? {}), JSON.stringify(secrets), NOW.toISOString(), NOW.toISOString()],
      );
    }
  }
  const binding = (entityId: string) => JSON.stringify({ url: "https://ha.test", token: "ha-token", entityId });
  const operations = () =>
    sqlite.query<{ action: string; device_id: string | null; status: string; payload_json: string }, []>(
      "SELECT action, device_id, status, payload_json FROM device_operations ORDER BY requested_at, id",
    ).all();
  return { sqlite, db, service, ha, io, machine, binding, operations, fetcher };
}

describe("device action service", () => {
  it("refuses a player action that needs an entry when the player has none", async () => {
    const { service, machine } = await fixture();
    await machine("m1", "舞萌", { hinata_io: { config: { coinKey: 32 }, secrets: { url: "https://io.test/m1", password: "pw" } } });
    await expect(service.requestDeviceAction({
      actor: { type: "player", playerId: "p1" },
      target: { kind: "game_machine", ref: "舞萌" },
      type: "coin",
    })).rejects.toMatchObject({ code: "DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION" });
  });

  it("applies the coin cooldown to a player's earlier coin", async () => {
    const { service, machine, io } = await fixture({ activeSession: true });
    await machine("m1", "舞萌", { hinata_io: { config: { coinKey: 32 }, secrets: { url: "https://io.test/m1", password: "pw" } } });
    const request = { actor: { type: "player" as const, playerId: "p1" }, target: { kind: "game_machine" as const, ref: "舞萌" }, type: "coin" as const };
    const first = await service.requestDeviceAction(request);
    expect(first).toMatchObject({ type: "coin", status: "acked", executorKind: "hinata_io", targetKind: "game_machine" });
    expect(io).toEqual(["https://io.test/m1/event"]);
    await expect(service.requestDeviceAction(request)).rejects.toMatchObject({ code: "COIN_COMMAND_COOLDOWN_ACTIVE" });
  });

  it("swipes only a card bound to the player and never stores the number", async () => {
    const { service, machine, operations, sqlite, db } = await fixture({ activeSession: true });
    // The player's card at this shop, kept encrypted.
    await createCardStore(db, SHOP, KEY).bind({ playerId: "p1", card: { type: "aime", accessCode: "12345678901234567890" }, source: "scan" });
    await machine("m1", "舞萌", { hinata_io: { config: {}, secrets: { url: "https://io.test/m1" } } });
    const scan = { actor: { type: "player" as const, playerId: "p1" }, target: { kind: "game_machine" as const, ref: "舞萌" }, type: "aime.scan" as const };
    await expect(service.requestDeviceAction({ ...scan, payload: { subject: "99999999999999999999" } }))
      .rejects.toMatchObject({ code: "SCAN_IDENTITY_NOT_BOUND_TO_PLAYER" });
    await service.requestDeviceAction(scan);
    expect(operations().map((operation) => operation.action)).toEqual(["aime.scan"]);
    const stored = JSON.stringify(sqlite.query("SELECT * FROM device_events").all()) + JSON.stringify(operations());
    expect(stored).not.toContain("12345678901234567890");
  });

  it("turns every powered device off for `all` and answers in the legacy shape", async () => {
    const { service, machine, binding, ha, operations } = await fixture();
    await machine("m1", "舞萌", { power: { secrets: { binding: binding("switch.mai") } } });
    await machine("m2", "中二", { power: { secrets: { binding: binding("switch.chu") } } });
    await machine("m3", "门", { door: { config: { lockId: 1 } } });
    const command = await service.requestDeviceAction({
      actor: { type: "staff", staffId: "bot" },
      target: { kind: "facility", ref: "all" },
      type: "power.off",
    });
    expect(command).toMatchObject({ deviceId: null, status: "acked", executorKind: "home_assistant", payload: { deviceLabel: "所有设备" } });
    expect(ha.map((call) => call.body)).toEqual([{ entity_id: "switch.mai" }, { entity_id: "switch.chu" }]);
    expect(operations().map((operation) => [operation.device_id, operation.status])).toEqual([["m1", "succeeded"], ["m2", "succeeded"]]);
  });
});

describe("legacy device registries", () => {
  it("adopts registry devices once, keeps their Bot names and points their history at them", async () => {
    const { sqlite, service, ha, db, fetcher } = await fixture();
    const settings: Array<[string, unknown]> = [
      ["devices.homeassistant", [{ id: "switch.wacca", name: "华卡", alias: ["wc"] }]],
      ["devices.homeassistant_connection", { url: "https://ha.test", token: "ha-token" }],
      ["devices.ttlock", [{ id: "front", name: "前门", aliases: [], lockId: 42 }]],
    ];
    for (const [key, value] of settings) {
      sqlite.run("INSERT INTO app_settings(shop_id, key, value_json, updated_at) VALUES (?,?,?,?)", [SHOP, key, JSON.stringify(value), NOW.toISOString()]);
    }
    // A command issued against the registry recorded the entity id as its device.
    sqlite.run(
      `INSERT INTO device_operations(shop_id, id, device_id, capability, action, status, counts_as_play, payload_json, requested_at)
       VALUES (?, 'old', 'switch.wacca', 'power', 'power.on', 'succeeded', 1, '{}', ?)`,
      [SHOP, NOW.toISOString()],
    );

    await service.requestDeviceAction({ actor: { type: "staff", staffId: "bot" }, target: { kind: "facility", ref: "wc" }, type: "power.on" });
    expect(ha.map((call) => call.url)).toEqual(["https://ha.test/api/services/switch/turn_on"]);

    const devices = sqlite.query<{ id: string; name: string; aliases_json: string; kind: string }, []>(
      "SELECT id, name, aliases_json, kind FROM machines ORDER BY name",
    ).all();
    expect(devices.map((device) => [device.name, device.kind])).toEqual([["前门", "door"], ["华卡", "machine"]]);
    const wacca = devices.find((device) => device.name === "华卡")!;
    expect(JSON.parse(wacca.aliases_json)).toEqual(["switch.wacca", "wc"]);
    expect(sqlite.query("SELECT device_id FROM device_operations WHERE id='old'").get()).toEqual({ device_id: wacca.id });
    const keys = sqlite.query<{ key: string }, []>("SELECT key FROM app_settings ORDER BY key").all().map((row) => row.key);
    // The registry is gone; its Home Assistant became one shop connection.
    expect(keys.filter((key) => !key.startsWith("devices.ha_connection:"))).toEqual(["devices.homeassistant_connection"]);
    expect(keys.filter((key) => key.startsWith("devices.ha_connection:"))).toHaveLength(1);

    // The adopted device is an ordinary device everywhere, including the Bot's state listing.
    const states = await listDeviceStates({ db, env: { DB: db, URL_ENCRYPTION_KEY: KEY } as unknown as Env, shopId: SHOP, fetcher, now: () => NOW });
    expect(states.map((state) => [state.label, state.state, state.status])).toEqual([["华卡", "on", "online"]]);
  });

  it("leaves the registry alone until the platform key is available", async () => {
    const { sqlite, db } = await fixture();
    sqlite.run("INSERT INTO app_settings(shop_id, key, value_json, updated_at) VALUES (?,?,?,?)", [
      SHOP, "devices.hinata_io", JSON.stringify([{ id: "io", name: "IO", url: "https://io.test", password: "pw", coinKey: 32, aliases: [] }]), NOW.toISOString(),
    ]);
    const { loadResources } = await import("../src/resources/resource.js");
    expect(await loadResources(db, SHOP, undefined)).toEqual([]);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM app_settings").get()).toEqual({ n: 1 });
    const adopted = await loadResources(db, SHOP, KEY);
    expect(adopted.map((device) => [device.name, [...device.capabilities.keys()]])).toEqual([["IO", ["hinata_io"]]]);
  });
});
