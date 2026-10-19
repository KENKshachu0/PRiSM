import { describe, expect, it } from "vitest";
import { convertPrismNeoFile } from "./shop-data-transfer";

const dump = `--
-- PostgreSQL database dump
--

COPY public."User" (id, "createdAt", "isBanned") FROM stdin;
7\t2026-01-01 00:00:00\tf
\\.

COPY public."Asset" (id, "assetId", type, name, description, valid, "activeAt", "expireAt", "billingEffect") FROM stdin;
1\t10001\tCURRENCY\t余额\t\\N\tt\t\\N\t\\N\t\\N
\\.

COPY public."Session" (id, "userId", "createdAt", "closedAt", "isActive", "billingCost", "costOverwrite", "finalCost") FROM stdin;
51\t7\t2026-01-03 10:00:00.000\t2026-01-03 11:30:00.000\t\\N\t120\t\\N\t90
\\.
`;

describe("convertPrismNeoFile", () => {
  it("parses a pg_dump text file into a converted PRiSM backup file", async () => {
    const file = new File([dump], "yg_prism.sql", { type: "text/plain" });
    const converted = await convertPrismNeoFile(file, "Asia/Shanghai");
    expect(converted.name).toContain("prism-prism-neo-");
    const backup = JSON.parse(await converted.text());
    expect(backup.format).toBe("prism-shop-data");
    expect(backup.version).toBe(3);
    expect(backup.tables.players).toEqual([
      { id: "legacy:user:7", display_name: "Player 7", status: "active", created_at: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(backup.tables.sessions).toHaveLength(1);
    expect(backup.tables.settlements[0]).toMatchObject({ total: 9000 });
    expect(backup.source.name).toBe("yg_prism");
  });

  it("fails a dump whose rows cannot yield a complete conversion", async () => {
    // A cut-short row means the snapshot cannot be complete: fail loudly
    // instead of importing a silently partial shop.
    const broken = dump.replace(
      "51\t7\t2026-01-03 10:00:00.000\t2026-01-03 11:30:00.000\t\\N\t120\t\\N\t90",
      "51\t7",
    );
    const file = new File([broken], "broken.sql", { type: "text/plain" });
    await expect(convertPrismNeoFile(file, "UTC")).rejects.toThrow("数据损坏");
  });

  it("rejects a file that is neither JSON nor a pg_dump with a clear message", async () => {
    const file = new File(["not a backup at all"], "notes.txt", { type: "text/plain" });
    await expect(convertPrismNeoFile(file, "UTC")).rejects.toThrow("数据损坏");
  });

  it("recognizes dumps whose first COPY block sits behind a long DDL preamble", async () => {
    // pg_dump 18 writes every CREATE TABLE before the data; the first COPY
    // block can land well past 4 KB.
    const preamble = "-- PostgreSQL database dump\n".repeat(400);
    const file = new File([preamble + dump], "late.sql", { type: "text/plain" });
    const converted = await convertPrismNeoFile(file, "UTC");
    const backup = JSON.parse(await converted.text());
    expect(backup.tables.players).toHaveLength(1);
  });

  it("converts a dump whose final block ends exactly at a row boundary", async () => {
    // A clean row boundary without the terminator is still complete data.
    const cut = `COPY public."Session" (id, "userId", "createdAt", "closedAt", "isActive", "billingCost", "costOverwrite", "finalCost") FROM stdin;
51\t7\t2026-01-03 10:00:00.000\t2026-01-03 11:30:00.000\t\\N\t120\t\\N\t90
`;
    const file = new File([dump + cut], "cut.sql", { type: "text/plain" });
    const backup = JSON.parse(await (await convertPrismNeoFile(file, "UTC")).text());
    expect(backup.tables.asset_definitions).toHaveLength(1);
    expect(backup.tables.sessions).toHaveLength(1);
  });

  it("accepts a CLI JSON snapshot file as well", async () => {
    const file = new File(
      [JSON.stringify({ users: [{ id: 3, createdAt: "2026-01-01T00:00:00Z", isBanned: false }] })],
      "neo.json",
      { type: "application/json" },
    );
    const converted = await convertPrismNeoFile(file, "UTC");
    const backup = JSON.parse(await converted.text());
    expect(backup.tables.players).toHaveLength(1);
  });
});
