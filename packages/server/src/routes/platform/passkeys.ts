import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppBindings, AuthUser } from "../../bindings.js";
import { randomToken } from "../../crypto.js";
import { jsonError, nowIso, clientIp } from "../../http.js";
import { requireUser, createSession } from "../../middleware/auth.js";
import { enforceRateLimits } from "../../middleware/rate-limit.js";

const challengeCookie = "arcadelink_passkey_challenge";
const challengeSeconds = 300;

export const passkeyProviders: Record<string, string> = {
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "Apple Passwords",
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
  "d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
  "d3452668-01fd-4c12-926c-83a4204853aa": "Microsoft Password Manager",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
};

export const passkeyLabelSchema = z.string().trim().min(1).max(60);

export const passkeyNameSchema = z.object({
  name: passkeyLabelSchema,
});

type PasskeyRow = {
  id: string;
  user_id: string;
  public_key: ArrayBuffer;
  counter: number;
  transports: string | null;
};

export function androidCertificateFingerprints(value?: string): string[] {
  return Array.from(
    new Set(
      (value ?? "")
        .split(/[\s,]+/)
        .map((fingerprint) => fingerprint.replaceAll(":", "").toUpperCase())
        .filter((fingerprint) => /^[0-9A-F]{64}$/.test(fingerprint))
        .map((fingerprint) => fingerprint.match(/.{2}/g)?.join(":") ?? fingerprint),
    ),
  );
}

export function androidPasskeyOrigins(certFingerprints?: string): string[] {
  return androidCertificateFingerprints(certFingerprints).map((fingerprint) => {
    const bytes = fingerprint.split(":").map((value) => Number.parseInt(value, 16));
    const binary = String.fromCharCode(...bytes);
    const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    return `android:apk-key-hash:${encoded}`;
  });
}

export async function registrationOptions(c: Context<AppBindings>, user: AuthUser) {
  const passkeys = await c.env.DB.prepare("SELECT id, transports FROM passkeys WHERE user_id = ?")
    .bind(user.id)
    .all<{ id: string; transports: string | null }>();
  const options = await generateRegistrationOptions({
    rpName: "PRiSM",
    rpID: rp(c).id,
    userID: new TextEncoder().encode(user.id),
    userName: user.username,
    userDisplayName: user.displayName,
    attestationType: "none",
    excludeCredentials: passkeys.results.map((passkey) => {
      const transports = parseTransports(passkey.transports);
      return { id: passkey.id, ...(transports ? { transports } : {}) };
    }),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  await saveChallenge(c, "register", options.challenge, user.id);
  return options;
}

export async function finishRegistration(
  c: Context<AppBindings>,
  user: AuthUser,
  response: RegistrationResponseJSON,
  requestedName?: string,
): Promise<void> {
  const challenge = await takeChallenge(c, "register", user.id);
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: rp(c).origin,
    expectedRPID: rp(c).id,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) {
    jsonError(400, "Passkey 验证失败", "PASSKEY_VERIFICATION_FAILED");
  }
  const { aaguid, credential, credentialBackedUp, credentialDeviceType } = verification.registrationInfo;
  const providerName = passkeyProviderName(aaguid);
  const name =
    requestedName || providerName || (credentialDeviceType === "multiDevice" ? "同步 Passkey" : "设备 Passkey");
  await c.env.DB.prepare(
    `INSERT INTO passkeys
       (id, user_id, public_key, counter, transports, device_type, backed_up, name, aaguid, provider_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      credential.id,
      user.id,
      toArrayBuffer(credential.publicKey) as unknown as string,
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      credentialDeviceType,
      credentialBackedUp ? 1 : 0,
      name,
      aaguid,
      providerName,
    )
    .run();
}

export function passkeyProviderName(aaguid: string): string | null {
  return passkeyProviders[aaguid.toLowerCase()] ?? null;
}

export async function authenticationOptions(c: Context<AppBindings>) {
  const options = await generateAuthenticationOptions({
    rpID: rp(c).id,
    userVerification: "required",
  });
  await saveChallenge(c, "authenticate", options.challenge, null);
  return options;
}

export async function finishAuthentication(
  c: Context<AppBindings>,
  response: AuthenticationResponseJSON,
): Promise<string> {
  const challenge = await takeChallenge(c, "authenticate", null);
  const passkey = await c.env.DB.prepare(
    "SELECT id, user_id, public_key, counter, transports FROM passkeys WHERE id = ?",
  )
    .bind(response.id)
    .first<PasskeyRow>();
  if (!passkey) jsonError(401, "无法识别这个 Passkey", "UNKNOWN_PASSKEY");
  const transports = parseTransports(passkey.transports);
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: authenticationOrigins(c),
    expectedRPID: rp(c).id,
    credential: {
      id: passkey.id,
      publicKey: new Uint8Array(passkey.public_key),
      counter: passkey.counter,
      ...(transports ? { transports } : {}),
    },
    requireUserVerification: true,
  });
  if (!verification.verified) jsonError(401, "Passkey 验证失败", "PASSKEY_VERIFICATION_FAILED");
  await c.env.DB.prepare("UPDATE passkeys SET counter = ?, last_used_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(verification.authenticationInfo.newCounter, passkey.id)
    .run();
  return passkey.user_id;
}

function authenticationOrigins(c: Context<AppBindings>): string | string[] {
  const origins = [rp(c).origin, ...androidPasskeyOrigins(c.env.ANDROID_CERT_FINGERPRINTS)];
  return origins.length === 1 ? origins[0] ?? rp(c).origin : origins;
}

async function saveChallenge(
  c: Context<AppBindings>,
  purpose: "register" | "authenticate",
  challenge: string,
  userId: string | null,
): Promise<void> {
  const id = randomToken(24);
  const expiresAt = new Date(Date.now() + challengeSeconds * 1000).toISOString();
  const previousId = getCookie(c, challengeCookie);
  const statements = [
    c.env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(nowIso()),
  ];
  if (previousId) {
    statements.push(c.env.DB.prepare("DELETE FROM auth_challenges WHERE id = ?").bind(previousId));
  }
  statements.push(
    c.env.DB.prepare(
      "INSERT INTO auth_challenges (id, user_id, purpose, challenge, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(id, userId, purpose, challenge, expiresAt),
  );
  await c.env.DB.batch(statements);
  setCookie(c, challengeCookie, id, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Strict",
    path: "/",
    maxAge: challengeSeconds,
  });
}

async function takeChallenge(
  c: Context<AppBindings>,
  purpose: "register" | "authenticate",
  userId: string | null,
): Promise<string> {
  const id = getCookie(c, challengeCookie);
  deleteCookie(c, challengeCookie, { path: "/" });
  if (!id) jsonError(400, "Passkey 请求已过期", "PASSKEY_CHALLENGE_EXPIRED");
  const row = await c.env.DB.prepare(
    "DELETE FROM auth_challenges WHERE id = ? AND purpose = ? AND user_id IS ? AND expires_at > ? RETURNING challenge",
  )
    .bind(id, purpose, userId, nowIso())
    .first<{ challenge: string }>();
  if (!row) jsonError(400, "Passkey 请求已过期", "PASSKEY_CHALLENGE_EXPIRED");
  return row.challenge;
}

function rp(c: Context<AppBindings>): { id: string; origin: string } {
  const origin = new URL(c.env.APP_ORIGIN || "http://localhost").origin;
  return { id: new URL(origin).hostname, origin };
}

function parseTransports(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const transports = JSON.parse(value);
    return Array.isArray(transports) && transports.every((item) => typeof item === "string")
      ? transports
      : undefined;
  } catch {
    return undefined;
  }
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

export const passkeysRouter = new Hono<AppBindings>();

passkeysRouter.get("/options", async (c) => {
  await enforceRateLimits(c, [
    {
      key: `passkey:options:${clientIp(c.req.raw)}`,
      limit: 10,
      windowSeconds: 60,
    },
  ]);
  return c.json(await authenticationOptions(c));
});

passkeysRouter.post("/", async (c) => {
  const body = await c.req.json<AuthenticationResponseJSON>();
  const userId = await finishAuthentication(c, body);
  const user = await c.env.DB.prepare("SELECT banned_at FROM users WHERE id = ?")
    .bind(userId)
    .first<{ banned_at: string | null }>();
  if (!user || user.banned_at) {
    jsonError(403, "这个账号暂时无法使用", "ACCOUNT_BANNED");
  }
  await createSession(c, userId);
  return c.json({ ok: true });
});

passkeysRouter.get("/register/options", async (c) => {
  const user = requireUser(c);
  return c.json(await registrationOptions(c, user));
});

passkeysRouter.post("/register", async (c) => {
  const user = requireUser(c);
  const body = await c.req.json<{
    credential: RegistrationResponseJSON;
    name?: unknown;
  }>();
  const name =
    body.name === undefined ? undefined : passkeyLabelSchema.parse(body.name);
  await finishRegistration(c, user, body.credential, name);
  return c.json({ ok: true }, 201);
});

passkeysRouter.delete("/:id", async (c) => {
  const user = requireUser(c);
  await c.env.DB.prepare("DELETE FROM passkeys WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), user.id)
    .run();
  return c.json({ ok: true });
});

passkeysRouter.patch("/:id", async (c) => {
  const user = requireUser(c);
  const body = passkeyNameSchema.parse(await c.req.json());
  const result = (await c.env.DB.prepare(
    "UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?",
  )
    .bind(body.name, c.req.param("id"), user.id)
    .run()) as { meta?: { changes?: number } } | undefined;
  if (result?.meta?.changes === 0) {
    jsonError(404, "没有找到这个 Passkey", "PASSKEY_NOT_FOUND");
  }
  return c.json({ ok: true });
});
