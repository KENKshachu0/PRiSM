/**
 * Who is in the shop, and where.
 *
 * Someone is in the shop while they play anywhere or bill anything: every
 * player occupying a resource (a cabinet, a mahjong seat) and every player
 * with an active session. Each of them is listed once, at
 * their most specific place:
 *
 * 1. The resource they occupy, with its head count and capacity. Someone seen
 *    on two resources (they moved before the first timed out) is listed at the
 *    one they were seen on last.
 * 2. Otherwise their most specific plan: among the plans they bill, one that
 *    none of the others requires (an add-on rather than the base it needs);
 *    the latest started when several qualify, then by name.
 *
 * Asking for one resource or one plan by name lists everyone on that resource,
 * or everyone billing that plan, wherever they are listed otherwise.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import type { StaffActiveSessionListItem } from "@prism/application";
import { buildPricingRelationGraph, isStartablePricingKind, type PricingConfig, type PricingRelationGraph } from "@prism/core";
import type { OccupancyService, ResourceOccupancy } from "./occupancy/service.js";

export type RosterMember = {
  playerId: string;
  displayName: string | null;
  identities: Array<{ provider: string; subject: string }>;
  since: Date;
};

export type RosterGroup =
  | { kind: "resource"; id: string; name: string; capacity: number; members: RosterMember[] }
  /** `id` is null for the unpriced placeholder session of a shop without time plans. */
  | { kind: "plan"; id: string | null; name: string; members: RosterMember[] };

export type Roster = { total: number; groups: RosterGroup[] };

/** What the unpriced placeholder session is called. */
const PLACEHOLDER_PLAN_NAME = "计费";

type InShop = {
  playerId: string;
  displayName: string;
  identities: Array<{ provider: string; subject: string }>;
  sessions: StaffActiveSessionListItem[];
};

function relationGraph(plans: readonly PricingConfig[]): PricingRelationGraph | null {
  try {
    return buildPricingRelationGraph(plans.filter((plan) => isStartablePricingKind(plan.kind)));
  } catch {
    return null;
  }
}

/** Every plan `planId` needs, directly or through another. */
function requiredBy(graph: PricingRelationGraph | null, planId: string): Set<string> {
  const found = new Set<string>();
  const visit = (id: string) => {
    for (const dependency of graph?.requiresOf(id) ?? []) {
      if (found.has(dependency)) continue;
      found.add(dependency);
      visit(dependency);
    }
  };
  visit(planId);
  return found;
}

/** The session that places a player when they occupy nothing. */
export function mostSpecificSession<S extends { pricingConfigId?: string | null; startedAt: Date }>(
  sessions: readonly S[],
  graph: PricingRelationGraph | null,
  nameOf: (planId: string) => string,
): S | undefined {
  const needed = new Set(sessions.flatMap((session) => session.pricingConfigId ? [...requiredBy(graph, session.pricingConfigId)] : []));
  const candidates = sessions.filter((session) => !session.pricingConfigId || !needed.has(session.pricingConfigId));
  return [...(candidates.length ? candidates : sessions)].sort((a, b) =>
    b.startedAt.getTime() - a.startedAt.getTime()
    || (a.pricingConfigId ? nameOf(a.pricingConfigId) : "").localeCompare(b.pricingConfigId ? nameOf(b.pricingConfigId) : ""))[0];
}

export function createRoster(dependencies: {
  db: D1DatabaseLike;
  shopId: string;
  /** Every active session in the shop with its player's identities. */
  listActiveSessions(): Promise<StaffActiveSessionListItem[]>;
  /** The shop's plans, archived ones included, for names and relations. */
  listPlans(): Promise<readonly PricingConfig[]>;
  occupancy: OccupancyService;
}) {
  const { db, shopId } = dependencies;

  async function read() {
    const [sessions, plans, resources] = await Promise.all([
      dependencies.listActiveSessions(),
      dependencies.listPlans(),
      dependencies.occupancy.current(),
    ]);
    const players = new Map<string, InShop>();
    for (const session of sessions) {
      const player = players.get(session.playerId) ?? {
        playerId: session.playerId,
        displayName: session.playerDisplayName,
        identities: session.identities ?? [],
        sessions: [],
      };
      player.sessions.push(session);
      players.set(session.playerId, player);
    }
    // Occupants who bill nothing are still in the shop; their identities let a bot name them.
    const strangers = [...new Set(resources.flatMap((resource) => resource.occupants)
      .flatMap((occupant) => players.has(occupant.playerId) ? [] : [occupant.playerId]))];
    const identities = new Map<string, Array<{ provider: string; subject: string }>>();
    if (strangers.length) {
      const rows = await db.prepare(
        `SELECT player_id, provider, subject FROM player_identities
         WHERE shop_id = ? AND player_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, provider, subject`,
      ).bind(shopId, JSON.stringify(strangers)).all<{ player_id: string; provider: string; subject: string }>();
      for (const row of rows.results) {
        identities.set(row.player_id, [...(identities.get(row.player_id) ?? []), { provider: row.provider, subject: row.subject }]);
      }
    }
    const names = new Map(plans.map((plan) => [plan.id, plan.name]));
    return { players, resources, identities, graph: relationGraph(plans), nameOf: (id: string) => names.get(id) ?? id, plans };
  }

  type Read = Awaited<ReturnType<typeof read>>;

  function member(state: Read, occupant: ResourceOccupancy["occupants"][number]): RosterMember {
    const player = state.players.get(occupant.playerId);
    return {
      playerId: occupant.playerId,
      displayName: occupant.displayName ?? player?.displayName ?? null,
      identities: player?.identities ?? state.identities.get(occupant.playerId) ?? [],
      since: occupant.since,
    };
  }

  const inShopMember = (player: InShop, since: Date): RosterMember => ({
    playerId: player.playerId, displayName: player.displayName, identities: player.identities, since,
  });

  const total = (groups: RosterGroup[]) => groups.reduce((sum, group) => sum + group.members.length, 0);

  return {
    async list(): Promise<Roster> {
      const state = await read();
      // Where each known occupant is listed: the resource they were seen on last.
      const placeOf = new Map<string, { resourceId: string; seen: number }>();
      for (const resource of state.resources) {
        for (const occupant of resource.occupants) {
          const seen = occupant.lastSeenAt.getTime();
          const current = placeOf.get(occupant.playerId);
          if (!current || seen > current.seen) placeOf.set(occupant.playerId, { resourceId: resource.resourceId, seen });
        }
      }
      const planGroups = new Map<string, RosterGroup & { kind: "plan" }>();
      for (const player of state.players.values()) {
        if (placeOf.has(player.playerId)) continue;
        const session = mostSpecificSession(player.sessions, state.graph, state.nameOf)!;
        const id = session.pricingConfigId ?? null;
        const key = id ?? "";
        const group = planGroups.get(key) ?? { kind: "plan" as const, id, name: id ? state.nameOf(id) : PLACEHOLDER_PLAN_NAME, members: [] };
        group.members.push(inShopMember(player, session.startedAt));
        planGroups.set(key, group);
      }
      const resourceGroups: RosterGroup[] = state.resources.flatMap((resource) => {
        const members = resource.occupants
          .filter((occupant) => placeOf.get(occupant.playerId)?.resourceId === resource.resourceId)
          .map((occupant) => member(state, occupant));
        return members.length
          ? [{ kind: "resource" as const, id: resource.resourceId, name: resource.name, capacity: resource.capacity, members }]
          : [];
      });
      const groups = [...planGroups.values(), ...resourceGroups];
      return { total: total(groups), groups };
    },

    /** One resource (by name or alias) or one plan (by name), or null when nothing is called that. */
    async only(name: string): Promise<Roster | null> {
      const wanted = name.trim().toLowerCase();
      if (!wanted) return null;
      const state = await read();
      const aliases = await db.prepare("SELECT id, aliases_json FROM machines WHERE shop_id = ?")
        .bind(shopId).all<{ id: string; aliases_json: string | null }>();
      const aliasOf = new Map(aliases.results.map((row) => {
        try {
          const parsed: unknown = JSON.parse(row.aliases_json ?? "[]");
          return [row.id, Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []];
        } catch {
          return [row.id, []];
        }
      }));
      const resource = state.resources.find((candidate) =>
        candidate.name.trim().toLowerCase() === wanted
        || (aliasOf.get(candidate.resourceId) ?? []).some((alias) => alias.trim().toLowerCase() === wanted));
      if (resource) {
        const group: RosterGroup = {
          kind: "resource", id: resource.resourceId, name: resource.name, capacity: resource.capacity,
          members: resource.occupants.map((occupant) => member(state, occupant)),
        };
        return { total: group.members.length, groups: [group] };
      }
      const plan = state.plans.find((candidate) => candidate.name.trim().toLowerCase() === wanted);
      if (!plan) return null;
      const members = [...state.players.values()].flatMap((player) => {
        const session = player.sessions.find((candidate) => candidate.pricingConfigId === plan.id);
        return session ? [inShopMember(player, session.startedAt)] : [];
      });
      return { total: members.length, groups: [{ kind: "plan", id: plan.id, name: plan.name, members }] };
    },

    /** Whether one player is in the shop: the plans they bill and the resources they occupy. */
    async ofPlayer(playerId: string) {
      const state = await read();
      const player = state.players.get(playerId);
      const occupying = state.resources.filter((resource) => resource.occupants.some((occupant) => occupant.playerId === playerId));
      return {
        inShop: !!player || occupying.length > 0,
        plans: (player?.sessions ?? []).map((session) => ({
          pricingConfigId: session.pricingConfigId ?? null,
          planName: session.pricingConfigId ? state.nameOf(session.pricingConfigId) : PLACEHOLDER_PLAN_NAME,
          startedAt: session.startedAt,
        })),
        occupying: occupying.map((resource) => ({ resourceId: resource.resourceId, name: resource.name })),
      };
    },
  };
}

export type RosterService = ReturnType<typeof createRoster>;
