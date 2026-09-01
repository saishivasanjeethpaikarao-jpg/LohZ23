/**
 * Phase 38 - Versioned Skill Library schema.
 *
 * This is the PUBLIC record shape presented by SkillLibrary.get/list.
 * It is composed over the Phase-36 SkillVersion rows; storage is shared
 * (no duplicate persistence layer). Fields are added/derived, never
 * silently rewritten.
 *
 * Status vocabulary (Phase 38):
 *   - "candidate"  : just detected; awaits validation.
 *   - "verified"   : passed validation + replay; awaits human approval.
 *   - "active"     : human-approved and currently selectable.
 *   - "degraded"   : registry drift or consecutive failures; NOT
 *                    selectable; the original stepGraph is preserved
 *                    untouched and a candidate v2 exists or is expected.
 *   - "deprecated" : retired from use (rejected or retired status).
 */
import type { RiskLevel } from "../planner/types";
import type { SkillInputSchema, SkillStep, SkillRiskProfile, SkillVersion, SkillStatus } from "../learning/types";

export type LibrarySkillStatus = "candidate" | "verified" | "active" | "degraded" | "deprecated";

export interface PlanTemplate {
  steps: SkillStep[];
}

export interface Skill {
  skillId: string;
  name: string;
  description: string;
  version: number;
  inputSchema: SkillInputSchema | null;
  planTemplate: PlanTemplate;
  riskProfile: SkillRiskProfile;
  ownerUserId: string;
  status: LibrarySkillStatus;
  successCount: number;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
}

export const LIBRARY_LIMITS = {
  maxInputSchemaEntries: 8,
  maxPlaceholderNameChars: 32,
  maxDescriptionChars: 500,
} as const;

export function mapVersionStatusToLibrary(status: SkillStatus): LibrarySkillStatus {
  switch (status) {
    case "candidate": return "candidate";
    case "validated":
    case "replay_verified":
    case "pending_approval": return "verified";
    case "promoted": return "active";
    case "unreliable":
    case "degraded": return "degraded";
    case "rejected":
    case "retired": return "deprecated";
  }
}

function isoOrFallback(value: number | null | undefined, fallback: number): string {
  const ms = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return new Date(ms).toISOString();
}

export function toLibrarySkill(version: SkillVersion): Skill {
  const createdAt = isoOrFallback(version.createdAt, Date.now());
  const updatedAt = isoOrFallback(version.updatedAt ?? version.lastVerifiedAt ?? version.createdAt, version.createdAt ?? Date.now());
  const successCount = version.metrics?.successes ?? 0;
  const failureCount = version.metrics?.failures ?? 0;
  return {
    skillId: version.skillId,
    name: version.name,
    description: version.description,
    version: version.version,
    inputSchema: version.inputSchema ?? null,
    planTemplate: { steps: JSON.parse(JSON.stringify(version.stepGraph)) as SkillStep[] },
    riskProfile: JSON.parse(JSON.stringify(version.riskProfile)) as SkillRiskProfile,
    ownerUserId: version.uid,
    status: mapVersionStatusToLibrary(version.status),
    successCount,
    failureCount,
    createdAt,
    updatedAt,
  };
}

/** Library-level selection: only "active" skills are eligible. */
export function isSelectable(libraryStatus: LibrarySkillStatus): boolean {
  return libraryStatus === "active";
}

/** Library-level executability: only "active" skills may be executed. */
export function isExecutable(libraryStatus: LibrarySkillStatus): boolean {
  return libraryStatus === "active";
}

/** Convenience: the maximum risk currently declared in the plan template. */
export function planTemplateMaxRisk(template: PlanTemplate): RiskLevel {
  return template.steps.reduce<RiskLevel>((max, step) => {
    const order: Record<RiskLevel, number> = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };
    return order[step.riskLevel] > order[max] ? step.riskLevel : max;
  }, "safe");
}
