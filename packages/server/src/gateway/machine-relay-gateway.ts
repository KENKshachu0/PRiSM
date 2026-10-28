import type { Env } from "../bindings.js";
import { sha256Hex } from "../crypto.js";
import type { CardLoginResult, CardWaitLimits, HaWatch } from "../durable-objects/machine-relay.js";
import { machineRelayPath } from "./relay-path.js";

export type RelayGatewayResult =
  | { kind: "not-relay" }
  | { kind: "rejected"; response: Response }
  | { kind: "dispatch"; channel: string; shopId: string; machineId: string };

type ResourceRow = { device_id: string; shop_id: string; channel: string | null };

/**
 * Authenticate a device connecting to the embedded relay.
 *
 * The IO presents its token as a Bearer header on the WebSocket upgrade request,
 * which is the last point where a credential can be checked before the socket
 * exists. The channel is resolved *from* the token, so nothing identifying
 * appears in the URL and there is no channel to enumerate.
 */
export async function relayGateway(
  request: Request,
  env: Env,
): Promise<RelayGatewayResult> {
  const url = new URL(request.url);
  if (url.pathname !== machineRelayPath) return { kind: "not-relay" };

  if (!env.MACHINE_RELAY) {
    return { kind: "rejected", response: rejected("relay binding not configured") };
  }
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return { kind: "rejected", response: new Response("Expected Upgrade: websocket", { status: 426 }) };
  }
  const token = request.headers.get("Authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return { kind: "rejected", response: rejected("missing bearer token") };

  const tokenHash = await sha256Hex(token);
  const device = await env.DB.prepare(
    `SELECT c.device_id, c.shop_id, json_extract(c.config_json, '$.channel') AS channel
     FROM device_capabilities c JOIN machines m ON m.id = c.device_id AND m.shop_id = c.shop_id
     WHERE c.credential_hash = ? AND c.capability = 'hinata_io'
       AND json_extract(c.config_json, '$.transport') = 'embedded' AND m.enabled = 1`,
  )
    .bind(tokenHash)
    .first<ResourceRow>();
  if (!device) return { kind: "rejected", response: rejected("unknown or disabled device token") };
  if (!device.channel) {
    return { kind: "rejected", response: rejected("device has no relay channel") };
  }

  return {
    kind: "dispatch",
    channel: device.channel,
    shopId: device.shop_id,
    machineId: device.device_id,
  };
}

/**
 * 401, not 404. The client treats 401/403 as a permanent failure and stops
 * retrying with a clear log line; anything else looks like a transient outage
 * and it would retry a bad token forever. That diagnosability is worth more than
 * hiding whether a token exists — and a rejected token reveals nothing, because
 * resolving a channel requires the token itself.
 */
function rejected(reason: string): Response {
  console.log(JSON.stringify({ event: "machine_relay_rejected", reason }));
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": "Bearer" },
  });
}

/**
 * A structural view of the relay namespace. The generated `DurableObjectNamespace`
 * generic is too deep for `tsc` to instantiate when chained, and the existing
 * LiveBilling call site narrows the same way.
 */
export type MachineRelayNamespace = {
  getByName(name: string): {
    sendCard(input: {
      accessCode: string;
      source?: string;
      disposable?: boolean;
      duration?: number;
      wait?: CardWaitLimits;
    }): Promise<{ ok: boolean; error?: string; login?: CardLoginResult }>;
    sendKeyPress(input: { key: number; messageId: string; expiresAt: number; count?: number }):
      Promise<{ ok: boolean; error?: string }>;
    watchHa(watch: HaWatch | null): Promise<{ ok: boolean }>;
    startCardCapture(input: {
      id: string; shopId: string; userId: string; playerId: string; expiresAt: number;
    }): Promise<{ ok: boolean; error?: string }>;
    cardCaptureResult(id: string, userId: string): Promise<{ status: string; cardType?: string }>;
    getCapabilities(): Promise<{
      online: boolean;
      e2ee: boolean;
      agents: Array<{ cardProtocol: number; clientVersion: string }>;
    }>;
  };
};

export function machineRelayNamespace(env: Env): MachineRelayNamespace | undefined {
  return env.MACHINE_RELAY as unknown as MachineRelayNamespace | undefined;
}

/** Forward an authenticated upgrade to the machine's Durable Object. */
export async function dispatchToRelay(
  request: Request,
  env: Env,
  target: { channel: string; shopId: string; machineId: string },
): Promise<Response> {
  const namespace = env.MACHINE_RELAY as unknown as {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
  const headers = new Headers(request.headers);
  headers.set("x-prism-relay-shop", target.shopId);
  headers.set("x-prism-relay-machine", target.machineId);
  headers.set("x-prism-relay-channel", target.channel);
  // `webSocket` must be carried over untouched for the upgrade to complete; only
  // the headers differ from what arrived.
  const forwarded = new Request(request, { headers });
  return namespace.get(namespace.idFromName(target.channel)).fetch(forwarded);
}
