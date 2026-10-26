import { describe, expect, it } from "bun:test";
import type {
  Session,
  SessionRepository,
} from "@prism/core";
import { createPlayerCommandService } from "../src/index";

class MemorySessionRepository implements SessionRepository {
  saved: Session[] = [];

  constructor(private readonly activeSession: Session | null = null) {}

  async findActiveByPlayerId(playerId: string): Promise<Session[]> {
    if (this.activeSession?.playerId !== playerId || this.activeSession?.status !== "active") return [];
    return [this.activeSession];
  }

  async findById(sessionId: string): Promise<Session | null> {
    return this.saved.find((s) => s.id === sessionId) ?? (this.activeSession?.id === sessionId ? this.activeSession : null);
  }

  async findUnpaidClosedByPlayerId(playerId: string): Promise<Session[]> {
    return this.saved.filter((s) => s.playerId === playerId && s.status === "closed" && s.paymentStatus === "unpaid");
  }

  async save(session: Session): Promise<void> {
    this.saved = this.saved.filter((s) => s.id !== session.id);
    this.saved.push(session);
  }
}

describe("createPlayerCommandService", () => {
  it("starts a session through core rules and persists it", async () => {
    const sessions = new MemorySessionRepository();
    const service = createPlayerCommandService({
      sessions,
      now: () => new Date("2026-06-07T10:00:00.000Z"),
      id: () => "session-1",
    });

    const result = await service.startSession({
      playerId: "player-1",
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
    expect(sessions.saved).toEqual([result]);
  });

  it("rejects starting a session when the current time is outside billable business intervals", async () => {
    const sessions = new MemorySessionRepository();
    const service = createPlayerCommandService({
      sessions,
      now: () => new Date("2026-06-07T09:00:00.000Z"),
      id: () => "session-closed",
      canStartSessionAt: async () => false,
    });

    await expect(service.startSession({ playerId: "player-1", pricingConfigIds: ["config-1"] })).rejects.toThrow("Player cannot start a billing session outside billable business intervals.");
    expect(sessions.saved).toEqual([]);
  });

  it("starts a session when the current time matches a billable business interval", async () => {
    const sessions = new MemorySessionRepository();
    const service = createPlayerCommandService({
      sessions,
      now: () => new Date("2026-06-07T10:00:00.000Z"),
      id: () => "session-open",
      canStartSessionAt: async () => true,
    });

    const result = await service.startSession({ playerId: "player-1", pricingConfigIds: ["config-1"] });

    expect(result.id).toBe("session-open");
    expect(sessions.saved).toEqual([result]);
  });

  it("rejects starting a session with a duplicate label for the same player", async () => {
    const activeSession = {
      id: "session-1",
      playerId: "player-1",
      startedAt: new Date("2026-06-07T10:00:00.000Z"),
      status: "active" as const,
      pricingConfigIds: ["config-1"],
      paymentStatus: "unpaid" as const,
      label: "login",
    };
    const service = createPlayerCommandService({
      sessions: new MemorySessionRepository(activeSession),
      now: () => new Date("2026-06-07T10:05:00.000Z"),
      id: () => "session-2",
    });

    await expect(
      service.startSession({
        playerId: "player-1",
        pricingConfigIds: ["config-1"],
        label: "login",
      })
    ).rejects.toThrow("Player already has an active session with label 'login'.");
  });
});
