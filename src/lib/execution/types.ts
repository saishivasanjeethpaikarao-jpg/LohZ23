/**
 * Phase 29 - observable execution types. Bounded states, legal
 * transitions, structured results. Execution is deterministic; this
 * module performs ZERO model calls.
 */
import type { Plan, PlanStep } from "../planner/types";

export type StepExecStatus =
  | "pending" | "ready" | "running"
  | "completed" | "failed" | "skipped"
  | "blocked" | "cancelled";

/** Legal step transitions - anything else fails deterministically. */
export const STEP_TRANSITIONS: Record<StepExecStatus, StepExecStatus[]> = {
  pending:   ["ready", "running", "skipped", "blocked", "cancelled"],
  ready:     ["running", "skipped", "blocked", "cancelled"],
  running:   ["completed", "failed"],
  completed: [],
  failed:    ["ready"], // only via bounded retry re-arm
  skipped:   [],
  blocked:   ["ready"],
  cancelled: [],
};

export function canTransitionStep(from: StepExecStatus, to: StepExecStatus): boolean {
  return STEP_TRANSITIONS[from]?.includes(to) ?? false;
}

export type AuthorizationDecision =
  | "AUTHORIZED"
  | "REQUIRES_CONFIRMATION"
  | "REJECTED";

export interface ExecutionFailure {
  code: string;
  message: string;
  retryable: boolean;
}

/** Bounded observed result for one step (never fabricated). */
export interface StepExecutionRecord {
  stepId: string;
  title: string;
  toolName: string | null;
  status: StepExecStatus;
  attempts: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  /** Raw tool result, JSON-serialized and truncated to <=2000 chars. */
  observedResult: string | null;
  failure: ExecutionFailure | null;
  manualReason?: string;
}

export type ExecutionRecordStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "awaiting_confirmation"
  | "rejected"
  | "partial_manual";

export interface ExecutionRecord {
  uid: string;
  requestId: string;
  planId: string;
  planVersion: number;
  status: ExecutionRecordStatus;
  authorization: AuthorizationDecision;
  startedAt: number;
  finishedAt: number | null;
  steps: StepExecutionRecord[];
  planStatusAfter: Plan["status"] | null;
  failure: ExecutionFailure | null;
  version: number;
}

/** Same shape as the Phase 27 router executor - one mechanism, no duplicates. */
export type ToolRunner = (
  userId: string,
  toolName: string,
  args: Record<string, unknown>
) => Promise<{ ok: boolean; result?: unknown; errorKind?: string }>;

export interface ExecutionDeps {
  store: import("./persistence").ExecutionStore;
  planStore: import("../planner/planPersistence").PlanStore;
  idempotency?: import("./idempotency").IdempotencyStore;
  /** Cross-process plan reservation. Required by production composition. */
  lease?: import("./executionLease").ExecutionLeaseStore;
  toolCatalog: () => string[];
  runner: ToolRunner;
  temporal?: {
    record: (input: {
      userId: string;
      type:
        | "plan_started" | "step_completed" | "step_failed"
        | "plan_completed" | "plan_failed" | "plan_cancelled"
        /* Phase 30 verification/recovery events ride the same emitter */
        | "step_verified" | "step_verification_failed"
        | "recovery_started" | "recovery_succeeded" | "recovery_failed"
        | "plan_replanned";
      description?: string;
      importance?: number;
    }) => Promise<void>;
  };
  goalProgress?: (userId: string, goalId: string, progress: number, evidence: string) => Promise<boolean>;
  /**
   * Phase 30 - optional observe/verify/recover pipeline. When present,
   * every step passes through it BEFORE completion is granted.
   */
  observation?: {
    executeVerifiedStep: (
      userId: string,
      planId: string,
      requestId: string,
      step: PlanStep,
      executor: import("./stepExecutor").StepExecutor
    ) => Promise<StepExecutionRecord>;
    /** Phase 30 replan seam; invoked only by executePlanManaged. */
    replan?: {
      canReplan: (userId: string, requestId: string) => boolean;
      maybeReplan: (
        userId: string, requestId: string, original: Plan,
        failedSteps: StepExecutionRecord[], completedStepIds: string[]
      ) => Promise<{ ok: boolean; plan?: Plan; reason?: string }>;
    };
    /** Optional bounded memory-candidate seam (Phase 23 pipeline). */
    memoryCandidate?: (uid: string, text: string) => void;
  };
  now?: () => number;
}

export interface ExecutionContextInput {
  userId: string;
  requestId: string;
  /** Explicit user confirmation captured server-side (never from plan). */
  confirmed?: boolean;
}

export const EXECUTION_LIMITS = {
  maxParallelSteps: 5,
  maxTimeoutMs: 120_000,
  maxRetries: 2,
  maxObservedResultChars: 2000,
} as const;

/** Tools that must never auto-execute or auto-retry (defense-in-depth). */
export const DESTRUCTIVE_TOOLS = new Set(["deleteFile", "deleteFolder", "formatDisk"]);

export type { Plan, PlanStep };
