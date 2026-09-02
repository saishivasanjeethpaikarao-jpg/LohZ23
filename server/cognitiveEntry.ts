import type express from "express";
import type { AuthenticatedRequest } from "./authMiddleware";
import type { IntegrationPipeline } from "../src/lib/integration/pipeline";
import type { PlanStore } from "../src/lib/planner/planPersistence";
import type { ExecutionStore } from "../src/lib/execution/persistence";
import type { PlanExecutionEngine } from "../src/lib/execution/planExecutor";
import { randomUUID } from "node:crypto";

export interface CognitiveEntryDeps {
  planStore: PlanStore;
  executionStore: ExecutionStore;
  executionEngine: PlanExecutionEngine;
}

/** The single HTTP cognitive entry. Authentication must be installed first. */
export function registerCognitiveEntryRoutes(app: express.Express, deps: CognitiveEntryDeps): void {
  app.post("/api/route", async (req, res) => {
    const userId = (req as AuthenticatedRequest).userId;
    if (!userId) { res.status(401).json({ error: "authenticated uid required" }); return; }
    const text = (req.body?.text ?? req.body?.input) as unknown;
    if (typeof text !== "string" || !text.trim()) { res.status(400).json({ error: "text is required" }); return; }
    const pipeline = app.locals.pipeline as IntegrationPipeline | undefined;
    if (!pipeline) { res.status(503).json({ error: "Cognitive pipeline unavailable" }); return; }
    try {
      const requestId = randomUUID();
      const outcome = await pipeline.handleAuthenticatedText(userId, text.slice(0, 2000), { requestId });
      // Phase 42 — record knowledge gaps observed during this route.
      // Best-effort: curiosity capture NEVER changes or delays the response.
      try {
        const curiosity = app.locals.curiosityService as import("../src/lib/curiosity").CuriosityService | undefined;
        if (curiosity) {
          void curiosity.captureRouteOutcome(userId, {
            intent: outcome.intent,
            confidence: outcome.confidence,
            success: outcome.success,
            verificationStatus: outcome.verificationStatus,
            askedClarification: outcome.lifecycle.includes("ASK"),
            inputText: text.slice(0, 500),
          });
        }
      } catch { /* gap capture is observational only */ }
      res.json({
        requestId: outcome.requestId, tier: outcome.tier, intent: outcome.intent,
        confidence: outcome.confidence, success: outcome.success, response: outcome.response,
        toolUsed: outcome.toolUsed, modelCalls: outcome.modelCalls, latencyMs: outcome.latencyMs,
        lifecycle: outcome.lifecycle, planId: outcome.planId, result: outcome.resultPayload,
        decision: outcome.decision, verificationStatus: outcome.verificationStatus,
        consistency: outcome.consistency,
      });
    } catch { res.status(500).json({ error: "Cognitive processing failed" }); }
  });

  app.post("/api/executions/:requestId/confirm", async (req, res) => {
    const userId = (req as AuthenticatedRequest).userId;
    const requestId = String(req.params.requestId ?? "");
    if (!userId) { res.status(401).json({ error: "authenticated uid required" }); return; }
    if (!/^[A-Za-z0-9#_-]{1,160}$/.test(requestId)) { res.status(400).json({ error: "invalid requestId" }); return; }
    const execution = await deps.executionStore.getExecution(userId, requestId);
    if (!execution || execution.status !== "awaiting_confirmation") {
      res.status(404).json({ error: "awaiting confirmation record not found" }); return;
    }
    const plan = await deps.planStore.getPlan(userId, execution.planId);
    if (!plan || plan.userId !== userId || plan.version !== execution.planVersion) {
      res.status(404).json({ error: "owned plan version not found" }); return;
    }
    const outcome = await deps.executionEngine.executePlanManaged(plan, { userId, requestId, confirmed: true });
    res.json({ requestId, planId: plan.id, authorization: outcome.authorization,
      status: outcome.recordStatus, success: outcome.recordStatus === "completed",
      summary: outcome.summary, steps: outcome.steps });
  });
}
