export type ChangeKind = "bug_fix" | "feature";
export type ProposalStatus =
  | "draft"
  | "proposed"
  | "sandbox_verified"
  | "pending_approval"
  | "approved"
  | "applying"
  | "applied"
  | "rejected"
  | "verification_failed"
  | "apply_failed";

export type VerificationCheck = "tests" | "typecheck" | "build" | "security";

export interface FileReference {
  path: string;
  sha256: string;
  size: number;
  kind: "source" | "test" | "config" | "documentation";
}

export interface SearchHit {
  path: string;
  line: number;
  preview: string;
}

export interface DependencyRelationship {
  from: string;
  specifier: string;
  resolvedPath: string | null;
  kind: "static_import" | "dynamic_import" | "require";
}

/** Exact text replacements only. There is no delete-file operation. */
export interface ProposedFilePatch {
  path: string;
  operation: "create" | "update";
  expectedSha256: string | null;
  hunks: Array<{ oldText: string; newText: string }>;
}

export interface VerificationRun {
  check: VerificationCheck;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  output: string;
}

export interface SecurityEvaluation {
  passed: boolean;
  checkedAt: number;
  policyVersion: 1;
  issues: string[];
}

export interface ChangeApproval {
  requestId: string | null;
  requestedAt: number | null;
  approvedAt: number | null;
  approvedBy: string | null;
  approvedDigest: string | null;
}

export interface CodeChangeProposal {
  uid: string;
  proposalId: string;
  version: number;
  kind: ChangeKind;
  status: ProposalStatus;
  title: string;
  reason: string;
  requirement: string;
  diagnosis: string;
  rootCauseHypothesis: string;
  affectedFiles: FileReference[];
  dependencySummary: DependencyRelationship[];
  patches: ProposedFilePatch[];
  tests: string[];
  verification: VerificationRun[];
  security: SecurityEvaluation | null;
  approval: ChangeApproval;
  proposalDigest: string;
  createdAt: number;
  updatedAt: number;
  appliedAt: number | null;
  revision: number;
  schemaVersion: 1;
}

export interface CodeChangeAuditEvent {
  uid: string;
  eventId: string;
  proposalId: string;
  proposalVersion: number;
  type:
    | "proposal_created"
    | "verification_completed"
    | "approval_requested"
    | "approved"
    | "rejected"
    | "apply_started"
    | "applied"
    | "apply_failed";
  actor: "system" | "authenticated_user";
  actorUid: string | null;
  proposalDigest: string;
  details: string;
  timestamp: number;
}

export interface DiagnosticArtifact {
  artifactId: string;
  kind: "build_output" | "error_log";
  content: string;
  capturedAt: number;
}

export const SELF_CODING_LIMITS = {
  maxFileBytes: 256_000,
  maxFilesPerList: 2_000,
  maxSearchHits: 100,
  maxSearchQueryChars: 120,
  maxAffectedFiles: 30,
  maxPatches: 30,
  maxHunksPerPatch: 30,
  maxPatchTextChars: 200_000,
  maxVerificationOutputChars: 20_000,
  maxAuditDetailChars: 1_000,
  maxArtifactChars: 100_000,
  maxProposalsPerUser: 100,
  verificationTimeoutMs: 5 * 60 * 1_000,
} as const;
