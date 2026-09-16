import { centsOf, type Cents, unitsOf } from "../../src/index";

/**
 * Test-facing constructor for a money amount written in yuan.
 *
 * Like `centsOf(6)`, `yuan(6)` represents six yuan as 600 integer cents.
 */
export function yuan(amount: number): Cents {
  return centsOf(amount);
}

/** Test-facing constructor for a count of a non-currency holding. */
export function count(amount: number): number {
  return unitsOf(amount);
}
