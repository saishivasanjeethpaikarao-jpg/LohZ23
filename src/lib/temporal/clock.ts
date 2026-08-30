/**
 * Phase 25 — deterministic clock helpers.
 *
 * All functions are pure: they take an explicit `nowUtc` (epoch ms) and
 * return buckets/booleans computed from absolute UTC arithmetic plus
 * UTC-calendar day boundaries. No locale, no hidden Date.now(), no
 * natural-language assumptions. DST cannot corrupt ordering because
 * ordering never uses wall-clock fields; day-level bucketing is defined
 * on UTC days (presentation layers may localize separately).
 */
import type { RelativeBucket } from "./types";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Start of the UTC calendar day containing `ts`. */
export function startOfUtcDay(ts: number): number {
  return Math.floor(ts / DAY) * DAY;
}

/** Whole UTC-day difference between two instants. */
export function utcDayDiff(fromTs: number, toTs: number): number {
  return Math.floor((startOfUtcDay(toTs) - startOfUtcDay(fromTs)) / DAY);
}

/**
 * Deterministic relative bucket ladder:
 *   <2min just_now · <1h minutes_ago · <12h hours_ago
 *   then calendar-based: today · yesterday · this_week(2-6d)
 *   last_week(7-13d) · recent(<30d) · stale(≥30d)
 */
export function relativeBucket(tsUtc: number, nowUtc: number): RelativeBucket {
  if (tsUtc > nowUtc) return "just_now"; // future timestamps clamp conservatively
  const delta = nowUtc - tsUtc;
  if (delta < 2 * MINUTE) return "just_now";
  if (delta < HOUR) return "minutes_ago";
  if (delta < 12 * HOUR) return "hours_ago";
  const dayDiff = utcDayDiff(tsUtc, nowUtc);
  if (dayDiff <= 0) return "today";
  if (dayDiff === 1) return "yesterday";
  if (dayDiff <= 6) return "this_week";
  if (dayDiff <= 13) return "last_week";
  if (dayDiff < 30) return "recent";
  return "stale";
}

/** Window membership against explicit configurable durations. */
export function inWindow(
  tsUtc: number,
  nowUtc: number,
  windowMs: number
): boolean {
  return tsUtc <= nowUtc && nowUtc - tsUtc <= windowMs;
}

/** Absolute staleness for arbitrary records with a last-touched stamp. */
export function isStaleByDays(lastActivityUtc: number, nowUtc: number, days: number): boolean {
  return nowUtc - lastActivityUtc > days * DAY;
}

export const CLOCK_CONSTANTS = { SECOND, MINUTE, HOUR, DAY };
