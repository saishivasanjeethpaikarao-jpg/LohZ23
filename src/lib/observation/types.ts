/**
 * Phase 30 - observation/verification/recovery types.
 * Bounded records, closed vocabularies, centralized limits.
 */

export type ObservationStatus =
  | "observed" | "verified" | "contradicted" | "inconclusive";

export type VerificationLevel =
  | "NONE" | "TOOL_RESULT" | "STATE_CHECK" | "MULTI_SIGNAL" | "MODEL_ASSISTED";

/** The ONLY verdicts verification may produce. */
export type VerificationVerdict = "VERIFIED" | "FAILED" | "INCONCLUSIVE";

/** Closed failure vocabulary (Section 7) - no LLM-invented kinds. */
export const FAILURE_KINDS = [
  "transient", "tool_error", "invalid_arguments", "authorization",
  "agent_offline", "timeout", "state_mismatch", "dependency_failure",
  "environment_failure", "verification_failure", "unknown",
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export type RecoveryAction =
  | "RETRY" | "RECHECK" | "WAIT_AND_RETRY"
  | "ALTERNATIVE_ALLOWED_TOOL" | "REPLAN" | "ASK_USER" | "STOP";

export interface FailureClassification {
  kind: FailureKind;
  retryable: boolean;
  severity: 1 | 2 | 3 | 4 | 5;
  recommendedRecovery: RecoveryAction;
}

/** Centralized bounds (Section 8, 17). */
export const RECOVERY_LIMITS = {
  maxRecoveryAttempts: 2,
  maxReplans: 2,
  maxExecutionDepth: 5,
  backoffMinMs: 100,
  backoffMaxMs: 500,
} as const;

export const OBSERVATION_LIMITS = {
  perStep: 8,
  perPlan: 20,
  summaryChars: 400,
  observedResultChars: 2000,
} as const;

export interface Observation {
  id: string;
  uid: string;
  planId: string;
  stepId: string;
  requestId: string;
  timestamp: number;
  source: "probe" | "tool_result" | "recheck" | "model";
  observedState: string; // <= summaryChars
  evidence: string;      // <= summaryChars
  confidence: number;    // 0..1
  status: ObservationStatus;
}

/** Probe tools that are read-only and safe to run for state checks. */
export const PROBE_SAFE_TOOLS = new Set([
  "listWindows", "getVolume", "clipboardRead", "readFile", "getSystemInfo",
]);

export function sanitizeEvidence(text: string, limit = OBSERVATION_LIMITS.summaryChars): string {
  // Strip credential-looking content; bound length.
  const redacted = String(text ?? "")
    .replace(/(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .replace(/-----[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*KEY-----/g, "<redacted-key>")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length <= limit ? redacted : redacted.slice(0, limit - 1) + "…";
}
