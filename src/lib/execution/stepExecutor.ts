/**
 * Phase 29 - step executor (Section 4, 8, 9, 10).
 * Executes ONE step through the injected runner (the EXISTING
 * agentBridge mechanism). Fail-closed on every pre-check. Bounded
 * retries and timeouts. Never fabricates observed results.
 */
import type { PlanStep } from "../planner/types";
import {
  EXECUTION_LIMITS,
  StepExecutionRecord,
} from "./types";
import { validateToolArgs, toolRisk, isDestructive, isSideEffecting } from "./guards";

export interface StepRunOutcome {
  record: StepExecutionRecord;
  /** Whether failure was deemed transient and retries remain meaningful. */
  retryable: boolean;
}

const RETRYABLE_CODES = new Set([
  "timeout", "agent_offline", "tool_exception", "transient",
]);

export interface StepExecutorDeps {
  runner: (userId: string, toolName: string, args: Record<string, unknown>) =>
    Promise<{ ok: boolean; result?: unknown; errorKind?: string }>;
  toolCatalog: () => string[];
  now?: () => number;
}

export class StepExecutor {
  private readonly now: () => number;
  constructor(private deps: StepExecutorDeps) {
    this.now = deps.now ?? Date.now;
  }

  async run(userId: string, step: PlanStep): Promise<StepRunOutcome> {
    const rec: StepExecutionRecord = {
      stepId: step.id,
      title: step.title.slice(0, 120),
      toolName: step.requiredTool ?? null,
      status: "failed",
      attempts: 0,
      startedAt: this.now(),
      finishedAt: null,
      durationMs: null,
      observedResult: null,
      failure: null,
    };

    const finish = (status: StepExecutionRecord["status"], failure: StepExecutionRecord["failure"]): StepRunOutcome => {
      rec.status = status;
      rec.finishedAt = this.now();
      rec.durationMs = Math.max(0, rec.finishedAt - (rec.startedAt ?? rec.finishedAt));
      if (failure) rec.failure = failure;
      return { record: rec, retryable: failure?.retryable ?? false };
    };

    // ── Manual / observation steps have no automated action ──
    if (!step.requiredTool) {
      rec.status = "skipped";
      rec.finishedAt = this.now();
      rec.manualReason = "manual step - no automated tool assigned";
      return { record: rec, retryable: false };
    }

    const catalog = new Set(this.deps.toolCatalog());

    // 1. tool exists (never execute unknown tools)
    if (!catalog.has(step.requiredTool)) {
      return finish("failed", { code: "unknown_tool", message: `tool '${step.requiredTool}' not in registry`, retryable: false });
    }
    // 2. destructive tools never auto-run
    if (isDestructive(step.requiredTool)) {
      return finish("failed", { code: "destructive_blocked", message: "destructive operations are never auto-executed", retryable: false });
    }
    // 3. argument contract
    const argCheck = validateToolArgs(step.requiredTool, step.arguments);
    if (!argCheck.ok) {
      return finish("failed", { code: "invalid_arguments", message: argCheck.reason ?? "arguments rejected", retryable: false });
    }
    // 8/9. timeout bounds + risk sanity
    const timeoutMs = Math.max(1, Math.min(step.timeoutMs || EXECUTION_LIMITS.maxTimeoutMs, EXECUTION_LIMITS.maxTimeoutMs));
    const risk = toolRisk(step.requiredTool);
    if (risk === "critical") {
      return finish("failed", { code: "risk_rejected", message: "critical risk tools are not executable", retryable: false });
    }

    const maxAttempts =
      1 + Math.min(step.retryPolicy?.maxRetries ?? 0, EXECUTION_LIMITS.maxRetries);
    let lastFailure: NonNullable<StepExecutionRecord["failure"]> = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      rec.attempts = attempt;
      try {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error("step timeout"), { code: "timeout" })), timeoutMs);
        });
        const result = await Promise.race([
          this.deps.runner(userId, step.requiredTool, step.arguments ?? {}),
          timeout,
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });
        if (result && result.ok) {
          // Bound the stored observation; never invent content.
          let serialized: string | null = null;
          if (result.result !== undefined) {
            try {
              serialized = JSON.stringify(result.result).slice(0, EXECUTION_LIMITS.maxObservedResultChars);
            } catch {
              serialized = "<unserializable result>";
            }
          }
          rec.observedResult = serialized;
          return finish("completed", null);
        }
        lastFailure = {
          code: result?.errorKind ?? "tool_failed",
          message: "tool reported failure",
          retryable: RETRYABLE_CODES.has(result?.errorKind ?? ""),
        };
      } catch (e: unknown) {
        const code = (e as { code?: string })?.code === "timeout" ? "timeout" : "tool_exception";
        lastFailure = {
          code,
          message: code === "timeout" ? `step exceeded ${timeoutMs}ms` : "runner threw",
          retryable: RETRYABLE_CODES.has(code),
        };
      }

      // Retry gate: only transient failures, never destructive/high-risk.
      const mayRetry =
        attempt < maxAttempts &&
        lastFailure.retryable &&
        !(lastFailure.code === "timeout" && isSideEffecting(step.requiredTool)) &&
        risk !== "high" &&
        risk !== "medium";
      if (!mayRetry) break;
    }

    return finish("failed", lastFailure ?? { code: "unknown_failure", message: "execution failed", retryable: false });
  }
}
