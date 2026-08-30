/**
 * Action resolution: candidate + comparison result → ADD/UPDATE/KEEP/IGNORE/ARCHIVE/REMOVE.
 *
 * Preservation-over-destruction: preference_change and correction
 * supersede (ARCHIVE old, ADD new); only explicit removal requests or
 * celebrated-garbage patterns produce REMOVE. Importance/confidence
 * floors keep trivia out of Firestore entirely.
 */
import type { Memory } from "../memoryTypes";
import type { DecidedAction, MemoryCandidate, DedupeResolution, ContradictionResolution } from "./types";
import type { DedupeConfig } from "./dedupe";
import { DEFAULT_DEDUPE_CONFIG, ambiguityZone } from "./dedupe";

export interface ResolutionConfig extends DedupeConfig {
  minPersistenceImportance: number;
  minPersistenceConfidence: number;
  /** Band in which model arbitration may be consulted. */
  ambiguityModelEnabled: boolean;
}

export const DEFAULT_RESOLUTION_CONFIG: ResolutionConfig = {
  ...DEFAULT_DEDUPE_CONFIG,
  minPersistenceImportance: 0.25,
  minPersistenceConfidence: 0.4,
  ambiguityModelEnabled: false, // off by default; cost-gated when enabled
};

interface ResolveInput {
  candidate: MemoryCandidate;
  duplicate: DedupeResolution;
  contradiction: ContradictionResolution | null;
  existingLookup: (id: string) => Memory | undefined;
}

export function decideAction(
  input: ResolveInput,
  config: ResolutionConfig = DEFAULT_RESOLUTION_CONFIG
): DecidedAction {
  const { candidate, duplicate, contradiction, existingLookup } = input;

  // 1. Persistence gates — bounded floors, never trust the model blindly.
  if (candidate.importance < config.minPersistenceImportance) {
    return {
      action: "IGNORE", candidate,
      reason: `importance ${candidate.importance.toFixed(2)} below floor ${config.minPersistenceImportance}`,
    };
  }
  if (candidate.confidence < config.minPersistenceConfidence) {
    return {
      action: "IGNORE", candidate,
      reason: `confidence ${candidate.confidence.toFixed(2)} below floor ${config.minPersistenceConfidence}`,
    };
  }

  // 2. Contradiction takes precedence over duplicate reinforcement:
  //    an explicit "actually, I don't like X" is a token-duplicate of
  //    "likes X" but semantically a supersession. Archive old, add new.
  if (contradiction) {
    const existing = existingLookup(contradiction.existingId);
    if (existing) {
      if (contradiction.kind === "ambiguity") {
        return {
          action: "KEEP", candidate, targetId: contradiction.existingId,
          reason: `ambiguous contradiction — preserving historical record; rationale: ${contradiction.rationale}`,
        };
      }
      return {
        action: "ARCHIVE", candidate, targetId: contradiction.existingId,
        reason: `${contradiction.kind}: archive superseded memory, record new. ${contradiction.rationale}`,
      };
    }
  }

  // 3. Exact duplicate — reinforce rather than double-store.
  if (duplicate.kind === "duplicate" && duplicate.existingId) {
    const existing = existingLookup(duplicate.existingId);
    if (existing) {
      return {
        action: "KEEP", candidate, targetId: duplicate.existingId,
        reason: `matches existing memory (sim=${duplicate.similarity.toFixed(2)}) — reinforce`,
      };
    }
  }

  // 4. Ambiguous similarity band — KEEP (never silently merge without model arbitration).
  const zone = ambiguityZone(duplicate.similarity, config);
  if (zone === "ambiguous" && duplicate.existingId) {
    return {
      action: "KEEP", candidate, targetId: duplicate.existingId,
      reason: `ambiguous similarity ${duplicate.similarity.toFixed(2)} in [${config.ambiguityFloor}, ${config.ambiguityCeiling}) — conservative KEEP`,
    };
  }

  // 5. New memory — store it.
  return { action: "ADD", candidate, reason: "novel, above thresholds, no contradiction" };
}

/**
 * Apply a REMOVE explicitly requested by the user (e.g. "forget X").
 * Never called implicitly by confidence/importance floors — those
 * produce IGNORE/ARCHIVE instead.
 */
export function decideRemove(candidate: MemoryCandidate, targetId: string, reason = "user requested removal"): DecidedAction {
  return { action: "REMOVE", candidate, targetId, reason };
}
