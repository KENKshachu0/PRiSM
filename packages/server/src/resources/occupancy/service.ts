/**
 * Who occupies the shop's resources, now and before.
 *
 * Event-driven capabilities (a cabinet's IO) report observations through
 * `observe`; the rules in `rules.ts` turn them into stays. Capabilities that
 * hold their occupants themselves (a mahjong table's seats) are read as they
 * are, and their stays are mirrored into the same history by `syncHeld`.
 *
 * Every stay is a row of `resource_occupancies`; an open row whose
 * `expires_at` has passed ended then, by timeout, and is closed lazily.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import type { CapabilityId } from "../capabilities/catalog.js";
import { heldProviders, occupancyProviderFor, type HeldOccupant } from "./providers.js";
import { planObservation, type OpenOccupancy } from "./rules.js";

export type Occupant = {
  playerId: string;
  displayName: string | null;
  since: Date;
  lastSeenAt: Date;
  /** Null while its source ends it explicitly (a seat). */
  expiresAt: Date | null;
};

export type ResourceOccupancy = {
  resourceId: string;
  name: string;
  capacity: number;
  /** The capability that decides who is on it. */
  source: CapabilityId;
  occupants: Occupant[];
};

export type OccupancyHistoryEntry = {
  id: string;
  playerId: string;
  displayName: string | null;
  source: string;
  startedAt: Date;
  lastSeenAt: Date;
  /** Null while the stay is running. */
  endedAt: Date | null;
  endReason: "timeout" | "replaced" | "left" | "billing_ended" | null;
};

export type OccupancyEvent =
  | { kind: "action"; action: import("../capabilities/catalog.js").ActionName; playerId: string | null }
  | { kind: "signal"; name: string; payload: Record<string, unknown>; playerId: string | null };

type Row = {
  id: string;
  resource_id: string;
  player_id: string;
  source: string;
  started_at: string;
  last_seen_at: string;
  expires_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  session_ids_json: string;
  display_name?: string | null;
};

const toOpen = (row: Row): OpenOccupancy => ({
  id: row.id,
  playerId: row.player_id,
  startedAt: new Date(row.started_at),
  lastSeenAt: new Date(row.last_seen_at),
  expiresAt: row.expires_at ? new Date(row.expires_at) : null,
});

export function createOccupancy(deps: { db: D1DatabaseLike; shopId: string; now?: () => Date }) {
  const { db, shopId } = deps;
  const now = deps.now ?? (() => new Date());

  /** Each resource's capacity, occupancy time and deciding capability. */
  async function settings(resourceId?: string) {
    const [machines, capabilities] = await Promise.all([
      db.prepare(
        `SELECT id, name, capacity, occupancy_minutes FROM machines
         WHERE shop_id = ? AND enabled = 1 ${resourceId ? "AND id = ?" : ""}`,
      ).bind(...(resourceId ? [shopId, resourceId] : [shopId])).all<{ id: string; name: string; capacity: number; occupancy_minutes: number }>(),
      db.prepare(
        `SELECT device_id, capability FROM device_capabilities WHERE shop_id = ? ${resourceId ? "AND device_id = ?" : ""}`,
      ).bind(...(resourceId ? [shopId, resourceId] : [shopId])).all<{ device_id: string; capability: CapabilityId }>(),
    ]);
    const capabilitiesOf = new Map<string, CapabilityId[]>();
    for (const row of capabilities.results) {
      capabilitiesOf.set(row.device_id, [...(capabilitiesOf.get(row.device_id) ?? []), row.capability]);
    }
    return machines.results.flatMap((machine) => {
      const provider = occupancyProviderFor(capabilitiesOf.get(machine.id) ?? []);
      if (!provider) return [];
      if (machine.capacity <= 0) return [];
      return [{ id: machine.id, name: machine.name, capacity: machine.capacity, minutes: machine.occupancy_minutes, provider }];
    });
  }

  /** Close stays whose time ran out, at the moment it did. */
  const closeTimedOut = (at: Date, resourceId?: string) =>
    db.prepare(
      `UPDATE resource_occupancies SET ended_at = expires_at, end_reason = 'timeout'
       WHERE shop_id = ? ${resourceId ? "AND resource_id = ?" : ""} AND ended_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?`,
    ).bind(...(resourceId ? [shopId, resourceId, at.toISOString()] : [shopId, at.toISOString()])).run();

  /**
   * Mirror held occupants (seats) into the stays: a new seat opens a stay; a
   * seat that is gone ends its stay when the sessions it depended on ended,
   * or now if they did not.
   */
  async function syncHeld(at = now()) {
    if (!heldProviders.length) return;
    const held: Array<HeldOccupant & { source: CapabilityId }> = [];
    for (const provider of heldProviders) {
      for (const occupant of await provider.held!(db, shopId)) held.push({ ...occupant, source: provider.capability });
    }
    const sources = heldProviders.map((provider) => provider.capability);
    const open = (await db.prepare(
      `SELECT * FROM resource_occupancies WHERE shop_id = ? AND ended_at IS NULL AND source IN (SELECT value FROM json_each(?))`,
    ).bind(shopId, JSON.stringify(sources)).all<Row>()).results;
    const key = (resourceId: string, playerId: string) => `${resourceId}\u0000${playerId}`;
    const heldKeys = new Set(held.map((occupant) => key(occupant.resourceId, occupant.playerId)));
    const openKeys = new Set(open.map((row) => key(row.resource_id, row.player_id)));
    const statements = [
      ...open.filter((row) => !heldKeys.has(key(row.resource_id, row.player_id))).map((row) =>
        db.prepare(
          `UPDATE resource_occupancies SET end_reason = 'billing_ended',
             ended_at = COALESCE((SELECT MAX(ended_at) FROM sessions WHERE shop_id = ? AND status = 'closed'
               AND id IN (SELECT value FROM json_each(?))), ?)
           WHERE shop_id = ? AND id = ? AND ended_at IS NULL`,
        ).bind(shopId, row.session_ids_json, at.toISOString(), shopId, row.id)),
      ...held.filter((occupant) => !openKeys.has(key(occupant.resourceId, occupant.playerId))).map((occupant) =>
        db.prepare(
          `INSERT INTO resource_occupancies(shop_id, id, resource_id, player_id, source, started_at, last_seen_at, expires_at, session_ids_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        ).bind(shopId, crypto.randomUUID(), occupant.resourceId, occupant.playerId, occupant.source,
          occupant.since.toISOString(), occupant.since.toISOString(), JSON.stringify(occupant.sessionIds))),
    ];
    if (statements.length) await db.batch(statements);
  }

  return {
    /** What an action or a device signal says about who is on a resource. */
    /** Record what an action or signal says about who is on a resource; `started` is whoever it put on newly. */
    async observe(input: { resourceId: string; event: OccupancyEvent; at?: Date }): Promise<{ started: { playerId: string } | null }> {
      const none = { started: null };
      const at = input.at ?? now();
      const [resource] = await settings(input.resourceId);
      if (!resource || resource.provider.held) return none;
      const { provider } = resource;
      const observation = input.event.kind === "action"
        ? provider.fromAction?.({ action: input.event.action, playerId: input.event.playerId }) ?? null
        : provider.fromSignal?.({
            name: input.event.name,
            payload: input.event.payload,
            playerId: input.event.playerId,
          }) ?? null;
      if (!observation) return none;
      await closeTimedOut(at, resource.id);
      const open = (await db.prepare(
        "SELECT * FROM resource_occupancies WHERE shop_id = ? AND resource_id = ? AND source = ? AND ended_at IS NULL",
      ).bind(shopId, resource.id, provider.capability).all<Row>()).results.map(toOpen);
      const plan = planObservation({ open, capacity: resource.capacity, observation });
      const expires = new Date(at.getTime() + resource.minutes * 60_000).toISOString();
      const statements = [
        ...plan.end.map((end) =>
          db.prepare("UPDATE resource_occupancies SET ended_at = ?, end_reason = ? WHERE shop_id = ? AND id = ? AND ended_at IS NULL")
            .bind(at.toISOString(), end.reason, shopId, end.id)),
        ...plan.refresh.map((id) =>
          db.prepare("UPDATE resource_occupancies SET last_seen_at = ?, expires_at = ? WHERE shop_id = ? AND id = ? AND ended_at IS NULL")
            .bind(at.toISOString(), expires, shopId, id)),
        ...(plan.start
          ? [db.prepare(
              `INSERT INTO resource_occupancies(shop_id, id, resource_id, player_id, source, started_at, last_seen_at, expires_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(shopId, crypto.randomUUID(), resource.id, plan.start.playerId, provider.capability,
              at.toISOString(), at.toISOString(), expires)]
          : []),
      ];
      if (statements.length) await db.batch(statements);
      return { started: plan.start ? { playerId: plan.start.playerId } : null };
    },

    /** A held occupant left on their own (got up from a seat). */
    async left(input: { resourceId: string; playerId: string; at?: Date }): Promise<void> {
      await db.prepare(
        `UPDATE resource_occupancies SET ended_at = ?, end_reason = 'left'
         WHERE shop_id = ? AND resource_id = ? AND player_id = ? AND ended_at IS NULL`,
      ).bind((input.at ?? now()).toISOString(), shopId, input.resourceId, input.playerId).run();
    },

    syncHeld,

    /**
     * Whether a player holds a place on the resource that a capability keeps
     * itself (a seat). Such a place is backed by billing that runs for it, so
     * holding it counts as using the resource even when the resource's own plan
     * was replaced (a table that started playing ends its waiting plan).
     */
    async holds(resourceId: string, playerId: string): Promise<boolean> {
      for (const provider of heldProviders) {
        const held = await provider.held!(db, shopId);
        if (held.some((occupant) => occupant.resourceId === resourceId && occupant.playerId === playerId)) return true;
      }
      return false;
    },

    /** Every resource that can be occupied, with who is on it now. */
    async current(): Promise<ResourceOccupancy[]> {
      const at = now();
      await syncHeld(at);
      const resources = await settings();
      const rows = (await db.prepare(
        `SELECT o.*, p.display_name FROM resource_occupancies o
         LEFT JOIN players p ON p.shop_id = o.shop_id AND p.id = o.player_id
         WHERE o.shop_id = ? AND o.ended_at IS NULL AND (o.expires_at IS NULL OR o.expires_at > ?)
         ORDER BY o.started_at, o.rowid`,
      ).bind(shopId, at.toISOString()).all<Row>()).results;
      return resources.map((resource) => ({
        resourceId: resource.id,
        name: resource.name,
        capacity: resource.capacity,
        source: resource.provider.capability,
        occupants: rows
          .filter((row) => row.resource_id === resource.id && row.source === resource.provider.capability)
          .map((row) => ({
            playerId: row.player_id,
            displayName: row.display_name ?? null,
            since: new Date(row.started_at),
            lastSeenAt: new Date(row.last_seen_at),
            expiresAt: row.expires_at ? new Date(row.expires_at) : null,
          })),
      }));
    },

    /** Stays on one resource, newest first. */
    async history(resourceId: string, options: { limit?: number; before?: Date } = {}): Promise<OccupancyHistoryEntry[]> {
      const at = now();
      await syncHeld(at);
      await closeTimedOut(at, resourceId);
      const rows = (await db.prepare(
        `SELECT o.*, p.display_name FROM resource_occupancies o
         LEFT JOIN players p ON p.shop_id = o.shop_id AND p.id = o.player_id
         WHERE o.shop_id = ? AND o.resource_id = ? AND o.started_at < ?
         ORDER BY o.started_at DESC, o.rowid DESC LIMIT ?`,
      ).bind(shopId, resourceId, options.before?.toISOString() ?? "9999-12-31T23:59:59.999Z", Math.min(options.limit ?? 50, 200)).all<Row>()).results;
      return rows.map((row) => ({
        id: row.id,
        playerId: row.player_id,
        displayName: row.display_name ?? null,
        source: row.source,
        startedAt: new Date(row.started_at),
        lastSeenAt: new Date(row.last_seen_at),
        endedAt: row.ended_at ? new Date(row.ended_at) : null,
        endReason: (row.end_reason as OccupancyHistoryEntry["endReason"]) ?? null,
      }));
    },
  };
}

export type OccupancyService = ReturnType<typeof createOccupancy>;
