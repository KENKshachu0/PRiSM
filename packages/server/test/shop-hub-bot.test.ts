import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { sha256Hex } from "../src/crypto.js";
import { ShopHub } from "../src/durable-objects/shop-hub.js";
import { botRequestUrl, parseBotFrame } from "../src/durable-objects/shop-hub-bot.js";

const migrations = resolve(import.meta.dir, "../../../migrations");
const TOKEN = "integration_test_token";

class FakeSocket {
  readonly sent: string[] = [];
  attachment: unknown = null;
  closed: { code?: number; reason?: string } | null = null;
  send(payload: string) { this.sent.push(payload); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; }
  serializeAttachment(value: unknown) { this.attachment = value; }
  deserializeAttachment() { return this.attachment; }
}

beforeEach(() => {
  (globalThis as any).WebSocketPair = class {
    0 = new FakeSocket();
    1 = new FakeSocket();
  };
});
afterEach(() => {
  delete (globalThis as any).WebSocketPair;
});

async function fixture() {
  const sqlite = new Database(":memory:");
  for (const name of readdirSync(migrations).filter((s) => s.endsWith(".sql")).sort())
    for (const sql of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) sqlite.run(sql);
  sqlite.run("PRAGMA foreign_keys=OFF");
  sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('shop','shop-code','A',0,0,80,'u')");
  sqlite.run("INSERT INTO shop_billing_settings(shop_id,billing_enabled,auto_register) VALUES ('shop',1,1)");
  sqlite.run(
    `INSERT INTO api_tokens(shop_id,id,label,role,token_prefix,token_hash,status,created_at)
     VALUES ('shop','t1','bot','integration','integ',?, 'active', '2026-01-01')`,
    [await sha256Hex(TOKEN)],
  );
  const sockets: FakeSocket[] = [];
  const state = new Map<string, unknown>();
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    storage: {
      async get<T>(key: string) { return structuredClone(state.get(key)) as T | undefined; },
      async put(key: string, value: unknown) { state.set(key, structuredClone(value)); },
      async delete(key: string | string[]) { for (const k of [key].flat()) state.delete(k); return true; },
      async list({ prefix }: { prefix: string }) { return new Map([...state].filter(([k]) => k.startsWith(prefix))); },
      async setAlarm() {},
      async deleteAlarm() {},
    },
    acceptWebSocket(ws: FakeSocket) { sockets.push(ws); },
    getWebSockets() { return sockets; },
    waitUntil(task: Promise<unknown>) { tasks.push(task); },
  };
  const env = {
    DB: createD1DatabaseFromSqlite(sqlite),
    SESSION_SECRET: "s",
    RATE_LIMIT_5: { limit: async () => ({ success: true }) },
  };
  const hub = new ShopHub(ctx as any, env as any);
  const response = await hub.fetch(new Request("https://prism.test/api/v1/shops/shop-code/integration/ws", {
    headers: { Upgrade: "websocket", authorization: `Bearer ${TOKEN}`, "x-prism-hub-shop": "shop", "x-prism-hub-shop-code": "shop-code" },
  }));
  expect(response.status).toBe(101);
  const ws = sockets[0]!;
  const send = async (frame: unknown) => {
    await hub.webSocketMessage(ws as any, JSON.stringify(frame));
    return JSON.parse(ws.sent.at(-1) ?? "null");
  };
  return { sqlite, hub, ws, send, state };
}

describe("bot connection", () => {
  it("runs a request through the shop's integration routes with the bot's token", async () => {
    const { send, sqlite } = await fixture();
    const reply = await send({ type: "request", id: "r1", method: "GET", path: "integration/sessions/active" });
    expect(reply).toMatchObject({ type: "response", id: "r1", status: 200, body: { data: { sessions: [] } } });
    sqlite.close();
  });

  it("answers a resent write from memory instead of running it twice", async () => {
    const { send, sqlite } = await fixture();
    const frame = {
      type: "request", id: "w1", method: "POST", path: "integration/players/by-identity/register",
      body: { identity: { provider: "onebot", subject: "10001" }, displayName: "A" },
    };
    const first = await send(frame);
    expect(first.status).toBe(200);
    const second = await send(frame);
    expect(second).toEqual(first);
    expect((sqlite.query("SELECT COUNT(*) AS n FROM players").get() as { n: number }).n).toBe(1);
    sqlite.close();
  });

  it("refuses paths outside the shop's integration routes", async () => {
    const { send, sqlite } = await fixture();
    expect((await send({ type: "request", id: "x", method: "GET", path: "staff/settings" })).status).toBe(404);
    expect((await send({ type: "request", id: "y", method: "GET", path: "integration/../staff/settings" })).status).toBe(404);
    sqlite.close();
  });

  it("ends the connection once its token is revoked", async () => {
    const { send, ws, sqlite } = await fixture();
    sqlite.run("UPDATE api_tokens SET status='revoked'");
    const reply = await send({ type: "request", id: "r2", method: "GET", path: "integration/sessions/active" });
    expect(reply.status).toBe(403);
    expect(ws.closed?.code).toBe(4003);
    sqlite.close();
  });

  it("pushes idle reminders to the bot and learns how early it wants them", async () => {
    const { hub, ws, send, sqlite, state } = await fixture();
    await hub.webSocketMessage(ws as any, JSON.stringify({ type: "hello", reminderLeadSeconds: 300 }));
    expect((ws.attachment as { reminderLeadMs: number }).reminderLeadMs).toBe(300_000);
    expect(state.has("touchAt")).toBe(true);
    await (hub as any).notify([{ reason: "shop_empty", at: 1, devices: [{ id: "m1", name: "舞萌" }] }]);
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({
      type: "event", event: "idle.reminder", data: { reason: "shop_empty", at: 1, devices: [{ id: "m1", name: "舞萌" }] },
    });
    void send;
    sqlite.close();
  });
});

describe("bot connection route", () => {
  it("hands an authenticated upgrade to the shop's hub, and refuses a bad token", async () => {
    const { createApp } = await import("../src/app.js");
    const { sqlite } = await fixture();
    const env = { DB: createD1DatabaseFromSqlite(sqlite), SESSION_SECRET: "s" } as any;
    const forwarded: Request[] = [];
    env.SHOP_HUB = { getByName: () => ({ async fetch(request: Request) { forwarded.push(request); return new Response(null, { status: 204 }); } }) };
    const connect = (token: string) => createApp().fetch(new Request("https://prism.test/api/v1/shops/shop-code/integration/ws", {
      headers: { Upgrade: "websocket", authorization: `Bearer ${token}` },
    }), env);
    expect((await connect("wrong")).status).toBe(403);
    expect(forwarded).toHaveLength(0);
    await connect(TOKEN);
    expect(forwarded[0]?.headers.get("x-prism-hub-shop")).toBe("shop");
    expect(forwarded[0]?.headers.get("x-prism-hub-shop-code")).toBe("shop-code");
    sqlite.close();
  });
});

describe("bot frames", () => {
  it("only reads well-formed requests", () => {
    expect(parseBotFrame("{")).toBeNull();
    expect(parseBotFrame(JSON.stringify({ type: "request", id: "", method: "GET", path: "integration/x" }))).toBeNull();
    expect(parseBotFrame(JSON.stringify({ type: "request", id: "a", method: "DELETE", path: "integration/x" }))).toBeNull();
    expect(parseBotFrame(JSON.stringify({ type: "hello", reminderLeadSeconds: -1 }))).toEqual({ type: "hello" });
  });

  it("maps paths to the shop's routes only", () => {
    expect(botRequestUrl("s", "integration/players/by-identity/wallet")?.pathname).toBe("/api/v1/shops/s/integration/players/by-identity/wallet");
    expect(botRequestUrl("s", "/version")?.pathname).toBe("/version");
    expect(botRequestUrl("s", "integration/sessions/active", { a: 1 })?.search).toBe("?a=1");
    expect(botRequestUrl("s", "player/me")).toBeNull();
  });
});
