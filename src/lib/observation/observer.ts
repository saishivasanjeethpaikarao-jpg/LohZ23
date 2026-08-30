/**
 * Phase 30 - Observer + RecoveryCoordinator (Sections 3, 6, 9-12).
 *
 * The core invariant: a step completes ONLY on VERIFIED evidence.
 * TOOL_RESULT-sufficient rules may complete directly; everything else
 * requires probe/state confirmation. Recovery is bounded (<=2), prefers
 * RECHECK-before-ACT for side-effecting tools, and never retries
 * destructive/authorization/argument failures.
 */
import type { PlanStep } from "../planner/types";
import type {
  ExecutionDeps,
  StepExecutionRecord,
} from "../execution/types";
import type { StepExecutor } from "../execution/stepExecutor";
import { classifyFailure } from "./failureClassifier";
import { ruleFor } from "./verificationRules";
import { PROBE_SAFE_TOOLS, sanitizeEvidence, RECOVERY_LIMITS, OBSERVATION_LIMITS } from "./types";
import type { Observation, VerificationVerdict } from "./types";
import type { ObservationStore } from "./observationStore";

export interface ObservationEventEmitter {
  record: (input: {
    userId: string;
    type: "step_verified" | "step_verification_failed" | "recovery_started"
      | "recovery_succeeded" | "recovery_failed" | "plan_replanned";
    description?: string;
    importance?: number;
  }) => Promise<void>;
}

export interface ObservationHooksDeps {
  store: ObservationStore;
  events?: ObservationEventEmitter;
  /** Read-only runner reused for probes - same bridge, no duplicates. */
  probeRunner: (userId: string, toolName: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown }>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Optional MODEL_ASSISTED fallback - off by default (Section 15). */
  modelVerifier?: (userId: string, step: PlanStep, note: string) =>
    Promise<"VERIFIED" | "FAILED" | "INCONCLUSIVE">;
  memoryCandidate?: (uid: string, text: string) => void;
}

const SIDE_EFFECTING = new Set(["openApp", "closeApp", "setVolume", "clipboardWrite", "createFile", "writeFile", "createFolder", "renameFile"]);

export class ObservationCoordinator {
  constructor(private deps: ObservationHooksDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
  }
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  private probeArguments(step: PlanStep, probeTool: string): Record<string, unknown> {
    if (probeTool !== "readFile") return {};
    const original = typeof step.arguments?.path === "string" ? step.arguments.path : "";
    if (step.requiredTool !== "renameFile") return original ? { path: original } : {};
    const newName = typeof step.arguments?.newName === "string" ? step.arguments.newName : "";
    if (!original || !newName) return {};
    const split = Math.max(original.lastIndexOf("/"), original.lastIndexOf("\\"));
    return { path: `${split >= 0 ? original.slice(0, split + 1) : ""}${newName}` };
  }

  private async probe(userId: string, toolName: string, args: Record<string, unknown>): Promise<{ ok: boolean; raw: unknown } | null> {
    if (!PROBE_SAFE_TOOLS.has(toolName)) return null;
    try {
      const r = await this.deps.probeRunner(userId, toolName, args);
      return { ok: Boolean(r?.ok), raw: r?.result };
    } catch {
      return null;
    }
  }

  private mkObservation(uid: string, planId: string, stepId: string, requestId: string,
    source: Observation["source"], state: string, evidence: string,
    confidence: number, status: Observation["status"]): Observation {
    return {
      id: `obs-${this.now()}-${Math.random().toString(36).slice(2, 7)}`,
      uid, planId, stepId, requestId,
      timestamp: this.now(),
      source,
      observedState: sanitizeEvidence(state),
      evidence: sanitizeEvidence(evidence),
      confidence: Math.max(0, Math.min(1, confidence)),
      status,
    };
  }

  /**
   * State-only check used by idempotent recovery: has the desired state
   * ALREADY been achieved, without performing the action again?
   */
  async recheckState(
    userId: string, planId: string, requestId: string, step: PlanStep
  ): Promise<{ verdict: VerificationVerdict; observation: Observation; persisted: boolean } | null> {
    const rule = ruleFor(step.requiredTool);
    if (!rule?.probeTool) return null;
    const probe = await this.probe(userId, rule.probeTool, this.probeArguments(step, rule.probeTool));
    const outcome = rule.evaluate({
      step,
      toolOk: false, // we did NOT act; only state matters here
      toolResultRaw: undefined,
      probeOk: probe ? probe.ok : null,
      probeResultRaw: probe?.raw,
    });
    // For recheck, "tool failed but state present" must read VERIFIED.
    let verdict = outcome.verdict;
    if (verdict === "INCONCLUSIVE" && probe && !probe.ok) verdict = "INCONCLUSIVE";
    if (probe && probe.ok) {
      // Re-evaluate pretending action succeeded so positive predicates fire.
      const positive = rule.evaluate({
        step, toolOk: true, toolResultRaw: undefined,
        probeOk: probe.ok, probeResultRaw: probe.raw,
      });
      verdict = positive.verdict;
    }
    const obs = this.mkObservation(userId, planId, step.id, requestId,
      "recheck", outcome.observedState, outcome.evidence, outcome.confidence,
      verdict === "VERIFIED" ? "verified" : verdict === "FAILED" ? "contradicted" : "inconclusive");
    const persisted = await this.deps.store.add(userId, requestId, obs);
    return { verdict: persisted ? verdict : "INCONCLUSIVE", observation: obs, persisted };
  }

  /** Verify an executed step per its rule. Deterministic-first. */
  async verifyExecuted(
    userId: string, planId: string, requestId: string, step: PlanStep,
    toolOutcome: { ok: boolean; errorKind?: string; resultRaw: unknown }
  ): Promise<{ verdict: VerificationVerdict; observation: Observation; persisted: boolean }> {
    const rule = ruleFor(step.requiredTool);
    let outcomeLevel = rule?.level ?? "NONE";
    let evaluated = rule
      ? (() => {
          let probe: { ok: boolean; raw: unknown } | null = null;
          if (rule.probeTool) {
            // Synchronous-ish: probes run through the injected runner.
          }
          return { rule, probe: undefined as typeof probe };
        })()
      : null;
    void evaluated;

    let probeData: { ok: boolean; raw: unknown } | null = null;
    if (rule?.probeTool) {
      probeData = await this.probe(userId, rule.probeTool, this.probeArguments(step, rule.probeTool));
    }

    let verdict: VerificationVerdict;
    let observedState: string;
    let evidence: string;
    let confidence: number;

    if (!rule || rule.level === "NONE") {
      // Optional MODEL_ASSISTED fallback - constrained to three verdicts.
      if (this.deps.modelVerifier && toolOutcome.ok) {
        try {
          verdict = await this.deps.modelVerifier(userId, step, `tool=${step.requiredTool} ok`);
          observedState = "model-assisted verification";
          evidence = `model returned ${verdict}`;
          confidence = 0.4;
        } catch {
          verdict = "INCONCLUSIVE";
          observedState = "verification unavailable";
          evidence = "no deterministic rule; model verifier unavailable";
          confidence = 0.2;
        }
      } else {
        verdict = toolOutcome.ok ? "INCONCLUSIVE" : "FAILED";
        observedState = toolOutcome.ok ? "no verification rule" : "tool failed";
        evidence = toolOutcome.ok ? "cannot independently confirm" : sanitizeEvidence(String(toolOutcome.errorKind ?? ""));
        confidence = toolOutcome.ok ? 0.25 : 0.7;
      }
    } else {
      const r = rule.evaluate({
        step,
        toolOk: toolOutcome.ok,
        toolResultRaw: toolOutcome.resultRaw,
        probeOk: probeData ? probeData.ok : null,
        probeResultRaw: probeData?.raw,
      });
      verdict = r.verdict; observedState = r.observedState; evidence = r.evidence; confidence = r.confidence;
      void outcomeLevel;
    }

    const obs = this.mkObservation(userId, planId, step.id, requestId,
      probeData ? "probe" : "tool_result", observedState, evidence, confidence,
      verdict === "VERIFIED" ? "verified" : verdict === "FAILED" ? "contradicted" : "inconclusive");
    const persisted = await this.deps.store.add(userId, requestId, obs);
    return { verdict: persisted ? verdict : "INCONCLUSIVE", observation: obs, persisted };
  }

  /**
   * Full verified-step pipeline with bounded recovery.
   * Contract-compatible with StepExecutor.run().
   */
  async executeVerifiedStep(
    userId: string,
    planId: string,
    requestId: string,
    step: PlanStep,
    executor: StepExecutor
  ): Promise<StepExecutionRecord> {
    const first = await executor.run(userId, step);

    // Fast path: clean success -> still must VERIFY.
    if (first.record.status === "completed") {
      const v = await this.verifyExecuted(userId, planId, requestId, step,
        { ok: true, resultRaw: first.record.observedResult });
      if (v.verdict === "VERIFIED" && v.persisted) {
        first.record.observedResult = `${first.record.observedResult ?? ""} | verified: ${v.observation.observedState}`.slice(0, OBSERVATION_LIMITS.observedResultChars);
        await this.emit({ userId, type: "step_verified", description: `${step.title}: ${v.observation.observedState}` });
        return first.record;
      }
      if (v.verdict === "INCONCLUSIVE" && v.persisted && ruleFor(step.requiredTool)?.toolResultSufficient) {
        await this.emit({ userId, type: "step_verified", description: `${step.title}: tool-result sufficient` });
        return first.record;
      }
      // Contradicted or unverifiable success -> treat as failure + recover.
      return this.recover(userId, planId, requestId, step, executor, first.record, v.verdict);
    }

    // Initial execution failed -> classify and consider RECHECK/retry.
    const code = first.record.failure?.code ?? "";
    const cls = classifyFailure(code);

    // Idempotent recovery FIRST for side-effecting tools (Section 11/12):
    if (SIDE_EFFECTING.has(step.requiredTool ?? "")) {
      const recheck = await this.recheckState(userId, planId, requestId, step);
      if (recheck?.verdict === "VERIFIED" && recheck.persisted) {
        first.record.status = "completed";
        first.record.failure = null;
        first.record.observedResult = `state already satisfied (recheck): ${recheck.observation.observedState}`.slice(0, OBSERVATION_LIMITS.observedResultChars);
        await this.emit({ userId, type: "recovery_succeeded", description: `${step.title}: no duplicate action needed` });
        await this.emit({ userId, type: "step_verified", description: `${step.title}: verified via recheck` });
        return first.record;
      }
    }

    if (!cls.retryable) {
      await this.emit({ userId, type: "step_verification_failed", description: `${step.title}: ${cls.kind}` });
      return first.record;
    }

    return this.retryWithBackoff(userId, planId, requestId, step, executor, first.record, cls.recommendedRecovery);
  }

  private async retryWithBackoff(
    userId: string, planId: string, requestId: string, step: PlanStep,
    executor: StepExecutor, base: StepExecutionRecord,
    action: "RETRY" | "WAIT_AND_RETRY" | "RECHECK" | "STOP" | "ASK_USER" | "REPLAN" | "ALTERNATIVE_ALLOWED_TOOL"
  ): Promise<StepExecutionRecord> {
    if (action === "STOP" || action === "ASK_USER" || action === "REPLAN" || action === "ALTERNATIVE_ALLOWED_TOOL") {
      await this.emit({ userId, type: "step_verification_failed", description: `${step.title}: ${base.failure?.code}` });
      return base;
    }

    await this.emit({ userId, type: "recovery_started", description: `${step.title}: ${action}` });

    let current = base;
    for (let attempt = 1; attempt <= RECOVERY_LIMITS.maxRecoveryAttempts; attempt++) {
      if (action === "WAIT_AND_RETRY") {
        const ms = RECOVERY_LIMITS.backoffMinMs +
          Math.floor(Math.random() * (RECOVERY_LIMITS.backoffMaxMs - RECOVERY_LIMITS.backoffMinMs));
        await this.sleep(ms);
      }
      current = (await executor.run(userId, step)).record;
      current.attempts = (base.attempts || 0) + attempt;
      if (current.status === "completed") {
        const v = await this.verifyExecuted(userId, planId, requestId, step,
          { ok: true, resultRaw: current.observedResult });
        if (v.persisted && (v.verdict === "VERIFIED" || ruleFor(step.requiredTool)?.toolResultSufficient)) {
          await this.emit({ userId, type: "recovery_succeeded", description: `${step.title} after ${attempt} recovery attempt(s)` });
          await this.emit({ userId, type: "step_verified", description: step.title });
          return current;
        }
        return this.recover(userId, planId, requestId, step, executor, current, v.verdict);
      }
    }

    await this.emit({ userId, type: "recovery_failed", description: `${step.title}: exhausted ${RECOVERY_LIMITS.maxRecoveryAttempts}` });
    if (this.deps.memoryCandidate) {
      this.deps.memoryCandidate(userId, sanitizeEvidence(`Recovery failed for "${current.title}" (${current.failure?.code}).`));
    }
    return current;
  }

  /** Handle executed-but-unverified outcomes (contradicted/inconclusive). */
  private async recover(
    userId: string, planId: string, requestId: string, step: PlanStep,
    executor: StepExecutor, base: StepExecutionRecord,
    verdict: VerificationVerdict
  ): Promise<StepExecutionRecord> {
    await this.emit({ userId, type: "step_verification_failed", description: `${step.title}: ${verdict.toLowerCase()}` });

    // One bounded RECHECK cycle for side-effecting steps.
    if (SIDE_EFFECTING.has(step.requiredTool ?? "")) {
      const recheck = await this.recheckState(userId, planId, requestId, step);
      if (recheck?.verdict === "VERIFIED" && recheck.persisted) {
        base.status = "completed";
        base.failure = null;
        base.observedResult = `verified via post-failure recheck: ${recheck.observation.observedState}`;
        await this.emit({ userId, type: "recovery_succeeded", description: `${step.title}: state confirmed` });
        await this.emit({ userId, type: "step_verified", description: step.title });
        return base;
      }
      // Retry ONCE within budget when the failure looks transient.
      const cls = classifyFailure(base.failure?.code ?? "");
      if (cls.retryable) {
        return this.retryWithBackoff(userId, planId, requestId, step, executor, base, cls.recommendedRecovery === "WAIT_AND_RETRY" ? "WAIT_AND_RETRY" : "RETRY");
      }
    }

    const kind = verdict === "INCONCLUSIVE" ? "inconclusive_verification" : "state_mismatch";
    base.status = "failed";
    base.failure = { code: kind, message: `verification said ${verdict}`, retryable: false };
    if (this.deps.memoryCandidate) {
      this.deps.memoryCandidate(userId, sanitizeEvidence(`Could not verify "${step.title}" (${verdict}).`));
    }
    return base;
  }

  private async emit(i: Parameters<ObservationEventEmitter["record"]>[0]): Promise<void> {
    if (!this.deps.events) return;
    try { await this.deps.events.record(i); } catch { /* one-way */ }
  }
}

