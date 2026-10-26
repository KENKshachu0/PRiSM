/**
 * A mahjong table's seats are who occupies it, and nothing outranks them.
 *
 * A seat lives as long as the session it currently runs on: while the table
 * waits to fill, the table's own plan (the waiting plan); once the table
 * plays, the table plan's session. Starting the table plan may end the waiting
 * session (the two can conflict); the seat then follows the table plan. A seat
 * whose session ended, by checkout or by staff, is gone, and so is one whose
 * player was disabled.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import type { OccupancyProvider } from "../occupancy/providers.js";

/** Seats still taken, as a subquery over `mahjong_seats`. */
export const liveSeatsSql = `SELECT ms.* FROM mahjong_seats ms
 WHERE EXISTS (SELECT 1 FROM players p WHERE p.shop_id = ms.shop_id AND p.id = ms.player_id AND p.status = 'active')
 AND (
   EXISTS (SELECT 1 FROM sessions s WHERE s.shop_id = ms.shop_id AND s.id = ms.session_id AND s.status = 'active')
   OR (
     NOT EXISTS (SELECT 1 FROM sessions s WHERE s.shop_id = ms.shop_id AND s.id = ms.session_id)
     AND (ms.entry_session_id IS NULL OR EXISTS (
       SELECT 1 FROM sessions e WHERE e.shop_id = ms.shop_id AND e.id = ms.entry_session_id AND e.status = 'active'))
   )
 )`;

export const mahjongOccupancy: OccupancyProvider = {
  capability: "mahjong",
  authority: 100,
  async held(db: D1DatabaseLike, shopId: string) {
    const rows = await db.prepare(
      `SELECT ms.machine_id, ms.player_id, ms.joined_at, ms.session_id, ms.entry_session_id
       FROM (${liveSeatsSql}) ms WHERE ms.shop_id = ? ORDER BY ms.joined_at, ms.player_id`,
    ).bind(shopId).all<{ machine_id: string; player_id: string; joined_at: string; session_id: string | null; entry_session_id: string | null }>();
    return rows.results.map((row) => ({
      resourceId: row.machine_id,
      playerId: row.player_id,
      since: new Date(row.joined_at),
      sessionIds: [row.entry_session_id, row.session_id].filter((id): id is string => !!id),
    }));
  },
};
