import type { Cents } from "./money";

/**
 * Membership is an ordinary shop asset: a membership card is an asset
 * definition of this type, and whatever pricing effect it binds is the member
 * benefit. There is no second discount engine and no hidden system card.
 */
export const MEMBER_ASSET_TYPE = "membership";
/** The card catalogue and sale plans for one shop. */
export const MEMBER_PROGRAM_KEY = "membership.program";
/** Which plan each resource group / resource uses for members. */
export const MEMBER_RESOURCE_PLANS_KEY = "membership.resource_plans";

export type MemberPlanStatus = "active" | "archived";

/** One purchasable duration of a membership card. */
export type MemberPlan = {
  id: string;
  name: string;
  /** The membership asset definition this plan grants. */
  assetCode: string;
  /** Stored in cents; the API converts to yuan at its boundary. */
  price: Cents;
  durationDays: number;
  status: MemberPlanStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type MemberProgram = {
  enabled: boolean;
  plans: MemberPlan[];
};

export type MemberStatus = {
  /** True while the programme is enabled and an unexpired card is held. */
  active: boolean;
  enabled: boolean;
  /** The card the status was read from; null when there is no valid card. */
  assetCode: string | null;
  cardName: string | null;
  /** The card's percentage effect, for display; null for other effects. */
  discountPercent: number | null;
  expiresAt: Date | null;
};

/** Resource-group / resource ids mapped to the plan members bill there. */
export type MemberResourcePlans = {
  groups: Record<string, string>;
  resources: Record<string, string>;
};

export function isMemberAsset(assetType: string): boolean {
  return assetType === MEMBER_ASSET_TYPE;
}

export function memberDurationMs(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}
