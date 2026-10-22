/**
 * Seed the end-to-end platform: an owner, a player and a platform administrator (a session row each), a
 * shop with the token its bot connects with, and three devices made through the platform's own API.
 *
 *   机台A  embedded IO, power switch.decorative_lights and air conditioner climate.hvac on the shop's
 *          Home Assistant (an administrator token, so the platform can make it a read-only account)
 *   机台B  embedded IO, power switch.ac on the same Home Assistant
 *   休息室  no IO, power input_boolean.lounge_power (nobody else uses it) and air conditioner
 *          climate.heatpump on the same Home Assistant but with a token that is not an administrator's:
 *          no read-only account can be made, so nothing ever watches it
 *
 * Writes `.e2e/platform.json` and the two IO config files `.e2e/io/a.ini` and `b.ini`.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { haLogin, haStaffToken } from "./ha-client.ts";

const origin = process.env.PLATFORM_ORIGIN ?? "http://127.0.0.1:8787";
const ha = JSON.parse(await Bun.file(".e2e/ha.json").text()) as { url: string; adminToken: string; username: string; password: string };
const run = randomBytes(3).toString("hex");
const hash = (token: string) => createHash("sha256").update(token).digest("base64url");

// Users and their sessions are the one thing the platform makes through a browser sign-in. The platform
// administrator is the only one who may change a shop's number of Home Assistant watchers.
const users = [
  { id: `e2e-owner-${run}`, role: "user", token: `owner-${randomBytes(16).toString("hex")}` },
  { id: `e2e-player-${run}`, role: "user", token: `player-${randomBytes(16).toString("hex")}` },
  { id: `e2e-admin-${run}`, role: "admin", token: `admin-${randomBytes(16).toString("hex")}` },
];
const now = new Date().toISOString();
const expires = new Date(Date.now() + 7 * 86_400_000).toISOString();
const d1 = (sql: string) => {
  const result = Bun.spawnSync(
    ["bunx", "wrangler", "d1", "execute", "DB", "--local", "--config", "wrangler.jsonc", "--persist-to", ".e2e/state", "--command", sql],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(`seeding failed: ${result.stderr.toString()}`);
};
d1(users.flatMap((user) => [
  `INSERT INTO users(id,role,created_at,updated_at) VALUES ('${user.id}','${user.role}','${now}','${now}');`,
  `INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ('s-${user.id}','${user.id}','${hash(user.token)}','${expires}');`,
]).join(" "));
const [owner, player, admin] = users as [(typeof users)[number], (typeof users)[number], (typeof users)[number]];

async function api<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${init.token ?? owner.token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} ${response.status}: ${text}`);
  return (JSON.parse(text) as { data: T }).data;
}

const shopResult = await api<{ shop: { id: string; publicId: string } }>("/api/v1/merchant/shops", {
  method: "POST",
  body: { name: "E2E 测试店", latitude: 35.68, longitude: 139.76, radiusMeters: 80 },
});
const shop = shopResult.shop;
console.log(`shop ${shop.publicId} (${shop.id})`);

// The token a shop bot connects with, which the platform stores only as a hash.
const botToken = `prism_integration_${randomBytes(24).toString("hex")}`;
d1(
  `INSERT INTO api_tokens(shop_id,id,label,role,token_prefix,token_hash,status,created_at) VALUES ('${shop.id}','e2e-bot-${run}','Bot','integration','prism_integration','${createHash("sha256").update(botToken).digest("hex")}','active','${now}');`,
);

const staffToken = await haStaffToken(ha.url, await haLogin(ha.url, ha.username, ha.password), `staff${run}`, `staff-${run}-pw`);

type Made = { machine: { id: string; publicId: string; relayUrl?: string | null }; relayToken?: string };
const make = (body: Record<string, unknown>) => api<Made>("/api/v1/merchant/machines", { method: "POST", body: { shopId: shop.id, ...body } });
const control = { url: ha.url, token: ha.adminToken };
const a = await make({
  name: "机台A", relayConnection: "embedded", rotateRelayToken: true,
  homeAssistant: { ...control, entityId: "switch.decorative_lights" }, climate: { url: ha.url, entityId: "climate.hvac" },
});
const b = await make({
  name: "机台B", relayConnection: "embedded", rotateRelayToken: true,
  homeAssistant: { url: ha.url, entityId: "switch.ac" },
});
const lounge = await make({
  name: "休息室",
  homeAssistant: { url: ha.url, token: staffToken, entityId: "input_boolean.lounge_power" },
  climate: { url: ha.url, token: staffToken, entityId: "climate.heatpump" },
});

// The platform makes the read-only account in the background, on the real Home Assistant.
type Connection = { id: string; url: string; readAccess: string | null; readError?: string | null };
let connections: Connection[] = [];
for (let attempt = 0; attempt < 60; attempt += 1) {
  connections = (await api<{ connections: Connection[] }>(`/api/v1/merchant/ha-connections?shopId=${shop.id}`)).connections;
  if (connections.length >= 2 && connections.every((connection) => connection.readAccess)) break;
  await Bun.sleep(1000);
}
console.log("connections:", connections.map((connection) => `${connection.id}=${connection.readAccess}${connection.readError ? ` (${connection.readError})` : ""}`).join(", "));

await writeFile(".e2e/platform.json", JSON.stringify({
  origin,
  shop,
  owner,
  player,
  admin,
  botToken,
  ha,
  staffToken,
  devices: {
    a: { id: a.machine.id, publicId: a.machine.publicId, relayUrl: a.machine.relayUrl, relayToken: a.relayToken },
    b: { id: b.machine.id, publicId: b.machine.publicId, relayUrl: b.machine.relayUrl, relayToken: b.relayToken },
    lounge: { id: lounge.machine.id, publicId: lounge.machine.publicId },
  },
  connections,
}, null, 2));

// One config file per IO process, as the real client reads it (`SEGATOOLS_CONFIG_PATH`).
await mkdir(".e2e/io", { recursive: true });
for (const [name, device] of [["a", a], ["b", b]] as const) {
  await writeFile(`.e2e/io/${name}.ini`, `[aimeio]\nserverUrl=${device.machine.relayUrl}\ndeviceToken=${device.relayToken}\n`);
}
console.log("seeded; wrote .e2e/platform.json and .e2e/io/{a,b}.ini");
