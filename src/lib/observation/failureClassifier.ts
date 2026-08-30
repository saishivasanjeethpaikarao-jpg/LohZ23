/**
 * Phase 30 - failure classification (Section 7). Deterministic table;
 * the LLM never invents failure kinds.
 */
import type { FailureClassification, FailureKind, RecoveryAction } from "./types";

interface Entry extends FailureClassification { }

const T = (kind: FailureKind, severity: 1 | 2 | 3 | 4 | 5, rec: RecoveryAction): Entry => ({
  kind, retryable: true, severity, recommendedRecovery: rec,
});
const F = (kind: FailureKind, severity: 1 | 2 | 3 | 4 | 5, rec: RecoveryAction): Entry => ({
  kind, retryable: false, severity, recommendedRecovery: rec,
});

const TABLE: Record<string, Entry> = {
  // runner/step-executor codes
  timeout: T("timeout", 2, "RECHECK"),
  agent_offline: T("agent_offline", 3, "WAIT_AND_RETRY"),
  tool_exception: T("transient", 2, "RETRY"),
  tool_failed: F("tool_error", 2, "RECHECK"),
  tool_not_found: F("tool_error", 4, "REPLAN"),
  invalid_arguments: F("invalid_arguments", 3, "STOP"),
  unknown_tool: F("tool_error", 4, "REPLAN"),
  destructive_blocked: F("authorization", 5, "STOP"),
  risk_rejected: F("authorization", 5, "STOP"),
  policy_rejected: F("authorization", 5, "STOP"),
  confirmation_required: F("authorization", 1, "ASK_USER"),
  illegal_transition: F("unknown", 4, "STOP"),
  // observation layer codes
  verification_failure: F("verification_failure", 3, "REPLAN"),
  state_mismatch: F("state_mismatch", 3, "REPLAN"),
  inconclusive_verification: F("verification_failure", 2, "RECHECK"),
  dependency_failure: F("dependency_failure", 3, "REPLAN"),
  environment_failure: T("environment_failure", 3, "WAIT_AND_RETRY"),
};

const DEFAULT: Entry = { kind: "unknown", retryable: false, severity: 3, recommendedRecovery: "STOP" };

export function classifyFailure(code: string | null | undefined): FailureClassification {
  if (!code) return DEFAULT;
  return TABLE[code] ?? DEFAULT;
}
