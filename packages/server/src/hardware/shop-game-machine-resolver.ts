import type { D1DatabaseLike } from "@prism/adapter-d1";
import type { DeviceActionServiceDependencies, HinataIoDeviceConfig } from "@prism/application";
import { PrismDomainError } from "@prism/core";
import { decryptSecret } from "../crypto.js";
import { createHinataExecutor, normalizeHinataUrl } from "./hinata.js";

type Machine = {
  id: string;
  public_id: string;
  name: string;
  enabled: number;
  aliases_json: string | null;
  hinata_url_encrypted: string | null;
  hinata_password_encrypted: string | null;
  coin_key: number;
};

function refs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function readAliases(value: string | null): string[] {
  try { return refs(JSON.parse(value ?? "[]")); }
  catch { return []; }
}

function matches(ref: string, device: { id: string; name: string; aliases?: string[] }, publicId?: string): boolean {
  return [device.id, publicId, device.name, ...(device.aliases ?? [])].some(
    value => typeof value === "string" && value.trim().toLowerCase() === ref,
  );
}

/** Shop-scoped Bot coin/Aime target resolution. Never take relay URL/password from Bot payloads. */
export function createShopGameMachineResolver(input: {
  db: D1DatabaseLike;
  shopId: string;
  encryptionKey?: string;
  fetcher?: typeof fetch;
}): NonNullable<DeviceActionServiceDependencies["resolveGameMachineTarget"]> {
  return async (deviceRef) => {
    const ref = deviceRef.trim().toLowerCase();
    if (!ref) throw new PrismDomainError("Device reference is required.", "DEVICE_REFERENCE_REQUIRED");
    const machines = (await input.db.prepare(
      "SELECT id, public_id, name, enabled, aliases_json, hinata_url_encrypted, hinata_password_encrypted, coin_key FROM machines WHERE shop_id = ?",
    ).bind(input.shopId).all<Machine>()).results;
    const selected = machines.filter(machine => matches(
      ref, { id: machine.id, name: machine.name, aliases: readAliases(machine.aliases_json) }, machine.public_id,
    ));
    if (selected.length > 1) throw new PrismDomainError("Device reference is ambiguous.", "DEVICE_REFERENCE_AMBIGUOUS");
    if (selected.length) {
      const machine = selected[0]!;
      if (!machine.enabled) throw new PrismDomainError("Device is disabled.", "DEVICE_DISABLED");
      if (!machine.hinata_url_encrypted || !machine.hinata_password_encrypted) {
        throw new PrismDomainError("Hinata IO is not configured for this machine.", "DEVICE_CONFIGURATION_REQUIRED");
      }
      if (!input.encryptionKey) {
        throw new PrismDomainError("Device encryption key is not configured.", "DEVICE_ENCRYPTION_UNAVAILABLE");
      }
      let url: string;
      let password: string;
      try {
        [url, password] = await Promise.all([
          decryptSecret(machine.hinata_url_encrypted, input.encryptionKey),
          decryptSecret(machine.hinata_password_encrypted, input.encryptionKey),
        ]);
        if (!url || !password || !/^https?:\/\//.test(normalizeHinataUrl(url))) throw new Error("Invalid device binding");
      } catch {
        throw new PrismDomainError("Device connection could not be decrypted.", "DEVICE_CONFIGURATION_REQUIRED");
      }
      const config: HinataIoDeviceConfig = {
        id: machine.id, name: machine.name, aliases: [], url: normalizeHinataUrl(url),
        password, salt: "", coinKey: machine.coin_key, cardType: "aime",
      };
      return {
        target: { kind: "game_machine" as const, id: machine.id, executorKind: "hinata_io" as const },
        deviceLabel: machine.name,
        executor: createHinataExecutor({ devices: [config], fetch: input.fetcher }),
      };
    }

    // Pre-migration machines could still be kept in per-shop settings.
    const setting = await input.db.prepare(
      "SELECT value_json FROM app_settings WHERE shop_id = ? AND key = 'devices.hinata_io'",
    ).bind(input.shopId).first<{ value_json: string }>();
    let legacy: unknown;
    try { legacy = JSON.parse(setting?.value_json ?? "[]"); } catch { legacy = []; }
    const devices = Array.isArray(legacy) ? legacy.filter((item): item is HinataIoDeviceConfig =>
      !!item && typeof item.id === "string" && typeof item.name === "string" &&
      typeof item.url === "string" && typeof item.password === "string" &&
      typeof item.coinKey === "number" && typeof item.cardType === "string") : [];
    const found = devices.filter(item => matches(ref, { ...item, aliases: refs(item.aliases) }));
    if (found.length > 1) throw new PrismDomainError("Device reference is ambiguous.", "DEVICE_REFERENCE_AMBIGUOUS");
    if (!found.length) throw new PrismDomainError("Game machine was not found.", "DEVICE_NOT_FOUND");
    if (!found[0]!.password || !/^https?:\/\//.test(normalizeHinataUrl(found[0]!.url))) {
      throw new PrismDomainError("Hinata IO configuration is incomplete.", "DEVICE_CONFIGURATION_REQUIRED");
    }
    return {
      target: { kind: "game_machine" as const, id: found[0]!.id, executorKind: "hinata_io" as const },
      deviceLabel: found[0]!.name,
      executor: createHinataExecutor({ devices: [found[0]!], fetch: input.fetcher }),
    };
  };
}
