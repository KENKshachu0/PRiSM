/**
 * How many clients watch a shop's Home Assistant at once. A watcher is a shop bot or a HINATA IO that
 * has been handed the read-only token and reports every change; with two, one can leave without a gap.
 *
 * The number is the platform administrator's to set, per shop (one `app_settings` row), and defaults to
 * two. The shop hub keeps its own copy, refreshed when this changes.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";

export const HA_WATCHER_LIMIT_KEY = "devices.ha_watcher_limit";
export const DEFAULT_WATCHERS = 2;
export const MAX_WATCHERS = 4;

export const isWatcherLimit = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_WATCHERS;

export async function readWatcherLimit(db: D1DatabaseLike, shopId: string): Promise<number> {
  const row = await db
    .prepare("SELECT value_json FROM app_settings WHERE shop_id = ? AND key = ?")
    .bind(shopId, HA_WATCHER_LIMIT_KEY)
    .first<{ value_json: string }>();
  try {
    const count = row ? (JSON.parse(row.value_json) as { count?: unknown }).count : undefined;
    return isWatcherLimit(count) ? count : DEFAULT_WATCHERS;
  } catch {
    return DEFAULT_WATCHERS;
  }
}

export async function writeWatcherLimit(db: D1DatabaseLike, shopId: string, count: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_settings(shop_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(shop_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .bind(shopId, HA_WATCHER_LIMIT_KEY, JSON.stringify({ count }), new Date().toISOString())
    .run();
}
