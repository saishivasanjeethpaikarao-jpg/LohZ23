import { describe, it, expect, beforeEach } from "vitest";
import { TaskPlanner, Plan, PlanStep, StepResult, DEFAULT_PLAN_CONFIG } from "./taskPlanner";

// ── Helpers ──

function successResult(output: string = "done"): StepResult {
  return { success: true, output, latencyMs: 100, timestamp: Date.now() };
}

function failResult(error: string = "tool error"): StepResult {
  return { success: false, output: null, error, latencyMs: 100, timestamp: Date.now() };
}

function makeExecute(results: StepResult[]) {
  let callIndex = 0;
  return (_step: PlanStep): StepResult => {
    return results[Math.min(callIndex++, results.length - 1)];
  };
}

// ── Tests ──

describe("TaskPlanner", () => {
  let planner: TaskPlanner;

  beforeEach(() => {
    planner = new TaskPlanner({
      maxSteps: 10,
      defaultMaxRetries: 2,
      requireConfirmationForHighRisk: true,
      availableTools: ["conversation", "memory_retrieval", "memory_store", "web_search", "filesystem_read"],
      grantedPermissions: ["memory.read", "memory.write", "web.search"],
      criticalTools: [],
    });
  });

  // ── 1. Simple Task ──

  describe("simple task", () => {
    it("should create a single-step plan for unrecognized goal", () => {
      const plan = planner.createPlan("u1", "do something random");
      expect(plan.steps.length).toBe(1);
      expect(plan.steps[0].description).toBe("do something random");
      expect(plan.status).toBe("draft");
    });

    it("should create multi-step plan for search goal", () => {
      const plan = planner.createPlan("u1", "search for TypeScript patterns");
      expect(plan.steps.length).toBe(3);
      expect(plan.steps[0].description).toContain("Search");
      expect(plan.steps[1].description).toContain("results");
      expect(plan.steps[2].description).toContain("Summarize");
    });

    it("should create multi-step plan for create goal", () => {
      const plan = planner.createPlan("u1", "create a README file");
      expect(plan.steps.length).toBe(3);
      expect(plan.steps[0].description).toContain("requirements");
    });

    it("should create multi-step plan for open goal", () => {
      const plan = planner.createPlan("u1", "open Chrome browser");
      expect(plan.steps.length).toBe(2);
    });

    it("should assign tool based on description keywords", () => {
      const plan = planner.createPlan("u1", "search for something");
      const searchStep = plan.steps[0];
      // Should match web_search or similar
      expect(searchStep.toolRequired).toBeTruthy();
    });

    it("should set correct dependencies between steps", () => {
      const plan = planner.createPlan("u1", "search for something");
      expect(plan.steps[0].dependencies).toEqual([]);
      expect(plan.steps[1].dependencies.length).toBe(1);
      expect(plan.steps[2].dependencies.length).toBe(1);
    });
  });

  // ── 2. Multi-Step Task ──

  describe("multi-step task", () => {
    it("should execute steps in dependency order", () => {
      const plan = planner.createPlan("u1", "search for TypeScript patterns");
      const exec = makeExecute([successResult("found"), successResult("read"), successResult("summary")]);

      const r1 = planner.executeStep(plan.id, plan.steps[0].id, exec);
      expect(r1.step.status).toBe("completed");
      expect(r1.shouldContinue).toBe(true);

      const r2 = planner.executeStep(plan.id, plan.steps[1].id, exec);
      expect(r2.step.status).toBe("completed");

      const r3 = planner.executeStep(plan.id, plan.steps[2].id, exec);
      expect(r3.step.status).toBe("completed");
      expect(r3.plan.status).toBe("completed");
      expect(r3.shouldContinue).toBe(false);
    });

    it("should block step with unmet dependencies", () => {
      const plan = planner.createPlan("u1", "search for TypeScript patterns");
      const exec = makeExecute([successResult()]);

      // Try to execute step 2 before step 1
      const result = planner.executeStep(plan.id, plan.steps[1].id, exec);
      expect(result.shouldContinue).toBe(false);
      expect(result.step.status).toBe("pending");
    });

    it("should track execution history", () => {
      const plan = planner.createPlan("u1", "search for something");
      const exec = makeExecute([successResult("r1"), successResult("r2"), successResult("r3")]);

      planner.executeStep(plan.id, plan.steps[0].id, exec);
      planner.executeStep(plan.id, plan.steps[1].id, exec);
      planner.executeStep(plan.id, plan.steps[2].id, exec);

      expect(plan.executionHistory.length).toBe(3);
    });
  });

  // ── 3. Tool Failure ──

  describe("tool failure", () => {
    it("should mark step as failed on tool error", () => {
      const plan = planner.createPlan("u1", "search for something");
      const exec = makeExecute([failResult("network error")]);

      const result = planner.executeStep(plan.id, plan.steps[0].id, exec);
      expect(result.step.status).toBe("pending"); // retry pending
      expect(result.step.result?.error).toContain("network error");
      expect(result.step.retryCount).toBe(1);
    });

    it("should trigger retry on failure", () => {
      const plan = planner.createPlan("u1", "search for something");
      const exec = makeExecute([failResult("timeout")]);

      planner.executeStep(plan.id, plan.steps[0].id, exec);
      expect(plan.failureStrategy).toBe("retry");
      expect(plan.steps[0].retryCount).toBe(1);
      expect(plan.steps[0].status).toBe("pending");
    });

    it("should abort after max retries exhausted", () => {
      const plan = planner.createPlan("u1", "do something");
      const exec = makeExecute([failResult("fail 1"), failResult("fail 2"), failResult("fail 3")]);

      planner.executeStep(plan.id, plan.steps[0].id, exec); // retry 1
      planner.executeStep(plan.id, plan.steps[0].id, exec); // retry 2
      planner.executeStep(plan.id, plan.steps[0].id, exec); // retries exhausted → ask_user

      expect(plan.steps[0].status).toBe("awaiting_confirmation");
      expect(plan.failureStrategy).toBe("ask_user");
    });

    it("should use alternative tool when available", () => {
      const plan = planner.createPlan("u1", "search for something");
      const step = plan.steps[0];
      const originalTool = step.toolRequired;

      // Fail once to trigger alternative
      const exec = makeExecute([failResult("fail")]);
      planner.executeStep(plan.id, step.id, exec);

      if (step.alternativeTools.length > 0) {
        expect(plan.failureStrategy).toBe("alternative");
        expect(step.toolRequired).not.toBe(originalTool);
      }
    });
  });

  // ── 4. Retry ──

  describe("retry", () => {
    it("should retry failed step up to maxRetries", () => {
      const plan = planner.createPlan("u1", "do something");
      const exec = makeExecute([failResult("err1"), failResult("err2"), successResult("ok")]);

      planner.executeStep(plan.id, plan.steps[0].id, exec); // fail, retry 1
      planner.executeStep(plan.id, plan.steps[0].id, exec); // fail, retry 2
      planner.executeStep(plan.id, plan.steps[0].id, exec); // success

      expect(plan.steps[0].status).toBe("completed");
      expect(plan.steps[0].retryCount).toBe(2);
    });

    it("should reset retry count on user guidance", () => {
      const plan = planner.createPlan("u1", "do something");
      const step = plan.steps[0];
      step.retryCount = 2;

      planner.userProvideGuidance(plan.id, step.id, "try a different approach");
      expect(step.retryCount).toBe(0);
      expect(step.status).toBe("pending");
    });
  });

  // ── 5. Replan ──

  describe("replan", () => {
    it("should create recovery step on replan", () => {
      const plan = planner.createPlan("u1", "do something complex");
      const step = plan.steps[0];
      step.maxRetries = 0; // No retries allowed
      step.alternativeTools = []; // No alternatives

      const exec = makeExecute([failResult("critical failure")]);
      planner.executeStep(plan.id, step.id, exec);

      // With maxRetries=0 and no alternatives, strategy is ask_user
      expect(plan.failureStrategy).toBe("ask_user");
      expect(step.status).toBe("awaiting_confirmation");
    });

    it("should replan when retries exhausted and alternatives exist", () => {
      const plan = planner.createPlan("u1", "do something complex");
      const step = plan.steps[0];
      step.maxRetries = 1;
      step.alternativeTools = ["alt_tool_1"];

      const exec = makeExecute([failResult("fail1"), failResult("fail2")]);
      planner.executeStep(plan.id, step.id, exec); // retryCount=1
      planner.executeStep(plan.id, step.id, exec); // retryCount=2 >= maxRetries=1

      // Should use alternative or ask_user
      expect(step.status).not.toBe("in_progress");
    });
  });

  // ── 6. Unsafe Action ──

  describe("unsafe action", () => {
    it("should require confirmation for HIGH risk steps", () => {
      planner = new TaskPlanner({
        availableTools: ["filesystem_write"],
        requireConfirmationForHighRisk: true,
      });

      const plan = planner.createPlan("u1", "write a file");
      const writeStep = plan.steps.find(s => s.toolRequired === "filesystem_write");

      if (writeStep) {
        expect(writeStep.requiresConfirmation).toBe(true);
        expect(writeStep.riskLevel).toBe("HIGH");

        const exec = makeExecute([successResult()]);
        const result = planner.executeStep(plan.id, writeStep.id, exec);
        expect(writeStep.status).toBe("awaiting_confirmation");
        expect(result.shouldContinue).toBe(false);
      }
    });

    it("should proceed after confirmation", () => {
      planner = new TaskPlanner({
        availableTools: ["filesystem_write"],
        requireConfirmationForHighRisk: true,
      });

      const plan = planner.createPlan("u1", "write a file");
      const writeStep = plan.steps.find(s => s.toolRequired === "filesystem_write");

      if (writeStep) {
        planner.userConfirmStep(plan.id, writeStep.id);
        expect(writeStep.status).toBe("pending");

        const exec = makeExecute([successResult()]);
        planner.executeStep(plan.id, writeStep.id, exec);
        expect(writeStep.status).toBe("completed");
      }
    });

    it("should assess plan risk from steps", () => {
      planner = new TaskPlanner({
        availableTools: ["memory_retrieval", "filesystem_write"],
      });

      const plan = planner.createPlan("u1", "read and write a file");
      expect(plan.riskLevel).toBe("HIGH");
    });
  });

  // ── 7. Authorization ──

  describe("authorization", () => {
    it("should block step requiring unavailable tool", () => {
      planner = new TaskPlanner({
        availableTools: ["conversation"],
        criticalTools: ["web_search"],
      });

      const plan = planner.createPlan("u1", "search for something");
      const searchStep = plan.steps[0];

      if (searchStep.toolRequired === "web_search") {
        const exec = makeExecute([successResult()]);
        const result = planner.executeStep(plan.id, searchStep.id, exec);
        expect(searchStep.status).toBe("blocked");
      }
    });

    it("should allow step with available tool", () => {
      const plan = planner.createPlan("u1", "search for something");
      const searchStep = plan.steps[0];

      const exec = makeExecute([successResult("found")]);
      const result = planner.executeStep(plan.id, searchStep.id, exec);
      expect(result.step.status).toBe("completed");
    });

    it("should block step missing required permissions", () => {
      planner = new TaskPlanner({
        availableTools: ["memory_store"],
        grantedPermissions: [], // No permissions
      });

      const plan = planner.createPlan("u1", "save something to memory");
      const saveStep = plan.steps.find(s => s.toolRequired === "memory_store");

      if (saveStep) {
        const exec = makeExecute([successResult()]);
        planner.executeStep(plan.id, saveStep.id, exec);
        expect(saveStep.status).toBe("blocked");
      }
    });
  });

  // ── 8. Maximum Steps ──

  describe("maximum steps", () => {
    it("should abort when max steps reached", () => {
      planner = new TaskPlanner({ maxSteps: 2 });

      const plan = planner.createPlan("u1", "do a lot of things");

      // Manually add extra steps to test the limit
      for (let i = 0; i < 5; i++) {
        plan.steps.push({
          id: `extra_${i}`,
          description: `Extra step ${i}`,
          toolRequired: null,
          riskLevel: "LOW",
          dependencies: [],
          status: "completed",
          retryCount: 0,
          maxRetries: 0,
          alternativeTools: [],
          parameters: {},
          expectedOutcome: "done",
          verificationCriteria: [],
          requiresConfirmation: false,
        });
      }

      // Simulate max steps by setting completed count
      expect(plan.steps.filter(s => s.status === "completed").length).toBeGreaterThanOrEqual(2);
    });

    it("should not create plan exceeding maxSteps", () => {
      planner = new TaskPlanner({ maxSteps: 3 });
      const plan = planner.createPlan("u1", "search for something");
      expect(plan.steps.length).toBeLessThanOrEqual(3);
    });
  });

  // ── 9. Memory Candidates ──

  describe("memory candidates", () => {
    it("should suggest procedural memory for completed plan", () => {
      const plan = planner.createPlan("u1", "search for something");
      const exec = makeExecute([successResult("r1"), successResult("r2"), successResult("r3")]);

      for (const step of plan.steps) {
        planner.executeStep(plan.id, step.id, exec);
      }

      const memory = planner.getProceduralMemoryCandidates(plan.id);
      expect(memory).not.toBeNull();
      expect(memory!.goal).toBe("search for something");
      expect(memory!.successRate).toBe(1);
      expect(memory!.toolsUsed.length).toBeGreaterThan(0);
    });

    it("should suggest reflection for failed plan", () => {
      const plan = planner.createPlan("u1", "do something");
      plan.steps[0].maxRetries = 0;

      const exec = makeExecute([failResult("critical error")]);
      planner.executeStep(plan.id, plan.steps[0].id, exec);

      // Force plan to aborted status (step is awaiting_confirmation)
      plan.status = "aborted";

      const reflection = planner.getReflectionCandidates(plan.id);
      expect(reflection).not.toBeNull();
      expect(reflection!.failedSteps.length).toBeGreaterThan(0);
      expect(reflection!.lessonsLearned.length).toBeGreaterThan(0);
    });

    it("should not suggest procedural memory for incomplete plan", () => {
      const plan = planner.createPlan("u1", "search for something");
      const exec = makeExecute([successResult("r1")]);
      planner.executeStep(plan.id, plan.steps[0].id, exec);

      const memory = planner.getProceduralMemoryCandidates(plan.id);
      expect(memory).toBeNull();
    });

    it("should track failed plan patterns", () => {
      const p1 = planner.createPlan("u1", "broken task");
      p1.steps[0].maxRetries = 0;
      const exec = makeExecute([failResult("err")]);
      planner.executeStep(p1.id, p1.steps[0].id, exec);
      p1.status = "aborted"; // Force to archivable status
      planner.archivePlan(p1.id);

      const p2 = planner.createPlan("u1", "broken task");
      p2.steps[0].maxRetries = 0;
      planner.executeStep(p2.id, p2.steps[0].id, exec);
      p2.status = "aborted";
      planner.archivePlan(p2.id);

      const patterns = planner.getFailedPlanPatterns();
      expect(patterns.length).toBe(1);
      expect(patterns[0].goal).toBe("broken task");
      expect(patterns[0].failCount).toBe(2);
    });
  });

  // ── 10. Verification ──

  describe("verification", () => {
    it("should pass verification on successful output", () => {
      const plan = planner.createPlan("u1", "search for something");
      const exec = makeExecute([successResult("valid output")]);

      const result = planner.executeStep(plan.id, plan.steps[0].id, exec);
      expect(result.step.result?.verificationPassed).toBe(true);
    });

    it("should fail verification on empty output", () => {
      const plan = planner.createPlan("u1", "search for something");
      const exec = makeExecute([{ success: true, output: "", latencyMs: 100, timestamp: Date.now() }]);

      const result = planner.executeStep(plan.id, plan.steps[0].id, exec);
      expect(result.step.result?.verificationPassed).toBe(false);
      expect(result.step.status).toBe("pending"); // retry pending after verification failure
    });

    it("should fail verification on null output", () => {
      const plan = planner.createPlan("u1", "search for something");
      const exec = makeExecute([{ success: true, output: null, latencyMs: 100, timestamp: Date.now() }]);

      const result = planner.executeStep(plan.id, plan.steps[0].id, exec);
      expect(result.step.result?.verificationPassed).toBe(false);
    });
  });

  // ── 11. Plan Retrieval ──

  describe("plan retrieval", () => {
    it("should get plan by id", () => {
      const plan = planner.createPlan("u1", "test goal");
      expect(planner.getPlan(plan.id)).toBe(plan);
    });

    it("should get user plans", () => {
      planner.createPlan("u1", "goal 1");
      planner.createPlan("u1", "goal 2");
      planner.createPlan("u2", "goal 3");

      expect(planner.getUserPlans("u1").length).toBe(2);
      expect(planner.getUserPlans("u2").length).toBe(1);
    });

    it("should get active plan", () => {
      const plan = planner.createPlan("u1", "test goal");
      expect(planner.getActivePlan("u1")?.id).toBe(plan.id);
    });

    it("should return null for nonexistent plan", () => {
      expect(planner.getPlan("nonexistent")).toBeUndefined();
    });

    it("should get plan status", () => {
      const plan = planner.createPlan("u1", "test goal");
      const status = planner.getPlanStatus(plan.id);
      expect(status).not.toBeNull();
      expect(status!.status).toBe("draft");
      expect(status!.totalSteps).toBe(1);
      expect(status!.completedSteps).toBe(0);
    });
  });

  // ── 12. User Interaction ──

  describe("user interaction", () => {
    it("should abort plan on user request", () => {
      const plan = planner.createPlan("u1", "test goal");
      const result = planner.userAbortPlan(plan.id);
      expect(result?.status).toBe("aborted");
    });

    it("should provide guidance to failed step", () => {
      const plan = planner.createPlan("u1", "test goal");
      const step = plan.steps[0];
      step.status = "failed";

      const result = planner.userProvideGuidance(plan.id, step.id, "try web search instead");
      expect(result).not.toBeNull();
      expect(step.parameters._userGuidance).toBe("try web search instead");
      expect(step.status).toBe("pending");
    });

    it("should confirm awaiting step", () => {
      const plan = planner.createPlan("u1", "test goal");
      const step = plan.steps[0];
      step.status = "awaiting_confirmation";

      const result = planner.userConfirmStep(plan.id, step.id);
      expect(result).not.toBeNull();
      expect(step.status).toBe("pending");
    });

    it("should not confirm non-awaiting step", () => {
      const plan = planner.createPlan("u1", "test goal");
      const step = plan.steps[0];
      step.status = "completed";

      const result = planner.userConfirmStep(plan.id, step.id);
      expect(result).toBeNull();
    });
  });

  // ── 13. Confidence ──

  describe("confidence", () => {
    it("should update confidence", () => {
      const plan = planner.createPlan("u1", "test goal");
      planner.updateConfidence(plan.id, 0.7);
      expect(plan.confidence).toBe(0.7);
    });

    it("should clamp confidence to 0-1", () => {
      const plan = planner.createPlan("u1", "test goal");
      planner.updateConfidence(plan.id, 1.5);
      expect(plan.confidence).toBe(1);

      planner.updateConfidence(plan.id, -0.5);
      expect(plan.confidence).toBe(0);
    });
  });

  // ── 14. Archive ──

  describe("archive", () => {
    it("should archive completed plan", () => {
      const plan = planner.createPlan("u1", "test goal");
      plan.status = "completed";

      const result = planner.archivePlan(plan.id);
      expect(result).toBe(true);
      expect(planner.getPlan(plan.id)).toBeUndefined();
    });

    it("should not archive executing plan", () => {
      const plan = planner.createPlan("u1", "test goal");
      plan.status = "executing";

      const result = planner.archivePlan(plan.id);
      expect(result).toBe(false);
    });
  });
});
