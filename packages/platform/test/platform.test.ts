import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { sqliteSchema } from "@prism/storage-sql";
import app from "../src/index";
import { addLocalDays, parseLocalDateTime } from "@prism/core";
import { encryptSecret, sha256 } from "../src/crypto";
import { decryptE2EE } from "../src/e2ee";
import { sendHinataCoin } from "../src/hinata";
import type { Env } from "../src/types";

const mf = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('test'); } }",
  d1Databases: ["DB"],
  kvNamespaces: ["RATE_LIMIT"],
  compatibilityDate: "2026-06-01",
});
let env: Env;
const cookie = "arcadelink_session=test-session";
const origin = "https://prism.test";
const request = (path: string, body?: unknown, token?: string) =>
  app.fetch(
    new Request(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie,
        origin,
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );

async function entryBody() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO machines(id,public_id,shop_id,name,hinata_url_encrypted,enabled) VALUES ('entry-device','entry-device','a','Entry','','1')",
  ).run();
  const result = (await (
    await request("/api/v1/machines/session/start", {
      shopCode: "a",
      publicId: "entry-device",
    })
  ).json()) as { data: { ticket: string } };
  return {
    ticket: result.data.ticket,
    consent: true,
    operationId: crypto.randomUUID(),
  };
}

beforeAll(async () => {
  const db = await mf.getD1Database("DB");
  const kv = await mf.getKVNamespace("RATE_LIMIT");
  // Miniflare exposes the same D1/KV wire methods as the Worker bindings.
  env = {
    DB: db,
    RATE_LIMIT: kv,
    APP_ORIGIN: origin,
    SESSION_SECRET: "test-only",
    URL_ENCRYPTION_KEY: "test-only",
    MUNET_CLIENT_ID: "",
    MUNET_CLIENT_SECRET: "",
    APPLE_TEAM_ID: "TEST",
  } as Env;
  const statements = [
    ...sqliteSchema,
    ...readFileSync(
      new URL(
        "../../../migrations/0017_platform_accounts.sql",
        import.meta.url,
      ),
      "utf8",
    )
      .split(";")
      .filter((s) => s.trim()),
  ];
  statements.push(
    ...readFileSync(
      new URL("../../../migrations/0018_unified_devices.sql", import.meta.url),
      "utf8",
    )
      .split(";")
      .filter((s) => s.trim()),
  );
  for (const sql of statements) await db.prepare(sql).run();
  for (const sql of readFileSync(
    new URL("../../../migrations/0019_ticket_coin.sql", import.meta.url),
    "utf8",
  )
    .split(";")
    .filter((s) => s.trim()))
    await db.prepare(sql).run();

  for (const sql of readFileSync(new URL("../../../migrations/0020_mahjong_devices.sql", import.meta.url), "utf8").split(";").filter(s=>s.trim())) await db.prepare(sql).run();
  for (const sql of readFileSync(new URL("../../../migrations/0021_machine_aliases.sql", import.meta.url), "utf8").split(";").filter(s=>s.trim())) await db.prepare(sql).run();
  await db.prepare("INSERT INTO users(id,role) VALUES ('u','user')").run();
  await db
    .prepare(
      "INSERT INTO auth_identities(id,user_id,provider,provider_subject,username,display_name) VALUES ('identity','u','munet','u','test','Test')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ('session','u',?,'2999-01-01T00:00:00Z')",
    )
    .bind(await sha256("test-session"))
    .run();
  for (const code of ["a", "b", "card"]) {
    await db
      .prepare(
        "INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES (?,?,?,35,139,80,'u')",
      )
      .bind(code, code, code)
      .run();
    await db
      .prepare(
        "INSERT INTO shop_billing_settings(shop_id,billing_enabled,checkin_geo) VALUES (?,?,?)",
      )
      .bind(code, code === "card" ? 0 : 1, code === "a" ? 1 : 0)
      .run();
    await db
      .prepare(
        "INSERT INTO api_tokens(shop_id,id,label,role,token_prefix,token_hash,status,created_at) VALUES (?,'bot','Bot','integration','test',?,'active','2026-01-01')",
      )
      .bind(code, createHash("sha256").update(`${code}-bot`).digest("hex"))
      .run();
    await db
      .prepare(
        "INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?,'p','Player','active','2026-01-01')",
      )
      .bind(code)
      .run();
    await db
      .prepare(
        "INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) VALUES (?,'p','qq','123456','2026-01-01')",
      )
      .bind(code)
      .run();
  }
}, 30000);
afterAll(async () => {
  await mf.dispose();
});

test("global v1 auth and public shop responses use the shared envelope", async () => {
  expect(await (await request("/api/v1/me")).json()).toMatchObject({
    data: { user: { id: "u" } },
  });
  const shop = await (await request("/api/v1/shops/card")).json();
  expect(shop).toMatchObject({
    data: {
      entryPricing: [],
      shop: {
        billingEnabled: false,
        machineGeo: false,
        timeZone: "Asia/Shanghai",
      },
    },
  });
  const legacy = await request("/api/me");
  expect(legacy.headers.get("deprecation")).toBe("true");
  expect(await legacy.json()).toMatchObject({ user: { id: "u" } });
});

test("QQ codes are shop-bound, single-use and grant no membership in another shop", async () => {
  const generated = (await (
    await request("/api/v1/shops/a/qq-binding", {})
  ).json()) as { data: { code: string } };
  const wrong = await request(
    "/api/v1/shops/a/integration/qq-binding/confirm",
    { code: generated.data.code, qq: "123456" },
    "b-bot",
  );
  expect(wrong.status).toBe(403);
  const confirmed = await request(
    "/api/v1/shops/a/integration/qq-binding/confirm",
    { code: generated.data.code, qq: "123456" },
    "a-bot",
  );
  expect(confirmed.status).toBe(200);
  expect(
    (
      await request(
        "/api/v1/shops/a/integration/qq-binding/confirm",
        { code: generated.data.code, qq: "123456" },
        "a-bot",
      )
    ).status,
  ).toBe(410);
  expect((await request("/api/v1/shops/b/player/me")).status).toBe(403);
  expect((await request("/api/v1/shops/a/player/me")).status).toBe(200);
});

test("location remains required for Web while authenticated shop integrations can enter and checkout", async () => {
  const response = await request("/api/v1/shops/a/player/session/start", await entryBody());
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: "LOCATION_REQUIRED" } });
  await env.DB.prepare("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('a','geo-bot','Bot test','active','2026-01-01')").run();
  await env.DB.prepare("INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) VALUES ('a','geo-bot','qq','990001','2026-01-01')").run();
  const base = "/api/v1/shops/a/integration/players/by-identity";
  const body = { identity: { provider: "qq", subject: "990001" } };
  for (const token of [undefined, "invalid", "b-bot"]) {
    expect((await request(base + "/session/start", body, token)).status).toBe(403);
  }
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n")).toBe(0);
  expect((await request(base + "/session/start", body, "a-bot")).status).toBe(200);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL").first("n")).toBe(1);
  const deviceBody = { ...body, target: { kind: "facility", ref: "unknown-device" }, action: { type: "power.on" } };
  expect((await request(base + "/device-actions", deviceBody, "b-bot")).status).toBe(403);
  const device = await request(base + "/device-actions", deviceBody, "a-bot");
  expect(device.status).toBe(400);
  expect(await device.json()).toMatchObject({ error: { code: "DEVICE_NOT_FOUND" } });
  expect((await request(base + "/checkout/confirm", body, "a-bot")).status).toBe(200);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL").first("n")).toBe(0);
});

test("public identity strings cannot mint a player session", async () => {
  const result = await request("/api/v1/player-auth/login/by-identity", {
    identity: { provider: "qq", subject: "123456" },
  });
  expect(result.status).toBe(404);
});

test("owner can configure billing while a viewer and a removed member cannot mutate it", async () => {
  await env.DB.prepare(
    "INSERT INTO shop_members(id,shop_id,user_id,role) VALUES ('owner-a','a','u','owner')",
  ).run();
  expect((await request("/api/v1/shops/a/staff/me")).status).toBe(200);
  const created = await request("/api/v1/shops/a/staff/pricing-configs", {
    kind: "charge.fixed",
    name: "Entry",
    enabled: true,
    provider: { id: "entry-rule", label: "Entry", amount: 12 },
  });
  expect(created.status).toBe(200);
  const {
    data: { pricingConfig },
  } = (await created.json()) as { data: { pricingConfig: { id: string } } };
  await env.DB.prepare(
    "UPDATE shop_billing_settings SET entry_pricing_ids_json=?,checkin_geo=0 WHERE shop_id='a'",
  )
    .bind(JSON.stringify([pricingConfig.id]))
    .run();
  await env.DB.prepare(
    "UPDATE staff_users SET role='viewer' WHERE shop_id='a' AND id='account:u'",
  ).run();
  expect(
    (
      await request("/api/v1/shops/a/staff/device-actions", {
        type: "power.on",
        target: { kind: "facility", ref: "any" },
      })
    ).status,
  ).toBe(403);
  expect((await request("/api/v1/shops/a/staff/settings")).status).toBe(403);
  expect((await request("/api/v1/shops/a/staff/players")).status).toBe(200);
  await env.DB.prepare("DELETE FROM shop_members WHERE id='owner-a'").run();
  expect((await request("/api/v1/shops/a/staff/players")).status).toBe(403);
});

test("Web and Bot entry share one session; insufficient balance keeps timing; operation IDs replay results", async () => {
  expect(
    (await request("/api/v1/shops/a/player/session/start", await entryBody()))
      .status,
  ).toBe(200);
  expect(
    (
      await request(
        "/api/v1/shops/a/integration/players/by-identity/session/start",
        { identity: { provider: "qq", subject: "123456" } },
        "a-bot",
      )
    ).status,
  ).toBe(200);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE shop_id='a' AND player_id='p'",
    ).first("n"),
  ).toBe(1);
  const operationId = crypto.randomUUID();
  const denied = await request("/api/v1/shops/a/player/checkout/confirm", {
    operationId,
  });
  expect(denied.status).toBe(409);
  const deniedBody = await denied.json();
  expect(
    (await request("/api/v1/shops/a/player/checkout/confirm", { operationId }))
      .status,
  ).toBe(409);
  expect(
    await (
      await request("/api/v1/shops/a/player/checkout/confirm", { operationId })
    ).json(),
  ).toEqual(deniedBody);
  expect(
    await env.DB.prepare(
      "SELECT status FROM sessions WHERE shop_id='a' AND player_id='p'",
    ).first("status"),
  ).toBe("active");
  expect(
    (
      await request("/api/v1/shops/a/player/redeem", {
        operationId,
        code: "anything",
      })
    ).status,
  ).toBe(409);
  expect(
    (await request(`/api/v1/shops/b/operations/${operationId}`)).status,
  ).toBe(404);
  expect(
    (await request(`/api/v1/shops/a/operations/${operationId}`)).status,
  ).toBe(200);
});

test("imported Bot entry labels are reused by Web and staff money retries debit once", async () => {
  await env.DB.prepare(
    "UPDATE sessions SET label='音游区间' WHERE shop_id='a' AND player_id='p'",
  ).run();
  expect(
    (await request("/api/v1/shops/a/player/session/start", await entryBody()))
      .status,
  ).toBe(200);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE shop_id='a' AND player_id='p'",
    ).first("n"),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT label FROM sessions WHERE shop_id='a' AND player_id='p'",
    ).first("label"),
  ).toBe("音游区间");
  await env.DB.prepare(
    "INSERT INTO shop_members(id,shop_id,user_id,role) VALUES ('restored-owner','a','u','owner')",
  ).run();
  await env.DB.prepare(
    "UPDATE staff_users SET role='owner' WHERE shop_id='a' AND id='account:u'",
  ).run();
  expect(
    (
      await request(
        "/api/v1/shops/a/staff/asset-definitions/currency/paid",
        undefined,
      )
    ).status,
  ).toBe(404);
  const created = await app.fetch(
    new Request(
      origin + "/api/v1/shops/a/staff/asset-definitions/currency/paid",
      {
        method: "PUT",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Paid",
          stackable: true,
          pricingEffectId: null,
          metadata: null,
        }),
      },
    ),
    env,
  );
  expect(created.status).toBe(200);
  const operationId = crypto.randomUUID();
  const body = {
    operationId,
    reason: "test",
    grants: [
      {
        assetType: "currency",
        assetCode: "paid",
        amount: 25,
        mergeStrategy: "stack",
        activeAt: null,
        expiresAt: null,
      },
    ],
  };
  const path = "/api/v1/shops/a/staff/players/p/assets/grants";
  const result = await request(path, body);
  expect(result.status).toBe(200);
  expect(await (await request(path, body)).json()).toEqual(await result.json());
  expect(
    await env.DB.prepare(
      "SELECT SUM(quantity) AS n FROM asset_holdings WHERE shop_id='a' AND player_id='p'",
    ).first("n"),
  ).toBe(25);
  expect(
    (
      await request(path, {
        ...body,
        grants: [{ ...body.grants[0], amount: 50 }],
      })
    ).status,
  ).toBe(409);
  expect(
    (await request(path, { ...body, operationId: undefined })).status,
  ).toBe(400);
});

test("report dates use shop midnight across time zones and daylight saving", () => {
  expect(
    parseLocalDateTime("2026-09-12", "00:00", "Asia/Shanghai").toISOString(),
  ).toBe("2026-09-11T16:00:00.000Z");
  const start = parseLocalDateTime("2026-03-08", "00:00", "America/New_York");
  const end = parseLocalDateTime(
    addLocalDays("2026-03-08", 1),
    "00:00",
    "America/New_York",
  );
  expect((end.getTime() - start.getTime()) / 3600000).toBe(23);
});

test("one machine ticket supports repeated card sends, audits the imported entry and never closes billing on relay failure", async () => {
  const url = await encryptSecret(
    "https://receiver.test/card",
    env.URL_ENCRYPTION_KEY,
  );
  await env.DB.prepare(
    "INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted,enabled) VALUES ('machine','machine','a','Demo',?,1)",
  )
    .bind(url)
    .run();
  await env.DB.prepare(
    "INSERT INTO cards(id,user_id,label,card_type,access_code,source) VALUES ('card','u','Test','aime','01234567890123456789','manual')",
  ).run();
  const session = await request("/api/v1/machines/session/start", {
    shopCode: "a",
    publicId: "machine",
  });
  const {
    data: { ticket },
  } = (await session.json()) as { data: { ticket: string } };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url, options) => {
    expect(String(url)).toBe("https://receiver.test/card");
    expect(JSON.parse(String(options?.body))).toMatchObject({
      type: "aime",
      value: "01234567890123456789",
    });
    calls++;
    return new Response("relay accepted", { status: 200 });
  }) as typeof fetch;
  try {
    const results = await Promise.all([
      request("/api/v1/machines/login", { ticket, cardId: "card" }),
      request("/api/v1/machines/login", { ticket, cardId: "card" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200]);
    expect(calls).toBe(2);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM device_commands WHERE shop_id='a' AND type='aime.scan'",
      ).first("n"),
    ).toBe(2);
    const next = await request("/api/v1/machines/session/start", {
      shopCode: "a",
      publicId: "machine",
    });
    const {
      data: { ticket: nextTicket },
    } = (await next.json()) as { data: { ticket: string } };
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("simulated lost relay response");
    }) as typeof fetch;
    const failed = await request("/api/v1/machines/login", {
      ticket: nextTicket,
      cardId: "card",
    });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({
      error: { code: "DEVICE_UNAVAILABLE" },
    });
    expect(
      (
        await request("/api/v1/machines/login", {
          ticket: nextTicket,
          cardId: "card",
        })
      ).status,
    ).toBe(502);
    expect((await request(`/api/v1/devices/session/state?ticket=${nextTicket}`)).status).toBe(200);
    expect(calls).toBe(4);
    expect(
      await env.DB.prepare(
        "SELECT status FROM sessions WHERE shop_id='a' AND player_id='p'",
      ).first("status"),
    ).toBe("active");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM player_operations WHERE shop_id='a' AND kind='aime.scan' AND status='unknown'",
      ).first("n"),
    ).toBe(2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("devices allow zero or combined capabilities and retain one identity for power and IO", async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO shop_members(id,shop_id,user_id,role) VALUES ('device-owner','card','u','owner')",
  ).run();
  const empty = await request("/api/v1/merchant/machines", {
    shopId: "card",
    name: "Empty entrance",
  });
  expect(empty.status).toBe(201);
  const {
    data: { machine: blank },
  } = (await empty.json()) as any;
  const emptySession = await request("/api/v1/machines/session/start", {
    shopCode: "card",
    publicId: blank.publicId,
  });
  const {
    data: { ticket: emptyTicket, machine: emptyMachine },
  } = (await emptySession.json()) as any;
  expect(emptyMachine.capabilities).toEqual({
    power: false,
    coin: false,
    card: false,
    door: false,
    mahjong: false,
  });
  expect(
    await (
      await request(`/api/v1/devices/session/state?ticket=${emptyTicket}`)
    ).json(),
  ).toMatchObject({ data: { gate: "ready", power: "unmanaged" } });
  expect(
    (
      await request("/api/v1/devices/session/actions", {
        ticket: emptyTicket,
        operationId: crypto.randomUUID(),
        action: "power.on",
      })
    ).status,
  ).toBe(409);
  const created = await request("/api/v1/merchant/machines", {
    shopId: "card",
    name: "Combined",
    hinataUrl: "https://io.test",
    hinataPassword: "io-secret",
    homeAssistant: {
      url: "https://ha.test",
      entityId: "switch.game",
      token: "ha-secret",
    },
  });
  expect(created.status).toBe(201);
  const {
    data: { machine },
  } = (await created.json()) as any;
  expect(JSON.stringify(machine)).not.toContain("ha-secret");
  const {
    data: { ticket },
  } = (await (
    await request("/api/v1/machines/session/start", {
      shopCode: "card",
      publicId: machine.publicId,
    })
  ).json()) as any;
  const originalFetch = globalThis.fetch;
  let power = "off";
  let coinCalls = 0;
  let powerCalls = 0;
  globalThis.fetch = (async (url, init) => {
    if (String(url).includes("/api/states/"))
      return Response.json({ state: power });
    if (String(url).includes("/api/services/")) {
      powerCalls++;
      power = "on";
      return Response.json([]);
    }
    if (String(url) === "https://io.test/event") {
      coinCalls++;
      expect(
        await decryptE2EE("io-secret", JSON.parse(String(init?.body))),
      ).toMatchObject({
        action: "KEY_PRESS",
        body: { key: 32, count: 1 },
      });
      return Response.json({ ok: true });
    }
    if (String(url) === "https://io.test") return Response.json({ ok: true });
    throw new Error("unexpected test URL");
  }) as typeof fetch;
  try {
    expect(
      await (
        await request(`/api/v1/devices/session/state?ticket=${ticket}`)
      ).json(),
    ).toMatchObject({ data: { gate: "ready", power: "off" } });
    expect(
      (await request("/api/v1/machines/login", { ticket, cardId: "card" }))
        .status,
    ).toBe(409);
    expect(
      (
        await request("/api/v1/devices/session/actions", {
          ticket,
          operationId: crypto.randomUUID(),
          action: "coin",
        })
      ).status,
    ).toBe(409);
    const on = { ticket, operationId: crypto.randomUUID(), action: "power.on" };
    expect((await request("/api/v1/devices/session/actions", on)).status).toBe(
      200,
    );
    expect((await request("/api/v1/devices/session/actions", on)).status).toBe(
      200,
    );
    expect(powerCalls).toBe(1);
    const coin = { ticket, operationId: crypto.randomUUID(), action: "coin" };
    expect(
      (await request("/api/v1/devices/session/actions", coin)).status,
    ).toBe(200);
    expect(
      (await request("/api/v1/devices/session/actions", coin)).status,
    ).toBe(200);
    expect(coinCalls).toBe(1);
    expect((await request("/api/v1/devices/session/actions", {ticket, operationId: crypto.randomUUID(), action: "coin"})).status).toBe(429);
    expect(coinCalls).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(DISTINCT device_id) FROM device_commands WHERE shop_id='card'",
      ).first("COUNT(DISTINCT device_id)"),
    ).toBe(1);
    power = "unavailable";
    expect(
      await (
        await request(`/api/v1/devices/session/state?ticket=${ticket}`)
      ).json(),
    ).toMatchObject({ data: { power: "unknown" } });
    expect(
      (
        await request("/api/v1/devices/session/actions", {
          ticket,
          operationId: crypto.randomUUID(),
          action: "power.off",
        })
      ).status,
    ).toBe(403);
    await env.DB.prepare(
      "DELETE FROM operation_locks WHERE shop_id='card' AND scope='device.coin'",
    ).run();
    expect(
      (
        await request("/api/v1/devices/session/actions", {
          ticket,
          operationId: crypto.randomUUID(),
          action: "coin",
        })
      ).status,
    ).toBe(200);
    expect(coinCalls).toBe(2);
    expect(
      (await request("/api/v1/machines/login", { ticket, cardId: "card" }))
        .status,
    ).toBe(200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("new billed stores create base assets and pricing atomically; door QR requires QQ and consent", async () => {
  const created = await request("/api/v1/merchant/shops", {
    name: "New store",
    latitude: 35,
    longitude: 139,
    billingSetup: {
      paidName: "余额",
      freeName: "赠送",
      hourlyPrice: 12,
      graceMinutes: 5,
      dailyCap: 60,
      autoRegister: true,
    },
  });
  expect(created.status).toBe(201);
  const {
    data: { shop, botToken },
  } = (await created.json()) as any;
  const savedSettings = await request(`/api/v1/shops/${shop.publicId}/settings`);
  const { data: billingSettings } = await savedSettings.json() as any;
  expect(billingSettings.botContact).toBe("");
  const updatedSettings = await app.fetch(new Request(`${origin}/api/v1/shops/${shop.publicId}/settings`, {
    method: "PUT",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify(billingSettings),
  }), env);
  expect(updatedSettings.status).toBe(200);

  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM asset_definitions WHERE shop_id=?",
    )
      .bind(shop.id)
      .first("n"),
  ).toBe(2);
  const {
    data: { machine },
  } = (await (
    await request("/api/v1/merchant/machines", {
      shopId: shop.id,
      name: "Entrance",
      ttlockLockId: 12,
    })
  ).json()) as any;
  const {
    data: { ticket },
  } = (await (
    await request("/api/v1/machines/session/start", {
      shopCode: shop.publicId,
      publicId: machine.publicId,
    })
  ).json()) as any;
  const path = "/api/v1/devices/session/actions";
  const open = {
    ticket,
    operationId: crypto.randomUUID(),
    action: "door.open",
    consent: true,
  };
  expect(await (await request(path, open)).json()).toMatchObject({
    error: { code: "QQ_BINDING_REQUIRED" },
  });
  const {
    data: { code },
  } = (await (
    await request(`/api/v1/shops/${shop.publicId}/qq-binding`, {})
  ).json()) as any;
  const binding = await request(
    `/api/v1/shops/${shop.publicId}/integration/qq-binding/confirm`,
    { code, qq: "987654" },
    botToken,
  );
  expect(binding.status).toBe(200);
  await env.DB.prepare(
    "INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES (?,'devices.ttlock_connection',?,?)",
  )
    .bind(
      shop.id,
      JSON.stringify({
        baseUrl: "https://lock.test",
        clientId: "client",
        accessToken: "token",
        clientSecret: "secret",
        refreshToken: "",
        appAccount: "",
        appPwd: "",
        accessTokenExpiresAt: null,
      }),
      new Date().toISOString(),
    )
    .run();
  expect(
    await (await request(path, { ...open, consent: false })).json(),
  ).toMatchObject({ error: { code: "CHECKIN_CONSENT_REQUIRED" } });
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE shop_id=?")
      .bind(shop.id)
      .first("n"),
  ).toBe(0);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url) => {
    expect(String(url)).toBe("https://lock.test/v3/keyboardPwd/add");
    calls++;
    return Response.json({ keyboardPwdId: 123 });
  }) as typeof fetch;
  try {
    const confirmed = { ...open, operationId: crypto.randomUUID() };
    const response = await request(path, confirmed);
    expect(response.status).toBe(200);
    const first = (await response.json()) as any;
    expect(first.data.temporaryPassword).toMatch(/^\d{8}$/);
    expect(await (await request(path, confirmed)).json()).toEqual(first);
    expect(calls).toBe(1);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE shop_id=?")
        .bind(shop.id)
        .first("n"),
    ).toBe(1);
    globalThis.fetch = (async () => {
      throw new Error("timeout");
    }) as typeof fetch;
    expect(
      (await request(path, { ...open, operationId: crypto.randomUUID() }))
        .status,
    ).toBe(502);
    expect(
      await env.DB.prepare("SELECT status FROM sessions WHERE shop_id=?")
        .bind(shop.id)
        .first("status"),
    ).toBe("active");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("existing HA and IO settings bind to the same empty device without exposing credentials", async () => {
  const now = new Date().toISOString();
  for (const [key, value] of [
    [
      "devices.homeassistant_connection",
      { url: "https://old-ha.test", token: "old-ha-secret" },
    ],
    ["devices.homeassistant", [{ id: "switch.legacy", name: "Old power" }]],
    [
      "devices.hinata_io",
      [
        {
          id: "old-io",
          name: "Old reader",
          url: "https://old-io.test",
          password: "old-io-secret",
          salt: "AAECAwQFBgcICQoLDA0ODw",
          coinKey: 33,
          cardType: "aime",
          aliases: [],
        },
      ],
    ],
  ] as const)
    await env.DB.prepare(
      "INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES (?,?,?,?) ON CONFLICT(shop_id,key) DO UPDATE SET value_json=excluded.value_json",
    )
      .bind("card", key, JSON.stringify(value), now)
      .run();
  const choices = (await (
    await request("/api/v1/merchant/device-bindings?shopId=card")
  ).json()) as any;
  expect(choices).toHaveProperty("data");
  expect(choices.data.bindings).toHaveLength(2);
  expect(JSON.stringify(choices)).not.toContain("secret");
  const {
    data: { machine },
  } = (await (
    await request("/api/v1/merchant/machines", {
      shopId: "card",
      name: "Imported cabinet",
    })
  ).json()) as any;
  const updated = await app.fetch(
    new Request(origin + `/api/v1/merchant/machines/${machine.id}`, {
      method: "PATCH",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({
        legacyBindings: [
          { kind: "home_assistant", id: "switch.legacy" },
          { kind: "hinata_io", id: "old-io" },
        ],
      }),
    }),
    env,
  );
  expect(updated.status).toBe(200);
  const result = (await updated.json()) as any;
  expect(result.data.machine).toMatchObject({
    id: machine.id,
    publicId: machine.publicId,
    hasPassword: true,
    coinKey: 33,
  });
  const {
    data: { machine: publicDevice },
  } = (await (
    await request("/api/v1/machines/session/start", {
      shopCode: "card",
      publicId: machine.publicId,
    })
  ).json()) as any;
  expect(publicDevice.capabilities).toMatchObject({
    power: true,
    coin: true,
    card: true,
    door: false,
    mahjong: false,
  });
  expect(JSON.stringify(publicDevice)).not.toContain("old-ha");
});

test("nonbilling card and automatic coin flows need no QQ or entry, dispatch once and report partial results", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { id?: string; action: string; body?: unknown }[] = [];
  let failure = "";
  globalThis.fetch = (async (_url, init) => {
    const envelope = JSON.parse(String(init?.body));
    const command =
      envelope.action === "E2EE_V2"
        ? ((await decryptE2EE("coin-secret", envelope)) as {
            action: string;
            body: unknown;
          })
        : { action: "SET_CARD", body: envelope };
    calls.push({ id: envelope.body?.message_id, ...command });
    if (failure === command.action)
      return new Response("rejected", { status: 400 });
    if (failure === `${command.action}:lost`)
      throw new Error("simulated lost device response");
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    expect((await sendHinataCoin("https://auto.test", 32)).ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(
      (
        await request("/api/v1/merchant/machines", {
          shopId: "card",
          name: "Invalid automatic coin",
          hinataUrl: "https://auto.test",
          coinAfterSwipe: true,
        })
      ).status,
    ).toBe(400);
    const created = await request("/api/v1/merchant/machines", {
      shopId: "card",
      name: "Automatic coin",
      hinataUrl: "https://auto.test",
    });
    expect(created.status).toBe(201);
    const {
      data: { machine },
    } = (await created.json()) as any;
    expect(machine.coinAfterSwipe).toBe(false);
    const start = async () => {
      // Each scenario isolates delivery semantics from the separate login throttle.
      await env.RATE_LIMIT.delete(
        `login:user:u:${Math.floor(Date.now() / 60000)}`,
      );
      const response = await request("/api/v1/machines/session/start", {
        shopCode: "card",
        publicId: machine.publicId,
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as any).data;
    };
    const plain = await start();
    expect(plain.machine).toMatchObject({
      coinAfterSwipe: false,
      capabilities: { card: true, coin: false },
      shop: { billingEnabled: false },
    });
    expect(
      await (
        await request(`/api/v1/devices/session/state?ticket=${plain.ticket}`)
      ).json(),
    ).toMatchObject({ data: { gate: "ready", power: "unmanaged" } });
    expect(
      (
        await request("/api/v1/machines/login", {
          ticket: plain.ticket,
          cardId: "card",
        })
      ).status,
    ).toBe(200);
    expect(calls.map((c) => c.action)).toEqual(["SET_CARD"]);
    const patched = await app.fetch(
      new Request(`${origin}/api/v1/merchant/machines/${machine.id}`, {
        method: "PATCH",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({
          hinataPassword: "coin-secret",
          coinAfterSwipe: true,
        }),
      }),
      env,
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      data: { machine: { id: machine.id, coinAfterSwipe: true } },
    });
    const disabledCoin = await app.fetch(
      new Request(`${origin}/api/v1/merchant/machines/${machine.id}`, {
        method: "PATCH",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({ coinKey: 0, coinAfterSwipe: true }),
      }),
      env,
    );
    expect(disabledCoin.status).toBe(200);
    expect(await disabledCoin.json()).toMatchObject({
      data: { machine: { coinKey: 0, coinAfterSwipe: false } },
    });
    const cardOnly = await start();
    expect(cardOnly.machine.capabilities).toMatchObject({ card: true, coin: false });
    const restoreCoin = await app.fetch(
      new Request(`${origin}/api/v1/merchant/machines/${machine.id}`, {
        method: "PATCH",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({ coinKey: 32, coinAfterSwipe: true }),
      }),
      env,
    );
    expect(restoreCoin.status).toBe(200);
    calls.length = 0;
    const automatic = await start();
    expect(automatic.machine).toMatchObject({
      coinAfterSwipe: true,
      webOnly: true,
      capabilities: { card: true, coin: true },
    });
    const results = await Promise.all([
      request("/api/v1/machines/login", {
        ticket: automatic.ticket,
        cardId: "card",
      }),
      request(`/api/v1/machines/${machine.publicId}/login`, {
        ticket: automatic.ticket,
        cardId: "card",
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200]);
    const responses = await Promise.all(results.map(r => r.json())) as any[];
    const success = responses.find(r => r.data.coin.status === "sent");
    expect(success.data.coin.status).toBe("sent");
    expect(calls.filter(c => c.action === "SET_CARD")).toHaveLength(2);
    const coins = calls.filter(c => c.action === "KEY_PRESS");
    expect(coins).toHaveLength(1);
    expect(coins[0]!.body).toEqual({ key: 32, count: 1 });
    expect(calls[0]!.id).not.toBe(coins[0]!.id);
    expect(calls.every((c) => !!c.id)).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT payload_json FROM device_commands WHERE shop_id='card' AND id=?",
      )
        .bind(coins[0]!.id!)
        .first("payload_json"),
    ).toBe(JSON.stringify({ parentOperationId: success.data.operationId }));
    const cooldown = await start();
    expect(
      (
        await request("/api/v1/devices/session/actions", {
          ticket: cooldown.ticket,
          operationId: crypto.randomUUID(),
          action: "coin",
        })
      ).status,
    ).toBe(409);
    const skipped = await request("/api/v1/machines/login", {
      ticket: cooldown.ticket,
      cardId: "card",
    });
    expect(await skipped.json()).toMatchObject({
      data: { ok: true, coin: { status: "skipped", reason: "COIN_COOLDOWN" } },
    });
    expect(calls.filter((c) => c.action === "KEY_PRESS")).toHaveLength(1);
    for (const [mode, expected] of [
      ["SET_CARD", "failed"],
      ["SET_CARD:lost", "unknown"],
      ["KEY_PRESS", "failed"],
      ["KEY_PRESS:lost", "unknown"],
    ]) {
      failure = mode!;
      calls.length = 0;
      await env.DB.prepare(
        "DELETE FROM operation_locks WHERE shop_id='card' AND resource_id=?",
      )
        .bind(machine.id)
        .run();
      const { ticket } = await start();
      const response = await request("/api/v1/machines/login", {
        ticket,
        cardId: "card",
      });
      const body = (await response.json()) as any;
      if (mode!.startsWith("SET_CARD")) {
        expect(response.status).toBe(502);
        expect(calls.map((c) => c.action)).toEqual(["SET_CARD"]);
      } else {
        expect(response.status).toBe(200);
        expect(body).toMatchObject({
          data: { ok: true, status: "completed", coin: { status: expected } },
        });
        expect(calls.map((c) => c.action)).toEqual(["SET_CARD", "KEY_PRESS"]);
        expect(
          await env.DB.prepare(
            "SELECT status FROM device_commands WHERE shop_id='card' AND id=?",
          )
            .bind(body.data.coin.operationId)
            .first("status"),
        ).toBe(expected === "unknown" ? "pending" : "expired");
      }
      expect(
        (await request("/api/v1/machines/login", { ticket, cardId: "card" }))
          .status,
      ).toBe(mode!.startsWith("SET_CARD") ? 502 : 200);
      expect((await request(`/api/v1/devices/session/state?ticket=${ticket}`)).status).toBe(200);
      expect(calls).toHaveLength(mode!.startsWith("SET_CARD") ? 2 : 3);
    }
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM sessions WHERE shop_id='card'",
      ).first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM shop_player_accounts WHERE shop_id='card'",
      ).first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM asset_definitions WHERE shop_id='card'",
      ).first("n"),
    ).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a nonbilling door verifies QQ and opens without creating admission or charging assets", async () => {
  const created = await request("/api/v1/merchant/machines", {
    shopId: "card",
    name: "Entrance",
    ttlockLockId: 202,
  });
  expect(created.status).toBe(201);
  const {
    data: { machine },
  } = (await created.json()) as any;
  const {
    data: { ticket },
  } = (await (
    await request("/api/v1/machines/session/start", {
      shopCode: "card",
      publicId: machine.publicId,
    })
  ).json()) as any;
  const state = `/api/v1/devices/session/state?ticket=${ticket}`;
  expect(await (await request(state)).json()).toMatchObject({
    data: { gate: "qq" },
  });
  const action = {
    ticket,
    operationId: crypto.randomUUID(),
    action: "door.open",
  };
  expect(
    (await request("/api/v1/devices/session/actions", action)).status,
  ).toBe(403);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO shop_player_accounts(shop_id,user_id,player_id,qq,verified_at) VALUES ('card','u','p','123456',?)",
    ).bind(new Date().toISOString()),
    env.DB.prepare(
      "INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES ('card','devices.ttlock_connection',?,?)",
    ).bind(
      JSON.stringify({
        baseUrl: "https://lock.test",
        clientId: "test",
        accessToken: "test",
      }),
      new Date().toISOString(),
    ),
  ]);
  expect(await (await request(state)).json()).toMatchObject({
    data: { gate: "ready" },
  });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url) => {
    expect(String(url)).toBe("https://lock.test/v3/keyboardPwd/add");
    calls++;
    return Response.json({ keyboardPwdId: 202 });
  }) as typeof fetch;
  try {
    const opened = await request("/api/v1/devices/session/actions", action);
    expect(opened.status).toBe(200);
    expect(((await opened.json()) as any).data.temporaryPassword).toMatch(
      /^\d+$/,
    );
    expect(
      (await request("/api/v1/devices/session/actions", action)).status,
    ).toBe(200);
    expect(calls).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM sessions WHERE shop_id='card'",
      ).first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM asset_definitions WHERE shop_id='card'",
      ).first("n"),
    ).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("entry requires a scanned device ticket and explicit consent; players cannot list device links", async () => {
  expect(
    (
      await request("/api/v1/shops/a/player/session/start", {
        operationId: crypto.randomUUID(),
        consent: true,
      })
    ).status,
  ).toBe(410);
  const body = await entryBody();
  expect(
    (
      await request("/api/v1/shops/a/player/session/start", {
        ...body,
        consent: false,
      })
    ).status,
  ).toBe(409);
  expect((await request("/api/v1/shops/a/devices")).status).toBe(404);
  expect((await request("/api/v1/shops/a/player/devices")).status).toBe(409);
});

test("player rate schedule resolves production-style priorities, dated overnight promotions and global caps", async () => {
  const rates = {
    unitPrice: 4,
    unitMinutes: 30,
    roundGraceMinutes: 5,
    priceCap: 40,
  };
  const provider = {
    id: "schedule",
    timeZone: "Asia/Shanghai",
    rules: [
      {
        id: "day",
        label: "平日日场",
        priority: 1,
        timeRange: { start: "10:00", end: "22:00" },
        pricing: rates,
      },
      {
        id: "night",
        label: "平日夜场",
        priority: 1,
        timeRange: { start: "22:00", end: "10:00" },
        pricing: rates,
      },
      {
        id: "weekday",
        label: "工作日日场",
        priority: 2,
        weekdays: [1, 2, 3, 4, 5],
        timeRange: { start: "10:00", end: "22:00" },
        pricing: { ...rates, unitPrice: 3 },
      },
      {
        id: "holiday",
        label: "跨年活动",
        priority: 3,
        specificDates: ["2025-12-31"],
        timeRange: { start: "22:30", end: "01:30" },
        pricing: { ...rates, unitPrice: 0, priceCap: 0 },
      },
      {
        id: "spring",
        label: "春节",
        priority: 3,
        dateTimeRange: {
          start: "2026-02-17T00:00:21.735Z",
          end: "2026-03-03T20:00:21.735Z",
        },
        pricing: { ...rates, unitPrice: 3, priceCap: 30 },
      },
    ],
  };
  await env.DB.prepare(
    "INSERT INTO pricing_configs(shop_id,id,name,kind,enabled,status,provider_json,created_at,updated_at) VALUES ('a','schedule','Rates','time.priority',1,'active',?,'2026-01-01','2026-01-01')",
  )
    .bind(JSON.stringify(provider))
    .run();
  await env.DB.prepare(
    "UPDATE shop_billing_settings SET entry_pricing_ids_json='[\"schedule\"]' WHERE shop_id='a'",
  ).run();
  const guide = (
    (await (await request("/api/v1/shops/a?date=2026-09-11")).json()) as any
  ).data.entryPricing.find((plan: any) => plan.id === "schedule").provider
    .rules;
  expect(guide.filter((rule: any) => rule.id === "night")).toHaveLength(1);
  expect(guide.find((rule: any) => rule.id === "night").timeRange).toEqual({
    start: "22:00",
    end: "10:00",
  });
  expect(guide.map((rule: any) => rule.id)).toEqual(["weekday", "night"]);
  const entryRules = async (date: string) => (
    (await (await request(`/api/v1/shops/a?date=${date}`)).json()) as any
  ).data.entryPricing.find((plan: any) => plan.id === "schedule").provider.rules;
  expect((await entryRules("2026-09-12")).map((r: any) => r.id)).toEqual(["day", "night"]);
  const holiday = (await entryRules("2026-01-01")).find((r: any) => r.id === "holiday");
  expect(holiday.timeRange).toEqual({start: "22:30", end: "01:30"});
  const spring = await entryRules("2026-02-18");
  expect(spring.map((r: any) => r.id)).toEqual(["spring"]);
  expect(spring[0].displayDateTimeRange).toEqual({ start: "2026-02-17 08:00:21", end: "2026-03-04 04:00:21" });
  const schedule = async (date: string) =>
    (
      (await (await request(`/api/v1/shops/a?date=${date}`)).json()) as any
    ).data.pricingSchedule.groups.find((g: any) => g.id === "schedule")
      .segments;
  expect((await schedule("2026-01-01"))[0]).toMatchObject({
    label: "跨年活动",
    startLabel: "00:00",
    endLabel: "01:30",
    pricing: { unitPrice: 0 },
  });
  expect(
    (await schedule("2026-02-18")).every((s: any) => s.label === "春节"),
  ).toBe(true);
  expect(
    (await schedule("2026-09-11")).some((s: any) => s.label === "工作日日场"),
  ).toBe(true);
  expect(
    (await schedule("2026-09-12")).some((s: any) => s.label === "工作日日场"),
  ).toBe(false);
  expect((await request("/api/v1/shops/a?date=2026-02-31")).status).toBe(400);
  const cap = {
    id: "combined-cap",
    includedPricingConfigIds: ["schedule"],
    rules: [
      {
        id: "cap",
        label: "日场合计",
        priority: 1,
        timeRange: { start: "10:00", end: "22:00" },
        priceCap: 30,
      },
    ],
  };
  await env.DB.prepare(
    "INSERT INTO pricing_configs(shop_id,id,name,kind,enabled,status,provider_json,created_at,updated_at) VALUES ('a','combined-cap','Cap','time.cap',1,'active',?,'2026-01-01','2026-01-01')",
  )
    .bind(JSON.stringify(cap))
    .run();
  const response = (await (
    await request("/api/v1/shops/a?date=2026-09-12")
  ).json()) as any;
  expect(
    response.data.pricingSchedule.groups
      .find((g: any) => g.kind === "time.cap")
      .segments.some((s: any) => s.priceCap === 30),
  ).toBe(true);
});

test("merchant location toggle synchronizes legacy flags and native session policy without billing", async () => {
  await env.DB.prepare("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('geo-policy','geo-policy','Geo',35,139,80,'u')").run();
  await env.DB.prepare("INSERT INTO shop_members(id,shop_id,user_id,role) VALUES ('geo-owner','geo-policy','u','owner')").run();
  await env.DB.prepare("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted,enabled) VALUES ('geo-device','geo-device','geo-policy','Device','',1)").run();
  for (const enabled of [true, false]) {
    const response = await app.fetch(new Request(origin + "/api/v1/shops/geo-policy/settings", {
      method: "PUT", headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ billingEnabled: false, autoRegister: false, locationEnabled: enabled,
        entryPricingIds: [], botContact: "", checkinGeo: !enabled, checkoutGeo: !enabled, machineGeo: !enabled }),
    }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { locationEnabled: enabled, checkinGeo: enabled, checkoutGeo: enabled, machineGeo: enabled } });
    const session = await request("/api/v1/machines/session/start", { shopCode: "geo-policy", publicId: "geo-device" });
    expect(await session.json()).toMatchObject({ data: { machine: { shop: { locationEnabled: enabled, machineGeo: enabled } } } });
  }
});

test("mahjong seats persist, start together, allow replacements and settle independently", async () => {
  const created = await request("/api/v1/merchant/shops", {
    name:"Mahjong", latitude:35,longitude:139,billingSetup:{paidName:"余额",freeName:"赠送",hourlyPrice:12,graceMinutes:0,dailyCap:0,autoRegister:true},
  });
  const {data:{shop,botToken}} = await created.json() as any;
  const {data:settings} = await (await request(`/api/v1/shops/${shop.publicId}/settings`)).json() as any;
  const device = await request("/api/v1/merchant/machines",{shopId:shop.id,name:"麻将 A",mahjong:{capacity:4,pricingConfigIds:settings.entryPricingIds}});
  expect(device.status).toBe(201);
  const {data:{machine}} = await device.json() as any;
  const cookies:string[]=[];
  const tickets:string[]=[];
  const call = (n:number,path:string,body?:unknown) => app.fetch(new Request(origin+path,{
    method:body===undefined?"GET":"POST",headers:{cookie:cookies[n]!,origin,"content-type":"application/json"},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  }),env);
  for(let n=0;n<5;n++) {
    const id=`mahjong-player-${n}`, token=`mahjong-token-${n}`;
    cookies.push("arcadelink_session="+token);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users(id,role) VALUES (?,'user')").bind(id),
      env.DB.prepare("INSERT INTO auth_identities(id,user_id,provider,provider_subject,username,display_name) VALUES (?,?,'munet',?,?,?)").bind(id,id,id,id,id),
      env.DB.prepare("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,'2999-01-01')").bind(id,id,await sha256(token)),
      env.DB.prepare("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?,?,?,'active','2026-01-01')").bind(shop.id,id,id),
      env.DB.prepare("INSERT INTO shop_player_accounts(shop_id,user_id,player_id,qq,verified_at) VALUES (?,?,?,?,?)").bind(shop.id,id,id,`90000000${n}`,new Date().toISOString()),
    ]);
    const {data:session}=await (await call(n,"/api/v1/machines/session/start",{shopCode:shop.publicId,publicId:machine.publicId})).json() as any;
    tickets.push(session.ticket);
    expect(session.machine.capabilities.mahjong).toBe(true);
  }
  const action=(n:number,a:string,operationId=crypto.randomUUID())=>call(n,"/api/v1/devices/session/actions",{ticket:tickets[n],action:a,operationId});
  expect((await action(0,"mahjong.join")).status).toBe(403);
  for(let n=0;n<5;n++) {
    const response=await call(n,`/api/v1/shops/${shop.publicId}/player/session/start`,{ticket:tickets[n],consent:true,operationId:crypto.randomUUID()});
    expect(response.status).toBe(200);
  }
  for(let n=0;n<3;n++) expect((await action(n,"mahjong.join")).status).toBe(200);
  const count=()=>env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE shop_id=? AND json_extract(metadata_json,'$.mahjongDeviceId')=? AND status='active'").bind(shop.id,machine.id).first<number>("n");
  expect(await count()).toBe(0);
  const roster = await request(`/api/v1/shops/${shop.publicId}/integration/sessions/active`,undefined,botToken);
  expect(roster.status).toBe(200);
  expect((await roster.json() as any).data.mahjongTables[0].players).toHaveLength(3);
  await env.DB.prepare(`CREATE TRIGGER reject_mahjong_test BEFORE INSERT ON sessions
    WHEN json_extract(NEW.metadata_json,'$.mahjongDeviceId') IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'simulated table-start failure'); END`).run();
  expect((await action(3,"mahjong.join")).status).toBe(500);
  expect(await count()).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM mahjong_seats WHERE machine_id=?").bind(machine.id).first("n")).toBe(3);
  await env.DB.prepare("DROP TRIGGER reject_mahjong_test").run();

  const contenders=await Promise.all([action(3,"mahjong.join"),action(4,"mahjong.join")]);
  expect(contenders.map(r=>r.status).sort()).toEqual([200,409]);
  expect(await count()).toBe(4);
  expect(await env.DB.prepare("SELECT COUNT(DISTINCT started_at) AS n FROM sessions WHERE shop_id=? AND json_extract(metadata_json,'$.mahjongDeviceId')=?").bind(shop.id,machine.id).first("n")).toBe(1);
  const reloaded=await call(0,`/api/v1/devices/session/state?ticket=${tickets[0]}`);
  const {data:state}=await reloaded.json() as any;
  expect(state.mahjong.seats).toHaveLength(4);
  expect(state.mahjong.seats.every((s:any)=>s.playing)).toBe(true);
  const op=crypto.randomUUID();
  expect((await action(0,"mahjong.leave",op)).status).toBe(200);
  expect((await action(0,"mahjong.leave",op)).status).toBe(200);
  expect(await count()).toBe(3);
  const replacement=contenders[0]!.status===200?4:3;
  expect((await action(replacement,"mahjong.join")).status).toBe(200);
  expect(await count()).toBe(4);
  const preview=await call(0,`/api/v1/shops/${shop.publicId}/player/checkout/preview`,{});
  expect(preview.status).toBe(200);
  const checkout=await call(0,`/api/v1/shops/${shop.publicId}/player/checkout/confirm`,{operationId:crypto.randomUUID()});
  expect(checkout.status).toBe(200);
  expect(await count()).toBe(4);
  // An expired QR cannot join or leave; another shop's ticket cannot target this table.
  await env.DB.prepare("UPDATE machine_tickets SET expires_at='2000-01-01' WHERE token_hash=?").bind(await sha256(tickets[0]!)).run();
  expect((await action(0,"mahjong.join")).status).toBe(410);
},30000);

test("staff can bind a player code without Bot credentials, scoped by shop and role", async () => {
  const shop = 'manual-binding';
  await env.DB.prepare("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES (?,?,?,35,139,80,'u')").bind(shop, shop, shop).run();
  await env.DB.prepare("INSERT INTO shop_billing_settings(shop_id,billing_enabled,auto_register) VALUES (?,1,0)").bind(shop).run();
  const { data: { code } } = await (await request(`/api/v1/shops/${shop}/qq-binding`, {})).json() as { data: { code: string } };
  const confirm = { code, qq: '987654321' };
  const endpoint = `/api/v1/shops/${shop}/staff/qq-binding/confirm`;
  expect((await request(endpoint, confirm)).status).toBe(403);
  await env.DB.prepare("INSERT INTO shop_members(id,shop_id,user_id,role) VALUES ('manual-owner',?,'u','owner')").bind(shop).run();
  await request(`/api/v1/shops/${shop}/staff/me`);
  await env.DB.prepare("UPDATE staff_users SET role='viewer' WHERE shop_id=? AND id='account:u'").bind(shop).run();
  expect((await request(endpoint, confirm)).status).toBe(403);
  await env.DB.prepare("UPDATE staff_users SET role='manager' WHERE shop_id=? AND id='account:u'").bind(shop).run();
  expect((await request(endpoint, confirm)).status).toBe(200);
  const binding = await env.DB.prepare("SELECT player_id,qq FROM shop_player_accounts WHERE shop_id=? AND user_id='u'").bind(shop).first<{ player_id: string; qq: string }>();
  expect(binding?.qq).toBe(confirm.qq);
  expect((await request(endpoint, confirm)).status).toBe(410);
  const { data: second } = await (await request(`/api/v1/shops/${shop}/qq-binding`, {})).json() as { data: { code: string } };
  expect((await request(endpoint, { code: second.code, qq: '987654322' })).status).toBe(409);
  const { data: third } = await (await request(`/api/v1/shops/${shop}/qq-binding`, {})).json() as { data: { code: string } };
  expect((await request(endpoint, { code: third.code, qq: confirm.qq })).status).toBe(200);
  expect(await env.DB.prepare("SELECT player_id FROM shop_player_accounts WHERE shop_id=? AND user_id='u'").bind(shop).first()).toEqual({ player_id: binding!.player_id });
});
