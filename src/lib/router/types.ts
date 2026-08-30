/**
 * Phase 27 — Fast Intent Router types.
 *
 * Closed vocabularies, bounded entities, explicit risk/tier/lifecycle
 * enums. The router is deterministic-first: no network, no LLM, no
 * Firestore for classification.
 */

export type ProcessingTier = "tier0_direct" | "tier1_light" | "tier2_reasoning" | "tier3_autonomous";

export const INTENT_VOCABULARY = [
  // device/tool intents (Tier 0 candidates)
  "open_app", "close_app", "focus_app",
  "open_url", "clipboard_read", "clipboard_write",
  "screenshot", "volume_get", "volume_set", "system_info",
  // light conversational intents (Tier 1)
  "chat", "memory_query", "context_query",
  // reasoning intents (Tier 2)
  "reason", "explain", "compare", "summarize",
  // autonomous intents (Tier 3)
  "plan", "execute_task", "manage_goal",
  "unknown",
] as const;

export type Intent = (typeof INTENT_VOCABULARY)[number];

export type RiskLevel = "safe" | "low" | "medium" | "high" | "critical";

/** Bounded entity set — no arbitrary user-data keys. */
export interface RouteEntities {
  appName?: string;
  url?: string;
  volumeLevel?: number;
  filePath?: string;
  text?: string;
  goalId?: string;
  projectKey?: string;
}

export interface RoutingResult {
  tier: ProcessingTier;
  intent: Intent;
  confidence: number;
  entities: RouteEntities;
  requiresMemory: boolean;
  requiresContext: boolean;
  requiresReasoning: boolean;
  requiresPlanning: boolean;
  requiresTool: boolean;
  riskLevel: RiskLevel;
  /** Set when a referent could not be resolved ("open it"). */
  needsClarification?: string;
}

export type LifecycleStage =
  | "RECEIVED" | "CLASSIFIED" | "ROUTED" | "AUTHORIZED"
  | "EXECUTED" | "OBSERVED" | "COMPLETED" | "PLANNED"
  | "AWAITING_CONFIRMATION" | "ASK" | "REJECT";

/** Bounded diagnostic record — never contains credentials/content. */
export interface RouteDiagnostic {
  requestId: string;
  userId: string;
  intent: Intent;
  tier: ProcessingTier;
  confidence: number;
  latencyMs: number;
  success: boolean;
  risk: RiskLevel;
  toolUsed: string | null;
  modelUsed: string | null;
  modelCalls: number;
  lifecycle: LifecycleStage[];
  errorKind?: string; // coarse kind only ("tool_failed"), never messages
}

/** Confidence thresholds (§6). */
export const CONFIDENCE = {
  exactCommand: 0.98,
  clearPattern: 0.9,
  ambiguousFloor: 0.6,
  unknownCeiling: 0.5,
  clarifyBelow: 0.75,
} as const;

/** Risk classification per intent (§8). Tier 0 table only; others default low. */
export const INTENT_RISK: Record<Intent, RiskLevel> = {
  open_app: "safe", close_app: "low", focus_app: "safe",
  open_url: "safe", clipboard_read: "low", clipboard_write: "medium",
  screenshot: "low", volume_get: "safe", volume_set: "safe",
  system_info: "safe",
  chat: "safe", memory_query: "safe", context_query: "safe",
  reason: "safe", explain: "safe", compare: "safe", summarize: "safe",
  plan: "low", execute_task: "medium", manage_goal: "low",
  unknown: "low",
};

const TIER0_INTENTS = new Set<Intent>([
  "open_app", "close_app", "focus_app", "open_url", "screenshot",
  "volume_get", "volume_set", "system_info", "clipboard_read", "clipboard_write",
]);
const TIER1_INTENTS = new Set<Intent>(["chat", "memory_query", "context_query"]);
const TIER2_INTENTS = new Set<Intent>(["reason", "explain", "compare", "summarize"]);

export function tierForIntent(intent: Intent): ProcessingTier {
  if (TIER0_INTENTS.has(intent)) return "tier0_direct";
  if (TIER1_INTENTS.has(intent)) return "tier1_light";
  if (TIER2_INTENTS.has(intent)) return "tier2_reasoning";
  return "tier3_autonomous";
}
