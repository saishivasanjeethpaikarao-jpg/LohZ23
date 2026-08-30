/**
 * Phase 30 - replan seam (Sections 13, 14). Uses the Phase 28 planner's
 * replan + a new additive promoteDraft; NO second planner. Filters
 * completed steps out of revised plans and enforces the replan cap.
 */
import type { Plan, PlanStep } from "../planner/types";
import type { HierarchicalPlanner } from "../planner/planner";
import type { StepExecutionRecord } from "../execution/types";

export interface ReplanResult {
  ok: boolean;
  plan?: Plan;
  reason?: string;
}

export class ReplanCoordinator {
  private used = new Map<string, number>(); // userId:requestId -> count

  constructor(private planner: HierarchicalPlanner) {}

  reset(userId: string, requestId: string): void {
    this.used.delete(`${userId}:${requestId}`);
  }

  countFor(userId: string, requestId: string): number {
    return this.used.get(`${userId}:${requestId}`) ?? 0;
  }

  async maybeReplan(
    userId: string,
    requestId: string,
    original: Plan,
    failedSteps: StepExecutionRecord[],
    completedStepIds: string[]
  ): Promise<ReplanResult> {
    const key = `${userId}:${requestId}`;
    const used = this.used.get(key) ?? 0;

    // Preserve lineage: goalId/objective ride on original; replan copies it.
    const evidenceNote =
      `replan#${used + 1}: failed=[${failedSteps.map((s) => `${s.stepId}:${s.failure?.code ?? "?"}`).join(",")}] ` +
      `completed=[${completedStepIds.join(",")}]`;

    const result = await this.planner.replan(userId, original, evidenceNote);
    if (!result.ok || !result.plan) {
      return { ok: false, reason: result.reason ?? "replan rejected" };
    }

    let revised = result.plan;

    // Only unresolved work appears in the replan (Section 13).
    const completedSet = new Set(completedStepIds);
    const failedIds = new Set(failedSteps.map((f) => f.stepId));
    const kept: PlanStep[] = [];
    for (const s of revised.steps) {
      if (completedSet.has(s.id)) continue;                 // never re-run completed work
      if (!failedIds.has(s.id) && !completedSet.has(s.id)) {
        // Untouched pending steps remain candidates.
        kept.push({ ...s, dependencies: s.dependencies.filter((d) => !completedSet.has(d)) });
        continue;
      }
      if (failedIds.has(s.id)) {
        kept.push({
          ...s,
          status: "draft",
          title: `${s.title} (retry approach)`,
          dependencies: s.dependencies.filter((d) => !completedSet.has(d)),
        });
      }
    }
    if (kept.length === 0) {
      return { ok: false, reason: "no unresolved work remains after filtering completed steps" };
    }
    kept.forEach((s, i) => { s.index = i; });
    revised.steps = kept;

    // Validate/gate/promote through the SAME planner machinery.
    const promoted = await this.planner.promoteDraft(userId, revised);
    if (!promoted.ok || !promoted.plan || promoted.plan.status !== "ready") {
      return { ok: false, reason: promoted.reason ?? "revised plan failed validation/confidence gate" };
    }

    this.used.set(key, used + 1);
    return { ok: true, plan: promoted.plan };
  }

  /** Cap check used by callers before attempting another cycle. */
  canReplan(userId: string, requestId: string): boolean {
    return (this.used.get(`${userId}:${requestId}`) ?? 0) < 2;
  }
}
