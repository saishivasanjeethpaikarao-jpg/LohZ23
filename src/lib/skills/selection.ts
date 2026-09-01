/**
 * Phase 38 - skill intent matching.
 *
 * Deterministic, token-overlap matching over an authenticated user's
 * promoted skills. Only skills with status === "promoted" (library
 * "active") and matching requiredContext.environment are eligible.
 *
 * Scoring:
 *   - score = |matched trigger tokens| / |trigger tokens|
 *   - require ≥ min(3, |trigger tokens|) hits AND score ≥ 0.5
 *   - tiebreak by highest version (newest preferred)
 *
 * Matching always returns at most one skill; callers either accept the
 * result or fall through to the next planning stage. A skill whose
 * required inputs cannot be resolved at selection time is treated as if
 * no match was found (the caller must then resort to model-assisted or
 * clarification paths).
 */
import { objectiveTokens } from "../learning/experienceBuilder";
import type { SkillVersion } from "../learning/types";

export interface SkillMatch {
  skill: SkillVersion;
  score: number;
  matchedTokens: string[];
}

export const SKILL_MATCH_THRESHOLD = 0.5;
export const SKILL_MATCH_MIN_HITS = 3;

export function matchSkillIntent(
  versions: SkillVersion[],
  objective: string,
  environment: string
): SkillMatch | null {
  const tokens = new Set(objectiveTokens(objective));
  let best: SkillMatch | null = null;
  for (const version of versions) {
    if (version.status !== "promoted") continue;
    if (version.requiredContext.environment !== environment) continue;
    const triggerTokens = version.trigger.objectiveTokens.slice(0, 12);
    if (triggerTokens.length === 0) continue;
    const hits = triggerTokens.filter((token) => tokens.has(token));
    if (hits.length === 0) continue;
    const score = hits.length / triggerTokens.length;
    const minHits = Math.min(SKILL_MATCH_MIN_HITS, triggerTokens.length);
    if (hits.length < minHits) continue;
    if (score < SKILL_MATCH_THRESHOLD) continue;
    const candidate: SkillMatch = { skill: version, score, matchedTokens: hits };
    if (!best || score > best.score || (score === best.score && version.version > best.skill.version)) {
      best = candidate;
    }
  }
  return best;
}
