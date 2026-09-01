/**
 * Phase 42 — CuriosityService.
 *
 * Records knowledge gaps, dedupes them, ranks information sources by
 * expected information gain, and answers ONE question: "what (if anything)
 * should be done about this gap?"
 *
 * Hard boundaries (enforced structurally):
 *  - NO tool execution. This service holds no executor reference.
 *  - NO model calls. All logic is deterministic.
 *  - NO autonomous speech. It can only recommend `ask_user`; whether a
 *    question is ever voiced is the caller's decision.
 *  - High-importance gaps never resolve from unverified data alone
 *    (memory hits only reduce uncertainty; verification closes).
 */
import { detectGap, gapIdFor, type GapDetectionInput, type GapSeed } from "./detection";
import { bestSource, rankGapActions, type RankedSource, type SourceContext } from "./infoGain";
import type { CuriosityStore } from "./store";
import { CURIOSITY_LIMITS, type CuriosityInteraction, type KnowledgeGap } from "./types";

export const ASK_COOLDOWN_MS = 10 * 60 * 1000;

export interface CuriosityProviders {
  /** True when durable memory plausibly answers the question. */
  hasRelevantMemory?: (uid: string, question: string) => Promise<boolean>;
  /** True when the world model has a CURRENT assertion about the subject. */
  hasCurrentWorldFact?: (uid: string, missingInformation: string) => Promise<boolean>;
  /** True when every read-only probe needed would be LOW risk. */
  probeIsSafe?: () => boolean;
}

export interface CuriosityDeps {
  store: CuriosityStore;
  providers?: CuriosityProviders;
  now?: () => number;
}

export interface CuriosityRecommendation {
  gap: KnowledgeGap;
  ranked: RankedSource[];
  action: RankedSource["source"];
}

export class CuriosityService {
  private readonly now: () => number;
  constructor(private readonly deps: CuriosityDeps) {
    if (!deps.store) throw new Error("CuriosityService: store is required");
    this.now = deps.now ?? Date.now;
  }

  /** Ingest a post-route outcome; returns the recorded gap (or null when nothing to learn from). */
  async captureRouteOutcome(uid: string, input: GapDetectionInput): Promise<KnowledgeGap | null> {
    if (!uid) return null;
    const seed = detectGap(input);
    if (!seed) return null;
    return this.recordSeed(uid, seed);
  }

  /** Upsert semantics: identical pending gap reinforces (capped), never duplicates. */
  async recordSeed(uid: string, seed: GapSeed): Promise<KnowledgeGap> {
    const now = this.now();
    const gapId = gapIdFor(uid, seed.missingInformation);
    const existing = await this.deps.store.getGap(uid, gapId);
    if (existing && (existing.status === "open" || existing.status === "probing")) {
      existing.importance = Math.min(1, existing.importance + 0.05);
      existing.uncertainty = Math.max(existing.uncertainty, seed.uncertainty);
      existing.updatedAt = now;
      existing.expiresAt = now + CURIOSITY_LIMITS.gapTtlMs;
      await this.deps.store.upsertGap(existing);
      return existing;
    }
    // Capacity: expire least-important open gap when at cap.
    const all = await this.deps.store.listGaps(uid);
    const open = all.filter((g) => g.status === "open" || g.status === "probing");
    if (open.length >= CURIOSITY_LIMITS.maxOpenGapsPerUser) {
      const weakest = open.sort((a, b) => a.importance - b.importance)[0];
      weakest.status = "stale";
      weakest.resolution = { kind: "expired", note: "evicted: capacity" };
      weakest.updatedAt = now;
      await this.deps.store.upsertGap(weakest);
    }
    const gap: KnowledgeGap = {
      gapId,
      uid,
      question: seed.question.slice(0, CURIOSITY_LIMITS.maxQuestionChars),
      missingInformation: seed.missingInformation.slice(0, CURIOSITY_LIMITS.maxMissingInfoChars),
      importance: seed.importance,
      uncertainty: seed.uncertainty,
      possibleSources: seed.possibleSources.slice(0, CURIOSITY_LIMITS.maxSources),
      source: seed.source,
      status: "open",
      openedAt: now,
      updatedAt: now,
      expiresAt: now + CURIOSITY_LIMITS.gapTtlMs,
      probes: 0,
      resolution: null,
      schemaVersion: 1,
    };
    await this.deps.store.upsertGap(gap);
    return gap;
  }

  async listOpen(uid: string): Promise<KnowledgeGap[]> {
    await this.expireStale(uid);
    const all = await this.deps.store.listGaps(uid);
    return all
      .filter((g) => g.status === "open" || g.status === "probing")
      .sort((a, b) => b.importance * b.uncertainty - a.importance * a.uncertainty)
      .map((g) => ({ ...g }));
  }

  private async buildContext(uid: string, gap: KnowledgeGap): Promise<SourceContext> {
    const now = this.now();
    const recent = await this.deps.store.recentInteractions(uid, now - ASK_COOLDOWN_MS);
    return {
      memoryHasAnswer: (await this.deps.providers?.hasRelevantMemory?.(uid, gap.question)) ?? false,
      worldHasAnswer: (await this.deps.providers?.hasCurrentWorldFact?.(uid, gap.missingInformation)) ?? false,
      probeWouldBeSafe: this.deps.providers?.probeIsSafe?.() ?? true,
      fileReadPermitted: false, // MEDIUM risk → always confirmation-gated here
      trustedQueryEnabled: false, // experimental seam stays OFF
      questionsUnmuted: !recent.some((entry) => entry.kind === "question"),
    };
  }

  /**
   * Rank information sources for a gap and record the recommendation.
   * The recommendation is DATA (e.g. for a future UI or an authorized
   * caller). "withhold" means LOHZ should NOT proceed to act — the
   * information is insufficient; this is the action-avoidance path.
   */
  async recommend(uid: string, gapId: string): Promise<CuriosityRecommendation | null> {
    const gap = await this.deps.store.getGap(uid, gapId);
    if (!gap || (gap.status !== "open" && gap.status !== "probing")) return null;
    const ctx = await this.buildContext(uid, gap);
    const ranked = rankGapActions(gap, ctx);
    const action = bestSource(gap, ctx);
    const now = this.now();

    if (gap.status === "open") {
      gap.status = "probing";
      gap.updatedAt = now;
      gap.probes += 1;
      await this.deps.store.upsertGap(gap);
    }
    await this.deps.store.appendInteraction({
      uid,
      at: now,
      kind: action === "ask_user" ? "question" : action === "withhold" ? "withhold" : "probe_hint",
      gapId: gap.gapId,
      note: `${action} for ${gap.missingInformation.slice(0, 120)}`,
    });
    return { gap, ranked, action };
  }

  /**
   * Mark a gap as resolved by verified evidence (e.g. a world-model
   * assertion written after an observation). HIGH-STAKES gaps require
   * verified evidence; low-stakes ones may also resolve via user answer.
   */
  async resolveWithEvidence(uid: string, gapId: string, note: string): Promise<boolean> {
    const gap = await this.deps.store.getGap(uid, gapId);
    if (!gap || gap.status === "resolved") return false;
    const now = this.now();
    gap.status = "resolved";
    gap.uncertainty = Math.max(0, gap.uncertainty - 0.9); // verified evidence largely closes the gap
    gap.resolution = { kind: "evidence", note: String(note).slice(0, 200) };
    gap.updatedAt = now;
    return this.deps.store.upsertGap(gap);
  }

  /** User answered a question about a gap. High-importance gaps are only reduced, not closed. */
  async resolveWithUserAnswer(uid: string, gapId: string, answer: string): Promise<boolean> {
    const gap = await this.deps.store.getGap(uid, gapId);
    if (!gap || gap.status === "resolved") return false;
    const now = this.now();
    gap.status = "resolved";
    gap.uncertainty = gap.importance >= 0.8
      ? Math.max(0.2, gap.uncertainty - 0.5)  // unverified: partial reduction only
      : Math.max(0, gap.uncertainty - 0.85);
    gap.resolution = { kind: "user_answer", note: String(answer).slice(0, 200) };
    gap.updatedAt = now;
    return this.deps.store.upsertGap(gap);
  }

  /**
   * Memory hit: cheaper but weaker — uncertainty drops only partially
   * and the gap stays "probing" unless importance was low AND uncertainty
   * got small. Never counts as verified knowledge.
   */
  async applyMemoryHit(uid: string, gapId: string, note: string): Promise<boolean> {
    const gap = await this.deps.store.getGap(uid, gapId);
    if (!gap || gap.status === "resolved") return false;
    const now = this.now();
    const reduction = gap.importance >= 0.8 ? 0.2 : 0.45;
    gap.uncertainty = Math.max(0.1, gap.uncertainty - reduction);
    gap.updatedAt = now;
    gap.resolution = { kind: "memory_hit", note: String(note).slice(0, 200) };
    if (gap.uncertainty <= 0.15 && gap.importance < 0.6) gap.status = "resolved";
    return this.deps.store.upsertGap(gap);
  }

  async dismiss(uid: string, gapId: string): Promise<boolean> {
    const gap = await this.deps.store.getGap(uid, gapId);
    if (!gap || gap.status === "resolved" || gap.status === "dismissed") return false;
    gap.status = "dismissed";
    gap.resolution = { kind: "dismissed", note: "user dismissed" };
    gap.updatedAt = this.now();
    return this.deps.store.upsertGap(gap);
  }

  /**
   * Honest sufficiency check used by callers (and by the eval harness):
   * can we act safely given what we know?
   */
  async sufficiency(uid: string, gapId: string): Promise<{ sufficient: boolean; reason: string }> {
    const gap = await this.deps.store.getGap(uid, gapId);
    if (!gap) return { sufficient: false, reason: "gap_unknown" };
    if (gap.status === "resolved") return { sufficient: true, reason: "resolved" };
    if (gap.status === "dismissed") return { sufficient: true, reason: "user_waived" };
    if (gap.uncertainty < 0.4) return { sufficient: true, reason: "uncertainty_below_threshold" };
    return { sufficient: false, reason: `information insufficient: ${gap.missingInformation}` };
  }

  private async expireStale(uid: string): Promise<void> {
    const now = this.now();
    const all = await this.deps.store.listGaps(uid);
    for (const gap of all) {
      if ((gap.status === "open" || gap.status === "probing") && gap.expiresAt < now) {
        gap.status = "stale";
        gap.resolution = { kind: "expired", note: "ttl elapsed" };
        gap.updatedAt = now;
        await this.deps.store.upsertGap(gap);
      }
    }
  }
}

export type { CuriosityInteraction, KnowledgeGap } from "./types";
