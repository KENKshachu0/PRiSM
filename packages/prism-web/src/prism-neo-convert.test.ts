import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { convertPrismNeoSnapshot, normalizePrismNeoTimestamp } from "./prism-neo-convert";
import { pricingPreview } from "./ui/merchant/pricing-preview";

const snapshot = {
  exportedAt: "2026-06-01T00:00:00.000Z",
  users: [
    { id: 7, createdAt: "2026-01-01T00:00:00Z", isBanned: false },
    { id: 8, createdAt: "2026-01-02T00:00:00Z", isBanned: true },
  ],
  binds: [{ id: 31, userId: 7, type: "QQ", bid: "123456" }],
  assetDefinitions: [
    { id: 1, assetId: 10001, type: "CURRENCY", name: "Paid balance", valid: true },
    {
      id: 3,
      assetId: 10001,
      type: "PASS",
      name: "Monthly pass",
      valid: true,
      billingEffect: { type: "FIXED_OFF", value: 10, consume: false },
    },
  ],
  userAssets: [
    { id: 101, userId: 7, assetDefId: 10001, assetType: "CURRENCY", count: 500.5 },
    { id: 102, userId: 7, assetDefId: 10001, assetType: "CURRENCY", count: 12, hide: true },
  ],
  userAssetLogs: [
    {
      id: 301,
      userId: 7,
      userAssetId: 101,
      assetId: 10001,
      assetType: "CURRENCY",
      changeAmount: -50,
      action: "DEDUCT_WALLET",
      comment: "checkout",
    },
  ],
  sessions: [
    {
      id: 51,
      userId: 7,
      createdAt: "2026-01-03T10:00:00Z",
      closedAt: "2026-01-03T11:30:00Z",
      billingCost: 120,
      finalCost: 90,
    },
    { id: 52, userId: 7, createdAt: "2026-01-04T10:00:00Z" },
  ],
  billingRules: [
    {
      id: 2,
      name: "Night",
      priority: 20,
      matchDate: { weekdays: [5, 6] },
      timeRange: { start: "20:00", end: "04:00" },
      pricing: { unitMinutes: 30, unitPrice: 40, priceCap: 160, roundGraceMinutes: 5 },
    },
  ],
  billingRecords: [
    {
      id: 401,
      userId: 7,
      ruleId: 2,
      ruleStartTimeStamp: 1_767_225_600_000,
      cost: 90,
      billingStart: "2026-01-03 10:00:00.000",
      billingEnd: "2026-01-03 11:30:00.000",
      durationMin: 90,
    },
  ],
  presents: [
    {
      id: 61,
      name: "Recharge pack",
      oncePerUser: true,
      body: [{ assetType: "CURRENCY", assetId: 10001, count: 1000, mergeStrategy: "STACK" }],
    },
  ],
  redeems: [
    {
      id: 71,
      code: "ABC123",
      presentId: 61,
      activeAt: "2026-01-01T00:00:00Z",
      maxUseCount: 1,
    },
  ],
  redeemRecords: [{ id: 81, userId: 7, redeemId: 71, presentId: 61, date: "2026-01-04T00:00:00Z" }],
  coinRecords: [
    { id: 91, userId: 7, machineName: "mai-1", count: 2, createAt: "2026-01-05T00:00:00Z" },
  ],
};

describe("convertPrismNeoSnapshot", () => {
  it("keeps a snapshot without billing rules as a device-only shop", () => {
    const converted = convertPrismNeoSnapshot({ ...snapshot, billingRules: [] }, { timeZone: "Asia/Shanghai" });
    expect(converted.settings).toMatchObject({ entryPricingIds: [] });
    expect(converted.tables.pricing_configs).toEqual([]);
  });

  it("stores present grants in stored units and keeps per-item limits", () => {
    const converted = convertPrismNeoSnapshot(
      {
        ...snapshot,
        presents: [
          {
            id: 62,
            name: "First top-up",
            oncePerUser: false,
            body: [
              { assetType: "CURRENCY", assetId: 10001, count: 12.5, mergeStrategy: "STACK" },
              { assetType: "TICKET", assetId: 10001, count: 3, mergeStrategy: "EXTEND_TIME", durationMs: 3_600_000, oncePerUser: true },
            ],
          },
        ],
      },
      { shopName: "x" },
    );
    expect(JSON.parse(String(converted.tables.presents[0]!.grants_json))).toEqual([
      expect.objectContaining({ assetType: "currency", assetCode: "paid", amount: 1250, mergeStrategy: "stack" }),
      expect.objectContaining({
        assetType: "ticket",
        assetCode: "legacy.ticket.10001",
        amount: 3,
        mergeStrategy: "extend-time",
        durationMs: 3_600_000,
        maxPerPlayer: 1,
      }),
    ]);
  });

  const backup = convertPrismNeoSnapshot(snapshot, { shopName: "云谷", timeZone: "Asia/Shanghai" });

  it("maps legacy ids, money and hidden assets like the CLI importer", () => {
    expect(backup.tables.players).toEqual([
      { id: "legacy:user:7", display_name: "Player 7", status: "active", created_at: "2026-01-01T00:00:00.000Z" },
      { id: "legacy:user:8", display_name: "Player 8", status: "banned", created_at: "2026-01-02T00:00:00.000Z" },
    ]);
    expect(backup.tables.player_identities).toEqual([
      { player_id: "legacy:user:7", provider: "qq", subject: "123456", created_at: "2026-06-01T00:00:00.000Z" },
    ]);
    expect(backup.tables.asset_definitions.find((d) => d.code === "paid")?.metadata_json).toContain('"hiddenFromPlayer":true');
    expect(backup.tables.asset_holdings[0]).toMatchObject({
      id: "legacy:user-asset:101",
      asset_type: "currency",
      asset_code: "paid",
      quantity: 50050,
    });
    expect(backup.tables.asset_ledger_entries[0]).toMatchObject({
      id: "legacy:user-asset-log:301",
      delta: -5000,
      reason: "legacy.DEDUCT_WALLET",
      ref_id: "legacy:user-asset:101",
    });
  });

  it("settles closed sessions from final cost and derives the delta", () => {
    expect(backup.tables.sessions).toEqual([
      expect.objectContaining({
        id: "legacy:session:51",
        status: "closed",
        payment_status: "paid",
        ended_at: "2026-01-03T11:30:00.000Z",
      }),
      expect.objectContaining({ id: "legacy:session:52", status: "active", payment_status: "unpaid" }),
    ]);
    expect(backup.tables.settlements).toEqual([
      {
        id: "legacy:settlement:legacy:session:51",
        session_id: "legacy:session:51",
        checkout_id: null,
        subtotal: 12000,
        total: 9000,
        status: "settled",
        settled_at: "2026-01-03T11:30:00.000Z",
      },
    ]);
    expect(backup.tables.settlement_charge_items).toEqual([
      {
        id: "legacy:billing-record:401",
        session_id: "legacy:session:51",
        item_order: 0,
        source: "legacy.billing-rule.2",
        label: "Legacy billing record 401",
        amount: 9000,
      },
    ]);
    expect(backup.tables.settlement_adjustments).toEqual([
      {
        id: "legacy:session-cost-delta:51",
        session_id: "legacy:session:51",
        adjustment_order: 0,
        source: "legacy.session",
        label: "Legacy final cost delta",
        amount: -3000,
      },
    ]);
  });

  it("bills the default group by an enabled legacy pricing release pinning unpaid sessions", () => {
    expect(backup.settings).toMatchObject({
      cashierEnabled: false,
      entryPricingIds: ["legacy:pricing-config:time-priority"],
    });
    expect(backup.tables.pricing_configs[0]).toMatchObject({ id: "legacy:pricing-config:time-priority", enabled: 1 });
    expect(backup.tables.pricing_config_versions[0]).toMatchObject({ enabled: 1 });
    expect(
      backup.tables.asset_definitions.filter((d) => d.type === "currency" && d.status === "active").map((d) => d.code),
    ).toEqual(expect.arrayContaining(["paid", "free"]));
    const provider = JSON.parse(String(backup.tables.pricing_configs[0]!.provider_json));
    // neo's Fri/Sat 20:00-04:00 Shanghai night rate, stored in UTC.
    expect(provider.timeZone).toBe("UTC");
    expect(provider.rules[0]).toMatchObject({
      id: "legacy.rule.2",
      weekdays: [5, 6],
      timeRange: { start: "12:00", end: "20:00" },
      pricing: { unitPrice: 4000, priceCap: 16000 },
    });
    expect(backup.tables.pricing_releases[0]!.time_zone).toBe("UTC");
    expect(backup.tables.session_pricing_releases).toEqual([
      { session_id: "legacy:session:52", release_id: "legacy:pricing-release:time-priority" },
    ]);
    expect(backup.tables.pricing_history_entries[0]).toMatchObject({
      id: "legacy:billing-record:401",
      rule_anchor_at: "2026-01-01T00:00:00.000Z",
      amount: 9000,
    });
  });

  it("converts coin records into settled hinata_io operations with request and result events", () => {
    expect(backup.tables.device_operations[0]).toMatchObject({
      id: "legacy:coin-record:91",
      device_id: "mai-1",
      capability: "hinata_io",
      status: "succeeded",
      counts_as_play: 1,
      payload_json: '{"count":2,"legacyCoinRecordId":91}',
    });
    expect(backup.tables.device_events.map((event) => event.id)).toEqual([
      "legacy:coin-record:91.request",
      "legacy:coin-record:91.result",
    ]);
  });

  it("matches the server's import fixture, so its end-to-end restore test covers what this writes", () => {
    const converted = convertPrismNeoSnapshot({
      exportedAt: "2026-06-01T00:00:00Z",
      users: [{ id: 7, createdAt: "2026-01-01T00:00:00Z", isBanned: false }],
      billingRules: [{ id: 2, name: "Night", priority: 20, matchDate: { weekdays: [5, 6] }, timeRange: { start: "20:00", end: "04:00" },
        pricing: { unitMinutes: 30, unitPrice: 40, priceCap: 160, roundGraceMinutes: 5 } }],
    } as never, { shopName: "云谷店", timeZone: "Asia/Shanghai" });
    const { counts: _counts, ...file } = converted;
    const fixture = JSON.parse(readFileSync(new URL("../../server/test/fixtures/prism-neo-converted.json", import.meta.url), "utf8"));
    expect(JSON.parse(JSON.stringify(file))).toEqual(fixture);
  });

  it("emits a partial v3 header that leaves the importing shop's profile alone", () => {
    expect(backup.partial).toBe(true);
    expect(backup).not.toHaveProperty("shopProfile");
    expect(Object.keys(backup).sort()).toEqual(
      ["counts", "exportedAt", "format", "partial", "scope", "settings", "source", "storage", "tables", "version"].sort(),
    );
  });

  it("produces a backup whose tables carry exactly the columns the import schema infers", () => {
    // The paged importer reads rows with json_extract per schema column and
    // requires an exact column match per row; assert no legacy-era field leaks.
    for (const [table, rows] of Object.entries(backup.tables)) {
      for (const row of rows) {
        for (const [key, value] of Object.entries(row)) {
          expect([key, typeof value === "string" || typeof value === "number" || value === null]).toEqual([
            key,
            true,
          ]);
          expect(key.endsWith("_json") ? JSON.parse(String(value)) !== undefined : true).toBe(true);
        }
      }
      expect(table.length).toBeGreaterThan(0);
    }
    expect(Object.keys(backup.tables).length).toBe(39);
  });

  it("keeps absolute holiday ranges as dateTimeRange so the pricing page can render them", () => {
    // prism-neo stores holiday rules as {isDateTimeRange:true,start,end};
    // treating that as a clock range made the pricing timeline throw
    // "Invalid time value" and took down the whole billing page.
    const holiday = convertPrismNeoSnapshot(
      {
        billingRules: [
          {
            id: 9,
            name: "春节",
            priority: 3,
            matchDate: null,
            timeRange: {
              isDateTimeRange: true,
              start: "2026-02-17T00:00:21.735Z",
              end: "2026-03-03T20:00:21.735Z",
            },
            pricing: { unitMinutes: 30, unitPrice: 3, priceCap: 30, roundGraceMinutes: 3 },
          },
        ],
      },
      { timeZone: "Asia/Shanghai" },
    );
    const provider = JSON.parse(String(holiday.tables.pricing_configs[0]!.provider_json));
    expect(provider.rules[0].dateTimeRange).toEqual({
      start: "2026-02-17T00:00:21.735Z",
      end: "2026-03-03T20:00:21.735Z",
    });
    expect(provider.rules[0].timeRange).toBeUndefined();
    // The imported config must produce a timeline instead of crashing.
    expect(
      pricingPreview(
        {
          id: "legacy:pricing-config:time-priority",
          kind: "time.priority",
          name: "Legacy time priority pricing",
          enabled: false,
          provider,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as never,
        "2026-10-20",
        "Asia/Shanghai",
      ),
    ).not.toBeNull();
  });

  it("parses bare legacy timestamps as UTC", () => {
    expect(normalizePrismNeoTimestamp("2026-01-03 10:00:00.000")).toBe("2026-01-03T10:00:00.000Z");
    expect(normalizePrismNeoTimestamp("2026-01-03T18:00:00+08:00")).toBe("2026-01-03T10:00:00.000Z");
  });
});