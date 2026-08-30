/**
 * Phase 29 - execution authorization policy (Section 3).
 * Planning authority NEVER grants execution authority: the decision is
 * derived from the EXISTING tool risk model + plan autonomy + an
 * explicit server-side confirmation signal.
 */
import type { Plan, RiskLevel } from "../planner/types";
import { planRisk } from "../planner/planScorer";
import { DESTRUCTIVE_TOOLS } from "./types";

export type { AuthorizationDecision } from "./types";

export interface PolicyInput {
  plan: Plan;
  /** Server-verified confirmation captured out-of-band from the user. */
  confirmed?: boolean;
}

export interface PolicyDecision {
  decision: "AUTHORIZED" | "REQUIRES_CONFIRMATION" | "REJECTED";
  reason: string;
  maxRisk: RiskLevel;
}

const RISK_RANK: Record<RiskLevel, number> = {
  safe: 0, low: 1, medium: 2, high: 3, critical: 4,
};

export function evaluateExecutionPolicy(input: PolicyInput): PolicyDecision {
  const { plan } = input;
  const maxRisk = planRisk(plan.steps);

  // Destructive tools anywhere -> hard reject (no existing policy allows).
  const hasDestructive = plan.steps.some(
    (s) => s.requiredTool && DESTRUCTIVE_TOOLS.has(s.requiredTool)
  );
  if (hasDestructive || maxRisk === "critical") {
    return {
      decision: "REJECTED",
      reason: "Plan contains destructive or critical-risk operations; execution refused.",
      maxRisk,
    };
  }

  // Planner-assigned autonomy alone never authorizes: level must be >=1
  // AND risk must be within the auto-executable band.
  const autonomy = plan.autonomyLevel ?? 0;

  if (RISK_RANK[maxRisk] >= RISK_RANK.high) {
    if (input.confirmed === true) {
      return {
        decision: "AUTHORIZED",
        reason: `High-risk plan executed with explicit confirmation.`,
        maxRisk,
      };
    }
    return {
      decision: "REQUIRES_CONFIRMATION",
      reason: `High-risk operations (${maxRisk}) require explicit confirmation.`,
      maxRisk,
    };
  }

  if (maxRisk === "medium" && input.confirmed !== true) {
    return {
      decision: "REQUIRES_CONFIRMATION",
      reason: "Medium-risk operations require confirmation before automatic execution.",
      maxRisk,
    };
  }

  if (autonomy < 1) {
    return {
      decision: "REQUIRES_CONFIRMATION",
      reason: `Plan autonomy level ${autonomy} does not permit execution.`,
      maxRisk,
    };
  }

  return {
    decision: "AUTHORIZED",
    reason: `Safe/low-risk plan with autonomy ${autonomy}.`,
    maxRisk,
  };
}
