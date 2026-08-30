import { describe, it, expect, vi } from "vitest";
import { CognitiveRouter, type ToolExecutor } from "../router/cognitiveRouter";
import { HierarchicalPlanner } from "../planner/planner";
import { InMemoryPlanStore } from "../planner/planPersistence";
import { PlanExecutionEngine } from "./planExecutor";
import { InMemoryExecutionStore } from "./persistence";

const CATALOG = [
  "openApp", "closeApp", "focusApp", "openUrl", "takeScreenshot",
  "getSystemInfo", "getVolume", "setVolume", "clipboardRead", "clipboardWrite",
  "readFile", "createFile", "writeFile", "createFolder", "renameFile",
];

/**
 * Replicates the server-side wiring exactly: planner -> authorization ->
 * execution engine inside the tier3 seam.
 */
function buildWiredRouter(execCalls: Array<{ tool: string; userId: string }>) {
  const planStore = new InMemoryPlanStore();
  const execStore = new InMemoryExecutionStore();
  const planner = new HierarchicalPlanner({
    store: planStore,
    toolCatalog: () => CATALOG,
  });
  const engine = new PlanExecutionEngine({
    store: execStore,
    planStore,
    toolCatalog: () => CATALOG,
    runner: (async (userId, toolName) => {
      execCalls.push({ tool: toolName, userId });
      return { ok: true, result: { ok: true, tool: toolName } };
    }) as never,
  });

  const router = new CognitiveRouter({
    executeTool: (async () => ({ ok: true })) as ToolExecutor,
    planner: {
      shouldPlan: (input) => planner.shouldPlan(input),
      createPlan: async (userId, request) => {
        const out = await planner.createPlan(userId, request);
        if (!out.ok || !out.plan || out.plan.status !== "ready") {
          return {
            ok: out.ok,
            reason: out.reason,
            needsClarification: out.needsClarification,
            rejected: out.rejected,
            modelCallsUsed: out.modelCallsUsed,
          };
        }
        const execOutcome = await engine.executePlan(out.plan, {
          userId,
          requestId: `route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          confirmed: false,
        });
        return {
          ok: true,
          plan: {
            id: out.plan.id,
            title: out.plan.title,
            status: execOutcome.planStatus ?? out.plan.status,
            confidence: out.plan.confidence,
          },
          summary: `PLANNED: ${out.plan.title}\n${execOutcome.summary}`,
          reason: execOutcome.authorization === "REQUIRES_CONFIRMATION" ? "confirmation required" : undefined,
          needsClarification: false,
          rejected: false,
          modelCallsUsed: out.modelCallsUsed,
        };
      },
    },
  });

  return { router, planStore, execStore };
}

describe("Phase 29 mandatory end-to-end (Section 23)", () => {
  it('"Open Chrome": tier0 fast path intact - no planner, no plan, one direct tool', async () => {
    const directToolCalls: Array<{ tool: string; userId: string }> = [];
    const createPlan = vi.fn();
    const planner = new HierarchicalPlanner({ store: new InMemoryPlanStore(), toolCatalog: () => CATALOG });
    const shouldPlanSpy = vi.fn((input: string) => planner.shouldPlan(input));

    const tier0Exec: ToolExecutor = async (userId, toolName) => {
      directToolCalls.push({ tool: toolName, userId });
      return { ok: true };
    };
    const router = new CognitiveRouter({
      executeTool: tier0Exec,
      planner: { shouldPlan: shouldPlanSpy, createPlan: createPlan as never },
    });

    const out = await router.route("userA", "Open Chrome");
    expect(out.tier).toBe("tier0_direct");
    expect(out.plannerCalled ?? false).toBe(false);
    expect(createPlan).not.toHaveBeenCalled();
    expect(out.modelCalls).toBe(0);
    expect(directToolCalls).toHaveLength(1);
    expect(directToolCalls[0].tool).toBe("openApp");
    expect(out.success).toBe(true); // actual tool result determined it
  });

  it('"Finish setting up LOHZ authentication": tier3 -> planned -> authorized -> observed, NO fake completion', async () => {
    const generate = vi.fn(async () => ({
      text: JSON.stringify({
        title: "Set up LOHZ authentication",
        failurePolicy: "ask_user",
        confidence: 0.85,
        steps: [
          { id: "s1", title: "Verify service account file exists", intent: "verify", requiredTool: null, expectedOutcome: "presence known", riskLevel: "safe", confidence: 0.9, dependsOn: [] },
          { id: "s2", title: "Validate Firestore rules compile", intent: "verify", requiredTool: null, expectedOutcome: "rules validated", riskLevel: "low", confidence: 0.8, dependsOn: ["s1"] },
        ],
      }),
    }));

    const execCalls: Array<{ tool: string; userId: string }> = [];
    // Model-assisted plan requires a gateway on the PLANNER:
    const planStore = new InMemoryPlanStore();
    const planner = new HierarchicalPlanner({
      store: planStore,
      toolCatalog: () => CATALOG,
      gateway: { generate },
    });
    const execStore = new InMemoryExecutionStore();
    const engine = new PlanExecutionEngine({
      store: execStore,
      planStore,
      toolCatalog: () => CATALOG,
      runner: (async (userId, toolName) => {
        execCalls.push({ tool: toolName, userId });
        return { ok: true };
      }) as never,
    });

    const router = new CognitiveRouter({
      executeTool: (async () => ({ ok: true })) as ToolExecutor,
      planner: {
        shouldPlan: (input) => planner.shouldPlan(input),
        createPlan: async (userId, request) => {
          const out = await planner.createPlan(userId, request);
          if (!out.ok || !out.plan || out.plan.status !== "ready") {
            return { ok: out.ok, reason: out.reason, needsClarification: out.needsClarification, rejected: out.rejected, modelCallsUsed: out.modelCallsUsed };
          }
          const execOutcome = await engine.executePlan(out.plan, {
            userId,
            requestId: `route-${Math.random().toString(36).slice(2)}`,
            confirmed: false,
          });
          return {
            ok: true,
            plan: { id: out.plan.id, title: out.plan.title, status: execOutcome.planStatus ?? out.plan.status, confidence: out.plan.confidence },
            summary: `PLANNED: ${out.plan.title}\n${execOutcome.summary}`,
            reason: execOutcome.authorization === "REQUIRES_CONFIRMATION" ? execOutcome.summary.slice(0, 200) : undefined,
            needsClarification: false,
            rejected: false,
            modelCallsUsed: out.modelCallsUsed,
          };
        },
      },
    });

    const out = await router.route("userA", "Finish setting up LOHZ authentication");
    expect(out.tier).toBe("tier3_autonomous");
    expect(out.plannerCalled).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1); // bounded budget
    expect(execCalls).toHaveLength(0); // manual/verify steps have no tools

    // Execution was AUTHORIZED but produced partial_manual - NOT completed:
    expect(out.response).toContain("PLANNED");
    expect(out.response).toContain("manual");
    expect(out.response.toLowerCase()).not.toContain("-> completed");

    // Plan persisted with honest non-completed status:
    const plans = await planStore.listPlans("userA");
    expect(plans).toHaveLength(1);
    expect(plans[0].status === "paused" || plans[0].status === "ready").toBe(true);
    expect(plans[0].status === "completed").toBe(false);
    expect(plans[0].steps.every((s) => s.status !== "completed")).toBe(true);

    // Execution record exists with truthful state:
    const records = await execStore.listExecutions("userA");
    expect(records).toHaveLength(1);
    expect(records[0].authorization).toBe("AUTHORIZED");
    expect(records[0].status).toBe("partial_manual");
  });

  it("medium/high-risk tier3 plan returns REQUIRES_CONFIRMATION and executes nothing", async () => {
    const execCalls: Array<{ tool: string; userId: string }> = [];
    const planStore = new InMemoryPlanStore();
    const planner = new HierarchicalPlanner({ store: planStore, toolCatalog: () => CATALOG });
    const execStore = new InMemoryExecutionStore();
    const engine = new PlanExecutionEngine({
      store: execStore,
      planStore,
      toolCatalog: () => CATALOG,
      runner: (async (userId, toolName) => {
        execCalls.push({ tool: toolName, userId });
        return { ok: true };
      }) as never,
    });

    // Craft a ready medium-risk plan directly in the store:
    const riskyPlan = {
      id: "plan-risky", userId: "userB", title: "Write config", objective: "write config",
      kind: "single_step" as const, status: "ready" as const, confidence: 0.9,
      createdAt: Date.now(), updatedAt: Date.now(),
      steps: [{
        id: "s1", index: 0, title: "write file", description: "", intent: "tool_step",
        status: "draft" as const, dependencies: [], requiredTool: "writeFile",
        arguments: { path: "/w/cfg.json", content: "{}" }, expectedOutcome: "config written",
        riskLevel: "medium" as const, confidence: 0.9, retryPolicy: { maxRetries: 1 }, timeoutMs: 30000,
      }],
      constraints: [], expectedOutcome: "done", failurePolicy: "ask_user" as const,
      autonomyLevel: 1, version: 1, generatedBy: "deterministic" as const, modelCallsUsed: 0,
    };
    await planStore.savePlan("userB", riskyPlan as never);

    const outcome = await engine.executePlan(riskyPlan as never, {
      userId: "userB",
      requestId: `rq-${Math.random().toString(36).slice(2)}`,
      confirmed: false,
    });
    expect(outcome.authorization).toBe("REQUIRES_CONFIRMATION");
    expect(execCalls).toHaveLength(0);
    expect(outcome.recordStatus).toBe("awaiting_confirmation");

    // With explicit confirmation the same plan executes:
    const after = await engine.executePlan(riskyPlan as never, {
      userId: "userB",
      requestId: `rq-confirm-${Math.random().toString(36).slice(2)}`,
      confirmed: true,
    });
    expect(after.authorization).toBe("AUTHORIZED");
    expect(after.recordStatus).toBe("completed");
    expect(execCalls).toHaveLength(1);
  });
});
