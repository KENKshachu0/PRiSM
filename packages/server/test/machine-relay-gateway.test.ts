import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type { D1DatabaseLike, SqlValue } from "@prism/adapter-d1";
import type { Env } from "../src/bindings.js";
import { deviceEventSchema } from "@prism/storage-sql";
import { sha256Hex } from "../src/crypto.js";
import { relayGateway } from "../src/gateway/machine-relay-gateway.js";

class SqliteD1 implements D1DatabaseLike {
  constructor(private readonly sqlite: Database) {}
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...values: SqlValue[]) {
        return {
          async first<T = unknown>() {
            return (db.query(sql).get(...values) as T | null) ?? null;
          },
          async all<T = unknown>() {
            return { results: db.query(sql).all(...values) as T[] };
          },
          async run() {
            const result = db.run(sql, values);
            return { meta: { changes: result.changes } };
          },
        };
      },
    };
  }
  async batch() {
    return [];
  }
}

const RELAY_PATH = "https://prism.test/io/ws";
const TOKEN = "prism_io_test-token-value";

async function fixture(input: {
  relayConnection?: string;
  enabled?: number;
  channel?: string | null;
  tokenHash?: string | null;
} = {}) {
  const sqlite = new Database(":memory:");
  sqlite.run(`CREATE TABLE machines(
    id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
  )`);
  for (const statement of deviceEventSchema) sqlite.run(statement);
  sqlite.run("INSERT INTO machines(id,shop_id,enabled) VALUES (?,?,?)", ["machine-1", "shop-1", input.enabled ?? 1]);
  const channel = input.channel === undefined ? "m_abc" : input.channel;
  sqlite.run(
    `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,credential_hash,created_at,updated_at)
     VALUES ('shop-1','machine-1','hinata_io',?,'{}',?,'2026-01-01','2026-01-01')`,
    [
      JSON.stringify({ transport: input.relayConnection ?? "embedded", coinKey: 32, coinAfterSwipe: false, ...(channel ? { channel } : {}) }),
      input.tokenHash === undefined ? await sha256Hex(TOKEN) : input.tokenHash,
    ],
  );
  const db = new SqliteD1(sqlite);
  const env = { DB: db, MACHINE_RELAY: {} } as unknown as Env;
  return { env, sqlite };
}

function upgrade(url = RELAY_PATH, token: string | null = TOKEN) {
  const headers = new Headers({ Upgrade: "websocket" });
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  return new Request(url, { headers });
}

describe("machine relay gateway", () => {
  it("ignores any path other than the relay endpoint", async () => {
    const { env } = await fixture();
    const result = await relayGateway(new Request("https://prism.test/api/v1/health"), env);
    expect(result.kind).toBe("not-relay");
  });

  it("resolves the channel from a valid token", async () => {
    const { env } = await fixture();
    const result = await relayGateway(upgrade(), env);
    expect(result).toEqual({
      kind: "dispatch",
      channel: "m_abc",
      shopId: "shop-1",
      machineId: "machine-1",
    });
  });

  it("rejects a wrong token", async () => {
    const { env } = await fixture();
    const result = await relayGateway(upgrade(RELAY_PATH, "prism_io_wrong"), env);
    expect(result.kind).toBe("rejected");
    expect((result as { response: Response }).response.status).toBe(401);
  });

  it("rejects a request with no token at all", async () => {
    const { env } = await fixture();
    const result = await relayGateway(upgrade(RELAY_PATH, null), env);
    expect(result.kind).toBe("rejected");
    expect((result as { response: Response }).response.status).toBe(401);
  });

  it("rejects a valid token on a machine that is disabled", async () => {
    const { env } = await fixture({ enabled: 0 });
    const result = await relayGateway(upgrade(), env);
    expect(result.kind).toBe("rejected");
  });

  it("rejects a token on a machine left in external relay mode", async () => {
    // A store that has not opted into embedded mode must not be reachable here.
    const { env } = await fixture({ relayConnection: "external" });
    const result = await relayGateway(upgrade(), env);
    expect(result.kind).toBe("rejected");
  });

  it("rejects an embedded machine that has no channel yet", async () => {
    const { env } = await fixture({ channel: null });
    const result = await relayGateway(upgrade(), env);
    expect(result.kind).toBe("rejected");
  });

  it("requires a websocket upgrade", async () => {
    const { env } = await fixture();
    const result = await relayGateway(
      new Request(RELAY_PATH, { headers: { Authorization: `Bearer ${TOKEN}` } }),
      env,
    );
    expect(result.kind).toBe("rejected");
    expect((result as { response: Response }).response.status).toBe(426);
  });

  it("reports unavailable rather than throwing when the binding is absent", async () => {
    const { env } = await fixture();
    const withoutBinding = { DB: env.DB } as unknown as Env;
    const result = await relayGateway(upgrade(), withoutBinding);
    expect(result.kind).toBe("rejected");
  });
});
