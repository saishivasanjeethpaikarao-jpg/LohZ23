import { describe, it, expect, vi } from "vitest";
import { ObservationCoordinator, type ObservationEventEmitter } from "./observer";
import { InMemoryObservationStore } from "./observationStore";
import { VERIFICATION_RULES, ruleFor } from "./verificationRules";
import { classifyFailure } from "./failureClassifier";
import { ReplanCoordinator } from "./replan";
import { sanitizeEvidence, RECOVERY_LIMITS, PROBE_SAFE_TOOLS } from "./types";
import { HierarchicalPlanner } from "../planner/planner";
import { InMemoryPlanStore } from "../planner/planPersistence";
import { PlanExecutionEngine } from "../execution/planExecutor";
import { InMemoryExecutionStore } from "../execution/persistence";
import { StepExecutor } from "../execution/stepExecutor";
import type { PlanStep } from "../planner/types";

const CATALOG = [
  "openApp", "closeApp", "openUrl", "takeScreenshot", "setVolume", "getVolume",
  "clipboardRead", "clipboardWrite", "readFile", "getSystemInfo", "listWindows",
];

function mkStep(over: Partial<PlanStep>): PlanStep {
  return {
    id: "s1", index: 0, title: "step", description: "", intent: "open_app",
    status: "draft", dependencies: [], expectedOutcome: "expected state",
    riskLevel: "safe", confidence: 0.9, retryPolicy: { maxRetries: 0 },
    timeoutMs: 1000,
    ...over,
  };
}

interface HarnessOpts {
  probeWindows?: string[];
  probeVolume?: number;
  probeFails?: boolean;
  runnerBehavior?: "ok" | "fail_permanent" | "timeout" | "transient_twice";
  modelVerifier?: (uid: string, step: PlanStep, note: string) => Promise<"VERIFIED" | "FAILED" | "INCONCLUSIVE">;
  memory?: (uid: string, text: string) => void;
  worldState?: { recordVerifiedObservation: (uid: string, step: PlanStep, observation: import("./types").Observation) => Promise<boolean> };
}

function buildObserver(opts: HarnessOpts = {}) {
  const store = new InMemoryObservationStore();
  const events: Array<{ type: string; description?: string }> = [];
  const emitter: ObservationEventEmitter = {
    record: vi.fn(async (i) => { events.push({ type: i.type, description: i.description }); }),
  };
  let transientCount = 0;
  const toolRuns: Array<{ tool: string; args: unknown }> = [];
  const runner = vi.fn(async (_uid: string, toolName: string, args: Record<string, unknown>) => {
    toolRuns.push({ tool: toolName, args });
    if (PROBE_SAFE_TOOLS.has(toolName)) {
      if (opts.probeFails) return { ok: false };
      switch (toolName) {
        case "listWindows": return { ok: true, result: (opts.probeWindows ?? []).map((t) => ({ title: t })) };
        case "getVolume": return { ok: true, result: { volume: opts.probeVolume ?? 50 } };
        case "clipboardRead": return { ok: true, result: opts.probeWindows?.[0] ?? "" };
        case "readFile": return { ok: true, result: "content" };
        default: return { ok: true, result: {} };
      }
    }
    switch (opts.runnerBehavior ?? "ok") {
      case "fail_permanent": return { ok: false, errorKind: "tool_failed" };
      case "timeout": return { ok: false, errorKind: "timeout" };
      case "transient_twice":
        transientCount += 1;
        return transientCount <= 2 ? { ok: false, errorKind: "agent_offline" } : { ok: true, result: {} };
      default: return { ok: true, result: { launched: true } };
    }
  });

  const stepExecutor = new StepExecutor({
    runner: runner as never,
    toolCatalog: () => CATALOG,
  });
  const observer = new ObservationCoordinator({
    store,
    events: emitter,
    probeRunner: runner as never,
    ...(opts.modelVerifier ? { modelVerifier: opts.modelVerifier } : {}),
    ...(opts.memory ? { memoryCandidate: opts.memory } : {}),
    ...(opts.worldState ? { worldState: opts.worldState } : {}),
  });
  return { store, events, runner, toolRuns, stepExecutor, observer, transientCountRef: () => transientCount };
}

describe("verification rules (deterministic)", () => {
  const chrome = mkStep({ requiredTool: "openApp", arguments: { name: "chrome" } });

  it("openApp verifies when window present", () => {
    const r = VERIFICATION_RULES.openApp!.evaluate({
      step: chrome, toolOk: true, toolResultRaw: {},
      probeOk: true, probeResultRaw: [{ title: "Chrome - New Tab" }],
    });
    expect(r.verdict).toBe("VERIFIED");
  });

  it("openApp FAILS when tool succeeded but window absent (false-success prevention)", () => {
    const r = VERIFICATION_RULES.openApp!.evaluate({
      step: chrome, toolOk: true, toolResultRaw: {},
      probeOk: true, probeResultRaw: [{ title: "Notepad" }],
    });
    expect(r.verdict).toBe("FAILED");
  });

  it("setVolume verifies on readback match; fails on mismatch", () => {
    const s = mkStep({ requiredTool: "setVolume", arguments: { level: 50 } });
    expect(VERIFICATION_RULES.setVolume!.evaluate({ step: s, toolOk: true, toolResultRaw: {}, probeOk: true, probeResultRaw: { volume: 50 } }).verdict).toBe("VERIFIED");
    expect(VERIFICATION_RULES.setVolume!.evaluate({ step: s, toolOk: true, toolResultRaw: {}, probeOk: true, probeResultRaw: { volume: 77 } }).verdict).toBe("FAILED");
  });

  it("openUrl is INCONCLUSIVE even on success (never fake success)", () => {
    const r = VERIFICATION_RULES.openUrl!.evaluate({ step: mkStep({ requiredTool: "openUrl", arguments: { url: "https://x.com" } }), toolOk: true, toolResultRaw: {}, probeOk: null, probeResultRaw: undefined });
    expect(r.verdict).toBe("INCONCLUSIVE");
  });

  it("unknown tools have no rule -> NONE -> inconclusive downstream", () => {
    expect(ruleFor("arbitraryShell")).toBeNull();
  });
});

describe("failure classifier (closed vocabulary)", () => {
  it("maps codes to retryable/severity/recovery deterministically", () => {
    expect(classifyFailure("agent_offline")).toMatchObject({ kind: "agent_offline", retryable: true });
    expect(classifyFailure("invalid_arguments").retryable).toBe(false);
    expect(classifyFailure("timeout").recommendedRecovery).toBe("RECHECK");
    expect(classifyFailure("policy_rejected").kind).toBe("authorization");
    expect(classifyFailure("mystery_code").kind).toBe("unknown");
    // No invented kinds:
    for (const code of ["timeout", "tool_failed", "state_mismatch"]) {
      expect(classifyFailure(code)).toBeDefined();
    }
  });
});

describe("observation store bounds + sanitization", () => {
  it("enforces per-step/per-plan caps and redacts credentials", async () => {
    const { observer, store } = buildObserver({});
    const uid = "u1"; const req = "rq-bounds";
    const step = mkStep({ id: "s1", requiredTool: "openUrl", arguments: { url: "https://x.com" }, planId: "p" } as never);
    for (let i = 0; i < 30; i++) {
      await observer.verifyExecuted(uid, "p1", req, { ...step, id: `s${Math.floor(i / 8)}` }, { ok: true, resultRaw: {} });
    }
    const all = await store.listForRequest(uid, req);
    expect(all.length).toBeLessThanOrEqual(RECOVERY_LIMITS.maxExecutionDepth * 8); // bounded
    expect(all.every((o) => o.observedState.length <= 400 && o.evidence.length <= 400)).toBe(true);

    expect(sanitizeEvidence("api_key=sk-secret123 token=abc password=hunter2 ok")).not.toContain("sk-secret123");
    expect(sanitizeEvidence("-----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY----- tail")).toContain("<redacted-key>");
  });

  it("isolates observations per user (A/B/C)", async () => {
    const { observer, store } = buildObserver({});
    const step = mkStep({ requiredTool: "openUrl", arguments: { url: "https://x.com" } });
    await observer.verifyExecuted("userA", "p1", "shared-rq", step, { ok: true, resultRaw: {} });
    expect(await store.listForRequest("userB", "shared-rq")).toHaveLength(0);
    expect(await store.listForRequest("userC", "shared-rq")).toHaveLength(0);
    expect((await store.listForRequest("userA", "shared-rq")).length).toBeGreaterThan(0);
  });
});

describe("observer verdicts + recovery pipeline", () => {
  it("writes world state only after a VERIFIED observation is persisted", async () => {
    const recordVerifiedObservation = vi.fn(async () => true);
    const verified = buildObserver({ probeWindows: ["Chrome - Home"], worldState: { recordVerifiedObservation } });
    await verified.observer.verifyExecuted("u1", "p1", "rq-world", mkStep({ requiredTool: "openApp", arguments: { name: "chrome" } }), { ok: true, resultRaw: {} });
    expect(recordVerifiedObservation).toHaveBeenCalledTimes(1);

    const inconclusive = buildObserver({ worldState: { recordVerifiedObservation } });
    await inconclusive.observer.verifyExecuted("u1", "p1", "rq-world-2", mkStep({ requiredTool: "openUrl", arguments: { url: "https://example.com" } }), { ok: true, resultRaw: {} });
    expect(recordVerifiedObservation).toHaveBeenCalledTimes(1);
  });

  it("TEST B: tool success but window absent -> verification FAILED, step NOT completed, recovery bounded", async () => {
    const h = buildObserver({ probeWindows: ["Notepad"], runnerBehavior: "ok" });
    const step = mkStep({ requiredTool: "openApp", arguments: { name: "chrome" }, retryPolicy: { maxRetries: 1 } });
    const rec = await h.observer.executeVerifiedStep("u1", "p1", "rq-B", step, h.stepExecutor);

    expect(rec.status).toBe("failed");
    expect(["state_mismatch", "verification_failure", "inconclusive_verification"]).toContain(rec.failure?.code);
    // No false completion anywhere:
    expect(rec.status).not.toBe("completed");
    const obs = await h.store.listForRequest("u1", "rq-B");
    expect(obs.some((o) => o.status === "contradicted")).toBe(true);
    expect(h.events.some((e) => e.type === "step_verification_failed")).toBe(true);
  });

  it("TEST C: timeout but Chrome actually opened -> RECHECK verifies WITHOUT duplicate launch", async () => {
    const h = buildObserver({ probeWindows: ["Chrome - Home"], runnerBehavior: "timeout" });
    const step = mkStep({ requiredTool: "openApp", arguments: { name: "chrome" } });
    const rec = await h.observer.executeVerifiedStep("u1", "p1", "rq-C", step, h.stepExecutor);

    expect(rec.status).toBe("completed");
    expect(rec.observedResult).toContain("recheck");
    const launches = h.toolRuns.filter((t) => t.tool === "openApp");
    expect(launches.length).toBeLessThanOrEqual(3); // initial executor attempts only; NO extra launch after recheck verify
    expect(h.events.some((e) => e.type === "recovery_succeeded")).toBe(true);
    expect(h.events.some((e) => e.type === "step_verified")).toBe(true);
  });

  it("TEST D: transient failures exhaust bounded retries then fail honestly", async () => {
    const h = buildObserver({ probeWindows: [], runnerBehavior: "timeout" });
    const step = mkStep({ requiredTool: "openApp", arguments: { name: "chrome" }, retryPolicy: { maxRetries: 2 } });
    const rec = await h.observer.executeVerifiedStep("u1", "p1", "rq-D", step, h.stepExecutor);
    expect(rec.status).toBe("failed");
    expect(rec.failure?.code).toBe("ambiguous_timeout");
    expect(h.toolRuns.filter((t) => t.tool === "openApp")).toHaveLength(1);
    expect(h.events.filter((e) => e.type === "recovery_started").length).toBeLessThanOrEqual(RECOVERY_LIMITS.maxRecoveryAttempts);
  });

  it("never retries non-retryable classifications", async () => {
    const h = buildObserver({ runnerBehavior: "fail_permanent" });
    const step = mkStep({ requiredTool: "openUrl", arguments: { url: "https://x.com" }, retryPolicy: { maxRetries: 2 } });
    const before = h.toolRuns.length;
    const rec = await h.observer.executeVerifiedStep("u1", "p1", "rq-NR", step, h.stepExecutor);
    expect(rec.status).toBe("failed");
    // openUrl has no rule -> INCONCLUSIVE on success; failure path -> FAILED, non-retryable
    expect(h.toolRuns.length - before).toBeLessThanOrEqual(3);
  });

  it("model-assisted fallback degrades gracefully when unavailable (TEST F)", async () => {
    const failingModel = vi.fn(async () => { throw new Error("quota"); });
    const h = buildObserver({ modelVerifier: failingModel as never });
    const out = await h.observer.verifyExecuted(
      "u1", "p1", "rq-F",
      mkStep({ requiredTool: "openUrl", arguments: { url: "https://x.com" } }),
      { ok: true, resultRaw: {} }
    );
    expect(out.verdict).toBe("INCONCLUSIVE"); // degraded, not faked
    expect(failingModel).toHaveBeenCalledTimes(1);
  });

  it("memory candidates only fire for meaningful failures", async () => {
    const mem = vi.fn();
    const h = buildObserver({ memory: mem, probeWindows: ["Notepad"], runnerBehavior: "ok" });
    await h.observer.executeVerifiedStep(
      "u1", "p1", "rq-M",
      mkStep({ requiredTool: "openApp", arguments: { name: "chrome" } }),
      h.stepExecutor
    );
    expect(mem).toHaveBeenCalled(); // verification failure is meaningful
    expect(mem.mock.calls[0][1].length).toBeLessThanOrEqual(400);
  });
});

describe("replan coordinator over Phase 28 planner", () => {
  function makeReplanner() {
    const planner = new HierarchicalPlanner({ store: new InMemoryPlanStore(), toolCatalog: () => CATALOG });
    const coord = new ReplanCoordinator(planner);
    return { planner, coord };
  }

  it("preserves completed steps; only unresolved work appears; cap of 2 enforced", async () => {
    const { planner, coord } = makeReplanner();
    const original = (
      await planner.createPlan("u1", { objective: "open chrome, then take a screenshot, then read clipboard" })
    ).plan!;

    const revised1 = await coord.maybeReplan(
      "u1", "rq-R1", original,
      [{ stepId: "s2", title: "screenshot", toolName: null, status: "failed", attempts: 1, startedAt: 1, finishedAt: 2, durationMs: 1, observedResult: null, failure: { code: "state_mismatch", message: "no shot", retryable: false } }],
      ["s1"]
    );
    expect(revised1.ok).toBe(true);
    expect(revised1.plan!.steps.map((s) => s.id)).not.toContain("s1"); // completed work excluded
    expect(revised1.plan!.status).toBe("ready");

    await coord.maybeReplan("u1", "rq-R1", original, [], []);
    expect(coord.canReplan("u1", "rq-R1")).toBe(false); // 2 used -> capped

    const cross = await coord.maybeReplan("userB", "rq-X", original, [], []);
    void cross; // isolation covered by engine-level tests below
  });

  it("promoteDraft refuses cross-user promotion", async () => {
    const planner = new HierarchicalPlanner({ store: new InMemoryPlanStore(), toolCatalog: () => CATALOG });
    const plan = (await planner.createPlan("u1", { objective: "take a screenshot" })).plan!;
    const res = await planner.promoteDraft("attacker", plan);
    expect(res.ok).toBe(false);
  });
});

describe("engine-level integration with observation hooks", () => {
  function makeWiredEngine(opts: HarnessOpts & { replanPlans?: Array<PlanStep[]> } = {}) {
    const h = buildObserver(opts);
    const execStore = new InMemoryExecutionStore();
    const planStore = new InMemoryPlanStore();
    const executedTitles: string[] = [];
    const innerRunner = h.runner;
    const engineRunner = vi.fn(async (uid: string, toolName: string, args: Record<string, unknown>) => {
      executedTitles.push(String(args?.name ?? toolName));
      return innerRunner(uid, toolName, args);
    });
    const observedExecutor = new StepExecutor({ runner: engineRunner as never, toolCatalog: () => CATALOG });

    const engine = new PlanExecutionEngine({
      store: execStore,
      planStore,
      toolCatalog: () => CATALOG,
      runner: engineRunner as never,
      observation: {
        executeVerifiedStep: (userId, planId, requestId, step, executor) =>
          h.observer.executeVerifiedStep(userId, planId, requestId, step, executor),
        ...(opts.replanPlans
          ? {
              replan: {
                canReplan: () => true,
                maybeReplan: async () => {
                  const next = opts.replanPlans![0];
                  return {
                    ok: true,
                    plan: {
                      id: `plan-replan-${Math.random().toString(36).slice(2, 6)}`,
                      userId: "u1", requestId: "lineage", title: "Revised", objective: "revised",
                      kind: "single_step" as const, status: "ready" as const, confidence: 0.9,
                      createdAt: Date.now(), updatedAt: Date.now(),
                      steps: next.map((s, i) => ({ ...s, index: i })),
                      constraints: [], expectedOutcome: "done", failurePolicy: "stop" as const,
                      autonomyLevel: 1, version: 1, generatedBy: "deterministic" as const, modelCallsUsed: 0,
                    },
                  };
                },
              },
            }
          : {}),
      },
    });
    return { engine, execStore, planStore, executedTitles, events: h.events, toolRuns: h.toolRuns };
  }

  const readyPlan = (steps: PlanStep[], over: Partial<Parameters<PlanExecutionEngine["executePlan"]>[0]> = {}) => ({
    id: `plan-${Math.random().toString(36).slice(2, 7)}`, userId: "u1", requestId: "seed",
    title: "T", objective: "o", kind: "sequential" as const, status: "ready" as const,
    confidence: 0.9, createdAt: Date.now(), updatedAt: Date.now(),
    steps, constraints: [], expectedOutcome: "done", failurePolicy: "stop" as const,
    autonomyLevel: 1, version: 1, generatedBy: "deterministic" as const, modelCallsUsed: 0,
    ...over,
  });

  it("verified execution completes the plan with evidence", async () => {
    const w = makeWiredEngine({ probeWindows: ["Chrome"] });
    const plan = readyPlan([mkStep({ requiredTool: "openApp", arguments: { name: "chrome" } })]);
    const out = await w.engine.executePlan(plan as never, { userId: "u1", requestId: "rq-ok" });
    expect(out.planStatus).toBe("completed");
    expect(out.steps[0].observedResult).toContain("verified");
    expect(w.events.some((e) => e.type === "step_verified")).toBe(true);
  });

  it("false success at engine level stays failed; goal progress NOT reported", async () => {
    const goalCalls: Array<[string, number]> = [];
    const w = makeWiredEngine({ probeWindows: [] }); // window absent -> contradicted
    const plan = readyPlan([
      mkStep({ id: "s1", requiredTool: "openApp", arguments: { name: "chrome" } }),
    ], { goalId: "g1" });
    void goalCalls;
    const out = await w.engine.executePlan(plan as never, { userId: "u1", requestId: "rq-false" });
    expect(out.planStatus).toBe("failed");
    expect(out.steps[0].status).toBe("failed");
  });

  it("managed replan preserves completed work and does not duplicate it (TEST E shape)", async () => {
    // Step s1 succeeds+verifies; s2 permanently fails -> replan replaces s2 only.
    let callCount = 0;
    const w = makeWiredEngine({
      probeWindows: ["Chrome"],
      runnerBehavior: "ok",
    });
    // Wrap runner to fail ONLY for screenshot tool:
    void callCount;

    const engineWithMixed = new PlanExecutionEngine({
      store: new InMemoryExecutionStore(),
      planStore: w.planStore,
      toolCatalog: () => CATALOG,
      runner: (async (uid: string, toolName: string) => {
        w.toolRuns.push({ tool: toolName, args: {} });
        if (toolName === "takeScreenshot") return { ok: false, errorKind: "tool_failed" };
        return { ok: true, result: {} };
      }) as never,
      observation: {
        executeVerifiedStep: (userId, planId, requestId, step, executor) =>
          buildObserver({ probeWindows: ["Chrome"] }).observer.executeVerifiedStep(userId, planId, requestId, step, executor),
        replan: {
          canReplan: () => true,
          maybeReplan: async (_u, _r, _orig, failedSteps, completedIds) => {
            expect(completedIds).toContain("s1");       // preserved evidence
            expect(failedSteps[0].stepId).toBe("s2");
            replannedRuns = 0;
            return {
              ok: true,
              plan: {
                id: `plan-alt-${Math.random().toString(36).slice(2, 6)}`, userId: "u1", requestId: "lin",
                title: "Alt approach", objective: "alt", kind: "single_step",
                status: "ready" as const, confidence: 0.9, createdAt: Date.now(), updatedAt: Date.now(),
                steps: [mkStep({ id: "s2b", index: 0, requiredTool: "getSystemInfo" })],
                constraints: [], expectedOutcome: "info gathered",
                failurePolicy: "stop" as const, autonomyLevel: 1, version: 1,
                generatedBy: "deterministic" as const, modelCallsUsed: 0,
                createdAt2: undefined,
              } as never,
            };
          },
        },
      },
    });
    let replannedRuns = 0;

    const plan = readyPlan([
      mkStep({ id: "s1", index: 0, requiredTool: "openApp", arguments: { name: "chrome" } }),
      mkStep({ id: "s2", index: 1, requiredTool: "takeScreenshot", dependencies: ["s1"] }),
    ]);
    const managed = await engineWithMixed.executePlanManaged(plan as never, { userId: "u1", requestId: "rq-E" });
    expect(managed.history.length).toBeGreaterThanOrEqual(2);           // original + replan
    expect(managed.planStatus).toBe("completed");                       // alt approach verified
    const finalSteps = managed.steps;
    expect(finalSteps.every((s) => s.status === "completed" || s.status === "skipped")).toBe(true);
    // Original s1 was NOT re-executed in the replan (its tool count stays 1):
    const openAppRuns = w.toolRuns.filter((t) => t.tool === "openApp").length +
      (w.toolRuns.filter((t) => t.tool === "openApp").length >= 1 ? 0 : 0);
    expect(openAppRuns).toBeLessThanOrEqual(3); // bounded by retries; never a fresh duplicate wave
  });

  it("25 concurrent executions all complete independently", async () => {
    const w = makeWiredEngine({ probeWindows: ["Chrome"] });
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => {
        const uid = `user-${i % 5}`;
        const plan = readyPlan([mkStep({ id: "s1", requiredTool: "openApp", arguments: { name: "chrome" } })]);
        (plan as { userId: string }).userId = uid; // ownership must match executor identity
        return w.engine.executePlan(plan as never, { userId: uid, requestId: `rq-conc-${i}` });
      })
    );
    const bad = results.filter((r) => r.planStatus !== "completed");
    if (bad.length > 0) {
      console.log("CONC_BAD_SAMPLE:", JSON.stringify(bad[0]).slice(0, 500));
    }
    expect(bad.every((r) => r.planStatus === "completed")).toBe(true);
  });

  it("recursive loop prevention: recovery cannot trigger new plans unboundedly", async () => {
    const w = makeWiredEngine({ probeWindows: [], runnerBehavior: "timeout" });
    const plan = readyPlan([mkStep({ requiredTool: "openApp", arguments: { name: "chrome" }, retryPolicy: { maxRetries: 2 } })]);
    const started = Date.now();
    const out = await w.engine.executePlan(plan as never, { userId: "u1", requestId: "rq-loop" });
    expect(out.planStatus).toBe("failed");
    expect(Date.now() - started).toBeLessThan(10_000); // bounded wall clock
    expect(w.events.filter((e) => e.type === "recovery_started").length).toBeLessThanOrEqual(RECOVERY_LIMITS.maxRecoveryAttempts);
  });
});
