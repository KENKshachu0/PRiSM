
const KEY_PRESS_TTL_MS = 30_000;
const MAX_KEY_PRESS_COUNT = 20;
const MAX_KEY_VALUE = 65_535;
const PBKDF2_V1_ITERATIONS = 600_000;
const PBKDF2_V2_ITERATIONS = 20_000;

export type HinataResult = {
  ok: boolean;
  status: number;
  error?: string;
};

export type EncryptHinataIoMessageInput = {
  password: string;
  salt?: string | null;
  message: Record<string, unknown>;
  messageId?: string;
  expiresAt?: number | null;
  nonce?: Uint8Array;
  version?: "v1" | "v2";
};

const keyCache = new Map<string, Promise<CryptoKey>>();
const MAX_E2EE_CACHE_ENTRIES = 128;

export function normalizeHinataUrl(targetUrl: string): string {
  let url = targetUrl.trim();
  if (/^wss:\/\//i.test(url)) {
    url = "https://" + url.slice(6);
  } else if (/^ws:\/\//i.test(url)) {
    url = "http://" + url.slice(5);
  }
  return url.replace(/\/+$/, "");
}

export async function encryptHinataIoMessage(
  input: EncryptHinataIoMessageInput,
): Promise<Record<string, unknown>> {
  if (!input.password) throw new Error("Hinata IO password is required.");
  const version = input.version ?? "v1";
  const iterations = version === "v2" ? PBKDF2_V2_ITERATIONS : PBKDF2_V1_ITERATIONS;
  const action = version === "v2" ? "E2EE_V2" : "E2EE_V1";
  const aadPrefix = version === "v2" ? "aimeio-remote-e2ee-v2" : "aimeio-remote-e2ee-v1";

  let saltBytes: Uint8Array;
  let saltB64: string;
  if (input.salt) {
    saltBytes = decodeBase64Url(input.salt, 16, "salt");
    saltB64 = input.salt;
  } else {
    // Independent random salt avoids deterministic password-derived KDF inputs.
    saltBytes = crypto.getRandomValues(new Uint8Array(16));
    saltB64 = encodeBase64Url(saltBytes);
  }

  const messageId = input.messageId ?? crypto.randomUUID();
  const expiresAt = input.expiresAt ?? null;
  const nonce = input.nonce ?? crypto.getRandomValues(new Uint8Array(12));
  if (nonce.byteLength !== 12) throw new Error("Hinata IO nonce must be 12 bytes.");

  const aad = new TextEncoder().encode(`${aadPrefix}\n${saltB64}\n${messageId}\n${expiresAt ?? ""}`);

  const cacheKey = `${input.password}\0${saltB64}\0${iterations}`;
  let keyPromise = keyCache.get(cacheKey);
  if (!keyPromise) {
    keyPromise = (async () => {
      const passwordKey = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(input.password),
        "PBKDF2",
        false,
        ["deriveKey"],
      );
      return crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          salt: toArrayBuffer(saltBytes),
          iterations,
        },
        passwordKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    // Do not cache random one-time salts: this would grow the key cache indefinitely.
    if (input.salt) keyCache.set(cacheKey, keyPromise);
  }
  const key = await keyPromise;

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(aad),
      tagLength: 128,
    },
    key,
    new TextEncoder().encode(JSON.stringify(input.message)),
  );

  return {
    action,
    body: {
      salt: saltB64,
      nonce: encodeBase64Url(nonce),
      message_id: messageId,
      expires_at: expiresAt,
      ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
    },
  };
}

export const encryptE2EE = encryptHinataIoMessage;

export async function decryptHinataIoMessage(
  password: string,
  envelope: Record<string, unknown>,
): Promise<unknown> {
  const action = envelope.action;
  if (action !== "E2EE_V1" && action !== "E2EE_V2") {
    throw new Error(`Unsupported Hinata IO envelope action: ${String(action)}`);
  }

  const body = envelope.body as {
    salt: string;
    nonce: string;
    message_id: string;
    expires_at: number | null;
    ciphertext: string;
  };
  if (!body) throw new Error("Invalid Hinata IO envelope: missing body.");

  const iterations = action === "E2EE_V2" ? PBKDF2_V2_ITERATIONS : PBKDF2_V1_ITERATIONS;
  const aadPrefix = action === "E2EE_V2" ? "aimeio-remote-e2ee-v2" : "aimeio-remote-e2ee-v1";

  const saltBytes = decodeBase64Url(body.salt, 16, "salt");
  const nonceBytes = decodeBase64Url(body.nonce, 12, "nonce");
  const ciphertextBytes = decodeBase64Url(body.ciphertext);

  const aad = new TextEncoder().encode(
    `${aadPrefix}\n${body.salt}\n${body.message_id}\n${body.expires_at ?? ""}`,
  );

  const cacheKey = `${password}\0${body.salt}\0${iterations}`;
  let keyPromise = keyCache.get(cacheKey);
  if (!keyPromise) {
    keyPromise = (async () => {
      const passwordKey = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveKey"],
      );
      return crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          salt: toArrayBuffer(saltBytes),
          iterations,
        },
        passwordKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    if (keyCache.size >= MAX_E2EE_CACHE_ENTRIES) keyCache.clear();
    keyCache.set(cacheKey, keyPromise);
  }
  const key = await keyPromise;

  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonceBytes),
      additionalData: toArrayBuffer(aad),
      tagLength: 128,
    },
    key,
    toArrayBuffer(ciphertextBytes),
  );

  return JSON.parse(new TextDecoder().decode(decrypted));
}

export const decryptE2EE = decryptHinataIoMessage;

export async function sendHinataCard(
  targetUrl: string,
  accessCode: string,
  password?: string | null,
  operationId?: string,
  options?: {
    salt?: string | null;
    fetcher?: typeof fetch;
    timeoutMs?: number;
    retries?: number;
  },
): Promise<HinataResult> {
  const plain = { type: "aime", value: accessCode };
  const message = {
    action: "SET_CARD",
    body: { type: "aime", value: accessCode, disposable: true },
  };

  return sendHinataRequest({
    targetUrl: normalizeHinataUrl(targetUrl),
    plain,
    message,
    password,
    operationId,
    salt: options?.salt,
    fetcher: options?.fetcher,
    timeoutMs: options?.timeoutMs ?? 10_000,
    retries: options?.retries ?? 0,
    expiresAt: null,
  });
}

export async function sendHinataCoin(
  targetUrl: string,
  key: number,
  password?: string | null,
  operationId?: string,
  options?: {
    count?: number;
    salt?: string | null;
    fetcher?: typeof fetch;
    timeoutMs?: number;
    retries?: number;
  },
): Promise<HinataResult> {
  if (!password || !Number.isInteger(key) || key < 1 || key > MAX_KEY_VALUE) {
    return { ok: false, status: 400, error: "投币需要有效按键码和连接密码" };
  }
  const count = options?.count ?? 1;
  const body = { key, count };
  const eventUrl = `${normalizeHinataUrl(targetUrl)}/event`;

  return sendHinataRequest({
    targetUrl: eventUrl,
    plain: { action: "KEY_PRESS", body },
    message: { action: "KEY_PRESS", body },
    password,
    operationId,
    salt: options?.salt,
    fetcher: options?.fetcher,
    timeoutMs: options?.timeoutMs ?? 10_000,
    retries: options?.retries ?? 0,
    expiresAt: Date.now() + KEY_PRESS_TTL_MS,
  });
}

async function sendHinataRequest(input: {
  targetUrl: string;
  plain: Record<string, unknown>;
  message: { action: string; body: Record<string, unknown> };
  password?: string | null;
  operationId?: string;
  salt?: string | null;
  fetcher?: typeof fetch;
  timeoutMs: number;
  retries: number;
  expiresAt: number | null;
}): Promise<HinataResult> {
  const fetcher = input.fetcher ?? fetch;
  const payload = input.password
    ? await encryptHinataIoMessage({
        password: input.password,
        salt: input.salt,
        messageId: input.operationId,
        expiresAt: input.expiresAt,
        message: input.message,
      })
    : input.plain;

  let attempts = 0;
  const maxAttempts = 1 + Math.max(0, input.retries);

  while (attempts < maxAttempts) {
    attempts++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), input.timeoutMs);

    try {
      const response = await fetcher(input.targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.ok) return { ok: true, status: response.status };
      if (response.status === 404) {
        return { ok: false, status: 404, error: "机台未在线或连接地址不正确" };
      }

      const errorText = await response.text().catch(() => "");
      return {
        ok: false,
        status: response.status,
        error: `机台响应异常 (${response.status}${errorText ? `: ${errorText.slice(0, 80)}` : ""})`,
      };
    } catch (error) {
      const isTimeout = controller.signal.aborted;
      if (attempts >= maxAttempts) {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        return {
          ok: false,
          status: 0,
          error: isTimeout ? "机台响应超时" : `机台通信失败 (${detail})`,
        };
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return { ok: false, status: 0, error: "机台通信失败" };
}

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string, length?: number, field = "value"): Uint8Array {
  if (!value || value.includes("=")) throw new Error(`Invalid base64url ${field}.`);
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  let decoded: string;
  try {
    decoded = atob(padded);
  } catch {
    throw new Error(`Invalid base64url ${field}.`);
  }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (length !== undefined && bytes.byteLength !== length) {
    throw new Error(`Hinata IO ${field} must be ${length} bytes.`);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy: Uint8Array<ArrayBuffer> = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
