import { deploymentControlPath } from "../packages/server/src/deployment-gate";

type Result = { ok?: boolean; revision?: string; phase?: string; code?: string; error?: unknown };
type Options = {
  origin: URL;
  token: string;
  revision: string;
  sleep(milliseconds: number): Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

/** Public GETs can still reach an earlier phase after the authenticated POST succeeds. */
export async function deploymentHealth(options: Omit<Options, "token">): Promise<void> {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 180_000);
  let last = "no response";
  while (now() < deadline) {
    try {
      const response = await request(new URL("/api/v1/health", options.origin), {
        cache: "no-store", signal: AbortSignal.timeout(Math.min(10_000, Math.max(1, deadline - now()))), redirect: "error",
      });
      last = `HTTP ${response.status}`;
      const matchingRevision = response.headers.get("x-prism-revision") === options.revision;
      last += matchingRevision ? ", revision matched" : ", revision not matched";
      let result: { data?: { ok?: boolean } } | null = null;
      try { result = await response.json(); } catch { /* Old assets or an edge error may return HTML. */ }
      if (response.ok && result?.data?.ok === true && matchingRevision) return;
    } catch {
      last = "network error";
    }
    await options.sleep(Math.min(2_000, Math.max(0, deadline - now())));
  }
  throw new Error(`Public health check timed out (${last}); expected release ${options.revision.slice(0, 12)} after resume was not confirmed`);
}

/** A new upload can reach the domain after Wrangler reports deployment success. */
export async function deploymentRequest(options: Options, body: Record<string, unknown>, expectedPhase?: string): Promise<Result> {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 180_000);
  let last = "no response";
  while (now() < deadline) {
    let response: Response;
    try {
      response = await request(new URL(deploymentControlPath, options.origin), {
        method: "POST", headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(Math.min(10_000, Math.max(1, deadline - now()))), redirect: "error",
      });
    } catch {
      last = "network error";
      await options.sleep(Math.min(2_000, Math.max(0, deadline - now())));
      continue;
    }
    let result: Result = {};
    try {
      const payload: unknown = await response.json();
      if (payload && typeof payload === "object" && !Array.isArray(payload)) result = payload as Result;
    } catch { /* An old route may still return HTML. */ }
    if (response.ok && result.ok === true && result.revision === options.revision
      && (!expectedPhase || result.phase === expectedPhase)) return result;
    last = `HTTP ${response.status}`;
    // Authenticated business/SQL failures are not propagation delays. Do not hide them
    // behind retries or expose arbitrary response bodies in the deployment log.
    const phasePending = response.status === 409 && result.code === "DEPLOYMENT_PHASE_NOT_READY";
    const knownCodes = ["DEPLOYMENT_OWNERSHIP_CHANGED", "DEPLOYMENT_MAINTENANCE_REQUIRED", "DEPLOYMENT_VERIFICATION_REQUIRED", "DEPLOYMENT_PHASE_NOT_READY"];
    if (result.code && knownCodes.includes(result.code)) last += ` ${result.code}`;
    if (!phasePending && ![404, 408, 429, 502, 503, 504].includes(response.status) && !response.ok) {
      throw new Error(`Deployment ${body.action} failed (${last}); release ${options.revision.slice(0, 12)} was not confirmed`);
    }
    await options.sleep(Math.min(2_000, Math.max(0, deadline - now())));
  }
  throw new Error(`Deployment ${body.action} timed out (${last}); expected release ${options.revision.slice(0, 12)}${expectedPhase ? ` in ${expectedPhase} phase` : ""} was not confirmed. Check domain routing and deployment bindings.`);
}
