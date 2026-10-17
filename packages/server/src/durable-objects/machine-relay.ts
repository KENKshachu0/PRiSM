import type { DurableObject } from "cloudflare:workers";
import type { Env } from "../bindings.js";
import { hinataIo } from "../devices/capabilities.js";
import { createRuntimeBus } from "../devices/runtime.js";
import {
  capabilitiesForAttachment,
  capabilitiesFromRequest,
  ioEventSource,
  parseClientHello,
  parseIoEvent,
  prepareMessageForClient,
  type ClientCapabilities,
  type IoEventMethod,
  type RelayMessage,
} from "../hardware/aimeio-relay.js";

const STATE_KEY = "state-message";
const CHANNEL_KEY = "channel";

/** IO event methods as device signals of the `hinata_io` capability. */
const SIGNAL_NAMES: Record<IoEventMethod, string> = {
  "event.cardStateChanged": "card.state",
  "event.cardConsumed": "card.consumed",
  "event.ledSet": "led.set",
};

type Channel = { shopId: string; machineId: string };

/**
 * Per-socket state. It lives in the socket attachment rather than on the
 * object, because a hibernated object wakes with its fields reset while its
 * sockets and their attachments survive.
 */
type Attachment = ClientCapabilities & { e2ee?: boolean };

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
    await this.ctx.storage.put<Channel>(CHANNEL_KEY, { shopId, machineId });

    const capabilities = capabilitiesFromRequest(request);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(capabilities satisfies Attachment);
    if (capabilities.role === "agent") await this.setLink(true);

    // A reconnecting device cleared its card locally, so it must learn the card
    // it is still holding.
    const state = await this.ctx.storage.get<RelayMessage>(STATE_KEY);
    if (state) {
      try {
        server.send(prepareMessageForClient(JSON.stringify(state), capabilities));
      } catch {
        // Socket already gone; the next command will deliver the state again.
      }
    }
    return new Response(null, { status: 101, webSocket: client });
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
   * exact operation that sent the card.
   */
  async sendCard(input: {
    accessCode: string;
    source?: string;
    disposable?: boolean;
    duration?: number;
  }): Promise<{ ok: boolean; error?: string }> {
    return this.deliver(
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
      true,
    );
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
      false,
    );
  }

  private async deliver(
    message: RelayMessage,
    store: boolean,
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
    if (store) await this.ctx.storage.put(STATE_KEY, message);
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
      ws.serializeAttachment({ ...this.socketCapabilities(ws), e2ee: hello.e2ee } satisfies Attachment);
      return;
    }

    const event = parseIoEvent(message);
    if (!event) return;
    const name = SIGNAL_NAMES[event.method];
    // The bus drops signals the catalog does not store (per-frame LED updates);
    // checking first skips the storage round trip for them entirely.
    if (!hinataIo.signals[name]?.store) return;
    await this.record(name, (bus, channel) =>
      bus.signal({
        device: { id: channel.machineId },
        capability: "hinata_io",
        name,
        operationId: ioEventSource(event.params),
        payload: event.params,
      }),
    );
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
  }

  async webSocketError(): Promise<void> {
    // The runtime drops the socket; there is nothing to release.
  }
}
