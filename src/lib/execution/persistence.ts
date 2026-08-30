/**
 * Phase 29 - ExecutionStore (Section 13). Storage-agnostic; bounded
 * metadata only. Firestore adapter can implement the same interface via
 * the Phase 22 seam pattern; InMemory ships for offline/tests.
 */
import type { ExecutionRecord } from "./types";

export interface ExecutionStore {
  getExecution(uid: string, requestId: string): Promise<ExecutionRecord | null>;
  saveExecution(record: ExecutionRecord): Promise<boolean>;
  updateExecution(record: ExecutionRecord): Promise<boolean>;
  deleteExecution(uid: string, requestId: string): Promise<boolean>;
  listExecutions(uid: string, limit?: number): Promise<ExecutionRecord[]>;
}

export class InMemoryExecutionStore implements ExecutionStore {
  private data = new Map<string, Map<string, ExecutionRecord>>();

  private bucket(uid: string): Map<string, ExecutionRecord> {
    if (!this.data.has(uid)) this.data.set(uid, new Map());
    return this.data.get(uid)!;
  }

  async getExecution(uid: string, requestId: string): Promise<ExecutionRecord | null> {
    const r = this.bucket(uid).get(requestId);
    return r ? JSON.parse(JSON.stringify(r)) : null;
  }

  async saveExecution(record: ExecutionRecord): Promise<boolean> {
    this.bucket(record.uid).set(record.requestId, JSON.parse(JSON.stringify(record)));
    return true;
  }

  async updateExecution(record: ExecutionRecord): Promise<boolean> {
    const existing = this.bucket(record.uid).get(record.requestId);
    if (!existing) return false;
    this.bucket(record.uid).set(record.requestId, JSON.parse(JSON.stringify(record)));
    return true;
  }

  async deleteExecution(uid: string, requestId: string): Promise<boolean> {
    return this.bucket(uid).delete(requestId);
  }

  async listExecutions(uid: string, limit = 20): Promise<ExecutionRecord[]> {
    return [...this.bucket(uid).values()].slice(-limit).map((r) => JSON.parse(JSON.stringify(r)));
  }
}
