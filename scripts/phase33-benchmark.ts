import { performance } from "node:perf_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import { CognitiveRouter } from "../src/lib/router/cognitiveRouter";
import { DurableExecutionRepository } from "../src/lib/execution/durableRepository";
import type { Plan } from "../src/lib/planner/types";
import { registerCognitiveEntryRoutes } from "../server/cognitiveEntry";

async function meanMs(iterations: number, work: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) await work();
  return (performance.now() - start) / iterations;
}

const router = new CognitiveRouter({
  executeTool: async () => ({ ok: true, result: { stub: true } }),
  gateway: { generate: async () => ({ text: "stub reasoning", provider: "stub", model: "stub" }) },
  planner: {
    shouldPlan: () => true,
    createPlan: async () => ({ ok: true, plan: { id: "p", title: "stub", status: "ready", confidence: 1 }, summary: "PLANNED: stub", modelCallsUsed: 0 }),
  },
});

const metrics: Record<string, number | string> = {};
metrics.tier0InternalMeanMs = await meanMs(500, () => router.route("bench-user", "open chrome"));
metrics.tier1InternalMeanMs = await meanMs(500, () => router.route("bench-user", "hello there"));
metrics.tier2InternalMeanMs = await meanMs(500, () => router.route("bench-user", "explain why retries fail"));
metrics.tier3InternalMeanMs = await meanMs(500, () => router.route("bench-user", "manage my goal"));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lohz-phase33-bench-"));
try {
  const repository = new DurableExecutionRepository(temp);
  const now = Date.now();
  const plan: Plan = { id: "bench-plan", userId: "bench-user", requestId: "bench-request", title: "bench",
    objective: "bench", kind: "single_step", status: "ready", confidence: 1, createdAt: now, updatedAt: now,
    steps: [], constraints: [], expectedOutcome: "bench", failurePolicy: "stop", autonomyLevel: 1,
    version: 1, generatedBy: "deterministic", modelCallsUsed: 0 };
  metrics.persistenceSaveMeanMs = await meanMs(100, () => repository.savePlan("bench-user", { ...plan, updatedAt: Date.now() }));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

const app = express(); app.use(express.json());
app.use("/api", (req, _res, next) => { (req as express.Request & { userId: string }).userId = "bench-user"; next(); });
app.locals.pipeline = { handleAuthenticatedText: (uid: string, text: string) => router.route(uid, text) };
registerCognitiveEntryRoutes(app, { planStore: {} as never, executionStore: {} as never, executionEngine: {} as never });
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const port = (server.address() as { port: number }).port;
  metrics.cognitiveEntryHttpWallMeanMs = await meanMs(50, async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/route`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: '{"text":"hello"}',
    });
    await response.arrayBuffer();
  });
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

metrics.modelLatency = "not measured (stub only)";
metrics.windowsAgentRoundTrip = "not measured (agent offline/unverified)";
console.log(JSON.stringify(metrics, null, 2));
