import express from "express";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVerifiedAuthMiddleware } from "../../server/authMiddleware";
import { registerCognitiveEntryRoutes } from "../../server/cognitiveEntry";
import { DurableExecutionRepository } from "./execution/durableRepository";
import { PlanExecutionEngine } from "./execution/planExecutor";
import { toolRisk } from "./execution/guards";
import { ObservationCoordinator, ReplanCoordinator } from "./observation";
import { HierarchicalPlanner } from "./planner/planner";
import { CognitiveRouter } from "./router/cognitiveRouter";
import { ContextAssembler } from "./cognitive/contextAssembler";
import { CognitiveCore } from "./cognitive/cognitiveCore";
import { IntegrationPipeline } from "./integration/pipeline";
import { createAuthorizedToolExecutor } from "./integration/authorizedToolExecutor";
import { INTENT_VOCABULARY } from "./router/types";

const CATALOG = ["openApp", "closeApp", "focusApp", "openUrl", "takeScreenshot", "getSystemInfo", "getVolume", "setVolume", "clipboardRead", "clipboardWrite", "readFile", "createFile", "writeFile", "createFolder", "renameFile", "listWindows"];
const dirs: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    server.close(() => resolve());
  })));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function composition() {
  const app = express();
  app.use(express.json());
  app.use("/api", createVerifiedAuthMiddleware(async (token) => {
    if (token === "a") return "user-a";
    if (token === "b") return "user-b";
    throw new Error("invalid token");
  }) as never);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lohz-http-")); dirs.push(dir);
  const repository = new DurableExecutionRepository(dir);
  const toolCalls: Array<{ uid: string; tool: string; args: Record<string, unknown> }> = [];
  let clipboard = "";
  let screenshotAttempts = 0;
  const runner = vi.fn(async (uid: string, tool: string, args: Record<string, unknown>) => {
    toolCalls.push({ uid, tool, args });
    if (tool === "clipboardWrite") clipboard = String(args.content ?? "");
    if (tool === "takeScreenshot" && screenshotAttempts++ === 0) return { ok: false, errorKind: "agent_offline" };
    return { ok: true, result: tool === "takeScreenshot" ? "image-data" : { accepted: true } };
  });

  const planningResponse = {
    provider: "test-planner", model: "bounded-plan",
    text: JSON.stringify({
      title: "Open and capture",
      steps: [
        { id: "s1", title: "Open Chrome", intent: "open_app", requiredTool: "openApp", arguments: { name: "chrome" }, expectedOutcome: "Chrome window visible", riskLevel: "low", confidence: 0.98, dependsOn: [] },
        { id: "s2", title: "Capture screenshot", intent: "screenshot", requiredTool: "takeScreenshot", arguments: {}, expectedOutcome: "Screenshot returned", riskLevel: "low", confidence: 0.98, dependsOn: ["s1"] },
      ], failurePolicy: "stop", confidence: 0.98,
    }),
  };
  const gatewayCalls: Array<{ capability: string; prompt: string; uid: string }> = [];
  const gateway = {
    generate: vi.fn(async (request: { capability: string; prompt: string; userId: string }) => {
      gatewayCalls.push({ capability: request.capability, prompt: request.prompt, uid: request.userId });
      return request.capability === "planning"
        ? planningResponse
        : { text: "Inspect the first failing stack frame.", provider: "test-reasoner", model: "reasoning-model" };
    }),
  };
  const planner = new HierarchicalPlanner({ store: repository, toolCatalog: () => CATALOG, gateway: gateway as never });
  const observer = new ObservationCoordinator({
    store: repository, sleep: async () => undefined,
    probeRunner: async (_uid, tool) => {
      if (tool === "listWindows") return { ok: true, result: [{ title: "Chrome" }] };
      if (tool === "clipboardRead") return { ok: true, result: clipboard };
      return { ok: true, result: {} };
    },
  });
  const replan = new ReplanCoordinator(planner);
  const engine = new PlanExecutionEngine({
    store: repository, planStore: repository, idempotency: repository, toolCatalog: () => CATALOG, runner,
    observation: {
      executeVerifiedStep: (uid, planId, requestId, step, executor) => observer.executeVerifiedStep(uid, planId, requestId, step, executor),
      replan: {
        canReplan: (uid, requestId) => replan.canReplan(uid, requestId),
        maybeReplan: (uid, requestId, original, failed, completed) => replan.maybeReplan(uid, requestId, original, failed, completed),
      },
    },
  });
  const router = new CognitiveRouter({
    executeTool: createAuthorizedToolExecutor({ planStore: repository, executionEngine: engine, hasTool: (name) => CATALOG.includes(name), riskForTool: toolRisk }),
    gateway: gateway as never,
    providers: {
      retrieveMemories: async (uid) => uid === "user-a" ? [{ id: "m1", text: "Alice memory", score: 1 }] : [],
      currentContextSnapshot: async (uid) => ({ owner: uid, activeProject: "LOHZ" }),
    },
    planner: {
      shouldPlan: (input) => planner.shouldPlan(input),
      createPlan: async (uid, request) => {
        const result = await planner.createPlan(uid, request);
        if (!result.ok || !result.plan || result.plan.status !== "ready") return { ok: result.ok, reason: result.reason, needsClarification: result.needsClarification, rejected: result.rejected, modelCallsUsed: result.modelCallsUsed };
        const execution = await engine.executePlanManaged(result.plan, { userId: uid, requestId: request.requestId ?? result.plan.requestId, confirmed: false });
        return { ok: true, plan: { id: result.plan.id, title: result.plan.title, status: execution.planStatus ?? result.plan.status, confidence: result.plan.confidence }, summary: `PLANNED: ${result.plan.title}\n${execution.summary}`, modelCallsUsed: result.modelCallsUsed };
      },
    },
  });
  const capabilities = { availableTools: CATALOG, supportedIntents: [...INTENT_VOCABULARY], canPlan: true, canExecute: true, canVerify: true, canRecover: true, canReason: true };
  const assembler = new ContextAssembler({
    loadMemories: async (uid) => [{ id: "frame-memory", text: `${uid} code project context` }],
    loadUserModel: async (uid) => ({ interactionMode: "text" as const, preferences: { detail: "brief" }, projects: [{ key: `${uid}-project`, displayName: "LOHZ", status: "active" }], currentTaskState: "testing" }),
    loadGoals: async () => [], loadRecentEvents: async () => [], worldAssertions: async () => [],
  }, capabilities as never);
  const core = new CognitiveCore({ router, assembler, toolCatalog: () => CATALOG, capabilities: capabilities as never });
  app.locals.pipeline = new IntegrationPipeline({ router, core });
  registerCognitiveEntryRoutes(app, { planStore: repository, executionStore: repository, executionEngine: engine });

  const server = http.createServer(app); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { base: `http://127.0.0.1:${address.port}`, repository, toolCalls, gatewayCalls };
}

async function post(base: string, text: string, token = "a", extra: Record<string, unknown> = {}) {
  const response = await fetch(`${base}/api/route`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ text, ...extra }) });
  return { response, body: await response.json() as Record<string, any> };
}

describe("Phase 33 real authenticated cognitive HTTP contracts", () => {
  it("flow 1: Tier 0 crosses auth, core, router, central policy, observed engine, and agent stub with zero model calls", async () => {
    const runtime = await composition();
    const { response, body } = await post(runtime.base, "open chrome");
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ tier: "tier0_direct", intent: "open_app", success: true, modelCalls: 0, toolUsed: "openApp", verificationStatus: "VERIFIED" });
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(runtime.toolCalls.filter((call) => call.tool === "openApp")).toEqual([{ uid: "user-a", tool: "openApp", args: { name: "chrome" } }]);
    expect((await runtime.repository.getPlan("user-a", `direct-${body.requestId}`))?.requestId).toBe(body.requestId);
  });

  it("flow 2: Tier 1 remains deterministic, user-scoped, and model-free", async () => {
    const runtime = await composition();
    const { body } = await post(runtime.base, "hello there");
    expect(body.tier).toBe("tier1_light");
    expect(body.modelCalls).toBe(0);
    expect(body.response).toContain('"owner":"user-a"');
    expect(runtime.gatewayCalls).toHaveLength(0);
    expect(runtime.toolCalls).toHaveLength(0);
  });

  it("flow 3: Tier 2 assembles bounded context, calls one gateway model, and executes no tool", async () => {
    const runtime = await composition();
    const { body } = await post(runtime.base, "Why is my code failing?");
    expect(body).toMatchObject({ tier: "tier2_reasoning", intent: "reason", success: true, modelCalls: 1, response: "Inspect the first failing stack frame." });
    expect(runtime.gatewayCalls).toHaveLength(1);
    expect(runtime.gatewayCalls[0]).toMatchObject({ capability: "reasoning", uid: "user-a" });
    expect(runtime.gatewayCalls[0].prompt).toContain("UNTRUSTED DATA BEGIN");
    expect(runtime.gatewayCalls[0].prompt).toContain("UNTRUSTED DATA END");
    expect(runtime.gatewayCalls[0].prompt).toContain("user-a code project context");
    expect(runtime.toolCalls).toHaveLength(0);
  });

  it("flow 4: Tier 3 plans, persists, executes, observes, and recovers a transient agent failure", async () => {
    const runtime = await composition();
    const { body } = await post(runtime.base, "finish this task for me while I am away");
    expect(body.tier).toBe("tier3_autonomous");
    expect(body.planId).toMatch(/^plan-/);
    expect(body.success).toBe(true);
    expect(body.response).toContain("completed");
    expect(runtime.gatewayCalls.filter((call) => call.capability === "planning")).toHaveLength(1);
    expect(runtime.toolCalls.filter((call) => call.tool === "openApp")).toHaveLength(1);
    expect(runtime.toolCalls.filter((call) => call.tool === "takeScreenshot")).toHaveLength(2);
    expect((await runtime.repository.listForRequest("user-a", body.requestId)).length).toBeGreaterThanOrEqual(2);
    expect((await runtime.repository.getPlan("user-a", body.planId))?.status).toBe("completed");
  });

  it("flow 5: medium-risk request persists awaiting confirmation, then re-authorizes and resumes exactly once", async () => {
    const runtime = await composition();
    const first = await post(runtime.base, 'write "hello" to the clipboard', "a", { uid: "user-b" });
    expect(first.body).toMatchObject({ tier: "tier0_direct", success: false, toolUsed: "clipboardWrite" });
    expect(first.body.lifecycle).toContain("AWAITING_CONFIRMATION");
    expect(runtime.toolCalls.filter((call) => call.tool === "clipboardWrite")).toHaveLength(0);
    const confirmed = await fetch(`${runtime.base}/api/executions/${first.body.requestId}/confirm`, { method: "POST", headers: { Authorization: "Bearer a", "Content-Type": "application/json" }, body: "{}" });
    const result = await confirmed.json() as Record<string, any>;
    expect(result).toMatchObject({ success: true, status: "completed", authorization: "AUTHORIZED" });
    expect(runtime.toolCalls.filter((call) => call.tool === "clipboardWrite")).toEqual([{ uid: "user-a", tool: "clipboardWrite", args: { content: "hello" } }]);
    expect(await runtime.repository.getExecution("user-b", first.body.requestId)).toBeNull();
    const replay = await fetch(`${runtime.base}/api/executions/${first.body.requestId}/confirm`, { method: "POST", headers: { Authorization: "Bearer a", "Content-Type": "application/json" }, body: "{}" });
    expect(replay.status).toBe(404);
    expect(runtime.toolCalls.filter((call) => call.tool === "clipboardWrite")).toHaveLength(1);
  });

  it("rejects unauthenticated and forged identities before the cognitive path", async () => {
    const runtime = await composition();
    const missing = await fetch(`${runtime.base}/api/route`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hello" }) });
    expect(missing.status).toBe(401);
    const forged = await post(runtime.base, "hello there", "a", { uid: "user-b" });
    expect(forged.body.response).toContain('"owner":"user-a"');
  });
});
