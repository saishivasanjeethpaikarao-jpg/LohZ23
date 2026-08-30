/**
 * Adapt deterministic Tier 0 calls to the existing plan/execution authority.
 * This preserves the fast, zero-model path without granting the router a
 * direct bridge bypass.
 */
import type { ToolExecutor } from "../router/cognitiveRouter";
import type { PlanStore } from "../planner/planPersistence";
import type { Plan } from "../planner/types";
import type { PlanExecutionEngine } from "../execution/planExecutor";

export interface AuthorizedToolExecutorDeps {
  planStore: PlanStore;
  executionEngine: PlanExecutionEngine;
  hasTool: (toolName: string) => boolean;
  riskForTool: (toolName: string) => "safe" | "low" | "medium" | "high" | "critical";
  now?: () => number;
}

export function createAuthorizedToolExecutor(deps: AuthorizedToolExecutorDeps): ToolExecutor {
  const now = deps.now ?? Date.now;
  return async (userId, toolName, args, context) => {
    if (!deps.hasTool(toolName)) return { ok: false, errorKind: "tool_not_found" };
    const requestId = context?.requestId ?? `direct-${now()}`;
    const timestamp = now();
    const directPlan: Plan = {
      id: `direct-${requestId}`,
      userId,
      requestId,
      title: `Direct ${toolName}`,
      objective: `Execute registered tool ${toolName}`,
      kind: "single_step",
      status: "ready",
      confidence: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      steps: [{
        id: "s1", index: 0, title: toolName, description: `Execute ${toolName}`,
        intent: toolName, status: "ready", dependencies: [], requiredTool: toolName,
        arguments: args, expectedOutcome: `${toolName} verified`, riskLevel: deps.riskForTool(toolName),
        confidence: 1, retryPolicy: { maxRetries: 2 }, timeoutMs: 30_000,
      }],
      constraints: ["registered_tool_only", "authorization_required", "verification_required"],
      expectedOutcome: `${toolName} verified`, failurePolicy: "stop", autonomyLevel: 1,
      version: 1, generatedBy: "deterministic", modelCallsUsed: 0,
    };
    if (!(await deps.planStore.savePlan(userId, directPlan))) {
      return { ok: false, errorKind: "persistence_failed" };
    }
    const outcome = await deps.executionEngine.executePlanManaged(directPlan, {
      userId, requestId, confirmed: false,
    });
    if (outcome.authorization === "REQUIRES_CONFIRMATION") {
      return { ok: false, errorKind: "confirmation_required", result: { requestId, planId: directPlan.id } };
    }
    const step = outcome.steps[0];
    return step?.status === "completed"
      ? {
          ok: true,
          result: step.observedResult,
          verificationStatus: /verified/i.test(String(step.observedResult ?? "")) ? "VERIFIED" : "UNVERIFIED",
        }
      : { ok: false, errorKind: step?.failure?.code ?? outcome.recordStatus, verificationStatus: "FAILED" };
  };
}
