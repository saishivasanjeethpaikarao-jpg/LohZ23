/**
 * Phase 25 — deterministic event ordering and interval semantics.
 *
 * Identical timestamps are broken by lexicographic id comparison so
 * ordering is total and reproducible regardless of insertion order.
 */
import type { TemporalEvent } from "./types";

export type OrderRelation =
  | "before"
  | "after"
  | "same_instant";

/** Point-vs-point relation with deterministic tie-breaking. */
export function compareEvents(a: TemporalEvent, b: TemporalEvent): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export function relationOf(a: TemporalEvent, b: TemporalEvent): OrderRelation {
  const c = compareEvents(a, b);
  return c < 0 ? "before" : c > 0 ? "after" : "same_instant";
}

function interval(e: TemporalEvent): { start: number; end: number } {
  const end = e.endTime ?? (e.durationMs !== undefined ? e.timestamp + e.durationMs : e.timestamp);
  return { start: e.timestamp, end: Math.max(end, e.timestamp) };
}

/** a occurs entirely within b's interval. */
export function during(a: TemporalEvent, b: TemporalEvent): boolean {
  const ia = interval(a);
  const ib = interval(b);
  return ia.start >= ib.start && ia.end <= ib.end && !(ia.start === ib.start && ia.end === ib.end);
}

/** Intervals share any overlap (identical instants count as overlap). */
export function overlaps(a: TemporalEvent, b: TemporalEvent): boolean {
  const ia = interval(a);
  const ib = interval(b);
  return ia.start <= ib.end && ib.start <= ia.end;
}

/** Both events fall within the same UTC calendar day. */
export function sameUtcPeriod(a: TemporalEvent, b: TemporalEvent): boolean {
  const DAY = 24 * 60 * 60_000;
  return Math.floor(a.timestamp / DAY) === Math.floor(b.timestamp / DAY);
}

/** Stable sort copy — never mutates the input array. */
export function sortEvents(events: TemporalEvent[]): TemporalEvent[] {
  return [...events].sort(compareEvents);
}
