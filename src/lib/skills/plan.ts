/**
 * Phase 38 - skill plan factory + provenance helpers.
 *
 * Builds a Plan from a selected SkillVersion with provenance baked into
 * the plan's `constraints` array. The same factory is used by:
 *   - SkillLibrary.matchPlanForObjective (planner selection seam)
 *   - SkillLibrary.executeSkill / SkillExecutor (direct skill invocation)
 *
 * The constraints string `skill_source:<skillId>@v<version>` is what the
 * server wiring uses to detect a skill-sourced plan and feed the outcome
 * back into SkillLearningService.recordSkillOutcome (keeping runtime
 * reliability counters coherent regardless of which path invoked the
 * skill).
 */
import { randomUUID } from "node:crypto";
import type { Plan } from "../planner/types";
import type { SkillVersion } from "../learning/types";

export const SKILL_PLAN_CONSTRAINT_PREFIX = "skill_source:";

export function skillPlanConstraint(skillId: string, version: number): string {
  return `${SKILL_PLAN_CONSTRAINT_PREFIX}${skillId}@v${version}`;
}

export interface ParsedSkillPlanConstraint {
  skillId: string;
  version: number;
}

export function parseSkillPlanConstraint(constraints: string[] | undefined): ParsedSkillPlanConstraint | null {
  if (!constraints) return null;
  for (const entry of constraints) {
    if (!entry || !entry.startsWith(SKILL_PLAN_CONSTRAINT_PREFIX)) continue;
    const rest = entry.slice(SKILL_PLAN_CONSTRAINT_PREFIX.length);
    const sep = rest.indexOf("@v");
    if (sep < 1) continue;
    const skillId = rest.slice(0, sep);
    const version = Number(rest.slice(sep + 2));
    if (skillId && Number.isInteger(version) && version >= 1) return { skillId, version };
  }
  return null;
}

export interface SkillPlanBuildInput {
  skill: SkillVersion;
  uid: string;
  objective: string;
  /** Whether the caller provided an out-of-band confirmation for this run. */
  confirmed: boolean;
  /** Request identity (execution context); a fresh one is minted when absent. */
  requestId?: string;
  /** The materialized step list (defaults already applied via inputs.ts). */
  steps: SkillVersion["stepGraph"];
  now: number;
}

export function buildSkillPlan(input: SkillPlanBuildInput): Plan {
  const id = `skill-plan-${input.skill.skillId}-v${input.skill.version}-${randomUUID().slice(0, 8)}`.slice(0, 240);
  const requestId = input.requestId ?? randomUUID();
  const baseConfidence = input.skill.metrics.successRate ?? 0.6;
  const confidence = Math.max(0.6, Math.min(0.95, baseConfidence));
  return {
    id,
    userId: input.uid,
    requestId,
    title: input.skill.name.slice(0, 120),
    objective: input.objective.slice(0, 500),
    kind: input.skill.stepGraph.some((step) => step.dependencies.length > 1) ? "parallel" : "sequential",
    status: "draft",
    confidence,
    createdAt: input.now,
    updatedAt: input.now,
    steps: input.steps.map((step) => ({
      id: step.id,
      index: step.index,
      title: step.title,
      description: step.description,
      intent: "execute_task",
      status: "draft",
      dependencies: [...step.dependencies],
      ...(step.toolName ? { requiredTool: step.toolName } : {}),
      arguments: JSON.parse(JSON.stringify(step.arguments)) as Record<string, unknown>,
      expectedOutcome: step.expectedOutcome,
      riskLevel: step.riskLevel,
      confidence,
      retryPolicy: { maxRetries: Math.min(2, Math.max(0, step.maxRetries)) },
      timeoutMs: Math.min(120_000, Math.max(1_000, step.timeoutMs)),
    })),
    constraints: [
      "skill_data_only",
      "normal_authorization_required",
      "normal_confirmation_required",
      skillPlanConstraint(input.skill.skillId, input.skill.version),
    ],
    expectedOutcome: input.skill.stepGraph.at(-1)?.expectedOutcome ?? "procedure completed and verified",
    failurePolicy: "retry_then_stop",
    autonomyLevel: input.confirmed === true ? 1 : 0,
    version: 1,
    generatedBy: "deterministic",
    modelCallsUsed: 0,
  };
}

export type SkillVerdict = "VERIFIED" | "FAILED" | "INCONCLUSIVE";

/**
 * Compute a deterministic verification verdict for a finished skill run.
 * "VERIFIED" requires ALL tool steps to have a matching persisted verified
 * observation AND the execution record to be "completed". Anything else
 * is honestly named "FAILED" or "INCONCLUSIVE"; never faked.
 */
export function computeSkillVerdict(
  recordStatus: string | null | undefined,
  observations: Array<{ stepId: string; status: string }>,
  stepGraph: SkillVersion["stepGraph"]
): SkillVerdict {
  const toolStepIds = stepGraph.filter((step) => step.toolName).map((step) => step.id);
  const fullyVerified = toolStepIds.length === 0 || toolStepIds.every((stepId) => observations.some((item) => item.stepId === stepId && item.status === "verified"));
  if (recordStatus === "completed" && fullyVerified) return "VERIFIED";
  if (recordStatus === "failed") return "FAILED";
  return "INCONCLUSIVE";
}

export function verdictFailureKind(recordStatus: string | null | undefined, steps: Array<{ failure?: { code?: string } | null }>): string {
  const failed = steps.find((step) => step.failure)?.failure?.code;
  return failed ?? recordStatus ?? "unknown";
}
