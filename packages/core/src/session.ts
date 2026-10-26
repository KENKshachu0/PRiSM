import { PrismDomainError } from "./errors";

/** The plan id an unpriced shop's sessions carry; it bills nothing. */
export const PLACEHOLDER_PRICING_CONFIG_ID = "default";

export type SessionPaymentStatus = "unpaid" | "paid";

export type Session = {
  id: string;
  playerId: string;
  startedAt: Date;
  endedAt?: Date;
  status?: "active" | "closed";
  pricingConfigIds?: string[];
  /**
   * The one plan this session bills, used to start, stop and deduplicate it.
   *
   * Absent on placeholder sessions of unpriced shops and on historical rows that
   * billed several plans at once; nothing infers it from `label` or `metadata`.
   */
  pricingConfigId?: string;
  pricingReleaseId?: string;
  paymentStatus?: SessionPaymentStatus;
  label?: string;
  metadata?: Record<string, unknown>;
};

export type StartSessionInput = {
  playerId: string;
  now: Date;
  id: string;
  /** Exactly one plan; `pricingConfigIds` remains for callers not yet moved. */
  pricingConfigId?: string;
  pricingConfigIds?: string[];
  label?: string;
  metadata?: Record<string, unknown>;
};

export type CloseSessionInput = {
  session: Session;
  now: Date;
};

export function startSession(input: StartSessionInput): Session & { status: "active" } {
  const pricingConfigIds = input.pricingConfigId ? [input.pricingConfigId] : input.pricingConfigIds ?? [];
  if (pricingConfigIds.length === 0) {
    throw new PrismDomainError("Session must be started with a pricing plan.", "PRICING_CONFIG_REQUIRED");
  }
  if (pricingConfigIds.length > 1) {
    throw new PrismDomainError("A session bills exactly one pricing plan.", "PRICING_CONFIG_SINGLE_PLAN_REQUIRED");
  }
  const [pricingConfigId] = pricingConfigIds;

  return {
    id: input.id,
    playerId: input.playerId,
    startedAt: input.now,
    status: "active",
    pricingConfigIds,
    ...(pricingConfigId !== PLACEHOLDER_PRICING_CONFIG_ID ? { pricingConfigId } : {}),
    paymentStatus: "unpaid",
    label: input.label,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

export function closeSession(input: CloseSessionInput): Session & { status: "closed"; endedAt: Date } {
  if (input.session.status !== "active") {
    throw new PrismDomainError("Session is not active.", "SESSION_NOT_ACTIVE");
  }

  return {
    ...input.session,
    endedAt: input.now,
    status: "closed",
  };
}
