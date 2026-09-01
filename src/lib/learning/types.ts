import type { FailureKind, VerificationVerdict } from "../observation/types";
import type { RiskLevel } from "../planner/types";

export const LEARNING_LIMITS = {
  maxExperiencesPerUser: 500,
  maxSkillsPerUser: 100,
  maxVersionsPerSkill: 20,
  maxSteps: 20,
  maxSourceExperiences: 50,
  maxTextChars: 500,
  minimumPatternSamples: 3,
  minimumRateSamples: 5,
  unreliableConsecutiveFailures: 3,
  maxLessonsPerUser: 300,
  maxReflectionsPerUser: 500,
  maxLessonSources: 50,
  maxDecisionObservationsPerUser: 1000,
  maxAdaptationsPerUser: 100,
  maxAdaptationVersions: 20,
} as const;

export type ExperienceOutcome = "success" | "failure" | "partial" | "rejected" | "awaiting_confirmation";

export interface ExperienceStep {
  stepId: string;
  index: number;
  title: string;
  toolName: string | null;
  arguments: Record<string, unknown>;
  dependencies: string[];
  expectedOutcome: string;
  riskLevel: RiskLevel;
  outcome: "completed" | "failed" | "skipped" | "blocked" | "cancelled";
  attempts: number;
  durationMs: number | null;
  failureCode: string | null;
  verification: VerificationVerdict | "NOT_APPLICABLE";
}

export interface ExperienceFailure {
  stepId: string | null;
  code: string;
  kind: FailureKind | "execution" | "user_correction";
  retryable: boolean;
}

export interface UserCorrectionEvidence {
  text: string;
  recordedAt: number;
  explicit: true;
}

/** Structured, bounded evidence. Every text/argument field is untrusted data. */
export interface ExperienceRecord {
  id: string;
  uid: string;
  objective: string;
  context: { environment: string; signature: string; tags: string[] };
  planId: string;
  planVersion: number;
  requestId: string;
  steps: ExperienceStep[];
  outcome: ExperienceOutcome;
  failures: ExperienceFailure[];
  recovery: { attempted: boolean; succeeded: boolean; actions: string[] };
  replans: { count: number; planIds: string[] };
  verification: VerificationVerdict | "NOT_APPLICABLE";
  success: boolean;
  userCorrections: UserCorrectionEvidence[];
  source: { executionRequestIds: string[]; observationIds: string[] };
  /** Phase 40 decision provenance; confidence is explicitly heuristic unless stated otherwise. */
  decision?: {
    taskType: string;
    approach: import("../adaptation/types").RoutingApproach;
    predictedConfidence: number;
    confidenceKind: import("../adaptation/types").ConfidenceKind;
  };
  createdAt: number;
  schemaVersion: 1;
}

/** Phase 39 lessons are bounded evidence records, never instructions or code. */
export type LessonType =
  | "procedural"
  | "tool_reliability"
  | "user_preference"
  | "planning"
  | "recovery"
  | "contextual";

export type LessonStatus = "candidate" | "reinforced" | "contradicted" | "stale";
export type LessonPolarity = "positive" | "negative" | "neutral";

export interface LessonRecord {
  lessonId: string;
  uid: string;
  type: LessonType;
  /** Stable normalized subject used for deduplication and contradiction checks. */
  topicKey: string;
  /** Bounded declarative data. Consumers must never interpret it as an instruction. */
  statement: string;
  polarity: LessonPolarity;
  context: { environment: string; signature: string };
  sourceExperienceIds: string[];
  evidenceCount: number;
  /** Heuristic ranking signal, not a calibrated probability. */
  confidence: number;
  confidenceKind: "heuristic";
  contradictionIds: string[];
  status: LessonStatus;
  createdAt: number;
  updatedAt: number;
  lastReinforcedAt: number;
  expiresAt: number;
  revision: number;
  safety: {
    dataOnly: true;
    executable: false;
    policyMutable: false;
    authorizationEffect: "none";
  };
  schemaVersion: 1;
}

export interface ExperienceReflection {
  reflectionId: string;
  uid: string;
  experienceId: string;
  taskType: string;
  outcome: "success" | "failure" | "partial";
  status: "completed" | "skipped";
  /** IDs only keep reflections bounded and avoid duplicating untrusted payloads. */
  lessonIds: string[];
  rejectedCandidateCodes: string[];
  generatedAt: number;
  deterministic: true;
  modelCallsUsed: 0;
  schemaVersion: 1;
}

export interface SkillStep {
  id: string;
  index: number;
  title: string;
  description: string;
  toolName: string | null;
  arguments: Record<string, unknown>;
  dependencies: string[];
  expectedOutcome: string;
  riskLevel: RiskLevel;
  timeoutMs: number;
  maxRetries: number;
}

export type SkillStatus =
  | "candidate"
  | "validated"
  | "replay_verified"
  | "pending_approval"
  | "promoted"
  | "unreliable"
  | "degraded"
  | "rejected"
  | "retired";

export interface SkillRiskProfile {
  maximumRisk: RiskLevel;
  tools: string[];
  requiresConfirmation: boolean;
  policyMutable: false;
}

/** Phase 38 — declarative input schema for parameterized skills. */
export type SkillInputType = "string" | "integer" | "boolean" | "enum";

export interface SkillInputSpec {
  type: SkillInputType;
  required: boolean;
  description?: string;
  /** Only meaningful when type === "enum". */
  enum?: string[];
  /** Optional literal default; type-matched at validation time. */
  default?: string | number | boolean;
}

export type SkillInputSchema = Record<string, SkillInputSpec>;

/** Phase 38 — registry-drift provenance for a degraded skill. */
export interface SkillDegradation {
  at: number;
  /** Bounded short code, e.g. "tool_removed:openApp" or "tool_changed:openApp". */
  reason: string;
  /** Current catalog fingerprint snapshot at the time of degradation. */
  catalogFingerprint: string | null;
}

export interface SkillMetrics {
  samples: number;
  successes: number;
  failures: number;
  successRate: number | null;
  failureRate: number | null;
}

/** Skills are versioned declarative DATA. No code, prompts, or policy overrides. */
export interface SkillVersion {
  uid: string;
  skillId: string;
  version: number;
  name: string;
  description: string;
  trigger: { signature: string; objectiveTokens: string[] };
  requiredContext: { environment: string; tags: string[] };
  stepGraph: SkillStep[];
  riskProfile: SkillRiskProfile;
  sourceExperienceIds: string[];
  metrics: SkillMetrics;
  status: SkillStatus;
  validation: { validatedAt: number | null; issues: string[] };
  replay: { verifiedAt: number | null; sourceExperienceIds: string[]; failures: string[] };
  approval: { requestedAt: number | null; approvedAt: number | null; approvalRequestId: string | null };
  createdAt: number;
  lastVerifiedAt: number | null;
  replacesVersion: number | null;
  schemaVersion: 1;
  /** Phase 38 — optional parameterized input schema (additive, backward-compatible). */
  inputSchema?: SkillInputSchema | null;
  /** Phase 38 — per-tool registry fingerprint captured at creation. */
  toolFingerprints?: Record<string, string>;
  /** Phase 38 — populated only when status === "degraded". */
  degradation?: SkillDegradation | null;
  /** Phase 38 — bumped on every mutation (transitions, new versions). */
  updatedAt?: number;
}

export interface SkillReliabilityRecord {
  uid: string;
  skillId: string;
  version: number;
  environment: string;
  attempts: number;
  verifiedSuccesses: number;
  failures: number;
  inconclusive: number;
  consecutiveFailures: number;
  successRate: number | null;
  failureRate: number | null;
  unreliable: boolean;
  failureKinds: Record<string, number>;
  updatedAt: number;
}

export interface ToolReliabilityRecord {
  uid: string;
  toolName: string;
  environment: string;
  contextSignature: string;
  samples: number;
  verifiedSuccesses: number;
  failures: number;
  inconclusive: number;
  successRate: number | null;
  failureRate: number | null;
  failureKinds: Record<string, number>;
  updatedAt: number;
}

export interface SkillSelection {
  skill: SkillVersion;
  score: number;
  reason: string;
}
