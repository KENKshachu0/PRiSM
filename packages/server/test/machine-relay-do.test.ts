import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { deviceEventSchema } from "@prism/storage-sql";
import { MachineRelay } from "../src/durable-objects/machine-relay.js";

// Bun has no `WebSocketPair`; a Durable Object upgrade only needs it to exist so
// the 101 response can be built. The server end must be a recording double,
// otherwise a replayed frame cannot be asserted.
beforeEach(() => {
  (globalThis as any).WebSocketPair = class {
    readonly 0: FakeSocket;
    readonly 1: FakeSocket;
    constructor() {
      this[0] = new FakeSocket();
      this[1] = new FakeSocket();
    }
  };
});
afterEach(() => {
  delete (globalThis as any).WebSocketPair;
});

/** Minimal hibernation-socket double that records what the DO sends. */
class FakeSocket {
  readonly sent: string[] = [];
  readonly attachment = { ref: null as unknown };
  closed: { code?: number; reason?: string } | null = null;

  send(payload: string) {
    this.sent.push(payload);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  serializeAttachment(value: unknown) {
    this.attachment.ref = value;
  }
  deserializeAttachment() {
    return this.attachment.ref;
  }
}

function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.run(`CREATE TABLE players(shop_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(shop_id, id))`);
  for (const statement of deviceEventSchema) sqlite.run(statement);
  const state = new Map<string, unknown>();
  const sockets: FakeSocket[] = [];
  const ctx = {
    storage: {
      async get<T>(key: string) { return state.get(key) as T | undefined; },
      async put(key: string, value: unknown) { state.set(key, value); },
      async delete(key: string) { return state.delete(key); },
    },
    acceptWebSocket(ws: FakeSocket) { sockets.push(ws); },
    getWebSockets() { return sockets; },
  };
  const env = { DB: createD1DatabaseFromSqlite(sqlite) };
  const relay = new MachineRelay(ctx as any, env as any);
  const events = () =>
    sqlite.query<{ name: string; operation_id: string | null; sequence: number | null }, []>(
      `SELECT name, operation_id, json_extract(payload_json,'$.sequence') AS sequence
       FROM device_events WHERE kind='signal' ORDER BY occurred_at, rowid`,
    ).all();
  const link = () =>
    sqlite.query<{ to: string }, []>(
      `SELECT json_extract(payload_json,'$.to') AS "to" FROM device_events
       WHERE kind='change' AND name='link' ORDER BY occurred_at, rowid`,
    ).all().map((row) => row.to);
  return { relay, ctx, sockets, sqlite, state, events, link, env };
}

/** Attach an agent socket the way an authenticated upgrade would. */
function attachAgent(sockets: FakeSocket[]) {
  const ws = new FakeSocket();
  ws.serializeAttachment({ cardProtocol: 2, clientVersion: "1.2.0", role: "agent" });
  sockets.push(ws);
  return ws;
}

describe("MachineRelay delivery", () => {
  it("refuses an upgrade that did not come through the authenticated gateway", async () => {
    const { relay } = fixture();
    const response = await relay.fetch(
      new Request("https://prism.test/io/ws", { headers: { Upgrade: "websocket" } }),
    );
    expect(response.status).toBe(400);
  });

  it("refuses a non-upgrade request", async () => {
    const { relay } = fixture();
    const response = await relay.fetch(new Request("https://prism.test/io/ws"));
    expect(response.status).toBe(426);
  });

  it("sends a card with the operation id as source", async () => {
    const { relay, sockets } = fixture();
    const ws = attachAgent(sockets);
    const result = await relay.sendCard({ accessCode: "01234567890123456789", source: "op-1" });
    expect(result.ok).toBe(true);
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      action: "SET_CARD",
      body: { type: "aime", value: "01234567890123456789", disposable: true, source: "op-1" },
    });
  });

  it("reports offline instead of silently succeeding when no device is connected", async () => {
    const { relay } = fixture();
    const result = await relay.sendCard({ accessCode: "01234567890123456789" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("未在线");
  });

  it("sends a key press with the replay and expiry fields the device requires", async () => {
    const { relay, sockets } = fixture();
    const ws = attachAgent(sockets);
    const result = await relay.sendKeyPress({ key: 32, count: 2, messageId: "coin-1", expiresAt: 1_800_000_030_000 });
    expect(result.ok).toBe(true);
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      action: "KEY_PRESS",
      body: { key: 32, count: 2, message_id: "coin-1", expires_at: 1_800_000_030_000 },
    });
  });

  it("rejects an out-of-range coin key or count before touching the socket", async () => {
    const { relay, sockets } = fixture();
    const ws = attachAgent(sockets);
    expect((await relay.sendKeyPress({ key: 0, messageId: "c", expiresAt: Date.now() })).ok).toBe(false);
    expect((await relay.sendKeyPress({ key: 70000, messageId: "c", expiresAt: Date.now() })).ok).toBe(false);
    expect((await relay.sendKeyPress({ key: 32, count: 21, messageId: "c", expiresAt: Date.now() })).ok).toBe(false);
    expect(ws.sent).toEqual([]);
  });

  it("refuses to send plaintext to a device that announced e2ee", async () => {
    // Such a device rejects every plaintext command, so sending would look like
    // a silent failure on the machine's screen.
    const { relay, sockets } = fixture();
    attachAgent(sockets);
    await relay.webSocketMessage(
      sockets[0]! as any,
      JSON.stringify({ action: "CLIENT_HELLO", body: { e2ee: true, events: [] } }),
    );
    const result = await relay.sendCard({ accessCode: "01234567890123456789" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("remotePassword");
  });

  it("replays the stored card to a reconnecting device", async () => {
    const { relay, sockets, ctx } = fixture();
    attachAgent(sockets);
    await relay.sendCard({ accessCode: "01234567890123456789", source: "op-1" });
    // Drop the first socket and reconnect: the device cleared its card locally.
    sockets.length = 0;
    const response = await relay.fetch(
      new Request("https://prism.test/io/ws?role=agent", {
        headers: {
          Upgrade: "websocket",
          "x-prism-relay-shop": "shop-1",
          "x-prism-relay-machine": "machine-1",
        },
      }),
    );
    expect(response.status).toBe(101);
    expect(JSON.parse(sockets[0]!.sent[0]!).body.value).toBe("01234567890123456789");
    expect(ctx.getWebSockets()).toHaveLength(1);
  });

  it("replaces the stored card instead of accumulating them", async () => {
    // The stored state is what a reconnecting device is handed, so a newer card
    // must supersede the older one rather than leaving a stale value behind.
    const { relay, sockets, state } = fixture();
    attachAgent(sockets);
    await relay.sendCard({ accessCode: "01234567890123456789" });
    await relay.sendCard({ accessCode: "99887766554433221100" });
    expect((state.get("state-message") as { body: { value: string } }).body.value)
      .toBe("99887766554433221100");
  });

  it("does not store a key press as channel state", async () => {
    // Replaying a coin press to a reconnecting device would press it again.
    const { relay, sockets, state } = fixture();
    attachAgent(sockets);
    await relay.sendKeyPress({ key: 32, messageId: "coin-1", expiresAt: Date.now() + 30_000 });
    expect(state.has("state-message")).toBe(false);
  });
});

describe("MachineRelay IO events", () => {
  it("stores a card-consumed event with its operation id", async () => {
    const { relay, sockets, events } = fixture();
    const ws = attachAgent(sockets);
    await relay.fetch(
      new Request("https://prism.test/io/ws", {
        headers: {
          Upgrade: "websocket",
          "x-prism-relay-shop": "shop-1",
          "x-prism-relay-machine": "machine-1",
        },
      }),
    );
    await relay.webSocketMessage(
      ws as any,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event.cardConsumed",
        params: { interface: "aimeio", unit_no: 0, sequence: 2, card: { source: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b" } },
      }),
    );
    expect(events()).toEqual([{ name: "card.consumed", operation_id: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", sequence: 2 }]);
  });

  it("confirms the card operation of this device that the consumed card came from", async () => {
    const { relay, sockets, sqlite } = fixture();
    const operationId = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    for (const [id, device] of [[operationId, "machine-1"], ["7f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", "machine-2"]]) {
      sqlite.run(
        `INSERT INTO device_operations(shop_id,id,device_id,capability,action,status,counts_as_play,payload_json,requested_at)
         VALUES ('shop-1',?,?,'hinata_io','aime.scan','succeeded',1,'{}','2026-01-01T00:00:00.000Z')`,
        [id, device],
      );
    }
    const ws = attachAgent(sockets);
    await relay.fetch(
      new Request("https://prism.test/io/ws", {
        headers: { Upgrade: "websocket", "x-prism-relay-shop": "shop-1", "x-prism-relay-machine": "machine-1" },
      }),
    );
    for (const source of [operationId, "7f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"]) {
      await relay.webSocketMessage(
        ws as any,
        JSON.stringify({ jsonrpc: "2.0", method: "event.cardConsumed", params: { card: { source } } }),
      );
    }
    const confirmed = sqlite.query<{ id: string; confirmed_at: string | null }, []>(
      "SELECT id, confirmed_at FROM device_operations ORDER BY id",
    ).all();
    // A device can only confirm its own operation, whatever source it echoes.
    expect(confirmed.map((row) => [row.id, row.confirmed_at !== null])).toEqual([
      [operationId, true],
      ["7f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", false],
    ]);
  });

  it("never persists a per-frame LED update", async () => {
    // The game calls this every frame; storing it would be a write storm.
    const { relay, sockets, events } = fixture();
    const ws = attachAgent(sockets);
    await relay.fetch(
      new Request("https://prism.test/io/ws", {
        headers: {
          Upgrade: "websocket",
          "x-prism-relay-shop": "shop-1",
          "x-prism-relay-machine": "machine-1",
        },
      }),
    );
    await relay.webSocketMessage(
      ws as any,
      JSON.stringify({ jsonrpc: "2.0", method: "event.ledSet", params: { r: 1, g: 2, b: 3 } }),
    );
    expect(events()).toEqual([]);
  });

  it("ignores an unknown or malformed device message without throwing", async () => {
    const { relay, sockets, events } = fixture();
    const ws = attachAgent(sockets);
    await relay.webSocketMessage(ws as any, "{");
    await relay.webSocketMessage(ws as any, JSON.stringify({ action: "SOMETHING_ELSE" }));
    expect(events()).toEqual([]);
  });
});

describe("MachineRelay link state", () => {
  const upgrade = () =>
    new Request("https://prism.test/io/ws?client_version=1.2.0", {
      headers: { Upgrade: "websocket", "x-prism-relay-shop": "shop-1", "x-prism-relay-machine": "machine-1" },
    });

  it("records the IO coming online and going offline as state changes", async () => {
    const { relay, sockets, link } = fixture();
    await relay.fetch(upgrade());
    // A second connection while already online is not a change.
    await relay.fetch(upgrade());
    expect(link()).toEqual(["online"]);
    await relay.webSocketClose(sockets[0] as any, 1006, "");
    // Another agent is still connected.
    expect(link()).toEqual(["online"]);
    sockets.splice(0, 1);
    await relay.webSocketClose(sockets[0] as any, 1006, "");
    expect(link()).toEqual(["online", "offline"]);
  });

  it("remembers that a socket announced E2EE across hibernation", async () => {
    const { relay, ctx, sockets, env } = fixture();
    await relay.fetch(upgrade());
    await relay.webSocketMessage(
      sockets[0] as any,
      JSON.stringify({ action: "CLIENT_HELLO", body: { events: [], e2ee: true } }),
    );
    // A woken object is a new instance; only socket attachments survive.
    const woken = new MachineRelay(ctx as any, env as any);
    expect((await woken.getCapabilities()).e2ee).toBe(true);
    expect((await woken.sendCard({ accessCode: "12345678901234567890" })).ok).toBe(false);
  });
});

describe("MachineRelay capabilities", () => {
  it("reports the connected agent and its protocol", async () => {
    const { relay, sockets } = fixture();
    attachAgent(sockets);
    expect(await relay.getCapabilities()).toEqual({
      online: true,
      e2ee: false,
      agents: [{ cardProtocol: 2, clientVersion: "1.2.0" }],
    });
  });

  it("reports offline with no agent connected", async () => {
    const { relay } = fixture();
    expect((await relay.getCapabilities()).online).toBe(false);
  });
});
