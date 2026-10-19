/**
 * Converts a prism-neo export snapshot into the PRiSM shop backup format
 * understood by the paged import endpoints. Mapping rules mirror
 * packages/migration (legacy:* id namespaces, currency paid/free, closed
 * sessions as settled) so both entry points produce the same records.
 */

type NeoSnapshot = {
  exportedAt?: string;
  users?: NeoUser[];
  binds?: NeoBind[];
  assetDefinitions?: NeoAssetDefinition[];
  userAssets?: NeoUserAsset[];
  userAssetLogs?: NeoUserAssetLog[];
  sessions?: NeoSession[];
  billingRules?: NeoBillingRule[];
  billingRecords?: NeoBillingRecord[];
  presents?: NeoPresent[];
  redeems?: NeoRedeem[];
  redeemRecords?: NeoRedeemRecord[];
  coinRecords?: NeoCoinRecord[];
};
type NeoUser = { id: number | string; createdAt: string; isBanned: boolean | string | number };
type NeoBind = { id: number | string; userId: number | string; type: string; bid: string };
type NeoAssetDefinition = {
  id: number | string;
  assetId: number | string;
  type: string;
  name: string;
  valid: boolean;
  billingEffect?: unknown;
};
type NeoUserAsset = {
  id: number | string;
  userId: number | string;
  assetDefId: number | string;
  assetType: string;
  count: number | string;
  activeAt?: string | null;
  expireAt?: string | null;
  hide?: boolean | string | number | null;
};
type NeoUserAssetLog = {
  id: number | string;
  userId: number | string;
  userAssetId?: number | string | null;
  assetId: number | string;
  assetType: string;
  changeAmount: number | string;
  action: string;
  comment?: string | null;
  createdAt?: string;
};
type NeoSession = {
  id: number | string;
  userId: number | string;
  createdAt: string;
  closedAt?: string | null;
  isActive?: boolean | null;
  billingCost?: number | string | null;
  finalCost?: number | string | null;
};
type NeoBillingRule = {
  id: number | string;
  name: string;
  priority: number;
  matchDate?: { specificDates?: string[]; weekdays?: number[] } | null;
  timeRange:
    | { start: string; end: string }
    | { isDateTimeRange: true; start: string; end: string };
  pricing: { unitMinutes: number | string; unitPrice: number | string; priceCap: number | string; roundGraceMinutes: number | string };
};
type NeoBillingRecord = {
  id: number | string;
  userId: number | string;
  ruleId: number | string;
  ruleStartTimeStamp: number | string;
  cost: number | string;
  billingStart: string;
  billingEnd: string;
  durationMin: number;
};
type NeoPresent = {
  id: number | string;
  name: string;
  oncePerUser: boolean | string | number;
  body: NeoPresentGrant[];
};
type NeoPresentGrant = {
  id?: number | string;
  name?: string;
  assetType?: string;
  assetId?: number | string;
  count?: number | string;
  mergeStrategy?: string;
  activeAt?: string | null;
  expireAt?: string | null;
};
type NeoRedeem = {
  id: number | string;
  code: string;
  presentId: number | string;
  activeAt?: string | null;
  expireAt?: string | null;
  maxUseCount: number | string;
};
type NeoRedeemRecord = {
  id: number | string;
  userId: number | string;
  redeemId: number | string;
  presentId: number | string;
  date: string;
};
type NeoCoinRecord = {
  id: number | string;
  userId: number | string;
  machineName: string;
  count: number | string;
  createAt: string;
};

type Row = Record<string, string | number | null>;
type NeoTables = {
  staff_users: Row[];
  pricing_effects: Row[];
  asset_definitions: Row[];
  pricing_configs: Row[];
  presents: Row[];
  business_items: Row[];
  pricing_config_versions: Row[];
  pricing_releases: Row[];
  pricing_release_heads: Row[];
  players: Row[];
  player_identities: Row[];
  cashier_profiles: Row[];
  sessions: Row[];
  session_pricing_releases: Row[];
  asset_holdings: Row[];
  asset_transactions: Row[];
  asset_ledger_entries: Row[];
  redeem_codes: Row[];
  redeem_records: Row[];
  player_checkouts: Row[];
  checkout_timelines: Row[];
  settlements: Row[];
  settlement_charge_items: Row[];
  settlement_adjustments: Row[];
  pricing_history_entries: Row[];
  pricing_cap_history_entries: Row[];
  business_item_orders: Row[];
  cashier_payments: Row[];
  app_settings: Row[];
  shop_billing_settings: Row[];
  api_tokens: Row[];
  machines: Row[];
  device_capabilities: Row[];
  mahjong_seats: Row[];
  device_operations: Row[];
  device_events: Row[];
  device_state: Row[];
  account_links: Row[];
  checkout_report_states: Row[];
};

export type PrismNeoConvertOptions = {
  /** Display name of the importing shop, echoed in the preview header. */
  shopName?: string;
  /** Named zone for the pricing release that pins unpaid sessions. */
  timeZone?: string;
};

export type PrismNeoBackup = {
  format: "prism-shop-data";
  version: 3;
  scope: "business";
  exportedAt: string;
  source: { publicId: string; name: string; timeZone: string };
  storage: { timeZone: "UTC"; money: "minor-units" };
  settings: {
    billingEnabled: false;
    cashierEnabled: false;
    autoRegister: boolean;
    identityBindingRequired: boolean;
    checkinGeo: false;
    checkoutGeo: false;
    machineGeo: false;
    entryPricingIds: string[];
    botContact: "";
    coinCooldownMs: 60_000;
    defaultPresentId: null;
  };
  /** Restores the importing shop's profile; hero data is not carried over. */
  shopProfile: { name: string; latitude: number; longitude: number; radiusMeters: number; heroData: null };
  counts: Record<string, number>;
  tables: NeoTables;
};

const iso = (value: string | number | undefined | null): string | null => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && !/[zZ]$/.test(value) && !/[+-]\d{2}:?\d{2}$/.test(value)) {
    return normalizePrismNeoTimestamp(value);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("数据损坏");
  return date.toISOString();
};

const legacyUserId = (id: number | string) => `legacy:user:${Number(id)}`;
const legacySessionId = (id: number | string) => `legacy:session:${Number(id)}`;

const mapLegacyAsset = (type: string, assetId: number | string): { type: string; code: string } => {
  const numericId = Number(assetId);
  if (type === "CURRENCY" && numericId === 10001) return { type: "currency", code: "paid" };
  if (type === "CURRENCY" && numericId === 10002) return { type: "currency", code: "free" };
  const normalized = type.toLowerCase();
  return { type: normalized, code: `legacy.${normalized}.${numericId}` };
};

const toMergeStrategy = (strategy: string | undefined): "stack" | "extend-time" | "replace" => {
  if (strategy === "EXTEND_TIME") return "extend-time";
  if (strategy === "REPLACE") return "replace";
  return "stack";
};

/** Bare neo timestamps are UTC (see packages/migration parseLegacyTimestamp). */
export const normalizePrismNeoTimestamp = (value: string): string => {
  const trimmed = value.trim();
  if (/[zZ]$/.test(trimmed) || /[+-]\d{2}:?\d{2}$/.test(trimmed)) return new Date(trimmed).toISOString();
  return new Date(`${trimmed.replace(" ", "T")}Z`).toISOString();
};

/** pg_dump COPY rows carry booleans as "t"/"f" strings; JSON exports use real booleans. */
export const parseLegacyBoolean = (value: unknown): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "t", "1", "yes"].includes(normalized)) return true;
    if (["false", "f", "0", "no"].includes(normalized)) return false;
  }
  throw new Error("数据损坏");
};

/** COPY rows deliver every field as text; numbers need coercing before arithmetic. */
export const parseLegacyNumber = (value: unknown): number => {
  if (typeof value === "number") return value;
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new Error("数据损坏");
  return parsed;
};

/** COPY rows deliver jsonb columns as text; JSON exports already parse them. */
export const parseLegacyJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("数据损坏");
  }
};

const cents = (value: number): number => Math.round(value * 100);

function resolveGrantAsset(
  grant: NeoPresentGrant,
  definitionsById: Map<number, NeoAssetDefinition>,
): { type: string; assetId: number } {
  if (grant.assetType && grant.assetId !== undefined)
    return { type: grant.assetType, assetId: parseLegacyNumber(grant.assetId) };
  if (grant.id !== undefined) {
    const definition = definitionsById.get(Number(grant.id));
    if (definition) return { type: definition.type, assetId: parseLegacyNumber(definition.assetId) };
  }
  throw new Error("数据损坏");
}

function anchorOf(timestamp: number | string): string {
  const value = Number(timestamp);
  const ms = value < 10_000_000_000 ? value * 1000 : value;
  return new Date(ms).toISOString();
}

export function convertPrismNeoSnapshot(
  snapshot: NeoSnapshot,
  options: PrismNeoConvertOptions = {},
): PrismNeoBackup {
  const exportedAt = iso(snapshot.exportedAt) ?? new Date().toISOString();
  const timeZone = options.timeZone || "UTC";
  const configId = "legacy:pricing-config:time-priority";
  const versionId = "legacy:pricing-version:time-priority";
  const releaseId = "legacy:pricing-release:time-priority";
  const neoRules = snapshot.billingRules ?? [];

  // The importer cross-checks the file's table keys against the full v3 list
  // and rejects any missing key, so every table ships even when empty.
  const tables: NeoTables = {
    staff_users: [],
    pricing_effects: [],
    asset_definitions: [],
    pricing_configs: [],
    presents: [],
    business_items: [],
    pricing_config_versions: [],
    pricing_releases: [],
    pricing_release_heads: [],
    players: [],
    player_identities: [],
    cashier_profiles: [],
    sessions: [],
    session_pricing_releases: [],
    asset_holdings: [],
    asset_transactions: [],
    asset_ledger_entries: [],
    redeem_codes: [],
    redeem_records: [],
    player_checkouts: [],
    checkout_timelines: [],
    settlements: [],
    settlement_charge_items: [],
    settlement_adjustments: [],
    pricing_history_entries: [],
    pricing_cap_history_entries: [],
    business_item_orders: [],
    cashier_payments: [],
    app_settings: [],
    shop_billing_settings: [],
    api_tokens: [],
    machines: [],
    device_capabilities: [],
    mahjong_seats: [],
    device_operations: [],
    device_events: [],
    device_state: [],
    account_links: [],
    checkout_report_states: [],
  };

  for (const user of snapshot.users ?? []) {
    tables.players.push({
      id: legacyUserId(user.id),
      display_name: `Player ${user.id}`,
      status: parseLegacyBoolean(user.isBanned) ? "banned" : "active",
      created_at: iso(user.createdAt)!,
    });
  }

  for (const bind of snapshot.binds ?? []) {
    tables.player_identities.push({
      player_id: legacyUserId(bind.userId),
      provider: bind.type.toLowerCase(),
      subject: bind.bid,
      created_at: exportedAt,
    });
  }

  // Hidden holdings stay hidden through metadata on the definition.
  const hiddenKeys = new Set(
    (snapshot.userAssets ?? [])
      .filter((asset) => asset.hide !== null && asset.hide !== undefined && parseLegacyBoolean(asset.hide))
      .map((asset) => `${asset.assetType}:${Number(asset.assetDefId)}`),
  );
  const definitionKeys = new Set(
    (snapshot.assetDefinitions ?? []).map((d) => `${d.type}:${Number(d.assetId)}`),
  );
  for (const definition of snapshot.assetDefinitions ?? []) {
    const mapped = mapLegacyAsset(definition.type, definition.assetId);
    const metadata: Record<string, unknown> = {
      legacy: { type: definition.type, assetId: Number(definition.assetId), id: Number(definition.id) },
      valid: definition.valid,
    };
    if (definition.billingEffect !== undefined && definition.billingEffect !== null) {
      metadata.billingEffect = parseLegacyJson(definition.billingEffect);
    }
    if (hiddenKeys.has(`${definition.type}:${Number(definition.assetId)}`)) metadata.hiddenFromPlayer = true;
    tables.asset_definitions.push({
      type: mapped.type,
      code: mapped.code,
      name: definition.name,
      stackable: 1,
      status: "active",
      pricing_effect_id: null,
      active_at: null,
      expires_at: null,
      metadata_json: JSON.stringify(metadata),
    });
  }
  const synthesizeDefinition = (type: string, assetId: number | string) => {
    const key = `${type}:${Number(assetId)}`;
    if (definitionKeys.has(key)) return;
    definitionKeys.add(key);
    const mapped = mapLegacyAsset(type, assetId);
    tables.asset_definitions.push({
      type: mapped.type,
      code: mapped.code,
      name: `Legacy ${type} ${assetId}`,
      stackable: 1,
      status: "active",
      pricing_effect_id: null,
      active_at: null,
      expires_at: null,
      metadata_json: JSON.stringify({ legacy: { type, assetId: Number(assetId) }, valid: true, synthesized: true }),
    });
  };

  for (const asset of snapshot.userAssets ?? []) {
    synthesizeDefinition(asset.assetType, asset.assetDefId);
    const mapped = mapLegacyAsset(asset.assetType, asset.assetDefId);
    tables.asset_holdings.push({
      id: `legacy:user-asset:${asset.id}`,
      player_id: legacyUserId(asset.userId),
      asset_type: mapped.type,
      asset_code: mapped.code,
      // Currency stores cents, everything else whole units.
      quantity: mapped.type === "currency"
        ? cents(parseLegacyNumber(asset.count))
        : Math.trunc(parseLegacyNumber(asset.count)),
      active_at: iso(asset.activeAt),
      expires_at: iso(asset.expireAt),
    });
  }
  for (const log of snapshot.userAssetLogs ?? []) {
    synthesizeDefinition(log.assetType, log.assetId);
    const mapped = mapLegacyAsset(log.assetType, log.assetId);
    tables.asset_ledger_entries.push({
      id: `legacy:user-asset-log:${log.id}`,
      player_id: legacyUserId(log.userId),
      transaction_id: null,
      asset_type: mapped.type,
      asset_code: mapped.code,
      delta:
        mapped.type === "currency"
          ? cents(parseLegacyNumber(log.changeAmount))
          : Math.trunc(parseLegacyNumber(log.changeAmount)),
      reason: `legacy.${log.action}`,
      ref_id: log.userAssetId
        ? `legacy:user-asset:${log.userAssetId}`
        : log.comment || `legacy:user-asset-log:${log.id}`,
      created_at: iso(log.createdAt) ?? exportedAt,
    });
  }

  for (const session of snapshot.sessions ?? []) {
    const closed = !!session.closedAt || session.isActive === false;
    tables.sessions.push({
      id: legacySessionId(session.id),
      player_id: legacyUserId(session.userId),
      started_at: iso(session.createdAt)!,
      ended_at: iso(session.closedAt),
      status: closed ? "closed" : "active",
      pricing_config_ids_json: "[]",
      payment_status: closed ? "paid" : "unpaid",
      label: null,
      metadata_json: null,
    });
  }

  // A v3 business import restores releases verbatim, so ship one disabled
  // release pinning every unpaid session; the legacy rules stay dormant until
  // the owner reviews their time zones in the pricing editor.
  if (neoRules.length) {
    const provider = {
      id: "legacy.time-priority",
      timeZone: "UTC",
      rules: neoRules.map((rule) => {
        const matchDate = parseLegacyJson(rule.matchDate) as NeoBillingRule["matchDate"];
        const timeRange = parseLegacyJson(rule.timeRange) as NeoBillingRule["timeRange"];
        const pricing = parseLegacyJson(rule.pricing) as NeoBillingRule["pricing"];
        return {
        id: `legacy.rule.${rule.id}`,
        label: rule.name,
        priority: parseLegacyNumber(rule.priority),
        ...(matchDate?.specificDates?.length ? { specificDates: matchDate.specificDates } : {}),
        ...(matchDate?.weekdays?.length ? { weekdays: matchDate.weekdays } : {}),
        // prism-neo stores holiday rules as absolute ranges; a bare clock
        // range would crash the pricing timeline ("Invalid time value").
        ...("isDateTimeRange" in timeRange && timeRange.isDateTimeRange
          ? {
              dateTimeRange: {
                start: new Date(timeRange.start).toISOString(),
                end: new Date(timeRange.end).toISOString(),
              },
            }
          : { timeRange: { start: timeRange.start, end: timeRange.end } }),
        pricing: {
          unitMinutes: parseLegacyNumber(pricing.unitMinutes),
          unitPrice: cents(parseLegacyNumber(pricing.unitPrice)),
          priceCap: cents(parseLegacyNumber(pricing.priceCap)),
          roundGraceMinutes: parseLegacyNumber(pricing.roundGraceMinutes),
        },
        };
      }),
    };
    const providerJson = JSON.stringify(provider);
    tables.pricing_configs.push({
      id: configId,
      kind: "time.priority",
      name: "Legacy time priority pricing",
      enabled: 0,
      status: "active",
      provider_json: providerJson,
      created_at: exportedAt,
      updated_at: exportedAt,
    });
    tables.pricing_config_versions.push({
      version_id: versionId,
      config_id: configId,
      version: 1,
      kind: "time.priority",
      name: "Legacy time priority pricing",
      enabled: 0,
      status: "active",
      provider_json: providerJson,
      created_at: exportedAt,
      updated_at: exportedAt,
    });
    tables.pricing_releases.push({
      id: releaseId,
      version_ids_json: JSON.stringify([versionId]),
      // Release zones are UTC by platform contract (the deployment check
      // rejects anything else); the legacy clocks were stored as UTC above.
      time_zone: "UTC",
      created_at: exportedAt,
    });
    tables.pricing_release_heads.push({ release_id: releaseId });
    for (const session of tables.sessions) {
      if (session.payment_status === "unpaid") {
        tables.session_pricing_releases.push({
          session_id: session.id as string,
          release_id: releaseId,
        });
      }
    }
  }

  const recordsByUser = new Map<number, NeoBillingRecord[]>();
  for (const record of snapshot.billingRecords ?? []) {
    const key = Number(record.userId);
    const list = recordsByUser.get(key) ?? [];
    list.push(record);
    recordsByUser.set(key, list);
  }
  for (const session of snapshot.sessions ?? []) {
    if (!session.closedAt || session.finalCost === null || session.finalCost === undefined) continue;
    const sessionId = legacySessionId(session.id);
    const from = new Date(iso(session.createdAt)!).getTime();
    const to = new Date(iso(session.closedAt)!).getTime();
    const sessionRecords = (recordsByUser.get(Number(session.userId)) ?? []).filter((record) => {
      const start = new Date(normalizePrismNeoTimestamp(String(record.billingStart))).getTime();
      const end = new Date(normalizePrismNeoTimestamp(String(record.billingEnd))).getTime();
      return start >= from && end <= to;
    });
    const subtotal =
      session.billingCost === null || session.billingCost === undefined
        ? sessionRecords.reduce((sum, record) => sum + cents(parseLegacyNumber(record.cost)), 0)
        : cents(parseLegacyNumber(session.billingCost));
    const total = cents(parseLegacyNumber(session.finalCost));
    const chargeItems = (
      sessionRecords.length
        ? sessionRecords.map((record) => ({
            id: `legacy:billing-record:${record.id}`,
            source: `legacy.billing-rule.${record.ruleId}`,
            label: `Legacy billing record ${record.id}`,
            amount: cents(parseLegacyNumber(record.cost)),
          }))
        : [
            {
              id: `legacy:session-charge:${session.id}`,
              source: "legacy.session",
              label: "Legacy session charge",
              amount: subtotal,
            },
          ]
    ).map((item, index) => ({ ...item, item_order: index, session_id: sessionId }));
    tables.settlements.push({
      id: `legacy:settlement:${sessionId}`,
      session_id: sessionId,
      checkout_id: null,
      subtotal,
      total,
      status: "settled",
      settled_at: iso(session.closedAt)!,
    });
    tables.settlement_charge_items.push(...chargeItems);
    if (total !== subtotal) {
      tables.settlement_adjustments.push({
        id: `legacy:session-cost-delta:${session.id}`,
        session_id: sessionId,
        adjustment_order: 0,
        source: "legacy.session",
        label: "Legacy final cost delta",
        amount: total - subtotal,
      });
    }
  }

  for (const record of snapshot.billingRecords ?? []) {
    tables.pricing_history_entries.push({
      id: `legacy:billing-record:${record.id}`,
      player_id: legacyUserId(record.userId),
      pricing_config_id: configId,
      provider_id: "legacy.time-priority",
      rule_id: `legacy.rule.${record.ruleId}`,
      rule_anchor_at: anchorOf(record.ruleStartTimeStamp),
      session_id: `legacy:billing-record:${record.id}`,
      amount: cents(parseLegacyNumber(record.cost)),
      created_at: normalizePrismNeoTimestamp(String(record.billingEnd)),
      metadata_json: JSON.stringify({
        legacy: {
          billingStart: normalizePrismNeoTimestamp(String(record.billingStart)),
          billingEnd: normalizePrismNeoTimestamp(String(record.billingEnd)),
          durationMin: record.durationMin,
          ruleStartTimeStamp: String(record.ruleStartTimeStamp),
        },
      }),
    });
  }

  const definitionsById = new Map(
    (snapshot.assetDefinitions ?? []).map((d) => [Number(d.id), d] as const),
  );
  for (const present of snapshot.presents ?? []) {
    const grants = (parseLegacyJson(present.body) as NeoPresentGrant[]).map((grant) => {
      const resolved = resolveGrantAsset(grant, definitionsById);
      const mapped = mapLegacyAsset(resolved.type, resolved.assetId);
      return {
        assetType: mapped.type,
        assetCode: mapped.code,
        amount: grant.count === undefined || grant.count === null ? 1 : parseLegacyNumber(grant.count),
        mergeStrategy: toMergeStrategy(grant.mergeStrategy),
        activeAt: iso(grant.activeAt),
        expiresAt: iso(grant.expireAt),
      };
    });
    tables.presents.push({
      id: `legacy:present:${present.id}`,
      name: present.name,
      once_per_player: parseLegacyBoolean(present.oncePerUser) ? 1 : 0,
      status: "active",
      active_at: null,
      expires_at: null,
      grants_json: JSON.stringify(grants),
    });
  }

  for (const redeem of snapshot.redeems ?? []) {
    tables.redeem_codes.push({
      id: `legacy:redeem:${redeem.id}`,
      code: redeem.code,
      present_id: `legacy:present:${redeem.presentId}`,
      active_at: iso(redeem.activeAt),
      expires_at: iso(redeem.expireAt),
      max_use_count: parseLegacyNumber(redeem.maxUseCount),
    });
  }
  for (const record of snapshot.redeemRecords ?? []) {
    tables.redeem_records.push({
      id: `legacy:redeem-record:${legacyUserId(record.userId)}:legacy:redeem:${record.redeemId}`,
      player_id: legacyUserId(record.userId),
      code_id: `legacy:redeem:${record.redeemId}`,
      present_id: `legacy:present:${record.presentId}`,
      redeemed_at: iso(record.date)!,
    });
  }

  for (const record of snapshot.coinRecords ?? []) {
    const operationId = `legacy:coin-record:${record.id}`;
    const occurredAt = iso(record.createAt)!;
    const count = parseLegacyNumber(record.count);
    const payload = JSON.stringify({ count, legacyCoinRecordId: record.id });
    tables.device_operations.push({
      id: operationId,
      device_id: record.machineName,
      capability: "hinata_io",
      action: "coin",
      parent_id: null,
      player_id: legacyUserId(record.userId),
      staff_id: null,
      status: "succeeded",
      counts_as_play: 1,
      failure: null,
      payload_json: payload,
      requested_at: occurredAt,
      settled_at: occurredAt,
      confirmed_at: null,
    });
    tables.device_events.push(
      {
        id: `${operationId}.request`,
        device_id: record.machineName,
        capability: "hinata_io",
        kind: "request",
        name: "coin",
        operation_id: operationId,
        parent_operation_id: null,
        origin: "platform",
        player_id: legacyUserId(record.userId),
        staff_id: null,
        payload_json: payload,
        occurred_at: occurredAt,
      },
      {
        id: `${operationId}.result`,
        device_id: record.machineName,
        capability: "hinata_io",
        kind: "result",
        name: "coin",
        operation_id: operationId,
        parent_operation_id: null,
        origin: "platform",
        player_id: legacyUserId(record.userId),
        staff_id: null,
        payload_json: JSON.stringify({ outcome: "ok" }),
        occurred_at: occurredAt,
      },
    );
  }

  return {
    format: "prism-shop-data",
    version: 3,
    scope: "business",
    exportedAt,
    source: { publicId: "prism-neo", name: options.shopName || "prism-neo", timeZone },
    storage: { timeZone: "UTC", money: "minor-units" },
    settings: {
      billingEnabled: false,
      cashierEnabled: false,
      autoRegister: true,
      identityBindingRequired: false,
      checkinGeo: false,
      checkoutGeo: false,
      machineGeo: false,
      entryPricingIds: neoRules.length ? [configId] : [],
      botContact: "",
      coinCooldownMs: 60_000,
      defaultPresentId: null,
    },
    shopProfile: {
      // The paged importer overwrites the shop profile from this block; keep
      // the target's identity by reusing its name and coordinates.
      name: options.shopName || "prism-neo",
      latitude: 0,
      longitude: 0,
      radiusMeters: 80,
      heroData: null,
    },
    counts: Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.length])),
    tables,
  };
}
