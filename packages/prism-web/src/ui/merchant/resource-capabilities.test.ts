import { describe, expect, it } from "vitest";
import {
  canOperateCoin,
  deviceActionGroups,
  deviceActions,
  resourceCapabilities,
  isDirectConnect,
  isUnconfigured,
} from "./resource-capabilities";
import type { Resource } from "../../api";

const machine = (over: Partial<Resource> = {}): Resource => ({
  id: "m1",
  publicId: "p1",
  shopId: "s1",
  shopPublicId: "shop",
  name: "机台",
  aliases: [],
  enabled: true,
  kind: "machine",
  hasHinata: false,
  hinataUrl: null,
  homeAssistant: null,
  ttlockLockId: null,
  mahjong: null,
  coinKey: 32,
  coinEnabled: true,
  coinAfterSwipe: false,
  relayConnection: "external",
  ...over,
});

describe("device capability view", () => {
  it("treats a climate entity as its own capability with its own action group", () => {
    const ac = machine({
      climate: { url: "https://ha", entityId: "climate.room" },
      actions: [
        { name: "climate.on", capability: "climate" },
        { name: "climate.set_temperature", capability: "climate" },
      ],
    });
    expect(resourceCapabilities(ac)).toMatchObject({ power: false, climate: true });
    expect(isUnconfigured(ac)).toBe(false);
    expect(deviceActionGroups(ac)).toEqual([
      { capability: "climate", actions: ["climate.on", "climate.set_temperature"] },
    ]);
    expect(deviceActionGroups({ ...ac, actions: undefined })[0]!.actions).toContain("climate.set_fan_mode");
  });

  it("derives one capability per bound binding", () => {
    expect(resourceCapabilities(machine())).toEqual({
      power: false,
      climate: false,
      hinata_io: false,
      door: false,
      mahjong: false,
      bot: false,
    });
    expect(
      resourceCapabilities(
        machine({
          homeAssistant: { url: "https://ha", entityId: "switch.a" },
          ttlockLockId: 42,
          mahjong: { capacity: 4, pricingConfigIds: [] },
          relayConnection: "embedded",
        }),
      ),
    ).toEqual({ power: true, climate: false, hinata_io: true, door: true, mahjong: true, bot: false });
  });

  it("treats a direct connection as HINATA IO even without an external URL", () => {
    const direct = machine({ relayConnection: "embedded", hasHinata: false });
    expect(resourceCapabilities(direct).hinata_io).toBe(true);
    expect(isDirectConnect(direct)).toBe(true);
  });

  it("gates coin on a key and, for external relays, a password", () => {
    const external = machine({ hasHinata: true, hasPassword: false, coinKey: 32 });
    expect(canOperateCoin(external)).toBe(false);
    expect(canOperateCoin({ ...external, hasPassword: true })).toBe(true);
    // The key is the switch: no key, no coin.
    expect(canOperateCoin({ ...external, hasPassword: true, coinKey: 0 })).toBe(false);
    // A direct connection authenticates the socket, so no password is needed.
    expect(
      canOperateCoin(
        machine({ relayConnection: "embedded", hasPassword: false, coinKey: 32 }),
      ),
    ).toBe(true);
  });

  it("offers only the actions the bound capabilities support", () => {
    expect(deviceActions(machine())).toEqual([]);
    expect(
      deviceActions(
        machine({
          homeAssistant: { url: "https://ha", entityId: "switch.a" },
          ttlockLockId: 7,
        }),
      ),
    ).toEqual(["power.on", "power.off", "door.open"]);
    // A card can always be sent once the IO binding exists; coin still needs a key.
    expect(
      deviceActions(
        machine({
          hasHinata: true,
          hasPassword: true,
          coinKey: 32,
          coinEnabled: true,
        }),
      ),
    ).toEqual(["aime.scan", "coin"]);
  });

  it("prefers the action list the server derived from the capability catalog", () => {
    const serverDriven = machine({
      actions: [
        { name: "power.on", capability: "power" },
        { name: "aime.scan", capability: "hinata_io" },
        { name: "mahjong.seat", capability: "mahjong" },
      ],
      hasHinata: true,
      hasPassword: true,
      coinKey: 32,
    });
    expect(deviceActions(serverDriven)).toEqual([
      "power.on",
      "aime.scan",
      "mahjong.seat",
    ]);
    expect(deviceActionGroups(serverDriven)).toEqual([
      { capability: "power", actions: ["power.on"] },
      { capability: "hinata_io", actions: ["aime.scan"] },
      { capability: "mahjong", actions: ["mahjong.seat"] },
    ]);
  });

  it("flags a device with no binding as unconfigured", () => {
    expect(isUnconfigured(machine())).toBe(true);
    expect(isUnconfigured(machine({ ttlockLockId: 5 }))).toBe(false);
  });
});
