import { randomUUID } from "node:crypto";
import type { FirestoreLike } from "../persistence/firestoreUserStore";
import type { ExecutionSession, SessionLease, SessionLeaseClaim } from "./sessionTypes";
import { EXECUTION_SESSION_LIMITS } from "./sessionTypes";
import type { ExecutionSessionStore } from "./sessionStore";

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function safe(value: string, label: string): string {
  if (!value || value.length > 160 || value.includes("/") || value.includes("\0") || value === "." || value === "..") {
    throw new Error(`FirestoreExecutionSessionStore: invalid ${label}`);
  }
  return value;
}
function validTtl(ttlMs: number): boolean {
  return Number.isFinite(ttlMs) && ttlMs >= EXECUTION_SESSION_LIMITS.minLeaseTtlMs && ttlMs <= EXECUTION_SESSION_LIMITS.maxLeaseTtlMs;
}

export class FirestoreExecutionSessionStore implements ExecutionSessionStore {
  constructor(
    private readonly db: FirestoreLike,
    private readonly now: () => number = Date.now,
    private readonly log: (message: string, error?: unknown) => void = (message, error) => console.warn(`[firestore-session] ${message}`, error ?? ""),
  ) {}

  private sessionPath(userId: string, sessionId: string): string {
    return `users/${safe(userId, "userId")}/executionSessions/${safe(sessionId, "sessionId")}`;
  }
  private leasePath(userId: string, sessionId: string): string {
    return `users/${safe(userId, "userId")}/executionSessionLeases/${safe(sessionId, "sessionId")}`;
  }

  async createSession(session: ExecutionSession): Promise<boolean> {
    if (!session?.userId || !session?.sessionId) return false;
    try {
      const path = this.sessionPath(session.userId, session.sessionId);
      return await this.db.runTransaction(async (tx) => {
        if ((await tx.get({ path })).exists) return false;
        tx.set({ path }, clone(session)); return true;
      });
    } catch (error) { this.log("create failed", error); return false; }
  }

  async getSession(userId: string, sessionId: string): Promise<ExecutionSession | null> {
    try {
      const snap = await this.db.doc(this.sessionPath(userId, sessionId)).get();
      if (!snap.exists) return null;
      const session = snap.data() as ExecutionSession;
      return session?.userId === userId && session?.sessionId === sessionId ? clone(session) : null;
    } catch (error) { this.log("get failed", error); return null; }
  }

  async listSessions(userId: string, limit = 20): Promise<ExecutionSession[]> {
    try {
      const ids = await this.db.collection(`users/${safe(userId, "userId")}/executionSessions`).listIds();
      const sessions = (await Promise.all(ids.map((id) => this.getSession(userId, id)))).filter((value): value is ExecutionSession => Boolean(value));
      return sessions.sort((a, b) => a.updatedAt - b.updatedAt).slice(-Math.max(0, limit));
    } catch (error) { this.log("list failed", error); return []; }
  }

  async compareAndSetSession(next: ExecutionSession, expectedVersion: number, claim?: SessionLeaseClaim): Promise<boolean> {
    try {
      const path = this.sessionPath(next.userId, next.sessionId);
      const leasePath = this.leasePath(next.userId, next.sessionId);
      return await this.db.runTransaction(async (tx) => {
        const snap = await tx.get({ path });
        if (!snap.exists) return false;
        const current = snap.data() as ExecutionSession;
        if (current?.userId !== next.userId || current?.sessionId !== next.sessionId || current.version !== expectedVersion || next.version !== expectedVersion + 1) return false;
        if (claim) {
          const leaseSnap = await tx.get({ path: leasePath });
          if (!leaseSnap.exists) return false;
          const lease = leaseSnap.data() as SessionLease;
          if (!matches(lease, claim) || lease.expiresAt <= this.now()) return false;
        }
        tx.set({ path }, clone(next)); return true;
      });
    } catch (error) { this.log("compare-and-set failed", error); return false; }
  }

  async acquireSessionLease(userId: string, sessionId: string, workerId: string, ttlMs: number): Promise<SessionLease | null> {
    if (!validTtl(ttlMs)) return null;
    try {
      const sessionPath = this.sessionPath(userId, sessionId);
      const path = this.leasePath(userId, sessionId);
      const now = this.now();
      return await this.db.runTransaction(async (tx) => {
        const sessionSnap = await tx.get({ path: sessionPath });
        if (!sessionSnap.exists || (sessionSnap.data() as ExecutionSession)?.userId !== userId) return null;
        const snap = await tx.get({ path });
        const current = snap.exists ? snap.data() as SessionLease : null;
        if (current && current.expiresAt > now) return null;
        const lease: SessionLease = {
          userId, sessionId, workerId, leaseToken: randomUUID(),
          fencingToken: (current?.fencingToken ?? 0) + 1,
          acquiredAt: now, heartbeatAt: now, expiresAt: now + ttlMs,
        };
        tx.set({ path }, lease); return clone(lease);
      });
    } catch (error) { this.log("acquire lease failed", error); return null; }
  }

  async renewSessionLease(claim: SessionLeaseClaim & { userId: string; sessionId: string }, ttlMs: number): Promise<SessionLease | null> {
    if (!validTtl(ttlMs)) return null;
    try {
      const path = this.leasePath(claim.userId, claim.sessionId);
      const now = this.now();
      return await this.db.runTransaction(async (tx) => {
        const snap = await tx.get({ path });
        if (!snap.exists) return null;
        const current = snap.data() as SessionLease;
        if (!matches(current, claim) || current.expiresAt <= now) return null;
        const renewed = { ...current, heartbeatAt: now, expiresAt: now + ttlMs };
        tx.set({ path }, renewed); return clone(renewed);
      });
    } catch (error) { this.log("renew lease failed", error); return null; }
  }

  async releaseSessionLease(claim: SessionLeaseClaim & { userId: string; sessionId: string }): Promise<boolean> {
    try {
      const path = this.leasePath(claim.userId, claim.sessionId);
      return await this.db.runTransaction(async (tx) => {
        const snap = await tx.get({ path });
        if (!snap.exists) return true;
        if (!matches(snap.data() as SessionLease, claim)) return false;
        tx.delete({ path }); return true;
      });
    } catch (error) { this.log("release lease failed", error); return false; }
  }
}

function matches(lease: SessionLease, claim: SessionLeaseClaim): boolean {
  return lease?.workerId === claim.workerId && lease?.leaseToken === claim.leaseToken && lease?.fencingToken === claim.fencingToken;
}
