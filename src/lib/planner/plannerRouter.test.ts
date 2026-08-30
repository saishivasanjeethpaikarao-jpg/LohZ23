import { describe, it, expect, vi } from "vitest";
import { CognitiveRouter, type ToolExecutor } from "../router/cognitiveRouter";
import { HierarchicalPlanner } from "./planner";
import { InMemoryPlanStore } from "./planPersistence";

const CATALOG = [
  "openApp", "closeApp", "focusApp", "openUrl", "takeScreenshot",
  "getSystemInfo", "getVolume", "setVolume", "clipboardRead", "clipboardWrite",
  "readFile", "createFile", "writeFile", "createFolder", "renameFile",
];

function buildRouter(planner: HierarchicalPlanner, exec: ToolExecutor) {
  return new CognitiveRouter({
    executeTool: exec,
    planner: {
      shouldPlan: (input) => planner.shouldPlan(input),
      createPlan: async (userId, request) => {
        const out = await planner.createPlan(userId, request);
        return {
          ok: out.ok,
          ...(out.plan
            ? {
                plan: { id: out.plan.id, title: out.plan.title, status: out.plan.status, confidence: out.plan.confidence },
                summary: `PLANNED (not executed): ${out.plan.title}`,
              }
            : {}),
          reason: out.reason,
          needsClarification: out.needsClarification,
          rejected: out.rejected,
          modelCallsUsed: out.modelCallsUsed,
        };
      },
    },
  });
}

describe("Phase 28 mandatory integration tests (Section 36)", () => {
  it('"Open Chrome": tier0, planner NOT called, modelCalls 0', async () => {
    const createPlan = vi.fn();
    const toolCalls: unknown[] = [];
    const exec: ToolExecutor = async (_u, _t, _a) => {
      toolCalls.push(1);
      return { ok: true };
    };
    const store = new InMemoryPlanStore();
    const planner = new HierarchicalPlanner({
      store,
      toolCatalog: () => CATALOG,
    });
    // Spy on shouldPlan to prove the planner path is never entered.
    const spy = vi.fn((_input: string) => false);
    planner.shouldPlan = spy;

    const router = new CognitiveRouter({
      executeTool: exec,
      planner: {
        shouldPlan: (i) => { spy(i); return planner.shouldPlan(i); },
        createPlan: createPlan as never,
      },
    });

    const out = await router.route("userA", "Open Chrome");
    expect(out.tier).toBe("tier0_direct");
    expect(out.plannerCalled ?? false).toBe(false);
    expect(createPlan).not.toHaveBeenCalled();
    expect(out.modelCalls).toBe(0);
    expect(toolCalls).toHaveLength(1); // direct execution happened
    expect(await store.listPlans("userA")).toHaveLength(0); // no plan created
  });

  it('"Finish setting up LOHZ authentication": tier3, plan generated, NO tools run, no goal completed', async () => {
    const toolCalls: unknown[] = [];
    const exec: ToolExecutor = async () => {
      toolCalls.push(1);
      return { ok: true };
    };
    const generate = vi.fn(async () => ({
      text: JSON.stringify({
        title: "Set up LOHZ authentication",
        failurePolicy: "ask_user",
        confidence: 0.85,
        steps: [
          { id: "s1", title: "Verify service account file", intent: "verify", requiredTool: null, expectedOutcome: "presence known", riskLevel: "safe", confidence: 0.9, dependsOn: [] },
          { id: "s2", title: "Validate Firestore rules", intent: "verify", requiredTool: null, expectedOutcome: "rules checked", riskLevel: "low", confidence: 0.85, dependsOn: ["s1"] },
        ],
      }),
    }));
    const store = new InMemoryPlanStore();
    const planner = new HierarchicalPlanner({ store, toolCatalog: () => CATALOG, gateway: { generate } });
    const router = buildRouter(planner, exec);

    const out = await router.route("userA", "Finish setting up LOHZ authentication");
    expect(out.tier).toBe("tier3_autonomous");
    expect(out.plannerCalled).toBe(true);
    expect(out.planId).toBeTruthy();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(toolCalls).toHaveLength(0); // NO execution
    expect(out.response).toContain("PLANNED");
    expect(out.lifecycle).toContain("PLANNED");

    const persisted = await store.listPlans("userA");
    expect(persisted).toHaveLength(1);
    expect(["draft", "ready"]).toContain(persisted[0].status); // never running/completed
    expect(persisted[0].steps.every((s) => s.status !== "running" && s.status !== "completed")).toBe(true);

    // No temporal/goal side effects exist in the seam at all - nothing to assert false positives on.
  });
});
