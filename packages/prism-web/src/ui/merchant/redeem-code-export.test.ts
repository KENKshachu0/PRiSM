import { describe, expect, it } from "vitest";
import type { RedeemCode } from "./asset-types";
import {
  codeUsage,
  codeValidity,
  emptyCodeExportFilter,
  filterRedeemCodes,
  redeemCodesToCsv,
  redeemCodesToText,
} from "./redeem-code-export";

const now = new Date("2026-06-10T00:00:00.000Z");
const code = (id: string, extra: Partial<RedeemCode> = {}): RedeemCode => ({
  id,
  code: `SPRING-${id}`,
  presentId: "p1",
  usageCount: 0,
  maxUseCount: 1,
  expiresAt: null,
  ...extra,
});
const codes = [
  code("a"),
  code("b", { usageCount: 1 }),
  code("c", { presentId: "p2", maxUseCount: 3, usageCount: 1 }),
  code("d", { maxUseCount: 0 }),
  code("e", { expiresAt: "2026-06-01T00:00:00.000Z" }),
  code("f", { activeAt: "2026-07-01T00:00:00.000Z", expiresAt: "2026-07-31T16:00:00.000Z" }),
];
const filter = (patch: Partial<typeof emptyCodeExportFilter>) => ({ ...emptyCodeExportFilter, ...patch });
const ids = (list: RedeemCode[]) => list.map((c) => c.id);

describe("redeem code export filters", () => {
  it("classifies usage and validity", () => {
    expect(codes.map(codeUsage)).toEqual(["unused", "exhausted", "partial", "revoked", "unused", "unused"]);
    expect(codes.map((c) => codeValidity(c, now))).toEqual(["valid", "valid", "valid", "valid", "expired", "pending"]);
  });

  it("returns everything with no conditions", () => {
    expect(ids(filterRedeemCodes(codes, emptyCodeExportFilter, now, "UTC"))).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("combines conditions with AND and a set of values with OR", () => {
    expect(ids(filterRedeemCodes(codes, filter({ usage: ["unused", "partial"], validity: ["valid"] }), now, "UTC"))).toEqual(["a", "c"]);
    expect(ids(filterRedeemCodes(codes, filter({ presentIds: ["p2"] }), now, "UTC"))).toEqual(["c"]);
  });

  it("matches the code text case-insensitively", () => {
    expect(ids(filterRedeemCodes(codes, filter({ search: "spring-b" }), now, "UTC"))).toEqual(["b"]);
  });

  it("takes the first N matches", () => {
    expect(ids(filterRedeemCodes(codes, filter({ usage: ["unused"], limit: "2" }), now, "UTC"))).toEqual(["a", "e"]);
  });

  it("reads the expiry range as inclusive local dates and drops codes that never expire", () => {
    const range = filter({ expiresFrom: "2026-06-01", expiresTo: "2026-08-01" });
    expect(ids(filterRedeemCodes(codes, range, now, "Asia/Shanghai"))).toEqual(["e", "f"]);
    // f expires 2026-08-01 00:00 Shanghai: inside Aug 1, outside Jul 31.
    expect(ids(filterRedeemCodes(codes, filter({ expiresFrom: "2026-06-01", expiresTo: "2026-07-31" }), now, "Asia/Shanghai"))).toEqual(["e"]);
  });
});

describe("redeem code export files", () => {
  it("writes one code per line", () => {
    expect(redeemCodesToText(codes.slice(0, 2))).toBe("SPRING-a\nSPRING-b\n");
    expect(redeemCodesToText([])).toBe("");
  });

  it("writes quoted CSV and keeps free text from running as a formula", () => {
    const labels = {
      code: "Code",
      columns: { present: "Gift", usageCount: "Used", maxUseCount: "Max", usage: "Usage", validity: "Validity", activeAt: "From", expiresAt: "Until" },
      usage: { unused: "Unused", partial: "Partial", exhausted: "Used up", revoked: "Revoked" },
      validity: { valid: "Valid", pending: "Pending", expired: "Expired" },
    };
    const csv = redeemCodesToCsv(
      [code("a", { code: "-RAW,1" })],
      [{ id: "p1", name: '=HYPERLINK("x")' }],
      ["present", "usageCount", "usage"],
      labels,
      now,
      (value) => value ?? "",
    );
    expect(csv).toBe('Code,Gift,Used,Usage\r\n"-RAW,1","\'=HYPERLINK(""x"")",0,Unused\r\n');
  });
});
