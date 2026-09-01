export const HEALTH_LIMITS = {
  observationsPerCapability: 40,
  capabilitiesPerUser: 160,
  detailCodeChars: 120,
  defaultStaleAfterMs: 5 * 60_000,
  toolStaleAfterMs: 30 * 60_000,
} as const;

export type CapabilityCategory =
  | "security" | "persistence" | "cognition" | "execution"
  | "integration" | "provider" | "memory" | "conversation" | "tool";

export type HealthVerdict = "success" | "failure" | "inconclusive";

export interface CapabilityObservation {
  id: string;
  capabilityId: string;
  verdict: HealthVerdict;
  source: string;
  observedAt: number;
  latencyMs: number | null;
  detailCode: string | null;
  /** Authoritative availability signals include an agent socket status or a direct persistence probe. */
  authoritative: boolean;
}

export interface CapabilityState {
  uid: string;
  capabilityId: string;
  category: CapabilityCategory;
  available: boolean;
  confidence: number;
  reliability: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  successCount: number;
  failureCount: number;
  inconclusiveCount: number;
  consecutiveFailures: number;
  lastVerifiedAt: number | null;
  lastObservedAt: number | null;
  staleAfterMs: number;
  observations: CapabilityObservation[];
  updatedAt: number;
}

export interface SelfModelDocument {
  uid: string;
  schemaVersion: 1;
  capabilities: CapabilityState[];
  updatedAt: number;
}

export type SubsystemStatus = "healthy" | "degraded" | "critical" | "offline" | "unknown" | "stale";

export interface SubsystemHealth {
  capabilityId: string;
  label: string;
  category: CapabilityCategory;
  available: boolean;
  score: number;
  status: SubsystemStatus;
  reliability: number;
  confidence: number;
  stale: boolean;
  lastVerifiedAt: number | null;
  lastFailureAt: number | null;
  consecutiveFailures: number;
  detailCode: string | null;
}

export interface HealthSnapshot {
  uid: string;
  overallScore: number;
  status: "healthy" | "degraded" | "critical";
  subsystems: SubsystemHealth[];
  tools: SubsystemHealth[];
  generatedAt: number;
  staleAfterMs: number;
  schemaVersion: 1;
}

export interface CapabilitySpec {
  capabilityId: string;
  label: string;
  category: CapabilityCategory;
  weight: number;
  critical: boolean;
  staleAfterMs?: number;
}

export const CORE_CAPABILITIES: readonly CapabilitySpec[] = [
  { capabilityId: "authentication", label: "Authentication", category: "security", weight: 1.4, critical: true },
  { capabilityId: "persistence", label: "Persistence", category: "persistence", weight: 1.3, critical: true },
  { capabilityId: "cognitive_core", label: "Cognitive Core", category: "cognition", weight: 1.3, critical: true },
  { capabilityId: "router", label: "Router", category: "cognition", weight: 1, critical: true },
  { capabilityId: "planner", label: "Planner", category: "cognition", weight: 0.8, critical: false },
  { capabilityId: "execution", label: "Execution", category: "execution", weight: 1, critical: false },
  { capabilityId: "observation", label: "Observation", category: "execution", weight: 1, critical: false },
  { capabilityId: "recovery", label: "Recovery", category: "execution", weight: 0.8, critical: false },
  { capabilityId: "windows_agent", label: "Windows Agent", category: "integration", weight: 1.1, critical: false, staleAfterMs: 30_000 },
  { capabilityId: "model_provider", label: "Model Provider", category: "provider", weight: 1, critical: false },
  { capabilityId: "gemini_live", label: "Gemini Live", category: "provider", weight: 0.7, critical: false },
  { capabilityId: "memory", label: "Memory", category: "memory", weight: 1.1, critical: false },
  { capabilityId: "world_model", label: "World Model", category: "memory", weight: 1.1, critical: false },
  { capabilityId: "temporal", label: "Temporal System", category: "memory", weight: 0.7, critical: false },
  { capabilityId: "participant_awareness", label: "Multi-Person", category: "conversation", weight: 0.7, critical: false },
  { capabilityId: "frontend_backend", label: "Frontend / Backend", category: "integration", weight: 0.8, critical: false },
  { capabilityId: "self_repair", label: "Verified Repair", category: "integration", weight: 0, critical: false },
] as const;
