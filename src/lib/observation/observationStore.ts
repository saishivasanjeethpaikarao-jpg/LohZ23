/**
 * Phase 30 - bounded observation store (Section 2, 17).
 * In-memory reference implementation behind a seam; per-plan/per-step
 * bounds enforced on write. Sanitization happens before persist.
 */
import type { Observation } from "./types";
import { OBSERVATION_LIMITS } from "./types";

export interface ObservationStore {
  add(uid: string, requestId: string, obs: Observation): Promise<boolean>;
  listForStep(uid: string, requestId: string, stepId: string): Promise<Observation[]>;
  listForRequest(uid: string, requestId: string): Promise<Observation[]>;
}

export class InMemoryObservationStore implements ObservationStore {
  private data = new Map<string, Observation[]>();

  private key(uid: string, requestId: string): string {
    return `${uid}::${requestId}`;
  }

  async add(uid: string, requestId: string, obs: Observation): Promise<boolean> {
    const k = this.key(uid, requestId);
    const arr = this.data.get(k) ?? [];
    if (arr.length >= OBSERVATION_LIMITS.perPlan) return false;
    const perStep = arr.filter((o) => o.stepId === obs.stepId).length;
    if (perStep >= OBSERVATION_LIMITS.perStep) return false;
    arr.push(JSON.parse(JSON.stringify(obs)));
    this.data.set(k, arr);
    return true;
  }

  async listForStep(uid: string, requestId: string, stepId: string): Promise<Observation[]> {
    return (this.data.get(this.key(uid, requestId)) ?? []).filter((o) => o.stepId === stepId);
  }

  async listForRequest(uid: string, requestId: string): Promise<Observation[]> {
    return [...(this.data.get(this.key(uid, requestId)) ?? [])];
  }
}
