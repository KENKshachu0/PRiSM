import type { D1DatabaseLike } from "@prism/adapter-d1";
import {
  MEMBER_RESOURCE_PLANS_KEY,
  type MemberResourcePlans,
} from "@prism/core";
import { resourceGroupIdOf, type BillableResource } from "./billing.js";

const EMPTY: MemberResourcePlans = { groups: {}, resources: {} };

/** The member-plan mapping lives in app_settings, so backups already carry it. */
export async function readMemberResourcePlans(
  db: D1DatabaseLike,
  shopId: string,
): Promise<MemberResourcePlans> {
  const row = await db.prepare(
    "SELECT value_json FROM app_settings WHERE shop_id = ? AND key = ?",
  ).bind(shopId, MEMBER_RESOURCE_PLANS_KEY).first<{ value_json: string }>();
  if (!row) return { ...EMPTY };
  try {
    return normalizeMemberResourcePlans(JSON.parse(row.value_json));
  } catch {
    return { ...EMPTY };
  }
}

export async function writeMemberResourcePlans(
  db: D1DatabaseLike,
  shopId: string,
  plans: MemberResourcePlans,
): Promise<void> {
  await db.prepare(
    `INSERT INTO app_settings(shop_id, key, value_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(shop_id, key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at`,
  ).bind(
    shopId,
    MEMBER_RESOURCE_PLANS_KEY,
    JSON.stringify(normalizeMemberResourcePlans(plans)),
    new Date().toISOString(),
  ).run();
}

/** Sets one group's or resource's member plan; null clears it. */
export async function setMemberResourcePlan(
  db: D1DatabaseLike,
  shopId: string,
  kind: "group" | "resource",
  id: string,
  planId: string | null,
): Promise<void> {
  const plans = await readMemberResourcePlans(db, shopId);
  const bucket = kind === "group" ? plans.groups : plans.resources;
  if (planId) bucket[id] = planId;
  else delete bucket[id];
  await writeMemberResourcePlans(db, shopId, plans);
}

/** The member plan this resource bills, before falling back to its normal plan. */
export function memberPlanForResource(
  plans: MemberResourcePlans,
  resource: BillableResource,
): string | null {
  return plans.resources[resource.id]
    ?? plans.groups[resourceGroupIdOf(resource)]
    ?? null;
}

function normalizeMemberResourcePlans(value: unknown): MemberResourcePlans {
  const record = isRecord(value) ? value : {};
  return {
    groups: stringRecord(record.groups),
    resources: stringRecord(record.resources),
  };
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].length > 0),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
