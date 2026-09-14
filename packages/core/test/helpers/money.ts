import { centsOf, type Cents, type Units, unitsOf } from "../../src/index";

/**
 * Test-facing constructor for a money amount written in yuan.
 *
 * Tests historically wrote `{ quantity: 6 }` meaning six yuan. Once holdings
 * are `Cents`, the literal has to be scaled — and writing `centsOf(6)` there
 * would mean six fen, a hundredfold mistake in every test that reads naturally.
 * Naming the helper after the unit the test author is thinking in removes that
 * ambiguity: `yuan(6)` is six yuan, and it is 600.
 */
export function yuan(amount: number): Cents {
  return centsOf(amount);
}

/** Test-facing constructor for a count of a non-currency holding. */
export function count(amount: number): Units {
  return unitsOf(amount);
}
