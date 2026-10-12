import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { D1DatabaseLike } from "@prism/adapter-d1";
import { encryptSecret } from "../src/crypto.js";
import { createShopGameMachineResolver } from "../src/hardware/shop-game-machine-resolver.js";

const encryptionKey = "test-encryption-key";
function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.run(`CREATE TABLE machines (
    shop_id TEXT, id TEXT, public_id TEXT, name TEXT, enabled INTEGER,
    aliases_json TEXT, hinata_url_encrypted TEXT, hinata_password_encrypted TEXT,
    coin_key INTEGER
  )`);
  sqlite.run("CREATE TABLE app_settings (shop_id TEXT, key TEXT, value_json TEXT)");
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: Array<string | number | null>) {
          return {
            async all<T>() { return { results: sqlite.query(sql).all(...params) as T[] }; },
            async first<T>() { return sqlite.query(sql).get(...params) as T | null; },
          };
        },
      };
    },
  } as unknown as D1DatabaseLike;
  const calls: Array<{ url: string; action: string }> = [];
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(url), action: body.action });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const resolve = createShopGameMachineResolver({ db, shopId: "shop-a", encryptionKey, fetcher });
  const insert = async (id: string, enabled = 1, shop = "shop-a", connected = true) => {
    const url = connected ? await encryptSecret("https://hinata.example.test/relay", encryptionKey) : null;
    const password = connected ? await encryptSecret("hinata-test-password", encryptionKey) : null;
    sqlite.query("INSERT INTO machines VALUES (?,?,?,?,?,?,?,?,?)")
      .run(shop, id, id + "-public", id + "名称", enabled, JSON.stringify([id + "别名"]), url, password, 32);
  };
  return { sqlite, resolve, insert, calls };
}

test("Bot resolves game-machine aliases into a real Hinata IO executor", async () => {
  const f = fixture();
  try {
    await f.insert("mai-1");
    const value = await f.resolve("mai-1别名");
    expect(value.target).toEqual({ kind: "game_machine", id: "mai-1", executorKind: "hinata_io" });
    expect(value.deviceLabel).toBe("mai-1名称");
    expect(value.executor).toBeDefined();
    const result = await value.executor!.execute({ command: {
      id: "action-1", type: "coin", deviceId: "mai-1", targetKind: "game_machine",
      executorKind: "hinata_io", status: "pending", playerId: "player-1",
      requestedAt: new Date(), payload: { count: 1 },
    } });
    expect(result.status).toBe("success");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://hinata.example.test/relay/event");
    expect(["E2EE_V1", "E2EE_V2"]).toContain(f.calls[0]!.action);
  } finally { f.sqlite.close(); }
});

test("Game-machine resolver blocks disabled, unbound and cross-shop devices", async () => {
  const f = fixture();
  try {
    await f.insert("disabled", 0);
    await f.insert("no-binding", 1, "shop-a", false);
    await f.insert("other-shop", 1, "shop-b");
    for (const [ref, code] of [
      ["disabled", "DEVICE_DISABLED"], ["no-binding", "DEVICE_CONFIGURATION_REQUIRED"],
      ["other-shop", "DEVICE_NOT_FOUND"], ["unknown", "DEVICE_NOT_FOUND"],
    ]) {
      await expect(f.resolve(ref!)).rejects.toMatchObject({ code });
    }
    expect(f.calls).toHaveLength(0);
  } finally { f.sqlite.close(); }
});

test("Game-machine resolver preserves legacy Hinata names and aliases", async () => {
  const f = fixture();
  try {
    f.sqlite.query("INSERT INTO app_settings VALUES (?,?,?)").run("shop-a", "devices.hinata_io", JSON.stringify([
      { id: "legacy-1", name: "旧机台", aliases: ["老机台"], url: "https://old.example.test/relay",
        password: "legacy-password", coinKey: 32, cardType: "aime", salt: "" },
    ]));
    const resolved = await f.resolve("老机台");
    expect(resolved.target).toEqual({ kind: "game_machine", id: "legacy-1", executorKind: "hinata_io" });
    expect(resolved.executor).toBeDefined();
  } finally { f.sqlite.close(); }
});
