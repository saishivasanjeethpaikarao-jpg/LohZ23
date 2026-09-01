import { randomUUID } from "node:crypto";
import type express from "express";
import type { AuthenticatedRequest } from "./authMiddleware";
import type { PlanStore } from "../src/lib/planner/planPersistence";
import { planRisk } from "../src/lib/planner/planScorer";
import type { PlanExecutionEngine } from "../src/lib/execution/planExecutor";
import type { ExecutionSessionCoordinator } from "../src/lib/execution/sessionCoordinator";
import type { ExecutionSession } from "../src/lib/execution/sessionTypes";

export interface ExecutionSessionRouteDeps {
  coordinator: ExecutionSessionCoordinator;
  planStore: PlanStore;
  executionEngine: PlanExecutionEngine;
}

/** Authenticated lifecycle routes. All scopes are derived from the owned plan. */
export function registerExecutionSessionRoutes(app: express.Express, deps: ExecutionSessionRouteDeps): void {
  const uid = (req: express.Request): string | null => (req as AuthenticatedRequest).userId ?? null;

  app.post("/api/execution-sessions", async (req, res) => {
    const userId = uid(req);
    if (!userId) { res.status(401).json({ error: "authenticated uid required" }); return; }
    const planId = cleanId(req.body?.planId);
    if (!planId) { res.status(400).json({ error: "valid planId required" }); return; }
    const plan = await deps.planStore.getPlan(userId, planId);
    if (!plan || plan.userId !== userId || plan.status !== "ready") { res.status(404).json({ error: "owned ready plan not found" }); return; }
    const session = await deps.coordinator.create({
      userId, objective: plan.objective, planId: plan.id, planVersion: plan.version,
      requestId: cleanId(req.body?.requestId) ?? `session-${randomUUID()}`,
      allowedTools: plan.steps.flatMap((step) => step.requiredTool ? [step.requiredTool] : []),
      maxRisk: planRisk(plan.steps), confirmed: req.body?.confirmed === true,
      authorizationTtlMs: boundedNumber(req.body?.authorizationTtlMs),
      sessionTimeoutMs: boundedNumber(req.body?.sessionTimeoutMs),
      nextAction: plan.steps.find((step) => step.requiredTool)?.title ?? "verify plan state",
    });
    if (!session) { res.status(503).json({ error: "durable session persistence unavailable" }); return; }
    res.status(201).json(publicSession(session));
  });

  app.get("/api/execution-sessions", async (req, res) => {
    const userId = uid(req);
    if (!userId) { res.status(401).json({ error: "authenticated uid required" }); return; }
    res.json({ sessions: (await deps.coordinator.list(userId, 50)).map(publicSession) });
  });

  app.get("/api/execution-sessions/:sessionId", async (req, res) => {
    const userId = uid(req); const sessionId = cleanId(req.params.sessionId);
    if (!userId) { res.status(401).json({ error: "authenticated uid required" }); return; }
    if (!sessionId) { res.status(400).json({ error: "invalid sessionId" }); return; }
    const session = await deps.coordinator.get(userId, sessionId);
    if (!session) { res.status(404).json({ error: "session not found" }); return; }
    res.json(publicSession(session));
  });

  app.post("/api/execution-sessions/:sessionId/resume", async (req, res) => {
    const userId = uid(req); const sessionId = cleanId(req.params.sessionId);
    if (!userId) { res.status(401).json({ error: "authenticated uid required" }); return; }
    if (!sessionId) { res.status(400).json({ error: "invalid sessionId" }); return; }
    // Resolve through the authenticated UID before reporting lease state so a
    // foreign session id cannot be used as a cross-user existence oracle.
    if (!(await deps.coordinator.get(userId, sessionId))) { res.status(404).json({ error: "session not found" }); return; }
    const result = await deps.coordinator.resume(userId, sessionId, `server-${process.pid}-${randomUUID()}`);
    const status = result.code === "lease_unavailable" ? 409 : result.session ? 200 : 404;
    res.status(status).json({ ok: result.ok, code: result.code, session: result.session ? publicSession(result.session) : null });
  });

  app.post("/api/execution-sessions/:sessionId/reauthorize", async (req, res) => {
    const userId = uid(req); const sessionId = cleanId(req.params.sessionId);
    if (!userId) { res.status(401).json({ error: "authenticated uid required" }); return; }
    if (!sessionId) { res.status(400).json({ error: "invalid sessionId" }); return; }
    const current = await deps.coordinator.get(userId, sessionId);
    if (!current) { res.status(404).json({ error: "session not found" }); return; }
    const plan = await deps.planStore.getPlan(userId, current.planId);
    if (!plan || plan.userId !== userId || plan.version !== current.planVersion) { res.status(409).json({ error: "plan changed; create a new bounded session" }); return; }
    const session = await deps.coordinator.reauthorize({
      userId, sessionId, planId: plan.id, planVersion: plan.version,
      allowedTools: plan.steps.flatMap((step) => step.requiredTool ? [step.requiredTool] : []),
      maxRisk: planRisk(plan.steps), confirmed: req.body?.confirmed === true,
      authorizationTtlMs: boundedNumber(req.body?.authorizationTtlMs),
    });
    if (!session) { res.status(409).json({ error: "reauthorization rejected" }); return; }
    res.json(publicSession(session));
  });

  app.post("/api/execution-sessions/:sessionId/pause", async (req, res) => {
    const userId = uid(req); const sessionId = cleanId(req.params.sessionId);
    if (!userId) { res.status(401).json({ error: "authenticated uid required" }); return; }
    if (!sessionId) { res.status(400).json({ error: "invalid sessionId" }); return; }
    const ok = await deps.coordinator.pause(userId, sessionId);
    res.status(ok ? 200 : 404).json({ ok });
  });

  app.post("/api/execution-sessions/:sessionId/cancel", async (req, res) => {
    const userId = uid(req); const sessionId = cleanId(req.params.sessionId);
    if (!userId) { res.status(401).json({ error: "authenticated uid required" }); return; }
    if (!sessionId) { res.status(400).json({ error: "invalid sessionId" }); return; }
    const current = await deps.coordinator.get(userId, sessionId);
    if (!current) { res.status(404).json({ ok: false }); return; }
    deps.executionEngine.requestCancel(userId, current.requestId);
    const ok = await deps.coordinator.cancel(userId, sessionId);
    res.status(ok ? 200 : 409).json({ ok });
  });
}

function publicSession(session: ExecutionSession): ExecutionSession {
  return session;
}
function cleanId(value: unknown): string | null {
  const text = String(value ?? ""); return /^[A-Za-z0-9#_.:-]{1,160}$/.test(text) ? text : null;
}
function boundedNumber(value: unknown): number | undefined {
  const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
