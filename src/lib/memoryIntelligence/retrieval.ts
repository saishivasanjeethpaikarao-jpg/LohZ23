/**
 * Retrieval scoring: multi-signal, bounded, per-user.
 *
 * Weights documented at types.ts. Every component maps to 0..1 so the
 * final score is interpretable and caps at 1.0. Output is sorted and
 * slice-bounded by the caller's MemoryBudget.
 */
import type { Memory } from "../memoryTypes";
import type { MemoryBudget, RetrievalWeights } from "./types";
import { DEFAULT_RETRIEVAL_WEIGHTS } from "./types";
import { tokenSimilarity } from "./fingerprint";
import { isArchived } from "./enrichment";

export interface RetrievalQuery {
  userId: string;
  query?: string;
  layer?: string;
  category?: string;
  minImportance?: number;
  minConfidence?: number;
  limit?: number;
  /** Current conversation turns, for recency/context overlap. */
  conversationContext?: string[];
  /** Active goals, for goalAlignment scoring. */
  activeGoals?: string[];
  now?: number;
}

export interface ScoredMemory {
  memory: Memory;
  score: number;
  breakdown: {
    semantic: number;
    importance: number;
    confidence: number;
    recency: number;
    goalAlignment: number;
    layerAffinity: number;
  };
  /** Marked memories included only when the caller asks. */
  archived: boolean;
}

const RECENCY_FULL_DAYS = 7;

function tokenOverlapRatio(a: string, b: string): number {
  if (!b.trim()) return 0;
  const bTokens = new Set(b.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
  if (bTokens.size === 0) return 0;
  const aTokens = new Set(a.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
  let hit = 0;
  for (const t of bTokens) if (aTokens.has(t)) hit++;
  return hit / bTokens.size;
}

function activeGoalsFromMemory(mem: Memory): string {
  return mem.text.toLowerCase();
}

export function scoreMemory(
  mem: Memory,
  q: RetrievalQuery,
  weights: RetrievalWeights = DEFAULT_RETRIEVAL_WEIGHTS
): ScoredMemory | null {
  if (mem.metadata.userId !== q.userId) return null;
  if (q.layer && mem.layer !== q.layer) return null;
  if (q.category && mem.category !== q.category) return null;
  if (q.minImportance !== undefined && mem.metadata.importance < q.minImportance) return null;
  if (q.minConfidence !== undefined && mem.metadata.confidence < q.minConfidence) return null;

  const now = q.now ?? Date.now();

  let semantic = 0;
  if (q.query) semantic = tokenSimilarity(mem.text, q.query);

  const contextText = (q.conversationContext ?? []).join(" ");
  const semanticContext = contextText ? tokenOverlapRatio(mem.text, contextText) : 0;
  semantic = Math.max(semantic, semanticContext * 0.9);

  const importance = Math.max(0, Math.min(1, mem.metadata.importance ?? 0.5));
  const confidence = Math.max(0, Math.min(1, mem.metadata.confidence ?? 0.5));

  const ageDays = Math.max(0, (now - mem.metadata.timestamp) / (1000 * 60 * 60 * 24));
  const recency = ageDays >= RECENCY_FULL_DAYS ? 0 : 1 - ageDays / RECENCY_FULL_DAYS;

  let goalAlignment = 0;
  if (q.activeGoals?.length) {
    const memText = activeGoalsFromMemory(mem);
    const hits = q.activeGoals.filter((g) => {
      const gTokens = g.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
      return gTokens.some((t) => memText.includes(t));
    }).length;
    goalAlignment = Math.min(1, hits / Math.max(1, q.activeGoals.length));
  }

  let layerAffinity = 0.5;
  if (q.layer && mem.layer === q.layer) layerAffinity = 1;
  else if (mem.layer === "semantic") layerAffinity = 0.7;
  else if (mem.layer === "user_model") layerAffinity = 0.6;

  const score =
    semantic * weights.semantic +
    importance * weights.importance +
    confidence * weights.confidence +
    recency * weights.recency +
    goalAlignment * weights.goalAlignment +
    layerAffinity * weights.layerAffinity;

  return {
    memory: mem,
    score: Math.max(0, Math.min(1, score)),
    breakdown: { semantic, importance, confidence, recency, goalAlignment, layerAffinity },
    archived: isArchived(mem),
  };
}

/** Score + filter + sort + limit in one call. */
export function retrieve(
  memories: Memory[],
  q: RetrievalQuery,
  budget: MemoryBudget,
  weights: RetrievalWeights = DEFAULT_RETRIEVAL_WEIGHTS
): ScoredMemory[] {
  const scored: ScoredMemory[] = [];
  for (const mem of memories) {
    const s = scoreMemory(mem, q, weights);
    if (s) scored.push(s);
  }
  scored.sort((a, b) => b.score - a.score);
  const limit = Math.min(q.limit ?? budget.maxRetrievalResults, budget.maxRetrievalResults);
  return scored.slice(0, limit);
}
