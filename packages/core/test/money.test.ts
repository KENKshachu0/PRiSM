import { centsOf as moneyFixture, centsOfInteger as integerFixture } from "@prism/core";
import { describe, expect, it } from "bun:test";
const n = (value: number): number => value;
import {
  type Cents,
  addCents,
  absCents,
  allocate,
  centsOf,
  centsOfInteger,
  compareCents,
  maxCents,
  minCents,
  mulDivRound,
  negCents,
  quantizeMoney,
  subCents,
  assetQuantityOf,
  assetQuantityToNatural,
  sumCents,
  unitsOf,
  yuanOf,
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
    expect(quantizeMoney(1.005)).toBe(1.01);
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

describe("centsOf / yuanOf", () => {
  it("converts yuan to exact cents and back", () => {
    expect(n(centsOf(0))).toBe(0);
    expect(n(centsOf(0.07))).toBe(7);
    expect(n(centsOf(7.5))).toBe(750);
    expect(n(centsOf(10.01))).toBe(1001);
    expect(yuanOf(centsOf(7.5))).toBe(7.5);
  });

  it("absorbs sub-cent residue instead of letting it through", () => {
    expect(n(centsOf(10.01001))).toBe(1001);
    expect(n(centsOf(0.00001))).toBe(0);
    expect(n(centsOf(33.333333333333336))).toBe(3333);
  });

  it("converts every legal two-decimal amount exactly", () => {
    // The contract is two decimals, so a million of them must all survive.
    for (let fen = 0; fen <= 1_000_000; fen++) {
      if (centsOf(fen / 100) !== fen) throw new Error(`centsOf lost ${fen / 100}`);
    }
    expect(n(centsOf(1919042))).toBe(191904200);
  });

  it("rounds decimal input half away from zero without binary multiplication", () => {
    expect(n(centsOf(1.005))).toBe(101);
    expect(n(centsOf(0.005))).toBe(1);
    expect(n(centsOf(-0.005))).toBe(-1);
    expect(n(centsOf(-1.005))).toBe(-101);
  });

  it("never produces negative zero", () => {
    expect(Object.is(n(centsOf(-0)), 0)).toBe(true);
    expect(Object.is(yuanOf(centsOf(-0)), 0)).toBe(true);
  });

  it("rejects values that are not finite money", () => {
    expect(() => centsOf(Number.NaN)).toThrow();
    expect(() => centsOf(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("refuses to wrap a non-integer as cents", () => {
    expect(() => centsOfInteger(1.5)).toThrow();
    expect(n(centsOfInteger(1001))).toBe(1001);
  });
});

describe("mulDivRound", () => {
  it("rounds a percentage discount the way each mode asks", () => {
    // 19.99 元 at 15% off = 299.85 分
    const subtotal = centsOf(19.99);
    expect(n(mulDivRound(subtotal, 15, 100, "half"))).toBe(300);
    expect(n(mulDivRound(subtotal, 15, 100, "floor"))).toBe(299);
    expect(n(mulDivRound(subtotal, 15, 100, "ceil"))).toBe(300);
    expect(n(mulDivRound(subtotal, 15, 100, "trunc"))).toBe(299);
    expect(yuanOf(mulDivRound(subtotal, 15, 100, "half"))).toBe(3);
  });

  it("handles negative amounts in the direction each mode promises", () => {
    const refund = centsOf(-19.99);
    expect(n(mulDivRound(refund, 15, 100, "floor"))).toBe(-300);
    expect(n(mulDivRound(refund, 15, 100, "ceil"))).toBe(-299);
    expect(n(mulDivRound(refund, 15, 100, "trunc"))).toBe(-299);
    expect(n(mulDivRound(refund, 15, 100, "half"))).toBe(-300);
  });

  it("returns the exact result when the division has no remainder", () => {
    expect(n(mulDivRound(centsOf(100), 1, 4, "floor"))).toBe(2500);
    // centsOf(1) is already 100 分, so doubling it is 200.
    expect(n(mulDivRound(centsOf(1), 2, 1, "trunc"))).toBe(200);
  });

  it("normalises a negative denominator", () => {
    const value = centsOf(1);
    expect(n(mulDivRound(value, 1, -3, "floor"))).toBe(-34);
    expect(n(mulDivRound(value, 1, -3, "trunc"))).toBe(-33);
  });

  it("does not lose precision on large cents times large weights", () => {
    // 191,904,200 分 x 86,400,000 ms overflows a float64 intermediate.
    const large = centsOfInteger(191_904_200);
    expect(n(mulDivRound(large, 86_400_000, 86_400_000, "floor"))).toBe(191_904_200);
    expect(n(mulDivRound(large, 86_400_000, 172_800_000, "floor"))).toBe(95_952_100);
  });

  it("refuses a ratio it cannot represent exactly, or a zero divisor", () => {
    expect(() => mulDivRound(centsOf(1), 15.5, 100, "half")).toThrow();
    expect(() => mulDivRound(centsOf(1), 15, 100.5, "half")).toThrow();
    expect(() => mulDivRound(centsOf(1), 1, 0, "half")).toThrow();
  });
});

describe("allocate", () => {
  it("always sums back to the original total", () => {
    const weightSets = [[1], [1, 1], [1, 2, 3], [0, 1], [5, 0, 0], [1, 1, 1, 1, 1, 1, 1]];
    for (const weights of weightSets) {
      for (let total = -50; total <= 50; total++) {
        const parts = allocate(centsOfInteger(total), weights);
        expect(parts.length).toBe(weights.length);
        expect(n(sumCents(parts))).toBe(total);
      }
    }
  });

  it("gives the residual cents to the largest remainders, ties by index", () => {
    // 10 split three ways: 3.33 each, the leftover cent goes to the first bucket.
    expect(allocate(centsOfInteger(10), [1, 1, 1]).map(n)).toEqual([4, 3, 3]);
    // Weighted 1:2 => 3.33 / 6.66, the leftover cent lands on the larger share.
    expect(allocate(centsOfInteger(10), [1, 2]).map(n)).toEqual([3, 7]);
  });

  it("keeps conservation for negative totals, where the residual is not symmetric", () => {
    const parts = allocate(centsOfInteger(-7), [1, 1, 1]);
    expect(n(sumCents(parts))).toBe(-7);
    expect(parts.map(n)).toEqual([-2, -2, -3]);
  });

  it("puts everything on the last bucket when there is no basis to split", () => {
    expect(allocate(centsOfInteger(100), [0, 0]).map(n)).toEqual([0, 100]);
    expect(allocate(centsOfInteger(100), [0, 0, 0]).map(n)).toEqual([0, 0, 100]);
    expect(allocate(centsOfInteger(0), [0, 0]).map(n)).toEqual([0, 0]);
  });

  it("splits exactly when the division is even", () => {
    expect(allocate(centsOfInteger(900), [1, 1, 1]).map(n)).toEqual([300, 300, 300]);
    expect(allocate(centsOfInteger(-900), [1, 1, 1]).map(n)).toEqual([-300, -300, -300]);
  });

  it("returns an empty split for no buckets, and rejects invalid weights", () => {
    expect(allocate(centsOfInteger(5), []).map(n)).toEqual([]);
    expect(() => allocate(centsOfInteger(5), [1, -1])).toThrow();
    expect(() => allocate(centsOfInteger(5), [1, 0.5])).toThrow();
  });
});

describe("cents arithmetic", () => {
  it("adds, subtracts, negates and compares exactly", () => {
    const a = centsOf(0.01);
    const b = centsOf(0.06);
    expect(n(addCents(a, b))).toBe(7);
    expect(yuanOf(addCents(a, b))).toBe(0.07);
    expect(n(subCents(b, a))).toBe(5);
    expect(n(negCents(a))).toBe(-1);
    expect(n(absCents(negCents(a)))).toBe(1);
    expect(compareCents(a, b)).toBe(-1);
    expect(compareCents(b, a)).toBe(1);
    expect(compareCents(a, a)).toBe(0);
    expect(n(minCents(a, b))).toBe(1);
    expect(n(maxCents(a, b))).toBe(6);
  });

  it("is not fooled by the sum that defeats the yuan comparison", () => {
    const available = addCents(centsOf(0.01), centsOf(0.06));
    const owed = centsOf(0.07);
    // In cents the two are equal, so the balance covers the payment.
    expect(n(available)).toBe(7);
    expect(n(owed)).toBe(7);
    expect(available < owed).toBe(false);
    expect(compareCents(available, owed)).toBe(0);
    // The yuan path the old code took gets it wrong.
    expect(0.01 + 0.06 < 0.07).toBe(true);
  });

  it("sums many amounts without drifting", () => {
    const parts = Array.from({ length: 10 }, () => centsOf(0.1));
    expect(n(sumCents(parts))).toBe(100);
    expect(yuanOf(sumCents(parts))).toBe(1);
  });
});

describe("money requires an explicit unit boundary", () => {
  it("refuses raw numbers and ticket counts as cents", () => {
    const count = unitsOf(1);

    // These assignments must be type errors. If any became legal the directive
    // turns into an "unused @ts-expect-error" and `bun run typecheck` fails.
    // @ts-expect-error a bare number is not money
    const rawAsMoney: Cents = 1;
    // @ts-expect-error counts cannot stand in for money
    const countAsMoney: Cents = count;

    // Widen to number[] so the assertion types do not fight the brands.
    const values: number[] = [rawAsMoney, countAsMoney];
    expect(values).toEqual([1, 1]);
  });
});

describe("asset quantities use their own units", () => {
  it("stores money in cents and coupons and tickets as whole counts", () => {
    expect(n(assetQuantityOf("currency", 1.23))).toBe(123);
    expect(assetQuantityToNatural("currency", centsOfInteger(123))).toBe(1.23);
    for (const type of ["coupon", "ticket"]) {
      expect(n(assetQuantityOf(type, 1))).toBe(1);
      expect(assetQuantityToNatural(type, unitsOf(1))).toBe(1);
      expect(() => assetQuantityOf(type, 0.5)).toThrow();
    }
  });

  it("rejects unsafe inputs and arithmetic overflow", () => {
    const largest = centsOfInteger(Number.MAX_SAFE_INTEGER);
    expect(() => centsOfInteger(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => centsOf(Number.MAX_SAFE_INTEGER)).toThrow();
    expect(() => addCents(largest, centsOfInteger(1))).toThrow();
    expect(() => mulDivRound(largest, 2, 1, "half")).toThrow();
    expect(() => allocate(largest, [Number.MAX_SAFE_INTEGER + 1])).toThrow();
  });
});
