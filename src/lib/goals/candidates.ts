/**
 * Phase 26 — deterministic goal candidate derivation, scoring,
 * duplicate detection, and conflict detection.
 *
 * Pipeline (§10): conversation → memory intelligence outcomes →
 * candidate extraction (deterministic verb patterns) → score →
 * duplicate/conflict resolution vs existing goals → proposal.
 * No LLM is invoked; semantic interpretation can be added later via
 * ModelGateway by the caller without changing this contract.
 */
import { tokenSimilarity, polarity } from "../memoryIntelligence/fingerprint";
import type { GoalRecord } from "../persistence/firestoreUserStore";
import {
  DEFAULT_CANDIDATE_WEIGHTS,
  CANDIDATE_PROPOSAL_THRESHOLD,
  CandidateWeights,
} from "./types";

const GOAL_INTENT_PATTERN =
  /\b(?:i want to|i need to|i plan to|my goal is|let's|we should|must|aim to|going to)\s+([^.,!?]{3,120})/i;
const COMPLETE_INTENT_PATTERN =
  /\b(?:finish|complete|ship|deploy|launch|deliver)\s+(?:the\s+)?([^.,!?]{3,120})/i;

export interface CandidateInput {
  text: string;
  /** From Phase 23 candidate kinds — only goal-ish kinds considered. */
  kind: "goal" | "project" | "preference" | "fact" | "correction" | "behavior" | "learning" | "event" | "procedure";
  confidence: number;
  memoryId?: string;
  projectKey?: string;
  timestamp?: number;
}

export interface GoalCandidate {
  title: string;
  description: string;
  source: "derived" | "explicit_request";
  confidence: number;
  score: number;
  breakdown: {
    explicitness: number;
    repetition: number;
    futureUsefulness: number;
    projectRelevance: number;
    novelty: number;
    recency: number;
    confidence: number;
  };
  relatedProjectKey?: string;
  evidenceMemoryIds: string[];
}

export type DuplicateRelation =
  | "exact"
  | "near"
  | "related"
  | "child"
  | "conflicting"
  | "none";

export interface DuplicateCheck {
  relation: DuplicateRelation;
  existingId?: string;
  similarity: number;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

/** Deterministic extraction of a goal phrase from user text. */
export function extractGoalPhrase(text: string): { title: string; explicit: boolean } | null {
  const m = text.match(GOAL_INTENT_PATTERN);
  if (m?.[1]) return { title: m[1].trim(), explicit: true };
  const c = text.match(COMPLETE_INTENT_PATTERN);
  if (c?.[1]) return { title: c[1].trim(), explicit: false };
  return null;
}

/**
 * Score candidates deterministically. `recentCandidateTitles` supplies
 * repetition evidence; existing goals supply novelty damping.
 */
export function scoreCandidate(
  input: CandidateInput,
  existingGoals: GoalRecord[],
  recentCandidateTexts: string[] = [],
  weights: CandidateWeights = DEFAULT_CANDIDATE_WEIGHTS,
  nowUtc = Date.now()
): GoalCandidate | null {
  const extracted = extractGoalPhrase(input.text);
  if (!extracted) return null;

  const title = extracted.title.slice(0, 80);
  const lowerTitle = title.toLowerCase();

  const explicitness = extracted.explicit ? 1 : 0.6;
  const repetition = Math.min(1, recentCandidateTexts.filter((t) =>
    t.toLowerCase().includes(lowerTitle.slice(0, 16))
  ).length * 0.34);

  const USEFUL_VERBS = /(learn|build|ship|deploy|fix|write|finish|launch|improve|migrate|automate)/;
  const futureUsefulness = USEFUL_VERBS.test(lowerTitle) ? 0.9 : 0.5;

  let projectRelevance = input.projectKey ? 0.8 : 0.2;
  if (input.projectKey && lowerTitle.includes(input.projectKey.replace(/-/g, " "))) projectRelevance = 1;

  // Novelty damps when an existing goal already covers the topic.
  let bestSim = 0;
  for (const g of existingGoals) {
    if (g.status === "completed" || g.status === "cancelled") continue;
    bestSim = Math.max(bestSim, tokenSimilarity(title, `${g.title} ${g.description}`));
  }
  const novelty = 1 - bestSim;

  const ts = input.timestamp ?? nowUtc;
  const ageDays = Math.max(0, (nowUtc - ts) / (24 * 3600_000));
  const recency = ageDays < 1 ? 1 : ageDays < 7 ? 0.6 : 0.2;

  const confidence = Math.max(0, Math.min(1, input.confidence));

  const breakdown = { explicitness, repetition, futureUsefulness, projectRelevance, novelty, recency, confidence };
  const score =
    explicitness * weights.explicitness +
    repetition * weights.repetition +
    futureUsefulness * weights.futureUsefulness +
    projectRelevance * weights.projectRelevance +
    novelty * weights.novelty +
    recency * weights.recency +
    confidence * weights.confidence;

  if (score < CANDIDATE_PROPOSAL_THRESHOLD) return null;

  return {
    title,
    description: `Derived from: ${input.text.slice(0, 100)}`,
    source: input.kind === "goal" && extracted.explicit ? "explicit_request" : "derived",
    confidence,
    score: Math.max(0, Math.min(1, score)),
    breakdown,
    ...(input.projectKey ? { relatedProjectKey: input.projectKey } : {}),
    evidenceMemoryIds: input.memoryId ? [input.memoryId] : [],
  };
}

/** Classify a would-be goal against the existing set. */
export function checkDuplicate(
  candidateTitle: string,
  existingGoals: GoalRecord[]
): DuplicateCheck {
  let best: DuplicateCheck = { relation: "none", similarity: 0 };
  for (const g of existingGoals) {
    if (g.status === "cancelled") continue;
    const sim = tokenSimilarity(candidateTitle, `${g.title} ${g.description}`);
    if (slug(candidateTitle) === slug(g.title)) {
      return { relation: "exact", existingId: g.id, similarity: 1 };
    }
    if (sim >= 0.75 && sim > best.similarity) {
      best = { relation: "near", existingId: g.id, similarity: sim };
    } else if (sim >= 0.4 && sim > best.similarity) {
      // child-ish: candidate narrower than an existing broad goal
      const relation: DuplicateRelation =
        g.title.toLowerCase().includes(candidateTitle.toLowerCase()) ? "child" : "related";
      best = { relation, existingId: g.id, similarity: sim };
    }

    // Conflicts: opposite polarity on high topic overlap
    if (sim >= 0.5) {
      const pa = polarity(candidateTitle);
      const pb = polarity(`${g.title} ${g.description}`);
      if (
        (pa === "positive" && pb === "negative") ||
        (pa === "negative" && pb === "positive")
      ) {
        return { relation: "conflicting", existingId: g.id, similarity: sim };
      }
    }
  }
  return best;
}
