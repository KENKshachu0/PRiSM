import { createD1Repositories } from "@prism/adapter-d1";
import { billEventLabel, billEvents, previewBillTimeline } from "@prism/application";
import {
  addCents,
  canStartPriorityTimePricingSession,
  chargeUnitChargedAt,
  compareCents,
  isPositiveCents,
  maxCents,
  nextTimePricingEvent,
  settleTimeCapWindows,
  subCents,
  ZERO_CENTS,
  type Cents,
  type ChargeItem,
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
  const current = await calculateActivityBill(env, shopId, playerId, now);
  const snapshot = current?.snapshot ?? null;
  const boundary = snapshot?.nextCheckAt;
  if (!current || !snapshot || snapshot.endedAtUnix !== null || !boundary || boundary <= now.getTime()
    || boundary > now.getTime() + 8 * 3600_000) return snapshot;
  // Forecast exactly one known boundary with the same engine, never a client rate.
  try {
    const next = await calculateActivityBill(env, shopId, playerId, new Date(boundary));
    if (!next || next.snapshot.endedAtUnix !== null || next.snapshot.startedAtUnix !== snapshot.startedAtUnix) return snapshot;
    // What the bill will newly say by then names the next event, such as a cap filling instead of a
    // charge. A cap fills at the unit it stopped, which began before it was counted.
    const known = new Set(current.events.map(event => `${event.at.toISOString()} ${event.label}`));
    const arriving = next.events.filter(event => event.at.getTime() <= boundary && !known.has(`${event.at.toISOString()} ${event.label}`));
    const nextEvent = snapshot.bill.nextEvent && arriving.length
      ? { ...snapshot.bill.nextEvent, label: billEventLabel([snapshot.bill.nextEvent.label, ...arriving.map(event => event.label)])! }
      : snapshot.bill.nextEvent;
    return { ...snapshot, bill: { ...snapshot.bill, nextEvent }, nextBill: next.snapshot.bill };
  } catch {
    // A forecast must not make the current bill or checkout unavailable.
    console.warn("Live bill forecast unavailable");
    return snapshot;
  }
}

/**
 * The bill as the live activity shows it, at `now`: the amount, and the events
 * either side of now as the bill's timeline has them (a charge, a rule change, a
 * cap filling or ending, the start or end). A plan counts as capped while the
 * bill draws it capped, which is what was actually charged after every cap.
 */
async function calculateActivityBill(
  env: Pick<Env, "DB">,
  shopId: string,
  playerId: string,
  now: Date,
): Promise<{ snapshot: ActivitySnapshot; events: { at: Date; label: string }[] } | null> {
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
      COALESCE(b.auto_register, 0) AS auto_register,
      COALESCE(b.identity_binding_required, 1) AS identity_binding_required,
      COALESCE((SELECT json_extract(value_json, '$.enabled') FROM app_settings WHERE shop_id = s.id AND key = 'cashier.settings'), 0) AS cashier_enabled,
      COALESCE(b.checkin_geo, 0) AS checkin_geo,
      COALESCE(b.checkout_geo, 0) AS checkout_geo,
      COALESCE(b.machine_geo, 0) AS machine_geo,
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
    cashier_enabled: 0,
    auto_register: 0,
    identity_binding_required: 1,
    checkin_geo: 0,
    checkout_geo: 0,
    machine_geo: 0,
    bot_contact: "",
    time_zone: "Asia/Shanghai",
    hero_url: null,
  };

  const preview = await createShopDependencies({
    db: env.DB,
    shop,
    now: () => now,
  }).playerCheckoutCommands.previewCheckout({ playerId });
  const timeline = previewBillTimeline(preview);
  const events = billEvents(timeline);
  // Each plan a full cap keeps from charging, until when.
  const cappedUntil = new Map<string, number>();
  for (const event of timeline.events) for (const entry of event.entries) {
    if (entry.kind !== "full" || !entry.until || Date.parse(event.at) > now.getTime()) continue;
    const until = Date.parse(entry.until);
    if (until <= now.getTime()) continue;
    for (const trackId of entry.trackIds ?? []) cappedUntil.set(trackId, Math.max(cappedUntil.get(trackId) ?? 0, until));
  }

  const releases = new Map<
    string,
    { configs: PricingConfig[]; timeZone: string }
  >();
  const labels = new Set<string>();
  const candidates: { at: number; label: string }[] = [];
  const tracks: string[] = [];
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
      if (config.kind === "time.cap") continue;
      if (session.pricingConfigIds?.length && !session.pricingConfigIds.includes(config.id)) continue;
      if (config.kind === "charge.fixed") {
        labels.add(config.name);
        continue;
      }
      const trackId = `${session.id}:${config.id}`;
      tracks.push(trackId);
      const capped = cappedUntil.get(trackId);
      if (capped !== undefined) candidates.push({ at: capped, label: "封顶结束" });
      const provider = { ...config.provider, timeZone: config.provider.timeZone ?? release.timeZone };
      if (config.kind === "time.priority") {
        billableNow.push(canStartPriorityTimePricingSession({
          config: provider as Extract<PricingConfig, { kind: "time.priority" }>["provider"],
          at: now,
        }));
      }
      const next = nextTimePricingEvent({ config: provider, session, now, intervalCapReached: capped !== undefined });
      if (next.ruleLabel) labels.add(`${config.name}（${next.ruleLabel}）`);
      if (next.chargeAt) candidates.push({ at: next.chargeAt.getTime(), label: "下次计费" });
      if (next.ruleAt) {
        // Named as the bill will name it: the same rule's next window, another rule, or no rule.
        const after = nextTimePricingEvent({ config: provider, session, now: next.ruleAt }).ruleLabel;
        candidates.push({
          at: next.ruleAt.getTime(),
          label: after === null ? "结束计费" : after === next.ruleLabel ? "新的一天" : "切换计费规则",
        });
      }
    }
  }

  const nextCheckAt = candidates.reduce((min, candidate) => Math.min(min, candidate.at), Infinity);
  const nextEvent: ActivityNextEvent | null = candidates.length
    ? {
        atUnix: nextCheckAt / 1000,
        label: billEventLabel(candidates.filter((candidate) => candidate.at === nextCheckAt).map((candidate) => candidate.label))!,
      }
    : null;

  // Nothing more is charged once every plan is capped; otherwise the tightest cap
  // across plans still counting a plan that charges, by what it has counted.
  let remainingToCapCents: Cents | undefined;
  const charging = tracks.filter((track) => !cappedUntil.has(track));
  if (tracks.length && !charging.length) remainingToCapCents = ZERO_CENTS;
  else {
    const headrooms = preview.globalCapWindows
      .filter((window) => window.windowStartedAt <= now && window.windowEndedAt > now
        && window.contributions.some((item) => charging.includes(`${item.sessionId}:${item.pricingConfigId}`)))
      .map((window) => subCents(window.priceCap, addCents(window.paidBefore, window.amountApplied)));
    if (headrooms.length) {
      remainingToCapCents = maxCents(
        headrooms.reduce((min, value) => (compareCents(value, min) < 0 ? value : min)),
        ZERO_CENTS,
      );
    }
  }
  const billable =
    active.length === 0
      ? undefined
      : billableNow.length === 0
      ? true
      : billableNow.some((value) => value);

  // The last event so far: one of the bill's, or a unit being charged.
  const sessions = new Map(unpaid.map((session) => [session.id, session]));
  const items = preview.sessionPreviews.flatMap((entry) =>
    entry.chargeItems.map((item): ChargeItem => (item.sessionId ? item : { ...item, sessionId: entry.sessionId })));
  const previousAt: { at: number; label: string }[] = events
    .filter((event) => event.at <= now)
    .map((event) => ({ at: event.at.getTime(), label: event.label }));
  const chargedAt = new Map<ChargeItem, Date[] | null>();
  for (const unit of settleTimeCapWindows(preview.globalCapWindows, items).units) {
    if (!isPositiveCents(unit.charged)) continue;
    if (!chargedAt.has(unit.item)) {
      const session = sessions.get(unit.item.sessionId ?? "");
      const plan = unit.item.pricingExplanation?.pricingConfigId;
      // The device being used waives the grace of the plan's first charge, as the quote does.
      const waived = Boolean(session?.metadata?.deviceOperated || session?.metadata?.hasDeviceActivity)
        && !items.some((prior) => prior.sessionId === unit.item.sessionId && prior.pricingExplanation?.pricingConfigId === plan
          && prior.period && unit.item.period && prior.period.startedAt < unit.item.period.startedAt && isPositiveCents(prior.amount));
      chargedAt.set(unit.item, chargeUnitChargedAt(unit.item, waived));
    }
    const at = chargedAt.get(unit.item)?.[unit.index];
    if (at && at <= now) previousAt.push({ at: at.getTime(), label: "计费" });
  }
  const latest = previousAt.reduce((max, event) => Math.max(max, event.at), -Infinity);
  const previousEvent: ActivityNextEvent | null = Number.isFinite(latest)
    ? { atUnix: latest / 1000, label: billEventLabel(previousAt.filter((event) => event.at === latest).map((event) => event.label))! }
    : null;

  const names = [...labels];
  const bill: ActivityBill = {
    amountCents: preview.settlementPreview.total,
    planLabel: (
      names.slice(0, 2).join(" · ") +
      (names.length > 2 ? ` 等 ${names.length} 项` : "")
    ).slice(0, 160),
    nextEvent,
    previousEvent,
    asOfUnix: now.getTime() / 1000,
    ...(remainingToCapCents !== undefined ? { remainingToCapCents } : {}),
    ...(billable !== undefined ? { billable } : {}),
  };

  return {
    events,
    snapshot: {
      bill,
      nextCheckAt: Number.isFinite(nextCheckAt) ? nextCheckAt : null,
      endedAtUnix: active.length
        ? null
        : Math.max(
            ...unpaid.map((session) => (session.endedAt ?? now).getTime()),
          ) / 1000,
      startedAtUnix:
        Math.min(...unpaid.map((session) => session.startedAt.getTime())) / 1000,
    },
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
