/**
 * Calling the shop hub. Kept apart from the Durable Object class so modules the
 * class itself imports can use it without an import cycle.
 */
import type { Env } from "../bindings.js";
import type { HaReport } from "../hardware/aimeio-relay.js";
import type { WatchedState } from "./shop-hub.js";

type ShopHubNamespace = {
  getByName(name: string): {
    relayOnline(shopId: string, machineId: string, channel: string): Promise<void>;
    relayOffline(shopId: string, machineId: string): Promise<void>;
    refresh(shopId: string): Promise<void>;
    readState(connectionId: string, entityId: string): Promise<WatchedState | null>;
    watcher(): Promise<{ machineId: string; leaseUntil: number } | null>;
    haReport(shopId: string, machineId: string, report: HaReport): Promise<void>;
    touch(shopId: string): Promise<void>;
  };
};

export function shopHub(env: Env, shopId: string) {
  return (env.SHOP_HUB as unknown as ShopHubNamespace | undefined)?.getByName(shopId) ?? null;
}

/** A watched state, or null without a hub or a current watcher. Never throws. */
export async function watchedState(env: Env, shopId: string, connectionId: string, entityId: string): Promise<WatchedState | null> {
  try {
    return (await shopHub(env, shopId)?.readState(connectionId, entityId)) ?? null;
  } catch {
    return null;
  }
}

/** Ask the hub to rebuild what is watched. Failures only cost freshness, so they are logged. */
export async function refreshShopHub(env: Env, shopId: string): Promise<void> {
  try {
    await shopHub(env, shopId)?.refresh(shopId);
  } catch (error) {
    console.error("Shop hub refresh failed", error);
  }
}

/**
 * Tell the hub something that may change idle state happened. Never throws; run
 * after the response when an execution context is at hand.
 */
export function touchShopHub(env: Env, shopId: string, ctx?: { waitUntil(promise: Promise<unknown>): void } | null): void {
  const task = (async () => {
    try {
      await shopHub(env, shopId)?.touch(shopId);
    } catch (error) {
      console.error("Shop hub touch failed", error);
    }
  })();
  if (ctx) ctx.waitUntil(task);
}

/** `touchShopHub` from a Hono handler, after the response. */
export function touchShopHubAfter(c: { env: Env; executionCtx: { waitUntil(promise: Promise<unknown>): void } }, shopId: string): void {
  let ctx: { waitUntil(promise: Promise<unknown>): void } | null = null;
  try {
    ctx = c.executionCtx;
  } catch {
    // Local server and tests: nothing would keep the call alive.
    return;
  }
  touchShopHub(c.env, shopId, ctx);
}
