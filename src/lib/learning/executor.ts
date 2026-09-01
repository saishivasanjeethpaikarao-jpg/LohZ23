import { randomUUID } from "node:crypto";
import type { PlanExecutionEngine, ExecutionOutcome } from "../execution/planExecutor";
import type { PlanStore } from "../planner/planPersistence";
import type { Plan } from "../planner/types";
import type { ObservationStore } from "../observation/observationStore";
import type { LearningStore } from "./store";
import type { SkillLearningService } from "./service";
import { materializeStepArguments, validateInputSchema, validateInputs } from "./inputs";

export interface SkillExecutionResult {
  skillId: string;
  skillVersion: number;
  planId: string | null;
  requestId?: string;
  outcome: ExecutionOutcome | null;
  error?: string;
  /** Phase 38 — when error === "invalid_skill_inputs" the per-input issues are listed here. */
  issues?: string[];
}

/**
 * Converts promoted skill DATA into a normal plan. It deliberately delegates
 * authentication to the caller and every policy/confirmation/tool decision to
 * the existing PlanExecutionEngine.
 */
export class SkillExecutor {
  constructor(
    private store: LearningStore,
    private planStore: PlanStore,
    private executionEngine: PlanExecutionEngine,
    private learning: SkillLearningService,
    private observations: ObservationStore,
    private now: () => number = Date.now,
  ) {}

  async execute(input: {
    authenticatedUserId: string;
    skillId: string;
    version: number;
    requestId?: string;
    confirmed?: boolean;
    environment: string;
    /** Phase 38 — caller-supplied inputs resolved against the skill's inputSchema. */
    inputs?: Record<string, unknown>;
  }): Promise<SkillExecutionResult> {
    const uid = input.authenticatedUserId;
    if (!uid) return { skillId: input.skillId, skillVersion: input.version, planId: null, outcome: null, error: "authentication_required" };
    const skill = await this.store.getSkillVersion(uid, input.skillId, input.version);
    if (!skill || skill.uid !== uid || skill.status !== "promoted") {
      return { skillId: input.skillId, skillVersion: input.version, planId: null, outcome: null, error: "promoted_skill_not_found" };
    }
    if (skill.requiredContext.environment !== input.environment) {
      return { skillId: input.skillId, skillVersion: input.version, planId: null, outcome: null, error: "environment_mismatch" };
    }

    // Phase 38 — input resolution (fail-closed).
    let resolvedSteps = skill.stepGraph;
    if (skill.inputSchema != null) {
      const schemaCheck = validateInputSchema(skill.inputSchema);
      if (!schemaCheck.ok) {
        return { skillId: skill.skillId, skillVersion: skill.version, planId: null, outcome: null, error: "invalid_skill_inputs", issues: schemaCheck.issues };
      }
      const inputCheck = validateInputs(skill.inputSchema, input.inputs);
      if (!inputCheck.ok) {
        return { skillId: skill.skillId, skillVersion: skill.version, planId: null, outcome: null, error: "invalid_skill_inputs", issues: inputCheck.issues };
      }
      const material = materializeStepArguments(
        skill.stepGraph.map((step) => ({ id: step.id, arguments: step.arguments })),
        skill.inputSchema,
        input.inputs,
      );
      if (!material.ok) {
        const issueCodes = material.issues.map((issue) => `${issue.code}:${issue.stepId}:${issue.detail}`);
        return { skillId: skill.skillId, skillVersion: skill.version, planId: null, outcome: null, error: "invalid_skill_inputs", issues: issueCodes };
      }
      const stepById = new Map(material.steps.map((entry) => [entry.id, entry.arguments]));
      resolvedSteps = skill.stepGraph.map((step) => ({ ...step, arguments: stepById.get(step.id) ?? step.arguments }));
    } else if (input.inputs && Object.keys(input.inputs).length > 0) {
      return { skillId: skill.skillId, skillVersion: skill.version, planId: null, outcome: null, error: "invalid_skill_inputs", issues: ["inputs_not_accepted"] };
    }

    const requestId = input.requestId ?? randomUUID();
    const now = this.now();
    const plan: Plan = {
      id: `skill-plan-${input.skillId}-v${input.version}-${requestId}`.slice(0, 240),
      userId: uid,
      requestId,
      title: skill.name.slice(0, 120),
      objective: skill.description.slice(0, 500),
      kind: skill.stepGraph.some((step) => step.dependencies.length > 1) ? "parallel" : "sequential",
      status: "ready",
      confidence: Math.max(0.6, skill.metrics.successRate ?? 0.6),
      createdAt: now,
      updatedAt: now,
      steps: resolvedSteps.map((step) => ({
        id: step.id, index: step.index, title: step.title, description: step.description,
        intent: "execute_task", status: "ready", dependencies: [...step.dependencies],
        ...(step.toolName ? { requiredTool: step.toolName } : {}),
        arguments: JSON.parse(JSON.stringify(step.arguments)), expectedOutcome: step.expectedOutcome,
        riskLevel: step.riskLevel, confidence: Math.max(0.6, skill.metrics.successRate ?? 0.6),
        retryPolicy: { maxRetries: Math.min(2, step.maxRetries) }, timeoutMs: Math.min(120_000, Math.max(1_000, step.timeoutMs)),
      })),
      constraints: ["skill_data_only", "normal_authorization_required", "normal_confirmation_required"],
      expectedOutcome: skill.stepGraph.at(-1)?.expectedOutcome ?? "procedure completed and verified",
      failurePolicy: "retry_then_stop",
      // A skill grants no autonomy. Only the out-of-band confirmation on this
      // request raises the plan to the minimum executable policy level.
      autonomyLevel: input.confirmed === true ? 1 : 0,
      version: 1,
      generatedBy: "deterministic",
      modelCallsUsed: 0,
    };
    if (!(await this.planStore.savePlan(uid, plan))) {
      return { skillId: skill.skillId, skillVersion: skill.version, planId: plan.id, outcome: null, error: "plan_persistence_failed" };
    }
    const outcome = await this.executionEngine.executePlanManaged(plan, {
      userId: uid,
      requestId,
      confirmed: input.confirmed === true,
    });
    const observed = await this.observations.listForRequest(uid, requestId);
    const toolStepIds = skill.stepGraph.filter((step) => step.toolName).map((step) => step.id);
    const fullyVerified = toolStepIds.length === 0 || toolStepIds.every((stepId) => observed.some((item) => item.stepId === stepId && item.status === "verified"));
    const verdict = outcome.recordStatus === "completed" && fullyVerified ? "VERIFIED"
      : outcome.recordStatus === "failed" ? "FAILED" : "INCONCLUSIVE";
    const failureKind = outcome.steps.find((step) => step.failure)?.failure?.code ?? outcome.recordStatus;
    await this.learning.recordSkillOutcome(uid, skill.skillId, skill.version, input.environment, verdict, failureKind);
    return { skillId: skill.skillId, skillVersion: skill.version, planId: plan.id, requestId, outcome };
  }
}
