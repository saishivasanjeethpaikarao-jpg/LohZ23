/**
 * Phase 42 — curiosity persistence seam + in-memory implementation.
 * Gaps and a bounded interaction ring, per user. Storage-agnostic;
 * Firestore adapter can follow the Phase-22/36 pattern later.
 */
import { CURIOSITY_LIMITS, type CuriosityInteraction, type KnowledgeGap } from "./types";

export interface CuriosityStore {
  upsertGap(gap: KnowledgeGap): Promise<boolean>;
  getGap(uid: string, gapId: string): Promise<KnowledgeGap | null>;
  listGaps(uid: string): Promise<KnowledgeGap[]>;
  deleteGap(uid: string, gapId: string): Promise<boolean>;
  appendInteraction(entry: CuriosityInteraction): Promise<boolean>;
  recentInteractions(uid: string, sinceMs: number): Promise<CuriosityInteraction[]>;
}

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

export class InMemoryCuriosityStore implements CuriosityStore {
  private gaps = new Map<string, Map<string, KnowledgeGap>>();
  private interactions = new Map<string, CuriosityInteraction[]>();

  private bucket(uid: string): Map<string, KnowledgeGap> {
    if (!this.gaps.has(uid)) this.gaps.set(uid, new Map());
    return this.gaps.get(uid)!;
  }

  async upsertGap(gap: KnowledgeGap): Promise<boolean> {
    this.bucket(gap.uid).set(gap.gapId, clone(gap));
    return true;
  }
  async getGap(uid: string, gapId: string): Promise<KnowledgeGap | null> {
    const g = this.bucket(uid).get(gapId);
    return g && g.uid === uid ? clone(g) : null;
  }
  async listGaps(uid: string): Promise<KnowledgeGap[]> {
    return [...this.bucket(uid).values()].filter((g) => g.uid === uid).map(clone);
  }
  async deleteGap(uid: string, gapId: string): Promise<boolean> {
    return this.bucket(uid).delete(gapId);
  }
  async appendInteraction(entry: CuriosityInteraction): Promise<boolean> {
    const list = this.interactions.get(entry.uid) ?? [];
    list.push(clone(entry));
    while (list.length > CURIOSITY_LIMITS.maxInteractionsLogged) list.shift();
    this.interactions.set(entry.uid, list);
    return true;
  }
  async recentInteractions(uid: string, sinceMs: number): Promise<CuriosityInteraction[]> {
    return (this.interactions.get(uid) ?? []).filter((e) => e.at >= sinceMs && e.uid === uid).map(clone);
  }
}
