import { describe, expect, it } from "bun:test";
import { periodRows } from "./period-rows";
import type { Segment } from "./merchant/PricingRing";

const at = (day: number, hhmm: string) => `2026-06-${String(day).padStart(2, "0")}T${hhmm}:00.000Z`;
const piece = (ruleId: string, start: string, end: string, window: [string, string]): Segment => {
  const minute = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  return {
    ruleId, label: ruleId, startMinute: minute(start), endMinute: end === "24:00" ? 1440 : minute(end), startLabel: start, endLabel: end,
    startedAt: at(7, start), endedAt: end === "24:00" ? at(8, "00:00") : at(7, end), windowStartedAt: window[0], windowEndedAt: window[1],
  };
};
const labels = (segments: Segment[]) => periodRows(segments).map((row) => `${row.pieces[0]!.ruleId} ${row.startLabel}–${row.endLabel}`);

describe("period rows", () => {
  it("lists a period through midnight once", () => {
    expect(labels([
      piece("night", "00:00", "10:00", [at(6, "22:00"), at(7, "10:00")]),
      piece("day", "10:00", "22:00", [at(7, "10:00"), at(7, "22:00")]),
      piece("night", "22:00", "24:00", [at(7, "22:00"), at(8, "10:00")]),
    ])).toEqual(["day 10:00–22:00", "night 22:00–10:00"]);
    expect(labels([
      piece("daily", "00:00", "06:00", [at(6, "06:00"), at(7, "06:00")]),
      piece("daily", "06:00", "24:00", [at(7, "06:00"), at(8, "06:00")]),
    ])).toEqual(["daily 06:00–06:00"]);
  });

  it("keeps a period interrupted by another within the day as two rows", () => {
    expect(labels([
      piece("base", "00:00", "12:00", [at(7, "00:00"), at(8, "00:00")]),
      piece("lunch", "12:00", "14:00", [at(7, "12:00"), at(7, "14:00")]),
      piece("base", "14:00", "24:00", [at(7, "00:00"), at(8, "00:00")]),
    ])).toEqual(["base 00:00–12:00", "lunch 12:00–14:00", "base 14:00–24:00"]);
  });
});
