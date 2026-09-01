import type { LohzCapabilitySnapshot } from "../cognitive/types";
import type { HealthEngine } from "./engine";
import type { HealthSnapshot, HealthVerdict } from "./types";

export interface RuntimeComponentState {
  cognitiveCore: boolean;
  router: boolean;
  planner: boolean;
  execution: boolean;
  observation: boolean;
  recovery: boolean;
  temporal: boolean;
}

export interface RuntimeHealthDeps {
  memoryHealthy: () => Promise<boolean>;
  worldModelHealthy: (uid: string) => Promise<boolean>;
  providerConfigured: (provider: "gemini" | "nvidia") => Promise<boolean>;
  agentStatus: () => { online: boolean; connecting?: boolean; lastError?: string | null };
  components: () => RuntimeComponentState;
  participantProbe: (uid: string) => Promise<boolean>;
  tools: () => string[];
  supportedIntents: () => string[];
}

const code = (value: unknown, fallback: string): string => {
  const clean = String(value ?? fallback).toLowerCase().replace(/[^a-z0-9_.:-]/g, "_").slice(0, 100);
  return clean || fallback;
};

export class OperationalHealthCoordinator {
  constructor(private engine: HealthEngine, private deps: RuntimeHealthDeps) {}

  async refresh(uid: string): Promise<HealthSnapshot | null> {
    const [memory, world, gemini, nvidia, participant] = await Promise.all([
      this.deps.memoryHealthy().catch(() => false),
      this.deps.worldModelHealthy(uid).catch(() => false),
      this.deps.providerConfigured("gemini").catch(() => false),
      this.deps.providerConfigured("nvidia").catch(() => false),
      this.deps.participantProbe(uid).catch(() => false),
    ]);
    const components = this.deps.components();
    const agent = this.deps.agentStatus();
    const check = (capabilityId: string, category: Parameters<HealthEngine["recordMany"]>[0][number]["category"], ok: boolean, source = "runtime_probe", detailCode?: string) => ({
      uid, capabilityId, category, verdict: (ok ? "success" : "failure") as HealthVerdict,
      source, authoritative: true, detailCode: detailCode ?? (ok ? "probe_ok" : "probe_failed"),
      ...(capabilityId === "windows_agent" ? { staleAfterMs: 30_000 } : {}),
    });
    const provider = (name: "gemini" | "nvidia", configured: boolean) => ({
      uid, capabilityId: `provider:${name}`, category: "provider" as const,
      verdict: (configured ? "inconclusive" : "failure") as HealthVerdict,
      source: "credential_probe", authoritative: !configured,
      detailCode: configured ? "configured_not_connectivity_verified" : "credential_not_configured",
    });
    const configuredProvider = gemini || nvidia;
    const observations = [
      check("authentication", "security", true, "authenticated_request"),
      check("frontend_backend", "integration", true, "authenticated_health_request"),
      check("memory", "memory", memory, "memory_store_probe", memory ? "store_reachable" : "store_unavailable"),
      check("world_model", "memory", world, "world_store_probe", world ? "store_reachable" : "store_unavailable"),
      check("persistence", "persistence", memory && world, "persistence_probe", memory && world ? "stores_reachable" : "one_or_more_stores_unavailable"),
      check("cognitive_core", "cognition", components.cognitiveCore),
      check("router", "cognition", components.router),
      check("planner", "cognition", components.planner),
      check("execution", "execution", components.execution),
      check("observation", "execution", components.observation),
      check("recovery", "execution", components.recovery),
      check("temporal", "memory", components.temporal),
      check("participant_awareness", "conversation", participant, "participant_self_probe"),
      check("windows_agent", "integration", agent.online === true, "agent_bridge_status", agent.online ? "socket_online" : code(agent.lastError, agent.connecting ? "connecting" : "offline")),
      provider("gemini", gemini), provider("nvidia", nvidia),
      {
        uid, capabilityId: "model_provider", category: "provider" as const,
        verdict: (configuredProvider ? "inconclusive" : "failure") as HealthVerdict,
        source: "credential_probe", authoritative: !configuredProvider,
        detailCode: configuredProvider ? "configured_not_connectivity_verified" : "no_provider_configured",
      },
      {
        uid, capabilityId: "gemini_live", category: "provider" as const,
        verdict: (gemini ? "inconclusive" : "failure") as HealthVerdict,
        source: "credential_probe", authoritative: !gemini,
        detailCode: gemini ? "configured_not_live_verified" : "credential_not_configured",
      },
    ];
    if (!(await this.engine.recordMany(observations))) return null;
    return this.engine.snapshot(uid);
  }

  async recordProviderOutcome(uid: string, provider: string, success: boolean, latencyMs: number, source = "model_gateway", aggregate = true): Promise<void> {
    const verdict: HealthVerdict = success ? "success" : "failure";
    const observations: Parameters<HealthEngine["recordMany"]>[0] = [
      { uid, capabilityId: `provider:${code(provider, "unknown")}`, category: "provider", verdict, source, latencyMs, detailCode: success ? "request_succeeded" : "request_failed" },
    ];
    if (aggregate) observations.push({ uid, capabilityId: "model_provider", category: "provider", verdict, source, latencyMs, detailCode: success ? "request_succeeded" : "request_failed" });
    await this.engine.recordMany(observations);
  }

  async recordGeminiLive(uid: string, verdict: HealthVerdict, detailCode: string): Promise<void> {
    await this.engine.record({ uid, capabilityId: "gemini_live", category: "provider", verdict, source: "gemini_live_transport", detailCode, authoritative: true, staleAfterMs: 10 * 60_000 });
  }

  async recordToolOutcome(uid: string, toolName: string, success: boolean, failureCode?: string): Promise<void> {
    await this.engine.record({
      uid, capabilityId: `tool:${code(toolName, "unknown")}`, category: "tool",
      verdict: success ? "success" : "failure", source: "observed_tool_execution",
      detailCode: success ? "execution_succeeded" : code(failureCode, "execution_failed"),
      authoritative: false,
    });
  }

  async recordSubsystemOutcome(
    uid: string,
    capabilityId: "cognitive_core" | "router" | "planner" | "execution" | "observation" | "recovery",
    success: boolean,
    detailCode?: string,
  ): Promise<void> {
    const categories = {
      cognitive_core: "cognition", router: "cognition", planner: "cognition",
      execution: "execution", observation: "execution", recovery: "execution",
    } as const;
    await this.engine.record({
      uid, capabilityId, category: categories[capabilityId],
      verdict: success ? "success" : "failure", source: "runtime_outcome",
      detailCode: success ? code(detailCode, "operation_succeeded") : code(detailCode, "operation_failed"),
      authoritative: false,
    });
  }

  async cognitiveCapabilities(uid: string): Promise<LohzCapabilitySnapshot> {
    await this.refresh(uid);
    const [agent, planner, execution, observation, recovery, provider] = await Promise.all([
      this.engine.getCapability(uid, "windows_agent"), this.engine.getCapability(uid, "planner"),
      this.engine.getCapability(uid, "execution"), this.engine.getCapability(uid, "observation"),
      this.engine.getCapability(uid, "recovery"), this.engine.getCapability(uid, "model_provider"),
    ]);
    return {
      availableTools: agent?.available ? this.deps.tools() : [],
      supportedIntents: this.deps.supportedIntents(),
      canPlan: planner?.available === true,
      canExecute: execution?.available === true && agent?.available === true,
      canVerify: observation?.available === true,
      canRecover: recovery?.available === true,
      canReason: provider?.available === true,
    };
  }

  async gate(uid: string, input: string, intent: string, toolName?: string): Promise<{ available: boolean; response?: string; errorKind?: string } | null> {
    await this.refresh(uid);
    if (toolName) {
      const agent = await this.engine.getCapability(uid, "windows_agent");
      if (!agent?.available) return {
        available: false, errorKind: "windows_agent_unavailable",
        response: "I can’t perform that computer action right now because the Windows Agent is offline or stale. Nothing was executed.",
      };
      const tool = await this.engine.getCapability(uid, `tool:${code(toolName, "unknown")}`);
      if (tool && !tool.available && tool.consecutiveFailures >= 3) return {
        available: false, errorKind: "tool_unreliable",
        response: `I can’t safely use ${toolName} right now because its recent verified executions repeatedly failed. Nothing was executed.`,
      };
    }
    if (intent === "memory_query" || /\b(?:remember|save)\s+(?:this|that)\b/i.test(input)) {
      const memory = await this.engine.getCapability(uid, "memory");
      if (!memory?.available) return {
        available: false, errorKind: "memory_persistence_unavailable",
        response: "Persistent memory is currently unavailable, so I can’t truthfully promise to remember that. I can still use it within the current conversation.",
      };
    }
    return null;
  }
}
