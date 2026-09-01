import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ContextAssembler } from "../cognitive/contextAssembler";
import { CognitiveRouter } from "../router/cognitiveRouter";
import { IntegrationPipeline } from "../integration/pipeline";
import { HealthEngine } from "./engine";
import { OperationalHealthCoordinator } from "./coordinator";
import { InMemorySelfModelStore, LocalSelfModelStore } from "./store";
import { CORE_CAPABILITIES, HEALTH_LIMITS } from "./types";

describe("Phase 37 HealthEngine", () => {
  it("starts unknown and prevents a fabricated 100 percent score", async () => {
    const engine = new HealthEngine(new InMemorySelfModelStore(), () => 1_000);
    const unknown = await engine.snapshot("u1");
    expect(unknown?.overallScore).toBe(0);
    expect(unknown?.status).toBe("critical");
    await engine.recordMany(CORE_CAPABILITIES.map((spec) => ({
      uid: "u1", capabilityId: spec.capabilityId, category: spec.category,
      verdict: "success" as const, source: "verified_probe", authoritative: true,
      staleAfterMs: spec.staleAfterMs,
    })));
    const healthy = await engine.snapshot("u1");
    expect(healthy?.overallScore).toBeGreaterThan(90);
    expect(healthy?.overallScore).toBeLessThan(100);
    expect(healthy?.status).toBe("healthy");
  });

  it("uses recent-weighted bounded reliability without letting one failure destroy confidence", async () => {
    let now = 10_000; const engine = new HealthEngine(new InMemorySelfModelStore(), () => now);
    for (let i = 0; i < 5; i++) { now++; await engine.record({ uid: "u1", capabilityId: "tool:openApp", category: "tool", verdict: "success", source: "tool_observation" }); }
    now++; await engine.record({ uid: "u1", capabilityId: "tool:openApp", category: "tool", verdict: "failure", source: "tool_observation" });
    const afterOne = await engine.getCapability("u1", "tool:openApp");
    expect(afterOne?.available).toBe(true);
    expect(afterOne?.reliability).toBeCloseTo(15 / 21);
    expect(afterOne?.consecutiveFailures).toBe(1);
    for (let i = 0; i < 2; i++) { now++; await engine.record({ uid: "u1", capabilityId: "tool:openApp", category: "tool", verdict: "failure", source: "tool_observation" }); }
    expect((await engine.getCapability("u1", "tool:openApp"))?.available).toBe(false);
    now++; await engine.record({ uid: "u1", capabilityId: "tool:openApp", category: "tool", verdict: "success", source: "recovery_probe", authoritative: true });
    const recovered = await engine.getCapability("u1", "tool:openApp");
    expect(recovered?.available).toBe(true);
    expect(recovered?.consecutiveFailures).toBe(0);
  });

  it("marks expired observations stale and unavailable", async () => {
    let now = 1_000; const engine = new HealthEngine(new InMemorySelfModelStore(), () => now);
    await engine.record({ uid: "u1", capabilityId: "windows_agent", category: "integration", verdict: "success", source: "socket_status", authoritative: true, staleAfterMs: 5_000 });
    expect((await engine.getCapability("u1", "windows_agent"))?.available).toBe(true);
    now += 5_001;
    expect((await engine.getCapability("u1", "windows_agent"))?.available).toBe(false);
    expect((await engine.snapshot("u1"))?.subsystems.find((item) => item.capabilityId === "windows_agent")?.status).toBe("stale");
  });

  it("bounds rolling observations", async () => {
    let now = 1; const engine = new HealthEngine(new InMemorySelfModelStore(), () => ++now);
    for (let i = 0; i < HEALTH_LIMITS.observationsPerCapability + 12; i++) {
      await engine.record({ uid: "u1", capabilityId: "tool:readFile", category: "tool", verdict: i % 5 ? "success" : "failure", source: "tool_observation" });
    }
    expect((await engine.getCapability("u1", "tool:readFile"))?.observations).toHaveLength(HEALTH_LIMITS.observationsPerCapability);
  });

  it("persists across restart and isolates users", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lohz-self-model-"));
    try {
      const first = new HealthEngine(new LocalSelfModelStore(root), () => 100);
      await first.record({ uid: "alice", capabilityId: "memory", category: "memory", verdict: "success", source: "store_probe", authoritative: true });
      const restarted = new HealthEngine(new LocalSelfModelStore(root), () => 101);
      expect((await restarted.getCapability("alice", "memory"))?.successCount).toBe(1);
      expect(await restarted.getCapability("bob", "memory")).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("serializes concurrent updates without losing observations", async () => {
    const engine = new HealthEngine(new InMemorySelfModelStore(), () => 100);
    await Promise.all(Array.from({ length: 20 }, () => engine.record({ uid: "u1", capabilityId: "tool:openUrl", category: "tool", verdict: "success", source: "tool_observation" })));
    expect((await engine.getCapability("u1", "tool:openUrl"))?.successCount).toBe(20);
  });
});

describe("Phase 37 operational integration", () => {
  const deps = (overrides: Partial<ConstructorParameters<typeof OperationalHealthCoordinator>[1]> = {}) => ({
    memoryHealthy: async () => true,
    worldModelHealthy: async () => true,
    providerConfigured: async () => false,
    agentStatus: () => ({ online: false, lastError: "connection_refused" }),
    components: () => ({ cognitiveCore: true, router: true, planner: true, execution: true, observation: true, recovery: true, temporal: true }),
    participantProbe: async () => true,
    tools: () => ["openApp"],
    supportedIntents: () => ["open_app"],
    ...overrides,
  });

  it("reports provider, Windows Agent, and database degradation from probes", async () => {
    const engine = new HealthEngine(new InMemorySelfModelStore());
    const coordinator = new OperationalHealthCoordinator(engine, deps({ memoryHealthy: async () => false }));
    const snapshot = await coordinator.refresh("u1");
    expect(snapshot?.subsystems.find((item) => item.capabilityId === "windows_agent")?.status).toBe("offline");
    expect(snapshot?.subsystems.find((item) => item.capabilityId === "memory")?.available).toBe(false);
    expect(snapshot?.subsystems.find((item) => item.capabilityId === "model_provider")?.available).toBe(false);
    expect(snapshot?.status).not.toBe("healthy");
  });

  it("recovers provider availability only after a real successful outcome", async () => {
    const engine = new HealthEngine(new InMemorySelfModelStore());
    const coordinator = new OperationalHealthCoordinator(engine, deps({ providerConfigured: async () => true }));
    await coordinator.refresh("u1");
    expect((await engine.getCapability("u1", "model_provider"))?.available).toBe(false);
    await coordinator.recordProviderOutcome("u1", "gemini", true, 12);
    expect((await engine.getCapability("u1", "model_provider"))?.available).toBe(true);
  });

  it("shows a newly configured provider as unknown until connectivity is verified", async () => {
    let configured = false;
    const engine = new HealthEngine(new InMemorySelfModelStore());
    const coordinator = new OperationalHealthCoordinator(engine, deps({ providerConfigured: async () => configured }));
    await coordinator.refresh("u1");
    configured = true;
    const snapshot = await coordinator.refresh("u1");
    const gemini = snapshot?.subsystems.find((item) => item.capabilityId === "provider:gemini");
    expect(gemini?.status).toBe("unknown");
    expect(gemini?.available).toBe(false);
    expect(gemini?.detailCode).toBe("configured_not_connectivity_verified");
  });

  it("truthfully blocks computer actions while the agent is offline", async () => {
    let executions = 0;
    const engine = new HealthEngine(new InMemorySelfModelStore());
    const coordinator = new OperationalHealthCoordinator(engine, deps());
    const router = new CognitiveRouter({
      executeTool: async () => { executions++; return { ok: true }; },
      capabilityGate: (uid, input, intent, tool) => coordinator.gate(uid, input, intent, tool),
    });
    const outcome = await router.route("u1", "open chrome");
    expect(outcome.success).toBe(false);
    expect(outcome.diagnostic.errorKind).toBe("windows_agent_unavailable");
    expect(outcome.response).toMatch(/Windows Agent is offline/i);
    expect(executions).toBe(0);
  });

  it("does not promise persistent memory when its database probe fails", async () => {
    let reads = 0;
    const engine = new HealthEngine(new InMemorySelfModelStore());
    const coordinator = new OperationalHealthCoordinator(engine, deps({ memoryHealthy: async () => false }));
    const router = new CognitiveRouter({
      executeTool: async () => ({ ok: false }),
      providers: { retrieveMemories: async () => { reads++; return []; } },
      capabilityGate: (uid, input, intent, tool) => coordinator.gate(uid, input, intent, tool),
    });
    const outcome = await router.route("u1", "What do you remember about my thesis?");
    expect(outcome.success).toBe(false);
    expect(outcome.diagnostic.errorKind).toBe("memory_persistence_unavailable");
    expect(outcome.response).toMatch(/Persistent memory is currently unavailable/i);
    expect(reads).toBe(0);
  });

  it("injects a dynamic measured capability snapshot into SituationFrame", async () => {
    const assembler = new ContextAssembler({}, async () => ({
      availableTools: [], supportedIntents: ["explain"], canPlan: false,
      canExecute: false, canVerify: true, canRecover: true, canReason: false,
    }));
    const { frame } = await assembler.assemble("u1", "r1", { intent: "explain", confidence: 0.9, riskLevel: "low", tier: "tier2_reasoning" }, "explain health");
    expect(frame.lohzCapabilities.canExecute).toBe(false);
    expect(frame.lohzCapabilities.canReason).toBe(false);
  });

  it("observes cognitive runtime outcomes without changing response truth", async () => {
    const observed: Array<{ success: boolean; tier?: string }> = [];
    const router = new CognitiveRouter({ executeTool: async () => ({ ok: true }) });
    const pipeline = new IntegrationPipeline({
      router,
      onCognitiveOutcome: async (_uid, outcome) => { observed.push(outcome); throw new Error("diagnostic store offline"); },
    });
    const result = await pipeline.handleAuthenticatedText("u1", "hello there");
    expect(result.tier).toBe("tier1_light");
    expect(observed).toHaveLength(1);
    expect(observed[0].tier).toBe("tier1_light");
  });
});
