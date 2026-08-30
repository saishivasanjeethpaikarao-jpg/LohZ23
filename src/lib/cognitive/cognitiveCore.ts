/**
 * Phase 32 - CognitiveCore.
 *
 * THE single cognitive coordination point per request. It does NOT
 * replace any authority:
 *   - classification  -> existing IntentRouter (consumed, never redone)
 *   - routing/exec    -> existing CognitiveRouter (delegated)
 *   - planning        -> existing HierarchicalPlanner (inside router tier3)
 *   - execution       -> existing PlanExecutionEngine (inside router seam)
 *   - verification    -> existing ObservationCoordinator
 *   - reasoning model -> existing ModelGateway (via router's gateway seam)
 *
 * The Core adds: structured CognitiveDecision derivation, bounded
 * SituationFrame assembly ONLY for tiers that need it, a structured
 * prompt for Tier 2, deterministic consistency checks over outcomes,
 * and truthful CognitiveResult mapping. It NEVER executes tools.
 */
import { classify } from "../router/intentRouter";
import type { RoutingResult } from "../router/types";
import type { CognitiveRouter } from "../router/cognitiveRouter";
import type {
  CognitiveAction,
  CognitiveDecision,
  CognitiveResult,
  LohzCapabilitySnapshot,
  SituationFrame,
  VerificationStatus,
} from "./types";
import type { ContextAssembler, ContextProviders } from "./contextAssembler";
import {
  checkExecutionTruthfulness,
  checkFrameReferences,
  checkToolClaims,
  checkVerificationClaims,
  sanitizeDiagnostic,
} from "./cognitiveGuards";

export interface CoreRouteOptions {
  /** Pre-rendered structured Tier-2 prompt built from the SituationFrame. */
  situationPrompt?: string;
}

/** Minimal structural contract of the router outcome we consume. */
export interface RouterOutcomeLike extends RoutingResult {
  requestId: string;
  lifecycle: readonly string[];
  success: boolean;
  response: string | null;
  toolUsed: string | null;
  modelUsed: string | null;
  modelCalls: number;
  latencyMs: number;
  planId?: string | null;
  plannerCalled?: boolean;
  diagnostic: { errorKind?: string };
}

export interface CognitiveCoreDeps {
  router: CognitiveRouter;
  assembler?: ContextAssembler;
  toolCatalog: () => string[];
  capabilities: Omit<LohzCapabilitySnapshot, "availableTools" | "supportedIntents"> & {
    supportedIntents: string[];
  };
}

function deriveDecision(c: Pick<RoutingResult, "tier" | "intent" | "confidence" | "riskLevel" | "requiresPlanning" | "needsClarification">): CognitiveDecision {
  const base = { confidence: c.confidence, riskLevel: c.riskLevel };
  switch (c.tier) {
    case "tier0_direct":
      return {
        action: "direct_tool",
        ...base,
        requiresPlanning: false,
        requiresModel: false,
        requiresConfirmation: false,
        rationaleMetadata: { reasonCode: "deterministic_command", evidence: ["tier0_intent"] },
      };
    case "tier1_light":
      if (c.intent === "unknown" || c.needsClarification) {
        return {
          action: "clarify",
          ...base,
          requiresPlanning: false,
          requiresModel: false,
          requiresConfirmation: false,
          rationaleMetadata: { reasonCode: "ambiguous_request", evidence: ["low_confidence"] },
        };
      }
      return {
        action: "retrieve_context",
        ...base,
        requiresPlanning: false,
        requiresModel: false,
        requiresConfirmation: false,
        rationaleMetadata: { reasonCode: "context_query", evidence: ["tier1_intent"] },
      };
    case "tier2_reasoning":
      return {
        action: "reason",
        ...base,
        requiresPlanning: false,
        requiresModel: true,
        requiresConfirmation: false,
        rationaleMetadata: { reasonCode: "semantic_reasoning_request", evidence: ["tier2_intent"] },
      };
    case "tier3_autonomous":
      return {
        action: "plan",
        ...base,
        requiresPlanning: true,
        requiresModel: true, // stage-2 planning may call the gateway
        requiresConfirmation: c.riskLevel === "medium" || c.riskLevel === "high",
        rationaleMetadata: { reasonCode: "complex_multi_step_request", evidence: ["tier3_intent"] },
      };
  }
}

function mapVerification(outcome: RouterOutcomeLike): VerificationStatus {
  const explicit = (outcome as RouterOutcomeLike & { verificationStatus?: VerificationStatus }).verificationStatus;
  if (explicit) return explicit;
  const s = String(outcome.response ?? "");
  if (!outcome.success && /inconclusive/i.test(s)) return "INCONCLUSIVE";
  if (outcome.planId) {
    if (/->\s*completed/i.test(s)) return "VERIFIED";
    if (/partial_manual|Confirmation required|awaiting_confirmation/i.test(s)) return "NOT_APPLICABLE";
    if (outcome.success === false) return "FAILED";
    return "UNVERIFIED";
  }
  if (outcome.tier === "tier0_direct") return outcome.success ? "UNVERIFIED" : "FAILED";
  if (outcome.tier === "tier2_reasoning") return "NOT_APPLICABLE";
  return outcome.success ? "UNVERIFIED" : "FAILED";
}

export class CognitiveCore {
  constructor(private deps: CognitiveCoreDeps) {
    if (!deps.router) throw new Error("CognitiveCore: router is required");
    if (!deps.toolCatalog) throw new Error("CognitiveCore: toolCatalog is required");
  }

  /**
   * Single entry. Classification is consumed from the authoritative
   * IntentRouter; SituationFrame is assembled ONLY when the derived
   * action benefits from it (never for tier0 fast path).
   */
  async process(
    userId: string,
    text: string,
    opts: { requestId?: string } = {}
  ): Promise<CognitiveResult> {
    const started = Date.now();
    if (!userId) throw new Error("CognitiveCore: authenticated uid is required");

    // ── Authoritative classification (no re-classification later) ──
    const classification = classify(text);
    const decision = deriveDecision(classification);

    const requestId = opts.requestId ?? `core-${started}-${Math.random().toString(36).slice(2, 8)}`;

    // ── Bounded frame assembly (skipped entirely on the fast path) ──
    let frame: SituationFrame | null = null;
    if (
      this.deps.assembler &&
      (classification.tier === "tier1_light" ||
        classification.tier === "tier2_reasoning" ||
        classification.tier === "tier3_autonomous")
    ) {
      try {
        const assembled = await this.deps.assembler.assemble(userId, requestId, classification, text);
        frame = assembled.frame;
      } catch {
        frame = null; // degrade honestly; providers already record missing lists
      }
    }

    // ── Delegate to the ONE router/execution authority ──
    const routeOpts: { situationPrompt?: string } = {};
    if (frame && classification.tier === "tier2_reasoning") {
      const { renderReasoningPrompt } = await import("./cognitiveGuards");
      routeOpts.situationPrompt = renderReasoningPrompt(frame, text);
    }

    const outcome = (await this.deps.router.route(userId, text, { ...routeOpts, requestId })) as RouterOutcomeLike;

    // ── Deterministic consistency checks ──
    const checks = [
      checkToolClaims(outcome.toolUsed ?? null, this.deps.toolCatalog),
      checkExecutionTruthfulness(outcome.success, outcome.toolUsed ?? null, outcome.lifecycle),
      checkVerificationClaims(outcome.response, mapVerification(outcome)),
      checkFrameReferences(frame, {
        projectKey: outcome.entities?.projectKey ?? null,
        goalId: outcome.entities && "goalId" in outcome.entities
          ? ((outcome.entities as { goalId?: string }).goalId ?? null)
          : null,
      }),
    ];
    const failed = checks.find((c) => !c.consistent);

    const observations = outcome.lifecycle.map((l) => sanitizeDiagnostic(l, 40));

    return {
      requestId: outcome.requestId || requestId,
      userId,
      tier: outcome.tier,
      intent: outcome.intent,
      decision,

      status: outcome.success ? "completed" : "failed",

      response: outcome.response,
      planId: outcome.planId ?? null,
      executionId: null,

      observations,

      modelCalls: outcome.modelCalls,
      latencyMs: Math.max(0, Date.now() - started),
      confidence: outcome.confidence,
      verificationStatus: mapVerification(outcome),

      failure: outcome.success
        ? null
        : {
            code: sanitizeDiagnostic(outcome.diagnostic?.errorKind ?? "unspecified_failure", 60),
            message: sanitizeDiagnostic(outcome.response ?? "", 200),
          },

      consistency: failed
        ? { consistent: false, reason: failed.reason }
        : { consistent: true },

      raw: outcome,
    };
  }
}
