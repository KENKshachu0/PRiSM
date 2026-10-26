import type { Segment } from "./merchant/PricingRing";

/** A period as listed: the pieces of one window, joined across midnight. */
export type PeriodRow = { pieces: Segment[]; startLabel: string; endLabel: string };

/**
 * One row per period. A window running through midnight shows on the strip as
 * its morning and evening pieces; listed, it is one period such as 22:00–10:00.
 */
export function periodRows(segments: Segment[]): PeriodRow[] {
  const rows = segments.map((s) => ({ pieces: [s], startLabel: s.startLabel, endLabel: s.endLabel }));
  const head = segments[0];
  const tail = segments.at(-1);
  const startsBefore = (s: Segment) => !!s.windowStartedAt && !!s.startedAt && Date.parse(s.windowStartedAt) < Date.parse(s.startedAt);
  const endsAfter = (s: Segment) => !!s.windowEndedAt && !!s.endedAt && Date.parse(s.windowEndedAt) > Date.parse(s.endedAt);
  if (segments.length > 1 && head && tail && !head.isClosed && head.ruleId === tail.ruleId && startsBefore(head) && endsAfter(tail)) {
    return [...rows.slice(1, -1), { pieces: [tail, head], startLabel: tail.startLabel, endLabel: head.endLabel }];
  }
  return rows;
}
