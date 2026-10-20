import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createD1Executor } from "@prism/adapter-d1";
import type { Session } from "@prism/core";
import { createDeviceEventRepository, sqliteSchema } from "@prism/storage-sql";
import type { Env } from "../src/bindings.js";
import { encryptSecret } from "../src/crypto.js";
import { createDeviceActionService } from "../src/devices/actions.js";
import { loadDevice } from "../src/devices/device.js";
import { observeClimate, readClimate } from "../src/devices/runtime.js";
import { createD1DatabaseFromSqlite, platformSchema } from "../src/local-server.js";

const KEY = "unit-test-encryption-key";
const SHOP = "shop-1";
const NOW = new Date("2026-10-20T10:00:00.000Z");

async function fixture(options: { activeSession?: boolean } = {}) {
  const sqlite = new Database(":memory:");
  for (const statement of [...sqliteSchema, ...platformSchema]) sqlite.run(statement);
  const db = createD1DatabaseFromSqlite(sqlite);
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const ac = { state: "off", temperature: 26, current: 28.5, fan: "auto" };
  let power = "on";
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/services/")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, body });
      if (url.endsWith("climate/turn_on")) ac.state = "cool";
      if (url.endsWith("climate/turn_off")) ac.state = "off";
      if (url.endsWith("climate/set_hvac_mode")) ac.state = String(body.hvac_mode);
      if (url.endsWith("climate/set_temperature")) ac.temperature = Number(body.temperature);
      if (url.endsWith("climate/set_fan_mode")) ac.fan = String(body.fan_mode);
      if (url.includes("/switch/")) power = url.endsWith("turn_on") ? "on" : "off";
      return Response.json([]);
    }
    if (url.includes("/api/states/climate.")) {
      return Response.json({
        state: ac.state,
        attributes: {
          hvac_modes: ["off", "cool", "heat", "dry", "fan_only", "auto"],
          min_temp: 16, max_temp: 30, target_temp_step: 1,
          temperature: ac.temperature, current_temperature: ac.current,
          fan_mode: ac.fan, fan_modes: ["auto", "low", "medium", "high"],
        },
      });
    }
    if (url.includes("/api/states/")) return Response.json({ state: power });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  let ids = 0;
  const sessions: Session[] = options.activeSession
    ? [{ id: "s1", playerId: "p1", startedAt: NOW, status: "active", paymentStatus: "unpaid" } as Session]
    : [];
  const env = { DB: db, URL_ENCRYPTION_KEY: KEY } as unknown as Env;
  const service = createDeviceActionService({
    db, env, shopId: SHOP,
    sessions: { async findActiveByPlayerId(playerId: string) { return sessions.filter((s) => s.playerId === playerId); } } as never,
    deviceEvents: createDeviceEventRepository(createD1Executor(db, SHOP)),
    playerIdentities: { async listByPlayerId() { return []; } } as never,
    coinCooldownMs: async () => 0,
    now: () => NOW,
    id: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    fetcher,
  });
  const binding = (entityId: string) => encryptSecret(JSON.stringify({ url: "https://ha.test", token: "t", entityId }), KEY);
  async function machine(id: string, name: string, capabilities: Record<string, string>) {
    sqlite.run("INSERT INTO machines(id, public_id, shop_id, name, aliases_json) VALUES (?,?,?,?,'[]')", [id, `pub-${id}`, SHOP, name]);
    for (const [capability, entity] of Object.entries(capabilities)) {
      sqlite.run(
        `INSERT INTO device_capabilities(shop_id, device_id, capability, config_json, secret_json, created_at, updated_at)
         VALUES (?,?,?,'{}',?,?,?)`,
        [SHOP, id, capability, JSON.stringify({ binding: await binding(entity) }), NOW.toISOString(), NOW.toISOString()],
      );
    }
  }
  const operations = () => sqlite.query<{ device_id: string; action: string; counts_as_play: number; status: string }, []>(
    "SELECT device_id, action, counts_as_play, status FROM device_operations ORDER BY requested_at, id",
  ).all();
  return { sqlite, db, env, service, calls, ac, machine, operations, fetcher };
}

const staff = { type: "staff" as const, staffId: "staff-1" };

describe("climate capability", () => {
  it("drives every basic air conditioner setting through climate services", async () => {
    const { service, machine, calls, operations } = await fixture();
    await machine("ac", "空调", { climate: "climate.lumi_cn_974741205_mcn02" });
    const send = (type: string, payload?: Record<string, unknown>) =>
      service.requestDeviceAction({ actor: staff, target: { kind: "facility", ref: "空调" }, type: type as never, payload });
    await send("climate.on");
    await send("climate.set_mode", { mode: "heat" });
    await send("climate.set_temperature", { temperature: 24.5 });
    await send("climate.set_fan_mode", { fanMode: "high" });
    await send("climate.off");
    expect(calls.map((call) => [call.url.replace("https://ha.test/api/services/", ""), call.body])).toEqual([
      ["climate/turn_on", { entity_id: "climate.lumi_cn_974741205_mcn02" }],
      ["climate/set_hvac_mode", { hvac_mode: "heat", entity_id: "climate.lumi_cn_974741205_mcn02" }],
      ["climate/set_temperature", { temperature: 24.5, entity_id: "climate.lumi_cn_974741205_mcn02" }],
      ["climate/set_fan_mode", { fan_mode: "high", entity_id: "climate.lumi_cn_974741205_mcn02" }],
      ["climate/turn_off", { entity_id: "climate.lumi_cn_974741205_mcn02" }],
    ]);
    // Using the air conditioner is not playing a machine.
    expect(operations().every((operation) => operation.counts_as_play === 0 && operation.status === "succeeded")).toBe(true);
    const missing = await send("climate.set_temperature");
    expect(missing.status).toBe("expired");
  });

  it("needs a player to be inside an entry, like other device actions", async () => {
    const { service, machine } = await fixture();
    await machine("ac", "空调", { climate: "climate.room" });
    await expect(service.requestDeviceAction({
      actor: { type: "player", playerId: "p1" }, target: { kind: "facility", ref: "空调" }, type: "climate.on" as never,
    })).rejects.toMatchObject({ code: "DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION" });
  });

  it("switches air conditioners along with machine power for `all`", async () => {
    const { service, machine, calls, operations } = await fixture();
    await machine("m1", "舞萌", { power: "switch.mai" });
    await machine("ac", "空调", { climate: "climate.room" });
    await machine("room", "包间", { power: "switch.room", climate: "climate.room2" });
    const command = await service.requestDeviceAction({ actor: staff, target: { kind: "facility", ref: "all" }, type: "power.off" });
    expect(command).toMatchObject({ type: "power.off", status: "acked", payload: { deviceLabel: "所有设备" } });
    expect(calls.map((call) => [call.url.replace("https://ha.test/api/services/", ""), call.body.entity_id])).toEqual([
      ["climate/turn_off", "climate.room"],
      ["switch/turn_off", "switch.mai"],
      ["switch/turn_off", "switch.room"],
      ["climate/turn_off", "climate.room2"],
    ]);
    expect(operations().map((operation) => [operation.device_id, operation.action])).toEqual([
      ["ac", "climate.off"], ["m1", "power.off"], ["room", "power.off"], ["room", "climate.off"],
    ]);
  });

  it("reads what the entity offers and records only setting changes", async () => {
    const { db, env, machine, ac, sqlite, fetcher } = await fixture();
    await machine("ac", "空调", { climate: "climate.room" });
    const device = (await loadDevice(db, SHOP, "ac"))!;
    const runtime = { db, env, shopId: SHOP, fetcher, now: () => NOW };
    expect(await readClimate(runtime, device)).toEqual({
      mode: "off", modes: ["off", "cool", "heat", "dry", "fan_only", "auto"],
      temperature: 26, currentTemperature: 28.5, minTemperature: 16, maxTemperature: 30, temperatureStep: 1,
      fanMode: "auto", fanModes: ["auto", "low", "medium", "high"],
    });
    const changes = () => (sqlite.query("SELECT COUNT(*) AS n FROM device_events WHERE kind='change' AND capability='climate'").get() as { n: number }).n;
    await observeClimate(runtime, device);
    expect(changes()).toBe(1);
    ac.current = 27;
    await observeClimate(runtime, device);
    expect(changes()).toBe(1);
    ac.state = "cool";
    await observeClimate(runtime, device);
    expect(changes()).toBe(2);
  });
});
