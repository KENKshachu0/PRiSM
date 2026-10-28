import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";

const migrations = resolve(import.meta.dir, "../../../migrations");
const run = (sqlite: Database, name: string) => {
  for (const sql of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) sqlite.run(sql);
};

describe("migration 0046: a bot has one announcement channel list", () => {
  it("merges the idle and event lists and keeps the idle warning on for bots that had one", () => {
    const sqlite = new Database(":memory:");
    sqlite.run("PRAGMA foreign_keys=OFF");
    const now = new Date().toISOString();
    sqlite.run(`
      CREATE TABLE device_capabilities(
        shop_id TEXT NOT NULL, device_id TEXT NOT NULL, capability TEXT NOT NULL,
        config_json TEXT NOT NULL, secret_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (shop_id, device_id, capability))`);

    const bots: Record<string, string> = {
      // Both lists: they merge, and the idle warning stays on.
      both: JSON.stringify({
        tokenId: "t1", idleChannelIds: ["onebot:1", "onebot:2"], idleReminderMinutes: 5,
        eventChannelIds: ["onebot:2", "onebot:3"], announcePower: true,
      }),
      // Only a lead of 0 meant the store never wanted the warning.
      silent: JSON.stringify({ tokenId: "t2", idleChannelIds: ["onebot:4"], idleReminderMinutes: 0 }),
      // No idle list at all, only shop news.
      news: JSON.stringify({ tokenId: "t3", eventChannelIds: ["onebot:5"], announceStarts: true }),
      // Nothing configured yet.
      fresh: JSON.stringify({ tokenId: "t4" }),
    };
    for (const [id, config] of Object.entries(bots))
      sqlite.run("INSERT INTO device_capabilities VALUES ('shop', ?, 'bot', ?, '{}', ?, ?)", [id, config, now, now]);
    // Devices with the same field names are left alone.
    sqlite.run("INSERT INTO device_capabilities VALUES ('shop', 'm1', 'power', ?, '{}', ?, ?)",
      [JSON.stringify({ idleChannelIds: ["not-a-channel-list"] }), now, now]);

    run(sqlite, readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort().find((file) => file.startsWith("0046"))!);

    const configs = Object.fromEntries(
      sqlite.query("SELECT device_id AS id, config_json AS json FROM device_capabilities WHERE capability='bot'").all()
        .map((row) => [(row as { id: string }).id, JSON.parse((row as { json: string }).json)]),
    );
    expect(configs.both).toEqual({
      tokenId: "t1", idleReminderMinutes: 5, announcePower: true,
      announceChannelIds: ["onebot:1", "onebot:2", "onebot:3"], announceIdle: true,
    });
    expect(configs.silent).toEqual({
      tokenId: "t2", idleReminderMinutes: 0, announceChannelIds: ["onebot:4"], announceIdle: false,
    });
    expect(configs.news).toEqual({
      tokenId: "t3", announceStarts: true, announceChannelIds: ["onebot:5"], announceIdle: false,
    });
    expect(configs.fresh).toEqual({ tokenId: "t4", announceChannelIds: [], announceIdle: false });

    const untouched = sqlite.query("SELECT config_json AS json FROM device_capabilities WHERE device_id='m1'").get() as { json: string };
    expect(JSON.parse(untouched.json)).toEqual({ idleChannelIds: ["not-a-channel-list"] });
  });
});
