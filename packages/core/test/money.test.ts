import { describe, expect, it } from "bun:test";
import {
  MONEY_EPSILON,
  compareMoney,
  isNegativeQuantity,
  isPositiveQuantity,
  isZeroQuantity,
  normalizeQuantity,
  quantizeMoney,
  sumMoney,
} from "../src/index";

describe("quantizeMoney", () => {
  it("leaves values that are already whole cents untouched", () => {
    for (const value of [0, 1, 6, 7.5, 69, 79, 10.25, 0.01, 0.06, 0.07, 999999.99]) {
      expect(quantizeMoney(value)).toBe(value);
    }
  });

  it("snaps values that carry floating-point noise back to whole cents", () => {
    expect(quantizeMoney(0.07000000000000001)).toBe(0.07);
    expect(quantizeMoney(0.06999999999999999)).toBe(0.07);
    expect(quantizeMoney(8.999999999999998)).toBe(9);
    expect(quantizeMoney(33.333333333333336)).toBe(33.33);
  });

  it("rounds sub-cent input to the nearest cent", () => {
    expect(quantizeMoney(0.004)).toBe(0);
    expect(quantizeMoney(0.005)).toBe(0.01);
    expect(quantizeMoney(0.006)).toBe(0.01);
    // 1.005 is stored fractionally *below* 1.005, so it rounds down. Sub-cent
    // input never reaches the domain in the first place — the API boundary
    // rejects or quantises it — so this only documents the direction.
    expect(quantizeMoney(1.005)).toBe(1);
  });

  it("never returns negative zero", () => {
    expect(Object.is(quantizeMoney(-0.004), 0)).toBe(true);
    expect(Object.is(quantizeMoney(-1e-17), 0)).toBe(true);
  });

  it("passes non-finite input through so callers keep their own validation", () => {
    expect(quantizeMoney(Number.NaN)).toBeNaN();
    expect(quantizeMoney(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("normalizeQuantity", () => {
  it("collapses subtraction residue to exactly zero", () => {
    // 1.00 minus ten times 0.10, which is what the ledger leaves behind today.
    let balance = 1;
    for (let index = 0; index < 10; index++) balance -= 0.1;

    expect(balance).not.toBe(0);
    expect(normalizeQuantity(balance)).toBe(0);
  });

  it("keeps a genuine balance and canonicalises it to cents", () => {
    expect(normalizeQuantity(13)).toBe(13);
    expect(normalizeQuantity(7.750000000000001)).toBe(7.75);
    expect(normalizeQuantity(-1e-16)).toBe(0);
  });
});

describe("quantity comparisons", () => {
  it("treats float noise as zero instead of a spendable balance", () => {
    const residue = 1.3877787807814457e-16;

    expect(isZeroQuantity(residue)).toBe(true);
    expect(isPositiveQuantity(residue)).toBe(false);
    expect(isNegativeQuantity(residue)).toBe(false);
  });

  it("keeps real amounts on the correct side of zero", () => {
    expect(isPositiveQuantity(MONEY_EPSILON * 10)).toBe(true);
    expect(isPositiveQuantity(0.01)).toBe(true);
    expect(isZeroQuantity(0.01)).toBe(false);
    expect(isNegativeQuantity(-0.01)).toBe(true);
    expect(isNegativeQuantity(MONEY_EPSILON)).toBe(false);
  });

  it("keeps reserves the same sign in both directions", () => {
    expect(isZeroQuantity(-1e-17)).toBe(true);
    expect(isZeroQuantity(1e-17)).toBe(true);
  });

  it("does not classify non-finite values as positive or zero", () => {
    expect(isPositiveQuantity(Number.NaN)).toBe(false);
    expect(isZeroQuantity(Number.NaN)).toBe(false);
    expect(isNegativeQuantity(Number.NaN)).toBe(false);
  });
});

describe("compareMoney", () => {
  it("reports equality for sums that binary floating point cannot add exactly", () => {
    // Every one of these evaluates to `true` with a raw `<` comparison.
    expect(0.01 + 0.06 < 0.07).toBe(true);
    expect(0.3 + 0.6 < 0.9).toBe(true);
    expect(0.7 + 0.1 < 0.8).toBe(true);

    expect(compareMoney(0.01 + 0.06, 0.07)).toBe(0);
    expect(compareMoney(0.3 + 0.6, 0.9)).toBe(0);
    expect(compareMoney(0.7 + 0.1, 0.8)).toBe(0);
  });

  it("still orders genuinely different amounts", () => {
    expect(compareMoney(25, 30)).toBe(-1);
    expect(compareMoney(30, 25)).toBe(1);
    expect(0.01 + 0.06 >= 0.08).toBe(false);
    expect(compareMoney(0.01 + 0.06, 0.08)).toBe(-1);
  });

  it("respects the cent grid rather than the raw float delta", () => {
    // Both land on 5.00 once snapped, so they are the same amount to the store.
    expect(compareMoney(5.004, 5.001)).toBe(0);
    expect(compareMoney(5, 5.01)).toBe(-1);
    expect(compareMoney(5.006, 5)).toBe(1);
  });

  it("falls back to a plain comparison for non-finite operands", () => {
    expect(compareMoney(Number.NaN, Number.NaN)).toBe(0);
    expect(compareMoney(Number.NaN, 1)).toBe(1);
    expect(compareMoney(1, Number.NaN)).toBe(-1);
  });
});

describe("sumMoney", () => {
  it("returns a canonical total for a long chain of decimals", () => {
    expect(sumMoney(Array.from({ length: 10 }, () => 0.1))).toBe(1);
    expect(sumMoney([0.01, 0.06])).toBe(0.07);
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
  });

  it("returns zero for an empty iterable", () => {
    expect(sumMoney([])).toBe(0);
  });
});
