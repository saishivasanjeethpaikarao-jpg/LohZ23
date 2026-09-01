/**
 * Phase 38 - declarative skill input handling.
 *
 * Two responsibilities:
 *   1. validateSkillInputSchema — schema shape, type/enum bounds.
 *   2. materializeStepArguments — resolve "${inputName}" placeholders in
 *      a skill's captured argument map against user-supplied inputs, with
 *      schema-declared defaults as fallback.
 *
 * Deterministic. No model calls. No mutation of stored data.
 *
 * Placeholder rule (strict by design):
 *   - A placeholder is a STRING value that exactly matches /^\$\{name\}\$/.
 *   - Any string CONTAINING "${" that does NOT match the full pattern is
 *     rejected as `partial_placeholder` (prevents partial interpolation
 *     smuggling).
 *   - Every declared placeholder name must exist in the schema.
 *   - Non-placeholder scalar values pass through verbatim (they were
 *     verified at acquisition time and must never be silently rewritten).
 */
import type { SkillInputSchema, SkillInputSpec, SkillInputType } from "./types";

export const PLACEHOLDER_PATTERN = /^\$\{([a-z][A-Za-z0-9_]{0,31})\}$/;
export const INPUT_NAME_PATTERN = /^[a-z][A-Za-z0-9_]{0,31}$/;

export interface MaterializeIssue {
  stepId: string;
  code: string;
  detail: string;
}

export interface MaterializeResult {
  ok: boolean;
  /** New argument maps, parallel to input steps (same order, same ids). */
  steps: Array<{ id: string; arguments: Record<string, unknown> }>;
  issues: MaterializeIssue[];
}

/** Schema shape + per-spec validation. */
export function validateInputSchema(schema: unknown): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (schema == null) return { ok: true, issues: [] };
  if (typeof schema !== "object" || Array.isArray(schema)) {
    return { ok: false, issues: ["invalid_input_schema_root"] };
  }
  const entries = Object.entries(schema as Record<string, unknown>);
  if (entries.length > 8) issues.push("input_schema_too_large");
  for (const [key, raw] of entries) {
    if (!INPUT_NAME_PATTERN.test(key)) issues.push(`invalid_input_name:${key}`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      issues.push(`invalid_input_spec:${key}`);
      continue;
    }
    const spec = raw as Record<string, unknown>;
    const type = spec.type;
    if (!isSkillInputType(type)) {
      issues.push(`invalid_input_type:${key}`);
      continue;
    }
    if (typeof spec.required !== "boolean") {
      issues.push(`invalid_required_field:${key}`);
    }
    if (spec.description !== undefined) {
      if (typeof spec.description !== "string" || spec.description.length > 120) {
        issues.push(`invalid_description:${key}`);
      }
    }
    if (type === "enum") {
      if (!Array.isArray(spec.enum) || spec.enum.length === 0 || spec.enum.length > 12) {
        issues.push(`invalid_enum_options:${key}`);
      } else if (spec.enum.some((v) => typeof v !== "string" || v.length === 0 || v.length > 120)) {
        issues.push(`invalid_enum_value:${key}`);
      }
    }
    if (spec.default !== undefined) {
      if (!isTypeMatch(type, spec.default)) {
        issues.push(`default_type_mismatch:${key}`);
      }
      if (type === "enum" && Array.isArray(spec.enum)) {
        if (!spec.enum.includes(String(spec.default))) {
          issues.push(`default_not_in_enum:${key}`);
        }
      }
    }
  }
  return { ok: issues.length === 0, issues: dedupe(issues) };
}

function isSkillInputType(v: unknown): v is SkillInputType {
  return v === "string" || v === "integer" || v === "boolean" || v === "enum";
}

function isTypeMatch(type: SkillInputType, v: unknown): boolean {
  if (type === "string") return typeof v === "string" && v.length <= 500;
  if (type === "integer") return typeof v === "number" && Number.isInteger(v);
  if (type === "boolean") return typeof v === "boolean";
  if (type === "enum") return typeof v === "string" && v.length > 0 && v.length <= 120;
  return false;
}

/**
 * Validate user-supplied inputs against a schema. Reject extra keys
 * (fail-closed), missing required keys, type/enum mismatches, and
 * oversized scalar values. Returns per-input issue list.
 */
export function validateInputs(
  schema: SkillInputSchema | null | undefined,
  inputs: Record<string, unknown> | undefined
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (schema == null) {
    if (inputs && Object.keys(inputs).length > 0) issues.push("inputs_not_accepted");
    return { ok: issues.length === 0, issues };
  }
  const provided = inputs ?? {};
  const keys = Object.keys(provided);
  if (keys.length > 8) issues.push("inputs_too_many");
  for (const key of keys) {
    if (!INPUT_NAME_PATTERN.test(key)) {
      issues.push(`invalid_input_name:${key}`);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      issues.push(`unknown_input:${key}`);
      continue;
    }
    const spec = schema[key];
    if (!isTypeMatch(spec.type, provided[key])) issues.push(`input_type_mismatch:${key}`);
    if (spec.type === "enum" && spec.enum && typeof provided[key] === "string" && !spec.enum.includes(provided[key])) {
      issues.push(`input_not_in_enum:${key}`);
    }
  }
  for (const [key, spec] of Object.entries(schema)) {
    if (spec.required && !Object.prototype.hasOwnProperty.call(provided, key)) {
      issues.push(`missing_required_input:${key}`);
    }
  }
  return { ok: issues.length === 0, issues: dedupe(issues) };
}

/**
 * Resolve "${inputName}" placeholders inside the stored arguments of each
 * step. Inputs that fail to resolve (missing required) cause that step's
 * arguments to be marked invalid. The step graph topology is preserved —
 * only the `arguments` map is rewritten. Non-placeholder values pass
 * through verbatim.
 *
 * `schema = null/undefined` means the skill has no declared inputs; any
 * placeholder found in the stored arguments is a structural defect and
 * will be rejected (we never silently ship literal "${...}" strings).
 */
export function materializeStepArguments(
  steps: Array<{ id: string; arguments: Record<string, unknown> }>,
  schema: SkillInputSchema | null | undefined,
  inputs: Record<string, unknown> | undefined
): MaterializeResult {
  const issues: MaterializeIssue[] = [];
  const out: MaterializeResult["steps"] = [];
  const provided = inputs ?? {};
  const isPlaceholder = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const m = PLACEHOLDER_PATTERN.exec(v);
    return m ? m[1] : (v.includes("${") ? "__INVALID__" : null);
  };
  for (const step of steps) {
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(step.arguments ?? {})) {
      const placeholder = isPlaceholder(v);
      if (placeholder === "__INVALID__") {
        issues.push({ stepId: step.id, code: "partial_placeholder", detail: k });
        out.push({ id: step.id, arguments: next });
        continue;
      }
      if (placeholder === null) {
        next[k] = v;
        continue;
      }
      // Placeholder resolution.
      if (schema == null) {
        issues.push({ stepId: step.id, code: "undeclared_placeholder", detail: placeholder });
        out.push({ id: step.id, arguments: next });
        continue;
      }
      const spec = schema[placeholder];
      if (!spec) {
        issues.push({ stepId: step.id, code: "undeclared_placeholder", detail: placeholder });
        out.push({ id: step.id, arguments: next });
        continue;
      }
      const supplied = Object.prototype.hasOwnProperty.call(provided, placeholder) ? provided[placeholder] : undefined;
      const resolved = supplied !== undefined ? supplied : spec.default;
      if (resolved === undefined) {
        if (spec.required) issues.push({ stepId: step.id, code: "missing_required_input", detail: placeholder });
        // non-required + no default → argument dropped (the step simply omits the key)
        continue;
      }
      if (!isTypeMatch(spec.type, resolved)) {
        issues.push({ stepId: step.id, code: "input_type_mismatch", detail: placeholder });
        continue;
      }
      next[k] = resolved;
    }
    out.push({ id: step.id, arguments: next });
  }
  return { ok: issues.length === 0, steps: out, issues };
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export const __test__ = { isTypeMatch, isSkillInputType };
export type { SkillInputSpec };
