/**
 * Phase 28 - plan validation gate (Section 14).
 * A plan becomes "ready" only when every check passes. Invalid plans are
 * rejected with deterministic reasons. This module never executes.
 */
import type { Plan, PlanStep } from "./types";
import { PLAN_LIMITS, WRITABLE_PLAN_STATUSES } from "./types";
import { validateDependencyGraph } from "./dependencyResolver";
import { planRisk } from "./planScorer";
import type { ToolCatalog } from "./types";

const KNOWN_FAILURE_POLICIES = new Set([
  "stop", "retry", "skip", "replan", "ask_user",
  "continue_independent", "retry_then_stop", "retry_then_continue",
]);
const KNOWN_KINDS = new Set(["single_step", "sequential", "parallel", "conditional", "iterative"]);

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  risk?: ReturnType<typeof planRisk>;
}

export function validatePlan(
  plan: Plan,
  toolCatalog: ToolCatalog
): ValidationResult {
  if (!plan.userId) return { ok: false, reason: "missing userId" };
  if (typeof plan.userId !== "string" || plan.userId.includes("/") || plan.userId.includes("..")) {
    return { ok: false, reason: "invalid userId" };
  }
  if (!KNOWN_KINDS.has(plan.kind)) return { ok: false, reason: `unknown plan kind '${plan.kind}'` };
  if (!WRITABLE_PLAN_STATUSES.has(plan.status)) {
    return { ok: false, reason: `status '${plan.status}' not writable in this phase` };
  }
  if (!KNOWN_FAILURE_POLICIES.has(plan.failurePolicy)) {
    return { ok: false, reason: `unknown failure policy '${plan.failurePolicy}'` };
  }
  if (plan.autonomyLevel < 0 || plan.autonomyLevel > 5) {
    return { ok: false, reason: "autonomy level out of range" };
  }
  if (!plan.steps.length) return { ok: false, reason: "plan has no steps" };
  if (plan.steps.length > PLAN_LIMITS.maxSteps) {
    return { ok: false, reason: `step count exceeds ${PLAN_LIMITS.maxSteps}` };
  }

  // Step-level schema + bounds.
  for (const step of plan.steps) {
    const stepErr = validateStep(step);
    if (stepErr) return { ok: false, reason: stepErr };
  }

  // Graph checks.
  const graph = validateDependencyGraph(plan.steps);
  if (!graph.ok) return { ok: false, reason: graph.reason ?? "dependency graph invalid" };

  // Tool existence via the EXISTING registry catalog (Section 13).
  const available = new Set(toolCatalog());
  for (const step of plan.steps) {
    if (step.requiredTool && !available.has(step.requiredTool)) {
      return { ok: false, reason: `unknown tool '${step.requiredTool}' on step ${step.id}` };
    }
    if ((step.intent === "" || step.intent === "undefined") && !step.requiredTool) {
      return { ok: false, reason: `step ${step.id} lacks intent and tool` };
    }
  }

  // Retry bounds.
  for (const step of plan.steps) {
    if (step.retryPolicy.maxRetries > PLAN_LIMITS.maxRetries) {
      return { ok: false, reason: `retry bound exceeded on ${step.id}` };
    }
  }

  return { ok: true, risk: planRisk(plan.steps) };
}

function validateStep(step: PlanStep): string | null {
  if (!step.id || typeof step.id !== "string") return "step missing id";
  if (!step.title || step.title.length > PLAN_LIMITS.maxStepTitleChars) return `bad title on ${step.id}`;
  if (typeof step.expectedOutcome !== "string" || step.expectedOutcome.length === 0 ||
      step.expectedOutcome.length > PLAN_LIMITS.maxExpectedOutcomeChars * 2) {
    return `bad expected outcome on ${step.id}`;
  }
  if (!Number.isFinite(step.confidence) || step.confidence < 0 || step.confidence > 1) {
    return `confidence out of range on ${step.id}`;
  }
  if (step.timeoutMs <= 0 || step.timeoutMs > PLAN_LIMITS.maxTimeoutMs) {
    return `timeout out of bounds on ${step.id}`;
  }
  if (step.status !== "draft" && step.status !== "validated" && step.status !== "ready") {
    return `illegal step status '${step.status}' in this phase`;
  }
  if (step.arguments !== undefined) {
    if (typeof step.arguments !== "object" || Array.isArray(step.arguments)) {
      return `arguments must be an object on ${step.id}`;
    }
    if (JSON.stringify(step.arguments).length > 4000) {
      return `arguments oversized on ${step.id}`;
    }
  }
  if (typeof step.index !== "number") return `missing index on ${step.id}`;
  return null;
}

/** Human-readable presentation (Section 23). Clearly PLANNED, never DONE. */
export function formatPlan(plan: Plan): string {
  const lines = [`PLANNED (not executed): ${plan.title}`];
  plan.steps.forEach((s, i) => {
    const deps = s.dependencies.length ? ` (after ${s.dependencies.join(", ")})` : "";
    lines.push(`${i + 1}. ${s.title}${deps} - expect: ${s.expectedOutcome}`);
  });
  return lines.join("\n");
}

