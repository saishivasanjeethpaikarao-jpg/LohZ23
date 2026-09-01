import type { FileReference, ProposedFilePatch, VerificationRun } from "./types";

export type BugSignalSource =
  | "runtime_error"
  | "test_failure"
  | "typescript_error"
  | "build_error"
  | "integration_failure"
  | "execution_failure"
  | "health_degradation"
  | "provider_failure";

export type BugIncidentStatus =
  | "observing"
  | "detected"
  | "hypothesis_ready"
  | "reproduced"
  | "candidate_verified"
  | "needs_user"
  | "repaired"
  | "dismissed";

export interface BugSignal {
  uid: string;
  source: BugSignalSource;
  component: string;
  summary: string;
  errorCode?: string | null;
  evidence?: string;
  occurredAt?: number;
  authoritative?: boolean;
}

export interface BugEvidence {
  evidenceId: string;
  kind: "signal" | "diagnostic" | "repository" | "reproduction" | "verification" | "user_correction";
  source: string;
  summary: string;
  capturedAt: number;
  authoritative: boolean;
}

export interface RootCauseHypothesis {
  summary: string;
  affectedFiles: FileReference[];
  supportingEvidenceIds: string[];
  heuristicConfidence: number;
  confidenceMeaning: "heuristic_not_probability";
  createdAt: number;
}

export type ReproductionTarget =
  | { kind: "test"; testFiles: string[] }
  | { kind: "typecheck" }
  | { kind: "build" };

export interface RepairCheckResult {
  target: ReproductionTarget;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  output: string;
}

export interface RepairAttempt {
  attempt: number;
  proposalId: string | null;
  proposalVersion: number | null;
  targeted: RepairCheckResult | null;
  regression: VerificationRun[];
  verified: boolean;
  failureCode: string | null;
  attemptedAt: number;
}

export interface BugIncident {
  uid: string;
  incidentId: string;
  fingerprint: string;
  source: BugSignalSource;
  component: string;
  status: BugIncidentStatus;
  summary: string;
  errorCode: string | null;
  occurrences: number;
  evidence: BugEvidence[];
  hypothesis: RootCauseHypothesis | null;
  reproduction: RepairCheckResult | null;
  attempts: RepairAttempt[];
  linkedProposal: { proposalId: string; version: number } | null;
  detectedAt: number | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  revision: number;
  schemaVersion: 1;
}

/** Regression records are retrieval data, never executable instructions. */
export interface RegressionMemory {
  uid: string;
  memoryId: string;
  incidentId: string;
  fingerprint: string;
  bug: string;
  cause: string;
  fix: string;
  tests: string[];
  affectedComponents: string[];
  proposalId: string;
  proposalVersion: number;
  verifiedAt: number;
  lastRetrievedAt: number | null;
  retrievalCount: number;
  untrustedData: true;
  schemaVersion: 1;
}

export interface RepairEvaluationCase {
  injectedBug: boolean;
  detected: boolean;
  diagnosisCorrect: boolean;
  repairAttempted: boolean;
  repairVerified: boolean;
  regressionPassed: boolean;
  repairProposed: boolean;
}

export interface RepairEvaluationMetrics {
  cases: number;
  injectedBugs: number;
  detectionRate: number | null;
  diagnosisAccuracy: number | null;
  repairSuccessRate: number | null;
  regressionRate: number | null;
  falseRepairRate: number | null;
}

export const REPAIR_LIMITS = {
  incidentsPerUser: 200,
  memoriesPerUser: 150,
  evidencePerIncident: 30,
  attemptsPerIncident: 2,
  signalTextChars: 4_000,
  testFilesPerRun: 12,
  retrievalResults: 8,
  repeatedSignalThreshold: 3,
  outputChars: 20_000,
} as const;

export function evaluateRepairCases(cases: RepairEvaluationCase[]): RepairEvaluationMetrics {
  const injected = cases.filter((item) => item.injectedBug);
  const detected = injected.filter((item) => item.detected);
  const attempts = injected.filter((item) => item.repairAttempted);
  const verified = attempts.filter((item) => item.repairVerified);
  const clean = cases.filter((item) => !item.injectedBug);
  const rate = (numerator: number, denominator: number): number | null => denominator ? numerator / denominator : null;
  return {
    cases: cases.length,
    injectedBugs: injected.length,
    detectionRate: rate(detected.length, injected.length),
    diagnosisAccuracy: rate(detected.filter((item) => item.diagnosisCorrect).length, detected.length),
    repairSuccessRate: rate(verified.length, attempts.length),
    regressionRate: rate(verified.filter((item) => !item.regressionPassed).length, verified.length),
    falseRepairRate: rate(clean.filter((item) => item.repairProposed).length, clean.length),
  };
}
