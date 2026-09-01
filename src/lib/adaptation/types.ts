export type RoutingApproach =
  | "deterministic"
  | "clarification"
  | "model_reasoning"
  | "planner"
  | "known_skill"
  | "recovery_strategy";

export type DecisionActualOutcome = "VERIFIED_SUCCESS" | "VERIFIED_FAILURE" | "INCONCLUSIVE" | "NOT_APPLICABLE";
export type ConfidenceKind = "heuristic" | "provider_calibrated";

export interface DecisionObservation {
  observationId: string;
  uid: string;
  requestId: string;
  taskType: string;
  approach: RoutingApproach;
  predictedConfidence: number;
  confidenceKind: ConfidenceKind;
  actualOutcome: DecisionActualOutcome;
  source: "execution" | "router" | "user_correction";
  environment: string;
  createdAt: number;
  schemaVersion: 1;
}

export interface CalibrationBin {
  lower: number;
  upper: number;
  samples: number;
  meanScore: number;
  empiricalSuccessRate: number;
}

export interface CalibrationMetrics {
  uid: string;
  taskType: string | null;
  confidenceKind: ConfidenceKind;
  status: "insufficient_evidence" | "measured";
  sampleSize: number;
  meanScore: number | null;
  empiricalSuccessRate: number | null;
  meanAbsoluteGap: number | null;
  diagnosticBrierScore: number | null;
  bins: CalibrationBin[];
  generatedAt: number;
  /** Explicit warning: heuristic scores are not asserted to be probabilities. */
  interpretation: "heuristic_score_diagnostic" | "calibrated_probability_diagnostic";
}

export type AdaptationStatus = "candidate" | "evaluated" | "pending_approval" | "deployed" | "rejected" | "retired";

export interface AdaptationVersion {
  uid: string;
  adaptationId: string;
  version: number;
  taskType: string;
  recommendedApproach: RoutingApproach;
  baselineApproach: RoutingApproach;
  evidenceObservationIds: string[];
  evaluation: {
    samples: number;
    recommendedSuccessRate: number;
    baselineSuccessRate: number;
    improvement: number;
    evaluatedAt: number | null;
    issues: string[];
  };
  status: AdaptationStatus;
  approval: { requestedAt: number | null; approvedAt: number | null; approvalRequestId: string | null };
  createdAt: number;
  updatedAt: number;
  replacesVersion: number | null;
  safety: {
    policyMutable: false;
    authorizationEffect: "none";
    riskReductionAllowed: false;
    toolArgumentsMutable: false;
  };
  schemaVersion: 1;
}

export interface PersonalizationEvidenceItem {
  value: string;
  evidenceCount: number;
  source: "explicit_preference_lesson" | "verified_experience" | "user_model";
}

export interface PersonalizationSnapshot {
  uid: string;
  communicationStyles: PersonalizationEvidenceItem[];
  preferredApplications: PersonalizationEvidenceItem[];
  preferredOutputFormats: PersonalizationEvidenceItem[];
  recurringWorkflows: PersonalizationEvidenceItem[];
  recurringProjects: PersonalizationEvidenceItem[];
  interactionPatterns: PersonalizationEvidenceItem[];
  generatedAt: number;
  sensitiveInferencePerformed: false;
}

export interface AdaptiveRecommendation {
  taskType: string;
  approach: RoutingApproach;
  adaptationId: string;
  version: number;
  evidenceSamples: number;
  /** A recommendation never carries authority, tool args, or policy changes. */
  advisoryOnly: true;
}

