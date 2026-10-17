import { describe, expect, it } from "bun:test";
import {
  capabilitiesForAttachment,
  capabilitiesFromRequest,
  ioEventSource,
  isIoEventMethod,
  messageForClient,
  parseClientHello,
  parseIoEvent,
  prepareMessageForClient,
  type ClientCapabilities,
} from "../src/hardware/aimeio-relay.js";

function capabilities(overrides: Partial<ClientCapabilities> = {}): ClientCapabilities {
  return { cardProtocol: 2, clientVersion: "1.2.0", role: "agent", ...overrides };
}

describe("relay client capabilities", () => {
  it("reads role, protocol and version from the upgrade query", () => {
    const request = new Request(
      "https://prism.test/io/ws?role=controller&card_protocol=2&client_version=1.2.0",
    );
    expect(capabilitiesFromRequest(request)).toEqual({
      cardProtocol: 2,
      clientVersion: "1.2.0",
      role: "controller",
    });
  });

  it("defaults to an agent on protocol 1 when nothing is announced", () => {
    expect(capabilitiesFromRequest(new Request("https://prism.test/io/ws"))).toEqual({
      cardProtocol: 1,
      clientVersion: "legacy",
      role: "agent",
    });
  });

  it("treats a malformed protocol as 1 rather than NaN", () => {
    const request = new Request("https://prism.test/io/ws?card_protocol=abc");
    expect(capabilitiesFromRequest(request).cardProtocol).toBe(1);
  });

  it("falls back safely for an unreadable attachment", () => {
    expect(capabilitiesForAttachment(undefined)).toEqual({
      cardProtocol: 1,
      clientVersion: "legacy",
      role: "agent",
    });
  });
});

describe("relay protocol downgrade", () => {
  it("rewrites a v2 card for a protocol-1 client", () => {
    const message = {
      action: "SET_CARD_V2",
      body: {
        card: { type: "aime", accessCode: "01234567890123456789" },
        source: "op-1",
        disposable: true,
      },
    };
    expect(messageForClient(message, capabilities({ cardProtocol: 1 }))).toEqual({
      action: "SET_CARD",
      body: {
        type: "aime",
        value: "01234567890123456789",
        source: "op-1",
        disposable: true,
      },
    });
  });

  it("passes a v2 card through for a protocol-2 client", () => {
    const message = { action: "SET_CARD_V2", body: { card: { type: "aime", accessCode: "x" } } };
    expect(messageForClient(message, capabilities({ cardProtocol: 2 }))).toBe(message);
  });

  it("leaves an unknown card type alone instead of emitting an empty value", () => {
    const message = { action: "SET_CARD_V2", body: { card: { type: "mystery" } } };
    expect(messageForClient(message, capabilities({ cardProtocol: 1 }))).toBe(message);
  });

  it("keeps the source when rewriting, because it identifies the operation", () => {
    const encoded = prepareMessageForClient(
      JSON.stringify({
        action: "SET_CARD_V2",
        body: { card: { type: "felica", id: "01aabb" }, source: "op-9" },
      }),
      capabilities({ cardProtocol: 1 }),
    );
    expect(JSON.parse(encoded as string).body.source).toBe("op-9");
  });

  it("passes non-JSON through untouched", () => {
    expect(prepareMessageForClient("not json", capabilities({ cardProtocol: 1 }))).toBe("not json");
  });
});

describe("relay client hello", () => {
  it("reports bearer auth and e2ee flags from a direct-connect client", () => {
    expect(
      parseClientHello({
        action: "CLIENT_HELLO",
        body: { protocol: "aimeio-remote", auth: "bearer", e2ee: false, events: ["event.ledSet"] },
      }),
    ).toEqual({ events: ["event.ledSet"], e2ee: false, authenticated: true });
  });

  it("reports a legacy client as unauthenticated and not e2ee", () => {
    // A legacy relay client sends no auth or e2ee fields at all.
    expect(parseClientHello({ action: "CLIENT_HELLO", body: { version: 2 } })).toEqual({
      events: [],
      e2ee: false,
      authenticated: false,
    });
  });

  it("ignores a message that is not a hello", () => {
    expect(parseClientHello({ action: "SET_CARD" })).toBeNull();
    expect(parseClientHello("nope")).toBeNull();
  });
});

describe("relay IO events", () => {
  it("recognises the three reported event methods", () => {
    for (const method of ["event.cardStateChanged", "event.cardConsumed", "event.ledSet"]) {
      expect(isIoEventMethod(method)).toBe(true);
    }
    expect(isIoEventMethod("event.somethingElse")).toBe(false);
  });

  it("parses a card event notification", () => {
    const event = parseIoEvent(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event.cardConsumed",
        params: { interface: "aimeio", unit_no: 0, card: { source: "op-1" }, sequence: 3 },
      }),
    );
    expect(event?.method).toBe("event.cardConsumed");
    expect(event?.params.sequence).toBe(3);
  });

  it("rejects a request that carries an id, since events are notifications", () => {
    // A JSON-RPC request is not an event and must not be treated as one.
    expect(
      parseIoEvent(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "event.ledSet", params: {} })),
    ).toBeNull();
  });

  it("rejects unknown methods and malformed payloads", () => {
    expect(parseIoEvent(JSON.stringify({ method: "device.setLed" }))).toBeNull();
    expect(parseIoEvent(JSON.stringify({ method: "event.ledSet", params: {} }))?.method).toBe("event.ledSet");
    expect(parseIoEvent("{")).toBeNull();
    expect(parseIoEvent(JSON.stringify([1, 2]))).toBeNull();
  });

  it("reads the echoed operation id that ties a card read to its command", () => {
    const id = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    expect(ioEventSource({ card: { source: id } })).toBe(id);
    expect(ioEventSource({ card: { source: id.toUpperCase() } })).toBe(id);
    expect(ioEventSource({ card: {} })).toBeNull();
    expect(ioEventSource({})).toBeNull();
  });

  it("does not treat the IO's own card labels as operation links", () => {
    // "Remote" is the IO's default when a command carried no source; the others
    // are cards read locally that never came from this platform.
    for (const source of ["Remote", "HINATA(1a2b)", "aime.txt", "reader-banapass", "op-1", "  "]) {
      expect(ioEventSource({ card: { source } })).toBeNull();
    }
  });
});
