/**
 * Phase 32 - Unified Cognitive Core types.
 *
 * SituationFrame is a BOUNDED PER-REQUEST snapshot — never persisted by
 * default, never a duplicate of the durable UserModel, never containing
 * chain-of-thought, credentials, or unbounded raw history.
 *
 * The Core composes EXISTING authorities (IntentRouter, CognitiveRouter,
 * HierarchicalPlanner, PlanExecutor, ObservationCoordinator,
 * ModelGateway). It owns decision framing and consistency checking only;
 * it never executes tools directly.
 */
import type { RoutingResult, RiskLevel } from "../router/types";

export type CognitiveAction =
  | "direct_tool"
  | "retrieve_context"
  | "reason"
  | "plan"
  | "clarify"
  | "reject"
  | "observe"
  | "recover";

export interface RationaleMetadata {
  /** Closed short codes — never free-text reasoning. */
  reasonCode:
    | "deterministic_command"
    | "context_query"
    | "complex_multi_step_request"
    | "semantic_reasoning_request"
    | "ambiguous_request"
    | "policy_rejection";
  evidence: string[]; // ≤4 bounded tokens, e.g. "tier3_intent"
}

export interface CognitiveDecision {
  action: CognitiveAction;
  confidence: number;
  riskLevel: RiskLevel;
  requiresPlanning: boolean;
  requiresModel: boolean;
  requiresConfirmation: boolean;
  rationaleMetadata: RationaleMetadata;
}

/** Hard bounds for the frame (Phase 32 §2/§4). */
export const FRAME_LIMITS = {
  memories: 5,
  goals: 5,
  events: 8,
  topics: 10,
  projects: 5,
  snippetChars: 400,
  preferenceChars: 200,
  evidenceTokens: 4,
} as const;

export interface FrameMemory {
  id: string;
  text: string; // ≤ snippetChars
}

export interface FrameGoal {
  id: string;
  title: string; // ≤ snippetChars
  status: string;
  priority?: number;
}

export interface FrameProject {
  key: string;
  displayName: string; // ≤ snippetChars
  status: string;
}

export interface FrameEvent {
  type: string;
  at: number;
  description?: string; // ≤ snippetChars
}

export interface TimeContext {
  hourOfDay: number;
  dayOfWeek: number;
  isoDate: string;
  epochMs: number;
}

/**
 * Phase 33 seam — full world model arrives later. For now this is an
 * interface over externally supplied, bounded assertions only.
 */
export interface WorldAssertionSource {
  getAssertions(uid: string, limit: number): Promise<string[]>;
}

export interface LohzCapabilitySnapshot {
  availableTools: string[];
  supportedIntents: string[];
  canPlan: boolean;
  canExecute: boolean;
  canVerify: boolean;
  canRecover: boolean;
  canReason: boolean;
}

export interface FrameUncertainty {
  missingProviders: string[];
  lowConfidenceIntent: boolean;
}

/** The per-request cognitive snapshot. Request-scoped; never global. */
export interface SituationFrame {
  requestId: string;
  userId: string;

  inputMetadata: { length: number; isVoiceStyle: boolean };
  intent: string;
  intentConfidence: number;

  interactionMode: "voice" | "text" | "hybrid" | null;
  currentTimeContext: TimeContext;

  activeProject: FrameProject | null;
  activeGoals: FrameGoal[];
  relevantMemories: FrameMemory[];
  relevantUserPreferences: Record<string, string>;
  relevantWorldAssertions: string[];

  temporalContext: {
    recentImportantEvents: FrameEvent[];
    recentTopics: string[];
    absenceMs: number | null;
  };

  currentTaskState: string | null;
  lohzCapabilities: LohzCapabilitySnapshot;
  uncertainty: FrameUncertainty;
  constraints: string[];

  riskLevel: RiskLevel;
  assembledAt: number;
}

export type VerificationStatus =
  | "VERIFIED" | "FAILED" | "INCONCLUSIVE" | "UNVERIFIED" | "NOT_APPLICABLE";

export interface CognitiveResult {
  requestId: string;
  userId: string;
  tier: RoutingResult["tier"];
  intent: string;
  decision: CognitiveDecision;

  status: "completed" | "failed" | "rejected" | "awaiting_confirmation" | "partial_manual";

  response: string | null;
  planId?: string | null;
  executionId?: string | null;

  observations: string[]; // bounded summaries ≤ snippetChars each

  modelCalls: number;
  latencyMs: number;
  confidence: number;
  verificationStatus: VerificationStatus;

  failure?: { code: string; message: string } | null;
  consistency: { consistent: boolean; reason?: string };

  /** Internal: the underlying RouteOutcome from the authoritative router.
   *  Kept as a side-channel for callers (IntegrationPipeline) that need
   *  the original payload; never persisted, never logged wholesale. */
  raw?: unknown;
}
