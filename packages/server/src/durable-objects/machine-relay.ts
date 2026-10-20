import type { DurableObject } from "cloudflare:workers";
import type { Env } from "../bindings.js";
import { hinataIo } from "../devices/capabilities.js";
import { createRuntimeBus } from "../devices/runtime.js";
import { shopHub } from "./shop-hub-client.js";
import {
  capabilitiesForAttachment,
  capabilitiesFromRequest,
  ioEventSource,
  parseClientHello,
  parseHaReport,
  parseIoEvent,
  prepareMessageForClient,
  type ClientCapabilities,
  type IoEventMethod,
  type RelayMessage,
} from "../hardware/aimeio-relay.js";

const STATE_KEY = "state-message";
const CHANNEL_KEY = "channel";

/** The IO forgets a remote card this long after receiving it unless told otherwise. */
const CARD_LIFETIME_MS = 3000;

/** IO event methods as device signals of the `hinata_io` capability. */
const SIGNAL_NAMES: Record<IoEventMethod, string> = {
  "event.cardStateChanged": "card.state",
  "event.cardConsumed": "card.consumed",
  "event.ledSet": "led.set",
};

type Channel = { shopId: string; machineId: string; channel?: string };

/**
 * Per-socket state. It lives in the socket attachment rather than on the
 * object, because a hibernated object wakes with its fields reset while its
 * sockets and their attachments survive.
 */
type Attachment = ClientCapabilities & { e2ee?: boolean; ha?: boolean };

/**
 * What the IO assigned to watch the shop's Home Assistants should subscribe to.
 * `urls` are tried in order (the shop-local address first); the token is a
 * read-only account's. `term` identifies this assignment in every report.
 */
export type HaWatch = {
  term: number;
  connections: Array<{ id: string; urls: string[]; token: string; entities: string[] }>;
};

/**
 * What became of a card sent to a waiting game: the reader turned blue (signed
 * in) or red/yellow (rejected), the game took it but showed no verdict, or it
 * expired unread because the game was not polling the reader.
 */
export type CardLoginResult = "ok" | "failed" | "read" | "not_read";

/** How long to wait for each step of a card login. */
export type CardWaitLimits = { readMs: number; resultMs: number };

/** A stored card is only worth replaying while the IO would still hold it. */
type StoredCard = { message: RelayMessage; expiresAt: number; source?: string };

/** `unit` stays null until the game takes the card from one of its readers. */
type CardWait = {
  unit: number | null;
  resultMs: number;
  timer: ReturnType<typeof setTimeout>;
  settle: (result: CardLoginResult) => void;
};

/** A consumed event without a reader number matches a colour on any reader. */
const ANY_UNIT = -1;

/** Reader colours a waiting game shows once its server has answered for the card. */
export function loginVerdict(r: unknown, g: unknown, b: unknown): "ok" | "failed" | null {
  if (r === 0 && g === 0 && b === 255) return "ok";
  if (r === 255 && b === 0 && (g === 0 || g === 255)) return "failed";
  return null;
}

const unitOf = (params: Record<string, unknown>) =>
  typeof params.unit_no === "number" && Number.isInteger(params.unit_no) ? params.unit_no : null;

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
 * Per-machine relay channel.
 *
 * The device connects here as `role=agent`. This platform is the controller, so
 * it calls the methods below directly rather than POSTing to a relay over HTTP —
 * that is what removes the extra hop and the public controller endpoints.
 *
 * Only the Worker can reach a Durable Object, and the Worker authenticates the
 * device token and resolves the channel before dispatching, so this class trusts
 * the channel headers it is given and never parses a credential itself.
 */
export class MachineRelay extends BaseDurableObject<Env> {
  /**
   * Cards a caller is waiting on, by operation id. Memory is enough: the waiting
   * call keeps the object awake, and nothing else reads these.
   */
  private readonly waits = new Map<string, CardWait>();

  private socketCapabilities(ws: WebSocket): ClientCapabilities {
    return capabilitiesForAttachment(ws.deserializeAttachment());
  }

  private agents(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => this.socketCapabilities(ws).role === "agent");
  }

  private socketE2ee(ws: WebSocket): boolean {
    return (ws.deserializeAttachment() as Attachment | null)?.e2ee === true;
  }

  private async channel(): Promise<Channel | null> {
    return (await this.ctx.storage.get<Channel>(CHANNEL_KEY)) ?? null;
  }

  /**
   * Record through the device bus. Storage failures are logged and swallowed:
   * losing an audit row must not break card delivery to the game.
   */
  private async record(what: string, write: (bus: ReturnType<typeof createRuntimeBus>, channel: Channel) => Promise<unknown>) {
    const channel = await this.channel();
    if (!channel) return;
    try {
      await write(createRuntimeBus({ db: this.env.DB, env: this.env, shopId: channel.shopId }), channel);
    } catch (error) {
      console.error(JSON.stringify({
        event: "machine_relay_record_failed",
        machineId: channel.machineId,
        what,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private setLink(online: boolean) {
    return this.record("link", (bus, channel) =>
      bus.setOwned({ device: { id: channel.machineId }, capability: "hinata_io", key: "link", value: online ? "online" : "offline" }),
    );
  }

  /**
   * WebSocket upgrade from a device. A request without the gateway's channel
   * headers did not come through the authenticated path and is refused.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const shopId = request.headers.get("x-prism-relay-shop");
    const machineId = request.headers.get("x-prism-relay-machine");
    if (!shopId || !machineId) {
      return new Response("Missing relay channel", { status: 400 });
    }
    const channel = request.headers.get("x-prism-relay-channel") ?? undefined;
    await this.ctx.storage.put<Channel>(CHANNEL_KEY, { shopId, machineId, ...(channel ? { channel } : {}) });

    const capabilities = capabilitiesFromRequest(request);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(capabilities satisfies Attachment);
    if (capabilities.role === "agent") await this.setLink(true);

    // A reconnecting device cleared its card locally, so it must learn the card
    // it was still holding. Only while it would still hold it: a card replayed
    // after its lifetime would sign the last player in again on a later boot.
    const stored = await this.storedCard();
    if (stored) {
      try {
        server.send(prepareMessageForClient(JSON.stringify(stored.message), capabilities));
      } catch {
        // Socket already gone; the next command will deliver the state again.
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The card to hand a reconnecting device, dropping one that has lapsed. */
  private async storedCard(): Promise<StoredCard | null> {
    const stored = await this.ctx.storage.get<Partial<StoredCard>>(STATE_KEY);
    if (!stored) return null;
    // Older objects stored the bare message with no lifetime; treat it as lapsed.
    if (!stored.message || typeof stored.expiresAt !== "number" || stored.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(STATE_KEY);
      return null;
    }
    return stored as StoredCard;
  }

  /** What the connected IO reported about itself, for the device board. */
  async getCapabilities(): Promise<{
    online: boolean;
    e2ee: boolean;
    agents: Array<{ cardProtocol: number; clientVersion: string }>;
  }> {
    const agents = this.agents().map((ws) => {
      const { cardProtocol, clientVersion } = this.socketCapabilities(ws);
      return { cardProtocol, clientVersion };
    });
    return { online: agents.length > 0, e2ee: this.agents().some((ws) => this.socketE2ee(ws)), agents };
  }

  /**
   * Deliver a card and remember it for replay.
   *
   * `source` rides along so a later `event.cardConsumed` can be tied back to the
   * exact operation that sent the card. With `wait`, the call returns only once
   * the game has taken the card and its reader showed a verdict, or a limit ran out.
   */
  async sendCard(input: {
    accessCode: string;
    source?: string;
    disposable?: boolean;
    duration?: number;
    wait?: CardWaitLimits;
  }): Promise<{ ok: boolean; error?: string; login?: CardLoginResult }> {
    // The IO holds one card at a time, so a newer card ends any older wait.
    for (const [source, wait] of this.waits) if (wait.unit === null) this.finish(source, "not_read");
    const waiting = input.wait && input.source ? this.waitFor(input.source, input.wait) : null;
    const lifetime = input.duration ?? CARD_LIFETIME_MS;
    const sent = await this.deliver(
      {
        action: "SET_CARD",
        body: {
          type: "aime",
          value: input.accessCode,
          disposable: input.disposable ?? true,
          ...(input.source ? { source: input.source } : {}),
          ...(input.duration ? { duration: input.duration } : {}),
        },
      },
      { expiresAt: Date.now() + lifetime, ...(input.source ? { source: input.source } : {}) },
    );
    if (!sent.ok) {
      if (input.source) this.finish(input.source, "not_read", false);
      return sent;
    }
    return waiting ? { ok: true, login: await waiting } : sent;
  }

  /** Start waiting before the card leaves, so a fast game cannot beat the wait. */
  private waitFor(source: string, limits: CardWaitLimits): Promise<CardLoginResult> {
    return new Promise((resolve) => {
      this.waits.set(source, {
        unit: null,
        resultMs: limits.resultMs,
        timer: setTimeout(() => this.finish(source, "not_read"), limits.readMs),
        settle: resolve,
      });
    });
  }

  private finish(source: string, result: CardLoginResult, settle = true) {
    const wait = this.waits.get(source);
    if (!wait) return;
    clearTimeout(wait.timer);
    this.waits.delete(source);
    if (settle) wait.settle(result);
  }

  /** The game took the card: now wait for that reader's colour. */
  private cardTaken(source: string, unit: number | null) {
    const wait = this.waits.get(source);
    if (!wait || wait.unit !== null) return;
    clearTimeout(wait.timer);
    wait.unit = unit ?? ANY_UNIT;
    wait.timer = setTimeout(() => this.finish(source, "read"), wait.resultMs);
  }

  private readerColour(params: Record<string, unknown>) {
    const verdict = loginVerdict(params.r, params.g, params.b);
    if (!verdict) return;
    const unit = unitOf(params);
    for (const [source, wait] of this.waits) {
      // A cabinet has a reader per player; only the one that took the card counts.
      if (wait.unit === null || (wait.unit !== ANY_UNIT && wait.unit !== unit)) continue;
      this.finish(source, verdict);
      void this.record("card.login", (bus, channel) =>
        bus.signal({
          device: { id: channel.machineId },
          capability: "hinata_io",
          name: "card.login",
          operationId: source,
          payload: { result: verdict, unit_no: unit },
        }),
      );
    }
  }

  /**
   * Ask the device to press a key.
   *
   * Not stored as channel state: a coin press is one-shot, and replaying it to a
   * reconnecting device would press the key a second time. `messageId` and
   * `expiresAt` are required because the device rejects a plaintext press
   * without them — that is its only replay protection once E2EE is off.
   */
  async sendKeyPress(input: {
    key: number;
    messageId: string;
    expiresAt: number;
    count?: number;
  }): Promise<{ ok: boolean; error?: string }> {
    if (!Number.isInteger(input.key) || input.key < 1 || input.key > 65535) {
      return { ok: false, error: "投币按键值必须在 1 到 65535 之间。" };
    }
    const count = input.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      return { ok: false, error: "投币次数必须在 1 到 20 之间。" };
    }
    return this.deliver(
      {
        action: "KEY_PRESS",
        body: {
          key: input.key,
          count,
          message_id: input.messageId,
          expires_at: input.expiresAt,
        },
      },
      null,
    );
  }

  private async deliver(
    message: RelayMessage,
    store: Omit<StoredCard, "message"> | null,
  ): Promise<{ ok: boolean; error?: string }> {
    const agents = this.agents();
    if (agents.length === 0) return { ok: false, error: "机台未在线或连接地址不正确。" };
    // A device that announced E2EE cannot read plaintext, and it rejects every
    // plaintext command. Saying so beats a silent no-op on the device screen.
    if (agents.some((ws) => this.socketE2ee(ws))) {
      return {
        ok: false,
        error: "该机台仍配置了 remotePassword（端到端加密），直连模式需要将其清空。",
      };
    }
    if (store) await this.ctx.storage.put<StoredCard>(STATE_KEY, { message, ...store });
    const encoded = JSON.stringify(message);
    for (const ws of agents) {
      try {
        ws.send(prepareMessageForClient(encoded, this.socketCapabilities(ws)));
      } catch {
        // A dead socket is reaped by the runtime; the others still receive it.
      }
    }
    return { ok: true };
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    // The IO announces its transports on connect, before anything else.
    const hello = parseClientHello(parsed);
    if (hello) {
      const ha = hello.features.includes("ha.watch");
      ws.serializeAttachment({ ...this.socketCapabilities(ws), e2ee: hello.e2ee, ha } satisfies Attachment);
      const channel = await this.channel();
      if (ha && channel?.channel) {
        await shopHub(this.env, channel.shopId)
          ?.relayOnline(channel.shopId, channel.machineId, channel.channel)
          .catch((error) => console.error("Shop hub relayOnline failed", error));
      }
      return;
    }

    const report = parseHaReport(parsed);
    if (report) {
      const channel = await this.channel();
      if (channel) {
        await shopHub(this.env, channel.shopId)
          ?.haReport(channel.shopId, channel.machineId, report)
          .catch((error) => console.error("Shop hub haReport failed", error));
      }
      return;
    }

    const event = parseIoEvent(message);
    if (!event) return;
    if (event.method === "event.ledSet") {
      // Never stored, but a waiting card login reads its verdict from it.
      this.readerColour(event.params);
      return;
    }
    const name = SIGNAL_NAMES[event.method];
    const source = ioEventSource(event.params);
    if (event.method === "event.cardConsumed" && source) {
      this.cardTaken(source, unitOf(event.params));
      // The game has the card, so a reconnect must not hand it over again.
      const stored = await this.ctx.storage.get<Partial<StoredCard>>(STATE_KEY);
      if (stored?.source === source) await this.ctx.storage.delete(STATE_KEY);
    }
    if (!hinataIo.signals[name]?.store) return;
    await this.record(name, (bus, channel) =>
      bus.signal({
        device: { id: channel.machineId },
        capability: "hinata_io",
        name,
        operationId: source,
        payload: event.params,
      }),
    );
    // Someone is at this machine; its idle countdown starts over.
    if (hinataIo.signals[name]?.activity) await this.touchHub();
  }

  private async touchHub() {
    const channel = await this.channel();
    if (!channel) return;
    await shopHub(this.env, channel.shopId)?.touch(channel.shopId).catch((error) => console.error("Shop hub touch failed", error));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Hibernation sockets need the server to finish the closing handshake.
    // 1005/1006/1015 are reserved and cannot be sent in a close frame.
    const responseCode = [1005, 1006, 1015].includes(code) ? 1000 : code;
    try {
      ws.close(responseCode, reason);
    } catch {
      // Already closed.
    }
    if (this.socketCapabilities(ws).role !== "agent") return;
    if (!this.agents().some((other) => other !== ws)) await this.setLink(false);
    const watching = (ws.deserializeAttachment() as Attachment | null)?.ha;
    if (watching && !this.watchers().some((other) => other !== ws)) {
      const channel = await this.channel();
      if (channel) {
        await shopHub(this.env, channel.shopId)
          ?.relayOffline(channel.shopId, channel.machineId)
          .catch((error) => console.error("Shop hub relayOffline failed", error));
      }
    }
  }

  /** Connected IOs that said they can watch Home Assistant. */
  private watchers(): WebSocket[] {
    return this.agents().filter((ws) => (ws.deserializeAttachment() as Attachment | null)?.ha === true);
  }

  /**
   * Hand this machine's IO the Home Assistant watch for the shop, or take it
   * away with `null`. Not stored: the shop hub sends it again on reconnect.
   */
  async watchHa(watch: HaWatch | null): Promise<{ ok: boolean }> {
    const [socket] = this.watchers();
    if (!socket) return { ok: false };
    try {
      socket.send(JSON.stringify(watch ? { action: "HA_WATCH", body: watch } : { action: "HA_UNWATCH", body: {} }));
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  async webSocketError(): Promise<void> {
    // The runtime drops the socket; there is nothing to release.
  }
}
