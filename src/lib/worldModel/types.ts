export type WorldScope = "environment" | "project" | "session" | "user";
export type WorldVerification = "VERIFIED" | "USER_CONFIRMED" | "UNVERIFIED" | "FAILED" | "INCONCLUSIVE";
export type WorldAssertionStatus = "active" | "superseded" | "contradicted" | "stale" | "retracted" | "unverified";
export type WorldSourceKind = "verified_observation" | "user_explicit" | "user_correction" | "memory" | "system" | "model";
export type WorldValue = string | number | boolean | null;

export interface WorldEntity {
  id: string;
  label: string;
  type: "application" | "file" | "folder" | "device" | "project" | "session" | "user" | "resource" | "other";
}

export interface WorldProvenance {
  sourceKind: WorldSourceKind;
  sourceId: string;
  observedAt: number;
  recordedAt: number;
  verification: WorldVerification;
  confidence: number;
  evidence: string;
}

export interface WorldAssertion {
  id: string;
  uid: string;
  entity: WorldEntity;
  relation: string;
  value: WorldValue;
  scope: WorldScope;
  status: WorldAssertionStatus;
  verification: WorldVerification;
  confidence: number;
  validFrom: number;
  validTo: number | null;
  observedAt: number;
  recordedAt: number;
  expiresAt: number | null;
  source: { kind: WorldSourceKind; id: string };
  provenance: WorldProvenance[];
  supersedes: string[];
  contradicts: string[];
}

export interface WorldAssertionInput {
  uid: string;
  entity: WorldEntity;
  relation: string;
  value: WorldValue;
  scope: WorldScope;
  verification: WorldVerification;
  confidence: number;
  observedAt?: number;
  source: { kind: WorldSourceKind; id: string; evidence?: string };
  /** Explicit override. Otherwise relation/scope decay policy is used. */
  ttlMs?: number | null;
}

export interface WorldQuery {
  entityId?: string;
  relation?: string;
  scope?: WorldScope;
  at?: number;
  since?: number;
  query?: string;
  limit?: number;
  includeUnverified?: boolean;
}

export interface WorldMutationResult {
  accepted: boolean;
  reason: string;
  resolution?: "added" | "reinforced" | "superseded" | "conflicted" | "recorded_unverified";
  assertion?: WorldAssertion;
}

export interface WorldStateDocument {
  uid: string;
  schemaVersion: 1;
  assertions: WorldAssertion[];
  updatedAt: number;
}

export interface WorldDecayPolicy {
  defaultByScopeMs: Record<WorldScope, number | null>;
  relationTtlMs: Record<string, number | null>;
}

export const WORLD_MODEL_LIMITS = {
  assertionsPerUser: 500,
  queryResults: 20,
  provenancePerAssertion: 8,
  linksPerAssertion: 12,
  entityChars: 160,
  relationChars: 64,
  valueChars: 500,
  evidenceChars: 400,
} as const;

export const DEFAULT_WORLD_DECAY: WorldDecayPolicy = {
  defaultByScopeMs: {
    environment: 30 * 60_000,
    session: 4 * 60 * 60_000,
    project: 30 * 24 * 60 * 60_000,
    user: 365 * 24 * 60 * 60_000,
  },
  relationTtlMs: {
    STATUS: 30 * 60_000,
    OUTPUT_VOLUME: 10 * 60_000,
    ACTIVE: 30 * 60_000,
    EXISTS: 24 * 60 * 60_000,
    USES: 180 * 24 * 60 * 60_000,
    PREFERS: null,
    IDENTITY: null,
  },
};

export function isAuthoritativeVerification(value: WorldVerification): boolean {
  return value === "VERIFIED" || value === "USER_CONFIRMED";
}
