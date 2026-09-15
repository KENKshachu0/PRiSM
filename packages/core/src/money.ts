/**
 * Money and quantity arithmetic for PRiSM.
 *
 * Billing arithmetic and storage use safe integers: money in cents, tickets
 * and coupons in whole counts. API/configuration boundaries still speak yuan.
 * Ratios use BigInt intermediates with explicit rounding or conserving allocation.
 * The legacy tolerance helpers remain exported for compatibility, but are not
 * used by billing. See `docs/money.md` for units and migration requirements.
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
 * Only for yuan-valued API/configuration boundaries. Billing and ledger reads
 * use integer helpers instead. Non-finite input passes through unchanged so
 * callers keep their existing `Number.isFinite` validation.
 */
export function quantizeMoney(value: number): number {
  if (!Number.isFinite(value)) return value;
  return yuanOf(centsOf(value));
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
  const [mantissa, exponent = "0"] = Math.abs(yuan).toString().split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  const digits = BigInt(whole! + fraction);
  const shift = Number(exponent) + 2 - fraction.length;
  const divisor = shift < 0 ? 10n ** BigInt(-shift) : 1n;
  const scaled = shift >= 0 ? digits * 10n ** BigInt(shift) : digits;
  const rounded = (scaled + divisor / 2n) / divisor;
  return centsOfInteger(Number(yuan < 0 ? -rounded : rounded));
}

/**
 * Wraps a value that is already an exact count of cents.
 *
 * Use it for values produced by integer arithmetic — never for a yuan amount,
 * which must go through `centsOf` (that mistake is off by a factor of 100).
 */
export function centsOfInteger(value: number): Cents {
  if (!Number.isSafeInteger(value)) {
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
  if (!Number.isSafeInteger(value)) {
    throw new PrismDomainError("Units must be a whole number.", "INVALID_UNITS");
  }
  return (value === 0 ? 0 : value) as Units;
}

/** Converts an external asset quantity to its stored integer representation.
 * Currency is expressed in yuan at the boundary and stored in cents; every
 * other asset is expressed and stored as a whole count. */
export function assetQuantityOf(assetType: string, value: number): Cents {
  return assetType === "currency" ? centsOf(value) : centsOfInteger(value);
}

/** Converts a stored asset quantity back to the API's natural unit. */
export function assetQuantityToNatural(assetType: string, value: Cents): number {
  return assetType === "currency" ? yuanOf(value) : value;
}

// ── Money arithmetic ─────────────────────────────────────────────────────────

export function addCents(left: Cents, right: Cents): Cents {
  return centsOfInteger(left + right);
}

export function subCents(left: Cents, right: Cents): Cents {
  return centsOfInteger(left - right);
}

export function negCents(value: Cents): Cents {
  return (value === 0 ? 0 : -value) as Cents;
}

export function absCents(value: Cents): Cents {
  return (value < 0 ? -value : value) as Cents;
}

export function sumCents(values: Iterable<Cents>): Cents {
  let total = 0;
  for (const value of values) total = centsOfInteger(total + value);
  return centsOfInteger(total);
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
  centsOfInteger(value);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
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
  if (remainder === 0n) return centsOfInteger(Number(quotient));

  switch (mode) {
    case "trunc":
      return centsOfInteger(Number(quotient));
    case "floor":
      return centsOfInteger(Number(remainder < 0n ? quotient - 1n : quotient));
    case "ceil":
      return centsOfInteger(Number(remainder > 0n ? quotient + 1n : quotient));
    case "half": {
      const magnitude = (remainder < 0n ? -remainder : remainder) * 2n;
      if (magnitude >= divisor) {
        return centsOfInteger(Number(remainder < 0n ? quotient - 1n : quotient + 1n));
      }
      return centsOfInteger(Number(quotient));
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
  centsOfInteger(total);
  if (weights.length === 0) return [];
  for (const weight of weights) {
    if (!Number.isSafeInteger(weight) || weight < 0) {
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
  const result = floors.map((value) => centsOfInteger(Number(value)));
  let cursor = 0;
  while (residual > 0) {
    const target = order[cursor % order.length]!.index;
    result[target] = centsOfInteger(result[target]! + 1);
    residual--;
    cursor++;
  }
  return result;
}

// ── Count arithmetic ─────────────────────────────────────────────────────────

export function addUnits(left: Units, right: Units): Units {
  return unitsOf(left + right);
}

export function subUnits(left: Units, right: Units): Units {
  return unitsOf(left - right);
}

export function sumUnits(values: Iterable<Units>): Units {
  let total = 0;
  for (const value of values) total = unitsOf(total + value);
  return unitsOf(total);
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
