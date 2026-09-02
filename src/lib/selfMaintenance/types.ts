export type MaintenanceHealthStatus = "HEALTHY" | "DEGRADED" | "WARNING" | "FAILING" | "UNKNOWN" | "UNAVAILABLE";
export type HealthCheckMode = "lightweight" | "standard" | "deep";
export type DiagnosticSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type DiagnosticConfidence = "HIGH" | "MEDIUM" | "LOW";
export type MaintenanceRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface HealthCheckResult {
  status: MaintenanceHealthStatus;
  score: number | null;
  confidence: number | null;
  checkedAt: number;
  checksPerformed: string[];
  failures: string[];
  warnings: string[];
  evidence: string[];
  dependencies: string[];
  degradationReason?: string;
  durationMs?: number;
}

export interface HealthSubsystemResult extends HealthCheckResult {
  subsystem: string;
  category: string;
  weight: number;
}

export interface HealthSnapshot {
  snapshotId: string;
  generatedAt: number;
  mode: HealthCheckMode;
  overallScore: number | null;
  status: MaintenanceHealthStatus;
  subsystems: HealthSubsystemResult[];
}

export interface DiagnosticInput {
  incidentId?: string;
  subsystem: string;
  symptom: string;
  severity?: DiagnosticSeverity;
  evidence?: Array<{ source: string; detail: string; authoritative?: boolean }>;
  recentChanges?: string[];
}

export interface DiagnosticResult {
  incidentId: string;
  subsystem: string;
  symptom: string;
  severity: DiagnosticSeverity;
  evidence: Array<{ source: string; detail: string; authoritative: boolean }>;
  probableCauses: Array<{ cause: string; confidence: DiagnosticConfidence; basis: string }>;
  affectedCapabilities: string[];
  recommendedInvestigation: string[];
  recommendedRemediation: string[];
  generatedAt: number;
}

export interface MaintenanceRecord {
  recordId: string;
  ownerUid: string;
  incidentId: string;
  diagnosis: DiagnosticResult;
  proposalId?: string;
  affectedFiles: string[];
  validation: Array<{ check: string; passed: boolean; detail: string }>;
  approval: "PROPOSED" | "UNDER_REVIEW" | "APPROVED" | "REJECTED" | "VALIDATED" | "PROMOTED" | "ROLLED_BACK";
  outcome: "open" | "rejected" | "validated" | "promoted" | "rolled_back" | "failed";
  createdAt: number;
  updatedAt: number;
}
