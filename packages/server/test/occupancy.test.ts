import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { MachineRelay } from "../src/durable-objects/machine-relay.js";
import { createCardStore } from "../src/resources/cards.js";
import { createOccupancy } from "../src/resources/occupancy/service.js";
import { planObservation, type OpenOccupancy } from "../src/resources/occupancy/rules.js";

const KEY = "unit-test-key";
const MIN = 60_000;
const CARD_A = "01234567890123456789";
const CARD_B = "98765432109876543210";
const CARD_C = "11112222333344445555";

describe("occupancy rules", () => {
  const stay = (id: string, playerId: string, startedMinutesAgo: number): OpenOccupancy => ({
    id, playerId, startedAt: new Date(Date.now() - startedMinutesAgo * MIN), lastSeenAt: new Date(), expiresAt: null,
  });

  it("extends the stay of someone already there instead of adding them again", () => {
    expect(planObservation({ open: [stay("a", "p1", 5)], capacity: 1, observation: { kind: "occupy", playerId: "p1" } }))
      .toEqual({ end: [], refresh: ["a"], start: null });
  });

  it("replaces whoever started earliest when a full resource gets someone new", () => {
    const open = [stay("late", "p2", 1), stay("early", "p1", 9)];
    expect(planObservation({ open, capacity: 2, observation: { kind: "occupy", playerId: "p3" } }))
      .toEqual({ end: [{ id: "early", reason: "replaced" }], refresh: [], start: { playerId: "p3" } });
  });

  it("never occupies a resource of capacity 0, and only extends a known stay on a sign-in", () => {
    expect(planObservation({ open: [], capacity: 0, observation: { kind: "occupy", playerId: "p1" } }).start).toBeNull();
    expect(planObservation({ open: [], capacity: 1, observation: { kind: "refresh", playerId: "p1" } }))
      .toEqual({ end: [], refresh: [], start: null });
  });
});

function database() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=OFF");
  const migrations = resolve(import.meta.dir, "../../../migrations");
  for (const name of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort())
    for (const sql of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) sqlite.run(sql);
  // Users and shop membership are beside the point here.
  sqlite.run("PRAGMA foreign_keys=OFF");
  const now = new Date().toISOString();
  sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('shop','shop-code','Arcade',0,0,80,'u')");
  for (const [id, name] of [["p1", "Alice"], ["p2", "Bob"], ["p3", "Carol"]])
    sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('shop',?,?,'active',?)", [id, name, now]);
  // A two-player cabinet with a directly connected IO.
  sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted,capacity,occupancy_minutes) VALUES ('cab','cab-pub','shop','maimai','',2,15)");
  sqlite.run(`INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
    VALUES ('shop','cab','hinata_io','{"transport":"embedded","channel":"chan"}','{}',?,?)`, [now, now]);
  // An air conditioner nobody occupies.
  sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted) VALUES ('ac','ac-pub','shop','空调','')");
  sqlite.run(`INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
    VALUES ('shop','ac','climate','{}','{}',?,?)`, [now, now]);
  return { sqlite, db: createD1DatabaseFromSqlite(sqlite) };
}

describe("cards at a shop", () => {
  it("recognises a bound card without keeping its number, and refuses one bound to someone else", async () => {
    const { sqlite, db } = database();
    const cards = createCardStore(db, "shop", KEY);
    expect(await cards.bind({ playerId: "p1", card: { type: "aime", accessCode: CARD_A }, source: "scan" })).toBe("bound");
    expect(await cards.bind({ playerId: "p1", card: { type: "aime", accessCode: CARD_B }, source: "reader" })).toBe("bound");
    expect(await cards.bind({ playerId: "p2", card: { type: "aime", accessCode: CARD_A }, source: "scan" })).toBe("taken");
    expect(await cards.playerOf(CARD_A)).toBe("p1");
    expect(await cards.playerOf(CARD_C)).toBeNull();
    expect((await cards.listOf("p1")).length).toBe(2);
    expect(JSON.stringify(sqlite.query("SELECT * FROM player_cards").all())).not.toContain(CARD_A);
    // Another shop cannot match the same card by its hash.
    expect(await createCardStore(db, "other-shop", KEY).hashOf(CARD_A)).not.toBe(await cards.hashOf(CARD_A));
  });

  it("moves a card kept in the clear as an identity into the encrypted store when it is first needed", async () => {
    const { sqlite, db } = database();
    sqlite.run("INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) VALUES ('shop','p2','aime',?,?)", [CARD_C, new Date().toISOString()]);
    const cards = createCardStore(db, "shop", KEY);
    expect(await cards.latestOf("p2")).toBe(CARD_C);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM player_identities WHERE provider='aime'").get()).toEqual({ n: 0 });
    expect(await cards.playerOf(CARD_C)).toBe("p2");
  });
});

describe("occupancy from a cabinet's events", () => {
  it("keeps whoever is on a cabinet, replaces the earliest when full, and ends a stay by timeout", async () => {
    const { db } = database();
    let at = Date.now();
    const occupancy = createOccupancy({ db, shopId: "shop", now: () => new Date(at) });
    const coin = (playerId: string) => occupancy.observe({ resourceId: "cab", event: { kind: "action", action: "coin", playerId } });

    await coin("p1");
    at += MIN;
    await coin("p2");
    at += MIN;
    await coin("p3");
    const [cab, ...others] = await occupancy.current();
    expect(others).toEqual([]);
    expect(cab!.occupants.map((occupant) => occupant.displayName)).toEqual(["Bob", "Carol"]);
    expect(cab!.capacity).toBe(2);

    at += 16 * MIN;
    expect((await occupancy.current())[0]!.occupants).toEqual([]);
    const history = await occupancy.history("cab");
    expect(history.map((entry) => [entry.displayName, entry.endReason])).toEqual([
      ["Carol", "timeout"], ["Bob", "timeout"], ["Alice", "replaced"],
    ]);
    // A stay that timed out ended when its time ran out, not when it was noticed.
    expect(history[0]!.endedAt!.getTime()).toBe(history[0]!.lastSeenAt.getTime() + 15 * MIN);
  });

  it("ignores switching a cabinet on and anything done without a player", async () => {
    const { db } = database();
    const occupancy = createOccupancy({ db, shopId: "shop" });
    await occupancy.observe({ resourceId: "cab", event: { kind: "action", action: "power.on", playerId: "p1" } });
    await occupancy.observe({ resourceId: "cab", event: { kind: "action", action: "coin", playerId: null } });
    expect((await occupancy.current())[0]!.occupants).toEqual([]);
  });
});

describe("a cabinet's card reports", () => {
  beforeEach(() => {
    (globalThis as any).WebSocketPair = class { 0 = new FakeSocket(); 1 = new FakeSocket(); };
  });
  afterEach(() => {
    delete (globalThis as any).WebSocketPair;
  });

  class FakeSocket {
    readonly sent: string[] = [];
    private attachment: unknown = null;
    send(payload: string) { this.sent.push(payload); }
    close() {}
    serializeAttachment(value: unknown) { this.attachment = value; }
    deserializeAttachment() { return this.attachment; }
  }

  async function relayFixture() {
    const { sqlite, db } = database();
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
    const relay = new MachineRelay(ctx as any, { DB: db, URL_ENCRYPTION_KEY: KEY } as any);
    const agent = new FakeSocket();
    agent.serializeAttachment({ cardProtocol: 2, clientVersion: "1.2.0", role: "agent" });
    sockets.push(agent);
    await relay.fetch(new Request("https://prism.test/io/ws?role=agent", {
      headers: { Upgrade: "websocket", "x-prism-relay-shop": "shop", "x-prism-relay-machine": "cab" },
    }));
    const report = (method: "event.cardStateChanged" | "event.cardConsumed", accessCode: string) =>
      relay.webSocketMessage(agent as any, JSON.stringify({
        jsonrpc: "2.0",
        method,
        params: { interface: "aimeio", unit_no: 0, backend: "Hinata", card: { source: "HINATA(1)", card: { type: "aime", id: "", accessCode } } },
      }));
    return { sqlite, db, relay, report };
  }

  it("logs whose card it was instead of its number, has its owner occupy the cabinet, and ignores an unknown card", async () => {
    const { sqlite, db, report } = await relayFixture();
    await createCardStore(db, "shop", KEY).bind({ playerId: "p1", card: { type: "aime", accessCode: CARD_A }, source: "scan" });
    await report("event.cardConsumed", CARD_A);
    // A card nobody bound here tells nothing.
    await report("event.cardConsumed", CARD_C);

    const logged = sqlite.query("SELECT player_id, payload_json FROM device_events WHERE kind='signal'").all() as { player_id: string | null; payload_json: string }[];
    expect(logged.map((row) => row.player_id)).toEqual(["p1", null]);
    expect(logged.map((row) => row.payload_json).join()).not.toContain(CARD_A);
    expect(logged.map((row) => row.payload_json).join()).not.toContain(CARD_C);
    expect(JSON.parse(logged[0]!.payload_json).card).toEqual({ source: "HINATA(1)", type: "aime" });

    const [cab] = await createOccupancy({ db, shopId: "shop" }).current();
    expect(cab!.occupants.map((occupant) => [occupant.playerId, occupant.displayName])).toEqual([["p1", "Alice"]]);
  });

  it("adds the next card put on the reader to the player who opened the window", async () => {
    const { sqlite, relay, report } = await relayFixture();
    sqlite.run("INSERT INTO users(id,role,created_at,updated_at) VALUES ('user-2','user',?,?)", [new Date().toISOString(), new Date().toISOString()]);
    await relay.startCardCapture({ id: "cap", shopId: "shop", userId: "user-2", playerId: "p2", expiresAt: Date.now() + MIN });
    expect(await relay.cardCaptureResult("cap", "user-2")).toEqual({ status: "waiting" });
    await report("event.cardStateChanged", CARD_B);
    // Nobody else can read the outcome; its owner reads it once.
    expect(await relay.cardCaptureResult("cap", "someone-else")).toEqual({ status: "expired" });
    expect(await relay.cardCaptureResult("cap", "user-2")).toEqual({ status: "added", cardType: "aime" });
    expect(sqlite.query("SELECT user_id, card_type, access_code FROM cards").all())
      .toEqual([{ user_id: "user-2", card_type: "aime", access_code: CARD_B }]);
    expect(sqlite.query("SELECT player_id, source FROM player_cards").all()).toEqual([{ player_id: "p2", source: "reader" }]);
  });
});
