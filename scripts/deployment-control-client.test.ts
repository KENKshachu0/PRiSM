import { expect, test } from "bun:test";
import { deploymentRequest } from "./deployment-control-client";

const token = "test-token-".repeat(6), revision = "1".repeat(40);
const originalFetch = globalThis.fetch;
function fixture(reply: (call: number, init?: RequestInit) => Response | Promise<Response>, timeoutMs = 180_000) {
  let now = 0, calls = 0;
  const sleeps: number[] = [];
  const options = {
    origin: new URL("https://test.example"), token, revision, timeoutMs,
    now: () => now,
    sleep: async (ms: number) => { sleeps.push(ms); now += ms; },
    fetch: Object.assign(async (_url: unknown, init?: RequestInit) => reply(++calls, init), { preconnect: originalFetch.preconnect }),
  };
  return { options, sleeps, calls: () => calls, elapsed: () => now };
}

test("readiness waits through old 404, HTML and wrong phase until the exact authenticated upload responds", async () => {
  const responses = [
    Response.json({ error: "Not found" }, { status: 404 }),
    new Response("old SPA", { headers: { "content-type": "text/html" } }),
    Response.json({ ok: true, revision: "old", phase: "maintenance" }),
    Response.json({ ok: true, revision, phase: "verify" }),
    Response.json({ ok: true, revision, phase: "maintenance" }),
  ];
  const f = fixture((call, init) => {
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(JSON.parse(String(init?.body))).toEqual({ action: "probe" });
    return responses[call - 1]!;
  });
  expect((await deploymentRequest(f.options, { action: "probe" }, "maintenance")).phase).toBe("maintenance");
  expect(f.calls()).toBe(5);
  expect(f.elapsed()).toBe(8_000);
});

test("a persistent 404 has a bounded wait and never exposes token or response contents", async () => {
  const f = fixture(() => Response.json({ error: `private response ${token}` }, { status: 404 }));
  let message = "";
  try { await deploymentRequest(f.options, { action: "begin" }); } catch (error) { message = (error as Error).message; }
  expect(message).toContain("Deployment begin timed out (HTTP 404)");
  expect(message).not.toContain(token);
  expect(message).not.toContain("private response");
  expect(f.elapsed()).toBe(180_000);
  expect(f.calls()).toBe(90);
});

test("authenticated SQL and ownership failures stop immediately without retrying", async () => {
  for (const status of [400, 409, 500]) {
    const f = fixture(() => Response.json({ error: "internal database details", revision }, { status }));
    await expect(deploymentRequest(f.options, { action: "schema" })).rejects.toThrow(`HTTP ${status}`);
    expect(f.calls()).toBe(1);
    expect(f.sleeps).toEqual([]);
  }
});

test("terminal failures print the server reason and edge error snippet", async () => {
  const structured = fixture(() =>
    Response.json({ error: "D1 migration failed: no such table", revision }, { status: 500 }));
  await expect(deploymentRequest(structured.options, { action: "schema" }))
    .rejects.toThrow("D1 migration failed: no such table");

  const edge = fixture(() => new Response("Error 1101: Worker threw exception", {
    status: 500, headers: { "content-type": "text/html" },
  }));
  await expect(deploymentRequest(edge.options, { action: "probe" }, "verify"))
    .rejects.toThrow("Error 1101: Worker threw exception");
  await expect(deploymentRequest(edge.options, { action: "probe" }, "verify"))
    .rejects.toThrow("verify phase");
});

test("a named step failure survives the rollout wrapper", async () => {
  // Covered in deploy-platform-flow.test.ts; this guards the message shape
  // operators rely on when the CI log stops mid-rollout.
  const structured = fixture(() =>
    Response.json({ code: "DEPLOYMENT_VERIFICATION_REQUIRED", error: "verify failed" }, { status: 409 }));
  await expect(deploymentRequest(structured.options, { action: "resume" }, "live"))
    .rejects.toThrow(/DEPLOYMENT_VERIFICATION_REQUIRED/);
});

test("a lost resume response can be retried against the idempotent control endpoint", async () => {
  const f = fixture(call => {
    if (call === 1) throw new TypeError("connection lost");
    return Response.json({ ok: true, revision, maintenance: false });
  });
  expect((await deploymentRequest(f.options, { action: "resume" })).ok).toBe(true);
  expect(f.calls()).toBe(2);
});

test("resume retries a stale verify phase but reports ownership conflicts without retrying", async () => {
  const f = fixture(call => call === 1
    ? Response.json({ error: "Invalid deployment phase or action", code: "DEPLOYMENT_PHASE_NOT_READY", revision, phase: "verify" }, { status: 409 })
    : Response.json({ ok: true, revision, phase: "live", maintenance: false }));
  expect((await deploymentRequest(f.options, { action: "resume" }, "live")).ok).toBe(true);
  expect(f.calls()).toBe(2);
  const conflict = fixture(() => Response.json({ code: "DEPLOYMENT_OWNERSHIP_CHANGED", revision, phase: "live" }, { status: 409 }));
  await expect(deploymentRequest(conflict.options, { action: "resume" }, "live")).rejects.toThrow("DEPLOYMENT_OWNERSHIP_CHANGED");
  expect(conflict.calls()).toBe(1);
});
