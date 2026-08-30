/**
 * Phase 28 - plan confidence scoring + plan-level risk (Section 10, 12).
 * Deterministic only.
 */
import type { PlanStep, RiskLevel } from "./types";

const RISK_RANK: Record<RiskLevel, number> = {
  safe: 0, low: 1, medium: 2, high: 3, critical: 4,
};

export function planRisk(steps: PlanStep[]): RiskLevel {
  let max: RiskLevel = "safe";
  for (const s of steps) {
    if (RISK_RANK[s.riskLevel] > RISK_RANK[max]) max = s.riskLevel;
  }
  return max;
}

export interface ConfidenceInput {
  intentConfidence: number;        // router classification confidence
  toolsAvailableRatio: number;     // 0..1 of steps whose requiredTool exists
  contextCompleteness: number;     // 0..1 heuristic from PlannerContext
  dependencyCertainty: number;     // 1 when graph valid, else 0
  modelConfidence?: number;        // present for model-assisted plans
}

export function scoreConfidence(input: ConfidenceInput): number {
  const base =
    input.intentConfidence * 0.45 +
    input.toolsAvailableRatio * 0.2 +
    input.contextCompleteness * 0.15 +
    input.dependencyCertainty * 0.1 +
    (input.modelConfidence ?? input.intentConfidence) * 0.1;
  return Math.max(0, Math.min(1, base));
}
