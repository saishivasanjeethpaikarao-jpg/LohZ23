import { randomUUID } from "node:crypto";
import type { ExecutionSession, SessionLease, SessionLeaseClaim } from "./sessionTypes";
import { EXECUTION_SESSION_LIMITS } from "./sessionTypes";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface ExecutionSessionStore {
  createSession(session: ExecutionSession): Promise<boolean>;
  getSession(userId: string, sessionId: string): Promise<ExecutionSession | null>;
  listSessions(userId: string, limit?: number): Promise<ExecutionSession[]>;
  compareAndSetSession(next: ExecutionSession, expectedVersion: number, lease?: SessionLeaseClaim): Promise<boolean>;
  acquireSessionLease(userId: string, sessionId: string, workerId: string, ttlMs: number): Promise<SessionLease | null>;
  renewSessionLease(lease: SessionLeaseClaim & { userId: string; sessionId: string }, ttlMs: number): Promise<SessionLease | null>;
  releaseSessionLease(lease: SessionLeaseClaim & { userId: string; sessionId: string }): Promise<boolean>;
}

/** Deterministic test/offline store. Production composition uses Firestore transactions. */
export class InMemoryExecutionSessionStore implements ExecutionSessionStore {
  private readonly sessions = new Map<string, ExecutionSession>();
  private readonly leases = new Map<string, SessionLease>();
  constructor(private readonly now: () => number = Date.now) {}

  private key(userId: string, sessionId: string): string { return `${userId}:${sessionId}`; }

  async createSession(session: ExecutionSession): Promise<boolean> {
    const key = this.key(session.userId, session.sessionId);
    if (this.sessions.has(key)) return false;
    this.sessions.set(key, clone(session));
    return true;
  }

  async getSession(userId: string, sessionId: string): Promise<ExecutionSession | null> {
    const value = this.sessions.get(this.key(userId, sessionId));
    return value?.userId === userId ? clone(value) : null;
  }

  async listSessions(userId: string, limit = 20): Promise<ExecutionSession[]> {
    return [...this.sessions.values()].filter((item) => item.userId === userId)
      .sort((a, b) => a.updatedAt - b.updatedAt).slice(-Math.max(0, limit)).map(clone);
  }

  async compareAndSetSession(next: ExecutionSession, expectedVersion: number, claim?: SessionLeaseClaim): Promise<boolean> {
    const key = this.key(next.userId, next.sessionId);
    const current = this.sessions.get(key);
    if (!current || current.userId !== next.userId || current.version !== expectedVersion || next.version !== expectedVersion + 1) return false;
    if (claim) {
      const lease = this.leases.get(key);
      if (!lease || lease.workerId !== claim.workerId || lease.leaseToken !== claim.leaseToken ||
          lease.fencingToken !== claim.fencingToken || lease.expiresAt <= this.now()) return false;
    }
    this.sessions.set(key, clone(next));
    return true;
  }

  async acquireSessionLease(userId: string, sessionId: string, workerId: string, ttlMs: number): Promise<SessionLease | null> {
    if (!validTtl(ttlMs) || !this.sessions.has(this.key(userId, sessionId))) return null;
    const key = this.key(userId, sessionId);
    const now = this.now();
    const current = this.leases.get(key);
    if (current && current.expiresAt > now) return null;
    const lease: SessionLease = {
      userId, sessionId, workerId, leaseToken: randomUUID(),
      fencingToken: (current?.fencingToken ?? 0) + 1,
      acquiredAt: now, heartbeatAt: now, expiresAt: now + ttlMs,
    };
    this.leases.set(key, lease);
    return clone(lease);
  }

  async renewSessionLease(claim: SessionLeaseClaim & { userId: string; sessionId: string }, ttlMs: number): Promise<SessionLease | null> {
    if (!validTtl(ttlMs)) return null;
    const key = this.key(claim.userId, claim.sessionId);
    const current = this.leases.get(key);
    const now = this.now();
    if (!matches(current, claim) || current!.expiresAt <= now) return null;
    current!.heartbeatAt = now; current!.expiresAt = now + ttlMs;
    return clone(current!);
  }

  async releaseSessionLease(claim: SessionLeaseClaim & { userId: string; sessionId: string }): Promise<boolean> {
    const key = this.key(claim.userId, claim.sessionId);
    const current = this.leases.get(key);
    if (!matches(current, claim)) return false;
    this.leases.delete(key);
    return true;
  }
}

function validTtl(ttlMs: number): boolean {
  return Number.isFinite(ttlMs) && ttlMs >= EXECUTION_SESSION_LIMITS.minLeaseTtlMs && ttlMs <= EXECUTION_SESSION_LIMITS.maxLeaseTtlMs;
}

function matches(current: SessionLease | undefined, claim: SessionLeaseClaim): boolean {
  return Boolean(current && current.workerId === claim.workerId && current.leaseToken === claim.leaseToken && current.fencingToken === claim.fencingToken);
}
