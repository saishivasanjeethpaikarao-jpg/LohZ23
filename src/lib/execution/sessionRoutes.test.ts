import express from "express";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createVerifiedAuthMiddleware } from "../../../server/authMiddleware";
import { registerExecutionSessionRoutes } from "../../../server/executionSessions";
import { InMemoryPlanStore } from "../planner/planPersistence";
import type { Plan } from "../planner/types";
import { InMemoryExecutionStore } from "./persistence";
import { PlanExecutionEngine } from "./planExecutor";
import { ExecutionSessionCoordinator } from "./sessionCoordinator";
import { InMemoryExecutionSessionStore } from "./sessionStore";

const servers: http.Server[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

function plan(userId: string): Plan {
  const now = Date.now();
  return {
    id: "plan-route", userId, requestId: "seed", title: "Prepare project", objective: "Prepare and verify the project",
    kind: "single_step", status: "ready", confidence: 1, createdAt: now, updatedAt: now,
    steps: [{ id: "s1", index: 0, title: "Open app", description: "open app", intent: "open_app", status: "ready",
      dependencies: [], requiredTool: "openApp", arguments: { name: "chrome" }, expectedOutcome: "open", riskLevel: "low",
      confidence: 1, retryPolicy: { maxRetries: 0 }, timeoutMs: 1_000 }],
    constraints: [], expectedOutcome: "ready", failurePolicy: "stop", autonomyLevel: 1, version: 1,
    generatedBy: "deterministic", modelCallsUsed: 0,
  };
}

async function setup() {
  const plans = new InMemoryPlanStore();
  await plans.savePlan("user-a", plan("user-a"));
  const executions = new InMemoryExecutionStore();
  const engine = new PlanExecutionEngine({ store: executions, planStore: plans, toolCatalog: () => ["openApp"], runner: async () => ({ ok: true }) });
  const coordinator = new ExecutionSessionCoordinator({
    store: new InMemoryExecutionSessionStore(),
    verifyResume: async () => ({ status: "VERIFIED", reason: "owned plan verified" }),
    run: async () => ({ status: "completed", reason: "verified", verificationStatus: "VERIFIED", completedStepIds: ["s1"] }),
  });
  const app = express(); app.use(express.json());
  app.use("/api", createVerifiedAuthMiddleware(async (token) => token === "a" ? "user-a" : token === "b" ? "user-b" : Promise.reject(new Error("invalid"))) as never);
  registerExecutionSessionRoutes(app, { coordinator, planStore: plans, executionEngine: engine });
  const server = http.createServer(app); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("listen failed");
  const request = (path: string, token: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { request, plans };
}

describe("Phase 41 authenticated session contract", () => {
  it("derives bounded authority from the owned plan and completes through resume", async () => {
    const { request } = await setup();
    const createdResponse = await request("/api/execution-sessions", "a", {
      method: "POST", body: JSON.stringify({ planId: "plan-route", allowedTools: ["deleteFile"], maxRisk: "critical" }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { sessionId: string; authorizationScope: { allowedTools: string[]; maxRisk: string } };
    expect(created.authorizationScope.allowedTools).toEqual(["openApp"]);
    expect(created.authorizationScope.maxRisk).toBe("low");
    const resumed = await request(`/api/execution-sessions/${created.sessionId}/resume`, "a", { method: "POST", body: "{}" });
    expect(resumed.status).toBe(200);
    expect((await resumed.json() as { session: { status: string } }).session.status).toBe("completed");
  });

  it("does not expose one user's session to another authenticated user", async () => {
    const { request } = await setup();
    const created = await (await request("/api/execution-sessions", "a", { method: "POST", body: JSON.stringify({ planId: "plan-route" }) })).json() as { sessionId: string };
    expect((await request(`/api/execution-sessions/${created.sessionId}`, "b")).status).toBe(404);
    expect((await request(`/api/execution-sessions/${created.sessionId}/resume`, "b", { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("refuses to extend old consent after the persisted plan version changes", async () => {
    const { request, plans } = await setup();
    const created = await (await request("/api/execution-sessions", "a", { method: "POST", body: JSON.stringify({ planId: "plan-route" }) })).json() as { sessionId: string };
    const changed = (await plans.getPlan("user-a", "plan-route"))!; changed.version = 2;
    await plans.savePlan("user-a", changed);
    const response = await request(`/api/execution-sessions/${created.sessionId}/reauthorize`, "a", { method: "POST", body: "{}" });
    expect(response.status).toBe(409);
  });
});
