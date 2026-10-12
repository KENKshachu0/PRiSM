import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { D1DatabaseLike } from "@prism/adapter-d1";
import type { DeviceCommand } from "@prism/core";
import { encryptSecret } from "../src/crypto.js";
import { createShopFacilityResolver } from "../src/hardware/shop-facility-resolver.js";

const encryptionKey = "test-encryption-key";
const now = new Date("2026-10-12T14:54:11Z");

function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.run(`CREATE TABLE machines (
    shop_id TEXT, id TEXT, public_id TEXT, name TEXT, enabled INTEGER,
    aliases_json TEXT, ha_binding_encrypted TEXT
  )`);
  sqlite.run(`CREATE TABLE app_settings (shop_id TEXT, key TEXT, value_json TEXT)`);
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: Array<string | number | null>) {
          return {
            async all<T>() {
              return { results: sqlite.query(sql).all(...params) as T[] };
            },
          };
        },
      };
    },
  } as unknown as D1DatabaseLike;
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  const resolve = createShopFacilityResolver({
    db, shopId: "shop-a", encryptionKey, fetcher,
  });
  const insert = async (id: string, name: string, enabled = 1, shop = "shop-a", hasHa = true) => {
    const binding = hasHa ? await encryptSecret(JSON.stringify({
      url: "https://ha.example.test", entityId: `switch.${id.replace(/-/g, "_")}`, token: "private-ha-token",
    }), encryptionKey) : null;
    sqlite.query("INSERT INTO machines VALUES (?,?,?,?,?,?,?)").run(shop, id, id + "-public", name, enabled, JSON.stringify(["主机", id + "-别名"]), binding);
  };
  const command = (id: string | null, type: "power.on" | "power.off" = "power.on"): DeviceCommand => ({
    id: "cmd-1", type, deviceId: id, targetKind: "facility", executorKind: "home_assistant",
    playerId: "player-1", status: "pending", requestedAt: now,
  });
  return { sqlite, calls, resolve, insert, command };
}

test("Bot power resolves shop machine alias and calls configured HA instead of merely queuing", async () => {
  const f = fixture();
  try {
    await f.insert("cabinet-1", "舞萌一号");
    const resolved = await f.resolve("cabinet-1-别名", "power.on");
    expect(resolved.target).toEqual({ kind: "facility", id: "cabinet-1" });
    expect(resolved.deviceLabel).toBe("舞萌一号");
    expect(resolved.executor).toBeDefined();
    const result = await resolved.executor!.execute({ command: f.command("cabinet-1") });
    expect(result.status).toBe("success");
    expect(f.calls).toEqual([{
      url: "https://ha.example.test/api/services/switch/turn_on",
      method: "POST",
      body: { entity_id: "switch.cabinet_1" },
    }]);
    expect(JSON.stringify(f.calls)).not.toContain("private-ha-token");
  } finally { f.sqlite.close(); }
});

test("Bot power refuses disabled, unbound, unknown, and cross-shop machines", async () => {
  const f = fixture();
  try {
    await f.insert("disabled", "停用设备", 0);
    await f.insert("unbound", "无电源设备", 1, "shop-a", false);
    await f.insert("other-shop", "别店设备", 1, "shop-b");
    for (const [ref, code] of [
      ["停用设备", "DEVICE_DISABLED"],
      ["无电源设备", "DEVICE_ACTION_UNSUPPORTED"],
      ["别店设备", "DEVICE_NOT_FOUND"],
      ["不存在", "DEVICE_NOT_FOUND"],
    ]) {
      await expect(f.resolve(ref!, "power.off")).rejects.toMatchObject({ code });
    }
    expect(f.calls).toHaveLength(0);
  } finally { f.sqlite.close(); }
});

test("Bot power 'all' executes each bound enabled machine and preserves legacy HA settings", async () => {
  const f = fixture();
  try {
    await f.insert("first", "一号");
    await f.insert("second", "二号");
    await f.insert("disabled", "停用", 0);
    f.sqlite.query("INSERT INTO app_settings VALUES (?,?,?)").run("shop-a", "devices.homeassistant", JSON.stringify([
      { id: "switch.legacy", name: "旧配置", alias: ["旧机台"] },
    ]));
    f.sqlite.query("INSERT INTO app_settings VALUES (?,?,?)").run("shop-a", "devices.homeassistant_connection", JSON.stringify({
      url: "https://legacy-ha.example.test", token: "private-legacy-token",
    }));
    const legacy = await f.resolve("旧机台", "power.off");
    expect((await legacy.executor!.execute({ command: f.command("switch.legacy", "power.off") })).status).toBe("success");

    const all = await f.resolve("all", "power.off");
    expect(all.target).toEqual({ kind: "facility", all: true });
    expect((await all.executor!.execute({ command: f.command(null, "power.off") })).status).toBe("success");
    expect(f.calls.map(call => call.body)).toEqual([
      { entity_id: "switch.legacy" },
      { entity_id: "switch.first" },
      { entity_id: "switch.second" },
      { entity_id: "switch.legacy" },
    ]);
  } finally { f.sqlite.close(); }
});
