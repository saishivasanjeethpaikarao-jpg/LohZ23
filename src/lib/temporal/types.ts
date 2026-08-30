/**
 * Phase 25 — Temporal reasoning types.
 *
 * A TemporalEvent is a bounded reference (never conversation content).
 * Timestamps are stored as UTC epoch milliseconds exclusively; local
 * formatting happens only at presentation boundaries.
 */

/** Controlled vocabulary — deliberately closed. */
export const TEMPORAL_EVENT_TYPES = [
  "conversation_started",
  "conversation_ended",
  "preference_changed",
  "goal_created",
  "goal_updated",
  "goal_completed",
  // Phase 26 §29 — controlled additions for goal lifecycle events
  "goal_progressed",
  "goal_blocked",
  "goal_unblocked",
  "goal_paused",
  "goal_resumed",
  "goal_cancelled",
  // Phase 29 §14 — observable execution events
  "plan_started",
  "step_completed",
  "step_failed",
  "plan_completed",
  "plan_failed",
  "plan_cancelled",
  // Phase 30 §23 — verification + recovery events
  "step_verified",
  "step_verification_failed",
  "recovery_started",
  "recovery_succeeded",
  "recovery_failed",
  "plan_replanned",
  "project_started",
  "project_activity",
  "project_paused",
  "project_resumed",
  "project_completed",
  "memory_created",
  "memory_updated",
  "memory_archived",
  "important_decision",
  "user_returned",
  "task_started",
  "task_completed",
] as const;

export type TemporalEventType = (typeof TEMPORAL_EVENT_TYPES)[number];

export interface TemporalEvent {
  id: string;
  type: TemporalEventType;
  /** UTC epoch ms — the ONLY timestamp representation stored. */
  timestamp: number;
  userId: string;
  source: "conversation" | "memory_pipeline" | "goal_system" | "observation" | "session";
  /** Optional bounded references — IDs only, never content copies. */
  memoryId?: string;
  goalId?: string;
  projectKey?: string;
  /** Bounded snippet (≤80 chars). */
  description?: string;
  confidence: number;
  importance: number;
  /** Optional duration support for interval semantics. */
  durationMs?: number;
  endTime?: number;
}

/** Bounded temporal windows (configurable, explicit durations). */
export interface TemporalWindows {
  immediateMs: number;
  recentMs: number;
  shortTermMs: number;
  mediumTermMs: number;
  longTermMs: number;
}

export const DEFAULT_TEMPORAL_WINDOWS: TemporalWindows = {
  immediateMs: 5 * 60_000,
  recentMs: 24 * 60 * 60_000,
  shortTermMs: 3 * 24 * 60 * 60_000,
  mediumTermMs: 14 * 24 * 60 * 60_000,
  longTermMs: 60 * 24 * 60 * 60_000,
};

export type WindowName = "immediate" | "recent" | "short_term" | "medium_term" | "long_term";

/** Relative-time buckets — deterministic ladder, UTC-calendar aware. */
export type RelativeBucket =
  | "just_now"
  | "minutes_ago"
  | "hours_ago"
  | "today"
  | "yesterday"
  | "this_week"
  | "last_week"
  | "recent"
  | "stale";

/** Bounded topic-continuity entry. Topics reference projects/memories. */
export interface TopicContinuity {
  key: string;
  displayName: string;
  status: "active" | "recent" | "paused" | "stale" | "completed";
  lastSeenAt: number;
  refProjectKey?: string;
  refMemoryIds: string[];
}

/** Compact checkpoint used for before/after questions (§13). */
export interface StateSnapshot {
  at: number;
  label: string;
  activeProjectKey: string | null;
  openGoalCount: number;
  preferenceKeyCount: number;
}

/** Session continuity — durable but assumption-free (§14). */
export interface SessionInfo {
  sessionId: string;
  startedAt: number;
  lastInteractionAt: number;
  previousSessionEndedAt: number | null;
  /** Absence bookkeeping ONLY — no inferred emotional states (§15). */
  lastInactivityGapMs: number | null;
}

/** Persisted per-user temporal state — fully bounded. */
export interface TemporalState {
  uid: string;
  schemaVersion: number;
  events: TemporalEvent[]; // ring ≤ limits.maxEvents, always sorted ascending
  topics: TopicContinuity[]; // ≤ limits.maxTopics
  snapshots: StateSnapshot[]; // ring ≤ limits.maxSnapshots
  session: SessionInfo | null;
  updatedAt: number;
}

export interface TemporalLimits {
  maxEvents: number;
  maxTopics: number;
  maxSnapshots: number;
  maxRefMemoryIdsPerTopic: number;
  maxQueryResults: number;
}

export const DEFAULT_TEMPORAL_LIMITS: TemporalLimits = {
  maxEvents: 200,
  maxTopics: 12,
  maxSnapshots: 5,
  maxRefMemoryIdsPerTopic: 3,
  maxQueryResults: 50,
};

export const TEMPORAL_SCHEMA_VERSION = 1;

/** Session classification thresholds. */
export const SESSION_SAME_MS = 30 * 60_000; // ≤30min gap = same session
export const SESSION_NEW_MS = 6 * 60 * 60_000; // ≤6h gap = new session, same day-ish

export type SessionKind = "first_visit" | "same_session" | "new_session" | "returning_user";
