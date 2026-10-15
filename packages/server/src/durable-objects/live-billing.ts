import type { DurableObject } from "cloudflare:workers";
import { activityBill, type ActivityBill } from "./live-activity-billing.js";
import {
  LiveActivityPusher,
  liveActivityConfig,
  liveActivityEndPayload,
  liveActivityUpdatePayload,
} from "./live-activity-push.js";
import type { Env } from "../bindings.js";
import { isDeploymentMaintenance } from "../deployment-gate.js";
import {
  checkAlarmBudget,
  spendAlarmBudget,
  nextMaintenanceRetry,
  MIN_BILLING_ALARM_INTERVAL_MS,
  type AlarmBudget,
  type MaintenanceWait,
} from "./alarm-budget.js";

type Visit = { shopId: string; playerId: string; revision: number; terminal?: boolean; urgent?: boolean };
type Token = {
  id: string;
  token: string;
  environment: "sandbox" | "production";
  bundle_id: string;
  session_id: string;
  created_at: string;
  started_at: string;
  ended_at: string | null;
  payment_status: string;
  checkout_total: number | null;
  settled_at: string | null;
};

type Retry = { signature: string; failures: number; nextAt: number };
type Snapshot = Awaited<ReturnType<typeof activityBill>>;
type CachedBill = { revision: number; calculatedAt: number; snapshot: Snapshot };

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

export class LiveBilling extends BaseDurableObject<Env> {
  async refresh(shopId: string, playerId: string, terminal = false, urgent = false): Promise<void> {
    const previous = await this.ctx.storage.get<Visit>("visit");
    const visit: Visit = {
      shopId,
      playerId,
      revision: (previous?.revision ?? 0) + 1,
      terminal: terminal || previous?.terminal || false,
      urgent: urgent || previous?.urgent || false,
    };
    await this.ctx.storage.put("visit", visit);
    // Every DO has exactly one alarm. Do not keep pushing it forward under
    // frequent refreshes or override a deployment-maintenance backoff.
    const now = Date.now();
    if (await this.ctx.storage.get<MaintenanceWait>("maintenance-wait")) {
      // A maintenance alarm may still be scheduled long after the deployment
      // has resumed. Wake promptly only once maintenance is confirmed over.
      let maintenance = true;
      try { maintenance = await isDeploymentMaintenance(this.env); } catch { /* fail closed */ }
      if (maintenance) return;
      await this.ctx.storage.delete("maintenance-wait");
    }
    const gate = checkAlarmBudget(
      await this.ctx.storage.get<AlarmBudget>("alarm-budget"), now,
    );
    const target = (visit.terminal || visit.urgent) ? now + 1000 : Math.max(now + 1000, gate.nextAllowedAt);
    const pending = await this.ctx.storage.getAlarm();
    // Preserve any earlier alarm; every invocation checks the budget again.
    if (pending !== null && pending > now && pending <= target) return;
    await this.ctx.storage.setAlarm(target);
  }

  private async deferMaintenanceAlarm(): Promise<void> {
    const now = Date.now();
    const plan = nextMaintenanceRetry(
      await this.ctx.storage.get<MaintenanceWait>("maintenance-wait"), now,
    );
    if (plan.nextAt === null) {
      // A Live Activity token only lives for eight hours. Never leave a
      // permanent 30-second loop when a deployment or the D1 gate is stuck.
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.put("maintenance-wait", plan.state);
    await this.ctx.storage.setAlarm(plan.nextAt);
  }

  async alarm(): Promise<void> {
    try {
      if (await isDeploymentMaintenance(this.env)) {
        await this.deferMaintenanceAlarm();
        return;
      }
    } catch {
      await this.deferMaintenanceAlarm();
      return;
    }
    if (await this.ctx.storage.get<MaintenanceWait>("maintenance-wait")) {
      await this.ctx.storage.delete("maintenance-wait");
    }
    const visit = await this.ctx.storage.get<Visit>("visit");
    const config = liveActivityConfig(this.env);
    if (!visit || !config) return;
    const start = Date.now();
    const gate = checkAlarmBudget(
      await this.ctx.storage.get<AlarmBudget>("alarm-budget"), start,
    );
    if (!gate.allowed && !visit.terminal && !visit.urgent) {
      await this.ctx.storage.setAlarm(Math.max(start + 1000, gate.nextAllowedAt));
      return;
    }
    // Ordinary calculations consume quota even when they fail or stay unchanged.
    // Business changes and settled activities have a per-token delivery limit.
    if (gate.allowed) await this.ctx.storage.put("alarm-budget", spendAlarmBudget(gate, start));
    const { shopId, playerId } = visit;
    const tokens = (
      await this.env.DB.prepare(
        `SELECT t.id,t.token,t.environment,t.bundle_id,t.session_id,t.created_at,s.started_at,s.ended_at,s.payment_status,
        pc.total AS checkout_total,pc.settled_at
        FROM live_activity_tokens t JOIN shop_player_accounts a ON a.shop_id=t.shop_id AND a.user_id=t.user_id
        JOIN sessions s ON s.shop_id=t.shop_id AND s.id=t.session_id AND s.player_id=a.player_id
        LEFT JOIN settlements st ON st.shop_id=s.shop_id AND st.session_id=s.id
        LEFT JOIN player_checkouts pc ON pc.shop_id=st.shop_id AND pc.id=st.checkout_id
        WHERE t.shop_id=? AND a.player_id=?`,
      )
        .bind(shopId, playerId)
        .all<Token>()
    ).results;
    const now = Date.now();
    // Server-issued tokens are at most eight hours old. Reject malformed or
    // far-future timestamps rather than scheduling alarms for months or years
    // after restoring bad legacy data.
    const valid = tokens.filter((token) => {
      const createdAt = Date.parse(token.created_at);
      return Number.isFinite(createdAt)
        && createdAt <= now + 60_000
        && createdAt + 8 * 3600_000 > now;
    });
    const expired = tokens.filter((token) => !valid.includes(token));
    if (expired.length) {
      await this.env.DB.batch(
        expired.map((token) =>
          this.env.DB.prepare(
            "DELETE FROM live_activity_tokens WHERE id=? AND token=?",
          ).bind(token.id, token.token),
        ),
      );
      await Promise.all(expired.flatMap((token) => [
        this.ctx.storage.delete(`sent:${token.id}`),
        this.ctx.storage.delete(`retry:${token.id}`),
      ]));
    }
    if (!valid.length) {
      // Preserve the small persistent budget across token churn. Otherwise
      // unregistering and registering a new activity would reset the limiter.
      const budget = await this.ctx.storage.get<AlarmBudget>("alarm-budget");
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      if (budget) await this.ctx.storage.put("alarm-budget", budget);
      return;
    }
    const cached = await this.ctx.storage.get<CachedBill>("bill");
    const snapshot = valid.every(token => token.payment_status === "paid") ? null :
      cached &&
      cached.revision === visit.revision &&
      now - cached.calculatedAt < 30_000 &&
      (!cached.snapshot?.nextCheckAt || cached.snapshot.nextCheckAt > now)
        ? cached.snapshot
        : await activityBill(this.env, shopId, playerId, new Date(now));
    if (!cached || snapshot !== cached.snapshot) {
      await this.ctx.storage.put("bill", {
        revision: visit.revision,
        calculatedAt: now,
        snapshot,
      });
    }
    if ((await this.ctx.storage.get<Visit>("visit"))?.revision !== visit.revision) {
      return;
    }
    const pusher = new LiveActivityPusher({ config });
    let nextRetryAt = Infinity;
    let nextTerminalAt = Infinity;
    let nextUrgentAt = Infinity;
    // Hard ceiling for APNs execution time: at most four network requests in
    // one alarm. Rotate across pre-existing oversized token sets fairly.
    const cursor = (await this.ctx.storage.get<number>("token-cursor")) ?? 0;
    const offset = cursor % valid.length;
    const ordered = [...valid.slice(offset), ...valid.slice(0, offset)];
    let attempted = 0;
    let inspected = 0;
    let hasUnprocessed = false;
    for (const token of ordered) {
      // Cap *storage reads* as well as APNs calls for legacy oversized token
      // sets (which may predate the new four-activity registration quota).
      if (attempted >= 4 || inspected >= 16) {
        hasUnprocessed = true;
        break;
      }
      inspected += 1;
      if (
        (await this.ctx.storage.get<Visit>("visit"))?.revision !== visit.revision
      ) {
        return;
      }
      const ended = token.payment_status === "paid" || !snapshot;
      // Business changes must invalidate preloaded bills even when ordinary quota is exhausted.
      if (!ended && !gate.allowed && !visit.urgent) continue;
      const bill: ActivityBill | undefined =
        ended && token.checkout_total !== null
          ? {
              amountCents: token.checkout_total,
              planLabel: "",
              nextEvent: null,
              asOfUnix: now / 1000,
            }
          : snapshot?.bill;
      const startedAtUnix = new Date(token.started_at).getTime() / 1000;
      const payload = ended
        ? liveActivityEndPayload({
            startedAtUnix,
            endedAtUnix: token.ended_at
              ? new Date(token.ended_at).getTime() / 1000
              : now / 1000,
            now: Math.floor(now / 1000),
            bill,
          })
        : liveActivityUpdatePayload({
            startedAtUnix,
            endedAtUnix: snapshot?.endedAtUnix,
            now: Math.floor(now / 1000),
            bill,
            nextBill: snapshot?.nextBill,
            staleAfterSeconds: snapshot?.nextCheckAt
              ? Math.max(1, Math.ceil(snapshot.nextCheckAt / 1000) - Math.floor(now / 1000))
              : 3600,
          });
      // Exclude asOf/timestamp from deduplication, but include token rotation.
      const signature = JSON.stringify([
        token.token,
        ended,
        ended ? token.ended_at : snapshot?.endedAtUnix,
        bill && { ...bill, asOfUnix: 0 },
        !ended && snapshot?.nextBill,
      ]);
      if ((await this.ctx.storage.get<string>(`sent:${token.id}`)) === signature) {
        continue;
      }
      const retryKey = `retry:${token.id}`;
      const retry = await this.ctx.storage.get<Retry>(retryKey);
      if (
        retry?.signature === signature &&
        (retry.nextAt > now || retry.failures >= 6)
      ) {
        nextRetryAt = Math.min(nextRetryAt, retry.nextAt);
        if (ended && retry.failures < 6) nextTerminalAt = Math.min(nextTerminalAt, retry.nextAt);
        if (visit.urgent && retry.failures < 6) nextUrgentAt = Math.min(nextUrgentAt, retry.nextAt);
        continue;
      }
      attempted += 1;
      const result = await pusher.send(
        {
          token: token.token,
          environment: token.environment,
          bundleId: token.bundle_id,
        },
        payload,
        visit.urgent ? "10" : undefined,
      );
      console.log(JSON.stringify({
        event: "live_activity_push", activityEvent: ended ? "end" : "update", outcome: result.kind,
        priority: ended || visit.urgent ? 10 : 5,
        ...(result.kind === "failed" ? {
          status: result.status,
          reason: result.reason && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(result.reason)
            ? result.reason : result.status ? "apns_error" : "transport_error",
        } : {}),
      }));
      if (result.kind === "failed") {
        const failures = (retry?.signature === signature ? retry.failures : 0) + 1;
        const expiresAt = new Date(token.created_at).getTime() + 8 * 3600_000;
        const nextAt =
          failures >= 6
            ? expiresAt
            : now + Math.min(60_000, 5000 * 2 ** (failures - 1));
        await this.ctx.storage.put(retryKey, { signature, failures, nextAt });
        nextRetryAt = Math.min(nextRetryAt, nextAt);
        if (ended && failures < 6) nextTerminalAt = Math.min(nextTerminalAt, nextAt);
        if (visit.urgent && failures < 6) nextUrgentAt = Math.min(nextUrgentAt, nextAt);
        continue;
      }
      await this.ctx.storage.delete(retryKey);
      if (result.kind === "expired" || (ended && result.kind === "delivered")) {
        await this.env.DB.prepare(
          "DELETE FROM live_activity_tokens WHERE id=? AND token=?",
        )
          .bind(token.id, token.token)
          .run();
        await this.ctx.storage.delete(`sent:${token.id}`);
      } else if (result.kind === "delivered") {
        await this.ctx.storage.put(`sent:${token.id}`, signature);
      }
    }
    if (inspected > 0 && valid.length > 1) {
      await this.ctx.storage.put("token-cursor", (offset + inspected) % valid.length);
    }
    if ((await this.ctx.storage.get<Visit>("visit"))?.revision !== visit.revision) {
      return;
    }
    if (hasUnprocessed && visit.terminal) nextTerminalAt = Math.min(nextTerminalAt, Date.now() + MIN_BILLING_ALARM_INTERVAL_MS);
    if (hasUnprocessed && visit.urgent) nextUrgentAt = Math.min(nextUrgentAt, Date.now() + MIN_BILLING_ALARM_INTERVAL_MS);
    await this.ctx.storage.put("visit", {
      ...visit, terminal: Number.isFinite(nextTerminalAt), urgent: Number.isFinite(nextUrgentAt),
    });
    const expiresAt = Math.min(
      ...valid.map((token) => new Date(token.created_at).getTime() + 8 * 3600_000),
    );
    const next = Math.min(
      snapshot?.nextCheckAt ?? Infinity,
      expiresAt,
      nextRetryAt,
      hasUnprocessed ? Date.now() + MIN_BILLING_ALARM_INTERVAL_MS : Infinity,
    );
    if (snapshot || Number.isFinite(nextRetryAt) || hasUnprocessed) {
      const later = Date.now();
      const budget = checkAlarmBudget(
        await this.ctx.storage.get<AlarmBudget>("alarm-budget"), later,
      );
      await this.ctx.storage.setAlarm(
        Math.max(later + 1000, Math.min(nextTerminalAt, nextUrgentAt,
          Math.max(Number.isFinite(next) ? next : later + MIN_BILLING_ALARM_INTERVAL_MS, budget.nextAllowedAt))),
      );
    } else {
      // Preserve the small persistent budget across token churn. Otherwise
      // unregistering and registering a new activity would reset the limiter.
      const budget = await this.ctx.storage.get<AlarmBudget>("alarm-budget");
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      if (budget) await this.ctx.storage.put("alarm-budget", budget);
    }
  }
}
