/**
 * Phase 28 - PlanPersistence (Section 24). Storage-agnostic; Firestore
 * adapter lives at the bottom and uses ONLY the Phase 22 store seam.
 * Persists bounded plan metadata only - never chain-of-thought.
 */
import type { Plan } from "./types";

export interface PlanStore {
  savePlan(userId: string, plan: Plan): Promise<boolean>;
  getPlan(userId: string, planId: string): Promise<Plan | null>;
  deletePlan(userId: string, planId: string): Promise<boolean>;
  listPlans(userId: string, limit?: number): Promise<Plan[]>;
}

/** In-memory implementation for tests / offline fallback. */
export class InMemoryPlanStore implements PlanStore {
  private data = new Map<string, Map<string, Plan>>();

  private bucket(uid: string): Map<string, Plan> {
    if (!this.data.has(uid)) this.data.set(uid, new Map());
    return this.data.get(uid)!;
  }

  async savePlan(userId: string, plan: Plan): Promise<boolean> {
    this.bucket(userId).set(plan.id, JSON.parse(JSON.stringify(plan)));
    return true;
  }
  async getPlan(userId: string, planId: string): Promise<Plan | null> {
    const p = this.bucket(userId).get(planId);
    return p ? JSON.parse(JSON.stringify(p)) : null;
  }
  async deletePlan(userId: string, planId: string): Promise<boolean> {
    return this.bucket(userId).delete(planId);
  }
  async listPlans(userId: string, limit = 20): Promise<Plan[]> {
    return [...this.bucket(userId).values()].slice(-limit).map((p) => JSON.parse(JSON.stringify(p)));
  }
}
