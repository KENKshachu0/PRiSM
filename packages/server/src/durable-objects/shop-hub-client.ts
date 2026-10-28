/**
 * Calling the shop hub. Kept apart from the Durable Object class so modules the
 * class itself imports can use it without an import cycle.
 */
import type { Env } from "../bindings.js";
import type { HaReport } from "../hardware/aimeio-relay.js";

type ShopHubNamespace = {
  getByName(name: string): {
    relayOnline(shopId: string, machineId: string, channel: string): Promise<void>;
    relayOffline(shopId: string, machineId: string): Promise<void>;
    markDown(shopId: string, machineId: string): Promise<void>;
    refresh(shopId: string): Promise<void>;
    watching(): Promise<Array<{ machineId: string; leaseUntil: number }>>;
    haReport(shopId: string, machineId: string, report: HaReport): Promise<void>;
    touch(shopId: string): Promise<void>;
    notifyUser(userId: string, frame: Record<string, unknown>): Promise<void>;
    botsChanged(): Promise<void>;
    shopEvent(event: Record<string, unknown>): Promise<void>;
    idleSchedule(): Promise<Record<string, number>>;
  };
};

export function shopHub(env: Env, shopId: string) {
  return (env.SHOP_HUB as unknown as ShopHubNamespace | undefined)?.getByName(shopId) ?? null;
}

/** When the idle rules will switch each device off. Empty when the hub cannot be asked. */
export async function idleSchedule(env: Env, shopId: string): Promise<Record<string, number>> {
  try {
    return (await shopHub(env, shopId)?.idleSchedule()) ?? {};
  } catch (error) {
    console.error("Shop hub idle schedule failed", error);
    return {};
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

/** The platform switched this HINATA IO off: the hub need not wait for it. Never throws. */
export async function markWatcherDown(env: Env, shopId: string, machineId: string): Promise<void> {
  try {
    await shopHub(env, shopId)?.markDown(shopId, machineId);
  } catch (error) {
    console.error("Shop hub mark down failed", error);
  }
}

/**
 * Tell a user's open device pages that something they show changed (for
 * example a bot just confirmed their binding), so they read it now instead of
 * waiting for a poll. Never throws; run after the response when an execution
 * context is at hand.
 */
export function notifyUserPages(
  env: Env,
  shopId: string,
  userId: string,
  frame: Record<string, unknown>,
  ctx?: { waitUntil(promise: Promise<unknown>): void } | null,
): void {
  const task = (async () => {
    try {
      await shopHub(env, shopId)?.notifyUser(userId, frame);
    } catch (error) {
      console.error("Shop hub notify failed", error);
    }
  })();
  if (ctx) ctx.waitUntil(task);
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

/**
 * Tell the shop's connected bots to reread their configuration. Never throws;
 * run after the response when an execution context is at hand.
 */
export function notifyBotsChanged(env: Env, shopId: string, ctx?: { waitUntil(promise: Promise<unknown>): void } | null): void {
  const task = (async () => {
    try {
      await shopHub(env, shopId)?.botsChanged();
    } catch (error) {
      console.error("Shop hub bot notify failed", error);
    }
  })();
  if (ctx) ctx.waitUntil(task);
}

/** `notifyBotsChanged` from a Hono handler, after the response. */
export function notifyBotsChangedAfter(c: { env: Env; executionCtx: { waitUntil(promise: Promise<unknown>): void } }, shopId: string): void {
  let ctx: { waitUntil(promise: Promise<unknown>): void } | null = null;
  try {
    ctx = c.executionCtx;
  } catch {
    // Local server and tests: nothing would keep the call alive.
    return;
  }
  notifyBotsChanged(c.env, shopId, ctx);
}

/** Hand a shop event to the hub for its bots to announce. Never throws: an event is best effort. */
export async function sendShopEvent(env: Env, shopId: string, event: Record<string, unknown>): Promise<void> {
  try {
    await shopHub(env, shopId)?.shopEvent(event);
  } catch (error) {
    console.error("Shop hub event failed", error);
  }
}
