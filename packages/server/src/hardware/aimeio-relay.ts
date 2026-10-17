/**
 * HINATA IO relay protocol.
 *
 * Ported from the standalone `aimeio-backend-ws` relay, minus the controller
 * HTTP surface: this platform is the controller, so it calls the relay Durable
 * Object directly instead of POSTing to itself.
 */

export type RelayMessage = Record<string, unknown> & {
  action: string;
};

export type ClientRole = "agent" | "controller";

export type ClientCapabilities = {
  cardProtocol: number;
  clientVersion: string;
  role: ClientRole;
};

/** Methods the IO reports over the same socket it receives commands on. */
export type IoEventMethod =
  | "event.cardStateChanged"
  | "event.cardConsumed"
  | "event.ledSet";

export const IO_EVENT_METHODS: readonly IoEventMethod[] = [
  "event.cardStateChanged",
  "event.cardConsumed",
  "event.ledSet",
];

export type IoEvent = {
  method: IoEventMethod;
  params: Record<string, unknown>;
};

export function isActionMessage(value: unknown): value is RelayMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { action?: unknown }).action === "string"
  );
}

export function capabilitiesFromRequest(request: Request): ClientCapabilities {
  const url = new URL(request.url);
  const cardProtocol = Number(url.searchParams.get("card_protocol") ?? "1");
  const roleParam = url.searchParams.get("role")?.trim().toLowerCase();
  return {
    cardProtocol: Number.isFinite(cardProtocol) ? cardProtocol : 1,
    clientVersion: url.searchParams.get("client_version") ?? "legacy",
    role: roleParam === "controller" ? "controller" : "agent",
  };
}

export function capabilitiesForAttachment(attachment: unknown): ClientCapabilities {
  if (typeof attachment !== "object" || attachment === null) {
    return { cardProtocol: 1, clientVersion: "legacy", role: "agent" };
  }
  const value = attachment as Partial<ClientCapabilities>;
  return {
    cardProtocol: typeof value.cardProtocol === "number" ? value.cardProtocol : 1,
    clientVersion: typeof value.clientVersion === "string" ? value.clientVersion : "legacy",
    role: value.role === "controller" ? "controller" : "agent",
  };
}

/**
 * The IO advertises `card_protocol=2` but still accepts `SET_CARD`, so a v2 body
 * is only rewritten for a connection that asked for protocol 1.
 */
export function messageForClient(
  message: RelayMessage,
  capabilities: ClientCapabilities,
): RelayMessage {
  if (message.action !== "SET_CARD_V2" || capabilities.cardProtocol >= 2) return message;
  const body = message.body;
  if (!isRecord(body) || !isRecord(body.card) || typeof body.card.type !== "string") {
    return message;
  }
  const card = body.card;
  let legacy: Record<string, unknown>;
  switch (card.type) {
    case "aime":
      legacy = { type: "aime", value: card.accessCode };
      break;
    case "aic":
      legacy = { type: "aic", value: `${card.id}:${card.accessCode}` };
      break;
    case "felica":
      legacy = { type: "felica", value: card.id };
      break;
    case "banapass":
      legacy = {
        type: "mifare",
        value: `${card.block1}${typeof card.block2 === "string" ? card.block2 : ""}`,
      };
      break;
    case "tunion":
      legacy = { type: "aime", value: card.cardNumber };
      break;
    case "suica":
      legacy = { type: "felica", value: card.id };
      break;
    default:
      return message;
  }
  for (const key of ["source", "duration", "disposable"]) {
    if (key in body) legacy[key] = body[key];
  }
  return { action: "SET_CARD", body: legacy };
}

export function prepareMessageForClient(
  message: string | ArrayBuffer,
  capabilities: ClientCapabilities,
): string | ArrayBuffer {
  if (typeof message !== "string") return message;
  try {
    const parsed: unknown = JSON.parse(message);
    if (isActionMessage(parsed)) {
      const transformed = messageForClient(parsed, capabilities);
      if (transformed !== parsed) return JSON.stringify(transformed);
    }
  } catch {
    // Not JSON; pass it through untouched.
  }
  return message;
}

export type ClientHello = {
  events: string[];
  e2ee: boolean;
  authenticated: boolean;
};

/**
 * The IO announces its transports on connect. `auth`/`e2ee` are only sent by
 * clients built for direct connection, so their absence means a legacy relay
 * client and the platform must keep talking the legacy dialect to it.
 */
export function parseClientHello(value: unknown): ClientHello | null {
  if (!isRecord(value) || value.action !== "CLIENT_HELLO") return null;
  const body = isRecord(value.body) ? value.body : {};
  return {
    events: Array.isArray(body.events)
      ? body.events.filter((item): item is string => typeof item === "string")
      : [],
    e2ee: body.e2ee === true,
    authenticated: body.auth === "bearer",
  };
}

export function isIoEventMethod(method: string): method is IoEventMethod {
  return (IO_EVENT_METHODS as readonly string[]).includes(method);
}

/**
 * IO events are JSON-RPC notifications (no `id`). Anything that is not one of
 * the known event methods is not an event, regardless of shape.
 */
export function parseIoEvent(raw: string): IoEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (typeof parsed.method !== "string" || !isIoEventMethod(parsed.method)) return null;
  if (parsed.id !== undefined && parsed.id !== null) return null;
  return {
    method: parsed.method,
    params: isRecord(parsed.params) ? parsed.params : {},
  };
}

/**
 * The operation a card report belongs to, or `null` when it is not ours.
 *
 * The IO echoes the `source` it was given, but the same field also carries the
 * IO's own labels for cards that never came from this platform: `Remote` is the
 * default when a command omitted a source, a physical reader reports
 * `HINATA(<instance>)`, and the text backend reports a file path. Every source
 * this platform sends is a UUID, so only a UUID is treated as a link; anything
 * else is a local card and must not be shown as related to a command.
 */
export function ioEventSource(params: Record<string, unknown>): string | null {
  const card = params.card;
  if (!isRecord(card)) return null;
  const source = typeof card.source === "string" ? card.source.trim() : "";
  return OPERATION_ID.test(source) ? source.toLowerCase() : null;
}

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
