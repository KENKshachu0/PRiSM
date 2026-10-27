/**
 * A shop bot as a resource.
 *
 * Each integration token belongs to one bot resource, which carries the bot's
 * settings in its `bot` capability. What the bot needs to know about the shop
 * (who is staff, what the currency is called, which tables and door exist) is
 * read from the platform when the bot asks, never configured twice.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import { randomToken } from "../crypto.js";
import { resourceBilledSql } from "./billed-sql.js";
import { capabilities, type BotConfig } from "./capabilities/catalog.js";

export type BotResource = { id: string; name: string; enabled: boolean; config: BotConfig };

const parse = (json: string | null) => capabilities.bot.config.safeParse(JSON.parse(json || "{}"));

/** The bot resource a token belongs to, or null. */
export async function findBotByToken(db: D1DatabaseLike, shopId: string, tokenId: string): Promise<BotResource | null> {
  const row = await db
    .prepare(
      `SELECT m.id, m.name, m.enabled, c.config_json FROM device_capabilities c
       JOIN machines m ON m.shop_id = c.shop_id AND m.id = c.device_id
       WHERE c.shop_id = ? AND c.capability = 'bot' AND json_extract(c.config_json, '$.tokenId') = ?`,
    )
    .bind(shopId, tokenId)
    .first<{ id: string; name: string; enabled: number; config_json: string }>();
  if (!row) return null;
  const config = parse(row.config_json);
  return config.success ? { id: row.id, name: row.name, enabled: row.enabled === 1, config: config.data } : null;
}

/**
 * The bot resource of a token. A credential issued before bots were resources
 * gets one the first time it connects, so every connected bot shows up on the
 * resources page. Rotation never comes here: it keeps the resource it rotates.
 */
export async function ensureBotResource(
  db: D1DatabaseLike,
  shopId: string,
  token: { id: string; label: string },
): Promise<BotResource> {
  const existing = await findBotByToken(db, shopId, token.id);
  if (existing) return existing;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const config = capabilities.bot.config.parse({ tokenId: token.id });
  await db.batch([
    db.prepare(
      `INSERT INTO machines(id, public_id, shop_id, name, enabled, kind, aliases_json, hinata_url_encrypted)
       VALUES (?, ?, ?, ?, 1, 'machine', '[]', '')`,
    ).bind(id, randomToken(12), shopId, token.label || "Bot"),
    db.prepare(
      `INSERT INTO device_capabilities(shop_id, device_id, capability, config_json, secret_json, created_at, updated_at)
       VALUES (?, ?, 'bot', ?, '{}', ?, ?)`,
    ).bind(shopId, id, JSON.stringify(config), now, now),
  ]);
  return { id, name: token.label || "Bot", enabled: true, config };
}

/** Everything a bot is told: its settings plus what the platform knows. */
export async function botConfigView(db: D1DatabaseLike, shopId: string, bot: BotResource) {
  const [staff, currency, tables, doors, own] = await Promise.all([
    // Staff are whoever works at the shop and bound a platform identity there.
    db.prepare(
      `SELECT DISTINCT b.provider, b.subject FROM shop_platform_bindings b
       WHERE b.shop_id = ? AND (
         b.user_id IN (SELECT user_id FROM shop_members WHERE shop_id = ?)
         OR b.user_id IN (
           SELECT a.user_id FROM shop_staff_accounts a
           JOIN staff_users s ON s.shop_id = a.shop_id AND s.id = a.staff_id
           WHERE a.shop_id = ? AND s.status = 'active'))
       ORDER BY b.provider, b.subject`,
    ).bind(shopId, shopId, shopId).all<{ provider: string; subject: string }>(),
    db.prepare(
      `SELECT name FROM asset_definitions WHERE shop_id = ? AND type = 'currency' AND status = 'active'
       ORDER BY CASE WHEN code IN ('paid', 'currency.paid') THEN 0 ELSE 1 END, code LIMIT 1`,
    ).bind(shopId).first<{ name: string }>(),
    db.prepare(
      `SELECT m.id, m.name, m.aliases_json, m.capacity
       FROM device_capabilities c JOIN machines m ON m.shop_id = c.shop_id AND m.id = c.device_id
       WHERE c.shop_id = ? AND c.capability = 'mahjong' AND m.enabled = 1 ORDER BY m.name`,
    ).bind(shopId).all<{ id: string; name: string; aliases_json: string; capacity: number }>(),
    db.prepare(
      `SELECT m.id, m.name FROM device_capabilities c JOIN machines m ON m.shop_id = c.shop_id AND m.id = c.device_id
       WHERE c.shop_id = ? AND c.capability = 'door' AND m.enabled = 1 ORDER BY m.name`,
    ).bind(shopId).all<{ id: string; name: string }>(),
    db.prepare(
      `SELECT ${resourceBilledSql("m")} AS billed FROM machines m WHERE m.shop_id = ? AND m.id = ?`,
    ).bind(shopId, bot.id).first<{ billed: number }>(),
  ]);
  const { tokenId: _token, doorResourceId, ...settings } = bot.config;
  // The chosen door, or the only door the shop has.
  const door = doors.results.find((row) => row.id === doorResourceId) ?? (doors.results.length === 1 ? doors.results[0] : null);
  return {
    bot: { id: bot.id, name: bot.name },
    settings,
    // Whether entering through this bot bills: its own plan, otherwise its
    // resource group's. It keeps the old shop-wide switch's name so released
    // plugins still read it; the shop itself no longer has one.
    billingEnabled: !!own?.billed,
    currencyName: currency?.name ?? "余额",
    staff: staff.results,
    door: door ? { id: door.id, name: door.name } : null,
    mahjongTables: tables.results.map((row) => ({
      id: row.id,
      name: row.name,
      aliases: (() => { try { return JSON.parse(row.aliases_json) as string[]; } catch { return []; } })(),
      capacity: Number(row.capacity) || 4,
    })),
  };
}
