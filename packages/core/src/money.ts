/**
 * Money and quantity arithmetic for PRiSM.
 *
 * Every monetary amount in PRiSM is expressed in yuan (元) and persisted in a
 * SQLite/D1 `REAL` column, i.e. an IEEE-754 binary double. Binary floating point
 * cannot represent most decimal fractions exactly: `0.06` is stored as
 * `0.059999999999999998` and `0.07` as `0.070000000000000007`, so
 * `0.01 + 0.06 < 0.07` evaluates to `true`.
 *
 * A 1e-17 error is harmless on its own. It only becomes a business defect where
 * the code turns it into a yes/no decision, and the codebase had three such
 * places:
 *
 *   - `available < amount`  → refuses a payment the player can afford
 *   - `quantity > 0`        → keeps an unspendable float residue alive forever
 *   - `amount === 0`        → misses an early return that should have fired
 *
 * This module centralises the two rules that make such decisions safe:
 *
 *   1. Compare with a tolerance. `isPositiveQuantity`, `isZeroQuantity`,
 *      `isNegativeQuantity` and `compareMoney` never let accumulated noise flip
 *      a branch. Tolerance is the only correct approach because the direction of
 *      the error is not stable — `0.1 + 0.2` overshoots `0.3` while
 *      `0.01 + 0.06` undershoots `0.07`, so no single rounding direction fixes it.
 *   2. Quantise at the arithmetic boundary. `quantizeMoney` snaps a computed
 *      amount to a whole cent, so the value that reaches storage is canonical
 *      and repeated arithmetic on it stays stable.
 *
 * Neither rule discards money. `MONEY_EPSILON` is ten orders of magnitude below
 * one cent (0.01) and seven above the largest noise measured in production data
 * (1.39e-16), so it only ever swallows genuine floating-point residue.
 *
 * See `docs/money.md` for the full rationale, the measured production scan, and
 * the staged plan that this module is stage one of.
 */

import { PrismDomainError } from "./errors";

/** Smallest representable money step. Amounts are modelled in whole cents of yuan. */
export const CENTS_PER_YUAN = 100;

/**
 * Comparison tolerance for money and quantity values.
 *
 * Chosen an order of magnitude above observed float noise (1.39e-16) and far
 * below the smallest meaningful amount (1 cent = 0.01). Do not tighten this to
 * something like 1e-15: residue from repeated subtraction reaches 1e-16..1e-15
 * and would start flipping comparisons again.
 */
export const MONEY_EPSILON = 1e-9;

/**
 * Snaps a computed amount to whole cents of yuan.
 *
 * Use it on the *output* of arithmetic (sums, prorated discounts, deltas) and on
 * values crossing an external boundary (API input, ledger load), never as a
 * replacement for a tolerance comparison on a value that has not been through
 * arithmetic. Non-finite input passes through unchanged so callers keep their
 * existing `Number.isFinite` validation.
 */
export function quantizeMoney(value: number): number {
  if (!Number.isFinite(value)) return value;
  const cents = Math.round(value * CENTS_PER_YUAN);
  // `cents === 0` also normalises negative zero, so callers never have to reason
  // about `-0` versus `0` (they differ under `Object.is`).
  return cents === 0 ? 0 : cents / CENTS_PER_YUAN;
}

/**
 * Collapses floating-point residue to exactly zero and canonicalises the rest to
 * cents. Balances coming back from `a - b` chains go through here so a storage
 * row can actually reach 0 instead of lingering at `1.3877787807814457e-16`.
 */
export function normalizeQuantity(value: number): number {
  if (!Number.isFinite(value)) return value;
  return isZeroQuantity(value) ? 0 : quantizeMoney(value);
}

/** True when `value` is indistinguishable from zero at money precision. */
export function isZeroQuantity(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  return Math.abs(value) <= MONEY_EPSILON;
}

/** True when `value` is meaningfully greater than zero. */
export function isPositiveQuantity(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  return value > MONEY_EPSILON;
}

/** True when `value` is meaningfully less than zero. */
export function isNegativeQuantity(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  return value < -MONEY_EPSILON;
}

/**
 * Orders two amounts after snapping both to cents. Returns `0` when they are the
 * same amount, so callers can write `compareMoney(available, amount) >= 0`
 * instead of `available >= amount`.
 *
 * Non-finite operands are not meaningful money, and callers are expected to
 * validate finiteness before comparing. They are still ordered consistently
 * (`NaN` last, then `+Infinity`) rather than returning an arbitrary result.
 */
export function compareMoney(left: number, right: number): -1 | 0 | 1 {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    if (Number.isNaN(left) && Number.isNaN(right)) return 0;
    if (left === right) return 0;
    if (Number.isNaN(left)) return 1;
    if (Number.isNaN(right)) return -1;
    return left < right ? -1 : 1;
  }

  const difference = quantizeMoney(left) - quantizeMoney(right);
  if (isZeroQuantity(difference)) return 0;
  return difference < 0 ? -1 : 1;
}

/** Sums amounts and quantises the result to whole cents. */
export function sumMoney(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return quantizeMoney(total);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage two: integer units.
//
// Everything above works in yuan and relies on tolerance to survive binary
// floating point. This section removes the tolerance requirement entirely by
// making the unit explicit in the type system:
//
//   Cents — money, an exact integer number of 分 (1/100 yuan)
//   Units — counts of non-currency holdings (tickets, coupons), exact integers
//
// The two brands are deliberately unconvertible. There is no function from
// `Cents` to `Units` or back, because 1 yuan and 1 ticket are not the same kind
// of thing, and the compiler refusing to mix them is the entire point of the
// exercise. Arithmetic on both is exact integer arithmetic, so `a === b` and
// `a < b` mean what they look like and `MONEY_EPSILON` is no longer involved.
//
// Amounts still cross external boundaries in yuan; `centsOf` and `yuanOf` are
// the only sanctioned way through.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An exact amount of money, held as a whole number of 分 (1/100 元).
 *
 * Branded on purpose: a bare `number` is not assignable to it, so a raw value
 * cannot drift into money arithmetic by accident. Construct one with `centsOf`
 * (yuan → cents) or `centsOfInteger` (an already-integral count of cents).
 */
export type Cents = number & { readonly __brand: "Cents" };

/**
 * An exact count of a non-currency holding — tickets, coupons, seats.
 *
 * Kept separate from `Cents` even though both are integers, so that "consume one
 * ticket" can never be written as "subtract one cent".
 */
export type Units = number & { readonly __brand: "Units" };

export const ZERO_CENTS = 0 as Cents;
export const ZERO_UNITS = 0 as Units;

/** How `mulDivRound` resolves an inexact division. There is no default. */
export type RoundingMode =
  | "floor" // toward negative infinity
  | "ceil" // toward positive infinity
  | "trunc" // toward zero
  | "half"; // away from zero on an exact half

/**
 * Converts a yuan amount to exact cents, rounding half away from zero.
 *
 * This is the *input* boundary: API payloads, legacy `REAL` columns, parsed
 * configuration. It always rounds, so a non-cent value such as `10.01001` is
 * absorbed here rather than propagating (see `docs/money.md`).
 */
export function centsOf(yuan: number): Cents {
  if (!Number.isFinite(yuan)) {
    throw new PrismDomainError("Money must be a finite number.", "INVALID_MONEY");
  }
  const scaled = yuan * CENTS_PER_YUAN;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  // `=== 0` also folds `-0` into `0` so downstream equality stays predictable.
  return (rounded === 0 ? 0 : rounded) as Cents;
}

/**
 * Wraps a value that is already an exact count of cents.
 *
 * Use it for values produced by integer arithmetic — never for a yuan amount,
 * which must go through `centsOf` (that mistake is off by a factor of 100).
 */
export function centsOfInteger(value: number): Cents {
  if (!Number.isInteger(value)) {
    throw new PrismDomainError("Cents must be a whole number.", "INVALID_MONEY");
  }
  return (value === 0 ? 0 : value) as Cents;
}

/** Converts cents back to yuan for an *output* boundary (API payload, display). */
export function yuanOf(cents: Cents): number {
  return cents === 0 ? 0 : cents / CENTS_PER_YUAN;
}

/** Wraps an exact count of a non-currency holding. */
export function unitsOf(value: number): Units {
  if (!Number.isInteger(value)) {
    throw new PrismDomainError("Units must be a whole number.", "INVALID_UNITS");
  }
  return (value === 0 ? 0 : value) as Units;
}

/**
 * Reads a scaled value as a whole-unit count: divides by 100 and keeps zero
 * decimals.
 *
 * This is the reading half of the pair for count-like assets (tickets,
 * coupons, seats) — the writing half is `fromInt`. Money uses the other pair,
 * `centsOf` / `yuanOf`, because a yuan amount carries two decimals.
 *
 *   stored 100  ->  intOf  ->  1
 *   stored  54  ->  intOf  ->  0.54 is not a whole count, so it rounds to 1
 *
 * Rounding rather than throwing is deliberate: a count that has picked up
 * residue should still read as the count it represents, and `Number.isInteger`
 * belongs to the caller that wants to reject that case.
 */
export function intOf(value: Cents): number {
  const units = value / CENTS_PER_YUAN;
  const rounded = units < 0 ? -Math.round(-units) : Math.round(units);
  return rounded === 0 ? 0 : rounded;
}

/** Wraps a whole-unit count as a scaled value: multiplies by 100. */
export function fromInt(count: number): Cents {
  if (!Number.isInteger(count)) {
    throw new PrismDomainError(
      "fromInt expects a whole count; use centsOf for a yuan amount.",
      "INVALID_UNITS",
    );
  }
  return (count === 0 ? 0 : count * CENTS_PER_YUAN) as Cents;
}

// ── Money arithmetic ─────────────────────────────────────────────────────────

export function addCents(left: Cents, right: Cents): Cents {
  return (left + right) as Cents;
}

export function subCents(left: Cents, right: Cents): Cents {
  return (left - right) as Cents;
}

export function negCents(value: Cents): Cents {
  return (value === 0 ? 0 : -value) as Cents;
}

export function absCents(value: Cents): Cents {
  return (value < 0 ? -value : value) as Cents;
}

export function sumCents(values: Iterable<Cents>): Cents {
  let total = 0;
  for (const value of values) total += value;
  return (total === 0 ? 0 : total) as Cents;
}

export function isZeroCents(value: Cents): boolean {
  return value === 0;
}

export function isPositiveCents(value: Cents): boolean {
  return value > 0;
}

export function isNegativeCents(value: Cents): boolean {
  return value < 0;
}

export function compareCents(left: Cents, right: Cents): -1 | 0 | 1 {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function minCents(left: Cents, right: Cents): Cents {
  return (left <= right ? left : right) as Cents;
}

export function maxCents(left: Cents, right: Cents): Cents {
  return (left >= right ? left : right) as Cents;
}

/**
 * Computes `value * numerator / denominator` and rounds the result explicitly.
 *
 * The three ratio operations in the domain — percentage discounts, time
 * proration across cap windows, and splitting a cap across sessions — all
 * divide by something that does not divide evenly. There is deliberately no
 * generic `multiply`, and no default rounding mode: every call site has to say
 * how it wants the remainder resolved, because the choice is a billing decision
 * and not a numeric detail.
 *
 * Computed with `BigInt` so the intermediate product cannot lose precision (a
 * cent total times a millisecond weight overflows the safe-integer range).
 */
export function mulDivRound(
  value: Cents,
  numerator: number,
  denominator: number,
  mode: RoundingMode,
): Cents {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    throw new PrismDomainError(
      "mulDivRound expects integer numerator and denominator; scale them first.",
      "INVALID_MONEY_RATIO",
    );
  }
  if (denominator === 0) {
    throw new PrismDomainError("Cannot divide money by zero.", "INVALID_MONEY_RATIO");
  }

  let dividend = BigInt(value) * BigInt(numerator);
  let divisor = BigInt(denominator);
  if (divisor < 0n) {
    dividend = -dividend;
    divisor = -divisor;
  }

  const quotient = dividend / divisor; // BigInt division truncates toward zero
  const remainder = dividend % divisor;
  if (remainder === 0n) return Number(quotient) as Cents;

  switch (mode) {
    case "trunc":
      return Number(quotient) as Cents;
    case "floor":
      return Number(remainder < 0n ? quotient - 1n : quotient) as Cents;
    case "ceil":
      return Number(remainder > 0n ? quotient + 1n : quotient) as Cents;
    case "half": {
      const magnitude = (remainder < 0n ? -remainder : remainder) * 2n;
      if (magnitude >= divisor) {
        return Number(remainder < 0n ? quotient - 1n : quotient + 1n) as Cents;
      }
      return Number(quotient) as Cents;
    }
  }
}

/**
 * Splits `total` across `weights` so the parts sum back to `total`, exactly.
 *
 * Uses largest-remainder: every bucket gets its floored share, then the residual
 * cents go to the buckets with the largest fractional remainder (ties broken by
 * index). Conservation is guaranteed by construction — unlike rounding each
 * share independently, which silently produces an invoice that does not add up.
 *
 * `weights` must be non-negative integers; scale them first if they are not.
 * A zero-weight sum puts everything on the last bucket, since there is no basis
 * to split on — the total is still preserved.
 */
export function allocate(total: Cents, weights: readonly number[]): Cents[] {
  if (weights.length === 0) return [];
  for (const weight of weights) {
    if (!Number.isInteger(weight) || weight < 0) {
      throw new PrismDomainError(
        "allocate expects non-negative integer weights; scale them first.",
        "INVALID_MONEY_RATIO",
      );
    }
  }

  const divisor = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  if (divisor === 0n) {
    return weights.map((_, index) => (index === weights.length - 1 ? total : ZERO_CENTS));
  }

  const dividendTotal = BigInt(total);
  const floors: bigint[] = [];
  const remainders: bigint[] = [];
  let allocated = 0n;

  for (const weight of weights) {
    const dividend = dividendTotal * BigInt(weight);
    const quotient = dividend / divisor;
    const remainder = dividend % divisor;
    // Floor toward negative infinity so every remainder is in [0, divisor) and
    // the residual below is never negative — this is what makes it work for
    // negative totals (refunds, deductions) as well as positive ones.
    const floored = remainder < 0n ? quotient - 1n : quotient;
    const normalisedRemainder = remainder < 0n ? remainder + divisor : remainder;
    floors.push(floored);
    remainders.push(normalisedRemainder);
    allocated += floored;
  }

  let residual = Number(dividendTotal - allocated);
  const order = remainders
    .map((remainder, index) => ({ index, remainder }))
    .sort((a, b) => (b.remainder === a.remainder ? a.index - b.index : b.remainder > a.remainder ? 1 : -1));

  // `floors` holds BigInt values for exact intermediate arithmetic; convert back
  // to plain numbers before handing them out as `Cents`.
  const result = floors.map((value) => Number(value) as Cents);
  let cursor = 0;
  while (residual > 0) {
    const target = order[cursor % order.length]!.index;
    result[target] = ((result[target] as number) + 1) as Cents;
    residual--;
    cursor++;
  }
  return result;
}

// ── Count arithmetic ─────────────────────────────────────────────────────────

export function addUnits(left: Units, right: Units): Units {
  return (left + right) as Units;
}

export function subUnits(left: Units, right: Units): Units {
  return (left - right) as Units;
}

export function sumUnits(values: Iterable<Units>): Units {
  let total = 0;
  for (const value of values) total += value;
  return (total === 0 ? 0 : total) as Units;
}

export function isZeroUnits(value: Units): boolean {
  return value === 0;
}

export function isPositiveUnits(value: Units): boolean {
  return value > 0;
}

export function isNegativeUnits(value: Units): boolean {
  return value < 0;
}

export function compareUnits(left: Units, right: Units): -1 | 0 | 1 {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
