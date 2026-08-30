/**
 * Phase 26 — autonomous goal model: schema, authority, state machine,
 * priority, autonomy policy. Deterministic only; no LLM anywhere.
 *
 * Authority (§3): user > explicit_request > derived > system.
 * Derived goals are PROPOSALS until confirmed — they never silently
 * become user commitments.
 */

export type GoalSource = "user" | "explicit_request" | "derived" | "system";

/** Numeric authority ranking — higher wins when priorities collide. */
export const SOURCE_AUTHORITY: Record<GoalSource, number> = {
  user: 4,
  explicit_request: 3,
  derived: 2,
  system: 1,
};

export type GoalLifecycle =
  | "proposed"
  | "active"
  | "progressing"
  | "paused"
  | "blocked"
  | "completed"
  | "cancelled"
  | "stale";

/**
 * Valid lifecycle transitions. Anything not listed is invalid.
 * completed → active requires explicit reopen() which asserts
 * `source === "user" || source === "explicit_request"` or a matching
 * derived goal being explicitly confirmed by the caller.
 */
export const VALID_TRANSITIONS: Record<GoalLifecycle, GoalLifecycle[]> = {
  proposed:   ["active", "cancelled"],
  active:     ["progressing", "paused", "blocked", "completed", "cancelled", "stale"],
  progressing:["active", "paused", "blocked", "completed", "cancelled", "stale"],
  paused:     ["active", "progressing", "cancelled", "stale"],
  blocked:    ["active", "progressing", "cancelled", "stale"],
  completed:  [],            // reopen is a separate explicit operation
  cancelled:  [],            // terminal
  stale:      ["active", "progressing", "paused", "blocked", "cancelled"], // reactivation on evidence
};

export function canTransition(from: GoalLifecycle, to: GoalLifecycle): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export type PriorityLevel = "critical" | "high" | "medium" | "low";

/** Bounded base priorities. Explicit user choice is authoritative. */
export const PRIORITY_LEVEL_BASE: Record<PriorityLevel, number> = {
  critical: 1.0,
  high: 0.75,
  medium: 0.5,
  low: 0.25,
};

export function levelFromPriority(p: number): PriorityLevel {
  if (p >= 0.875) return "critical";
  if (p >= 0.625) return "high";
  if (p >= 0.375) return "medium";
  return "low";
}

/**
 * Autonomy levels — POLICY METADATA ONLY. Nothing in this phase
 * executes tools or external side effects (§17). Phase 27+ consumes.
 */
export const AUTONOMY_LEVELS = {
  observe_only: 0,
  suggest: 1,
  prepare: 2,
  execute_low_risk: 3,
  execute_with_confirmation: 4,
  restricted: 5,
} as const;

export type AutonomyLevelName = keyof typeof AUTONOMY_LEVELS;

/** Default for inferred goals: observe/suggest only. */
export const DEFAULT_DERIVED_AUTONOMY = AUTONOMY_LEVELS.suggest;
export const DEFAULT_USER_AUTONOMY = AUTONOMY_LEVELS.observe_only;

/** Hard resource bounds. */
export interface GoalLimits {
  maxPerUser: number;
  maxChildren: number;
  maxDepth: number;
  maxDependencies: number;
  maxRelatedMemoryIds: number;
  maxCandidatesEvaluated: number;
}

export const GOAL_LIMITS: GoalLimits = {
  maxPerUser: 30,
  maxChildren: 8,
  maxDepth: 3,
  maxDependencies: 5,
  maxRelatedMemoryIds: 5,
  maxCandidatesEvaluated: 20,
};

/** Staleness: active → quiet → stale via Phase 25 temporal rules (§14). */
export const GOAL_STALE_DAYS = 14;

/** Candidate scoring weights (§11) — sum ≈ 1. */
export interface CandidateWeights {
  explicitness: number;
  repetition: number;
  futureUsefulness: number;
  projectRelevance: number;
  novelty: number;
  recency: number;
  confidence: number;
}

export const DEFAULT_CANDIDATE_WEIGHTS: CandidateWeights = {
  explicitness: 0.25,
  repetition: 0.15,
  futureUsefulness: 0.2,
  projectRelevance: 0.15,
  novelty: 0.15,
  recency: 0.05,
  confidence: 0.05,
};

/** Proposals below this score are dropped entirely (§11). */
export const CANDIDATE_PROPOSAL_THRESHOLD = 0.55;

/** Attention score weights (§15) — sum ≈ 1. */
export interface AttentionWeights {
  priority: number;
  deadlineUrgency: number;
  freshness: number;
  progressGap: number;
  userRelevance: number;
  blockerFlag: number;
}

export const DEFAULT_ATTENTION_WEIGHTS: AttentionWeights = {
  priority: 0.30,
  deadlineUrgency: 0.20,
  freshness: 0.10,
  progressGap: 0.15,
  userRelevance: 0.15,
  blockerFlag: 0.10,
};
