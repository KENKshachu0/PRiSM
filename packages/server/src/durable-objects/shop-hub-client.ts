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
