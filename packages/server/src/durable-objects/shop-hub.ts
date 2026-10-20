import type { DurableObject } from "cloudflare:workers";
import type { Env } from "../bindings.js";
import { decryptSecret } from "../crypto.js";
import { createRuntimeBus } from "../devices/runtime.js";
import { listHaConnections } from "../devices/ha-connections.js";
import { machineRelayNamespace } from "../gateway/machine-relay-gateway.js";
import type { HaEntityState, HaReport } from "../hardware/aimeio-relay.js";
import type { HaWatch } from "./machine-relay.js";
import { emptyIdleMemory, runIdleCheck, type IdleMemory, type IdleNotice } from "./shop-hub-idle.js";
import { parseBotFrame, revokedCredentials, runBotRequest, type BotResponse } from "./shop-hub-bot.js";
import { app } from "../app.js";
import { climateState } from "../devices/runtime.js";

/** A shop bot's connection, kept on the socket so it survives hibernation. */
type BotAttachment = { kind: "bot"; token: string; shopCode: string; reminderLeadMs: number | null };
/** A player's device page, listening for that device's state. */
type PageAttachment = { kind: "page"; deviceId: string };
/** A write a bot sent is answered from here if it arrives again (a resend after a lost reply). */
const REPLAY_MS = 10 * 60_000;

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

/** A watcher that has not reported for this long is presumed gone. */
export const LEASE_MS = 90_000;
/** A watcher that failed is not chosen again for this long, while others exist. */
const BENCH_MS = 5 * 60_000;
/** Bursts of activity are folded into one idle check this long after the first. */
const TOUCH_DELAY_MS = 2000;

/** An online IO able to watch Home Assistant for the shop. */
type Candidate = { machineId: string; channel: string; since: number; benchedUntil?: number };
type Leader = { machineId: string; channel: string; term: number; leaseUntil: number };
/** The last reported state of one entity. */
export type WatchedState = { state: string; attributes: Record<string, unknown>; lastChanged: string | null };
/** Which capabilities an entity drives, by `connectionId|entityId`. */
type Targets = Record<string, Array<{ deviceId: string; capability: "power" | "climate" }>>;

const entityKey = (connectionId: string, entityId: string) => `${connectionId}|${entityId}`;

/** Only what a setting is made of; room temperature drifts on its own. */
const climateSetting = (state: WatchedState) => ({
  mode: state.state,
  temperature: typeof state.attributes.temperature === "number" ? state.attributes.temperature : null,
  fanMode: typeof state.attributes.fan_mode === "string" ? state.attributes.fan_mode : null,
});

/**
 * One per shop, named by shop id. It decides which online HINATA IO watches the
 * shop's Home Assistants and keeps the states they report, so reading a power
 * switch does not have to ask Home Assistant.
 *
 * The watcher holds a lease renewed by every report. A watcher that leaves,
 * fails or goes quiet past the lease is replaced by the IO online longest; a
 * new watcher's first report is the full state, so nothing is missed in between.
 * Every report carries the term of the assignment it answers, and reports from
 * an earlier term are ignored, so a handover needs no exact timing.
 */
export class ShopHub extends BaseDurableObject<Env> {
  /** Requests running now, so a resend while the first is in flight is not run twice. */
  private readonly running = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // A bot's keep-alive is answered without waking the object.
    try {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    } catch {
      // Not available outside the Workers runtime; the message handler answers instead.
    }
  }

  /**
   * A bot connecting. The Worker route has already checked its token for this
   * shop and passes the shop on in headers; the token is kept to run requests.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected Upgrade: websocket", { status: 426 });
    const pageDevice = request.headers.get("x-prism-hub-device");
    if (pageDevice) return this.acceptPage(request, pageDevice);
    const shopId = request.headers.get("x-prism-hub-shop");
    const shopCode = request.headers.get("x-prism-hub-shop-code");
    const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
    if (!shopId || !shopCode || !token) return new Response("Missing bot channel", { status: 400 });
    await this.shopId(shopId);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server!, ["bot"]);
    server!.serializeAttachment({ kind: "bot", token, shopCode, reminderLeadMs: null } satisfies BotAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  private bots(): WebSocket[] {
    return this.ctx.getWebSockets("bot");
  }

  /** A device page connecting; the Worker route has checked its user and ticket. */
  private async acceptPage(request: Request, deviceId: string): Promise<Response> {
    const shopId = request.headers.get("x-prism-hub-shop");
    if (!shopId) return new Response("Missing page channel", { status: 400 });
    await this.shopId(shopId);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server!, [`page:${deviceId}`]);
    server!.serializeAttachment({ kind: "page", deviceId } satisfies PageAttachment);
    server!.send(JSON.stringify({ type: "hello", ...(await this.pageSnapshot(deviceId)) }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Whether the device's state is being watched, and what it is now if so. */
  private async pageSnapshot(deviceId: string): Promise<{ watching: boolean; power?: string; climate?: unknown }> {
    if (!(await this.watcher())) return { watching: false };
    const states = await this.load<Record<string, WatchedState>>("states", {});
    const targets = await this.load<Targets>("targets", {});
    const snapshot: { watching: boolean; power?: string; climate?: unknown } = { watching: true };
    for (const [key, list] of Object.entries(targets)) {
      const target = list.find((item) => item.deviceId === deviceId);
      const state = states[key];
      if (!target || !state) continue;
      if (target.capability === "power" && (state.state === "on" || state.state === "off")) snapshot.power = state.state;
      if (target.capability === "climate" && state.state !== "unavailable" && state.state !== "unknown")
        snapshot.climate = climateState(state.state, state.attributes);
    }
    return snapshot;
  }

  private toPages(deviceId: string, frame: Record<string, unknown>) {
    const encoded = JSON.stringify(frame);
    for (const ws of this.ctx.getWebSockets(`page:${deviceId}`)) {
      try {
        ws.send(encoded);
      } catch {
        // A page that left is reaped by the runtime.
      }
    }
  }

  /** Tell every open page whether state is being watched, so they poll when not. */
  private async announceWatching() {
    const watching = !!(await this.watcher());
    const frame = JSON.stringify({ type: "watching", watching });
    for (const ws of this.ctx.getWebSockets()) {
      if ((ws.deserializeAttachment() as PageAttachment | null)?.kind !== "page") continue;
      try {
        ws.send(frame);
      } catch {
        // Gone.
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const attachment = ws.deserializeAttachment() as BotAttachment | null;
    if (attachment?.kind !== "bot") return;
    if (message === "ping") {
      ws.send("pong");
      return;
    }
    const frame = parseBotFrame(message);
    if (!frame) return;
    if (frame.type === "hello") {
      ws.serializeAttachment({ ...attachment, reminderLeadMs: frame.reminderLeadSeconds === undefined ? null : frame.reminderLeadSeconds * 1000 });
      // Reminders may now be due earlier than the next planned check.
      await this.touch((await this.shopId()) ?? "");
      return;
    }
    const replayKey = `req:${frame.id}`;
    const replay = await this.ctx.storage.get<BotResponse & { at: number }>(replayKey);
    if (replay) {
      const { at: _at, ...response } = replay;
      ws.send(JSON.stringify(response));
      return;
    }
    if (this.running.has(frame.id)) return;
    this.running.add(frame.id);
    let response: BotResponse;
    try {
      response = await runBotRequest({
        app,
        env: this.env,
        waitUntil: (promise) => this.ctx.waitUntil(promise),
        token: attachment.token,
        shopCode: attachment.shopCode,
        frame,
      });
    } catch (error) {
      response = { type: "response", id: frame.id, status: 500, body: { error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "服务器错误" } } };
    } finally {
      this.running.delete(frame.id);
    }
    if (frame.method !== "GET") await this.remember(replayKey, response);
    try {
      ws.send(JSON.stringify(response));
    } catch {
      // The bot left; a resend gets the remembered answer.
    }
    if (revokedCredentials(response)) {
      try {
        ws.close(4003, "credentials revoked");
      } catch {
        // Already closed.
      }
    }
  }

  private async remember(key: string, response: BotResponse) {
    const now = Date.now();
    await this.ctx.storage.put(key, { ...response, at: now });
    const list = (this.ctx.storage as { list?: (options: { prefix: string }) => Promise<Map<string, { at?: number }>> }).list;
    if (!list) return;
    const stale = [...(await list.call(this.ctx.storage, { prefix: "req:" })).entries()]
      .filter(([, value]) => (value.at ?? 0) < now - REPLAY_MS)
      .map(([name]) => name);
    if (stale.length) await this.ctx.storage.delete(stale as never);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close([1005, 1006, 1015].includes(code) ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }

  private async load<T>(key: string, fallback: T): Promise<T> {
    return ((await this.ctx.storage.get<T>(key)) ?? fallback) as T;
  }

  private async shopId(shopId?: string): Promise<string | null> {
    if (shopId) {
      await this.ctx.storage.put("shop", shopId);
      return shopId;
    }
    return (await this.ctx.storage.get<string>("shop")) ?? null;
  }

  /** An IO announcing it can watch Home Assistant has connected. */
  async relayOnline(shopId: string, machineId: string, channel: string): Promise<void> {
    await this.shopId(shopId);
    const candidates = await this.load<Record<string, Candidate>>("candidates", {});
    candidates[machineId] = { machineId, channel, since: candidates[machineId]?.since ?? Date.now() };
    await this.ctx.storage.put("candidates", candidates);
    if (!(await this.ctx.storage.get<Leader>("leader"))) await this.elect();
  }

  /** That IO is gone. Its watch, if it had one, moves to another. */
  async relayOffline(shopId: string, machineId: string): Promise<void> {
    await this.shopId(shopId);
    const candidates = await this.load<Record<string, Candidate>>("candidates", {});
    delete candidates[machineId];
    await this.ctx.storage.put("candidates", candidates);
    const leader = await this.ctx.storage.get<Leader>("leader");
    if (leader?.machineId === machineId) {
      await this.ctx.storage.delete("leader");
      await this.elect();
    }
  }

  /** Devices or connections changed: rebuild what is watched and tell the watcher. */
  async refresh(shopId: string): Promise<void> {
    await this.shopId(shopId);
    const leader = await this.ctx.storage.get<Leader>("leader");
    if (leader) await this.assign(leader.machineId, leader.channel);
    else await this.elect();
  }

  /** The watched state of an entity, or null when nobody is watching it now. */
  async readState(connectionId: string, entityId: string): Promise<WatchedState | null> {
    const leader = await this.ctx.storage.get<Leader>("leader");
    if (!leader || leader.leaseUntil <= Date.now()) return null;
    const states = await this.load<Record<string, WatchedState>>("states", {});
    return states[entityKey(connectionId, entityId)] ?? null;
  }

  /** Whether some IO is watching right now, for the device board. */
  async watcher(): Promise<{ machineId: string; leaseUntil: number } | null> {
    const leader = await this.ctx.storage.get<Leader>("leader");
    return leader && leader.leaseUntil > Date.now() ? { machineId: leader.machineId, leaseUntil: leader.leaseUntil } : null;
  }

  async haReport(shopId: string, machineId: string, report: HaReport): Promise<void> {
    await this.shopId(shopId);
    const leader = await this.ctx.storage.get<Leader>("leader");
    // An earlier assignment, or an IO that is not the watcher: not ours to trust.
    if (!leader || leader.machineId !== machineId || leader.term !== report.params.term) return;
    if (report.method === "ha.status" && !report.params.connected) {
      // This IO cannot reach Home Assistant; another one may.
      const others = Object.values(await this.load<Record<string, Candidate>>("candidates", {}))
        .some((candidate) => candidate.machineId !== machineId);
      if (others) {
        await this.bench(machineId);
        await this.elect();
        return;
      }
    }
    leader.leaseUntil = Date.now() + LEASE_MS;
    await this.ctx.storage.put("leader", leader);
    await this.schedule();
    if (report.method === "ha.states") await this.apply(report.params.connection, report.params.states);
  }

  /**
   * Something that may change idle state happened: activity, an entry or a
   * checkout, a settings change. The check runs shortly after, once per burst.
   */
  async touch(shopId: string): Promise<void> {
    await this.shopId(shopId);
    const at = Date.now() + TOUCH_DELAY_MS;
    const pending = await this.ctx.storage.get<number>("touchAt");
    if (pending === undefined || pending > at) await this.ctx.storage.put("touchAt", at);
    await this.schedule();
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const leader = await this.ctx.storage.get<Leader>("leader");
    if (leader && leader.leaseUntil <= now) {
      await this.bench(leader.machineId);
      await this.ctx.storage.delete("leader");
      await this.elect();
    }
    const touchAt = await this.ctx.storage.get<number>("touchAt");
    const idle = await this.load<IdleMemory>("idle", emptyIdleMemory());
    if ((touchAt !== undefined && touchAt <= now) || (idle.wakeAt !== null && idle.wakeAt <= now)) {
      await this.ctx.storage.delete("touchAt");
      await this.checkIdle(idle);
    }
    await this.schedule();
  }

  private async checkIdle(memory: IdleMemory) {
    const shopId = await this.shopId();
    if (!shopId) return;
    try {
      const result = await runIdleCheck({
        env: this.env,
        shopId,
        now: Date.now(),
        memory,
        watched: await this.load<Record<string, WatchedState>>("states", {}),
        reminderLeadMs: await this.reminderLead(),
      });
      await this.ctx.storage.put("idle", result.memory);
      if (result.notices.length) await this.notify(result.notices);
    } catch (error) {
      console.error("Idle check failed", error);
    }
  }

  /** How long before a power-off the shop's bots want to hear about it; null without one. */
  private async reminderLead(): Promise<number | null> {
    const leads = this.bots()
      .map((ws) => (ws.deserializeAttachment() as BotAttachment | null)?.reminderLeadMs)
      .filter((lead): lead is number => typeof lead === "number");
    return leads.length ? Math.max(...leads) : null;
  }

  private async notify(notices: IdleNotice[]): Promise<void> {
    for (const notice of notices) {
      const frame = JSON.stringify({ type: "event", event: "idle.reminder", data: notice });
      for (const ws of this.bots()) {
        try {
          ws.send(frame);
        } catch {
          // A bot that left misses it; the power-off happens regardless.
        }
      }
    }
  }

  private async bench(machineId: string) {
    const candidates = await this.load<Record<string, Candidate>>("candidates", {});
    if (candidates[machineId]) candidates[machineId]!.benchedUntil = Date.now() + BENCH_MS;
    await this.ctx.storage.put("candidates", candidates);
  }

  /** Give the watch to the IO online longest, preferring ones that have not just failed. */
  private async elect(): Promise<void> {
    const candidates = Object.values(await this.load<Record<string, Candidate>>("candidates", {}));
    const now = Date.now();
    const ordered = candidates.sort((a, b) =>
      Number((a.benchedUntil ?? 0) > now) - Number((b.benchedUntil ?? 0) > now) || a.since - b.since);
    for (const candidate of ordered) {
      if (await this.assign(candidate.machineId, candidate.channel)) return;
    }
    await this.ctx.storage.delete("leader");
    await this.schedule();
    await this.announceWatching();
  }

  /** Send the watch to one IO under a new term. False when it could not be told. */
  private async assign(machineId: string, channel: string): Promise<boolean> {
    const shopId = await this.shopId();
    const relay = machineRelayNamespace(this.env);
    if (!shopId || !relay) return false;
    const watch = await this.buildWatch(shopId);
    const term = (await this.load<number>("term", 0)) + 1;
    await this.ctx.storage.put("term", term);
    if (!watch) {
      // Nothing to watch: no Home Assistant has a read-only account yet.
      await this.ctx.storage.delete("leader");
      return true;
    }
    let sent = false;
    try {
      sent = (await relay.getByName(channel).watchHa({ ...watch, term })).ok;
    } catch {
      sent = false;
    }
    if (!sent) {
      await this.bench(machineId);
      return false;
    }
    // The previous watcher, if still connected, stops; its later reports carry
    // an old term and would be ignored anyway.
    const previous = await this.ctx.storage.get<Leader>("leader");
    if (previous && previous.machineId !== machineId)
      await relay.getByName(previous.channel).watchHa(null).catch(() => undefined);
    // The IO has one lease period to report; its first report is the full state.
    await this.ctx.storage.put<Leader>("leader", { machineId, channel, term, leaseUntil: Date.now() + LEASE_MS });
    await this.schedule();
    await this.announceWatching();
    return true;
  }

  private async buildWatch(shopId: string): Promise<Omit<HaWatch, "term"> | null> {
    const key = this.env.URL_ENCRYPTION_KEY;
    if (!key) return null;
    const rows = (
      await this.env.DB.prepare(
        `SELECT c.device_id, c.capability,
                json_extract(c.config_json, '$.connectionId') AS connection_id,
                json_extract(c.config_json, '$.entityId') AS entity_id
         FROM device_capabilities c JOIN machines m ON m.shop_id = c.shop_id AND m.id = c.device_id
         WHERE c.shop_id = ? AND c.capability IN ('power', 'climate') AND m.enabled = 1`,
      ).bind(shopId).all<{ device_id: string; capability: "power" | "climate"; connection_id: string | null; entity_id: string | null }>()
    ).results;
    const targets: Targets = {};
    for (const row of rows) {
      if (!row.connection_id || !row.entity_id) continue;
      (targets[entityKey(row.connection_id, row.entity_id)] ??= []).push({ deviceId: row.device_id, capability: row.capability });
    }
    await this.ctx.storage.put("targets", targets);
    const connections: HaWatch["connections"] = [];
    for (const connection of await listHaConnections(this.env.DB, shopId)) {
      if (!connection.readToken) continue;
      const entities = [...new Set(rows.filter((row) => row.connection_id === connection.id && row.entity_id).map((row) => row.entity_id!))];
      if (!entities.length) continue;
      let token: string;
      try {
        token = await decryptSecret(connection.readToken, key);
      } catch {
        continue;
      }
      // Inside the shop the local address is usually the one that works.
      const urls = [...new Set([connection.internalUrl, connection.url].filter((url): url is string => !!url))];
      connections.push({ id: connection.id, urls, token, entities });
    }
    return connections.length ? { connections } : null;
  }

  /** Keep the reported states and record the ones that changed on their devices. */
  private async apply(connectionId: string, reported: HaEntityState[]) {
    const shopId = await this.shopId();
    if (!shopId) return;
    const states = await this.load<Record<string, WatchedState>>("states", {});
    const targets = await this.load<Targets>("targets", {});
    const bus = createRuntimeBus({ db: this.env.DB, env: this.env, shopId });
    for (const item of reported) {
      const key = entityKey(connectionId, item.entity_id);
      const previous = states[key];
      const next: WatchedState = { state: item.state, attributes: item.attributes, lastChanged: item.last_changed };
      states[key] = next;
      const at = item.last_changed ? new Date(item.last_changed) : undefined;
      for (const target of targets[key] ?? []) {
        try {
          if (target.capability === "power") {
            if ((next.state === "on" || next.state === "off") && previous?.state !== next.state) {
              this.toPages(target.deviceId, { type: "state", power: next.state });
              await bus.report({ device: { id: target.deviceId }, capability: "power", key: "power", value: next.state, at });
              // Switched on starts an idle countdown; switched off may end one.
              if (previous) await this.touch(shopId);
            }
          } else if (next.state !== "unavailable" && next.state !== "unknown") {
            // Pages show room temperature too, so they get every change.
            this.toPages(target.deviceId, { type: "state", climate: climateState(next.state, next.attributes) });
            const setting = climateSetting(next);
            if (!previous || JSON.stringify(climateSetting(previous)) !== JSON.stringify(setting))
              await bus.report({ device: { id: target.deviceId }, capability: "climate", key: "climate", value: setting, at });
          }
        } catch (error) {
          console.error("Shop hub state record failed", error);
        }
      }
    }
    await this.ctx.storage.put("states", states);
  }

  /** Wake for the earliest thing that needs checking. */
  private async schedule() {
    const leader = await this.ctx.storage.get<Leader>("leader");
    const touchAt = await this.ctx.storage.get<number>("touchAt");
    const idle = await this.ctx.storage.get<IdleMemory>("idle");
    const due = [leader?.leaseUntil, touchAt, idle?.wakeAt ?? undefined]
      .filter((at): at is number => typeof at === "number")
      .reduce<number | null>((earliest, at) => (earliest === null || at < earliest ? at : earliest), null);
    if (due === null) await this.ctx.storage.deleteAlarm?.();
    else await this.ctx.storage.setAlarm(due);
  }
}
