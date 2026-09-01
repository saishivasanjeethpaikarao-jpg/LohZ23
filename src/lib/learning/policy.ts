import type { ExperienceRecord, SkillStep, SkillVersion } from "./types";
import { LEARNING_LIMITS } from "./types";
import { validateInputSchema, PLACEHOLDER_PATTERN, INPUT_NAME_PATTERN } from "./inputs";

export const IMMUTABLE_SECURITY_DOMAINS = [
  "authentication", "authorization", "security policy", "credential handling",
  "dangerous-tool restriction", "user ownership", "bypass confirmation",
] as const;

const RISK_ORDER = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 } as const;

export interface SkillValidationResult { ok: boolean; issues: string[]; }

export function validateStepGraph(steps: SkillStep[]): string[] {
  const issues: string[] = [];
  if (!Array.isArray(steps)) return ["invalid_step_graph"];
  if (steps.length === 0 || steps.length > LEARNING_LIMITS.maxSteps) issues.push("invalid_step_count");
  const risks = new Set(["safe", "low", "medium", "high", "critical"]);
  for (const step of steps) {
    if (!step || typeof step !== "object" || typeof step.id !== "string" || !step.id || step.id.length > 120
      || !Number.isInteger(step.index) || typeof step.title !== "string" || typeof step.description !== "string"
      || (step.toolName !== null && typeof step.toolName !== "string") || !Array.isArray(step.dependencies)
      || typeof step.expectedOutcome !== "string" || !risks.has(step.riskLevel)
      || !Number.isFinite(step.timeoutMs) || step.timeoutMs < 1_000 || step.timeoutMs > 120_000
      || !Number.isInteger(step.maxRetries) || step.maxRetries < 0 || step.maxRetries > 2
      || !step.arguments || typeof step.arguments !== "object" || Array.isArray(step.arguments)) {
      issues.push("invalid_step_shape");
    }
  }
  if (issues.includes("invalid_step_shape")) return [...new Set(issues)];
  const ids = new Set(steps.map((step) => step.id));
  if (ids.size !== steps.length) issues.push("duplicate_step_id");
  for (const step of steps) {
    if (step.dependencies.some((dependency) => !ids.has(dependency) || dependency === step.id)) issues.push("invalid_dependency");
    if ((step as unknown as Record<string, unknown>).code || (step as unknown as Record<string, unknown>).script) issues.push("executable_code_forbidden");
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) if (!visit(dependency)) return false;
    visiting.delete(id); visited.add(id); return true;
  };
  if (![...ids].every(visit)) issues.push("cyclic_step_graph");
  return [...new Set(issues)];
}

export function validateSkillCandidate(skill: SkillVersion, experiences: ExperienceRecord[], toolCatalog: string[]): SkillValidationResult {
  const issues = validateStepGraph(skill.stepGraph);
  if (skill.riskProfile.policyMutable !== false) issues.push("policy_mutation_forbidden");
  if (skill.sourceExperienceIds.length < LEARNING_LIMITS.minimumPatternSamples) issues.push("insufficient_verified_experience");
  if (experiences.some((item) => item.uid !== skill.uid)) issues.push("cross_user_source");
  const sources = experiences.filter((item) => skill.sourceExperienceIds.includes(item.id));
  if (sources.length !== skill.sourceExperienceIds.length) issues.push("missing_source_experience");
  if (sources.some((item) => !item.success || !["VERIFIED", "NOT_APPLICABLE"].includes(item.verification))) issues.push("unverified_source_experience");
  if (new Set(sources.map((item) => item.context.signature)).size > 1) issues.push("inconsistent_pattern_signature");
  for (const step of skill.stepGraph) if (step.toolName && !toolCatalog.includes(step.toolName)) issues.push("unknown_tool");
  if (skill.riskProfile.maximumRisk === "critical") issues.push("critical_skill_forbidden");
  const text = `${skill.name} ${skill.description} ${skill.stepGraph.map((step) => `${step.title} ${step.description}`).join(" ")}`.toLowerCase();
  if (IMMUTABLE_SECURITY_DOMAINS.some((domain) => text.includes(domain))) issues.push("security_domain_change_forbidden");
  const maxStepRisk = skill.stepGraph.reduce((max, step) => Math.max(max, RISK_ORDER[step.riskLevel]), 0);
  if (maxStepRisk !== RISK_ORDER[skill.riskProfile.maximumRisk]) issues.push("risk_profile_mismatch");

  // Phase 38 — input schema validation + placeholder consistency.
  // Placeholders are scanned UNCONDITIONALLY: a "${name}" string without a
  // declared schema is corruption/injection evidence, not legitimate data.
  if (skill.inputSchema != null) {
    const schemaCheck = validateInputSchema(skill.inputSchema);
    if (!schemaCheck.ok) issues.push(...schemaCheck.issues.map((item) => `input_schema:${item}`));
  }
  const declared = new Set(Object.keys(skill.inputSchema ?? {}));
  for (const step of skill.stepGraph) {
    for (const v of Object.values(step.arguments ?? {})) {
      if (typeof v !== "string") continue;
      const m = PLACEHOLDER_PATTERN.exec(v);
      if (m) {
        if (!INPUT_NAME_PATTERN.test(m[1])) issues.push(`invalid_placeholder_name:${m[1]}`);
        else if (!declared.has(m[1])) issues.push(`undeclared_placeholder:${m[1]}`);
      } else if (v.includes("${")) {
        issues.push(`partial_placeholder:${step.id}`);
      }
    }
  }

  return { ok: issues.length === 0, issues: [...new Set(issues)] };
}
