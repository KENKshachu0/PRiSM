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
import {
  callHomeAssistantPower,
  callHomeAssistantService,
  getHomeAssistantEntity,
  getHomeAssistantEntityState,
} from "../hardware/home-assistant.js";
import { normalizeHinataUrl, sendHinataCard, sendHinataCoin } from "../hardware/hinata.js";
import { TTLockClient } from "../hardware/ttlock.js";
import { machineRelayNamespace } from "../gateway/machine-relay-gateway.js";
import { createDeviceBus, type ActionRunner, type RunOutcome, type StateReader } from "./bus.js";
import { doorConfigOf, hinataConfigOf, readSecret, type Device } from "./device.js";

const KEY_PRESS_TTL_MS = 30_000;
const HA_TIMEOUT_MS = 10_000;
/**
 * A game waiting for a card polls its reader continuously, so an unread card
 * means it is busy elsewhere; the IO drops the card after 3 s. The verdict needs
 * the game's server, which can take several seconds.
 */
const CARD_LOGIN_WAIT = { readMs: 4500, resultMs: 15_000 };

type HaBinding = { url: string; token: string; entityId: string };

export type DeviceRuntime = {
  db: D1DatabaseLike;
  env: Env;
  shopId: string;
  fetcher?: typeof fetch;
  now?: () => Date;
  id?: () => string;
};

async function haBinding(
  runtime: DeviceRuntime,
  device: Device,
  capability: "power" | "climate" = "power",
): Promise<HaBinding | null> {
  const raw = await readSecret(runtime.db, device, capability, "binding", runtime.env.URL_ENCRYPTION_KEY);
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

/** What a climate entity is doing and what it offers, read live from Home Assistant. */
export type ClimateState = {
  /** `off`, or the running HVAC mode such as `cool`, `heat`, `dry`, `fan_only`, `auto`. */
  mode: string;
  modes: string[];
  temperature: number | null;
  currentTemperature: number | null;
  minTemperature: number | null;
  maxTemperature: number | null;
  temperatureStep: number | null;
  fanMode: string | null;
  fanModes: string[];
};

const numberOrNull = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Live climate state, or null when Home Assistant cannot be read. */
export async function readClimate(runtime: DeviceRuntime, device: Device): Promise<ClimateState | null> {
  const binding = await haBinding(runtime, device, "climate");
  if (!binding) return null;
  const entity = await getHomeAssistantEntity({
    baseUrl: binding.url,
    accessToken: binding.token,
    entityId: binding.entityId,
    fetch: runtime.fetcher,
    timeoutMs: 3000,
  });
  if (!entity || entity.state === "unavailable" || entity.state === "unknown") return null;
  const a = entity.attributes;
  return {
    mode: entity.state,
    modes: strings(a.hvac_modes),
    temperature: numberOrNull(a.temperature),
    currentTemperature: numberOrNull(a.current_temperature),
    minTemperature: numberOrNull(a.min_temp),
    maxTemperature: numberOrNull(a.max_temp),
    temperatureStep: numberOrNull(a.target_temp_step),
    fanMode: typeof a.fan_mode === "string" ? a.fan_mode : null,
    fanModes: strings(a.fan_modes),
  };
}

/**
 * The part of a climate state that is a setting. Room temperature drifts on
 * its own, so recording it would log a change on nearly every read.
 */
export const climateSetting = (state: ClimateState) => ({
  mode: state.mode,
  temperature: state.temperature,
  fanMode: state.fanMode,
});

function climateRunner(
  runtime: DeviceRuntime,
  service: string,
  data: (payload: Record<string, unknown>) => Record<string, unknown> | null,
): ActionRunner {
  return async ({ device, payload }) => {
    const binding = await haBinding(runtime, device, "climate");
    if (!binding) return { outcome: "failed", message: "空调未配置" };
    const body = data(payload);
    if (!body) return { outcome: "failed", message: "空调操作缺少参数" };
    return relayOutcome(await callHomeAssistantService({
      baseUrl: binding.url,
      accessToken: binding.token,
      entityId: binding.entityId,
      domain: "climate",
      service,
      data: body,
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
      const sent = await relay.getByName(config.channel).sendCard({
        accessCode,
        source: operationId,
        ...(payload.awaitLogin === true ? { wait: CARD_LOGIN_WAIT } : {}),
      });
      if (!sent.ok) return { outcome: "failed", message: sent.error ?? "机台未在线" };
      return { outcome: "ok", ...(sent.login ? { result: { login: sent.login } } : {}) };
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
    "climate.on": climateRunner(runtime, "turn_on", () => ({})),
    "climate.off": climateRunner(runtime, "turn_off", () => ({})),
    "climate.set_mode": climateRunner(runtime, "set_hvac_mode", (p) =>
      typeof p.mode === "string" && p.mode ? { hvac_mode: p.mode } : null),
    "climate.set_temperature": climateRunner(runtime, "set_temperature", (p) =>
      typeof p.temperature === "number" && Number.isFinite(p.temperature) ? { temperature: p.temperature } : null),
    "climate.set_fan_mode": climateRunner(runtime, "set_fan_mode", (p) =>
      typeof p.fanMode === "string" && p.fanMode ? { fan_mode: p.fanMode } : null),
    "aime.scan": cardRunner(runtime),
    coin: coinRunner(runtime),
    "door.open": doorRunner(runtime),
  };
  const readers: Record<string, StateReader> = {
    "power.power": (device) => readPower(runtime, device),
    "climate.climate": async (device) => {
      const state = await readClimate(runtime, device);
      return state ? climateSetting(state) : null;
    },
  };
  return createDeviceBus({
    events: createDeviceEventRepository(createD1Executor(runtime.db, runtime.shopId)),
    now: runtime.now ?? (() => new Date()),
    id: runtime.id ?? (() => crypto.randomUUID()),
    runners,
    readers,
  });
}

/**
 * Read a climate device for display and record its setting when it moved,
 * with a single Home Assistant request.
 */
export async function observeClimate(runtime: DeviceRuntime, device: Device): Promise<ClimateState | null> {
  const state = await readClimate(runtime, device).catch(() => null);
  if (!state) return null;
  const bus = createDeviceBus({
    events: createDeviceEventRepository(createD1Executor(runtime.db, runtime.shopId)),
    now: runtime.now ?? (() => new Date()),
    id: runtime.id ?? (() => crypto.randomUUID()),
    runners: {},
    readers: { "climate.climate": async () => climateSetting(state) },
  });
  await bus.observe(device, "climate", "climate").catch(() => null);
  return state;
}
