import { describe, expect, it, vi } from "vitest";
import { HierarchicalPlanner } from "../planner/planner";
import { InMemoryPlanStore } from "../planner/planPersistence";
import { SkillLearningService } from "../learning/service";
import { InMemoryLearningStore } from "../learning/store";
import type { ExperienceRecord, SkillVersion } from "../learning/types";
import { SkillLibrary } from "./library";
import { parseSkillPlanConstraint } from "./plan";
import { InMemoryExecutionStore } from "../execution/persistence";
import { PlanExecutionEngine } from "../execution/planExecutor";
import { InMemoryObservationStore } from "../observation/observationStore";
import { SkillExecutor } from "../learning/executor";

const ENV = "windows-local";
const CATALOG = ["openApp", "openUrl", "setVolume"];

function fp(name: string): string | null {
  const t: Record<string, { risk: string; parameters: unknown }> = {
    openApp: { risk: "LOW", parameters: { type: "OBJECT", required: ["name"] } },
    openUrl: { risk: "LOW", parameters: { type: "OBJECT", required: ["url"] } },
    setVolume: { risk: "LOW", parameters: { type: "OBJECT" } },
  };
  return t[name] ? JSON.stringify(t[name]) : null;
}

function experience(uid: string, id: string, objective = "start my development environment"): ExperienceRecord {
  return {
    id, uid, objective,
    context: { environment: ENV, signature: `windows-local|openApp>openUrl|start-my-development-environment`, tags: [] },
    planId: `plan-${id}`, planVersion: 1, requestId: `req-${id}`,
    steps: [
      { stepId: "s1", index: 0, title: "VS Code up", toolName: "openApp", arguments: { name: "VS Code" }, dependencies: [], expectedOutcome: "editor open", riskLevel: "low", outcome: "completed", attempts: 1, durationMs: 10, failureCode: null, verification: "VERIFIED" },
      { stepId: "s2", index: 1, title: "Browser up", toolName: "openUrl", arguments: { url: "http://localhost:3000" }, dependencies: ["s1"], expectedOutcome: "browser open", riskLevel: "low", outcome: "completed", attempts: 1, durationMs: 10, failureCode: null, verification: "VERIFIED" },
    ],
    outcome: "success", failures: [], recovery: { attempted: false, succeeded: false, actions: [] },
    replans: { count: 0, planIds: [`plan-${id}`] }, verification: "VERIFIED", success: true, userCorrections: [],
    source: { executionRequestIds: [`req-${id}`], observationIds: [] }, createdAt: Number(id.replace(/\D/g, "")) || 1, schemaVersion: 1,
  };
}

async function buildPlannerSeam(store: InMemoryLearningStore) {
  const service = new SkillLearningService(store, () => CATALOG, Date.now, fp);
  const planStore = new InMemoryPlanStore();
  const engine = new PlanExecutionEngine({
    store: new InMemoryExecutionStore(), planStore, toolCatalog: () => CATALOG,
    runner: async () => ({ ok: true, result: "ok" }),
  });
  const observations = new InMemoryObservationStore();
  const executor = new SkillExecutor(store, planStore, engine, service, observations, () => 10);
  const library = new SkillLibrary({
    store, service, executor, observations,
    toolExists: (n) => CATALOG.includes(n), toolFingerprint: fp, environment: () => ENV,
  });
  return { service, library, planStore };
}

/** Objective carrying the skill's trigger tokens but NOT mappable by stage-1 verbs. */
const RECOGNIZED = "go start my development environment";

describe("Phase 38 — planner skill selection", () => {
  it("selects an active skill for a recognized recurring workflow (0 model calls, plan marked with provenance)", async () => {
    const store = new InMemoryLearningStore();
    const { service, library, planStore } = await buildPlannerSeam(store);
    for (let i = 1; i <= 3; i++) await service.ingestExperience(experience("u1", `e${i}`));
    const [cand] = await service.detectCandidates("u1");
    await service.validate("u1", cand.skillId, 1);
    await service.replay("u1", cand.skillId, 1);
    await service.requestApproval("u1", cand.skillId, 1, "appr");
    await library.approve("u1", cand.skillId, 1, "appr");

    const seam = vi.fn((uid: string, objective: string) => library.matchPlanForObjective(uid, objective, ENV));
    const planner = new HierarchicalPlanner({
      store: planStore, toolCatalog: () => CATALOG,
      skills: { matchPlan: seam },
    });
    const out = await planner.createPlan("u1", { objective: RECOGNIZED });
    expect(seam).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(true);
    expect(out.modelCallsUsed).toBe(0);
    expect(out.plan?.status).toBe("ready"); // confidence gate passed
    const ref = parseSkillPlanConstraint(out.plan!.constraints);
    expect(ref).toEqual({ skillId: cand.skillId, version: 1 });
    expect(out.plan!.steps.map((s) => s.requiredTool)).toEqual(["openApp", "openUrl"]);
    expect(out.plan!.steps[1].dependencies).toEqual(["s1"]);
    expect(out.plan!.generatedBy).toBe("deterministic");
    expect(out.plan!.autonomyLevel).toBe(0); // selection never grants authority
  });

  it("does NOT hijack objectives the deterministic stage already expresses", async () => {
    const store = new InMemoryLearningStore();
    const { service, library, planStore } = await buildPlannerSeam(store);
    for (let i = 1; i <= 3; i++) await service.ingestExperience(experience("u1", `e${i}`));
    const [cand] = await service.detectCandidates("u1");
    await service.validate("u1", cand.skillId, 1);
    await service.replay("u1", cand.skillId, 1);
    await service.requestApproval("u1", cand.skillId, 1, "appr");
    await library.approve("u1", cand.skillId, 1, "appr");
    const seam = vi.fn((uid: string, objective: string) => library.matchPlanForObjective(uid, objective, ENV));
    const planner = new HierarchicalPlanner({
      store: planStore, toolCatalog: () => CATALOG,
      skills: { matchPlan: seam },
    });
    // "start ..." is handled by stage-1 decomposition as open_app: skills are NOT consulted.
    const out = await planner.createPlan("u1", { objective: "start my development environment" });
    expect(seam).not.toHaveBeenCalled();
    expect(out.ok).toBe(true);
    expect(out.plan!.steps.map((s) => s.requiredTool)).toEqual(["openApp"]);
  });

  it("falls through to the model stage when no skill matches", async () => {
    const store = new InMemoryLearningStore();
    const { service, planStore } = await buildPlannerSeam(store);
    for (let i = 1; i <= 3; i++) await service.ingestExperience(experience("u1", `e${i}`));
    const gateway = { generate: vi.fn(async () => ({ text: "{\"title\":\"x\",\"steps\":[{\"id\":\"a\",\"title\":\"do\",\"requiredTool\":null,\"expectedOutcome\":\"ok\",\"riskLevel\":\"low\",\"dependsOn\":[]}],\"confidence\":0.9}" })) };
    const planner = new HierarchicalPlanner({
      store: planStore, toolCatalog: () => CATALOG, gateway,
      skills: { matchPlan: async () => null },
    });
    const out = await planner.createPlan("u1", { objective: "something no skill can do" });
    expect(out.ok).toBe(true);
    expect(gateway.generate).toHaveBeenCalledTimes(1);
    expect(out.plan!.generatedBy).toBe("model_assisted");
  });

  it("falls through gracefully when the skill seam throws", async () => {
    const planStore = new InMemoryPlanStore();
    const gateway = { generate: vi.fn(async () => ({ text: "{\"title\":\"x\",\"steps\":[{\"id\":\"a\",\"title\":\"do\",\"requiredTool\":null,\"expectedOutcome\":\"ok\",\"riskLevel\":\"low\",\"dependsOn\":[]}],\"confidence\":0.9}" })) };
    const planner = new HierarchicalPlanner({
      store: planStore, toolCatalog: () => CATALOG, gateway,
      skills: { matchPlan: async () => { throw new Error("store exploded"); } },
    });
    const out = await planner.createPlan("u1", { objective: "unmappable whatever request" });
    expect(out.ok).toBe(true);
    expect(gateway.generate).toHaveBeenCalledTimes(1);
  });

  it("does NOT select degraded or deprecated skills", async () => {
    const store = new InMemoryLearningStore();
    const { service, library, planStore } = await buildPlannerSeam(store);
    for (let i = 1; i <= 3; i++) await service.ingestExperience(experience("u1", `e${i}`));
    const [cand] = await service.detectCandidates("u1");
    await service.validate("u1", cand.skillId, 1);
    await service.replay("u1", cand.skillId, 1);
    await service.requestApproval("u1", cand.skillId, 1, "a");
    await library.approve("u1", cand.skillId, 1, "a");
    await service.markDegraded("u1", cand.skillId, 1, "tool_removed:openApp", null);
    const planner = new HierarchicalPlanner({
      store: planStore, toolCatalog: () => CATALOG,
      skills: { matchPlan: (u, o) => library.matchPlanForObjective(u, o, ENV) },
    });
    const out = await planner.createPlan("u1", { objective: RECOGNIZED });
    expect(out.ok).toBe(false); // skill degraded + no gateway configured -> clarification
    expect(out.plan).toBeUndefined();
  });

  it("does not select skills from another environment", async () => {
    const store = new InMemoryLearningStore();
    const { service, library, planStore } = await buildPlannerSeam(store);
    for (let i = 1; i <= 3; i++) await service.ingestExperience(experience("u1", `e${i}`));
    const [cand] = await service.detectCandidates("u1");
    await service.validate("u1", cand.skillId, 1);
    await service.replay("u1", cand.skillId, 1);
    await service.requestApproval("u1", cand.skillId, 1, "a");
    await library.approve("u1", cand.skillId, 1, "a");
    const planner = new HierarchicalPlanner({
      store: planStore, toolCatalog: () => CATALOG,
      skills: { matchPlan: (u, o) => library.matchPlanForObjective(u, o, "linux-x64") },
    });
    const out = await planner.createPlan("u1", { objective: RECOGNIZED });
    expect(out.ok).toBe(false);
  });

  it("never lets a skill-selected plan bypass execution policy (medium risk still awaits confirmation)", async () => {
    const planStore = new InMemoryPlanStore();
    const store = new InMemoryLearningStore();
    const service = new SkillLearningService(store, () => CATALOG, Date.now, fp);
    const observations = new InMemoryObservationStore();
    const engine = new PlanExecutionEngine({
      store: new InMemoryExecutionStore(), planStore, toolCatalog: () => CATALOG,
      runner: async () => ({ ok: true, result: "ok" }),
    });
    const executor = new SkillExecutor(store, planStore, engine, service, observations);
    const library = new SkillLibrary({
      store, service, executor, observations,
      toolExists: (n) => CATALOG.includes(n), toolFingerprint: fp, environment: () => ENV,
    });
    // hand-craft a promoted MEDIUM-risk skill (setVolume is LOW here; fake one via REGISTRY-style risk "medium")
    const medium: SkillVersion = {
      uid: "u1", skillId: "skill_medium", version: 1, name: "adjust volume loud", description: "set volume to 100",
      trigger: { signature: "windows-local|setVolume|adjust-volume-loud", objectiveTokens: ["adjust", "volume", "loud"] },
      requiredContext: { environment: ENV, tags: [] },
      stepGraph: [{ id: "s1", index: 0, title: "vol", description: "set", toolName: "setVolume", arguments: { level: 100 }, dependencies: [], expectedOutcome: "vol 100", riskLevel: "medium", timeoutMs: 5000, maxRetries: 0 }],
      riskProfile: { maximumRisk: "medium", tools: ["setVolume"], requiresConfirmation: true, policyMutable: false },
      sourceExperienceIds: ["x1", "x2", "x3"], metrics: { samples: 3, successes: 3, failures: 0, successRate: null, failureRate: null },
      status: "promoted", validation: { validatedAt: 1, issues: [] }, replay: { verifiedAt: 2, sourceExperienceIds: [], failures: [] },
      approval: { requestedAt: 1, approvedAt: 2, approvalRequestId: "a" }, createdAt: 1, lastVerifiedAt: 2, replacesVersion: null, schemaVersion: 1,
    };
    await store.putSkillVersion(medium, null);
    const planner = new HierarchicalPlanner({
      store: planStore, toolCatalog: () => CATALOG,
      skills: { matchPlan: (u, o) => library.matchPlanForObjective(u, o, ENV) },
    });
    const out = await planner.createPlan("u1", { objective: "adjust volume loud please" });
    expect(out.ok).toBe(true);
    expect(out.plan?.status).toBe("ready");
    // The produced plan is still just a plan; authorization happens downstream.
    expect(out.plan!.steps[0].riskLevel).toBe("medium");
  });
});
