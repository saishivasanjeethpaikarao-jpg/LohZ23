/**
 * Phase 31 - integration pipeline.
 *
 * ONE composition point over the existing authorities (router, planner,
 * executor, observer, memory intelligence, user model, temporal, goals).
 * Adds NOTHING new architecturally: no second router/planner/store.
 *
 * Responsibilities:
 *  - handleAuthenticatedText(): single entry for typed/voice-transcript
 *    text -> CognitiveRouter (tier decision stays inside the router).
 *  - post-action integration: memory outcomes -> UserModel (+ goal
 *    evidence), execution outcomes -> bounded lesson candidates.
 *  - noise discipline: trivial Tier 0 actions create NO memories,
 *    NO temporal events, NO goals.
 */
import type { CognitiveRouter, RouteOutcome } from "../router/cognitiveRouter";
import type { MemoryIntelligenceService } from "../memoryIntelligence/memoryIntelligence";
import type { UserModelEngine } from "../userModel/engine";
import { outcomesFromProcessResultLite } from "./memoryBridge";
import type { Memory } from "../memoryTypes";
import { recordLesson } from "../memoryIntelligence/learningSeam";
import type { CognitiveCore } from "../cognitive/cognitiveCore";
import type { ConversationParticipantState, SpeakerAuthorization } from "../conversation/types";

export interface IntegrationPipelineDeps {
  router: CognitiveRouter;
  /** Phase 32 — when present, the pipeline delegates through the
   *  Cognitive Core (decision + SituationFrame + consistency checks);
   *  the SAME router still executes every tier underneath. */
  core?: CognitiveCore;
  memoryIntel?: MemoryIntelligenceService;
  userModel?: UserModelEngine;
  /** Phase 26 manager seam (derived goals stay proposed). */
  proposeGoalsFromEvidence?: (userId: string, texts: string[], memoryIds: string[]) => Promise<number>;
  /** Bounded lesson candidate on meaningful completed/recovered work. */
  recordLessonCandidate?: (userId: string, text: string) => Promise<void>;
  /** Passive Phase 37 observation. It cannot alter the cognitive outcome. */
  onCognitiveOutcome?: (userId: string, outcome: { success: boolean; tier?: string; errorKind?: string }) => Promise<void>;
}

export interface PipelineHandleResult extends RouteOutcome {
  /** Post-action integration performed after routing (bounded counts). */
  integration?: {
    userModelAttributesTouched?: number;
    goalsProposed?: number;
    lessonRecorded?: boolean;
  };
  /** Phase 32 layers when the pipeline runs through the Cognitive Core. */
  decision?: import("../cognitive/types").CognitiveDecision;
  verificationStatus?: import("../cognitive/types").VerificationStatus;
  consistency?: { consistent: boolean; reason?: string };
}

export class IntegrationPipeline {
  constructor(private deps: IntegrationPipelineDeps) {
    if (!deps.router) throw new Error("IntegrationPipeline: router is required");
  }

  /**
   * Single authoritative text entry. Voice transcripts and typed input
   * share this path verbatim (normalization lives in the router).
   */
  async handleAuthenticatedText(userId: string, text: string, opts: {
    requestId?: string;
    speakerAuthorization?: SpeakerAuthorization;
    conversation?: ConversationParticipantState;
  } = {}): Promise<PipelineHandleResult> {
    if (!userId) throw new Error("IntegrationPipeline: authenticated uid required");
    try {
      if (this.deps.core) {
        // Single substrate: core decides + frames, router still executes.
        const result = await this.deps.core.process(userId, text, opts);
        const raw = result.raw as RouteOutcome | undefined;
        if (!raw) throw new Error("IntegrationPipeline: core returned no raw outcome");
        await this.observeCognitive(userId, { success: raw.success, tier: raw.tier, errorKind: raw.diagnostic?.errorKind });
        return {
          ...raw,
          decision: result.decision,
          verificationStatus: result.verificationStatus,
          consistency: result.consistency,
        } as PipelineHandleResult;
      }
      const outcome = await this.deps.router.route(userId, text, opts);
      await this.observeCognitive(userId, { success: outcome.success, tier: outcome.tier, errorKind: outcome.diagnostic?.errorKind });
      return outcome as PipelineHandleResult;
    } catch (error) {
      await this.observeCognitive(userId, { success: false, errorKind: "pipeline_exception" });
      throw error;
    }
  }

  private async observeCognitive(userId: string, outcome: { success: boolean; tier?: string; errorKind?: string }): Promise<void> {
    if (!this.deps.onCognitiveOutcome) return;
    try { await this.deps.onCognitiveOutcome(userId, outcome); } catch { /* diagnostics never alter response truth */ }
  }

  /**
   * PART 9/10 - connect consolidation results to UserModel + goal
   * evidence. Called by the conversation lifecycle AFTER
   * processConversationSlice succeeds (durable memories only).
   * Trivial chatter never reaches here (pre-gate rejects it upstream).
   */
  async syncMemoryOutcomes(userId: string, memories: Memory[]): Promise<{
    attributesTouched: number;
    goalsProposed: number;
  }> {
    let attributesTouched = 0;
    let goalsProposed = 0;

    if (this.deps.userModel && memories.length > 0) {
      const outcomes = outcomesFromProcessResultLite(memories);
      const results = await this.deps.userModel.applyOutcomes(userId, outcomes);
      attributesTouched = results.filter((r) => r.applied).length;
      try {
        await this.deps.userModel.flush(userId);
      } catch {
        /* debounced persistence retries later; never crashes pipeline */
      }
    }

    if (this.deps.proposeGoalsFromEvidence) {
      const goalMemories = memories.filter((m) => m.category === "goal" || m.category === "project");
      if (goalMemories.length > 0) {
        try {
          goalsProposed = await this.deps.proposeGoalsFromEvidence(
            userId,
            goalMemories.map((m) => m.text),
            goalMemories.map((m) => m.id)
          );
        } catch {
          goalsProposed = 0; // goal proposal failure must not break chat
        }
      }
    }

    return { attributesTouched, goalsProposed };
  }

  /**
   * PART 14 - lesson candidate ONLY for meaningful executions:
   * recovered/replanned work or verified completions of multi-step
   * plans. Tier 0 one-shots never produce lessons.
   */
  async lessonFromExecution(
    userId: string,
    input: { planId?: string; planTitle: string; planStatus: string; hadRecoveryOrReplan: boolean; stepCount: number }
  ): Promise<boolean> {
    if (!this.deps.recordLessonCandidate || !this.deps.memoryIntel) return false;
    const meaningful =
      input.hadRecoveryOrReplan ||
      (input.planStatus === "completed" && input.stepCount > 1);
    if (!meaningful) return false;

    const text =
      input.planStatus === "completed"
        ? `Plan "${input.planTitle}" completed with verification after ${input.stepCount} steps.`
        : `Plan "${input.planTitle}" ended as ${input.planStatus} despite recovery attempts.`;

    try {
      await recordLesson(this.deps.memoryIntel, {
        userId,
        text,
        confidence: input.planStatus === "completed" ? 0.8 : 0.6,
        evidence: [input.planId ?? "execution"],
      });
      await this.deps.recordLessonCandidate(userId, text);
      return true;
    } catch {
      return false; // honest: lesson persistence is best-effort
    }
  }
}
