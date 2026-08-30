/**
 * Deterministic dedup + contradiction detection.
 *
 * Uses only pure text math so the loop never burns model budget comparing
 * obvious matches — model escalation is reserved for the ambiguous band
 * and gated by the caller.
 */
import type { Memory } from "../memoryTypes";
import type { MemoryCandidate, DedupeResolution, ContradictionResolution } from "./types";
import { tokenSimilarity, polarity } from "./fingerprint";
import { isArchived, readEnrichment } from "./enrichment";

export interface DedupeConfig {
  duplicateThreshold: number;
  /** Token-similarity band where a model may be consulted. */
  ambiguityFloor: number;
  ambiguityCeiling: number;
  contradictionSimilarityFloor: number;
}

export const DEFAULT_DEDUPE_CONFIG: DedupeConfig = {
  duplicateThreshold: 0.8,
  ambiguityFloor: 0.5,
  ambiguityCeiling: 0.8,
  contradictionSimilarityFloor: 0.4,
};

function sameUser(mem: Memory, userId: string): boolean {
  return mem.metadata.userId === userId;
}

function categoryCompatible(mem: Memory, cat: MemoryCandidate["category"]): boolean {
  return mem.category === cat;
}

function expired(mem: Memory): boolean {
  return isArchived(mem);
}

/**
 * Find the strongest existing memory candidate conflicts with.
 * Filtering order (all deterministic):
 *   userId match → not archived → category compatible → fingerprint or
 *   similarity floor → highest similarity.
 */
export function findDuplicate(
  candidate: MemoryCandidate,
  existing: Memory[],
  config: DedupeConfig = DEFAULT_DEDUPE_CONFIG
): DedupeResolution {
  let best: { id: string; similarity: number } | null = null;

  for (const mem of existing) {
    if (!sameUser(mem, candidate.userId)) continue;
    if (expired(mem)) continue;
    if (!categoryCompatible(mem, candidate.category)) continue;

    const storedFp = readEnrichment(mem).fingerprint;
    if (storedFp && storedFp === candidate.fingerprint) {
      return { kind: "duplicate", existingId: mem.id, similarity: 1 };
    }

    const sim = tokenSimilarity(candidate.text, mem.text);
    if (sim >= config.duplicateThreshold) {
      if (!best || sim > best.similarity) {
        best = { id: mem.id, similarity: sim };
      }
    }
  }

  if (best) return { kind: "duplicate", existingId: best.id, similarity: best.similarity };
  return { kind: "distinct", similarity: 0 };
}

export function findContradiction(
  candidate: MemoryCandidate,
  existing: Memory[],
  config: DedupeConfig = DEFAULT_DEDUPE_CONFIG
): ContradictionResolution | null {
  // Correction-kind candidates are strong user signals — accept a wider
  // topic net for them than for passive polarity flips.
  const floor =
    candidate.kind === "correction"
      ? Math.min(config.contradictionSimilarityFloor, 0.15)
      : config.contradictionSimilarityFloor;

  for (const mem of existing) {
    if (!sameUser(mem, candidate.userId)) continue;
    if (expired(mem)) continue;
    if (!categoryCompatible(mem, candidate.category)) continue;

    const enrichment = readEnrichment(mem);
    const memReference = enrichment.evidence?.[0] ?? mem.text;

    const sim = tokenSimilarity(candidate.text, memReference);
    if (sim < floor) continue;

    const polA = polarity(candidate.text);
    const polB = polarity(memReference);

    const isCorrection = candidate.kind === "correction";
    const oppositePolarity =
      (polA === "positive" && polB === "negative") ||
      (polA === "negative" && polB === "positive");

    if (isCorrection || oppositePolarity) {
      const kind: ContradictionResolution["kind"] =
        isCorrection ? "correction"
        : candidate.kind === "preference" ? "preference_change"
        : sim > 0.85 ? "genuine"
        : "ambiguity";

      const rationale = isCorrection
        ? `explicit correction by user (kind=correction)`
        : oppositePolarity
          ? `opposite polarity with high topic similarity (sim=${sim.toFixed(2)})`
          : `high topic similarity without opposite polarity (sim=${sim.toFixed(2)})`;

      return { kind, existingId: mem.id, similarity: sim, rationale };
    }
  }
  return null;
}

/** Determine the dedupe band a comparison falls into. */
export function ambiguityZone(
  similarity: number,
  config: DedupeConfig = DEFAULT_DEDUPE_CONFIG
): "obvious_dup" | "obvious_new" | "ambiguous" {
  if (similarity >= config.duplicateThreshold) return "obvious_dup";
  if (similarity < config.ambiguityFloor) return "obvious_new";
  return "ambiguous";
}
