import { describe, expect, it } from "bun:test";
import {
  extractSessionIds,
  playerIdFromPayload,
  playerIdsFromPayload,
  sessionEventForPath,
} from "../src/routes/shops/live-activity-events.js";
import {
  liveActivityStartPayload,
  liveActivityEndPayload,
  liveActivityUpdatePayload,
} from "../src/durable-objects/live-activity-push.js";

describe("Live Activity API compatibility across channels", () => {
  it("recognizes start and end mutations on player, staff and integration routes", () => {
    for (const path of [
      "session/start", "players/id/session/start", "players/by-identity/session/start",
      "remote-entry",
      "profiles/id/entry",
    ]) expect(sessionEventForPath(path)).toBe("start");
    for (const path of [
      "checkout/confirm", "checkout/override", "sessions/active/checkout",
      "players/id/checkout/confirm", "players/by-identity/checkout/confirm",
      "players/id/checkout/recharge", "profiles/id/checkout/confirm", "sessions/abc/stop",
      "players/id/sessions/abc/stop", "players/by-identity/sessions/abc/stop",
    ]) expect(sessionEventForPath(path)).toBe("end");
    expect(sessionEventForPath("players")).toBeNull();
    expect(sessionEventForPath("checkout/preview")).toBeNull();
  });

  it("finds session and player IDs from each historical response shape", () => {
    const start = { session: { id: "session-1", playerId: "player-1" } };
    expect(extractSessionIds(start, "start")).toEqual(["session-1"]);
    expect(playerIdFromPayload(start)).toBe("player-1");

    const stopped = { session: { id: "session-1", playerId: "player-1" } };
    expect(extractSessionIds(stopped, "end")).toEqual(["session-1"]);

    const settled = { playerSettlement: { playerId: "player-2" },
      sessionDetails: [{ sessionId: "session-2", playerId: "player-2" }] };
    expect(extractSessionIds(settled, "end")).toEqual(["session-2"]);
    expect(playerIdFromPayload(settled)).toBe("player-2");

    const batch = { settlements: [
      { playerSettlement: { playerId: "a" }, sessions: [{ sessionId: "1" }] },
      { playerSettlement: { playerId: "b" }, sessions: [{ sessionId: "2" }] },
    ] };
    expect(playerIdsFromPayload(batch).sort()).toEqual(["a", "b"]);
    expect(extractSessionIds(batch, "end")).toEqual(["1", "2"]);
    expect(playerIdsFromPayload({ assetLedgerEntries: [{ playerId: "a" }] })).toEqual(["a"]);
    expect(playerIdsFromPayload({ holdings: [{ playerId: "a" }] })).toEqual(["a"]);
    expect(playerIdsFromPayload({ redeemRecord: { playerId: "a" } })).toEqual(["a"]);
    expect(playerIdsFromPayload({ businessItemOrder: { playerId: "a" } })).toEqual(["a"]);
  });

  it("uses APNs ActivityKit start/end payloads, including sessionId and shopCode", () => {
    const started = liveActivityStartPayload({
      sessionId: "s1", shopCode: "demo", shopName: "Example", startedAtUnix: 100, now: 110,
    }) as { aps: Record<string, any> };
    expect(started.aps.event).toBe("start");
    expect(started.aps.attributes).toMatchObject({ sessionId: "s1", shopCode: "demo" });
    expect(started.aps["content-state"].phase).toBe("active");
    const ended = liveActivityEndPayload({ startedAtUnix: 100, endedAtUnix: 200 }) as {
      aps: Record<string, any>;
    };
    expect(ended.aps.event).toBe("end");
    expect(ended.aps["content-state"]).toMatchObject({ phase: "ended", startedAtUnix: 100, endedAtUnix: 200 });
  });

  it("carries one bounded forecast in start/update payloads and drops it when billing stops", () => {
    const bill = { amountCents: 0, planLabel: "方案".repeat(80), nextEvent: { atUnix: 220, label: "下次计费" }, asOfUnix: 100 };
    const nextBill = { ...bill, amountCents: 200, nextEvent: { atUnix: 340, label: "下次计费" }, asOfUnix: 220 };
    const inputs = { startedAtUnix: 100, now: 101, bill, nextBill, staleAfterSeconds: 119 };
    for (const payload of [liveActivityUpdatePayload(inputs),
      liveActivityStartPayload({ ...inputs, sessionId: "s", shopCode: "mmw", shopName: "牧喵窝" })]) {
      const aps = payload.aps as Record<string, any>;
      expect(aps["content-state"].nextBill).toEqual(nextBill);
      expect(aps["stale-date"]).toBe(220);
      expect(new TextEncoder().encode(JSON.stringify(payload)).length).toBeLessThan(4096);
    }
    const stopped = liveActivityUpdatePayload({ ...inputs, endedAtUnix: 200 }).aps as Record<string, any>;
    expect(stopped["content-state"].nextBill).toBeUndefined();
  });
});
