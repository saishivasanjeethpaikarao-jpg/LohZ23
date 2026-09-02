import type { HealthSnapshot } from "./types";

export interface VerificationComparison { passed: boolean; regressions: string[]; improvements: string[]; beforeScore: number | null; afterScore: number | null; }

export class VerificationEngine {
  compareHealth(before: HealthSnapshot, after: HealthSnapshot): VerificationComparison {
    const beforeMap = new Map(before.subsystems.map((item) => [item.subsystem, item])); const regressions: string[] = []; const improvements: string[] = [];
    for (const current of after.subsystems) {
      const prior = beforeMap.get(current.subsystem); if (!prior) continue;
      if ((prior.score ?? -1) > (current.score ?? -1) || (prior.status === "HEALTHY" && current.status !== "HEALTHY")) regressions.push(`${current.subsystem}:${prior.status}->${current.status}`);
      if ((current.score ?? -1) > (prior.score ?? -1)) improvements.push(`${current.subsystem}:${prior.score ?? "unknown"}->${current.score ?? "unknown"}`);
    }
    return { passed: regressions.length === 0 && after.status !== "FAILING" && after.status !== "UNKNOWN", regressions, improvements, beforeScore: before.overallScore, afterScore: after.overallScore };
  }
}
