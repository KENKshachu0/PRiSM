/**
 * How a HINATA IO tells who is at its cabinet.
 *
 * - The game took a card (`card.consumed`): the card's owner occupies the
 *   cabinet, for physical cards on its reader and cards the platform sent
 *   alike. A card nobody bound here tells nothing: the cabinet stays as it is,
 *   and a coin from its holder through the platform tells who it was.
 * - A swipe or a coin requested through the platform for a player: that player
 *   occupies it, which is all a relay that reports nothing back tells.
 *
 * Switching a cabinet on, or keeping it from idling, says nothing about who
 * plays; those only hold off the idle power-off.
 */
import type { OccupancyProvider } from "../occupancy/providers.js";

export const hinataOccupancy: OccupancyProvider = {
  capability: "hinata_io",
  authority: 10,
  fromAction({ action, playerId }) {
    if (!playerId) return null;
    return action === "coin" || action === "aime.scan" ? { kind: "occupy", playerId } : null;
  },
  fromSignal({ name, playerId }) {
    if (!playerId) return null;
    if (name === "card.consumed") return { kind: "occupy", playerId };
    return null;
  },
};
