import type { D1DatabaseLike } from "@prism/adapter-d1";
import type { DeviceActionExecutor, DeviceActionServiceDependencies } from "@prism/application";
import { PrismDomainError } from "@prism/core";
import { decryptSecret } from "../crypto.js";
import { createHomeAssistantExecutor } from "./home-assistant.js";

type MachineRow = {
  id: string;
  public_id: string;
  name: string;
  enabled: number;
  aliases_json: string | null;
  ha_binding_encrypted: string | null;
};
type HaBinding = { url: string; token: string; entityId: string };
type Target = { id: string; label: string; binding: HaBinding };

function matches(ref: string, ...values: string[]): boolean {
  return values.some(value => value.trim().toLowerCase() === ref);
}

function aliases(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseJson(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

function validBinding(value: unknown): value is HaBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<HaBinding>;
  return typeof binding.url === "string" &&
    /^https?:\/\//i.test(binding.url) &&
    typeof binding.token === "string" && !!binding.token.trim() &&
    typeof binding.entityId === "string" && /^(switch|input_boolean)\.[a-z0-9_]+$/.test(binding.entityId);
}

function executorFor(targets: Target[], fetcher: typeof fetch): DeviceActionExecutor {
  return {
    async execute({ command }) {
      const failures: string[] = [];
      for (const item of targets) {
        try {
          const executor = createHomeAssistantExecutor({
            baseUrl: item.binding.url,
            accessToken: item.binding.token,
            fetch: (url, init) => fetcher(url, { ...init, signal: AbortSignal.timeout(10_000) }),
          });
          const result = await executor.execute({
            command: { ...command, deviceId: item.binding.entityId },
          });
          if (result.status !== "success") failures.push(item.label);
        } catch {
          // Network errors must produce an expired audit record, never an unhandled 500.
          failures.push(item.label);
        }
      }
      return failures.length
        ? { status: "failed", message: `Home Assistant 操作失败：${failures.join("、")}` }
        : { status: "success" };
    },
  };
}

/**
 * Resolve Bot facility references against the current shop's merchant machines,
 * then legacy Home Assistant settings. Never accept arbitrary HA entity IDs or
 * cross-shop machine IDs as an executable target.
 */
export function createShopFacilityResolver(input: {
  db: D1DatabaseLike;
  shopId: string;
  encryptionKey?: string;
  fetcher?: typeof fetch;
}): NonNullable<DeviceActionServiceDependencies["resolveFacilityTarget"]> {
  return async (deviceRef, actionType) => {
    if (actionType !== "power.on" && actionType !== "power.off") {
      throw new PrismDomainError("Unsupported facility action.", "FACILITY_ACTION_UNSUPPORTED");
    }
    const ref = deviceRef.trim().toLowerCase();
    if (!ref) throw new PrismDomainError("Device reference is required.", "DEVICE_REFERENCE_REQUIRED");

    const rows = await input.db.prepare(
      "SELECT id, public_id, name, enabled, aliases_json, ha_binding_encrypted FROM machines WHERE shop_id = ?",
    ).bind(input.shopId).all<MachineRow>();
    const machines = rows.results;
    const matched = ref === "all" ? machines.filter(machine => !!machine.enabled && !!machine.ha_binding_encrypted)
      : machines.filter(machine => matches(ref, machine.id, machine.public_id, machine.name, ...aliases(machine.aliases_json)));
    if (ref !== "all" && matched.length > 1) {
      throw new PrismDomainError("Device name is ambiguous.", "DEVICE_REFERENCE_AMBIGUOUS");
    }
    if (ref !== "all" && matched.length && !matched[0]!.enabled) {
      throw new PrismDomainError("Device is disabled.", "DEVICE_DISABLED");
    }
    if (ref !== "all" && matched.length && !matched[0]!.ha_binding_encrypted) {
      throw new PrismDomainError("Device has no Home Assistant power binding.", "DEVICE_ACTION_UNSUPPORTED");
    }

    const targets: Target[] = [];
    for (const machine of matched) {
      if (!machine.ha_binding_encrypted) continue;
      if (!input.encryptionKey) {
        throw new PrismDomainError("Device encryption key is not configured.", "DEVICE_ENCRYPTION_UNAVAILABLE");
      }
      let binding: unknown;
      try {
        binding = JSON.parse(await decryptSecret(machine.ha_binding_encrypted, input.encryptionKey));
      } catch {
        throw new PrismDomainError("Device power binding cannot be decrypted.", "DEVICE_CONFIGURATION_REQUIRED");
      }
      if (!validBinding(binding)) {
        throw new PrismDomainError("Device power binding is incomplete.", "DEVICE_CONFIGURATION_REQUIRED");
      }
      targets.push({ id: machine.id, label: machine.name, binding });
    }

    // Older standalone deployments store HA devices as app_settings rather
    // than machine bindings. Preserve Bot aliases from those installations.
    if (ref === "all" || matched.length === 0) {
      const settings = await input.db.prepare(
        "SELECT key, value_json FROM app_settings WHERE shop_id = ? AND key IN ('devices.homeassistant', 'devices.homeassistant_connection')",
      ).bind(input.shopId).all<{ key: string; value_json: string }>();
      const byKey = new Map(settings.results.map(row => [row.key, parseJson(row.value_json)]));
      const devices = byKey.get("devices.homeassistant");
      const connection = byKey.get("devices.homeassistant_connection");
      const conn = connection && typeof connection === "object" ? connection as { url?: unknown; token?: unknown } : null;
      const allDevices = Array.isArray(devices) ? devices : [];
      const legacy = allDevices.filter((item): item is { id: string; name: string; alias?: string[] } =>
        !!item && typeof item.id === "string" && typeof item.name === "string")
        .filter(item => ref === "all" || matches(ref, item.id, item.name, ...(Array.isArray(item.alias) ? item.alias : [])));
      if (ref !== "all" && legacy.length > 1) {
        throw new PrismDomainError("Device name is ambiguous.", "DEVICE_REFERENCE_AMBIGUOUS");
      }
      for (const item of legacy) {
        const binding = { url: conn?.url, token: conn?.token, entityId: item.id };
        if (!validBinding(binding)) {
          throw new PrismDomainError("Home Assistant is not configured.", "DEVICE_CONFIGURATION_REQUIRED");
        }
        // An imported machine can expose the same HA entity as legacy settings.
        if (targets.some(target => target.binding.url === binding.url && target.binding.entityId === item.id)) continue;
        targets.push({ id: item.id, label: item.name, binding });
      }
    }

    if (targets.length === 0) {
      throw new PrismDomainError("Device was not found.", "DEVICE_NOT_FOUND");
    }
    if (ref !== "all" && targets.length !== 1) {
      throw new PrismDomainError("Device name is ambiguous.", "DEVICE_REFERENCE_AMBIGUOUS");
    }
    const target = ref === "all"
      ? { kind: "facility" as const, all: true as const }
      : { kind: "facility" as const, id: targets[0]!.id };
    return {
      target,
      deviceLabel: ref === "all" ? "全部设备" : targets[0]!.label,
      executor: executorFor(targets, input.fetcher ?? fetch),
    };
  };
}
