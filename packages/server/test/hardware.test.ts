import { describe, expect, it } from "bun:test";
import type { TTLockConnectionConfig } from "@prism/application";
import {
  decryptHinataIoMessage,
  encryptHinataIoMessage,
  normalizeHinataUrl,
  sendHinataCard,
  sendHinataCoin,
} from "../src/hardware/hinata.js";
import { TTLockClient } from "../src/hardware/ttlock.js";
import { callHomeAssistantPower, getHomeAssistantEntityState } from "../src/hardware/home-assistant.js";

describe("Hinata IO encryption", () => {
  it("matches the Rust and Dart E2EE_V1 fixture", async () => {
    const envelope = await encryptHinataIoMessage({
      password: "test-remote-password",
      salt: "ABEiM0RVZneImaq7zN3u_w",
      nonce: Uint8Array.from([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4]),
      messageId: "00000000-0000-4000-8000-000000000001",
      expiresAt: 1_700_000_000_123,
      message: { action: "KEY_PRESS", body: { key: 32, count: 1 } },
    });

    expect(envelope).toEqual({
      action: "E2EE_V1",
      body: {
        salt: "ABEiM0RVZneImaq7zN3u_w",
        nonce: "Dw4NDAsKCQgHBgUE",
        message_id: "00000000-0000-4000-8000-000000000001",
        expires_at: 1_700_000_000_123,
        ciphertext: "2boPibGx_ErUB0K-8w2NPYaA6IK549jlVYQcZHoi_RAolCk7w8ktNj2WuKpVNftgGxS_08ksxVs97mw5l2Y-6JVv",
      },
    });

    const decrypted = await decryptHinataIoMessage("test-remote-password", envelope);
    expect(decrypted).toEqual({
      action: "KEY_PRESS",
      body: { key: 32, count: 1 },
    });
  });

  it("supports deterministic salt derivation and roundtrip decryption", async () => {
    const envelope = await encryptHinataIoMessage({
      password: "my-secret-password",
      message: { action: "PING" },
      version: "v2",
    });

    expect(envelope.action).toBe("E2EE_V2");
    expect((envelope.body as Record<string, unknown>).salt).toBeDefined();

    const decrypted = await decryptHinataIoMessage("my-secret-password", envelope);
    expect(decrypted).toEqual({ action: "PING" });
  });

  it("normalizes Hinata URLs properly", () => {
    expect(normalizeHinataUrl("ws://relay.example:8080/path/")).toBe("http://relay.example:8080/path");
    expect(normalizeHinataUrl("wss://relay.example/sub/")).toBe("https://relay.example/sub");
    expect(normalizeHinataUrl("https://relay.example/")).toBe("https://relay.example");
  });
});


describe("Hinata IO relay calls", () => {
  it("sendHinataCard sends encrypted payload when password is provided and plaintext fallback when not", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response("OK", { status: 200 });
    }) as typeof fetch;

    const resEncrypted = await sendHinataCard(
      "https://relay.example/mai",
      "999888777",
      "pwd-123",
      "op-1",
      { fetcher: mockFetch },
    );
    expect(resEncrypted.ok).toBe(true);

    const resPlain = await sendHinataCard(
      "https://relay.example/mai",
      "999888777",
      null,
      "op-2",
      { fetcher: mockFetch },
    );
    expect(resPlain.ok).toBe(true);
    expect(calls[1].body).toEqual({ type: "aime", value: "999888777" });
  });

  it("sendHinataCoin validates keys and sends encrypted event payload", async () => {
    const badKey = await sendHinataCoin("https://relay.example/mai", 0, "pwd");
    expect(badKey.ok).toBe(false);
    expect(badKey.status).toBe(400);

    const noPwd = await sendHinataCoin("https://relay.example/mai", 32, null);
    expect(noPwd.ok).toBe(false);
    expect(noPwd.status).toBe(400);

    let sentUrl = "";
    const mockFetch = (async (url: string | URL | Request) => {
      sentUrl = String(url);
      return new Response("OK", { status: 200 });
    }) as typeof fetch;

    const good = await sendHinataCoin("https://relay.example/mai", 32, "pwd", "op-coin", {
      fetcher: mockFetch,
    });
    expect(good.ok).toBe(true);
    expect(sentUrl).toBe("https://relay.example/mai/event");
  });
});

const ttlockConnection = {
  baseUrl: "https://api.sciener.com",
  clientId: "client-id",
  clientSecret: "client-secret",
  appAccount: "15517998347",
  appPwd: "password",
  accessToken: "access-token",
  refreshToken: "refresh-token",
  accessTokenExpiresAt: null,
};

const ttlockDevice = { lockId: 25356943 };

describe("TTLock client", () => {
  it("refreshes expired token and invokes onConnectionUpdated callback", async () => {
    const requests: Request[] = [];
    let updatedConnection: TTLockConnectionConfig | undefined;
    const client = new TTLockClient({
      connection: ttlockConnection,
      fetcher: async (url: string | URL | Request, init?: RequestInit) => {
        const request = new Request(url, init);
        requests.push(request);
        if (request.url.endsWith("/oauth2/token")) {
          return Response.json({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 7776000,
          });
        }
        if (request.url.endsWith("/v3/keyboardPwd/add")) {
          const body = await request.text();
          return body.includes("accessToken=new-access-token")
            ? Response.json({ errcode: 0, keyboardPwdId: 1 })
            : Response.json({ errcode: 10004, errmsg: "invalid grant" });
        }
        return Response.json({ errcode: 10004, errmsg: "invalid grant" });
      },
      now: () => new Date("2026-09-07T00:00:00.000Z"),
      onConnectionUpdated: (next: TTLockConnectionConfig) => {
        updatedConnection = next;
      },
    });

    await expect(client.addTemporaryPassword(ttlockDevice.lockId, "12345678", "test")).resolves.toEqual({
      keyboardPwdId: 1,
    });
    expect(updatedConnection?.accessToken).toBe("new-access-token");
  });
});

describe("Home Assistant driver", () => {
  it("calls the entity's own domain service", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const result = await callHomeAssistantPower({
      baseUrl: "https://ha.example.com/",
      accessToken: "ha-token",
      entityId: "input_boolean.maimai_dx",
      service: "turn_off",
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return Response.json([{ changed: true }]);
      },
    });
    expect(result).toEqual({ ok: true, status: 200 });
    expect(calls[0]?.url).toBe("https://ha.example.com/api/services/input_boolean/turn_off");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ entity_id: "input_boolean.maimai_dx" });
  });

  it("reports status 0 when no response arrived, so the outcome stays unknown", async () => {
    const result = await callHomeAssistantPower({
      baseUrl: "https://ha.example.com",
      accessToken: "ha-token",
      entityId: "switch.light",
      service: "turn_on",
      fetch: async () => { throw new TypeError("network down"); },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
  });

  it("reads the entity state", async () => {
    const state = await getHomeAssistantEntityState({
      baseUrl: "https://ha.example.com",
      accessToken: "ha-token",
      entityId: "switch.light",
      fetch: async () => Response.json({ state: "on" }),
    });
    expect(state).toBe("on");
  });
});
