import { activeLocale, rememberPlayerText } from "./i18n";
import { PlayerReadCache, subscribeRead } from "./player-read-cache";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

export type User = {
  id: string;
  username: string;
  displayName: string;
  role: "user" | "admin";
  hasShops?: boolean;
};

export type Card = {
  id: string;
  label: string;
  cardType: string;
  accessCode: string;
  source: string;
  disabledAt?: string | null;
};

export type PublicResource = {
  coinAfterSwipe: boolean;
  /** A card can be added at this cabinet's reader. */
  cardCapture?: boolean;
  kind: "machine" | "door";
  capabilities: { power: boolean; climate?: boolean; coin: boolean; card: boolean; door: boolean; mahjong?: boolean };
  webOnly?: boolean;
  /** Using it needs its pricing plan running; a free resource needs nothing. */
  billed?: boolean;
  publicId: string;
  name: string;
  shop: {
    name: string;
    publicId?: string;
    locationEnabled?: boolean;
    machineGeo?: boolean;
    webUrl?: string;
    heroUrl?: string | null;
    latitude: number;
    longitude: number;
    radiusMeters: number;
  };
};

export type MachineLoginResult = {
  ok: true;
  /**
   * Direct-connect machines report whether the game took the card or never
   * read it. Others only say sent.
   */
  card?: "read" | "not_read" | "sent";
  /** What to show: inline ones on the card row, dialogs only when something went wrong. */
  notices?: Notice[];
  coin?: {
    status: "sent" | "skipped" | "failed" | "unknown";
    operationId: string;
    reason?: string;
  };
};

export type ResourceSession = {
  ticket: string;
  expiresIn: number;
  machine: PublicResource;
};

export type Shop = {
  id: string;
  publicId: string;
  name: string;
  timeZone?: string;
  heroUrl?: string | null;
  latitude: number;
  longitude: number;
  radius_meters?: number;
  radiusMeters?: number;
};

/**
 * One entry of a device's log. `request`/`result` are an action the platform
 * asked for and its outcome (paired by `operationId`), `signal` is something
 * the machine reported, `change` is a state that moved.
 */
export type DeviceEvent = {
  id: string;
  capability: string;
  kind: "request" | "result" | "signal" | "change";
  /** Action, signal or state name, e.g. `power.on`, `card.consumed`, `link`. */
  name: string;
  origin: "platform" | "device" | "observer";
  operationId: string | null;
  parentOperationId: string | null;
  at: string;
  payload: Record<string, unknown>;
};

/** Who is on a resource now, as the resources page shows it. */
export type ResourceOccupancyView = {
  resourceId: string;
  capacity: number;
  /** The capability that decides who is on it, e.g. `hinata_io` or `mahjong`. */
  source: string;
  occupants: Array<{ playerId: string; displayName: string | null; startedAt: string; lastSeenAt: string; expiresAt: string | null }>;
};

/** One stay on a resource, newest first in the history. */
export type OccupancyHistoryEntry = {
  id: string;
  playerId: string;
  displayName: string | null;
  source: string;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  endReason: "timeout" | "replaced" | "left" | "billing_ended" | null;
};

export type Resource = {
  mahjong?: { capacity: number; pricingConfigIds: string[] } | null;
  /** How many people can use it at once; 0 for one nobody occupies. A mahjong table's is its size. */
  capacity?: number;
  /** How long someone counts as on it after the last sign of them; also its idle time. */
  occupancyMinutes?: number;
  /** Actions this device can perform now, tagged with their capability. */
  actions?: { name: string; capability: string }[];
  coinAfterSwipe: boolean;
  hasHinata: boolean;
  kind: "machine" | "door";
  hinataUrl: string | null;
  /** `connectionId` names the shop Home Assistant; null for a binding not yet moved onto one. */
  homeAssistant: { connectionId?: string | null; url: string; entityId: string } | null;
  /** A Home Assistant `climate.*` entity, such as an air conditioner. */
  climate?: { connectionId?: string | null; url: string; entityId: string } | null;
  ttlockLockId: number | null;
  coinKey: number;
  coinEnabled?: boolean;
  id: string;
  publicId: string;
  shopId: string;
  shopPublicId: string;
  name: string;
  aliases: string[];
  enabled: boolean | number;
  hasPassword?: boolean | number;
  /** "embedded" means the machine connects straight to this platform. */
  relayConnection?: "external" | "embedded";
  /** Whether a device token exists. The token itself is only returned on mint. */
  hasRelayToken?: boolean;
  /** The `[aimeio] serverUrl` value to paste into the machine's INI. */
  relayUrl?: string | null;
  /** null means the state could not be determined, not necessarily offline. */
  relayOnline?: boolean | null;
  /** The connected IO still encrypts payloads, which embedded mode cannot read. */
  relayE2ee?: boolean | null;
  /** A shop bot's settings; null for a resource that is not a bot. Its token is only shown when issued. */
  bot?: BotSettings | null;
  /** Whether the bot has an active credential, as a device has a relay token. */
  hasBotToken?: boolean;
  /** The group whose default plan this resource bills; "default" for the shop's default group. */
  resourceGroupId?: string;
  /** A plan of its own that replaces the group's; null to follow the group. */
  pricingConfigOverrideId?: string | null;
};

/** What a shop bot offers players and staff; everything else it is told comes from the platform. */
export type BotSettings = {
  playerCommands: "all" | "readonly";
  readOnlyNotice: string;
  staffCommands: boolean;
  powerOffStaffOnly: boolean;
  doorResourceId: string | null;
  receiptsToStaff: boolean;
  /** `login`/`入场` also hands out the door code. */
  doorPasswordOnEntry: boolean;
  /** Channels the bot says everything in: idle warnings and what happens at the shop. */
  announceChannelIds: string[];
  idleReminderMinutes: number;
  /** Which news is told, each on its own. */
  announceIdle: boolean;
  announcePower: boolean;
  announceStarts: boolean;
  announceCards: boolean;
  announceCoins: boolean;
};

/** A set of resources that bill the same default plan. The default group is the shop's own. */
export type ResourceGroup = {
  id: string;
  name: string;
  enabled: boolean;
  isDefault: boolean;
  defaultPricingConfigId: string | null;
  resourceCount: number;
};

export type UserSummary = {
  id: string;
  username: string;
  displayName: string;
  role: User["role"];
  bannedAt?: string | null;
  createdAt: string;
};

export type ShopMember = {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  role: "owner" | "staff";
  createdAt: string;
};

export type LoginEvent = {
  id: string;
  createdAt: string;
  result: string;
  riskResult: string;
  responseCode?: number | null;
  errorMessage?: string | null;
  distanceMeters?: number | null;
  machineName?: string | null;
  shopName?: string | null;
  userName?: string | null;
  cardLabel?: string | null;
};

export type Ban = {
  id: string;
  subjectType: "user" | "ip" | "card" | "machine";
  subjectValue: string;
  reason: string;
  expiresAt?: string | null;
  createdAt: string;
};

export type AuthIdentity = {
  id: string;
  provider: string;
  username?: string | null;
  displayName?: string | null;
  createdAt: string;
  lastLoginAt?: string | null;
};

export type Passkey = {
  id: string;
  name: string;
  providerName?: string | null;
  deviceType: string;
  backedUp: number;
  createdAt: string;
  lastUsedAt?: string | null;
};

/**
 * What the server wants the player told, and how: `dialog` interrupts, `inline`
 * belongs next to what they touched, `none` only runs `flow`.
 */
export type Notice = {
  code: string;
  level: "success" | "info" | "warning" | "error";
  display: "dialog" | "inline" | "none";
  flow: "none" | "expired" | "refresh" | "signin";
  title: string | null;
  body: string;
  actions: { kind: "dismiss" | "retry"; label: string }[];
};

/** A problem found on this device that is part of normal use (no location fix yet): shown inline. */
export class InlineError extends Error {}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
    readonly retryAfterMs?: number,
    readonly notice?: Notice,
    /** The server's own wording, for staff screens. */
    readonly reason?: string,
  ) {
    super(notice?.body ?? message);
    if (notice) rememberPlayerText(notice.body);
  }

  get sessionExpired(): boolean {
    return (
      this.code === "TICKET_EXPIRED" ||
      this.notice?.flow === "expired" ||
      this.message === "本次会话已失效" ||
      this.message === "缺少会话凭证"
    );
  }
}

const playerReads = new PlayerReadCache();
export const invalidatePlayerReads = () => playerReads.clear();
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const readOnly = (options.method ?? "GET").toUpperCase() === "GET";
  const shop = /^\/api\/v1\/shops\/[^/?]+(?:\?pricing=raw)?$/.test(path);
  const summary = /^\/api\/v1\/shops\/[^/]+\/player\/me$/.test(path);
  if (readOnly && (shop || summary)) {
    const user = typeof sessionStorage === "undefined" ? "" : sessionStorage.getItem("prism.user") ?? "";
    return subscribeRead(playerReads.read(`${user}:${path}`, shop ? 30_000 : 1000,
      () => fetchApi<T>(path, { ...options, signal: undefined })), options.signal);
  }
  const result = await fetchApi<T>(path, options);
  if (!readOnly) invalidatePlayerReads();
  return result;
}

async function fetchApi<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const send = () => fetch(path, {
    ...options,
    cache: "no-store",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      // Player-facing text comes back in this language.
      "accept-language": activeLocale(),
      ...options.headers,
    },
  });
  let response: Response;
  try { response = await send(); }
  catch (error) {
    const readOnly = (options.method ?? "GET").toUpperCase() === "GET" || path.endsWith("/checkout/preview");
    if (!(error instanceof TypeError) || !readOnly || options.signal?.aborted) throw error;
    await new Promise((resolve) => setTimeout(resolve, 300));
    response = await send();
  }
  const payload = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { code: string; message: string; details?: unknown; notice?: Notice; reason?: string };
  };
  if (!response.ok)
    throw new ApiError(
      payload.error?.message || `Request failed (${response.status})`,
      response.status,
      payload.error?.code,
      payload.error?.details,
      parseRetryAfter(response.headers.get("retry-after")),
      payload.error?.notice,
      payload.error?.reason,
    );
  return payload.data as T;
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = /^\d+(?:\.\d+)?$/.test(value.trim()) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

export const Api = {
  me: () => api<{ user: User | null }>("/api/v1/me"),
  passkeyOptions: () =>
    api<PublicKeyCredentialRequestOptionsJSON>("/api/v1/auth/passkey/options"),
  loginWithPasskey: (response: AuthenticationResponseJSON) =>
    api<{ ok: true }>("/api/v1/auth/passkey", {
      method: "POST",
      body: JSON.stringify(response),
    }),
  passkeyRegistrationOptions: () =>
    api<PublicKeyCredentialCreationOptionsJSON>(
      "/api/v1/auth/passkey/register/options",
    ),
  registerPasskey: (credential: RegistrationResponseJSON, name?: string) =>
    api<{ ok: true }>("/api/v1/auth/passkey/register", {
      method: "POST",
      body: JSON.stringify({ credential, name }),
    }),
  logout: () => api<{ ok: true }>("/api/v1/auth/logout", { method: "POST" }),
  account: () =>
    api<{ identities: AuthIdentity[]; passkeys: Passkey[] }>("/api/v1/account"),
  deletePasskey: (id: string) =>
    api<{ ok: true }>(`/api/v1/account/passkeys/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  renamePasskey: (id: string, name: string) =>
    api<{ ok: true }>(`/api/v1/account/passkeys/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  cards: () =>
    api<{
      cards: Card[];
      authorizationRequired: boolean;
      syncError: string | null;
    }>("/api/v1/cards"),
  /** Open a short window in which the card put on this cabinet's reader is added to the account. */
  startCardCapture: (input: { ticket: string; location?: unknown }) =>
    api<{ captureId: string; expiresAt: string }>("/api/v1/devices/session/cards/capture", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  cardCaptureResult: (captureId: string, ticket: string) =>
    api<{ status: "waiting" | "expired" | "added" | "bound" | "exists" | "taken" | "unsupported"; cardType?: string }>(
      `/api/v1/devices/session/cards/capture/${encodeURIComponent(captureId)}?ticket=${encodeURIComponent(ticket)}`,
    ),
  startResourceSession: (shopCode: string, publicId: string) =>
    api<ResourceSession>("/api/v1/machines/session/start", {
      method: "POST",
      body: JSON.stringify({ shopCode, publicId }),
    }),
  syncCards: () =>
    api<{
      cards: Card[];
      authorizationRequired: boolean;
      syncError: string | null;
    }>("/api/v1/cards/sync", {
      method: "POST",
    }),
  createCard: (label: string, accessCode: string) =>
    api<{ card: Card }>("/api/v1/cards", {
      method: "POST",
      body: JSON.stringify({ label, accessCode }),
    }),
  deleteCard: (id: string) =>
    api<{ ok: true }>(`/api/v1/cards/${id}`, { method: "DELETE" }),
  publicResource: (ticketOrPublicId: string, ticket?: string) => {
    const url = ticket
      ? `/api/v1/machines/${encodeURIComponent(ticketOrPublicId)}?ticket=${encodeURIComponent(ticket)}`
      : `/api/v1/machines/session?ticket=${encodeURIComponent(ticketOrPublicId)}`;
    return api<{ machine: PublicResource }>(url);
  },
  /**
   * The machine and, for a signed-in player, the page state in one request: what
   * the page needs before it can show anything. `state` is the device page's
   * state shape, which the page that reads it defines.
   */
  bootstrap: <S>(ticket: string) =>
    api<{ machine: PublicResource; state: S | null }>(
      `/api/v1/devices/session/bootstrap?ticket=${encodeURIComponent(ticket)}`,
    ),
  loginMachine: (
    inputOrPublicId:
      | {
          cardId: string;
          lat?: number;
          lng?: number;
          accuracy?: number;
          ticket: string;
        }
      | string,
    legacyInput?: {
      cardId: string;
      lat?: number;
      lng?: number;
      accuracy?: number;
      ticket: string;
    },
  ) => {
    if (typeof inputOrPublicId === "string" && legacyInput) {
      return api<MachineLoginResult>(
        `/api/v1/machines/${encodeURIComponent(inputOrPublicId)}/login`,
        {
          method: "POST",
          body: JSON.stringify(legacyInput),
        },
      );
    }
    return api<MachineLoginResult>("/api/v1/machines/login", {
      method: "POST",
      body: JSON.stringify(inputOrPublicId),
    });
  },
  shops: () => api<{ shops: Shop[] }>("/api/v1/merchant/shops"),
  createShop: (input: {
    name: string;
    heroData?: string | null;
    latitude: number;
    longitude: number;
    radiusMeters: number;
  }) =>
    api<{ shop: Shop }>("/api/v1/merchant/shops", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateShop: (
    id: string,
    input: {
      name?: string;
      heroData?: string | null;
      latitude?: number;
      longitude?: number;
      radiusMeters?: number;
    },
  ) =>
    api<{ shop: Shop }>(`/api/v1/merchant/shops/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteShop: (id: string) =>
    api<{ ok: true }>(`/api/v1/merchant/shops/${id}`, { method: "DELETE" }),
  machines: (shopId: string) =>
    api<{ machines: Resource[] }>(
      `/api/v1/merchant/machines?shopId=${encodeURIComponent(shopId)}`,
    ),
  resourceGroups: (shopId: string) =>
    api<{ resourceGroups: ResourceGroup[] }>(
      `/api/v1/merchant/resource-groups?shopId=${encodeURIComponent(shopId)}`,
    ),
  createResourceGroup: (input: { shopId: string; name: string; defaultPricingConfigId: string | null }) =>
    api<{ resourceGroup: ResourceGroup }>("/api/v1/merchant/resource-groups", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateResourceGroup: (
    id: string,
    input: { shopId: string; name?: string; enabled?: boolean; defaultPricingConfigId?: string | null },
  ) =>
    api<{ resourceGroup: ResourceGroup }>(`/api/v1/merchant/resource-groups/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteResourceGroup: (shopId: string, id: string) =>
    api<{ ok: true }>(
      `/api/v1/merchant/resource-groups/${encodeURIComponent(id)}?shopId=${encodeURIComponent(shopId)}`,
      { method: "DELETE" },
    ),
  createResource: (input: {
    shopId: string;
    name: string;
    hinataUrl: string;
    hinataPassword?: string | undefined;
    enabled: boolean;
  }) =>
    api<{ machine: Resource }>("/api/v1/merchant/machines", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateResource: (
    id: string,
    input: {
      name?: string | undefined;
      hinataUrl?: string | undefined;
      hinataPassword?: string | null | undefined;
      enabled?: boolean | undefined;
    },
  ) =>
    api<{ ok: true }>(`/api/v1/merchant/machines/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteResource: (id: string) =>
    api<{ ok: true }>(`/api/v1/merchant/machines/${id}`, { method: "DELETE" }),
  shopMembers: (shopId: string) =>
    api<{ members: ShopMember[] }>(
      `/api/v1/merchant/shop-members?shopId=${encodeURIComponent(shopId)}`,
    ),
  addShopMember: (input: {
    shopId: string;
    user: string;
    role: "owner" | "staff";
  }) =>
    api<{ ok: true }>("/api/v1/merchant/shop-members", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  removeShopMember: (id: string) =>
    api<{ ok: true }>(`/api/v1/merchant/shop-members/${id}`, {
      method: "DELETE",
    }),
  loginEvents: (input: {
    shopId?: string;
    machineId?: string;
    limit?: number;
  }) => {
    const params = new URLSearchParams();
    if (input.shopId) params.set("shopId", input.shopId);
    if (input.machineId) params.set("machineId", input.machineId);
    if (input.limit) params.set("limit", String(input.limit));
    return api<{ events: LoginEvent[] }>(
      `/api/v1/merchant/login-events?${params.toString()}`,
    );
  },
  adminUsers: (query?: string) =>
    api<{ users: UserSummary[] }>(
      `/api/v1/admin/users${query ? `?query=${encodeURIComponent(query)}` : ""}`,
    ),
  setUserRole: (userId: string, role: User["role"]) =>
    api<{ ok: true }>("/api/v1/admin/users/role", {
      method: "POST",
      body: JSON.stringify({ userId, role }),
    }),
  deleteUser: (userId: string) =>
    api<{ ok: true }>(`/api/v1/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE" }),
  bans: () => api<{ bans: Ban[] }>("/api/v1/admin/bans"),
  createBan: (input: {
    subjectType: Ban["subjectType"];
    subjectValue: string;
    reason: string;
    expiresAt?: string;
  }) =>
    api<{ ok: true }>("/api/v1/admin/bans", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteBan: (id: string) =>
    api<{ ok: true }>(`/api/v1/admin/bans/${id}`, { method: "DELETE" }),
};

/**
 * Device actions: a swipe, a coin, power. The server keeps whatever it answered
 * under the request ID, failures included, so a retry with the same ID only
 * replays that answer; and the next action is a new request, not one to hold
 * back until the last is settled.
 */
const isDeviceAction = (path: string) =>
  /\/(merchant\/machines\/[^/]+|devices\/session)\/actions$/.test(path);

/**
 * Keep the request ID through network errors and page reloads. A device action
 * keeps it only while no answer came back, and a different action replaces it.
 */
export async function playerOperation<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const key = `prism.pending:${sessionStorage.getItem("prism.user") ?? ""}:${path}${path === "/api/v1/devices/session/actions" ? `:${body.ticket}:${body.action}` : path.endsWith("/player/session/start") ? `:${body.ticket}` : ""}`;
  const { location: _location, ...payload } = body;
  const fingerprint = JSON.stringify(payload);
  const device = isDeviceAction(path);
  const stored = sessionStorage.getItem(key);
  const kept = stored ? (JSON.parse(stored) as { id: string; fingerprint: string }) : null;
  const pending = kept && (kept.fingerprint === fingerprint || !device)
    ? kept
    : { id: crypto.randomUUID(), fingerprint };
  if (pending.fingerprint !== fingerprint)
    throw new ApiError(
      "上一笔操作尚未确认，请先查看记录或联系店员",
      409,
      "OPERATION_PENDING",
    );
  sessionStorage.setItem(key, JSON.stringify(pending));
  try {
    const result = await api<T>(path, {
      method: "POST",
      body: JSON.stringify({ ...body, operationId: pending.id }),
    });
    sessionStorage.removeItem(key);
    return result;
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status < 500 || device) &&
      error.code !== "OPERATION_PENDING"
    )
      sessionStorage.removeItem(key);
    throw error;
  }
}
