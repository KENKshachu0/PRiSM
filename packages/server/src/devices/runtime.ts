/**
 * Hardware runners and readers for the capability catalog, plus the per-request
 * bus that wires them together. Runners only talk to hardware; recording what
 * happened is the bus's job.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import { createD1Executor } from "@prism/adapter-d1";
import { normalizeTTLockConnectionConfig } from "@prism/application";
import { createDeviceEventRepository } from "@prism/storage-sql";
import type { Env } from "../bindings.js";
import { callHomeAssistantPower, getHomeAssistantEntityState } from "../hardware/home-assistant.js";
import { normalizeHinataUrl, sendHinataCard, sendHinataCoin } from "../hardware/hinata.js";
import { TTLockClient } from "../hardware/ttlock.js";
import { machineRelayNamespace } from "../gateway/machine-relay-gateway.js";
import { createDeviceBus, type ActionRunner, type RunOutcome, type StateReader } from "./bus.js";
import { doorConfigOf, hinataConfigOf, readSecret, type Device } from "./device.js";

const KEY_PRESS_TTL_MS = 30_000;
const HA_TIMEOUT_MS = 10_000;

type HaBinding = { url: string; token: string; entityId: string };

export type DeviceRuntime = {
  db: D1DatabaseLike;
  env: Env;
  shopId: string;
  fetcher?: typeof fetch;
  now?: () => Date;
  id?: () => string;
};

async function haBinding(runtime: DeviceRuntime, device: Device): Promise<HaBinding | null> {
  const raw = await readSecret(runtime.db, device, "power", "binding", runtime.env.URL_ENCRYPTION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<HaBinding>;
    return typeof parsed.url === "string" && typeof parsed.token === "string" && typeof parsed.entityId === "string"
      ? { url: parsed.url, token: parsed.token, entityId: parsed.entityId }
      : null;
  } catch {
    return null;
  }
}

/** Live Home Assistant power state: "on", "off", or null when it cannot be read. */
export async function readPower(runtime: DeviceRuntime, device: Device): Promise<"on" | "off" | null> {
  const binding = await haBinding(runtime, device);
  if (!binding) return null;
  const state = await getHomeAssistantEntityState({
    baseUrl: binding.url,
    accessToken: binding.token,
    entityId: binding.entityId,
    fetch: runtime.fetcher,
    timeoutMs: 3000,
  });
  return state === "on" || state === "off" ? state : null;
}

function powerRunner(runtime: DeviceRuntime, service: "turn_on" | "turn_off"): ActionRunner {
  return async ({ device }) => {
    const binding = await haBinding(runtime, device);
    if (!binding) return { outcome: "failed", message: "电源未配置" };
    return relayOutcome(await callHomeAssistantPower({
      baseUrl: binding.url,
      accessToken: binding.token,
      entityId: binding.entityId,
      service,
      fetch: runtime.fetcher,
      timeoutMs: HA_TIMEOUT_MS,
    }));
  };
}

/** Map an HTTP call result: no status means the request may still have arrived. */
function relayOutcome(result: { ok: boolean; status: number; error?: string }): RunOutcome {
  if (result.ok) return { outcome: "ok" };
  if (result.status === 0) return { outcome: "unknown", message: result.error ?? "机台未响应" };
  return { outcome: "failed", message: result.error ?? "机台通信失败", httpStatus: result.status };
}

function cardRunner(runtime: DeviceRuntime): ActionRunner {
  return async ({ device, operationId, payload }) => {
    const accessCode = typeof payload.accessCode === "string" ? payload.accessCode : "";
    if (!accessCode) return { outcome: "failed", message: "缺少卡号" };
    const config = hinataConfigOf(device)!;
    // `source` carries the operation id so the machine's card report can be
    // tied back to this request.
    if (config.transport === "embedded") {
      const relay = machineRelayNamespace(runtime.env);
      if (!relay || !config.channel) return { outcome: "failed", message: "直连中继尚未配置" };
      const sent = await relay.getByName(config.channel).sendCard({ accessCode, source: operationId });
      return sent.ok ? { outcome: "ok" } : { outcome: "failed", message: sent.error ?? "机台未在线" };
    }
    const url = await readSecret(runtime.db, device, "hinata_io", "url", runtime.env.URL_ENCRYPTION_KEY);
    if (!url) return { outcome: "failed", message: "机台未配置连接地址" };
    const password = await readSecret(runtime.db, device, "hinata_io", "password", runtime.env.URL_ENCRYPTION_KEY);
    return relayOutcome(await sendHinataCard(normalizeHinataUrl(url), accessCode, password, operationId, {
      fetcher: runtime.fetcher,
    }));
  };
}

function coinRunner(runtime: DeviceRuntime): ActionRunner {
  return async ({ device, operationId, payload }) => {
    const config = hinataConfigOf(device)!;
    const count = typeof payload.count === "number" ? payload.count : 1;
    // Staff may press a key of their choosing; otherwise the device's
    // configured coin key is used.
    const key = typeof payload.key === "number" ? payload.key : config.coinKey;
    if (config.transport === "embedded") {
      const relay = machineRelayNamespace(runtime.env);
      if (!relay || !config.channel) return { outcome: "failed", message: "直连中继尚未配置" };
      const sent = await relay.getByName(config.channel).sendKeyPress({
        key,
        count,
        messageId: operationId,
        expiresAt: (runtime.now?.() ?? new Date()).getTime() + KEY_PRESS_TTL_MS,
      });
      return sent.ok ? { outcome: "ok" } : { outcome: "failed", message: sent.error ?? "机台未在线" };
    }
    const url = await readSecret(runtime.db, device, "hinata_io", "url", runtime.env.URL_ENCRYPTION_KEY);
    if (!url) return { outcome: "failed", message: "机台未配置连接地址" };
    const password = await readSecret(runtime.db, device, "hinata_io", "password", runtime.env.URL_ENCRYPTION_KEY);
    return relayOutcome(await sendHinataCoin(normalizeHinataUrl(url), key, password, operationId, {
      count,
      fetcher: runtime.fetcher,
    }));
  };
}

function doorRunner(runtime: DeviceRuntime): ActionRunner {
  return async ({ device, payload }) => {
    const config = doorConfigOf(device)!;
    // TTLock credentials are one account per shop, not per lock.
    const row = await runtime.db
      .prepare("SELECT value_json FROM app_settings WHERE shop_id=? AND key='devices.ttlock_connection'")
      .bind(runtime.shopId)
      .first<{ value_json: string }>();
    const connection = normalizeTTLockConnectionConfig(row ? JSON.parse(row.value_json) : undefined);
    if (!connection.accessToken && !connection.refreshToken && !(connection.appAccount && connection.appPwd)) {
      return { outcome: "failed", message: "店家尚未配置门锁" };
    }
    const fetcher = runtime.fetcher ?? fetch;
    const client = new TTLockClient({
      connection,
      fetcher: (url, init) => fetcher(url, { ...init, signal: AbortSignal.timeout(HA_TIMEOUT_MS) }),
      onConnectionUpdated: async (value) => {
        await runtime.db
          .prepare("UPDATE app_settings SET value_json=?,updated_at=? WHERE shop_id=? AND key='devices.ttlock_connection'")
          .bind(JSON.stringify(value), new Date().toISOString(), runtime.shopId)
          .run();
      },
    });
    const holder = typeof payload.holder === "string" ? payload.holder : "prism";
    const code = await client.createRandomTemporaryPassword(config.lockId, `prism:${holder}`);
    return { outcome: "ok", result: { temporaryPassword: code.password, expiresAt: code.expiresAt } };
  };
}

export function createRuntimeBus(runtime: DeviceRuntime) {
  const runners: Record<string, ActionRunner> = {
    "power.on": powerRunner(runtime, "turn_on"),
    "power.off": powerRunner(runtime, "turn_off"),
    "aime.scan": cardRunner(runtime),
    coin: coinRunner(runtime),
    "door.open": doorRunner(runtime),
  };
  const readers: Record<string, StateReader> = {
    "power.power": (device) => readPower(runtime, device),
  };
  return createDeviceBus({
    events: createDeviceEventRepository(createD1Executor(runtime.db, runtime.shopId)),
    now: runtime.now ?? (() => new Date()),
    id: runtime.id ?? (() => crypto.randomUUID()),
    runners,
    readers,
  });
}
