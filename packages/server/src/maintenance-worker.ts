import type { DurableObject } from "cloudflare:workers";
import { deploymentControl, maintenanceResponse } from "./deployment-gate.js";
import type { Env } from "./bindings.js";
import { nextMaintenanceRetry, type MaintenanceWait } from "./durable-objects/alarm-budget.js";

let BaseDurableObject: typeof DurableObject;
try {
  // @ts-ignore
  const cf = await import("cloudflare:workers");
  BaseDurableObject = cf.DurableObject;
} catch {
  BaseDurableObject = class MockDurableObject {
    constructor(public ctx: any, public env: any) {}
  } as any;
}

/**
 * Keeps every declared Durable Object class and its storage alive while the
 * schema is migrated. The deploy script uses this module as `main` for the
 * maintenance and verify phases, so each class named in wrangler config must be
 * exported here or those deploys fail with "class not found".
 */
export class MachineRelay extends BaseDurableObject<Env> {
  async fetch(): Promise<Response> {
    // Devices reconnect after the deployment; nothing is served while fenced.
    return new Response("Maintenance", { status: 503 });
  }
}

/** Keeps the existing Durable Object class and storage; no business schema is touched. */
export class LiveBilling extends BaseDurableObject<Env> {
  async refresh(shopId: string, playerId: string, terminal = false, urgent = false): Promise<void> {
    const previous = await this.ctx.storage.get<{ revision: number; terminal?: boolean; urgent?: boolean }>("visit");
    await this.ctx.storage.put("visit", {
      shopId,
      playerId,
      revision: (previous?.revision ?? 0) + 1,
      terminal: terminal || previous?.terminal || false,
      urgent: urgent || previous?.urgent || false,
    });
    // A refresh must not overwrite the maintenance alarm or accelerate the
    // exponential backoff. The alarm handler is the sole retry scheduler.
    const pending = await this.ctx.storage.getAlarm();
    if (pending !== null && pending > Date.now()) return;
    await this.deferAlarm();
  }

  private async deferAlarm(): Promise<void> {
    const now = Date.now();
    const plan = nextMaintenanceRetry(
      await this.ctx.storage.get<MaintenanceWait>("maintenance-wait"), now,
    );
    if (plan.nextAt === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.put("maintenance-wait", plan.state);
    await this.ctx.storage.setAlarm(plan.nextAt);
  }

  async alarm(): Promise<void> {
    await this.deferAlarm();
  }
}

export default {
  async scheduled(): Promise<void> {
    /* Retention pauses while the schema is being migrated. */
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const control = await deploymentControl(
      request,
      env,
      async () => maintenanceResponse(request),
    );
    return control ?? maintenanceResponse(request);
  },
};
