/**
 * Phase 29 - PlanExecutionEngine (Section 11).
 *
 * Executes ONLY validated, authorized plans through the existing tool
 * registry + agentBridge runner. Deterministic; zero model calls.
 * Idempotent per requestId; per-plan lock prevents duplicate workers;
 * concurrency bounded at 5. Completion requires ACTUAL successful
 * observed results for every automatable step - never granted merely
 * because a plan exists.
 */
import type { Plan, PlanStep } from "../planner/types";
import {
  EXECUTION_LIMITS,
  ExecutionDeps,
  ExecutionRecord,
  StepExecStatus,
  StepExecutionRecord,
} from "./types";
import { canTransitionStep } from "./types";
import { evaluateExecutionPolicy } from "./policy";
import { StepExecutor } from "./stepExecutor";

export interface ExecutionOutcome {
  authorization: "AUTHORIZED" | "REQUIRES_CONFIRMATION" | "REJECTED";
  planStatus: Plan["status"] | null;
  recordStatus: ExecutionRecord["status"];
  summary: string;
  steps: StepExecutionRecord[];
  idempotent?: boolean;
}

export class PlanExecutionEngine {
  private readonly deps: ExecutionDeps;
  private readonly now: () => number;
  private readonly stepExecutor: StepExecutor;
  /** userId:planId -> in-flight promise (duplicate worker prevention). */
  private locks = new Map<string, Promise<unknown>>();
  /** requestId -> cancel requested. */
  private cancelFlags = new Map<string, boolean>();

  constructor(deps: ExecutionDeps) {
    if (!deps.store) throw new Error("PlanExecutionEngine: store is required");
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.stepExecutor = new StepExecutor({
      runner: deps.runner,
      toolCatalog: deps.toolCatalog,
      now: this.now,
    });
  }

  /** Explicit cancellation API (Section 11 rule). */
  requestCancel(userId: string, requestId: string): void {
    const key = `${userId}:${requestId}`;
    this.cancelFlags.set(key, true);
  }

  /**
   * Restart recovery is conservative: an action that was checkpointed as
   * running has an ambiguous side effect and is stopped. Safe pending work may
   * resume only after ownership/version/policy are revalidated.
   */
  async recoverInterruptedUser(userId: string): Promise<ExecutionOutcome[]> {
    const recovered: ExecutionOutcome[] = [];
    for (const record of await this.deps.store.listExecutions(userId, 100)) {
      if (record.status !== "running") continue;
      const plan = await this.deps.planStore.getPlan(userId, record.planId);
      if (!plan || plan.userId !== userId || plan.version !== record.planVersion) {
        record.status = "failed";
        record.failure = { code: "restart_ownership_or_version_mismatch", message: "restart recovery refused", retryable: false };
        record.finishedAt = this.now();
        await this.deps.store.updateExecution(record);
        continue;
      }
      if (record.steps.some((step) => step.status === "running")) {
        record.status = "failed";
        record.failure = { code: "restart_ambiguous_side_effect", message: "a running step cannot be safely replayed", retryable: false };
        record.finishedAt = this.now();
        await this.deps.store.updateExecution(record);
        continue;
      }
      const refreshed = evaluateExecutionPolicy({ plan, confirmed: false });
      if (refreshed.decision !== "AUTHORIZED") {
        record.status = refreshed.decision === "REQUIRES_CONFIRMATION" ? "awaiting_confirmation" : "rejected";
        record.authorization = refreshed.decision;
        record.failure = { code: refreshed.decision === "REQUIRES_CONFIRMATION" ? "confirmation_required_after_restart" : "policy_rejected_after_restart", message: refreshed.reason, retryable: false };
        await this.deps.store.updateExecution(record);
        continue;
      }
      recovered.push(await this.runPlan(plan, { userId, requestId: record.requestId }, record));
    }
    return recovered;
  }

  async executePlan(
    planInput: Plan,
    ctx: { userId: string; requestId: string; confirmed?: boolean }
  ): Promise<ExecutionOutcome> {
    // ── 1-3. ownership / idempotency / state gates (fail closed) ──
    if (!ctx.userId) return this.reject(planInput, ctx, "missing authenticated uid");
    if (planInput.userId !== ctx.userId) {
      return this.reject(planInput, ctx, "plan does not belong to authenticated user");
    }
    const existing = await this.deps.store.getExecution(ctx.userId, ctx.requestId);
    if (existing) {
      if (existing.status === "awaiting_confirmation" && ctx.confirmed === true) {
        if (existing.planId !== planInput.id || existing.planVersion !== planInput.version) {
          return this.reject(planInput, ctx, "confirmation does not match the stored plan version");
        }
        const refreshed = evaluateExecutionPolicy({ plan: planInput, confirmed: true });
        if (refreshed.decision !== "AUTHORIZED") {
          return this.reject(planInput, ctx, "authorization changed; execution remains blocked");
        }
        // No step can execute before this state, so replacing the checkpoint is
        // safe. The normal path below revalidates every argument and policy.
        await this.deps.store.deleteExecution(ctx.userId, ctx.requestId);
      } else {
      return {
        authorization: existing.authorization,
        planStatus: existing.planStatusAfter,
        recordStatus: existing.status,
        summary: `Idempotent replay of requestId ${ctx.requestId}; no tools were re-executed.`,
        steps: existing.steps,
        idempotent: true,
      };
      }
    }
    if (planInput.status !== "ready") {
      return this.reject(planInput, ctx, `plan status '${planInput.status}' is not executable`);
    }

    // ── 4. execution authorization gate ──
    const policy = evaluateExecutionPolicy({ plan: planInput, confirmed: ctx.confirmed });

    const baseRecord: ExecutionRecord = {
      uid: ctx.userId,
      requestId: ctx.requestId,
      planId: planInput.id,
      planVersion: planInput.version,
      status:
        policy.decision === "REJECTED" ? "rejected"
        : policy.decision === "REQUIRES_CONFIRMATION" ? "awaiting_confirmation"
        : "running",
      authorization: policy.decision,
      startedAt: this.now(),
      finishedAt: null,
      steps: planInput.steps.map((s) => this.blankStep(s)),
      planStatusAfter: null,
      failure:
        policy.decision === "REJECTED"
          ? { code: "policy_rejected", message: policy.reason, retryable: false }
          : policy.decision === "REQUIRES_CONFIRMATION"
            ? { code: "confirmation_required", message: policy.reason, retryable: false }
            : null,
      version: 1,
    };

    if (policy.decision !== "AUTHORIZED") {
      await this.deps.store.saveExecution(baseRecord);
      return {
        authorization: policy.decision,
        planStatus: planInput.status,
        recordStatus: baseRecord.status,
        summary:
          policy.decision === "REJECTED"
            ? `Execution rejected: ${policy.reason}`
            : `Confirmation required: ${policy.reason} Nothing was executed.`,
        steps: baseRecord.steps,
      };
    }

    // ── Per-plan lock: two workers never run the same plan ──
    // Persist the record FIRST so idempotent replays and concurrent
    // duplicates observe it even while execution is in flight.
    const preSaved = await this.deps.store.saveExecution(baseRecord);
    if (!preSaved) {
      return this.reject(planInput, ctx, "execution persistence unavailable - failing closed");
    }
    const lockKey = `${ctx.userId}:${planInput.id}`;
    const inflight = this.locks.get(lockKey);
    if (inflight) {
      await inflight.catch(() => undefined);
      const replay = await this.deps.store.getExecution(ctx.userId, ctx.requestId);
      if (replay) {
        return {
          authorization: replay.authorization,
          planStatus: replay.planStatusAfter,
          recordStatus: replay.status,
          summary: "Concurrent duplicate suppressed; existing result returned.",
          steps: replay.steps,
          idempotent: true,
        };
      }
      return this.reject(planInput, ctx, "another worker is executing this plan");
    }

    const work = this.runPlan(planInput, ctx, baseRecord);
    this.locks.set(lockKey, work);
    try {
      return await work;
    } finally {
      this.locks.delete(lockKey);
      this.cancelFlags.delete(`${ctx.userId}:${ctx.requestId}`);
    }
  }

  private async runPlan(
    plan: Plan,
    ctx: { userId: string; requestId: string },
    record: ExecutionRecord
  ): Promise<ExecutionOutcome> {
    const cancelKey = `${ctx.userId}:${ctx.requestId}`;
    // NOTE: pre-existing cancel flags are honored, never cleared here.

    // Working copy of step statuses (record.steps mirrors it).
    const statuses = new Map<string, StepExecStatus>();
    for (const s of record.steps) statuses.set(s.stepId, s.status === "pending" ? "ready" : s.status);
    for (const s of record.steps) if (s.status === "pending") { s.status = "ready"; statuses.set(s.stepId, "ready"); }
    // Manual (tool-less) steps resolve immediately to skipped w/ reason.
    for (const s of record.steps) {
      if (!s.toolName && s.status === "ready") {
        s.status = "skipped";
        s.manualReason = "manual step - no automated tool assigned";
        statuses.set(s.stepId, "skipped");
      }
    }

    record.status = "running";
    await this.deps.store.updateExecution(record);
    await this.emit({ userId: ctx.userId, type: "plan_started", description: plan.title, importance: 0.6 });

    let haltedReason: string | null = null;

    const byStep = new Map<string, StepExecutionRecord>(record.steps.map((s) => [s.stepId, s]));
    const stepById = new Map<string, PlanStep>(plan.steps.map((s) => [s.id, s]));

    // ── Scheduler: dependency waves, bounded parallelism ──
    for (;;) {
      if (this.cancelFlags.get(cancelKey)) break;

      const readySteps = plan.steps.filter((ps) => {
        const st = statuses.get(ps.id);
        return st === "ready";
      }).filter((ps) =>
        ps.dependencies.every((d) => {
          const dep = statuses.get(d);
          return dep === "completed" || dep === "skipped";
        })
      );

      if (statuses.size > 0) {
        const pendingLeft = [...statuses.values()].filter(
          (s) => s === "ready" || s === "running"
        ).length;
        if (readySteps.length === 0 && pendingLeft === 0) break; // nothing left to schedule
        if (readySteps.length === 0 && pendingLeft > 0 && !this.hasRunning(statuses)) {
          // Dependencies unsatisfiable -> deterministic deadlock.
          haltedReason = "dependency inconsistency: no runnable steps remain";
          break;
        }
      }
      if (readySteps.length === 0 && this.hasRunning(statuses)) {
        continue; // wait for running wave (single-threaded loop; running set resolves synchronously below)
      }

      // Bounded batch (maxParallelSteps).
      const batch = readySteps.slice(0, EXECUTION_LIMITS.maxParallelSteps);
      const promises = batch.map(async (ps) => {
        const rec = byStep.get(ps.id)!;
        const idempotencyKey = `${plan.id}:${plan.version}:${ps.id}`;
        const checkpoint = await this.deps.idempotency?.get(ctx.userId, idempotencyKey);
        if (checkpoint?.status === "completed") {
          rec.status = "completed";
          rec.attempts = 0;
          rec.startedAt = checkpoint.createdAt;
          rec.finishedAt = checkpoint.updatedAt;
          rec.durationMs = Math.max(0, checkpoint.updatedAt - checkpoint.createdAt);
          rec.observedResult = "verified idempotency checkpoint; action not replayed";
          statuses.set(ps.id, "completed");
          return;
        }
        rec.status = "running";
        statuses.set(ps.id, "running");
        const outcomeRecord: StepExecutionRecord = this.deps.observation
          ? await this.deps.observation.executeVerifiedStep(ctx.userId, plan.id, ctx.requestId, ps, this.stepExecutor)
          : (await this.stepExecutor.run(ctx.userId, ps)).record;
        const next: StepExecStatus =
          outcomeRecord.status === "failed" ? "failed"
          : outcomeRecord.status === "skipped" ? "skipped"
          : "completed";
        // Legal transition check before committing.
        if (!canTransitionStep("running", next)) {
          rec.status = "failed";
          rec.failure = { code: "illegal_transition", message: `running->${next} rejected`, retryable: false };
          statuses.set(ps.id, "failed");
          return;
        }
        Object.assign(rec, outcomeRecord);
        statuses.set(ps.id, next);

        if (next === "completed" && rec.toolName) {
          await this.deps.idempotency?.put({
            uid: ctx.userId, key: idempotencyKey, requestId: ctx.requestId,
            planId: plan.id, stepId: ps.id, status: "completed",
            createdAt: rec.startedAt ?? this.now(), updatedAt: rec.finishedAt ?? this.now(),
          });
          await this.emit({
            userId: ctx.userId, type: "step_completed",
            description: `${rec.title} via ${rec.toolName}`, importance: 0.4,
          });
        } else if (next === "failed") {
          await this.emit({
            userId: ctx.userId, type: "step_failed",
            description: `${rec.title}: ${rec.failure?.code ?? "unknown"}`, importance: 0.6,
          });
        }
      });
      await Promise.all(promises);

      // Persist after each wave.
      await this.deps.store.updateExecution(record);

      // Failure policy gate: halt-family policies stop scheduling;
      // continue-family policies keep independent branches running.
      const failedNow = batch.some((ps) => statuses.get(ps.id) === "failed");
      if (
        failedNow &&
        ["stop", "ask_user", "replan", "retry_then_stop"].includes(plan.failurePolicy)
      ) {
        haltedReason = `halted after failure (${plan.failurePolicy} policy)`;
        break;
      }
    }

    // Halt remaining runnable steps honestly.
    if (haltedReason || this.cancelFlags.get(cancelKey)) {
      for (const s of record.steps) {
        const st = statuses.get(s.stepId);
        if (st === "ready" || st === "blocked") {
          s.status = "cancelled";
          s.manualReason = haltedReason ?? "cancelled by user request";
          statuses.set(s.stepId, "cancelled");
        }
      }
    }

    // ── Finalize: completion requires ALL automatable steps completed ──
    const automatable = record.steps.filter((s) => Boolean(s.toolName));
    const allAutomatedCompleted = automatable.every((s) => s.status === "completed");
    const anyFailed = record.steps.some((s) => s.status === "failed");
    const userCancelled = this.cancelFlags.get(cancelKey) === true;
    const anyCancelledByUser = record.steps.some((s) => s.status === "cancelled");

    let planStatusAfter: Plan["status"];
    if (userCancelled || (anyCancelledByUser && !anyFailed)) {
      record.status = "cancelled";
      planStatusAfter = "cancelled";
      await this.emit({ userId: ctx.userId, type: "plan_cancelled", description: plan.title });
    } else if (anyFailed) {
      record.status = "failed";
      planStatusAfter = "failed";
      record.failure = record.steps.find((s) => s.failure)?.failure ?? { code: "plan_failed", message: haltedReason ?? "steps failed", retryable: false };
      await this.emit({ userId: ctx.userId, type: "plan_failed", description: `${plan.title}: ${record.failure.code}` });
    } else if (automatable.length > 0 && allAutomatedCompleted) {
      record.status = "completed";
      planStatusAfter = "completed";
      await this.emit({ userId: ctx.userId, type: "plan_completed", description: plan.title, importance: 0.7 });
    } else {
      // Only manual steps remained - nothing was faked.
      record.status = "partial_manual";
      planStatusAfter = "paused";
      record.failure = {
        code: "manual_steps_pending",
        message: `${record.steps.filter((s) => s.status === "skipped").length} manual step(s) require human action; nothing was auto-completed.`,
        retryable: false,
      };
    }

    record.finishedAt = this.now();
    record.planStatusAfter = planStatusAfter;
    record.version += 1;
    await this.deps.store.updateExecution(record);

    // Persist plan state transition via the SAME PlanStore the planner uses.
    const persisted = await this.deps.planStore.getPlan(ctx.userId, plan.id);
    if (persisted) {
      persisted.status = planStatusAfter;
      persisted.updatedAt = this.now();
      persisted.version += 1;
      await this.deps.planStore.savePlan(ctx.userId, persisted);
    }

    // Goal evidence ONLY on genuine full completion (Section 15).
    if (record.status === "completed" && plan.goalId && this.deps.goalProgress) {
      try {
        await this.deps.goalProgress(ctx.userId, plan.goalId, 1, `plan ${plan.id} completed`);
      } catch {
        /* goal reporting must not corrupt execution truth */
      }
    }

    const executedTools = record.steps.filter((s) => s.toolName && s.status === "completed").length;
    return {
      authorization: "AUTHORIZED",
      planStatus: planStatusAfter,
      recordStatus: record.status,
      summary: this.summarize(record, planStatusAfter, haltedReason),
      steps: record.steps,
      ...(executedTools >= 0 ? {} : {}),
    };
  }

  private hasRunning(statuses: Map<string, StepExecStatus>): boolean {
    for (const v of statuses.values()) if (v === "running") return true;
    return false;
  }

  /**
   * Phase 30 managed loop: execute → observe/verify/recover → replan
   * when justified. Depth-capped; completed work never re-executes.
   */
  async executePlanManaged(
    planInput: Plan,
    ctx: { userId: string; requestId: string; confirmed?: boolean }
  ): Promise<ExecutionOutcome & { history: ExecutionOutcome[] }> {
    const history: ExecutionOutcome[] = [];
    let current = planInput;
    let usedReplans = 0;

    for (let depth = 0; depth < 5; depth++) {
      const requestId = depth === 0 ? ctx.requestId : `${ctx.requestId}#r${depth}`;
      const outcome = await this.executePlan(current, { ...ctx, requestId });
      history.push(outcome);

      if (outcome.planStatus !== "failed") {
        return { ...outcome, history };
      }
      if (!this.deps.observation?.replan) break;
      if (!this.deps.observation.replan.canReplan(ctx.userId, ctx.requestId)) break;
      if (usedReplans >= 2) break;

      const failedSteps = outcome.steps.filter((s) => s.status === "failed");
      const completedIds = outcome.steps.filter((s) => s.status === "completed").map((s) => s.stepId);
      const candidate = await this.deps.observation.replan.maybeReplan(
        ctx.userId, ctx.requestId, current, failedSteps, completedIds
      );
      if (!candidate.ok || !candidate.plan) break;
      current = candidate.plan;
      usedReplans++;
      // Fresh record for the revised plan; lineage preserved via request suffix.
    }

    const last = history[history.length - 1];
    return { ...last, history };
  }

  private summarize(rec: ExecutionRecord, planStatus: Plan["status"], halted: string | null): string {
    const completed = rec.steps.filter((s) => s.status === "completed").length;
    const failed = rec.steps.filter((s) => s.status === "failed").length;
    const skippedManual = rec.steps.filter((s) => s.status === "skipped").length;
    const lines = [`EXECUTED (observed): plan ${rec.planId} -> ${planStatus}${halted ? ` (${halted})` : ""}`];
    lines.push(`steps: ${completed} completed, ${failed} failed, ${skippedManual} manual/skipped`);
    for (const s of rec.steps) {
      lines.push(`- ${s.title}: ${s.status}${s.toolName ? ` [${s.toolName}]` : ""}${s.failure ? ` (${s.failure.code})` : ""}`);
    }
    return lines.join("\n").slice(0, 1500);
  }

  private blankStep(step: PlanStep): StepExecutionRecord {
    return {
      stepId: step.id,
      title: step.title.slice(0, 120),
      toolName: step.requiredTool ?? null,
      status: "pending",
      attempts: 0,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      observedResult: null,
      failure: null,
    };
  }

  private reject(plan: Plan, ctx: { userId: string }, reason: string): ExecutionOutcome {
    return {
      authorization: "REJECTED",
      planStatus: plan.status,
      recordStatus: "rejected",
      summary: `Execution refused: ${reason}`,
      steps: [],
      ...(ctx.userId ? {} : {}),
    };
  }

  private async emit(input: {
    userId: string; type: "plan_started" | "step_completed" | "step_failed"
    | "plan_completed" | "plan_failed" | "plan_cancelled";
    description?: string; importance?: number;
  }): Promise<void> {
    if (!this.deps.temporal) return;
    try {
      await this.deps.temporal.record(input);
    } catch {
      /* event emission is one-way and must never fail execution */
    }
  }
}
