import { randomUUID } from "node:crypto";
import type { SelfModelStore } from "./store";
import {
  CORE_CAPABILITIES, HEALTH_LIMITS,
  type CapabilityCategory, type CapabilityObservation, type CapabilitySpec,
  type CapabilityState, type HealthSnapshot, type HealthVerdict, type SubsystemHealth,
} from "./types";

const clamp = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const detail = (value: unknown): string | null => {
  const clean = String(value ?? "").replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, HEALTH_LIMITS.detailCodeChars);
  return clean || null;
};

function emptyState(uid: string, capabilityId: string, category: CapabilityCategory, staleAfterMs: number, now: number): CapabilityState {
  return {
    uid, capabilityId, category, available: false, confidence: 0, reliability: 0,
    lastSuccessAt: null, lastFailureAt: null, successCount: 0, failureCount: 0,
    inconclusiveCount: 0, consecutiveFailures: 0, lastVerifiedAt: null,
    lastObservedAt: null, staleAfterMs, observations: [], updatedAt: now,
  };
}

function derive(state: CapabilityState, now: number): CapabilityState {
  const observations = [...state.observations]
    .filter((item) => item && item.capabilityId === state.capabilityId && Number.isFinite(item.observedAt))
    .sort((a, b) => a.observedAt - b.observedAt)
    .slice(-HEALTH_LIMITS.observationsPerCapability);
  const decisive = observations.filter((item) => item.verdict !== "inconclusive");
  let successWeight = 0; let failureWeight = 0;
  decisive.forEach((item, index) => {
    // New observations carry more weight, so old successes cannot hide a recent regression.
    const weight = index + 1;
    if (item.verdict === "success") successWeight += weight;
    else failureWeight += weight;
  });
  const reliability = successWeight + failureWeight > 0 ? successWeight / (successWeight + failureWeight) : 0;
  const lastDecisive = decisive.at(-1);
  const lastAuthoritative = [...decisive].reverse().find((item) => item.authoritative);
  const lastVerifiedAt = lastDecisive?.observedAt ?? state.lastVerifiedAt;
  const stale = lastVerifiedAt === null || now - lastVerifiedAt > state.staleAfterMs;
  let available = decisive.some((item) => item.verdict === "success") && reliability >= 0.5 && state.consecutiveFailures < 3;
  if (lastAuthoritative && lastAuthoritative.observedAt === lastDecisive?.observedAt) available = lastAuthoritative.verdict === "success";
  if (stale) available = false;
  const confidence = decisive.length === 0 ? 0 : clamp(
    (lastAuthoritative?.observedAt === lastDecisive?.observedAt ? 0.82 : 0.35)
      + Math.min(0.13, decisive.length * 0.02)
  );
  return {
    ...state, observations, available, reliability: clamp(reliability), confidence,
    lastVerifiedAt, lastObservedAt: observations.at(-1)?.observedAt ?? state.lastObservedAt,
    updatedAt: now,
  };
}

export class HealthEngine {
  constructor(private store: SelfModelStore, private now: () => number = Date.now) {}
  backendName(): string { return this.store.backendName(); }

  async record(input: {
    uid: string; capabilityId: string; category: CapabilityCategory; verdict: HealthVerdict;
    source: string; observedAt?: number; latencyMs?: number | null; detailCode?: string | null;
    authoritative?: boolean; staleAfterMs?: number;
  }): Promise<CapabilityState | null> {
    if (!(await this.recordMany([input]))) return null;
    return this.getCapability(input.uid, input.capabilityId);
  }

  async recordMany(inputs: Array<{
    uid: string; capabilityId: string; category: CapabilityCategory; verdict: HealthVerdict;
    source: string; observedAt?: number; latencyMs?: number | null; detailCode?: string | null;
    authoritative?: boolean; staleAfterMs?: number;
  }>): Promise<boolean> {
    if (inputs.length === 0 || inputs.length > HEALTH_LIMITS.capabilitiesPerUser) return false;
    const uid = inputs[0].uid;
    if (!uid || inputs.some((item) => item.uid !== uid || !/^[a-z0-9_.:-]{2,120}$/i.test(item.capabilityId) || !/^[a-z0-9_.:-]{2,80}$/i.test(item.source))) return false;
    const now = this.now();
    const result = await this.store.transact(uid, (document) => {
      for (const input of inputs) {
        const observedAt = Math.min(now + 60_000, Number.isFinite(input.observedAt) ? input.observedAt! : now);
        const observation: CapabilityObservation = {
          id: randomUUID(), capabilityId: input.capabilityId, verdict: input.verdict,
          source: input.source, observedAt, latencyMs: Number.isFinite(input.latencyMs) ? Math.max(0, input.latencyMs!) : null,
          detailCode: detail(input.detailCode), authoritative: input.authoritative === true,
        };
        const index = document.capabilities.findIndex((item) => item.capabilityId === input.capabilityId);
        const previous = index >= 0 ? document.capabilities[index]
          : emptyState(uid, input.capabilityId, input.category, input.staleAfterMs ?? (input.category === "tool" ? HEALTH_LIMITS.toolStaleAfterMs : HEALTH_LIMITS.defaultStaleAfterMs), now);
        const state: CapabilityState = {
          ...previous,
          category: input.category,
          staleAfterMs: Math.max(5_000, Math.min(24 * 60 * 60_000, input.staleAfterMs ?? previous.staleAfterMs)),
          successCount: previous.successCount + (input.verdict === "success" ? 1 : 0),
          failureCount: previous.failureCount + (input.verdict === "failure" ? 1 : 0),
          inconclusiveCount: previous.inconclusiveCount + (input.verdict === "inconclusive" ? 1 : 0),
          consecutiveFailures: input.verdict === "failure" ? previous.consecutiveFailures + 1
            : input.verdict === "success" ? 0 : previous.consecutiveFailures,
          lastSuccessAt: input.verdict === "success" ? observedAt : previous.lastSuccessAt,
          lastFailureAt: input.verdict === "failure" ? observedAt : previous.lastFailureAt,
          observations: [...previous.observations, observation].slice(-HEALTH_LIMITS.observationsPerCapability),
          updatedAt: now,
        };
        const derived = derive(state, now);
        if (index >= 0) document.capabilities[index] = derived;
        else document.capabilities.push(derived);
      }
      document.capabilities = document.capabilities.slice(-HEALTH_LIMITS.capabilitiesPerUser);
      document.updatedAt = now;
      return { document, result: true };
    });
    return result === true;
  }

  async getCapability(uid: string, capabilityId: string): Promise<CapabilityState | null> {
    const document = await this.store.load(uid);
    const state = document?.capabilities.find((item) => item.capabilityId === capabilityId);
    return state ? derive(state, this.now()) : null;
  }

  async snapshot(uid: string, specs: readonly CapabilitySpec[] = CORE_CAPABILITIES): Promise<HealthSnapshot | null> {
    const document = await this.store.load(uid);
    if (!document || document.uid !== uid) return null;
    const now = this.now();
    const byId = new Map(document.capabilities.map((item) => [item.capabilityId, derive(item, now)]));
    const subsystem = (spec: CapabilitySpec, state?: CapabilityState): SubsystemHealth => {
      const current = state ?? emptyState(uid, spec.capabilityId, spec.category, spec.staleAfterMs ?? HEALTH_LIMITS.defaultStaleAfterMs, now);
      const stale = current.lastVerifiedAt === null || now - current.lastVerifiedAt > current.staleAfterMs;
      const last = current.observations.at(-1);
      const lastDecisive = [...current.observations].reverse().find((item) => item.verdict !== "inconclusive");
      const awaitingVerification = last?.verdict === "inconclusive" && (!lastDecisive || last.observedAt >= lastDecisive.observedAt);
      const score = stale ? (current.lastVerifiedAt === null ? 0 : 15)
        : current.available ? Math.round((current.reliability * 0.72 + current.confidence * 0.28) * 100)
          : current.consecutiveFailures > 0 ? Math.max(0, 30 - current.consecutiveFailures * 10) : 10;
      const status: SubsystemHealth["status"] = current.lastVerifiedAt === null ? "unknown"
        : stale ? "stale" : !current.available ? (awaitingVerification ? "unknown" : lastDecisive?.authoritative ? "offline" : "critical")
          : current.reliability >= 0.8 ? "healthy" : "degraded";
      return {
        capabilityId: spec.capabilityId, label: spec.label, category: spec.category,
        available: current.available, score: Math.max(0, Math.min(99, score)), status,
        reliability: current.reliability, confidence: current.confidence, stale,
        lastVerifiedAt: current.lastVerifiedAt, lastFailureAt: current.lastFailureAt,
        consecutiveFailures: current.consecutiveFailures,
        detailCode: (current.available ? lastDecisive?.detailCode : last?.detailCode) ?? null,
      };
    };
    const coreSubsystems = specs.map((spec) => subsystem(spec, byId.get(spec.capabilityId)));
    const providerSubsystems = [...byId.values()]
      .filter((item) => item.category === "provider" && item.capabilityId.startsWith("provider:"))
      .map((item) => subsystem({ capabilityId: item.capabilityId, label: item.capabilityId.replace(/^provider:/, "Provider: "), category: "provider", weight: 0, critical: false }, item))
      .sort((a, b) => a.label.localeCompare(b.label));
    const subsystems = [...coreSubsystems, ...providerSubsystems];
    const tools = [...byId.values()].filter((item) => item.category === "tool")
      .map((item) => subsystem({ capabilityId: item.capabilityId, label: item.capabilityId.replace(/^tool:/, ""), category: "tool", weight: 0, critical: false }, item))
      .sort((a, b) => a.label.localeCompare(b.label));
    const totalWeight = specs.reduce((sum, item) => sum + item.weight, 0);
    const weighted = specs.reduce((sum, spec, index) => sum + coreSubsystems[index].score * spec.weight, 0);
    // Operational health never reports a synthetic perfect 100.
    const overallScore = Math.min(99, Math.max(0, Math.round(weighted / Math.max(1, totalWeight))));
    const criticalDown = specs.some((spec, index) => spec.critical && !coreSubsystems[index].available);
    const status: HealthSnapshot["status"] = overallScore >= 80 && !criticalDown ? "healthy"
      : overallScore >= 45 && !criticalDown ? "degraded" : "critical";
    return { uid, overallScore, status, subsystems, tools, generatedAt: now, staleAfterMs: HEALTH_LIMITS.defaultStaleAfterMs, schemaVersion: 1 };
  }
}
