/**
 * Candidate extraction: conversation turn → typed MemoryCandidate[].
 *
 * Classification is deterministic (pattern tables), not model-driven.
 * Extractors that need nuance beyond the tables are marked `model`
 * confidenceSource and routed through the ModelGateway elsewhere.
 *
 * Overlap between rules is intentional: a turn can produce at most one
 * candidate per rule, and downstream dedupe collapses near-equal ones.
 */
import type {
  MemoryCandidate,
  CandidateKind,
  ImportanceWeights,
  ConfidenceFactors,
  ConfidenceSource,
  ImportanceBreakdown,
} from "./types";
import { DEFAULT_IMPORTANCE_WEIGHTS } from "./types";
import { fingerprint } from "./fingerprint";
import type { MemoryCategory, MemoryLayer } from "../memoryTypes";

interface Rule {
  kind: Exclude<CandidateKind, "chatter">;
  category: MemoryCategory;
  layer: MemoryLayer;
  pattern: RegExp;
  /** Base importance before scoring factors kick in. */
  baseImportance: number;
  /** Base confidence before source modifiers. */
  baseConfidence: number;
  /** High == user stated it directly. */
  explicitness: number;
  /** Category-inherent durability. */
  stability: number;
}

const RULES: Rule[] = [
  // identity facts
  {
    kind: "fact", category: "identity", layer: "user_model",
    pattern: /\bmy name is\s+([a-z][a-z\s-]{1,40})/i,
    baseImportance: 0.9, baseConfidence: 0.95, explicitness: 1.0, stability: 1.0,
  },
  {
    kind: "fact", category: "identity", layer: "user_model",
    pattern: /\bi(?:'m| am)\s+(?:a|an)?\s*([a-z][a-z\s-]{2,40})(?:\.|,|\band\b|$)/i,
    baseImportance: 0.75, baseConfidence: 0.8, explicitness: 0.9, stability: 0.95,
  },
  {
    kind: "fact", category: "identity", layer: "user_model",
    pattern: /\bi work (?:as|at|for)\s+([a-z][a-z\s-]{2,50})/i,
    baseImportance: 0.85, baseConfidence: 0.9, explicitness: 1.0, stability: 0.9,
  },
  // preferences
  {
    kind: "preference", category: "preference", layer: "semantic",
    pattern: /\bi (?:really )?(?:like|love|prefer|enjoy)\s+([^.,!?]{2,80})/i,
    baseImportance: 0.7, baseConfidence: 0.85, explicitness: 1.0, stability: 0.7,
  },
  {
    kind: "preference", category: "preference", layer: "semantic",
    pattern: /\bi (?:don't|do not|dont)?\s*(?:like|hate|dislike|can't stand|cant stand)\s+([^.,!?]{2,80})/i,
    baseImportance: 0.7, baseConfidence: 0.85, explicitness: 1.0, stability: 0.7,
  },
  // goals
  {
    kind: "goal", category: "goal", layer: "episodic",
    pattern: /\bmy goal is\s+([^.,!?]{2,120})/i,
    baseImportance: 0.85, baseConfidence: 0.9, explicitness: 1.0, stability: 0.8,
  },
  {
    kind: "goal", category: "project", layer: "episodic",
    pattern: /\bi(?:'m| am)?\s*(?:working on|building|creating|writing|developing)\s+([^.,!?]{2,120})/i,
    baseImportance: 0.8, baseConfidence: 0.8, explicitness: 0.85, stability: 0.75,
  },
  // behavior patterns
  {
    kind: "behavior", category: "behavior", layer: "procedural",
    pattern: /\bi (?:usually|always|often|tend to)\s+([^.,!?]{2,80})/i,
    baseImportance: 0.65, baseConfidence: 0.8, explicitness: 0.9, stability: 0.85,
  },
  // events
  {
    kind: "event", category: "emotional", layer: "episodic",
    pattern: /\b(?:yesterday|last week|last night|this morning|earlier today)\s*,?\s*(.+)/i,
    baseImportance: 0.5, baseConfidence: 0.65, explicitness: 0.6, stability: 0.3,
  },
  // corrections
  {
    kind: "correction", category: "preference", layer: "semantic",
    pattern: /\bactually,?\s*(?:i|my)\s+(.{2,100})/i,
    baseImportance: 0.8, baseConfidence: 0.85, explicitness: 0.95, stability: 0.8,
  },
  {
    kind: "correction", category: "preference", layer: "semantic",
    pattern: /\b(?:no,?\s*)?that's not (?:right|correct),?\s*(?:i meant|i said)?\s*(.{2,100})?/i,
    baseImportance: 0.85, baseConfidence: 0.9, explicitness: 1.0, stability: 0.85,
  },
  // learning statements ("this worked better")
  {
    kind: "learning", category: "strategy", layer: "procedural",
    pattern: /\b(?:this|that)\s+(?:method|approach|way|strategy|tool)\s+(?:worked|works|was|is)\s+(?:better|faster|easier)\b(.{0,80})/i,
    baseImportance: 0.7, baseConfidence: 0.8, explicitness: 0.9, stability: 0.8,
  },
  // explicit remember-me commands
  {
    kind: "fact", category: "preference", layer: "episodic",
    pattern: /\bremember (?:this|that)[:,]?\s+(.{5,200})/i,
    baseImportance: 0.95, baseConfidence: 0.95, explicitness: 1.0, stability: 0.95,
  },
  // preferences for assistant behavior
  {
    kind: "preference", category: "preference", layer: "user_model",
    pattern: /\bi want (?:you|lohz) to\s+(.{2,120})/i,
    baseImportance: 0.8, baseConfidence: 0.85, explicitness: 1.0, stability: 0.9,
  },
];

const CHATTER_MAX_WORDS = 3;
const CHATTER_PATTERNS = /^(?:ok|okay|yes|no|yeah|nah|sure|fine|thanks|thank you|what|huh|cool|nice|wow|right|lol|hmm|mhm|uh huh|k|huh\?|got it|tell me more|go on|interesting|i see|makes sense)/i;

export interface ExtractionContext {
  userId: string;
  activeGoals?: string[];
  existingCount?: number;
  recentMemoryTexts?: string[];
  timestamp?: number;
}

export interface ExtractionResult {
  candidates: MemoryCandidate[];
  dropped: number; // chatter / unclassified turns
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function futureUsefulness(kind: Exclude<CandidateKind, "chatter">): number {
  switch (kind) {
    case "fact": return 0.9;
    case "preference": return 0.85;
    case "goal": return 0.9;
    case "behavior": return 0.8;
    case "procedure": return 0.9;
    case "learning": return 0.75;
    case "correction": return 0.7;
    case "event": return 0.4;
  }
}

function computeImportance(
  rule: Rule,
  text: string,
  ctx: ExtractionContext,
  weights: ImportanceWeights
): { total: number; breakdown: ImportanceBreakdown } {
  const normalized = text.toLowerCase();
  const goals = ctx.activeGoals ?? [];

  let goalRelevance = 0;
  for (const g of goals) {
    const gt = g.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    if (gt.some((w) => normalized.includes(w))) goalRelevance = 0.8;
  }

  const tokenCount = Math.max(1, normalized.split(/\s+/).length);
  const recency = clamp01(tokenCount > 6 ? 0.9 : 0.6);

  const breakdown: ImportanceBreakdown = {
    explicitness: clamp01(rule.explicitness),
    futureUsefulness: clamp01(futureUsefulness(rule.kind)),
    repetition: 0, // computed later against history; extractor starts at 0
    stability: clamp01(rule.stability),
    goalRelevance: clamp01(goalRelevance),
    recency,
  };

  const total = clamp01(
    breakdown.explicitness * weights.explicitness +
    breakdown.futureUsefulness * weights.futureUsefulness +
    breakdown.repetition * weights.repetition +
    breakdown.stability * weights.stability +
    breakdown.goalRelevance * weights.goalRelevance +
    breakdown.recency * weights.recency
  );

  return { total, breakdown };
}

function computeConfidence(
  rule: Rule,
  source: ConfidenceSource,
  corroborations: number
): { score: number; factors: ConfidenceFactors } {
  const factors: ConfidenceFactors = {
    base: rule.baseConfidence,
    explicitBoost: source === "explicit" ? 0.05 : 0,
    repeatBoost: Math.min(0.15, corroborations * 0.05),
    recencyBoost: 0,
    contradictionPenalty: 0,
    stalenessPenalty: 0,
  };
  const score = clamp01(
    factors.base + factors.explicitBoost + factors.repeatBoost + factors.recencyBoost
    - factors.contradictionPenalty - factors.stalenessPenalty
  );
  return { score, factors };
}

export function extractCandidates(
  turns: Array<{ role: string; content: string }>,
  ctx: ExtractionContext,
  weights: ImportanceWeights = DEFAULT_IMPORTANCE_WEIGHTS
): ExtractionResult {
  if (!ctx.userId) throw new Error("extractCandidates: userId is required");
  const out: MemoryCandidate[] = [];
  let dropped = 0;

  for (const turn of turns) {
    if (turn.role !== "user") continue;
    const text = turn.content?.trim();
    if (!text) { dropped++; continue; }

    const wordCount = text.split(/\s+/).length;
    if (wordCount <= CHATTER_MAX_WORDS && CHATTER_PATTERNS.test(text)) {
      dropped++;
      continue;
    }

    type Hit = { rule: Rule; text: string };
    const hits: Hit[] = [];
    for (const rule of RULES) {
      const m = text.match(rule.pattern);
      if (!m) continue;
      const matchedAny = m[1] ?? m[0];
      const candidateText = typeof matchedAny === "string" ? matchedAny.trim() : "";
      if (candidateText.length < 2 || candidateText.length > 400) continue;
      hits.push({ rule, text: candidateText });
    }

    if (hits.length === 0) dropped++;
    for (const { rule, text: candidateText } of hits.slice(0, 2)) {
      const { total, breakdown } = computeImportance(rule, text, ctx, weights);
      const corroborations = (ctx.recentMemoryTexts ?? []).filter((t) =>
        t.toLowerCase().includes(candidateText.toLowerCase().slice(0, 20))
      ).length;
      const { score, factors } = computeConfidence(rule, "explicit", corroborations);

      out.push({
        kind: rule.kind,
        text: candidateText,
        category: rule.category,
        layer: rule.layer,
        importance: total,
        importanceBreakdown: breakdown,
        confidence: score,
        confidenceFactors: factors,
        confidenceSource: "explicit",
        fingerprint: fingerprint(candidateText),
        evidence: [text],
        source: "conversation",
        userId: ctx.userId,
      });
    }
  }

  return { candidates: out, dropped };
}

/** Simple classifier for free-form text when callers don't need candidates. */
export function classifyUtterance(text: string): CandidateKind {
  const trimmed = text.trim();
  if (!trimmed) return "chatter";
  if (trimmed.split(/\s+/).length <= CHATTER_MAX_WORDS && CHATTER_PATTERNS.test(trimmed)) return "chatter";
  for (const rule of RULES) if (rule.pattern.test(trimmed)) return rule.kind;
  return "chatter";
}
