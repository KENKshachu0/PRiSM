/**
 * Who occupies a resource: the rules every source follows.
 *
 * A capability decides what its events mean (see `providers.ts`); these rules
 * decide what an observation does to the people already there:
 *
 * - Someone already on the resource is seen again: their stay is extended.
 * - Someone new arrives: they occupy it. When it is full, whoever started
 *   earliest is replaced.
 * - Nobody is seen for the resource's occupancy time: their stay ends by
 *   timeout, at the moment it ran out.
 *
 * Only known players occupy anything: a card the shop cannot tie to a player
 * says nothing about who is there. A resource with capacity 0 is never occupied.
 */

export type OpenOccupancy = {
  id: string;
  playerId: string;
  startedAt: Date;
  lastSeenAt: Date;
  /** Null while its source ends it explicitly. */
  expiresAt: Date | null;
};

/** What a capability concluded from one of its events. */
export type OccupancyObservation =
  /** The player is using the resource now (a card taken by the game, a coin). */
  | { kind: "occupy"; playerId: string }
  /** The player is still on it (the game signed their card in); nobody new arrives. */
  | { kind: "refresh"; playerId: string };

export type OccupancyPlan = {
  end: Array<{ id: string; reason: "replaced" }>;
  refresh: string[];
  start: { playerId: string } | null;
};

/** Whether an open stay is still running at `at`. */
export function isOpen(occupancy: Pick<OpenOccupancy, "expiresAt">, at: Date): boolean {
  return occupancy.expiresAt === null || occupancy.expiresAt.getTime() > at.getTime();
}

export function planObservation(input: {
  /** The resource's stays still running. */
  open: readonly OpenOccupancy[];
  capacity: number;
  observation: OccupancyObservation;
}): OccupancyPlan {
  const plan: OccupancyPlan = { end: [], refresh: [], start: null };
  if (input.capacity <= 0) return plan;
  const { playerId } = input.observation;
  const same = input.open.find((occupancy) => occupancy.playerId === playerId);
  if (same) {
    plan.refresh.push(same.id);
    return plan;
  }
  if (input.observation.kind === "refresh") return plan;
  const byStart = [...input.open].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id));
  const over = byStart.length - input.capacity + 1;
  for (const occupancy of byStart.slice(0, Math.max(0, over))) plan.end.push({ id: occupancy.id, reason: "replaced" });
  plan.start = { playerId };
  return plan;
}
