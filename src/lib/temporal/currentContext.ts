/**
 * Phase 25 — derived current context and temporal interpretations.
 *
 * Pure functions over existing Phase 24 structures. Nothing here
 * mutates the UserModel; project/goal temporal states are DERIVED from
 * timestamps already stored (project.lastActivity, goal.updatedAt) —
 * no duplicated state, no second ranking engine.
 */
import type { UserModelBundle, UserProject } from "../userModel/types";
import type { TemporalEvent, TopicContinuity } from "./types";
import { relativeBucket, isStaleByDays } from "./clock";

/** Derived project temporality — status is unchanged; interpretation only (§10). */
export type ProjectTemporalState = "just_active" | "recently_active" | "quiet" | "stale";

export function projectTemporalState(p: UserProject, nowUtc: number): ProjectTemporalState {
  if (p.status === "completed" || p.status === "archived") return "quiet";
  const bucket = relativeBucket(p.lastActivity, nowUtc);
  if (bucket === "stale") return "stale";
  if (bucket === "just_now" || bucket === "minutes_ago") return "just_active";
  if (bucket === "hours_ago" || bucket === "today") return "recently_active";
  return p.stale ? "stale" : "quiet";
}

/** Derived goal temporality referencing GoalSystem records by ID only (§11). */
export interface GoalRef {
  id: string;
  status: string;
  updatedAt: number;
  progress?: number;
}

export type GoalTemporalState = "new" | "active" | "progressing" | "blocked" | "stale" | "completed";

export function goalTemporalState(g: GoalRef, nowUtc: number): GoalTemporalState {
  if (g.status === "completed" || g.status === "cancelled") return "completed";
  if (g.status === "blocked") return "blocked";
  const ageDays = (nowUtc - g.updatedAt) / (24 * 60 * 60_000);
  const isNew = ageDays <= 1 && g.progress === undefined || g.progress === 0;
  if (isNew && ageDays <= 1) return "new";
  if (ageDays > 14) return "stale";
  if ((g.progress ?? 0) > 0) return "progressing";
  return "active";
}

/** Bounded CurrentContext snapshot — derived, never a model copy (§6). */
export interface CurrentContext {
  uid: string;
  generatedAt: number;
  timeContext: { hourOfDay: number; dayOfWeek: number; utcDate: string };
  interactionMode: string | null;
  activeProject: { key: string; displayName: string; focus: string | null; temporalState: ProjectTemporalState } | null;
  activeGoals: string[];
  recentImportantEvents: TemporalEvent[];
  recentMemoryUpdates: number;
  topics: Array<Pick<TopicContinuity, "key" | "status">>;
  conversationContinuity: {
    lastEventAt: number | null;
    absenceMs: number | null;
    sessionKindHint: string | null;
  };
}

const IMPORTANT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "preference_changed", "project_started", "project_paused", "project_resumed",
  "project_completed", "goal_completed", "important_decision", "user_returned",
]);

export interface CurrentContextInput {
  uid: string;
  bundle: UserModelBundle;
  events: TemporalEvent[]; // pre-bounded (e.g., last ≤50)
  topics: TopicContinuity[];
  absenceMs: number | null;
  sessionKindHint?: string | null;
  memoryUpdatesLastWindow?: number;
  nowUtc: number;
}

export function buildCurrentContext(input: CurrentContextInput): CurrentContext {
  const { bundle, events, nowUtc } = input;
  const d = new Date(nowUtc);

  const activeProjects = bundle.projects
    .filter((p) => p.status === "active")
    .sort((a, b) => b.lastActivity - a.lastActivity);
  const top = activeProjects[0];

  return {
    uid: input.uid,
    generatedAt: nowUtc,
    timeContext: {
      hourOfDay: d.getUTCHours(),
      dayOfWeek: d.getUTCDay(),
      utcDate: d.toISOString().slice(0, 10),
    },
    interactionMode: bundle.world.interactionMode,
    activeProject: top
      ? {
          key: top.key,
          displayName: top.displayName,
          focus: top.currentFocus,
          temporalState: projectTemporalState(top, nowUtc),
        }
      : null,
    activeGoals: [...bundle.activeGoalIds],
    recentImportantEvents: events
      .filter((e) => IMPORTANT_EVENT_TYPES.has(e.type))
      .slice(-8),
    recentMemoryUpdates: Math.max(0, Math.min(999, input.memoryUpdatesLastWindow ?? 0)),
    topics: input.topics.slice(-10).map((t) => ({ key: t.key, status: t.status })),
    conversationContinuity: {
      lastEventAt: events.length ? events[events.length - 1].timestamp : null,
      absenceMs: input.absenceMs,
      sessionKindHint: input.sessionKindHint ?? null,
    },
  };
}

/**
 * Continuity evidence for a returning utterance like "let's continue
 * that": surfaces the most plausible topic WITHOUT assuming it (§8).
 * Deterministic: most recently seen non-completed topic wins; caller
 * decides how to use the hint.
 */
export function continuityHint(topics: TopicContinuity[], projects: UserProject[], nowUtc: number): {
  topicKey: string | null;
  basis: "active_topic" | "recent_topic" | null;
} {
  const usable = topics
    .filter((t) => t.status !== "completed")
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const top = usable[0];
  if (!top) return { topicKey: null, basis: null };
  const bucket = relativeBucket(top.lastSeenAt, nowUtc);
  if (bucket === "just_now" || bucket === "minutes_ago" || bucket === "hours_ago" || bucket === "today" || bucket === "yesterday") {
    return { topicKey: top.key, basis: "active_topic" };
  }
  if (bucket === "this_week" || bucket === "last_week") {
    // Cross-check against project staleness before offering older topics.
    const linked = projects.find((p) => p.key === top.refProjectKey);
    if (!linked || !isStaleByDays(linked.lastActivity, nowUtc, 30)) {
      return { topicKey: top.key, basis: "recent_topic" };
    }
  }
  return { topicKey: null, basis: null };
}
