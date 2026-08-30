/**
 * Phase 28 - Hierarchical Planning Engine types.
 *
 * A Plan is a bounded, declarative artifact. This phase creates plans up
 * to status "ready" ONLY. Statuses beyond ready exist in the schema for
 * Phase 29+ consumption but are unreachable here.
 */

export type PlanStatus =
  | "draft" | "validated" | "ready"
  | "running" | "paused" | "blocked"
  | "completed" | "failed" | "cancelled";

/** Statuses this phase may produce. Anything else is rejected at write time. */
export const WRITABLE_PLAN_STATUSES: ReadonlySet<PlanStatus> = new Set([
  "draft", "validated", "ready", "cancelled",
]);

export type StepStatus = PlanStatus;

export type PlanKind = "single_step" | "sequential" | "parallel" | "conditional" | "iterative";

export type RiskLevel = "safe" | "low" | "medium" | "high" | "critical";

export type FailurePolicy =
  | "stop"
  | "retry"
  | "skip"
  | "replan"
  | "ask_user"
  // Phase 29 Section 12 vocabulary - additive aliases
  | "continue_independent"
  | "retry_then_stop"
  | "retry_then_continue";

export interface RetryPolicy {
  maxRetries: number;
}

export interface PlanStep {
  id: string;
  index: number;
  title: string;
  description: string;
  /** Closed vocabulary from the Phase 27 IntentRouter where applicable. */
  intent: string;
  status: StepStatus;
  dependencies: string[];
  requiredTool?: string;
  arguments?: Record<string, unknown>;
  expectedOutcome: string;
  riskLevel: RiskLevel;
  confidence: number;
  retryPolicy: RetryPolicy;
  timeoutMs: number;
  /** conditional/iterative extras (declarative only). */
  condition?: "on_success" | "on_failure";
  maxIterations?: number;
}

export interface Plan {
  id: string;
  userId: string;
  goalId?: string;
  requestId: string;
  title: string;
  objective: string;
  kind: PlanKind;
  status: PlanStatus;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  steps: PlanStep[];
  constraints: string[];
  expectedOutcome: string;
  failurePolicy: FailurePolicy;
  autonomyLevel: number;
  version: number;
  /** Bounded provenance - never chain-of-thought. */
  generatedBy: "deterministic" | "model_assisted";
  modelCallsUsed: number;
  clarificationNeeded?: string;
}

/** Hard bounds (Section 7). */
export const PLAN_LIMITS = {
  maxSteps: 20,
  maxDependencyDepth: 10,
  maxBranches: 5,
  maxLoopIterations: 5,
  maxRetries: 2,
  minReadyConfidence: 0.6,
  maxPlannerModelCalls: 2,
  maxObjectiveChars: 500,
  maxStepTitleChars: 120,
  maxExpectedOutcomeChars: 200,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 120_000,
} as const;

/** Bounded planner context (Section 4). */
export interface PlannerContext {
  userId: string;
  currentContext: Record<string, unknown> | null;
  memories: Array<{ id: string; text: string }>;   // <=10
  goals: Array<{ id: string; title: string; status: string }>; // <=10
  projects: Array<{ key: string; displayName: string }>;       // <=8
  recentEvents: Array<{ type: string; at: number; description?: string }>; // <=8
  userPreferences: Record<string, string>;          // bounded snapshot
  contextTextBudget: number;                        // chars, default 4000
}

export const CONTEXT_LIMITS = {
  memories: 10,
  goals: 10,
  projects: 8,
  events: 8,
  contextTextChars: 4000,
} as const;

/** Available-tools catalog callback - wired to the EXISTING registry. */
export type ToolCatalog = () => string[];
