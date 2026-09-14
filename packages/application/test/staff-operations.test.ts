import { centsOf } from "@prism/core";
import { describe, expect, it } from "bun:test";
import { createStaffOperationsService } from "../src/staff-operations";

describe("createStaffOperationsService", () => {
  it("checks out each active player once even when they have multiple sessions", async () => {
    const checkedOut: string[] = [];
    const service = createStaffOperationsService({
      staffQueries: {
        async listPlayers() {
          return [];
        },
        async listActiveSessions() {
          return [
            activeSession("session-1", "player-1"),
            activeSession("session-2", "player-1"),
            activeSession("session-3", "player-2"),
          ];
        },
      },
      checkout: {
        async checkout({ playerId }) {
          checkedOut.push(playerId);
          return { playerId };
        },
      },
      now: () => new Date("2026-07-16T10:00:00.000Z"),
    });

    await expect(service.checkoutAllActivePlayers()).resolves.toEqual([
      { playerId: "player-1" },
      { playerId: "player-2" },
    ]);
    expect(checkedOut).toEqual(["player-1", "player-2"]);
  });
});

function activeSession(id: string, playerId: string) {
  return {
    id,
    playerId,
    playerDisplayName: playerId,
    startedAt: new Date("2026-07-16T09:00:00.000Z"),
    elapsedMinutes: 60,
  };
}

it('live list skips empty venues and bounds preview concurrency to four players', async () => {
  const now = new Date('2026-09-12T12:00:00Z');
  let occupied = false, playerReads = 0, pricingReads = 0, running = 0, peak = 0;
  const ids = Array.from({length: 9}, (_, i) => `p${i}`);
  const service = createStaffOperationsService({
    now: () => now,
    staffQueries: {
      listActiveSessions: async () => occupied ? ids.map(playerId => ({
        id: `s-${playerId}`, playerId, playerDisplayName: playerId,
        startedAt: now, elapsedMinutes: 0,
      })) : [],
      listPlayers: async (input) => {
        playerReads++;
        expect(input?.playerIds).toEqual(ids);
        return ids.map(id => ({id, displayName: id, status: 'active' as const,
          walletTotal: centsOf(10), activeSessionId: `s-${id}`,
          identities: [{provider: 'qq', subject: id, createdAt: now}],
        }));
      },
    },
    listPricingConfigs: async () => { pricingReads++; return []; },
    checkout: {
      checkout: async () => { throw new Error('listing must not settle'); },
      previewCheckout: async () => {
        peak = Math.max(peak, ++running);
        await new Promise(resolve => setTimeout(resolve, 5));
        running--;
        return {settlementPreview: {total: 3}, sessionPreviews: []};
      },
    },
  });
  expect(await service.listLivePlayers()).toEqual([]);
  expect(playerReads + pricingReads).toBe(0);
  occupied = true;
  const rows = await service.listLivePlayers();
  expect(rows).toHaveLength(9);
  expect(peak).toBe(4);
  expect(playerReads).toBe(1);
  expect(pricingReads).toBe(1);
  expect(rows.every(row => row.estimatedTotal === 3 && row.walletTotal === 10 && row.identities?.length === 1)).toBe(true);
});
