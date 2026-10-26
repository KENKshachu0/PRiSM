import { describe, expect, test } from "bun:test";
import type { OperationLockRepository } from "@prism/core";
import { PLAYER_BILLING_LOCK_SCOPE, withOperationLease } from "../src/index";

function memoryLocks(): OperationLockRepository & { acquired: string[] } {
  const held = new Map<string, string>();
  const acquired: string[] = [];
  return {
    acquired,
    async acquire(scope, resourceId, id) {
      const key = `${scope}:${resourceId}`;
      if (held.has(key)) return false;
      held.set(key, id);
      acquired.push(key);
      return true;
    },
    async release(scope, resourceId, id) {
      const key = `${scope}:${resourceId}`;
      if (held.get(key) === id) held.delete(key);
    },
  } as OperationLockRepository & { acquired: string[] };
}

const lease = (repository: OperationLockRepository, resourceId = "player-1") => ({
  repository,
  scope: PLAYER_BILLING_LOCK_SCOPE,
  resourceId,
  now: () => new Date("2026-10-24T00:00:00.000Z"),
});

describe("withOperationLease", () => {
  test("lets a holder take the same lease again instead of failing", async () => {
    const locks = memoryLocks();
    const result = await withOperationLease(lease(locks), () =>
      withOperationLease(lease(locks), async () => "nested"),
    );
    expect(result).toBe("nested");
    expect(locks.acquired).toEqual([`${PLAYER_BILLING_LOCK_SCOPE}:player-1`]);
  });

  test("still refuses a concurrent caller outside the holder's call chain", async () => {
    const locks = memoryLocks();
    let release!: () => void;
    const holding = withOperationLease(lease(locks), () => new Promise<void>((resolve) => (release = resolve)));
    await Promise.resolve();
    await expect(withOperationLease(lease(locks), async () => "second")).rejects.toMatchObject({
      code: "OPERATION_IN_PROGRESS",
    });
    release();
    await holding;
    expect(await withOperationLease(lease(locks), async () => "after")).toBe("after");
  });

  test("does not treat a different player as already held", async () => {
    const locks = memoryLocks();
    await withOperationLease(lease(locks, "player-1"), () =>
      withOperationLease(lease(locks, "player-2"), async () => undefined),
    );
    expect(locks.acquired).toEqual([
      `${PLAYER_BILLING_LOCK_SCOPE}:player-1`,
      `${PLAYER_BILLING_LOCK_SCOPE}:player-2`,
    ]);
  });
});
