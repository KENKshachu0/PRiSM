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
