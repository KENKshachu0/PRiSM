import { describe, expect, it } from "bun:test";
import { billingSetupSchema } from "../src/validators";

const validSetup = {
  paidName: "充值余额",
  freeName: "赠送余额",
  hourlyPrice: 7.5,
  graceMinutes: 5,
  dailyCap: 69,
  botContact: "",
  autoRegister: true,
};

describe("billingSetupSchema money fields", () => {
  it("snaps the hourly price and daily cap to whole cents", () => {
    const parsed = billingSetupSchema.parse({
      ...validSetup,
      hourlyPrice: 6.666666666666667,
      dailyCap: 78.99999999999999,
    });

    expect(parsed.hourlyPrice).toBe(6.67);
    expect(parsed.dailyCap).toBe(79);
  });

  it("leaves values that are already whole cents untouched", () => {
    expect(billingSetupSchema.parse({ ...validSetup, hourlyPrice: 6 })).toEqual({
      ...validSetup,
      hourlyPrice: 6,
    });
  });

  it("rejects out-of-range prices against the typed value, not the rounded one", () => {
    expect(() => billingSetupSchema.parse({ ...validSetup, hourlyPrice: 0 })).toThrow();
    expect(() => billingSetupSchema.parse({ ...validSetup, hourlyPrice: -1 })).toThrow();
    expect(() => billingSetupSchema.parse({ ...validSetup, hourlyPrice: 100_001 })).toThrow();
    expect(() => billingSetupSchema.parse({ ...validSetup, hourlyPrice: Number.NaN })).toThrow();
    expect(() => billingSetupSchema.parse({ ...validSetup, dailyCap: -1 })).toThrow();
  });

  it("keeps graceMinutes a whole number of minutes", () => {
    expect(billingSetupSchema.parse({ ...validSetup, graceMinutes: 0 }).graceMinutes).toBe(0);
    expect(() => billingSetupSchema.parse({ ...validSetup, graceMinutes: 4.5 })).toThrow();
  });
});
