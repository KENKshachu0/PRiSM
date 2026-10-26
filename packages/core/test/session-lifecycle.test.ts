import { describe, expect, it } from "bun:test";
import { closeSession, PrismDomainError, startSession } from "../src/index";

describe("startSession", () => {
  it("creates an active session with pricingConfigIds", () => {
    const result = startSession({
      playerId: "player-1",
      now: new Date("2026-06-07T10:00:00.000Z"),
      id: "session-1",
      pricingConfigIds: ["config-1"],
    });

    expect(result).toEqual({
      id: "session-1",
      playerId: "player-1",
      startedAt: new Date("2026-06-07T10:00:00.000Z"),
      status: "active",
      pricingConfigIds: ["config-1"],
      pricingConfigId: "config-1",
      paymentStatus: "unpaid",
    });
  });

  it("refuses a session that would bill several plans at once", () => {
    expect(() =>
      startSession({
        playerId: "player-1",
        now: new Date("2026-06-07T10:00:00.000Z"),
        id: "session-1",
        pricingConfigIds: ["config-1", "config-2"],
      }),
    ).toThrow(expect.objectContaining({ code: "PRICING_CONFIG_SINGLE_PLAN_REQUIRED" }));
  });

  it("gives an unpriced placeholder session no lifecycle plan", () => {
    const result = startSession({
      playerId: "player-1",
      now: new Date("2026-06-07T10:00:00.000Z"),
      id: "session-1",
      pricingConfigIds: ["default"],
    });
    expect(result.pricingConfigIds).toEqual(["default"]);
    expect(result.pricingConfigId).toBeUndefined();
  });

  it("rejects starting a session without pricingConfigIds", () => {
    expect(() =>
      startSession({
        playerId: "player-1",
        now: new Date("2026-06-07T10:05:00.000Z"),
        id: "session-2",
        pricingConfigIds: [],
      }),
    ).toThrow(
      expect.objectContaining({
        name: "PrismDomainError",
        code: "PRICING_CONFIG_REQUIRED",
      }) as PrismDomainError,
    );
  });
});

describe("closeSession", () => {
  it("closes an active session", () => {
    const result = closeSession({
      session: {
        id: "session-1",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        status: "active",
      },
      now: new Date("2026-06-07T10:30:00.000Z"),
    });

    expect(result).toEqual({
      id: "session-1",
      playerId: "player-1",
      startedAt: new Date("2026-06-07T10:00:00.000Z"),
      endedAt: new Date("2026-06-07T10:30:00.000Z"),
      status: "closed",
    });
  });

  it("rejects closing a non-active session", () => {
    expect(() =>
      closeSession({
        session: {
          id: "session-1",
          playerId: "player-1",
          startedAt: new Date("2026-06-07T10:00:00.000Z"),
          endedAt: new Date("2026-06-07T10:30:00.000Z"),
          status: "closed",
        },
        now: new Date("2026-06-07T10:31:00.000Z"),
      }),
    ).toThrow(
      expect.objectContaining({
        name: "PrismDomainError",
        code: "SESSION_NOT_ACTIVE",
      }) as PrismDomainError,
    );
  });
});
