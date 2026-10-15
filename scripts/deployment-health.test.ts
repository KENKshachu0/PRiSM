import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { deploymentHealth } from "./deployment-control-client";
import { deployPlatform, type PlatformDeploymentSteps } from "./deploy-platform-flow";
import { worker } from "../packages/server/src/worker";
import { createD1DatabaseFromSqlite } from "../packages/server/src/local-server";
import { deploymentGateSchema } from "../packages/server/src/deployment-gate";
import type { Env } from "../packages/server/src/bindings";

const revision = "a".repeat(40);
function fixture(reply: (call: number, url: URL, init?: RequestInit) => Response | Promise<Response>) {
  let now = 0, calls = 0;
  const options = {
    origin: new URL("https://test.example"), revision, timeoutMs: 10_000,
    now: () => now,
    sleep: async (ms: number) => { now += ms; },
    fetch: Object.assign(async (url: unknown, init?: RequestInit) => reply(++calls, new URL(String(url)), init), { preconnect: fetch.preconnect }),
  };
  return { options, calls: () => calls, elapsed: () => now };
}

test("public health waits for real Worker phase, database gate and exact release to agree", async () => {
  const sqlite = new Database(":memory:");
  sqlite.run(deploymentGateSchema);
  sqlite.run("INSERT INTO prism_deployment_gate VALUES ('global','owner',0,0,1,'now')");
  const env = { DB: createD1DatabaseFromSqlite(sqlite), PRISM_DEPLOY_GUARD: "1", PRISM_DEPLOY_REVISION: revision } as Env;
  const f = fixture((call, url, init) => {
    expect(url.pathname).toBe("/api/v1/health");
    expect(init?.cache).toBe("no-store");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    if (call === 4) sqlite.run("UPDATE prism_deployment_gate SET maintenance=1");
    if (call === 5) sqlite.run("UPDATE prism_deployment_gate SET maintenance=0");
    return worker.fetch(new Request(url, init), {
      ...env,
      PRISM_DEPLOY_PHASE: call === 1 ? "maintenance" : call === 2 ? "verify" : "live",
      PRISM_DEPLOY_REVISION: call === 3 ? "b".repeat(40) : revision,
    });
  });
  try {
    await deploymentHealth(f.options);
    expect(f.calls()).toBe(5);
    expect(f.elapsed()).toBe(8_000);
  } finally { sqlite.close(); }
});

test("public health recovers from network errors and old HTML routes", async () => {
  const f = fixture(call => {
    if (call === 1) throw new TypeError("connection reset");
    if (call === 2) return new Response("old SPA");
    return Response.json({ data: { ok: true } }, { headers: { "x-prism-revision": revision } });
  });
  await deploymentHealth(f.options);
  expect(f.calls()).toBe(3);
});

test("incorrect release, unhealthy body and HTTP failure never confirm public health", async () => {
  for (const response of [
    () => Response.json({ data: { ok: true } }, { headers: { "x-prism-revision": "b".repeat(40) } }),
    () => Response.json({ data: { ok: false } }, { headers: { "x-prism-revision": revision } }),
    () => Response.json({ data: { ok: true } }, { status: 503, headers: { "x-prism-revision": revision } }),
  ]) {
    const f = fixture(response);
    await expect(deploymentHealth(f.options)).rejects.toThrow("Public health check timed out");
    expect(f.calls()).toBe(5);
    expect(f.elapsed()).toBe(10_000);
  }
});

test("only a sustained public health failure re-blocks the deployment, without logging response contents", async () => {
  const calls: string[] = [];
  const f = fixture(() => new Response("private internal details", { status: 503 }));
  const steps: PlatformDeploymentSteps = {
    preflight: async () => {}, deploy: async () => {}, checkpoint: async () => {}, migrate: async () => {},
    control: async action => { calls.push(action); }, health: () => deploymentHealth(f.options),
  };
  try {
    await deployPlatform(steps);
    throw new Error("Expected failure");
  } catch (error) {
    expect((error as Error).message).toContain("HTTP 503, revision not matched");
    expect((error as Error).message).not.toContain("private internal details");
  }
  expect(calls.slice(-2)).toEqual(["resume", "block"]);
  expect(f.elapsed()).toBe(10_000);
});
