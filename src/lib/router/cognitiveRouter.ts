/**
 * Phase 27 - CognitiveRouter: cheapest-safe-path execution across tiers.
 * Tier 0: deterministic tools (0 model calls). Tier 1: memory/context.
 * Tier 2: ModelGateway reasoning. Tier 3: autonomous SEAM (no fake exec).
 *
 * Safety: routing != authorization. Tools run only via the injected
 * executor (server wires ToolDecisionEngine -> toolRouter -> Agent).
 */
import { randomUUID } from "crypto";
import type {
  LifecycleStage,
  ProcessingTier,
  RouteDiagnostic,
  RouteEntities,
  RoutingResult,
} from "./types";
import { classify } from "./intentRouter";
import type { SpeakerAuthorization } from "../conversation/types";
import type { AdaptiveRecommendation } from "../adaptation/types";

export interface ToolExecutionResult {
  ok: boolean;
  result?: unknown;
  errorKind?: string;
  verificationStatus?: "VERIFIED" | "FAILED" | "INCONCLUSIVE" | "UNVERIFIED";
}

export type ToolExecutor = (
  userId: string,
  toolName: string,
  args: Record<string, unknown>,
  context?: { requestId: string }
) => Promise<ToolExecutionResult>;

export interface LightContextProviders {
  retrieveMemories?: (
    userId: string,
    query: string,
    limit: number
  ) => Promise<Array<{ id: string; text: string; score: number }>>;
  currentContextSnapshot?: (userId: string) => Promise<Record<string, unknown> | null>;
}

export interface RouteOptions {
  depth?: number;
  /** Request identity assigned by the authenticated entry point. */
  requestId?: string;
  /** Phase 32 — pre-rendered structured prompt from the CognitiveCore's
   *  SituationFrame. When present, Tier 2 reasoning uses it instead of
   *  the raw input; the gateway seam/cost controls are unchanged. */
  situationPrompt?: string;
  /** Session speaker role. Authentication remains the only authority boundary. */
  speakerAuthorization?: SpeakerAuthorization;
}

export interface RouteOutcome extends RoutingResult {
  requestId: string;
  lifecycle: LifecycleStage[];
  success: boolean;
  response: string | null;
  toolUsed: string | null;
  modelUsed: string | null;
  modelCalls: number;
  latencyMs: number;
  diagnostic: RouteDiagnostic;
  resultPayload?: unknown;
  verificationStatus?: "VERIFIED" | "FAILED" | "INCONCLUSIVE" | "UNVERIFIED" | "NOT_APPLICABLE";
  /** Phase 28 - true only when the tier3 planner seam actually ran. */
  plannerCalled?: boolean;
  planId?: string | null;
}

export const MAX_ROUTE_DEPTH = 3;

export interface CognitiveRouterDeps {
  executeTool: ToolExecutor;
  capabilityGate?: (
    userId: string,
    input: string,
    intent: string,
    toolName?: string
  ) => Promise<{ available: boolean; response?: string; errorKind?: string } | null>;
  providers?: LightContextProviders;
  gateway?: {
    generate: (req: {
      prompt: string;
      capability: "reasoning" | "planning" | "text_generation";
      userId: string;
      reason: string;
    }) => Promise<{ text?: string; provider?: string; model?: string }>;
  };
  temporal?: {
    recordObservation: (userId: string, description: string, importance: number) => Promise<void>;
  };
  adaptation?: {
    recommendForInput: (userId: string, intent: string, input: string) => Promise<AdaptiveRecommendation | null>;
  };
  /** Phase 28 seam - optional; when present, tier3 requests produce a plan. */
  planner?: {
    shouldPlan: (input: string) => boolean;
    createPlan: (
      userId: string,
      request: { objective: string; intentConfidence?: number; requestId?: string }
    ) => Promise<{
      ok: boolean;
      plan?: { id: string; title: string; status: string; confidence: number };
      summary?: string;          // human-readable PLANNED rendering
      reason?: string;
      needsClarification?: boolean;
      rejected?: boolean;
      modelCallsUsed: number;
    }>;
  };
  now?: () => number;
}

const INTENT_TO_TOOL: Record<string, string> = {
  open_app: "openApp",
  close_app: "closeApp",
  focus_app: "focusApp",
  open_url: "openUrl",
  screenshot: "takeScreenshot",
  volume_get: "getVolume",
  volume_set: "setVolume",
  system_info: "getSystemInfo",
  clipboard_read: "clipboardRead",
  clipboard_write: "clipboardWrite",
};

/** Meaningful actions worth a temporal observation; trivial ones are not stored. */
const OBSERVABLE_INTENTS = new Set(["manage_goal", "execute_task", "plan"]);

function toolArgsFor(intent: string, e: RouteEntities): Record<string, unknown> {
  switch (intent) {
    case "open_app": return { name: e.appName };
    case "close_app": return { name: e.appName };
    case "focus_app": return { name: e.appName };
    case "open_url": return { url: e.url };
    case "volume_set": return { level: e.volumeLevel };
    case "clipboard_write": return { content: e.text };
    default: return {};
  }
}

export class CognitiveRouter {
  private readonly deps: CognitiveRouterDeps;
  private readonly now: () => number;
  private diagnostics: RouteDiagnostic[] = [];
  private readonly maxDiagnostics = 200;

  constructor(deps: CognitiveRouterDeps) {
    if (!deps.executeTool) throw new Error("CognitiveRouter: executeTool is required");
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  getDiagnostics(): RouteDiagnostic[] {
    return [...this.diagnostics];
  }

  private pushDiagnostic(d: RouteDiagnostic): void {
    this.diagnostics.push(d);
    while (this.diagnostics.length > this.maxDiagnostics) this.diagnostics.shift();
  }

  async route(
    authenticatedUserId: string,
    input: string,
    opts: RouteOptions = {}
  ): Promise<RouteOutcome> {
    const started = this.now();
    const requestId = opts.requestId ?? randomUUID();
    const depth = opts.depth ?? 0;
    const lifecycle: LifecycleStage[] = ["RECEIVED"];

    if (!authenticatedUserId) throw new Error("CognitiveRouter.route: authenticated userId required");
    if (depth > MAX_ROUTE_DEPTH) {
      return this.finish(requestId, authenticatedUserId, { intent: "unknown", tier: "tier1_light", confidence: 0.4, riskLevel: "low", entities: {} }, false, lifecycle, {
        response: "Routing depth exceeded.",
        errorKind: "depth_exceeded",
      }, started);
    }

    let classification = classify(input);
    lifecycle.push("CLASSIFIED");

    if (opts.speakerAuthorization && opts.speakerAuthorization !== "primary_user") {
      const privileged = classification.tier === "tier0_direct"
        || classification.tier === "tier3_autonomous"
        || classification.intent === "memory_query"
        || classification.intent === "context_query";
      if (privileged) {
        lifecycle.push("REJECT", "COMPLETED");
        return this.finish(requestId, authenticatedUserId, classification, false, lifecycle, {
          response: "I understood the request, but a participant cannot authorize actions or access the account owner's private context. Please ask the authenticated user to make or confirm the request.",
          errorKind: "participant_not_authorized",
          verificationStatus: "NOT_APPLICABLE",
        }, started);
      }
    }

    // Phase 40 — only an explicitly deployed, user-owned adaptation may
    // influence routing. The transition matrix never adds tool authority,
    // reduces risk, changes arguments, or bypasses capability/confirmation.
    if ((!opts.speakerAuthorization || opts.speakerAuthorization === "primary_user") && this.deps.adaptation) {
      try {
        const advice = await this.deps.adaptation.recommendForInput(authenticatedUserId, classification.intent, input);
        if (advice?.approach === "clarification" && !classification.needsClarification) {
          classification = { ...classification, confidence: Math.min(classification.confidence, 0.7), needsClarification: "Historical verified outcomes suggest I should clarify this request before choosing an approach. What exact result do you want?" };
        } else if (advice?.approach === "model_reasoning" && classification.tier === "tier1_light" && !classification.requiresTool && !classification.requiresMemory && !classification.requiresContext) {
          classification = { ...classification, tier: "tier2_reasoning", requiresReasoning: true };
        }
        // planner/known_skill/recovery_strategy recommendations remain within
        // their existing tier-3 execution machinery; selection is never auth.
      } catch {
        /* adaptation failure preserves the original deterministic route */
      }
    }

    if (classification.needsClarification && classification.confidence < 0.75) {
      lifecycle.push("ASK", "COMPLETED");
      return this.finish(requestId, authenticatedUserId, classification, true, lifecycle, {
        response: classification.needsClarification,
      }, started);
    }
    lifecycle.push("ROUTED");

    if (this.deps.capabilityGate) {
      try {
        const toolName = classification.tier === "tier0_direct" ? INTENT_TO_TOOL[classification.intent] : undefined;
        const gate = await this.deps.capabilityGate(authenticatedUserId, input, classification.intent, toolName);
        if (gate && !gate.available) {
          lifecycle.push("REJECT", "COMPLETED");
          return this.finish(requestId, authenticatedUserId, classification, false, lifecycle, {
            response: gate.response ?? "That capability is currently unavailable. Nothing was executed.",
            errorKind: gate.errorKind ?? "capability_unavailable",
            verificationStatus: "NOT_APPLICABLE",
          }, started);
        }
      } catch {
        if (classification.tier === "tier0_direct") {
          lifecycle.push("REJECT", "COMPLETED");
          return this.finish(requestId, authenticatedUserId, classification, false, lifecycle, {
            response: "I can’t verify my computer-control capability right now, so I did not execute anything.",
            errorKind: "capability_check_unavailable",
            verificationStatus: "NOT_APPLICABLE",
          }, started);
        }
      }
    }

    switch (classification.tier) {
      case "tier0_direct":
        return this.runDirect(requestId, authenticatedUserId, classification, lifecycle, started);
      case "tier1_light":
        return this.runLight(requestId, authenticatedUserId, input, classification, lifecycle, started, opts);
      case "tier2_reasoning":
        return this.runReasoning(requestId, authenticatedUserId, input, classification, lifecycle, started, opts);
      case "tier3_autonomous":
        return this.runAutonomousSeam(requestId, authenticatedUserId, input, classification, lifecycle, started);
    }
  }

  private async runDirect(
    requestId: string,
    userId: string,
    c: RoutingResult,
    lifecycle: LifecycleStage[],
    started: number
  ): Promise<RouteOutcome> {
    // High/critical risks never auto-execute in this phase (Â§8/Â§23).
    if (c.riskLevel === "high" || c.riskLevel === "critical") {
      lifecycle.push("REJECT", "COMPLETED");
      return this.finish(requestId, userId, c, false, lifecycle, {
        response: "This action requires explicit approval and is not executed by the router.",
        errorKind: "risk_rejected",
      }, started);
    }

    lifecycle.push("AUTHORIZED");
    const toolName = INTENT_TO_TOOL[c.intent];
    const args = toolArgsFor(c.intent, c.entities);
    let exec: ToolExecutionResult;
    try {
      exec = await this.deps.executeTool(userId, toolName, args, { requestId });
    } catch {
      exec = { ok: false, errorKind: "tool_exception" };
    }

    if (!exec.ok) {
      if (exec.errorKind === "confirmation_required") {
        lifecycle.push("AWAITING_CONFIRMATION", "COMPLETED");
        return this.finish(requestId, userId, c, false, lifecycle, {
          toolUsed: toolName,
          errorKind: "confirmation_required",
          response: "This action is awaiting your confirmation. Nothing has been executed.",
          resultPayload: exec.result,
          verificationStatus: exec.verificationStatus,
        }, started);
      }
      lifecycle.push("EXECUTED", "OBSERVED", "COMPLETED");
      return this.finish(requestId, userId, c, false, lifecycle, {
        toolUsed: toolName,
        errorKind: exec.errorKind ?? "tool_failed",
        response: "The tool could not complete the action.",
        verificationStatus: exec.verificationStatus ?? "FAILED",
      }, started);
    }

    lifecycle.push("EXECUTED", "OBSERVED", "COMPLETED");

    // Temporal observation ONLY for meaningful intents (Â§26): opening
    // Chrome or setting volume is NOT recorded as long-term context.
    if (this.deps.temporal && OBSERVABLE_INTENTS.has(c.intent)) {
      try {
        await this.deps.temporal.recordObservation(
          userId,
          `${c.intent} ${c.entities.appName ?? c.entities.projectKey ?? ""}`.trim(),
          0.5
        );
      } catch {
        /* observation failure must not fail the command */
      }
    }

    const toolMsg = (exec.result as any)?.message;
    const friendlyResponse = typeof toolMsg === "string" && toolMsg.trim() ? toolMsg : `Done (${toolName}).`;

    return this.finish(requestId, userId, c, true, lifecycle, {
      toolUsed: toolName,
      response: friendlyResponse,
      resultPayload: exec.result,
      verificationStatus: exec.verificationStatus ?? "UNVERIFIED",
    }, started);
  }

  private async runLight(
    requestId: string,
    userId: string,
    input: string,
    c: RoutingResult,
    lifecycle: LifecycleStage[],
    started: number,
    opts: RouteOptions = {}
  ): Promise<RouteOutcome> {
    let response: string | null = null;
    const canReadPrivateContext = (opts.speakerAuthorization ?? "primary_user") === "primary_user";

    if (canReadPrivateContext && c.intent === "memory_query" && this.deps.providers?.retrieveMemories) {
      const mems = await this.deps.providers.retrieveMemories(userId, input, 5);
      response = mems.length
        ? `From memory: ${mems.map((m) => m.text).join(" | ")}`
        : "I do not have a relevant memory for that yet.";
    } else if (canReadPrivateContext && (c.intent === "context_query" || c.intent === "chat") && this.deps.providers?.currentContextSnapshot) {
      const snap = await this.deps.providers.currentContextSnapshot(userId);
      response = snap
        ? `Current context: ${JSON.stringify(snap).slice(0, 400)}`
        : "No active context recorded yet.";
    }

    lifecycle.push(response ? "EXECUTED" : "ASK", "COMPLETED");
    return this.finish(requestId, userId, c, response !== null, lifecycle, {
      response,
    }, started);
  }

  private async runReasoning(
    requestId: string,
    userId: string,
    input: string,
    c: RoutingResult,
    lifecycle: LifecycleStage[],
    started: number,
    opts: RouteOptions = {}
  ): Promise<RouteOutcome> {
    if (!this.deps.gateway) {
      // Graceful degradation (§22): Tier 1-style acknowledgement.
      lifecycle.push("ASK", "COMPLETED");
      return this.finish(requestId, userId, c, false, lifecycle, {
        response: "Reasoning model unavailable right now.",
        errorKind: "gateway_unavailable",
      }, started);
    }
    try {
      const prompt = opts.situationPrompt ?? input;
      const res = await this.deps.gateway.generate({
        prompt: String(prompt).slice(0, 8000),
        capability: "reasoning",
        userId,
        reason: `route:${c.intent}`,
      });
      lifecycle.push("EXECUTED", "OBSERVED", "COMPLETED");
      return this.finish(requestId, userId, c, true, lifecycle, {
        response: res.text ?? "(empty response)",
        modelUsed: res.model ?? res.provider ?? "gateway",
      }, started);
    } catch {
      lifecycle.push("ASK", "COMPLETED");
      return this.finish(requestId, userId, c, false, lifecycle, {
        response: "Reasoning failed â€” please retry later.",
        errorKind: "model_failed",
      }, started);
    }
  }

  private async runAutonomousSeam(
    requestId: string,
    userId: string,
    input: string,
    c: RoutingResult,
    lifecycle: LifecycleStage[],
    started: number
  ): Promise<RouteOutcome> {
    // Phase 28 planner seam: PLANNING only. Tools are never executed and
    // nothing is ever marked complete (no false success).
    if (this.deps.planner && this.deps.planner.shouldPlan(input)) {
      try {
        const outcome = await this.deps.planner.createPlan(userId, {
          objective: input.slice(0, 500),
          intentConfidence: c.confidence,
          requestId,
        });
        if (outcome.ok && outcome.plan && outcome.summary) {
          lifecycle.push("PLANNED", "COMPLETED");
          const completedWithoutFailure = outcome.plan.status !== "failed" && outcome.plan.status !== "cancelled";
          return this.finish(requestId, userId, c, completedWithoutFailure, lifecycle, {
            response: outcome.summary,
            planId: outcome.plan.id,
            plannerCalled: true,
            modelCalls: outcome.modelCallsUsed,
            ...(!completedWithoutFailure ? { errorKind: "planned_execution_failed" } : {}),
          }, started);
        }
        if (outcome.needsClarification || outcome.rejected) {
          lifecycle.push("ASK", "COMPLETED");
          return this.finish(requestId, userId, c, false, lifecycle, {
            response: outcome.reason ?? "Clarification needed before planning.",
            planId: null,
            plannerCalled: true,
            errorKind: outcome.rejected ? "planner_rejected" : "planner_clarification",
          }, started);
        }
      } catch {
        /* fall through to plain ack */
      }
    }
    lifecycle.push("ASK", "COMPLETED");
    return this.finish(requestId, userId, c, false, lifecycle, {
      response: "AUTONOMOUS_REQUEST acknowledged - no planner configured; nothing was executed.",
      plannerCalled: false,
    }, started);
  }

  private finish(
    requestId: string,
    userId: string,
    cls: Pick<RoutingResult, "intent" | "tier" | "confidence" | "riskLevel" | "entities">,
    success: boolean,
    lifecycle: LifecycleStage[],
    extra: {
      response?: string | null;
      toolUsed?: string | null;
      modelUsed?: string | null;
      errorKind?: string;
      resultPayload?: unknown;
      plannerCalled?: boolean;
      planId?: string | null;
      modelCalls?: number;
      verificationStatus?: "VERIFIED" | "FAILED" | "INCONCLUSIVE" | "UNVERIFIED" | "NOT_APPLICABLE";
    },
    started: number
  ): RouteOutcome {
    const latencyMs = Math.max(0, this.now() - started);
    const risk = cls.riskLevel ?? "low";
    const outcome: RouteOutcome = {
      intent: cls.intent,
      tier: cls.tier,
      confidence: cls.confidence,
      entities: cls.entities,
      requiresMemory: false,
      requiresContext: false,
      requiresReasoning: false,
      requiresPlanning: false,
      requiresTool: false,
      riskLevel: risk,
      requestId,
      lifecycle: [...lifecycle],
      success,
      response: extra.response ?? null,
      toolUsed: extra.toolUsed ?? null,
      modelUsed: extra.modelUsed ?? null,
      modelCalls: extra.modelCalls ?? (extra.modelUsed ? 1 : 0),
      latencyMs,
      diagnostic: {
        requestId,
        userId,
        intent: cls.intent,
        tier: cls.tier,
        confidence: cls.confidence,
        latencyMs,
        success,
        risk,
        toolUsed: extra.toolUsed ?? null,
        modelUsed: extra.modelUsed ?? null,
        modelCalls: extra.modelCalls ?? (extra.modelUsed ? 1 : 0),
        lifecycle: [...lifecycle],
        ...(extra.errorKind ? { errorKind: extra.errorKind } : {}),
      },
      ...(extra.resultPayload !== undefined ? { resultPayload: extra.resultPayload } as object : {}),
      ...(extra.verificationStatus !== undefined ? { verificationStatus: extra.verificationStatus } as object : {}),
      ...(extra.plannerCalled !== undefined ? { plannerCalled: extra.plannerCalled } as object : {}),
      ...(extra.planId !== undefined ? { planId: extra.planId } as object : {}),
    };
    this.pushDiagnostic(outcome.diagnostic);
    return outcome;
  }
}


