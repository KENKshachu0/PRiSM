import type { DurableObject } from "cloudflare:workers";
import type { Env } from "../bindings.js";
import { decryptSecret } from "../crypto.js";
import type { DeviceBus } from "../resources/capabilities/bus.js";
import { climateState, createRuntimeBus, type ClimateState } from "../resources/capabilities/runtime.js";
import { listHaConnections } from "../resources/capabilities/ha-connections.js";
import { provisionReadAccess } from "../resources/capabilities/ha-read-access.js";
import { DEFAULT_WATCHERS, MAX_WATCHERS, readWatcherLimit } from "../resources/capabilities/ha-watchers.js";
import { loadResource } from "../resources/resource.js";
import { readBoardStates, readDeviceFacts, writeEventConnections } from "../resources/capabilities/state-view.js";
import { machineRelayNamespace } from "../gateway/machine-relay-gateway.js";
import type { HaEntityState, HaReport } from "../hardware/aimeio-relay.js";
import type { HaWatch } from "./machine-relay.js";
import { emptyIdleMemory, runIdleCheck, type IdleMemory, type IdleNotice } from "./shop-hub-idle.js";
import { DEFAULT_BOT_NAME, parseBotFrame, revokedCredentials, runBotRequest, type BotResponse } from "./shop-hub-bot.js";
import { app } from "../app.js";

/**
 * A shop bot's connection, kept on the socket so it survives hibernation. `id` tells this connection
 * from another bot's; `ha` and `name` come from its hello, and a bot that never said it can watch
 * Home Assistant is never given a watch.
 */
type BotAttachment = { kind: "bot"; token: string; shopCode: string; reminderLeadMs: number | null; id?: string; ha?: boolean; name?: string };
/** A player's device page, listening for that device's state and for changes to its own page. */
type PageAttachment = { kind: "page"; deviceId: string; userId: string };
/** A merchant's device board, listening for the state of every device in the shop. */
type BoardAttachment = { kind: "board" };
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
/**
 * The default number of clients watching at once. The second keeps the state flowing while the first
 * is replaced, so losing one never leaves a gap. A shop's own number is the platform administrator's
 * to set (`ha-watchers.ts`).
 */
export const WATCHERS = DEFAULT_WATCHERS;
/** A failed state write restarts the watch, but not more often than this. */
const RESYNC_MS = 30_000;

/** A bot's key among candidates and watchers; an IO's is its machine id. */
const BOT_PREFIX = "bot:";
const botKey = (id: string) => `${BOT_PREFIX}${id}`;
const isBot = (key: string) => key.startsWith(BOT_PREFIX);

/**
 * Something online that can watch Home Assistant for the shop: a HINATA IO, keyed by its machine id, or
 * a shop bot, keyed by `bot:<connection id>`. `machineId` is that key either way, so records written
 * before bots existed read as what they were.
 */
type Candidate = {
  machineId: string;
  /** The relay channel an IO is reached through; a bot is reached on its own socket. */
  channel: string;
  since: number;
  /** A bot's name for the board. */
  label?: string;
  /** Ranked after the others for this long after it failed to take the watch. */
  benchedUntil?: number;
  /** Not chosen at all: the platform switched it off. Its next hello clears this. */
  downUntil?: number;
};
/** What one watcher said about one Home Assistant connection. */
type Link = {
  /** The watcher is subscribed to it. */
  connected: boolean;
  /** Its full state was stored, so the stored facts are complete. */
  snapshot: boolean;
};
type Watcher = {
  machineId: string;
  channel: string;
  label?: string;
  term: number;
  leaseUntil: number;
  links: Record<string, Link>;
};
type Watchers = Record<string, Watcher>;
type Candidates = Record<string, Candidate>;
/**
 * The last state applied for one entity. The hub keeps it only to recognise a
 * repeat or an older report from the second watcher; readers use `device_state`.
 */
export type WatchedState = {
  state: string;
  attributes: Record<string, unknown>;
  lastChanged: string | null;
  /** Home Assistant's `last_updated` (else `last_changed`) in ms; orders reports. */
  stamp: number | null;
};
/** Which capabilities an entity drives, by `connectionId|entityId`. */
type Targets = Record<string, Array<{ deviceId: string; capability: "power" | "climate" }>>;

const entityKey = (connectionId: string, entityId: string) => `${connectionId}|${entityId}`;
const connectionOf = (key: string) => key.slice(0, key.indexOf("|"));

/** Only what a setting is made of; room temperature drifts on its own. */
const settingOf = (state: WatchedState) => ({
  mode: state.state,
  temperature: typeof state.attributes.temperature === "number" ? state.attributes.temperature : null,
  fanMode: typeof state.attributes.fan_mode === "string" ? state.attributes.fan_mode : null,
});

const stampOf = (item: HaEntityState): number | null => {
  const at = Date.parse(item.last_updated ?? item.last_changed ?? "");
  return Number.isNaN(at) ? null : at;
};
const sameState = (previous: WatchedState, item: HaEntityState) =>
  previous.state === item.state && JSON.stringify(previous.attributes) === JSON.stringify(item.attributes);
/** A report that adds nothing: a repeat, or older than what is already applied. */
const superseded = (previous: WatchedState, item: HaEntityState, stamp: number | null) => {
  if (previous.stamp !== null && stamp !== null) {
    if (stamp < previous.stamp) return true;
    if (stamp > previous.stamp) return false;
  }
  return sameState(previous, item);
};

type StateWrite = Parameters<DeviceBus["reportMany"]>[0][number];
/** `reportMany` is one batch; a snapshot of a large shop is split to stay within D1's limits. */
const WRITE_CHUNK = 40;

/**
 * One per shop, named by shop id. It decides which online clients watch the shop's Home Assistants,
 * keeps their reports in `device_state`, and tells the rest of the platform which Home Assistant
 * connections can be believed.
 *
 * A watcher is a shop bot or a HINATA IO. Up to the shop's number of them (two unless the platform
 * administrator changed it) watch at once, and bots come first: while a bot is online it holds a slot,
 * and a second bot takes the other one. An IO fills a slot no bot wants, and is sent home when a bot
 * arrives once the watchers that stay have delivered what it carried, so the handover has no gap. A
 * candidate that just failed (it cannot reach Home Assistant, or went quiet) ranks behind healthy
 * ones for a while, whatever it is. Each watcher holds a lease renewed by every report; one that
 * leaves, is switched off, fails or goes quiet past the lease is dropped and the next candidate takes
 * its place. Every report carries the term of the assignment it answers, so a replaced watcher's
 * reports are ignored.
 *
 * A connection is *watched* when some live watcher has it subscribed and has
 * delivered its full state. Only then does `ha_event_connections` hold it, and
 * readers take `device_state` as fact without asking Home Assistant. The
 * snapshot is stored before the connection is announced, and the announcement
 * is withdrawn when the last such watcher goes, so the table never promises
 * more than is stored.
 */
export class ShopHub extends BaseDurableObject<Env> {
  /** Requests running now, so a resend while the first is in flight is not run twice. */
  private readonly running = new Set<string>();
  private shop: string | null = null;
  private lastResync = 0;
  /** The last watcher list sent to the boards, so a board hears only about a change. */
  private lastWatchers = "";

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
   * A bot or a device page connecting. The Worker route has already checked
   * the token or the user and ticket and passes the shop on in headers.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected Upgrade: websocket", { status: 426 });
    const pageDevice = request.headers.get("x-prism-hub-device");
    if (pageDevice) return this.acceptPage(request, pageDevice);
    if (request.headers.get("x-prism-hub-board")) return this.acceptBoard(request);
    const shopId = request.headers.get("x-prism-hub-shop");
    const shopCode = request.headers.get("x-prism-hub-shop-code");
    const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
    if (!shopId || !shopCode || !token) return new Response("Missing bot channel", { status: 400 });
    await this.rememberShop(shopId);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server!, ["bot"]);
    server!.serializeAttachment({ kind: "bot", token, shopCode, reminderLeadMs: null, id: crypto.randomUUID() } satisfies BotAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  private bots(): WebSocket[] {
    return this.ctx.getWebSockets("bot");
  }

  /** A device page connecting; the Worker route has checked its user and ticket. */
  private async acceptPage(request: Request, deviceId: string): Promise<Response> {
    const shopId = request.headers.get("x-prism-hub-shop");
    if (!shopId) return new Response("Missing page channel", { status: 400 });
    const userId = request.headers.get("x-prism-hub-user") ?? "";
    await this.rememberShop(shopId);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server!, [`page:${deviceId}`, ...(userId ? [`user:${userId}`] : [])]);
    server!.serializeAttachment({ kind: "page", deviceId, userId } satisfies PageAttachment);
    server!.send(JSON.stringify({ type: "hello", ...(await this.pageSnapshot(shopId, deviceId)) }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Whether the device's state is pushed, and what it is now if so. */
  private async pageSnapshot(shopId: string, deviceId: string): Promise<{ watching: boolean; power?: "on" | "off" | null; climate?: ClimateState | null }> {
    try {
      const device = await loadResource(this.env.DB, shopId, deviceId);
      if (!device) return { watching: false };
      const facts = await readDeviceFacts(this.env.DB, shopId, device);
      if (!facts.watching) return { watching: false };
      return {
        watching: true,
        ...(device.capabilities.has("power") ? { power: facts.power } : {}),
        ...(device.capabilities.has("climate") ? { climate: facts.climate } : {}),
      };
    } catch (error) {
      console.error("Shop hub page snapshot failed", error);
      return { watching: false };
    }
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

  /** A merchant's device board connecting; the Worker route has checked the user is a member of the shop. */
  private async acceptBoard(request: Request): Promise<Response> {
    const shopId = request.headers.get("x-prism-hub-shop");
    if (!shopId) return new Response("Missing board channel", { status: 400 });
    await this.rememberShop(shopId);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server!, ["board"]);
    server!.serializeAttachment({ kind: "board" } satisfies BoardAttachment);
    // What is stored now, so the board catches up on anything that moved between its read and this connection.
    const snapshot = await this.boardSnapshot(shopId);
    if (snapshot) server!.send(JSON.stringify(snapshot));
    try {
      server!.send(JSON.stringify(await this.watchersFrame(await this.load<Watchers>("watchers", {}))));
    } catch (error) {
      console.error("Shop hub watcher list failed", error);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Every device of the shop with its stored facts, as the board's `states` frame; null if it cannot be read. */
  private async boardSnapshot(shopId: string): Promise<{ type: "states"; states: Record<string, unknown> } | null> {
    try {
      return { type: "states", states: (await readBoardStates(this.env.DB, shopId)).states };
    } catch (error) {
      console.error("Shop hub board snapshot failed", error);
      return null;
    }
  }

  private toBoards(frame: Record<string, unknown>) {
    const boards = this.ctx.getWebSockets("board");
    if (!boards.length) return;
    const encoded = JSON.stringify(frame);
    for (const ws of boards) {
      try {
        ws.send(encoded);
      } catch {
        // A board that left is reaped by the runtime.
      }
    }
  }

  /**
   * Send every open board the whole shop again. Done when a Home Assistant
   * connection starts or stops being watched: which devices are live changed,
   * and a board can only tell by being told.
   */
  private async announceBoards() {
    if (!this.ctx.getWebSockets("board").length) return;
    const shopId = await this.shopId();
    const snapshot = shopId ? await this.boardSnapshot(shopId) : null;
    if (snapshot) this.toBoards(snapshot);
  }

  /**
   * Who is watching Home Assistant right now, for the board: each watcher by kind (a bot by name, a
   * device by id), how far it has got, the shop's number of slots, and how many more are online and
   * waiting their turn. A watcher whose lease has lapsed is not listed.
   */
  private async watchersFrame(watchers: Watchers): Promise<Record<string, unknown>> {
    const now = Date.now();
    const candidates = await this.load<Candidates>("candidates", {});
    const list = Object.values(watchers)
      .filter((watcher) => watcher.leaseUntil > now)
      .sort((a, b) => Number(!isBot(a.machineId)) - Number(!isBot(b.machineId)) || a.machineId.localeCompare(b.machineId))
      .map((watcher) => {
        const links = Object.values(watcher.links);
        const state = links.some((link) => link.connected && link.snapshot)
          ? "watching"
          : links.some((link) => link.connected)
            ? "subscribing"
            : links.length
              ? "unreachable"
              : "starting";
        return isBot(watcher.machineId)
          ? { id: watcher.machineId, kind: "bot", name: watcher.label ?? DEFAULT_BOT_NAME, state }
          : { id: watcher.machineId, kind: "device", deviceId: watcher.machineId, state };
      });
    const standby = Object.values(candidates).filter((candidate) => !watchers[candidate.machineId] && (candidate.downUntil ?? 0) <= now).length;
    return { type: "watchers", limit: await this.limit(), max: MAX_WATCHERS, watchers: list, standby };
  }

  /** Tell the open boards who is watching, when that changed. */
  private async announceWatchers(watchers: Watchers) {
    if (!this.ctx.getWebSockets("board").length) return;
    const frame = await this.watchersFrame(watchers);
    const encoded = JSON.stringify(frame);
    if (encoded === this.lastWatchers) return;
    this.lastWatchers = encoded;
    this.toBoards(frame);
  }

  /** How many clients watch at once in this shop. */
  private async limit(): Promise<number> {
    const stored = await this.ctx.storage.get<number>("limit");
    return typeof stored === "number" && Number.isInteger(stored) && stored >= 1 && stored <= MAX_WATCHERS ? stored : DEFAULT_WATCHERS;
  }

  /** Tell the open device pages of one user that something they show changed. */
  /** Something a bot is told about changed (its settings, staff, tables): each rereads it. */
  async botsChanged(): Promise<void> {
    const frame = JSON.stringify({ type: "config.changed" });
    for (const ws of this.bots()) {
      try {
        ws.send(frame);
      } catch {
        // A bot that left is reaped by the runtime.
      }
    }
  }

  /**
   * Something happened at the shop that bots may announce (a device switched on
   * or off, a card, someone starting on a resource). Each bot decides from its
   * own settings whether and where to say it.
   */
  async shopEvent(event: Record<string, unknown>): Promise<void> {
    const frame = JSON.stringify({ type: "event", event: "shop.event", data: event });
    for (const ws of this.bots()) {
      try {
        ws.send(frame);
      } catch {
        // A bot that left misses it.
      }
    }
  }

  async notifyUser(userId: string, frame: Record<string, unknown>): Promise<void> {
    const encoded = JSON.stringify(frame);
    for (const ws of this.ctx.getWebSockets(`user:${userId}`)) {
      try {
        ws.send(encoded);
      } catch {
        // Gone.
      }
    }
  }

  /**
   * Tell pages whose device uses a connection that just started or stopped being
   * watched. A page that becomes watched also gets the current state, so it can
   * stop asking Home Assistant and show what it was missing.
   */
  private async announce(live: ReadonlySet<string>, changed: ReadonlySet<string>) {
    const pages = this.ctx.getWebSockets().filter((ws) => (ws.deserializeAttachment() as PageAttachment | null)?.kind === "page");
    if (!pages.length) return;
    const shopId = await this.shopId();
    const targets = await this.load<Targets>("targets", {});
    const connections = new Map<string, Set<string>>();
    for (const [key, list] of Object.entries(targets)) {
      for (const target of list) {
        const set = connections.get(target.deviceId) ?? new Set<string>();
        set.add(connectionOf(key));
        connections.set(target.deviceId, set);
      }
    }
    const snapshots = new Map<string, Record<string, unknown>>();
    for (const ws of pages) {
      const { deviceId } = ws.deserializeAttachment() as PageAttachment;
      const mine = connections.get(deviceId);
      if (!mine || ![...mine].some((id) => changed.has(id))) continue;
      const watching = [...mine].every((id) => live.has(id));
      let frame = snapshots.get(`${deviceId}:${watching}`);
      if (!frame) {
        frame = { type: "watching", ...(watching && shopId ? await this.pageSnapshot(shopId, deviceId) : { watching: false }) };
        snapshots.set(`${deviceId}:${watching}`, frame);
      }
      try {
        ws.send(JSON.stringify(frame));
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
      // A bot that rereads its settings says hello again; one no longer
      // allowed to watch hands its watch on first.
      if (attachment.ha && !frame.ha) await this.botGone(ws);
      const id = attachment.id ?? crypto.randomUUID();
      ws.serializeAttachment({
        ...attachment,
        id,
        reminderLeadMs: frame.reminderLeadSeconds === undefined ? null : frame.reminderLeadSeconds * 1000,
        ha: frame.ha === true,
        ...(frame.name ? { name: frame.name } : {}),
      } satisfies BotAttachment);
      const shopId = (await this.shopId()) ?? "";
      if (frame.ha) await this.botOnline(shopId, id, frame.name);
      // Reminders may now be due earlier than the next planned check.
      await this.touch(shopId);
      return;
    }
    if (frame.type === "ha") {
      // Only a bot that said it can watch has anything to report; a stale or unassigned one is ignored.
      const shopId = await this.shopId();
      if (shopId && attachment.ha && attachment.id) await this.haReport(shopId, botKey(attachment.id), frame.report);
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
    await this.botGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.botGone(ws);
  }

  /** A bot that was a candidate has left: its watch, if it had one, moves to the next. */
  private async botGone(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as BotAttachment | null;
    if (attachment?.kind !== "bot" || !attachment.ha || !attachment.id) return;
    const key = botKey(attachment.id);
    const candidates = await this.load<Candidates>("candidates", {});
    if (candidates[key]) {
      delete candidates[key];
      await this.ctx.storage.put("candidates", candidates);
    }
    await this.drop(key);
  }

  private async load<T>(key: string, fallback: T): Promise<T> {
    return ((await this.ctx.storage.get<T>(key)) ?? fallback) as T;
  }

  private async shopId(): Promise<string | null> {
    return this.shop ?? (this.shop = (await this.ctx.storage.get<string>("shop")) ?? null);
  }

  /** Remember the shop this object belongs to; written once, not on every report. */
  private async rememberShop(shopId: string): Promise<void> {
    if ((await this.shopId()) === shopId) return;
    this.shop = shopId;
    await this.ctx.storage.put("shop", shopId);
  }

  /** An IO announcing it can watch Home Assistant has connected. */
  async relayOnline(shopId: string, machineId: string, channel: string): Promise<void> {
    await this.rememberShop(shopId);
    await this.addCandidate({ machineId, channel, since: Date.now() });
  }

  /** A bot that can watch Home Assistant has said hello. */
  private async botOnline(shopId: string, id: string, name: string | undefined): Promise<void> {
    await this.rememberShop(shopId);
    await this.addCandidate({ machineId: botKey(id), channel: "", since: Date.now(), ...(name ? { label: name } : {}) });
  }

  /** A client that can watch has connected: it is a candidate, and may take a slot at once. */
  private async addCandidate(candidate: Candidate): Promise<void> {
    const candidates = await this.load<Candidates>("candidates", {});
    const key = candidate.machineId;
    candidates[key] = { ...candidate, since: candidates[key]?.since ?? candidate.since };
    await this.ctx.storage.put("candidates", candidates);
    // A reconnecting client lost its assignment with the old connection.
    const watchers = await this.load<Watchers>("watchers", {});
    if (watchers[key]) {
      delete watchers[key];
      await this.ctx.storage.put("watchers", watchers);
    }
    await this.fill();
  }

  /** That IO is gone. Its watch, if it had one, moves to another. */
  async relayOffline(shopId: string, machineId: string): Promise<void> {
    await this.rememberShop(shopId);
    const candidates = await this.load<Candidates>("candidates", {});
    delete candidates[machineId];
    await this.ctx.storage.put("candidates", candidates);
    await this.drop(machineId);
  }

  /**
   * The platform switched this IO off. It will not report again, so there is no
   * point waiting out its lease: its watch moves now, and it is not chosen again
   * until it says hello.
   */
  async markDown(shopId: string, machineId: string): Promise<void> {
    await this.rememberShop(shopId);
    const candidates = await this.load<Candidates>("candidates", {});
    if (candidates[machineId]) {
      candidates[machineId] = { ...candidates[machineId]!, downUntil: Date.now() + BENCH_MS };
      await this.ctx.storage.put("candidates", candidates);
    }
    await this.drop(machineId);
  }

  private async drop(machineId: string) {
    const watchers = await this.load<Watchers>("watchers", {});
    if (watchers[machineId]) {
      delete watchers[machineId];
      await this.ctx.storage.put("watchers", watchers);
    }
    await this.fill();
  }

  /** Devices, connections or the shop's number of watchers changed: rebuild what is watched and tell the watchers. */
  async refresh(shopId: string): Promise<void> {
    await this.rememberShop(shopId);
    // The platform administrator's number for this shop; this object keeps its own copy.
    await this.ctx.storage.put("limit", await readWatcherLimit(this.env.DB, shopId));
    // Which devices an entity drives may have changed; the next full snapshot rewrites every fact.
    await this.ctx.storage.put("states", {});
    const watchers = await this.load<Watchers>("watchers", {});
    const watch = await this.buildWatch(shopId);
    if (!watch) {
      await this.release(watchers);
      return;
    }
    for (const watcher of Object.values(watchers)) {
      if (!(await this.reassign(watcher, watch, true))) delete watchers[watcher.machineId];
    }
    await this.ctx.storage.put("watchers", watchers);
    await this.fill();
  }

  /** Stop every watcher: nothing is left to watch. */
  private async release(watchers: Watchers) {
    for (const watcher of Object.values(watchers)) await this.tell(watcher, null);
    await this.ctx.storage.put("watchers", {});
    await this.schedule();
    await this.publish({});
  }

  /**
   * Hand a watcher what to watch, or with null take it away. An IO is reached through its relay, a bot
   * on its own socket. False when it could not be told.
   */
  private async tell(watcher: Pick<Watcher, "machineId" | "channel">, watch: HaWatch | null): Promise<boolean> {
    if (isBot(watcher.machineId)) {
      const socket = this.botSocket(watcher.machineId);
      if (!socket) return false;
      try {
        socket.send(JSON.stringify(watch ? { type: "ha.watch", watch } : { type: "ha.unwatch" }));
        return true;
      } catch {
        return false;
      }
    }
    const relay = machineRelayNamespace(this.env);
    if (!relay) return false;
    try {
      return (await relay.getByName(watcher.channel).watchHa(watch)).ok;
    } catch {
      return false;
    }
  }

  /** The connection of the bot with this key, if it is still there. */
  private botSocket(key: string): WebSocket | undefined {
    return this.bots().find((ws) => {
      const attachment = ws.deserializeAttachment() as BotAttachment | null;
      return !!attachment?.id && botKey(attachment.id) === key;
    });
  }

  /** Whether some IO is watching right now. */
  async watching(): Promise<Array<{ machineId: string; leaseUntil: number }>> {
    const now = Date.now();
    return Object.values(await this.load<Watchers>("watchers", {}))
      .filter((watcher) => watcher.leaseUntil > now)
      .map(({ machineId, leaseUntil }) => ({ machineId, leaseUntil }));
  }

  /**
   * Reports are handled one at a time. Two watchers deliver the same event together, and the second
   * must find what the first stored before it decides whether the event is new; the storage and
   * database calls in between would otherwise let both think so and push it twice.
   */
  private reports: Promise<unknown> = Promise.resolve();

  async haReport(shopId: string, machineId: string, report: HaReport): Promise<void> {
    const turn = this.reports.then(() => this.takeReport(shopId, machineId, report));
    this.reports = turn.catch(() => undefined);
    return turn;
  }

  private async takeReport(shopId: string, machineId: string, report: HaReport): Promise<void> {
    await this.rememberShop(shopId);
    const current = (await this.load<Watchers>("watchers", {}))[machineId];
    // An earlier assignment, or a client that is not a watcher: not ours to trust.
    if (!current || current.term !== report.params.term) return;
    const { term } = current;
    const connection = report.params.connection;

    if (report.method === "ha.states") {
      // The facts are stored before the connection can be announced as watched.
      if (!(await this.apply(connection, report.params.states))) {
        await this.resync(machineId, term, connection);
        return;
      }
    }

    // Storage and D1 calls above may have let another report in: change the freshest copy.
    const watchers = await this.load<Watchers>("watchers", {});
    const watcher = watchers[machineId];
    if (!watcher || watcher.term !== term) return;
    watcher.leaseUntil = Date.now() + LEASE_MS;
    const link = (watcher.links[connection] ??= { connected: false, snapshot: false });
    if (report.method === "ha.status") {
      link.connected = report.params.connected;
      if (!link.connected) {
        link.snapshot = false;
        // This client cannot reach Home Assistant; another one that is not watching yet may.
        const now = Date.now();
        const spare = Object.values(await this.load<Candidates>("candidates", {}))
          .some((candidate) => !watchers[candidate.machineId] && (candidate.downUntil ?? 0) <= now);
        if (spare) {
          await this.bench(machineId);
          delete watchers[machineId];
          await this.ctx.storage.put("watchers", watchers);
          // It is not coming back soon, and left alone it would go on trying in the background.
          await this.tell(watcher, null);
          await this.fill();
          return;
        }
      }
    } else {
      link.connected = true;
      if (report.params.full) link.snapshot = true;
    }
    await this.ctx.storage.put("watchers", watchers);
    await this.schedule();
    await this.publish(watchers);
    // A watcher that was outranked keeps going until the ones that stay have this; a snapshot may be
    // what lets it go.
    if (Object.keys(watchers).length > (await this.limit())) await this.fill();
  }

  /**
   * Something that may change idle state happened: activity, an entry or a
   * checkout, a settings change. The check runs shortly after, once per burst.
   */
  async touch(shopId: string): Promise<void> {
    await this.rememberShop(shopId);
    const at = Date.now() + TOUCH_DELAY_MS;
    const pending = await this.ctx.storage.get<number>("touchAt");
    if (pending === undefined || pending > at) await this.ctx.storage.put("touchAt", at);
    await this.schedule();
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    // What is due is settled before anything calls `schedule()`. It would otherwise find the work still
    // pending and set an alarm in the past, which fires again at once, and a runtime may drop an alarm
    // set to the time of the one that is running, leaving nothing to wake for the next lease.
    const touchAt = await this.ctx.storage.get<number>("touchAt");
    const idle = await this.load<IdleMemory>("idle", emptyIdleMemory());
    const idleDue = (touchAt !== undefined && touchAt <= now) || (idle.wakeAt !== null && idle.wakeAt <= now);
    if (idleDue) await this.ctx.storage.delete("touchAt");
    const watchers = await this.load<Watchers>("watchers", {});
    let lost = false;
    for (const watcher of Object.values(watchers)) {
      if (watcher.leaseUntil > now) continue;
      await this.bench(watcher.machineId);
      delete watchers[watcher.machineId];
      lost = true;
    }
    if (lost) await this.ctx.storage.put("watchers", watchers);
    if (idleDue) await this.checkIdle(idle);
    // Also retries a slot that was open because every IO had just failed.
    await this.fill();
    await this.schedule();
  }

  /** When the idle rules will switch devices off, by device, for the board. Times already past are left out. */
  async idleSchedule(): Promise<Record<string, number>> {
    const now = Date.now();
    const { powerOffAt = {} } = await this.load<IdleMemory>("idle", emptyIdleMemory());
    return Object.fromEntries(Object.entries(powerOffAt).filter(([, at]) => at > now));
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
        eventConnections: new Set(await this.load<string[]>("eventConnections", [])),
        reminderLeadMs: await this.reminderLead(),
      });
      await this.ctx.storage.put("idle", result.memory);
      // An IO the idle rule switched off will not report again.
      const candidates = await this.load<Candidates>("candidates", {});
      for (const id of result.poweredOff) {
        if (!candidates[id]) continue;
        candidates[id] = { ...candidates[id]!, downUntil: Date.now() + BENCH_MS };
        await this.ctx.storage.put("candidates", candidates);
        await this.drop(id);
      }
      if (result.notices.length) await this.notify(result.notices);
      // The idle rule's own power-offs: the device bus left them to the hub to tell.
      for (const id of result.poweredOff) {
        const resource = await this.env.DB.prepare("SELECT name FROM machines WHERE shop_id = ? AND id = ?")
          .bind(shopId, id).first<{ name: string }>();
        await this.shopEvent({
          kind: "power", resourceId: id, resourceName: resource?.name ?? id, state: "off", by: "system", player: null,
          at: new Date().toISOString(),
        });
      }
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
    const candidates = await this.load<Candidates>("candidates", {});
    if (!candidates[machineId]) return;
    candidates[machineId] = { ...candidates[machineId]!, benchedUntil: Date.now() + BENCH_MS };
    await this.ctx.storage.put("candidates", candidates);
  }

  /**
   * Who may watch, best first. One that just failed goes last, unless it is watching fine right now
   * (it need not be swapped out for a newcomer); then bots before IOs; then the longest online.
   */
  private ranked(candidates: Candidates, watchers: Watchers, now: number): Candidate[] {
    const benched = (candidate: Candidate) =>
      (candidate.benchedUntil ?? 0) > now &&
      !Object.values(watchers[candidate.machineId]?.links ?? {}).some((link) => link.connected);
    return Object.values(candidates)
      .filter((candidate) => (candidate.downUntil ?? 0) <= now)
      .sort(
        (a, b) =>
          Number(benched(a)) - Number(benched(b)) ||
          Number(!isBot(a.machineId)) - Number(!isBot(b.machineId)) ||
          a.since - b.since,
      );
  }

  /** Forget bots whose connection is gone without a close (a deploy drops them silently). True if anything changed. */
  private pruneBots(candidates: Candidates, watchers: Watchers): boolean {
    const live = new Set(
      this.bots()
        .map((ws) => ws.deserializeAttachment() as BotAttachment | null)
        .filter((attachment): attachment is BotAttachment & { id: string } => !!attachment?.ha && !!attachment.id)
        .map((attachment) => botKey(attachment.id)),
    );
    let changed = false;
    for (const key of Object.keys(candidates)) {
      if (isBot(key) && !live.has(key)) {
        delete candidates[key];
        changed = true;
      }
    }
    for (const key of Object.keys(watchers)) {
      if (isBot(key) && !live.has(key)) {
        delete watchers[key];
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Make the watchers match the ranking: the first `limit` candidates watch, bots ahead of IOs. One
   * that cannot be told is ranked last for a while and the next is tried. A watcher that is no
   * longer among them (a bot came online, the number came down) is sent home, but only once the ones
   * that stay hold a full state for every connection announced as watched; until then it keeps going,
   * so a handover has no gap, and the next snapshot that arrives calls this again.
   */
  private async fill(): Promise<void> {
    const watchers = await this.load<Watchers>("watchers", {});
    const candidates = await this.load<Candidates>("candidates", {});
    const shopId = await this.shopId();
    let changed = this.pruneBots(candidates, watchers);
    const limit = await this.limit();
    const now = Date.now();
    const kept = new Set<string>();
    let built = false;
    let watch: Omit<HaWatch, "term"> | null = null;
    if (shopId) {
      for (const candidate of this.ranked(candidates, watchers, now)) {
        if (kept.size >= limit) break;
        if (watchers[candidate.machineId]) {
          kept.add(candidate.machineId);
          continue;
        }
        if (!built) {
          watch = await this.buildWatch(shopId);
          built = true;
        }
        if (!watch) {
          // Nothing to watch: no Home Assistant has a read-only account yet.
          await this.release(watchers);
          return;
        }
        const watcher: Watcher = {
          machineId: candidate.machineId,
          channel: candidate.channel,
          ...(candidate.label ? { label: candidate.label } : {}),
          term: 0,
          leaseUntil: 0,
          links: {},
        };
        if (await this.reassign(watcher, watch, false)) {
          watchers[candidate.machineId] = watcher;
          kept.add(candidate.machineId);
        } else {
          candidates[candidate.machineId] = { ...candidate, benchedUntil: Date.now() + BENCH_MS };
        }
        changed = true;
      }
      if (await this.retire(watchers, kept)) changed = true;
    }
    if (changed) {
      await this.ctx.storage.put("candidates", candidates);
      await this.ctx.storage.put("watchers", watchers);
    }
    await this.schedule();
    await this.publish(watchers);
  }

  /** Send outranked watchers home when the ones that stay already hold everything announced as watched. */
  private async retire(watchers: Watchers, kept: ReadonlySet<string>): Promise<boolean> {
    const excess = Object.keys(watchers).filter((key) => !kept.has(key));
    if (!excess.length) return false;
    const now = Date.now();
    const announced = await this.load<string[]>("eventConnections", []);
    const covered = announced.every((connection) =>
      [...kept].some((key) => {
        const link = watchers[key]?.links[connection];
        return !!watchers[key] && watchers[key]!.leaseUntil > now && !!link?.connected && link.snapshot;
      }),
    );
    if (!covered) return false;
    for (const key of excess) {
      await this.tell(watchers[key]!, null);
      delete watchers[key];
    }
    return true;
  }

  /**
   * Send the watch to one watcher under a new term. False when it could not be told.
   * With `keepSnapshots` the connections it already delivered stay announced
   * while its new term catches up; they are dropped if they left the watch.
   */
  private async reassign(watcher: Watcher, watch: Omit<HaWatch, "term">, keepSnapshots: boolean): Promise<boolean> {
    const term = (await this.load<number>("term", 0)) + 1;
    await this.ctx.storage.put("term", term);
    if (!(await this.tell(watcher, { ...watch, term }))) return false;
    const wanted = new Set(watch.connections.map((connection) => connection.id));
    watcher.links = Object.fromEntries(
      Object.entries(watcher.links)
        .filter(([id]) => wanted.has(id))
        .map(([id, link]) => [id, { connected: link.connected, snapshot: keepSnapshots && link.snapshot }]),
    );
    watcher.term = term;
    // It has one lease period to report; its first report is the full state.
    watcher.leaseUntil = Date.now() + LEASE_MS;
    return true;
  }

  /** Storing a report failed: have the IO subscribe again so a full state arrives to store. */
  private async resync(machineId: string, term: number, connection: string) {
    const now = Date.now();
    if (now - this.lastResync < RESYNC_MS) return;
    this.lastResync = now;
    const shopId = await this.shopId();
    const watchers = await this.load<Watchers>("watchers", {});
    const watcher = watchers[machineId];
    if (!shopId || !watcher || watcher.term !== term) return;
    if (watcher.links[connection]) watcher.links[connection]!.snapshot = false;
    const watch = await this.buildWatch(shopId);
    if (!watch || !(await this.reassign(watcher, watch, true))) return;
    await this.ctx.storage.put("watchers", watchers);
    await this.publish(watchers);
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
      const entities = [...new Set(rows.filter((row) => row.connection_id === connection.id && row.entity_id).map((row) => row.entity_id!))];
      if (!entities.length) continue;
      if (!connection.readToken) {
        // Saved before read-only accounts existed, so nobody ever tried; nothing else would.
        if (connection.readAccess === null) this.makeReadAccess(shopId, connection.id);
        continue;
      }
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

  /** Connections a read-only account is being made for right now. */
  private makingReadAccess = new Set<string>();
  /** What makes the account; a test replaces it. */
  private provision: typeof provisionReadAccess = provisionReadAccess;

  /**
   * Make the read-only account for a connection that never had one, once an IO is here to use it,
   * and start the watch when it is ready. Done here and not in a request because this object is
   * the one place per shop that can see it already running: two runs would each create a user in
   * Home Assistant and leave the first with a token that still works. A connection that ends up
   * `needs_admin` or `failed` is not tried again; the board's editor says why.
   */
  private makeReadAccess(shopId: string, connectionId: string) {
    const key = this.env.URL_ENCRYPTION_KEY;
    const origin = this.env.APP_ORIGIN;
    if (!key || !origin || this.makingReadAccess.has(connectionId)) return;
    this.makingReadAccess.add(connectionId);
    const run = this.provision(this.env.DB, shopId, connectionId, key, { origin })
      .then((result) => (result.access === "ready" ? this.refresh(shopId) : undefined))
      .catch((error) => console.error("Home Assistant read access failed", error))
      .finally(() => this.makingReadAccess.delete(connectionId));
    this.ctx.waitUntil?.(run);
  }

  /**
   * Store what a watcher reported and push it to the pages of the devices it
   * drives. A report that is a repeat, or older than what is already applied (the
   * second watcher saw the same event, or saw it later), changes nothing. False
   * when the facts could not be stored.
   */
  private async apply(connectionId: string, reported: HaEntityState[]): Promise<boolean> {
    const shopId = await this.shopId();
    if (!shopId) return true;
    const states = await this.load<Record<string, WatchedState>>("states", {});
    const targets = await this.load<Targets>("targets", {});
    const applied: Record<string, WatchedState> = {};
    const writes: StateWrite[] = [];
    const pushes: Array<[string, Record<string, unknown>]> = [];
    let powerMoved = false;
    for (const item of reported) {
      const key = entityKey(connectionId, item.entity_id);
      const previous = applied[key] ?? states[key];
      const stamp = stampOf(item);
      if (previous && superseded(previous, item, stamp)) continue;
      const next: WatchedState = { state: item.state, attributes: item.attributes, lastChanged: item.last_changed, stamp };
      applied[key] = next;
      const at = item.last_changed ? new Date(item.last_changed) : undefined;
      for (const target of targets[key] ?? []) {
        const device = { id: target.deviceId };
        if (target.capability === "power") {
          // A repeat of the same state (an attribute-only update) has nothing new to say.
          if (previous?.state === next.state) continue;
          const power = next.state === "on" || next.state === "off" ? next.state : null;
          writes.push({ device, capability: "power", key: "power", value: power, ...(at ? { at } : {}) });
          pushes.push([target.deviceId, { type: "state", power }]);
          if (previous) powerMoved = true;
        } else {
          const known = next.state !== "unavailable" && next.state !== "unknown";
          const view = known ? climateState(next.state, next.attributes) : null;
          // The page shows room temperature too, so it gets every change and the
          // log only gets the setting.
          writes.push({ device, capability: "climate", key: "view", value: view, quiet: true, ...(at ? { at } : {}) });
          if (!previous || JSON.stringify(settingOf(previous)) !== JSON.stringify(settingOf(next)))
            writes.push({ device, capability: "climate", key: "climate", value: known ? settingOf(next) : null, ...(at ? { at } : {}) });
          pushes.push([target.deviceId, { type: "state", climate: view }]);
        }
      }
    }
    if (writes.length) {
      const bus = createRuntimeBus({ db: this.env.DB, env: this.env, shopId, notifyHub: false });
      try {
        for (let start = 0; start < writes.length; start += WRITE_CHUNK) await bus.reportMany(writes.slice(start, start + WRITE_CHUNK));
      } catch (error) {
        console.error("Shop hub state write failed", error);
        return false;
      }
    }
    if (Object.keys(applied).length) await this.ctx.storage.put("states", { ...states, ...applied });
    // A board is told of a device's change only while the device is live, that is while every
    // Home Assistant connection it uses is announced. The first snapshot of a connection reaches
    // a board as the whole shop once it is announced, not as a change per device before.
    const announced = new Set(await this.load<string[]>("eventConnections", []));
    const connectionsOf = new Map<string, string[]>();
    for (const [key, list] of Object.entries(targets))
      for (const target of list) connectionsOf.set(target.deviceId, [...(connectionsOf.get(target.deviceId) ?? []), connectionOf(key)]);
    const live = (deviceId: string) => (connectionsOf.get(deviceId) ?? []).every((id) => announced.has(id));
    for (const [deviceId, frame] of pushes) {
      this.toPages(deviceId, frame);
      if (live(deviceId)) this.toBoards({ ...frame, deviceId });
    }
    // Switched on starts an idle countdown; switched off may end one.
    if (powerMoved) await this.touch(shopId);
    return true;
  }

  /**
   * Make `ha_event_connections` match the watchers: a connection is in it when a
   * live watcher has it subscribed and has delivered its full state. Called after
   * every change; the table is only written, and pages only told, when the set
   * moved. A failed write is retried by the next call.
   */
  private async publish(watchers: Watchers) {
    // Who is watching is told to the boards on its own: it changes without a connection starting or stopping.
    await this.announceWatchers(watchers);
    const shopId = await this.shopId();
    if (!shopId) return;
    const now = Date.now();
    const live = new Set<string>();
    for (const watcher of Object.values(watchers)) {
      if (watcher.leaseUntil <= now) continue;
      for (const [id, link] of Object.entries(watcher.links)) if (link.connected && link.snapshot) live.add(id);
    }
    const previous = new Set(await this.load<string[]>("eventConnections", []));
    const add = [...live].filter((id) => !previous.has(id));
    const remove = [...previous].filter((id) => !live.has(id));
    if (!add.length && !remove.length) return;
    try {
      await writeEventConnections(this.env.DB, shopId, { add, remove });
    } catch (error) {
      console.error("Shop hub watch mode write failed", error);
      return;
    }
    await this.ctx.storage.put("eventConnections", [...live]);
    await this.announce(live, new Set([...add, ...remove]));
    await this.announceBoards();
  }

  /** Wake for the earliest thing that needs checking. */
  private async schedule() {
    const now = Date.now();
    const watchers = await this.load<Watchers>("watchers", {});
    const touchAt = await this.ctx.storage.get<number>("touchAt");
    const idle = await this.ctx.storage.get<IdleMemory>("idle");
    const candidates = await this.load<Candidates>("candidates", {});
    // An open slot is retried when a benched or switched-off candidate becomes eligible again.
    const retry = Object.keys(watchers).length < (await this.limit())
      ? Object.values(candidates)
          .filter((candidate) => !watchers[candidate.machineId])
          .flatMap((candidate) => [candidate.benchedUntil, candidate.downUntil])
          .filter((at): at is number => typeof at === "number" && at > now)
      : [];
    const due = [...Object.values(watchers).map((watcher) => watcher.leaseUntil), touchAt, idle?.wakeAt ?? undefined, ...retry]
      .filter((at): at is number => typeof at === "number")
      .reduce<number | null>((earliest, at) => (earliest === null || at < earliest ? at : earliest), null);
    const getAlarm = this.ctx.storage.getAlarm?.bind(this.ctx.storage);
    const current = getAlarm ? await getAlarm() : null;
    if (due === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm?.();
      return;
    }
    // A heartbeat only pushes the lease later, so an earlier alarm is left to fire
    // and set the next one: that is one wake per lease period, not one per report.
    if (current === null || current > due) await this.ctx.storage.setAlarm(due);
  }
}
