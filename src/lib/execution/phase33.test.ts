import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableExecutionRepository } from "./durableRepository";
import { validateToolArgs, toolRisk } from "./guards";
import type { Plan } from "../planner/types";
import { PlanExecutionEngine } from "./planExecutor";
import type { ExecutionRecord } from "./types";

const dirs: string[] = [];
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lohz-phase33-")); dirs.push(dir);
  return { dir, store: new DurableExecutionRepository(dir) };
}
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function plan(uid: string, id: string): Plan {
  const now = Date.now();
  return { id, userId: uid, requestId: `r-${id}`, title: id, objective: id,
    kind: "single_step", status: "ready", confidence: 1, createdAt: now, updatedAt: now,
    steps: [], constraints: [], expectedOutcome: "test", failurePolicy: "stop",
    autonomyLevel: 1, version: 1, generatedBy: "deterministic", modelCallsUsed: 0 };
}

function clipboardPlan(uid: string, id: string): Plan {
  const value = plan(uid, id);
  value.steps = [{ id: "s1", index: 0, title: "write clipboard", description: "write clipboard",
    intent: "clipboard_write", status: "ready", dependencies: [], requiredTool: "clipboardWrite",
    arguments: { content: "hello" }, expectedOutcome: "clipboard updated", riskLevel: "medium",
    confidence: 1, retryPolicy: { maxRetries: 0 }, timeoutMs: 1000 }];
  return value;
}

function openPlan(uid: string, id: string): Plan {
  const value = plan(uid, id);
  value.steps = [{ id: "s1", index: 0, title: "open app", description: "open app",
    intent: "open_app", status: "ready", dependencies: [], requiredTool: "openApp",
    arguments: { name: "chrome" }, expectedOutcome: "app opened", riskLevel: "low",
    confidence: 1, retryPolicy: { maxRetries: 0 }, timeoutMs: 1000 }];
  return value;
}

function interrupted(p: Plan, stepStatus: "ready" | "running"): ExecutionRecord {
  return { uid: p.userId, requestId: p.requestId, planId: p.id, planVersion: p.version,
    status: "running", authorization: "AUTHORIZED", startedAt: Date.now(), finishedAt: null,
    steps: [{ stepId: "s1", title: "open app", toolName: "openApp", status: stepStatus,
      attempts: stepStatus === "running" ? 1 : 0, startedAt: stepStatus === "running" ? Date.now() : null,
      finishedAt: null, durationMs: null, observedResult: null, failure: null }],
    planStatusAfter: null, failure: null, version: 1 };
}

describe("Phase 33 durable contracts", () => {
  it("uses the registry clipboard schema", () => {
    expect(validateToolArgs("clipboardWrite", { content: "hello" }).ok).toBe(true);
    expect(validateToolArgs("clipboardWrite", { text: "hello" }).ok).toBe(false);
  });
  it("requires renameFile.newName consistently", () => {
    expect(validateToolArgs("renameFile", { path: "notes.txt" }).ok).toBe(false);
    expect(validateToolArgs("renameFile", { path: "notes.txt", newName: "done.txt" }).ok).toBe(true);
  });
  it("takes risk from the registry", () => {
    expect(toolRisk("clipboardWrite")).toBe("medium");
    expect(toolRisk("notRegistered")).toBe("high");
  });
  it("survives repository recreation and enforces ownership", async () => {
    const { dir, store } = repo();
    expect(await store.savePlan("user-a", plan("user-a", "p1"))).toBe(true);
    expect(await store.savePlan("user-b", plan("user-a", "forged"))).toBe(false);
    const restarted = new DurableExecutionRepository(dir);
    expect((await restarted.getPlan("user-a", "p1"))?.userId).toBe("user-a");
    expect(await restarted.getPlan("user-b", "p1")).toBeNull();
  });
  it("supports concurrent users without shared state", async () => {
    const { store } = repo();
    await Promise.all(["a", "b", "c"].map((uid) => store.savePlan(uid, plan(uid, `p-${uid}`))));
    const counts = await Promise.all(["a", "b", "c"].map((uid) => store.listPlans(uid)));
    expect(counts.map((x) => x.length)).toEqual([1, 1, 1]);
  });
  it("persists confirmation state and re-authorizes on resume", async () => {
    const { dir, store } = repo();
    const p = clipboardPlan("user-a", "confirm-plan");
    await store.savePlan("user-a", p);
    let calls = 0;
    const build = (repository: DurableExecutionRepository) => new PlanExecutionEngine({
      store: repository, planStore: repository, toolCatalog: () => ["clipboardWrite"],
      runner: async () => { calls++; return { ok: true, result: "written" }; },
    });
    const waiting = await build(store).executePlanManaged(p, { userId: "user-a", requestId: "confirm-request" });
    expect(waiting.recordStatus).toBe("awaiting_confirmation");
    expect(calls).toBe(0);
    const restarted = new DurableExecutionRepository(dir);
    const resumed = await build(restarted).executePlanManaged(p, { userId: "user-a", requestId: "confirm-request", confirmed: true });
    expect(resumed.recordStatus).toBe("completed");
    expect(calls).toBe(1);
  });
  it("resumes only safe checkpointed work after restart", async () => {
    const { dir, store } = repo(); const p = openPlan("user-a", "restart-safe");
    await store.savePlan("user-a", p); await store.saveExecution(interrupted(p, "ready"));
    let calls = 0; const restarted = new DurableExecutionRepository(dir);
    const engine = new PlanExecutionEngine({ store: restarted, planStore: restarted,
      toolCatalog: () => ["openApp"], runner: async () => { calls++; return { ok: true }; } });
    const outcomes = await engine.recoverInterruptedUser("user-a");
    expect(calls).toBe(1); expect(outcomes[0]?.recordStatus).toBe("completed");
  });
  it("resumes a partially completed plan without replaying its completed step", async () => {
    const { dir, store } = repo();
    const p = openPlan("user-a", "restart-partial");
    p.kind = "sequential";
    p.steps.push({ id: "s2", index: 1, title: "system info", description: "read system info",
      intent: "system_info", status: "ready", dependencies: ["s1"], requiredTool: "getSystemInfo",
      arguments: {}, expectedOutcome: "system info returned", riskLevel: "low", confidence: 1,
      retryPolicy: { maxRetries: 0 }, timeoutMs: 1000 });
    await store.savePlan("user-a", p);
    const record = interrupted(p, "ready");
    record.requestId = "restart-partial-request";
    record.steps[0] = { ...record.steps[0], status: "completed", attempts: 1, finishedAt: Date.now(), observedResult: "opened" };
    record.steps.push({ stepId: "s2", title: "system info", toolName: "getSystemInfo", status: "ready",
      attempts: 0, startedAt: null, finishedAt: null, durationMs: null, observedResult: null, failure: null });
    await store.saveExecution(record);

    const calls: string[] = [];
    const restarted = new DurableExecutionRepository(dir);
    const engine = new PlanExecutionEngine({ store: restarted, planStore: restarted,
      toolCatalog: () => ["openApp", "getSystemInfo"],
      runner: async (_uid, tool) => { calls.push(tool); return { ok: true, result: {} }; } });
    const outcomes = await engine.recoverInterruptedUser("user-a");
    expect(outcomes[0]?.recordStatus).toBe("completed");
    expect(calls).toEqual(["getSystemInfo"]);
  });
  it("stops ambiguous in-flight side effects after restart", async () => {
    const { dir, store } = repo(); const p = openPlan("user-a", "restart-ambiguous");
    await store.savePlan("user-a", p); await store.saveExecution(interrupted(p, "running"));
    let calls = 0; const restarted = new DurableExecutionRepository(dir);
    const engine = new PlanExecutionEngine({ store: restarted, planStore: restarted,
      toolCatalog: () => ["openApp"], runner: async () => { calls++; return { ok: true }; } });
    await engine.recoverInterruptedUser("user-a");
    expect(calls).toBe(0);
    expect((await restarted.getExecution("user-a", p.requestId))?.failure?.code).toBe("restart_ambiguous_side_effect");
  });
});
