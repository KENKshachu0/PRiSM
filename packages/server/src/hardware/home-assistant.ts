type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Turn a switch-like entity on or off. `status` 0 means no response arrived,
 * so the call may or may not have taken effect.
 */
export async function callHomeAssistantPower(input: {
  baseUrl: string;
  accessToken: string;
  entityId: string;
  service: "turn_on" | "turn_off";
  fetch?: Fetch;
  timeoutMs?: number;
}): Promise<{ ok: boolean; status: number; error?: string }> {
  const fetcher = input.fetch ?? fetch;
  const domain = input.entityId.split(".")[0] || "switch";
  try {
    const response = await fetcher(
      `${input.baseUrl.replace(/\/+$/, "")}/api/services/${encodeURIComponent(domain)}/${input.service}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${input.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ entity_id: input.entityId }),
        signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
      },
    );
    return response.ok
      ? { ok: true, status: response.status }
      : { ok: false, status: response.status, error: `Home Assistant 返回 ${response.status}` };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error && error.name === "TimeoutError" ? "Home Assistant 未响应" : String(error) };
  }
}

/**
 * Call any Home Assistant service on one entity. `status` 0 means no response
 * arrived, so the call may or may not have taken effect.
 */
export async function callHomeAssistantService(input: {
  baseUrl: string;
  accessToken: string;
  entityId: string;
  domain: string;
  service: string;
  data?: Record<string, unknown>;
  fetch?: Fetch;
  timeoutMs?: number;
}): Promise<{ ok: boolean; status: number; error?: string }> {
  const fetcher = input.fetch ?? fetch;
  try {
    const response = await fetcher(
      `${input.baseUrl.replace(/\/+$/, "")}/api/services/${encodeURIComponent(input.domain)}/${encodeURIComponent(input.service)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${input.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...input.data, entity_id: input.entityId }),
        signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
      },
    );
    return response.ok
      ? { ok: true, status: response.status }
      : { ok: false, status: response.status, error: `Home Assistant 返回 ${response.status}` };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error && error.name === "TimeoutError" ? "Home Assistant 未响应" : String(error) };
  }
}

/** One entity's state and attributes, or null when it cannot be read. */
export async function getHomeAssistantEntity(input: {
  baseUrl: string;
  accessToken: string;
  entityId: string;
  fetch?: Fetch;
  timeoutMs?: number;
}): Promise<{ state: string; attributes: Record<string, unknown> } | null> {
  const fetcher = input.fetch ?? fetch;
  try {
    const response = await fetcher(
      `${input.baseUrl.replace(/\/+$/, "")}/api/states/${encodeURIComponent(input.entityId)}`,
      {
        headers: { Authorization: `Bearer ${input.accessToken}` },
        signal: AbortSignal.timeout(input.timeoutMs ?? 3000),
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { state?: unknown; attributes?: unknown };
    if (typeof body.state !== "string") return null;
    const attributes =
      body.attributes && typeof body.attributes === "object" && !Array.isArray(body.attributes)
        ? (body.attributes as Record<string, unknown>)
        : {};
    return { state: body.state, attributes };
  } catch {
    return null;
  }
}

export async function getHomeAssistantEntityState(input: {
  baseUrl: string;
  accessToken: string;
  entityId: string;
  fetch?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}): Promise<string> {
  const fetcher = input.fetch ?? ((url: string | URL | Request, init?: RequestInit) => fetch(url, init));
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), input.timeoutMs ?? 3000);

  try {
    const response = await fetcher(
      `${baseUrl}/api/states/${encodeURIComponent(input.entityId)}`,
      {
        headers: { Authorization: `Bearer ${input.accessToken}` },
        signal: controller.signal,
      },
    );
    if (!response.ok) return "unknown";
    const body = (await response.json()) as { state?: string };
    return body.state === "on" || body.state === "off" ? body.state : body.state || "unknown";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timeout);
  }
}
