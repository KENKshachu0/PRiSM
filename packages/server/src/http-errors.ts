import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { PrismDomainError } from "@prism/core";

const NOT_FOUND = new Set([
  "CHECKOUT_NOT_FOUND",
  "SESSION_NOT_FOUND",
  "PLAYER_NOT_FOUND",
  "PLAYER_IDENTITY_NOT_FOUND",
  "PRICING_CONFIG_NOT_FOUND",
  "INTEGRATION_SESSION_NOT_FOUND",
  "SHOP_NOT_FOUND",
]);
const CONFLICT = new Set(["INSUFFICIENT_BALANCE", "CHECKIN_CONSENT_REQUIRED", "PRISM_ALREADY_INSTALLED", "PRICING_PLAN_ALREADY_ACTIVE", "PRICING_CONFIG_IN_USE", "PRICING_STATE_REVISION_MISMATCH", "RESOURCE_NOT_BILLED"]);

/** The HTTP status for a domain error code. */
export function domainErrorStatus(code: string): number {
  if (NOT_FOUND.has(code)) return 404;
  if (code === "UNAUTHORIZED") return 401;
  if (code === "FORBIDDEN") return 403;
  if (CONFLICT.has(code)) return 409;
  return 400;
}

/**
 * The one way a thrown error becomes a response, shared by every router so a
 * code means the same status everywhere. What the player reads is decided
 * later, from the code, when the response is wrapped.
 */
export function errorResponse(c: Context<any>, err: unknown, scope: string): Response {
  if (err instanceof Response) return err;
  if (err instanceof HTTPException) return err.getResponse();
  if (err instanceof PrismDomainError) {
    return c.json({ error: { code: err.code, message: err.message } }, domainErrorStatus(err.code) as never);
  }
  if (err instanceof z.ZodError) {
    return c.json(
      { error: { code: "VALIDATION_FAILED", message: err.issues?.[0]?.message || "Validation failed", details: err.issues } },
      422,
    );
  }
  console.error(`[${scope}] unhandled error:`, err);
  return c.json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } }, 500);
}
