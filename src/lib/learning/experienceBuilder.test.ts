import { describe, expect, it } from "vitest";
import { InMemoryExecutionStore } from "../execution/persistence";
import type { ExecutionRecord } from "../execution/types";
import { InMemoryObservationStore } from "../observation/observationStore";
import { InMemoryPlanStore } from "../planner/planPersistence";
import type { Plan } from "../planner/types";
import { ExperienceBuilder } from "./experienceBuilder";

function plan(uid = "u1"): Plan {
  return {
    id: "p1", userId: uid, requestId: "r1", title: "Open dashboard", objective: "Open dashboard safely", kind: "single_step", status: "completed",
    confidence: 0.9, createdAt: 1, updatedAt: 2, constraints: [], expectedOutcome: "open", failurePolicy: "stop", autonomyLevel: 0,
    version: 2, generatedBy: "deterministic", modelCallsUsed: 0,
    steps: [{ id: "s1", index: 0, title: "Open", description: "Open it", intent: "open_app", status: "completed", dependencies: [], requiredTool: "openApp", arguments: { name: "Dashboard", token: "must-not-persist" }, expectedOutcome: "open", riskLevel: "safe", confidence: 0.9, retryPolicy: { maxRetries: 1 }, timeoutMs: 1_000 }],
  };
}
function execution(uid = "u1"): ExecutionRecord {
  return { uid, requestId: "r1", planId: "p1", planVersion: 2, status: "completed", authorization: "AUTHORIZED", startedAt: 1, finishedAt: 2, planStatusAfter: "completed", failure: null, version: 2,
    steps: [{ stepId: "s1", title: "Open", toolName: "openApp", status: "completed", attempts: 1, startedAt: 1, finishedAt: 2, durationMs: 1, observedResult: "ok", failure: null }] };
}

describe("Phase 36 experience construction", () => {
  it("joins owned plan/execution/observation evidence and redacts credential-like arguments", async () => {
    const executions = new InMemoryExecutionStore(); const plans = new InMemoryPlanStore(); const observations = new InMemoryObservationStore();
    await plans.savePlan("u1", plan()); await executions.saveExecution(execution());
    await observations.add("u1", "r1", { id: "o1", uid: "u1", planId: "p1", stepId: "s1", requestId: "r1", timestamp: 2, source: "tool_result", observedState: "open", evidence: "verified", confidence: 1, status: "verified" });
    const record = await new ExperienceBuilder({ executions, plans, observations, now: () => 3 }).capture("u1", "r1");
    expect(record?.success).toBe(true); expect(record?.verification).toBe("VERIFIED");
    expect(record?.steps[0].arguments).not.toHaveProperty("token");
    expect(record?.source.observationIds).toEqual(["o1"]);
  });

  it("never crosses the authenticated user boundary", async () => {
    const executions = new InMemoryExecutionStore(); const plans = new InMemoryPlanStore(); const observations = new InMemoryObservationStore();
    await plans.savePlan("u1", plan()); await executions.saveExecution(execution());
    const builder = new ExperienceBuilder({ executions, plans, observations });
    expect(await builder.capture("u2", "r1")).toBeNull();
  });

  it("does not call an unobserved tool completion verified", async () => {
    const executions = new InMemoryExecutionStore(); const plans = new InMemoryPlanStore(); const observations = new InMemoryObservationStore();
    await plans.savePlan("u1", plan()); await executions.saveExecution(execution());
    const record = await new ExperienceBuilder({ executions, plans, observations }).capture("u1", "r1");
    expect(record?.verification).toBe("INCONCLUSIVE"); expect(record?.success).toBe(false);
  });
});

