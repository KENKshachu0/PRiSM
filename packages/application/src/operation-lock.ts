import { PrismDomainError, type OperationLockRepository } from "@prism/core";
import { leaseContext } from "#lease-context";

/**
 * The one lease that guards a player's billing state.
 *
 * Starting a session, stopping one and checking out read the same active set and
 * write the same rows, so they must exclude each other: a checkout under a
 * different lease could settle a snapshot while a start added a session, leaving
 * it unbilled. Wallet, redeem and item purchases already used this scope, so the
 * stored value stays `player.assets` and leases held during a deployment remain
 * compatible.
 */
export const PLAYER_BILLING_LOCK_SCOPE = "player.assets";

/**
 * Runs `action` while holding a TTL lease, failing fast when another holder has it.
 *
 * Re-entrant within one async call chain: a caller already holding the same
 * scope and resource runs `action` directly, so a route that takes the player
 * lease can call a service that takes it too.
 */
export async function withOperationLease<T>(input: {
  repository?: OperationLockRepository;
  scope: string;
  resourceId: string;
  id?: () => string;
  now: () => Date;
  ttlMs?: number;
}, action: () => Promise<T>): Promise<T> {
  if (!input.repository) return action();
  const key = `${input.scope}\u0000${input.resourceId}`;
  const held = leaseContext.held();
  if (held?.has(key)) return action();

  const now = input.now();
  const lockId = input.id?.() ?? crypto.randomUUID();
  const acquired = await input.repository.acquire(
    input.scope,
    input.resourceId,
    lockId,
    now,
    new Date(now.getTime() + (input.ttlMs ?? 60_000)),
  );
  if (!acquired) throw new PrismDomainError("Operation is already in progress.", "OPERATION_IN_PROGRESS");
  try {
    return await leaseContext.run(new Set([...(held ?? []), key]), action);
  } finally {
    await input.repository.release(input.scope, input.resourceId, lockId);
  }
}
