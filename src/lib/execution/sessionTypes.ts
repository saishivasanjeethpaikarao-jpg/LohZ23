import type { RiskLevel } from "../planner/types";

export type ExecutionSessionStatus =
  | "created"
  | "running"
  | "paused"
  | "awaiting_reauthorization"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type ResumeVerificationStatus = "VERIFIED" | "FAILED" | "INCONCLUSIVE";

export interface SessionAuthorizationScope {
  grantId: string;
  grantedBy: "authenticated_user";
  grantedAt: number;
  expiresAt: number;
  objectiveDigest: string;
  planId: string;
  planVersion: number;
  allowedTools: string[];
  maxRisk: RiskLevel;
  /** High-risk confirmation is deliberately short-lived and plan-version bound. */
  confirmed: boolean;
  revokedAt: number | null;
}

export interface ExecutionCheckpoint {
  checkpointId: string;
  sequence: number;
  planId: string;
  planVersion: number;
  requestId: string;
  executionRecordVersion: number | null;
  completedStepIds: string[];
  verificationStatus: ResumeVerificationStatus;
  worldStateToken: string | null;
  recordedAt: number;
  note: string;
  nextAction: string | null;
}

export interface ExecutionSession {
  sessionId: string;
  userId: string;
  objective: string;
  objectiveDigest: string;
  planId: string;
  planVersion: number;
  requestId: string;
  status: ExecutionSessionStatus;
  currentCheckpoint: ExecutionCheckpoint | null;
  checkpoints: ExecutionCheckpoint[];
  authorizationScope: SessionAuthorizationScope;
  createdAt: number;
  updatedAt: number;
  timeoutAt: number;
  nextAction: string | null;
  interruptionReason: string | null;
  failure: { code: string; message: string; retryable: boolean } | null;
  version: number;
}

export interface SessionLease {
  sessionId: string;
  userId: string;
  workerId: string;
  leaseToken: string;
  fencingToken: number;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

export interface SessionLeaseClaim {
  workerId: string;
  leaseToken: string;
  fencingToken: number;
}

export interface ResumeVerification {
  status: ResumeVerificationStatus;
  reason: string;
  worldStateToken?: string | null;
}

export const EXECUTION_SESSION_LIMITS = {
  maxObjectiveChars: 500,
  maxNextActionChars: 300,
  maxCheckpoints: 50,
  maxCompletedStepIds: 100,
  minAuthorizationTtlMs: 1_000,
  maxAuthorizationTtlMs: 60 * 60 * 1_000,
  defaultAuthorizationTtlMs: 15 * 60 * 1_000,
  minSessionTimeoutMs: 60_000,
  maxSessionTimeoutMs: 7 * 24 * 60 * 60 * 1_000,
  defaultSessionTimeoutMs: 24 * 60 * 60 * 1_000,
  minLeaseTtlMs: 1_000,
  maxLeaseTtlMs: 60_000,
  defaultLeaseTtlMs: 15_000,
  defaultCheckpointMaxAgeMs: 30 * 60 * 1_000,
} as const;

export const TERMINAL_SESSION_STATUSES: ReadonlySet<ExecutionSessionStatus> = new Set([
  "completed", "failed", "cancelled", "timed_out",
]);
