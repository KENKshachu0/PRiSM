import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type { DeviceEvent, DeviceOperation } from "@prism/core";
import type { SqlValue } from "../src/repositories";
import { createDeviceEventRepository, sqliteSchema, type SqlExecutor } from "../src/index";

function executorFor(db: Database): SqlExecutor {
  return {
    shopId: "shop",
    async first<T>(sql: string, params: readonly SqlValue[] = []) {
      return (db.query(sql).get(...(params as SqlValue[])) as T | null) ?? null;
    },
    async all<T>(sql: string, params: readonly SqlValue[] = []) {
      return db.query(sql).all(...(params as SqlValue[])) as T[];
    },
    async run(sql: string, params: readonly SqlValue[] = []) {
      db.query(sql).run(...(params as SqlValue[]));
    },
    async batch(statements) {
      db.transaction(() => {
        for (const statement of statements) db.query(statement.sql).run(...((statement.params ?? []) as SqlValue[]));
      })();
    },
  };
}

function fixture() {
  const db = new Database(":memory:");
  for (const statement of sqliteSchema) db.run(statement);
  db.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('shop','p1','P1','active','2026-01-01T00:00:00.000Z')");
  return { db, repo: createDeviceEventRepository(executorFor(db)) };
}

let seq = 0;
function event(overrides: Partial<DeviceEvent> = {}): DeviceEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    deviceId: "m1",
    capability: "power",
    kind: "change",
    name: "power",
    operationId: null,
    parentOperationId: null,
    origin: "observer",
    playerId: null,
    staffId: null,
    payload: {},
    occurredAt: new Date(Date.UTC(2026, 1, 1, 10, 0, seq)),
    ...overrides,
  };
}

function operation(overrides: Partial<DeviceOperation> = {}): DeviceOperation {
  return {
    id: "op1",
    deviceId: "m1",
    capability: "power",
    action: "power.on",
    parentId: null,
    playerId: "p1",
    staffId: null,
    status: "pending",
    countsAsPlay: true,
    failure: null,
    payload: {},
    requestedAt: new Date("2026-02-01T10:00:00.000Z"),
    settledAt: null,
    confirmedAt: null,
    ...overrides,
  };
}

const powerState = (value: string) => ({
  deviceId: "m1",
  capability: "power",
  key: "power",
  value,
  authority: "observed" as const,
});

describe("device event repository", () => {
  it("records a change only when the value actually changes", async () => {
    const { repo } = fixture();
    await repo.record({ events: [], states: [{ write: powerState("on"), event: event({ payload: { from: null, to: "on" } }) }] });
    // A repeated observation of the same value adds nothing.
    await repo.record({ events: [], states: [{ write: powerState("on"), event: event({ payload: { from: "on", to: "on" } }) }] });
    await repo.record({ events: [], states: [{ write: powerState("off"), event: event({ payload: { from: "on", to: "off" } }) }] });

    const events = await repo.listEvents({ deviceId: "m1", limit: 10 });
    expect(events.map((e) => e.payload.to)).toEqual(["off", "on"]);
    const [state] = await repo.listState(["m1"]);
    expect(state).toMatchObject({ value: "off", authority: "observed", eventId: events[0]!.id });
  });

  it("keeps the changed_at of the last real change across repeated observations", async () => {
    const { repo } = fixture();
    const first = event();
    await repo.record({ events: [], states: [{ write: powerState("on"), event: first }] });
    await repo.record({ events: [], states: [{ write: powerState("on"), event: event() }] });
    const [state] = await repo.listState();
    expect(state!.changedAt).toEqual(first.occurredAt);
  });

  it("creates an operation with its request and settles it once", async () => {
    const { repo } = fixture();
    await repo.record({ events: [event({ kind: "request", name: "power.on", operationId: "op1" })], operation: operation() });
    await repo.record({
      events: [event({ kind: "result", name: "power.on", operationId: "op1", payload: { outcome: "ok" } })],
      settle: { operationId: "op1", status: "succeeded", failure: null, settledAt: new Date("2026-02-01T10:00:01.000Z") },
    });
    // A late failure cannot overturn a recorded success.
    await repo.record({
      events: [],
      settle: { operationId: "op1", status: "failed", failure: "late", settledAt: new Date("2026-02-01T10:00:09.000Z") },
    });
    expect(await repo.getOperation("op1")).toMatchObject({ status: "succeeded", failure: null });
  });

  it("confirms an operation only the first time, and only from its own device", async () => {
    const { repo } = fixture();
    await repo.record({ events: [], operation: operation({ id: "scan", action: "aime.scan", capability: "hinata_io" }) });
    const first = new Date("2026-02-01T10:00:04.000Z");
    await repo.record({ events: [], confirm: { operationId: "scan", deviceId: "m2", confirmedAt: new Date("2026-02-01T10:00:02.000Z") } });
    expect((await repo.getOperation("scan"))!.confirmedAt).toBeNull();
    await repo.record({ events: [], confirm: { operationId: "scan", deviceId: "m1", confirmedAt: first } });
    await repo.record({ events: [], confirm: { operationId: "scan", deviceId: "m1", confirmedAt: new Date("2026-02-01T10:09:00.000Z") } });
    expect((await repo.getOperation("scan"))!.confirmedAt).toEqual(first);
  });

  it("writes nothing when a batch part fails", async () => {
    const { repo } = fixture();
    await repo.record({ events: [event({ id: "dup" })] });
    await expect(repo.record({
      events: [event({ id: "fresh" }), event({ id: "dup" })],
    })).rejects.toThrow();
    expect((await repo.listEvents({ deviceId: "m1", limit: 10 })).map((e) => e.id)).toEqual(["dup"]);
  });

  it("lists a player's operations in request order", async () => {
    const { repo } = fixture();
    await repo.record({ events: [], operation: operation({ id: "b", requestedAt: new Date("2026-02-02T00:00:00.000Z") }) });
    await repo.record({ events: [], operation: operation({ id: "a", requestedAt: new Date("2026-02-01T00:00:00.000Z") }) });
    expect((await repo.listOperationsByPlayer("p1")).map((o) => o.id)).toEqual(["a", "b"]);
  });
});
