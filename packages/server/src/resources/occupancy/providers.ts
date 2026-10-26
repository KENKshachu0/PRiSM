/**
 * Which capability says who occupies a resource.
 *
 * Each capability that can tell who is on a resource provides its own
 * reading of its events; this module only picks, per resource, the most
 * authoritative one it carries. A mahjong table's seats outrank anything a
 * cabinet's IO infers, and a game server's sign-ins (later) will outrank the
 * IO too. Capabilities that cannot tell (power, climate, a door) provide
 * nothing.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import type { ActionName, CapabilityId } from "../capabilities/catalog.js";
import { hinataOccupancy } from "../capabilities/hinata-io-occupancy.js";
import { mahjongOccupancy } from "../capabilities/mahjong-occupancy.js";
import type { OccupancyObservation } from "./rules.js";

/** Someone a capability itself holds on a resource, such as a seat. */
export type HeldOccupant = { resourceId: string; playerId: string; since: Date; sessionIds: string[] };

export type OccupancyProvider = {
  capability: CapabilityId;
  /** Higher wins when a resource carries several providers. */
  authority: number;
  /** What an action requested through the platform means; `playerId` is whom it was for. */
  fromAction?(input: { action: ActionName; playerId: string | null }): OccupancyObservation | null;
  /**
   * What a signal the device reported means. `playerId` is the owner of the
   * card it carried or of the operation it belongs to; null when nobody here
   * owns it.
   */
  fromSignal?(input: {
    name: string;
    payload: Record<string, unknown>;
    playerId: string | null;
  }): OccupancyObservation | null;
  /** A capability that holds its occupants itself (seats) lists them; no timeout applies. */
  held?(db: D1DatabaseLike, shopId: string): Promise<HeldOccupant[]>;
};

const providers: readonly OccupancyProvider[] = [hinataOccupancy, mahjongOccupancy];

/** The provider that decides who occupies a resource with these capabilities, or null. */
export function occupancyProviderFor(capabilities: Iterable<CapabilityId>): OccupancyProvider | null {
  let best: OccupancyProvider | null = null;
  for (const capability of capabilities) {
    const provider = providers.find((candidate) => candidate.capability === capability);
    if (provider && (!best || provider.authority > best.authority)) best = provider;
  }
  return best;
}

export const heldProviders = providers.filter((provider) => provider.held);
