/**
 * Phase 26 — goal attention scoring (§15).
 *
 * Pure function. The score answers "what deserves attention?" for later
 * autonomy systems. It authorizes NOTHING by itself.
 */
import type { GoalRecord } from "../persistence/firestoreUserStore";
import {
  DEFAULT_ATTENTION_WEIGHTS,
  AttentionWeights,
} from "./types";

export interface AttentionResult {
  goalId: string;
  score: number;
  breakdown: {
    priority: number;
    deadlineUrgency: number;
    freshness: number;
    progressGap: number;
    userRelevance: number;
    blockerFlag: number;
  };
}

const DAY = 24 * 3600_000;

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function attentionScore(
  goal: GoalRecord,
  nowUtc: number,
  weights: AttentionWeights = DEFAULT_ATTENTION_WEIGHTS
): AttentionResult {
  const priority = clamp01(goal.priority ?? 0.5);

  // Deadline urgency: ramps up over the final 7 days; overdue = 1.
  let deadlineUrgency = 0;
  if (goal.deadline !== undefined) {
    const remaining = goal.deadline - nowUtc;
    if (remaining <= 0) deadlineUrgency = 1;
    else deadlineUrgency = clamp01(1 - remaining / (7 * DAY));
  }

  // Freshness: recently touched goals get a small boost, stale ones none.
  const lastTouch = Math.max(goal.updatedAt, goal.lastProgressAt ?? 0);
  const ageDays = (nowUtc - lastTouch) / DAY;
  const freshness = clamp01(1 - ageDays / 14);

  const progressGap = clamp01(1 - (goal.progress ?? 0));

  const userRelevance =
    goal.source === "user" ? 1 : goal.source === "explicit_request" ? 0.8 : goal.source === "derived" ? 0.4 : 0.2;

  const blockerFlag = goal.status === "blocked" ? 1 : 0;

  const breakdown = { priority, deadlineUrgency, freshness, progressGap, userRelevance, blockerFlag };
  const score = clamp01(
    priority * weights.priority +
    deadlineUrgency * weights.deadlineUrgency +
    freshness * weights.freshness +
    progressGap * weights.progressGap +
    userRelevance * weights.userRelevance +
    blockerFlag * weights.blockerFlag
  );

  return { goalId: goal.id, score, breakdown };
}

/** Effective priority: user-set level is authoritative; modifiers never exceed it. */
export function effectivePriority(
  basePriority: number,
  opts: { hasDeadlineSoon?: boolean; isStale?: boolean; source?: GoalRecord["source"] },
  nowUtc = Date.now()
): number {
  let p = clamp01(basePriority);
  if (opts.isStale) p *= 0.7; // staleness decays, never boosts
  return clamp01(p);
}
