import type { ExecutionStore } from "../execution/persistence";
import type { ExecutionRecord, StepExecutionRecord } from "../execution/types";
import type { ObservationStore } from "../observation/observationStore";
import type { Observation, VerificationVerdict } from "../observation/types";
import type { PlanStore } from "../planner/planPersistence";
import type { Plan, PlanStep } from "../planner/types";
import type { ExperienceFailure, ExperienceOutcome, ExperienceRecord, ExperienceStep, UserCorrectionEvidence } from "./types";
import { LEARNING_LIMITS } from "./types";
import { adaptiveTaskType } from "../adaptation/signature";

function clip(value: unknown, max: number = LEARNING_LIMITS.maxTextChars): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return "<bounded>";
  if (typeof value === "string") return clip(value, 300).replace(/(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=<redacted>");
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/(apiKey|token|secret|password|authorization|credential)/i.test(key))
      .slice(0, 30).map(([key, item]) => [clip(key, 80), safeValue(item, depth + 1)]));
  }
  return String(value ?? "");
}

export function objectiveTokens(objective: string): string[] {
  return [...new Set(objective.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3).slice(0, 12))];
}

export function experienceSignature(plan: Pick<Plan, "steps" | "objective">, environment: string): string {
  const tools = plan.steps.slice(0, LEARNING_LIMITS.maxSteps).map((step) => step.requiredTool ?? `manual:${step.intent}`).join(">");
  return `${clip(environment, 80).toLowerCase()}|${tools}|${objectiveTokens(plan.objective).slice(0, 6).join("-")}`.slice(0, 500);
}

function verdictForStep(step: StepExecutionRecord, observations: Observation[]): VerificationVerdict | "NOT_APPLICABLE" {
  if (!step.toolName) return "NOT_APPLICABLE";
  const related = observations.filter((item) => item.stepId === step.stepId);
  if (related.some((item) => item.status === "verified")) return "VERIFIED";
  if (related.some((item) => item.status === "contradicted")) return "FAILED";
  return "INCONCLUSIVE";
}

function mapOutcome(record: ExecutionRecord): ExperienceOutcome {
  if (record.status === "completed") return "success";
  if (record.status === "failed" || record.status === "cancelled") return "failure";
  if (record.status === "awaiting_confirmation") return "awaiting_confirmation";
  if (record.status === "rejected") return "rejected";
  return "partial";
}

function toStep(planStep: PlanStep, record: StepExecutionRecord | undefined, observations: Observation[]): ExperienceStep {
  const verification = record ? verdictForStep(record, observations) : "INCONCLUSIVE";
  return {
    stepId: planStep.id,
    index: planStep.index,
    title: clip(planStep.title, 120),
    toolName: planStep.requiredTool ?? null,
    arguments: safeValue(planStep.arguments ?? {}) as Record<string, unknown>,
    dependencies: planStep.dependencies.slice(0, LEARNING_LIMITS.maxSteps).map((item) => clip(item, 120)),
    expectedOutcome: clip(planStep.expectedOutcome, 200),
    riskLevel: planStep.riskLevel,
    outcome: record?.status === "completed" ? "completed"
      : record?.status === "failed" ? "failed"
      : record?.status === "skipped" ? "skipped"
      : record?.status === "blocked" ? "blocked"
      : "cancelled",
    attempts: Math.max(0, Math.min(10, record?.attempts ?? 0)),
    durationMs: record?.durationMs ?? null,
    failureCode: record?.failure?.code ? clip(record.failure.code, 100) : null,
    verification,
  };
}

export interface ExperienceBuilderDeps {
  executions: ExecutionStore;
  plans: PlanStore;
  observations: ObservationStore;
  environment?: () => string;
  now?: () => number;
}

export class ExperienceBuilder {
  private now: () => number;
  constructor(private deps: ExperienceBuilderDeps) { this.now = deps.now ?? Date.now; }

  async capture(uid: string, requestId: string, corrections: UserCorrectionEvidence[] = []): Promise<ExperienceRecord | null> {
    if (!uid || !requestId) return null;
    const all = await this.deps.executions.listExecutions(uid, 100);
    const lineage = all.filter((record) => record.requestId === requestId || record.requestId.startsWith(`${requestId}#r`))
      .sort((a, b) => a.startedAt - b.startedAt);
    if (lineage.length === 0) return null;
    const final = lineage.at(-1)!;
    if (lineage.some((record) => record.uid !== uid)) return null;
    const plan = await this.deps.plans.getPlan(uid, final.planId);
    if (!plan || plan.userId !== uid) return null;
    const observationGroups = await Promise.all(lineage.map((record) => this.deps.observations.listForRequest(uid, record.requestId)));
    const observations = observationGroups.flat().filter((item) => item.uid === uid);
    const stepRecords = new Map(final.steps.map((step) => [step.stepId, step]));
    const steps = plan.steps.slice(0, LEARNING_LIMITS.maxSteps).map((step) => toStep(step, stepRecords.get(step.id), observations));
    const toolSteps = steps.filter((step) => step.toolName);
    const verification: ExperienceRecord["verification"] = toolSteps.length === 0
      ? "NOT_APPLICABLE"
      : toolSteps.every((step) => step.verification === "VERIFIED") ? "VERIFIED"
      : toolSteps.some((step) => step.verification === "FAILED") ? "FAILED" : "INCONCLUSIVE";
    const outcome = mapOutcome(final);
    const success = outcome === "success" && (verification === "VERIFIED" || verification === "NOT_APPLICABLE") && corrections.length === 0;
    const environment = clip(this.deps.environment?.() ?? "windows-local", 80);
    const failures: ExperienceFailure[] = lineage.flatMap((record) => record.steps.filter((step) => step.failure).map((step) => ({
      stepId: step.stepId,
      code: clip(step.failure!.code, 100),
      kind: "execution" as const,
      retryable: step.failure!.retryable,
    })));
    for (const correction of corrections) failures.push({ stepId: null, code: "user_correction", kind: "user_correction", retryable: false });
    return {
      id: `experience:${requestId}`,
      uid,
      objective: clip(plan.objective),
      context: { environment, signature: experienceSignature(plan, environment), tags: [] },
      planId: final.planId,
      planVersion: final.planVersion,
      requestId,
      steps,
      outcome,
      failures,
      recovery: {
        attempted: lineage.length > 1 || final.steps.some((step) => step.attempts > 1),
        succeeded: success && lineage.some((record) => record.status === "failed"),
        actions: lineage.length > 1 ? ["REPLAN"] : final.steps.some((step) => step.attempts > 1) ? ["RETRY"] : [],
      },
      replans: { count: Math.max(0, lineage.length - 1), planIds: lineage.map((record) => record.planId).slice(0, 5) },
      verification,
      success,
      userCorrections: corrections.slice(0, 10).map((item) => ({ ...item, text: clip(item.text) })),
      source: { executionRequestIds: lineage.map((record) => record.requestId), observationIds: observations.map((item) => item.id).slice(0, 100) },
      decision: {
        taskType: adaptiveTaskType(plan.steps[0]?.intent ?? "execute_task", plan.objective),
        approach: plan.constraints.some((item) => item.startsWith("skill_source:")) ? "known_skill"
          : lineage.length > 1 || final.steps.some((step) => step.attempts > 1) ? "recovery_strategy"
          : plan.steps.length > 1 ? "planner" : "deterministic",
        predictedConfidence: Math.max(0, Math.min(1, plan.confidence)),
        confidenceKind: "heuristic",
      },
      createdAt: this.now(),
      schemaVersion: 1,
    };
  }
}
