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

export type PublicMachine = {
  coinAfterSwipe: boolean;
  kind: "machine" | "door";
  capabilities: { power: boolean; coin: boolean; card: boolean; door: boolean; mahjong?: boolean };
  webOnly?: boolean;
  publicId: string;
  name: string;
  shop: {
    name: string;
    publicId?: string;
    locationEnabled?: boolean;
    machineGeo?: boolean;
    billingEnabled?: boolean;
    webUrl?: string;
    heroUrl?: string | null;
    latitude: number;
    longitude: number;
    radiusMeters: number;
  };
};

export type MachineLoginResult = {
  ok: true;
  coin?: {
    status: "sent" | "skipped" | "failed" | "unknown";
    operationId: string;
    reason?: string;
  };
};

export type MachineSession = {
  ticket: string;
  expiresIn: number;
  machine: PublicMachine;
};

export type Shop = {
  id: string;
  publicId: string;
  name: string;
  heroUrl?: string | null;
  latitude: number;
  longitude: number;
  radius_meters?: number;
  radiusMeters?: number;
};

export type Machine = {
  mahjong?: { capacity: number; pricingConfigIds: string[] } | null;
  coinAfterSwipe: boolean;
  hasHinata: boolean;
  kind: "machine" | "door";
  hinataUrl: string | null;
  homeAssistant: { url: string; entityId: string } | null;
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

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  get sessionExpired(): boolean {
    return (
      this.code === "TICKET_EXPIRED" ||
      this.message === "本次会话已失效" ||
      this.message === "缺少会话凭证"
    );
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const send = () => fetch(path, {
    ...options,
    cache: "no-store",
    credentials: "include",
    headers: {
      "content-type": "application/json",
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
    error?: { code: string; message: string; details?: unknown };
  };
  if (!response.ok)
    throw new ApiError(
      payload.error?.message || `Request failed (${response.status})`,
      response.status,
      payload.error?.code,
      payload.error?.details,
    );
  return payload.data as T;
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
  startMachineSession: (shopCode: string, publicId: string) =>
    api<MachineSession>("/api/v1/machines/session/start", {
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
  publicMachine: (ticketOrPublicId: string, ticket?: string) => {
    const url = ticket
      ? `/api/v1/machines/${encodeURIComponent(ticketOrPublicId)}?ticket=${encodeURIComponent(ticket)}`
      : `/api/v1/machines/session?ticket=${encodeURIComponent(ticketOrPublicId)}`;
    return api<{ machine: PublicMachine }>(url);
  },
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
    api<{ machines: Machine[] }>(
      `/api/v1/merchant/machines?shopId=${encodeURIComponent(shopId)}`,
    ),
  createMachine: (input: {
    shopId: string;
    name: string;
    hinataUrl: string;
    hinataPassword?: string | undefined;
    enabled: boolean;
  }) =>
    api<{ machine: Machine }>("/api/v1/merchant/machines", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateMachine: (
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
  deleteMachine: (id: string) =>
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

/** Keep the request ID through network errors and page reloads. */
export async function playerOperation<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const key = `prism.pending:${sessionStorage.getItem("prism.user") ?? ""}:${path}${path === "/api/v1/devices/session/actions" ? `:${body.ticket}:${body.action}` : path.endsWith("/player/session/start") ? `:${body.ticket}` : ""}`;
  const { location: _location, ...payload } = body;
  const fingerprint = JSON.stringify(payload);
  const stored = sessionStorage.getItem(key);
  const pending = stored
    ? (JSON.parse(stored) as { id: string; fingerprint: string })
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
      error.status < 500 &&
      error.code !== "OPERATION_PENDING"
    )
      sessionStorage.removeItem(key);
    throw error;
  }
}
