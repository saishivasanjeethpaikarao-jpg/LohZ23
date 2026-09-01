export interface ExecutionLease {
  uid: string;
  planId: string;
  requestId: string;
  acquiredAt: number;
  expiresAt: number;
  version: 1;
}

export interface ExecutionLeaseStore {
  acquireExecutionLease(uid: string, planId: string, requestId: string, ttlMs: number): Promise<boolean>;
  releaseExecutionLease(uid: string, planId: string, requestId: string): Promise<boolean>;
}

/** Test/offline implementation. Production uses the Firestore transaction-backed store. */
export class InMemoryExecutionLeaseStore implements ExecutionLeaseStore {
  private readonly leases = new Map<string, ExecutionLease>();

  async acquireExecutionLease(uid: string, planId: string, requestId: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const key = `${uid}:${planId}`;
    const current = this.leases.get(key);
    if (current && current.requestId !== requestId && current.expiresAt > now) return false;
    this.leases.set(key, { uid, planId, requestId, acquiredAt: now, expiresAt: now + ttlMs, version: 1 });
    return true;
  }

  async releaseExecutionLease(uid: string, planId: string, requestId: string): Promise<boolean> {
    const key = `${uid}:${planId}`;
    const current = this.leases.get(key);
    if (!current || current.requestId !== requestId) return false;
    this.leases.delete(key);
    return true;
  }
}
