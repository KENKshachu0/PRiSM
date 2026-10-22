/**
 * Onboard the end-to-end Home Assistant: create its owner, finish onboarding and mint a long-lived
 * access token, which is the "control token" a shop would give the platform. Written to
 * `.e2e/ha.json`. Safe to run again: an already onboarded instance is logged into instead.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { haLogin, haLongLivedToken, haStates } from "./ha-client.ts";

const base = process.env.HA_URL ?? "http://127.0.0.1:8123";
const clientId = `${base}/`;
const username = "admin";
const password = "prism-e2e-password";
const json = { "content-type": "application/json" };

async function onboard(): Promise<string> {
  // Once onboarding has finished the endpoint is gone (404), which is the same as "nothing left to do".
  const response = await fetch(`${base}/api/onboarding`);
  const steps = response.ok ? ((await response.json()) as Array<{ step: string; done: boolean }>) : [];
  if (!steps.find((step) => step.step === "user" && !step.done)) return haLogin(base, username, password);
  const created = await fetch(`${base}/api/onboarding/users`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ client_id: clientId, name: "E2E Admin", username, password, language: "en" }),
  });
  if (!created.ok) throw new Error(`onboarding user ${created.status}: ${await created.text()}`);
  const tokenResponse = await fetch(`${base}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code: ((await created.json()) as { auth_code: string }).auth_code,
    }),
  });
  const { access_token } = (await tokenResponse.json()) as { access_token: string };
  const auth = { ...json, authorization: `Bearer ${access_token}` };
  for (const [step, body] of [
    ["core_config", {}],
    ["analytics", {}],
    ["integration", { client_id: clientId, redirect_uri: `${clientId}?auth_callback=1` }],
  ] as const) {
    const done = await fetch(`${base}/api/onboarding/${step}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
    if (!done.ok) console.warn(`onboarding ${step}: ${done.status}`);
  }
  return access_token;
}

const accessToken = await onboard();
const adminToken = await haLongLivedToken(base, accessToken, "prism-e2e");
const states = await haStates(base, adminToken);
const wanted = states.filter((state) => /^(switch|climate)\./.test(state.entity_id));
await mkdir(".e2e", { recursive: true });
await writeFile(".e2e/ha.json", JSON.stringify({ url: base, adminToken, adminAccessToken: accessToken, username, password }, null, 2));
console.log(`onboarded; ${states.length} entities; ${wanted.map((s) => `${s.entity_id}=${s.state}`).join(", ")}`);
