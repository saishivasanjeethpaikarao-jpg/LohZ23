/**
 * Phase 42 — Knowledge Gap / Curiosity / Information-gain module (types).
 *
 * EXPERIMENTAL research module. This is NOT an autonomy mechanism:
 * the service records what LOHZ does not know and RANKS possible
 * information sources; it never executes tools, never speaks, never
 * skips authorization. "Proposals" are data — execution of any probe
 * would still go through the normal planner/executor/policy pipeline.
 */

export const CURIOSITY_LIMITS = {
  maxOpenGapsPerUser: 20,
  maxQuestionChars: 240,
  maxMissingInfoChars: 200,
  maxSources: 6,
  maxInteractionsLogged: 200,
  gapTtlMs: 24 * 60 * 60 * 1000,
  /** Minimum score for a source to be recommended at all. */
  recommendationThreshold: 0.3,
} as const;

export type GapStatus = "open" | "probing" | "resolved" | "stale" | "dismissed";

export type GapSourceKind =
  | "low_confidence_intent"   // classification fell back / clarify loop
  | "missing_entity"          // user referenced something we have no state on
  | "missing_context"         // task context expected but absent
  | "unverified_outcome"      // execution verdict FAILED/INCONCLUSIVE
  | "stale_knowledge"         // relevant world fact is stale/expired
  | "explicit_unknown";       // user explicitly said "I don't know"

export type InfoSourceKind =
  | "ask_user"            // direct question (costly, cooldown-gated)
  | "use_memory"          // durable memory lookup (free, unverified)
  | "inspect_state"       // world-model current-state query (free)
  | "safe_probe"          // read-only registry tools (LOW risk only)
  | "inspect_file"        // readFile — MEDIUM risk, confirmation-gated
  | "trusted_query";      // external source — DISABLED by default

export interface GapResolution {
  kind: "evidence" | "user_answer" | "expired" | "dismissed" | "memory_hit" | "probe_verified";
  note: string; // bounded
}

export interface KnowledgeGap {
  gapId: string;
  uid: string;
  /** Bounded natural-language puzzle posed by the system, e.g. "What did the user mean by 'the build'?" */
  question: string;
  /** The concrete missing fact. */
  missingInformation: string;
  /** 0..1 — how much a safe answer would improve the pending decision. */
  importance: number;
  /** 0..1 — current uncertainty IN THE GAP (starts high; reduced by evidence). */
  uncertainty: number;
  possibleSources: InfoSourceKind[];
  source: GapSourceKind;
  status: GapStatus;
  openedAt: number;
  updatedAt: number;
  expiresAt: number;
  probes: number;
  resolution: GapResolution | null;
  schemaVersion: 1;
}

/** Interaction ring entry (questions asked / probes proposed). */
export interface CuriosityInteraction {
  uid: string;
  at: number;
  kind: "question" | "probe_hint" | "withhold";
  gapId: string;
  /** bounded note for evaluation (what was asked/recommended) */
  note: string;
}
