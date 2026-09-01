import { describe, expect, it, vi } from "vitest";
import { InMemoryExecutionStore } from "../execution/persistence";
import { PlanExecutionEngine } from "../execution/planExecutor";
import { InMemoryObservationStore } from "../observation/observationStore";
import { ObservationCoordinator } from "../observation/observer";
import { InMemoryPlanStore } from "../planner/planPersistence";
import { SkillExecutor } from "./executor";
import { SkillLearningService } from "./service";
import { InMemoryLearningStore } from "./store";
import type { SkillVersion } from "./types";

function promoted(uid = "u1", risk: "safe" | "medium" = "safe"): SkillVersion {
  return {
    uid, skillId: "skill_open", version: 1, name: "Open dashboard", description: "Open the dashboard",
    trigger: { signature: "windows-local|openApp|open-dashboard", objectiveTokens: ["open", "dashboard"] },
    requiredContext: { environment: "windows-local", tags: [] },
    stepGraph: [{ id: "s1", index: 0, title: "Open", description: "Open dashboard", toolName: "openApp", arguments: { name: "Dashboard" }, dependencies: [], expectedOutcome: "Dashboard open", riskLevel: risk, timeoutMs: 1_000, maxRetries: 0 }],
    riskProfile: { maximumRisk: risk, tools: ["openApp"], requiresConfirmation: true, policyMutable: false },
    sourceExperienceIds: ["e1", "e2", "e3"], metrics: { samples: 3, successes: 3, failures: 0, successRate: null, failureRate: null },
    status: "promoted", validation: { validatedAt: 1, issues: [] }, replay: { verifiedAt: 2, sourceExperienceIds: ["e1", "e2", "e3"], failures: [] },
    approval: { requestedAt: 3, approvedAt: 4, approvalRequestId: "approve" }, createdAt: 1, lastVerifiedAt: 2, replacesVersion: null, schemaVersion: 1,
  };
}

function setup(skill: SkillVersion) {
  const learningStore = new InMemoryLearningStore(); const planStore = new InMemoryPlanStore();
  const executionStore = new InMemoryExecutionStore(); const observationStore = new InMemoryObservationStore();
  const runner = vi.fn(async (_uid: string, tool: string) => tool === "listWindows" ? { ok: true, result: ["Dashboard"] } : { ok: true, result: "launched" });
  const observer = new ObservationCoordinator({ store: observationStore, probeRunner: runner, sleep: async () => undefined });
  const engine = new PlanExecutionEngine({
    store: executionStore, planStore, toolCatalog: () => ["openApp", "listWindows"], runner,
    observation: { executeVerifiedStep: (uid, planId, requestId, step, executor) => observer.executeVerifiedStep(uid, planId, requestId, step, executor) },
  });
  const learning = new SkillLearningService(learningStore, () => ["openApp", "listWindows"]);
  const executor = new SkillExecutor(learningStore, planStore, engine, learning, observationStore, () => 10);
  return { learningStore, planStore, observationStore, runner, executor };
}

describe("Phase 36 skill execution security", () => {
  it("executes promoted skill data only through normal plan policy and observation", async () => {
    const skill = promoted(); const ctx = setup(skill); await ctx.learningStore.putSkillVersion(skill, null);
    const result = await ctx.executor.execute({ authenticatedUserId: "u1", skillId: skill.skillId, version: 1, environment: "windows-local", requestId: "run1", confirmed: true });
    expect(result.outcome?.recordStatus).toBe("completed");
    expect(result.outcome?.authorization).toBe("AUTHORIZED");
    expect((await ctx.observationStore.listForRequest("u1", "run1"))[0].status).toBe("verified");
    expect((await ctx.learningStore.getSkillReliability("u1", skill.skillId, 1, "windows-local"))?.verifiedSuccesses).toBe(1);
  });

  it("never lets promotion bypass confirmation", async () => {
    const skill = promoted("u1", "medium"); const ctx = setup(skill); await ctx.learningStore.putSkillVersion(skill, null);
    const result = await ctx.executor.execute({ authenticatedUserId: "u1", skillId: skill.skillId, version: 1, environment: "windows-local", requestId: "run2", confirmed: false });
    expect(result.outcome?.authorization).toBe("REQUIRES_CONFIRMATION");
    expect(ctx.runner).not.toHaveBeenCalled();
  });

  it("cannot execute another user's skill or an unpromoted version", async () => {
    const skill = promoted("u1"); const ctx = setup(skill); await ctx.learningStore.putSkillVersion(skill, null);
    expect((await ctx.executor.execute({ authenticatedUserId: "u2", skillId: skill.skillId, version: 1, environment: "windows-local" })).error).toBe("promoted_skill_not_found");
    await ctx.learningStore.transitionSkillStatus("u1", skill.skillId, 1, "promoted", "unreliable");
    expect((await ctx.executor.execute({ authenticatedUserId: "u1", skillId: skill.skillId, version: 1, environment: "windows-local" })).error).toBe("promoted_skill_not_found");
  });
});

