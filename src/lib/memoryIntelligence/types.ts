/**
 * Phase 23 — Memory Intelligence public types.
 *
 * These types wrap the existing `Memory`/`MemoryTransaction` shapes from
 * `memoryTypes.ts` (which stay unchanged) with the analyst-side metadata
 * the new pipeline produces: classification kind, scored importance and
 * confidence, archival status, supersession lineage, and the deterministic
 * fingerprint used for dedup.
 */
import type { Memory, MemoryLayer, MemoryCategory } from "../memoryTypes";

/** What kind of durable information a candidate carries. */
export type CandidateKind =
  | "fact"
  | "preference"
  | "goal"
  | "behavior"
  | "event"
  | "correction"
  | "learning"
  | "procedure"
  | "chatter"; // explicitly not memory-worthy

export type MemoryAction = "ADD" | "UPDATE" | "KEEP" | "IGNORE" | "ARCHIVE" | "REMOVE";

export type ArchiveReason = "decay" | "superseded" | "user_requested" | "pruned";

export type ConfidenceSource =
  | "explicit"     // user directly stated it
  | "repeated"     // same information seen before
  | "inferred"     // derived from context
  | "model";       // produced by an LLM call (never auto-trusted)

export interface ImportanceBreakdown {
  explicitness: number;  // 0..1 — how directly the user stated it
  futureUsefulness: number; // 0..1 — heuristically useful later
  repetition: number;    // 0..1 — seen across multiple turns/memories
  stability: number;     // 0..1 — category-inherent durability
  goalRelevance: number; // 0..1 — overlaps active goals
  recency: number;       // 0..1 — freshness
}

export interface ConfidenceFactors {
  base: number;
  explicitBoost: number;
  repeatBoost: number;
  recencyBoost: number;
  contradictionPenalty: number;
  stalenessPenalty: number;
}

/** A candidate memory extracted from conversation, before persistence. */
export interface MemoryCandidate {
  kind: Exclude<CandidateKind, "chatter">;
  text: string;
  category: MemoryCategory;
  layer: MemoryLayer;
  importance: number;
  importanceBreakdown: ImportanceBreakdown;
  confidence: number;
  confidenceFactors: ConfidenceFactors;
  confidenceSource: ConfidenceSource;
  fingerprint: string;
  evidence: string[];
  source: "conversation" | "reflection" | "observation" | "user_correction";
  userId: string;
}

export interface DedupeResolution {
  kind: "duplicate" | "contradiction" | "distinct";
  existingId?: string;
  similarity: number;
}

export interface ContradictionResolution {
  kind: "correction" | "preference_change" | "temporary_exception" | "ambiguity" | "genuine";
  existingId: string;
  similarity: number;
  rationale: string;
}

export interface DecidedAction {
  action: MemoryAction;
  candidate: MemoryCandidate;
  /** For UPDATE/ARCHIVE/REMOVE/KEEP actions: the target memory's id. */
  targetId?: string;
  reason: string;
}

/** Extended Memory with Phase 23 metadata riding on the existing shape. */
export interface EnrichedMemoryMetadata extends Memory {
  metadata: Memory["metadata"] & {
    kind?: CandidateKind;
    status?: "active" | "archived";
    archivedAt?: number;
    archiveReason?: ArchiveReason;
    supersededBy?: string;
    fingerprint?: string;
    evidence?: string[];
  };
}

/** Weights for the deterministic importance model. Sum ≈ 1. */
export interface ImportanceWeights {
  explicitness: number;
  futureUsefulness: number;
  repetition: number;
  stability: number;
  goalRelevance: number;
  recency: number;
}

export const DEFAULT_IMPORTANCE_WEIGHTS: ImportanceWeights = {
  explicitness: 0.30,
  futureUsefulness: 0.25,
  repetition: 0.15,
  stability: 0.10,
  goalRelevance: 0.10,
  recency: 0.10,
};

/** Weights for the retrieval scoring model. */
export interface RetrievalWeights {
  semantic: number;
  importance: number;
  confidence: number;
  recency: number;
  goalAlignment: number;
  layerAffinity: number;
}

export const DEFAULT_RETRIEVAL_WEIGHTS: RetrievalWeights = {
  semantic: 0.30,
  importance: 0.25,
  confidence: 0.15,
  recency: 0.15,
  goalAlignment: 0.10,
  layerAffinity: 0.05,
};

/** Hard resource bounds for the memory subsystem. */
export interface MemoryBudget {
  maxWorkingMemories: number;
  maxRetrievalResults: number;
  maxCandidatesPerSlice: number;
  maxModelCompareCalls: number;
  maxMemoriesPerUser: number;
  decaySweepLimit: number;
}

export const DEFAULT_MEMORY_BUDGET: MemoryBudget = {
  maxWorkingMemories: 20,
  maxRetrievalResults: 10,
  maxCandidatesPerSlice: 10,
  maxModelCompareCalls: 3,
  maxMemoriesPerUser: 500,
  decaySweepLimit: 100,
};

export const ALL_MEMORY_ACTIONS: MemoryAction[] = ["ADD", "UPDATE", "KEEP", "IGNORE", "ARCHIVE", "REMOVE"];
