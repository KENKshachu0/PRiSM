/**
 * A shop bot for the end-to-end run. It is the real plugin: `applyPrismKoishiPlugin` builds the platform
 * connection and the Home Assistant watcher exactly as it does in Koishi. Only Koishi itself is stood in
 * for (it would give the plugin chat commands and `ctx.http.ws`), and the sockets are Bun's.
 *
 *   BOT_NAME=前台 bun run scripts/e2e-ha/bot-sim.ts
 *
 * Reads the shop and its bot token from `.e2e/platform.json`, and runs until it is killed. Run several with
 * different names to have several bots.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyPrismKoishiPlugin } from "../../packages/koishi-plugin/src/index.ts";

process.chdir(resolve(import.meta.dir, "../.."));
const cfg = JSON.parse(readFileSync(".e2e/platform.json", "utf8")) as { origin: string; shop: { publicId: string }; botToken: string };
const name = process.env.BOT_NAME ?? "bot";

const bun = (url: string, headers: Record<string, string>) => new WebSocket(url, { headers } as never) as never;
const koishi = {
  command: () => ({ action() { return this; } }),
  logger: () => ({ warn: (...args: unknown[]) => console.error(`[${name}] warn`, ...args) }),
  on: () => {},
};
applyPrismKoishiPlugin(koishi as never, {
  shopCode: cfg.shop.publicId,
  baseUrl: cfg.origin,
  integrationToken: cfg.botToken,
  botName: name,
  socket: bun,
  haSocket: bun,
  idleReminderMinutes: 0,
  autoRegister: true,
} as never);
console.log(`[${name}] up`);
setInterval(() => {}, 1 << 30);
