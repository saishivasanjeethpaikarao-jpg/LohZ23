/**
 * Phase 38 - tool registry fingerprint.
 *
 * Captures a stable hash of a tool's published surface (name + risk level +
 * normalized parameter schema). Body code is intentionally NOT included
 * (any code change inside `validate`/`execute` is out of scope for
 * versioning because the existing registry's parameter schema is the only
 * contract planners and the executor consume).
 *
 * Drift detection compares the fingerprint recorded on a skill version
 * (per-tool) against the current registry. A mismatch marks the skill as
 * "degraded" — the original stepGraph is preserved and a candidate v2 is
 * queued for re-validation; the skill itself is never silently mutated.
 */
import { createHash } from "node:crypto";

export interface ToolFingerprintInput {
  name: string;
  /** Registry risk string ("LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "SAFE") or already-lowercased. */
  risk: string;
  parameters: unknown;
}

const PARAM_FIELD_WHITELIST = new Set(["type", "required", "properties", "items", "enum", "description", "additionalProperties", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "nullable"]);

/** Deterministic stable stringifier that strips non-contract metadata. */
export function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undef";
  if (typeof value === "number") return Number.isFinite(value) ? `n:${value}` : "n:NaN";
  if (typeof value === "boolean") return value ? "b:true" : "b:false";
  if (typeof value === "string") return `s:${JSON.stringify(value)}`;
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((key) => PARAM_FIELD_WHITELIST.has(key)).sort((a, b) => a.localeCompare(b));
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`);
    return `{${parts.join(",")}}`;
  }
  return "undef";
}

function normalizeRisk(risk: unknown): string {
  return String(risk ?? "").toUpperCase();
}

export function toolRecordFingerprint(tool: ToolFingerprintInput): string {
  const surface = JSON.stringify({
    name: String(tool.name ?? ""),
    risk: normalizeRisk(tool.risk),
    parameters: stableStringify(tool.parameters),
  });
  return createHash("sha256").update(surface).digest("hex").slice(0, 16);
}

export function catalogFingerprint(perTool: Record<string, string>): string | null {
  const keys = Object.keys(perTool);
  if (keys.length === 0) return null;
  const ordered = keys.sort();
  const material = ordered.map((key) => `${JSON.stringify(key)}:${perTool[key]}`).join(",");
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}
