import { createD1Repositories } from "@prism/adapter-d1";
import {
  addCents,
  canStartPriorityTimePricingSession,
  compareCents,
  maxCents,
  nextTimePricingEvent,
  previousBillingEvent,
  subCents,
  ZERO_CENTS,
  type Cents,
  type PricingConfig,
} from "@prism/core";
import { ensureD1UtcPricing } from "../utc-pricing.js";
import { createShopDependencies } from "../middleware/tenant.js";
import type { Env, TenantShop } from "../bindings.js";
import { liveActivityConfig } from "./live-activity-push.js";

export type ActivityNextEvent = {
  atUnix: number;
  label: string;
};

export type ActivityBill = {
  amountCents: number;
  planLabel: string;
  nextEvent: ActivityNextEvent | null;
  /** Last resolved pricing/rule/session event. Refresh timestamps are not events. */
  previousEvent?: ActivityNextEvent | null;
  asOfUnix: number;
  /** Amount still chargeable before the effective cap: the minimum over every
   *  cap window covering `now` that this session contributes to. 0 means capped.
   *  Omitted when no cap is in force, so the client can tell "capped" from "no
   *  cap configured" instead of having to guess. */
  remainingToCapCents?: Cents;
  /** False while no stacked plan of the visit is billable ("非营业") at this
   *  moment. Omitted once every session is closed, because billing is over and
   *  the question no longer applies. */
  billable?: boolean;
};

type ActivitySnapshot = {
  bill: ActivityBill;
  nextBill?: ActivityBill;
  nextCheckAt: number | null;
  endedAtUnix: number | null;
  startedAtUnix: number;
};

export async function activityBill(
  env: Pick<Env, "DB">,
  shopId: string,
  playerId: string,
  now = new Date(),
): Promise<ActivitySnapshot | null> {
  const snapshot = await calculateActivityBill(env, shopId, playerId, now);
  const boundary = snapshot?.nextCheckAt;
  if (!snapshot || snapshot.endedAtUnix !== null || !boundary || boundary <= now.getTime()
    || boundary > now.getTime() + 8 * 3600_000) return snapshot;
  // Forecast exactly one known boundary with the same engine, never a client rate.
  try {
    const next = await calculateActivityBill(env, shopId, playerId, new Date(boundary));
    return { ...snapshot, ...(next && next.endedAtUnix === null
      && next.startedAtUnix === snapshot.startedAtUnix ? { nextBill: next.bill } : {}) };
  } catch {
    // A forecast must not make the current bill or checkout unavailable.
    console.warn("Live bill forecast unavailable");
    return snapshot;
  }
}

async function calculateActivityBill(
  env: Pick<Env, "DB">,
  shopId: string,
  playerId: string,
  now: Date,
) {
  await ensureD1UtcPricing(env.DB, now);
  const repos = createD1Repositories({
    db: env.DB,
    shopId,
    now: () => now,
    id: crypto.randomUUID,
  });
  const active = await repos.sessions.findActiveByPlayerId(playerId);
  const unpaid = [
    ...active,
    ...(await repos.sessions.findUnpaidClosedByPlayerId(playerId)),
  ];
  if (!unpaid.length) return null;

  const rawShop = await env.DB.prepare(
    `SELECT s.id, s.public_id, s.name, s.latitude, s.longitude, s.radius_meters,
      COALESCE(b.billing_enabled, 0) AS billing_enabled,
      COALESCE(b.auto_register, 0) AS auto_register,
      COALESCE(b.identity_binding_required, 1) AS identity_binding_required,
      COALESCE((SELECT json_extract(value_json, '$.enabled') FROM app_settings WHERE shop_id = s.id AND key = 'cashier.settings'), 0) AS cashier_enabled,
      COALESCE(b.checkin_geo, 0) AS checkin_geo,
      COALESCE(b.checkout_geo, 0) AS checkout_geo,
      COALESCE(b.machine_geo, 0) AS machine_geo,
      COALESCE(b.entry_pricing_ids_json, '[]') AS entry_pricing_ids_json,
      COALESCE(b.bot_contact, '') AS bot_contact,
      CASE WHEN s.hero_data IS NULL OR s.hero_data = '' THEN NULL ELSE '/api/v1/shops/' || s.public_id || '/hero?v=' || COALESCE(s.hero_hash, 'original') END AS hero_url,
      COALESCE((SELECT json_extract(value_json, '$.timeZone') FROM app_settings WHERE shop_id = s.id AND key = 'store.profile'), 'Asia/Shanghai') AS time_zone
    FROM shops s
    LEFT JOIN shop_billing_settings b ON b.shop_id = s.id
    WHERE s.public_id = ? OR s.id = ?`,
  )
    .bind(shopId, shopId)
    .first<TenantShop>();

  const shop: TenantShop = rawShop ?? {
    id: shopId,
    public_id: shopId,
    name: shopId,
    latitude: 0,
    longitude: 0,
    radius_meters: 0,
    billing_enabled: 1,
    cashier_enabled: 0,
    auto_register: 0,
    identity_binding_required: 1,
    checkin_geo: 0,
    checkout_geo: 0,
    machine_geo: 0,
    entry_pricing_ids_json: "[]",
    bot_contact: "",
    time_zone: "Asia/Shanghai",
    hero_url: null,
  };

  const preview = await createShopDependencies({
    db: env.DB,
    shop,
    now: () => now,
  }).playerCheckoutCommands.previewCheckout({ playerId });
  const releases = new Map<
    string,
    { configs: PricingConfig[]; timeZone: string }
  >();
  const labels = new Set<string>();
  const candidates: { at: number; label: string }[] = [];
  const ruleBoundaries: Date[] = [];
  const capHeadrooms: Cents[] = [];
  const billableNow: boolean[] = [];

  for (const session of active) {
    const key = session.pricingReleaseId ?? "legacy";
    if (!releases.has(key)) {
      const release = session.pricingReleaseId
        ? await repos.pricingConfigs.findRelease!(session.pricingReleaseId)
        : null;
      if (session.pricingReleaseId && !release) {
        throw new Error("Pinned pricing release not found");
      }
      releases.set(
        key,
        release ?? {
          configs: await repos.pricingConfigs.listEnabled(),
          timeZone: "UTC",
        },
      );
    }
    const release = releases.get(key)!;
    for (const config of release.configs.filter(
      (config) => config.enabled && config.status !== "archived",
    )) {
      if (
        config.kind !== "time.cap" &&
        session.pricingConfigIds?.length &&
        !session.pricingConfigIds.includes(config.id)
      ) {
        continue;
      }
      if (config.kind === "charge.fixed") {
        labels.add(config.name);
        continue;
      }
      if (
        config.kind === "time.cap" &&
        !config.provider.includedPricingConfigIds.some((id) =>
          session.pricingConfigIds?.includes(id),
        )
      ) {
        continue;
      }
      const segment = preview.chargeItems
        .filter(
          (item) =>
            item.sessionId === session.id &&
            item.pricingExplanation?.pricingConfigId === config.id,
        )
        .at(-1);
      const globallyCapped = preview.globalCapWindows.some(
        (window) =>
          window.windowStartedAt <= now &&
          window.windowEndedAt > now &&
          window.paidBefore + window.currentAmount >= window.priceCap &&
          window.contributions.some(
            (item) =>
              item.sessionId === session.id &&
              item.pricingConfigId === config.id,
          ),
      );
      if (config.kind === "time.cap") {
        for (const window of preview.globalCapWindows ?? []) {
          const inForce =
            window.windowStartedAt <= now && window.windowEndedAt > now;
          const involves = window.contributions.some(
            (item) =>
              item.sessionId === session.id &&
              (session.pricingConfigIds ?? []).includes(item.pricingConfigId),
          );
          if (inForce && involves) {
            capHeadrooms.push(
              subCents(
                window.priceCap,
                addCents(window.paidBefore, window.currentAmount),
              ),
            );
          }
        }
      }
      if (config.kind === "time.priority") {
        const priority = config as Extract<
          PricingConfig,
          { kind: "time.priority" }
        >;
        billableNow.push(
          canStartPriorityTimePricingSession({
            config: {
              ...priority.provider,
              timeZone: priority.provider.timeZone ?? release.timeZone,
            },
            at: now,
          }),
        );
      }
      const next = nextTimePricingEvent({
        config: {
          ...config.provider,
          timeZone: config.provider.timeZone ?? release.timeZone,
        },
        session,
        now,
        intervalCapReached:
          segment?.pricingExplanation?.intervalCapReached || globallyCapped,
        intervalStartedAt: globallyCapped
          ? undefined
          : segment?.period?.startedAt,
      });
      ruleBoundaries.push(next.intervalStartedAt);
      if (config.kind !== "time.cap" && next.ruleLabel) {
        labels.add(`${config.name}（${next.ruleLabel}）`);
      }
      if (next.chargeAt) {
        candidates.push({ at: next.chargeAt.getTime(), label: "下次计费" });
      }
      if (next.ruleAt) {
        candidates.push({ at: next.ruleAt.getTime(), label: "规则切换" });
      }
    }
  }

  const nextCheckAt = candidates.reduce(
    (min, candidate) => Math.min(min, candidate.at),
    Infinity,
  );
  let nextEvent: ActivityNextEvent | null = null;
  if (candidates.length) {
    const earliest = candidates.reduce((a, b) => (b.at < a.at ? b : a));
    const earliestLabels = new Set(
      candidates
        .filter((candidate) => candidate.at === earliest.at)
        .map((candidate) => candidate.label),
    );
    nextEvent = {
      atUnix: earliest.at / 1000,
      label: earliestLabels.size > 1 ? "计费与规则切换" : earliest.label,
    };
  }

  let remainingToCapCents: Cents | undefined;
  if (capHeadrooms.length) {
    const tightest = capHeadrooms.reduce((min, value) =>
      compareCents(value, min) < 0 ? value : min,
    );
    remainingToCapCents = maxCents(tightest, ZERO_CENTS);
  }
  const billable =
    active.length === 0
      ? undefined
      : billableNow.length === 0
      ? true
      : billableNow.some((value) => value);

  const names = [...labels];
  const previous = previousBillingEvent({
    now,
    sessions: unpaid,
    chargeItems: preview.chargeItems,
    globalCapWindows: preview.globalCapWindows,
    ruleBoundaries,
  });

  const bill: ActivityBill = {
    amountCents: preview.settlementPreview.total,
    planLabel: (
      names.slice(0, 2).join(" · ") +
      (names.length > 2 ? ` 等 ${names.length} 项` : "")
    ).slice(0, 160),
    nextEvent,
    previousEvent: previous
      ? { atUnix: previous.at.getTime() / 1000, label: previous.label }
      : null,
    asOfUnix: now.getTime() / 1000,
    ...(remainingToCapCents !== undefined ? { remainingToCapCents } : {}),
    ...(billable !== undefined ? { billable } : {}),
  };

  return {
    bill,
    nextCheckAt: Number.isFinite(nextCheckAt) ? nextCheckAt : null,
    endedAtUnix: active.length
      ? null
      : Math.max(
          ...unpaid.map((session) => (session.endedAt ?? now).getTime()),
        ) / 1000,
    startedAtUnix:
      Math.min(...unpaid.map((session) => session.startedAt.getTime())) / 1000,
  };
}

export async function refreshActivityBill(
  env: Env,
  shopId: string,
  playerId: string,
  terminal = false,
  urgent = false,
) {
  if (!env.LIVE_BILLING || !liveActivityConfig(env)) return;
  const token = await env.DB.prepare(
    `SELECT t.id FROM live_activity_tokens t
    JOIN shop_player_accounts a ON a.shop_id=t.shop_id AND a.user_id=t.user_id
    WHERE t.shop_id=? AND a.player_id=? AND t.session_id IS NOT NULL LIMIT 1`,
  )
    .bind(shopId, playerId)
    .first();
  if (!token) return;
  const liveBillingNs = env.LIVE_BILLING as unknown as {
    getByName(name: string): {
      refresh(shopId: string, playerId: string, terminal?: boolean, urgent?: boolean): Promise<void>;
    };
  } | undefined;
  if (!liveBillingNs) return;
  await liveBillingNs
    .getByName(JSON.stringify([shopId, playerId]))
    .refresh(shopId, playerId, terminal, urgent);
}
