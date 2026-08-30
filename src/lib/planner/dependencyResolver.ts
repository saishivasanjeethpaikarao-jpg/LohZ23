/**
 * Phase 28 - deterministic dependency graph validation (Section 6).
 * Pure functions: valid refs, self-deps, duplicates, cycles, depth.
 */
import type { PlanStep } from "./types";
import { PLAN_LIMITS } from "./types";

export interface GraphCheck {
  ok: boolean;
  reason?: string;
  /** Topologically ordered step ids (only when ok). */
  order?: string[];
  maxDepth?: number;
}

export function validateDependencyGraph(steps: PlanStep[]): GraphCheck {
  const ids = new Set(steps.map((s) => s.id));
  if (ids.size !== steps.length) {
    return { ok: false, reason: "duplicate step ids" };
  }

  for (const step of steps) {
    if (step.dependencies.includes(step.id)) {
      return { ok: false, reason: `self dependency on ${step.id}` };
    }
    for (const dep of step.dependencies) {
      if (!ids.has(dep)) {
        return { ok: false, reason: `missing dependency '${dep}' referenced by ${step.id}` };
      }
    }
    if (step.dependencies.length > PLAN_LIMITS.maxSteps) {
      return { ok: false, reason: `step ${step.id} has too many dependencies` };
    }
  }

  // Cycle detection + topological order (Kahn).
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const s of steps) {
    indegree.set(s.id, s.dependencies.length);
    for (const d of s.dependencies) {
      dependents.set(d, [...(dependents.get(d) ?? []), s.id]);
    }
  }
  const queue: string[] = steps.filter((s) => (indegree.get(s.id) ?? 0) === 0).map((s) => s.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  if (order.length !== steps.length) {
    return { ok: false, reason: "dependency cycle detected" };
  }

  // Depth = longest dependency chain.
  const depthOf = new Map<string, number>();
  let maxDepth = 0;
  for (const id of order) {
    const step = steps.find((s) => s.id === id)!;
    const d = step.dependencies.length === 0 ? 1 : Math.max(...step.dependencies.map((dep) => (depthOf.get(dep) ?? 0))) + 1;
    depthOf.set(id, d);
    maxDepth = Math.max(maxDepth, d);
  }
  if (maxDepth > PLAN_LIMITS.maxDependencyDepth) {
    return { ok: false, reason: `dependency depth ${maxDepth} exceeds limit` };
  }

  // Branch width bound: max number of steps sharing a dependency level.
  const byLevel = new Map<number, number>();
  for (const id of order) {
    const d = depthOf.get(id)!;
    byLevel.set(d, (byLevel.get(d) ?? 0) + 1);
  }
  const maxBranches = Math.max(...byLevel.values());
  if (maxBranches > PLAN_LIMITS.maxBranches && steps.length > PLAN_LIMITS.maxBranches) {
    return { ok: false, reason: `parallel width ${maxBranches} exceeds branch limit` };
  }

  return { ok: true, order, maxDepth };
}
