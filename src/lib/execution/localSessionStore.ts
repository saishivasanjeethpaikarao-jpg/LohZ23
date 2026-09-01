import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExecutionSessionStore } from "./sessionStore";
import type { ExecutionSession, SessionLease, SessionLeaseClaim } from "./sessionTypes";
import { EXECUTION_SESSION_LIMITS } from "./sessionTypes";

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function safe(value: string, label: string): string {
  if (!/^[A-Za-z0-9#_.:-]{1,160}$/.test(value)) throw new Error(`LocalExecutionSessionStore: invalid ${label}`);
  return Buffer.from(value, "utf8").toString("base64url");
}

/** Restart-safe single-host fallback. Multi-server production uses FirestoreExecutionSessionStore. */
export class LocalExecutionSessionStore implements ExecutionSessionStore {
  private readonly root: string;
  constructor(root = path.join(process.cwd(), "data", "phase41"), private readonly now: () => number = Date.now) {
    this.root = path.resolve(root);
    fs.mkdirSync(path.join(this.root, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(this.root, "leases"), { recursive: true });
    fs.mkdirSync(path.join(this.root, "guards"), { recursive: true });
  }

  private key(userId: string, sessionId: string): string { return `${safe(userId, "userId")}-${safe(sessionId, "sessionId")}`; }
  private sessionFile(userId: string, sessionId: string): string { return path.join(this.root, "sessions", `${this.key(userId, sessionId)}.json`); }
  private leaseFile(userId: string, sessionId: string): string { return path.join(this.root, "leases", `${this.key(userId, sessionId)}.json`); }

  async createSession(session: ExecutionSession): Promise<boolean> {
    return this.withGuard(session.userId, session.sessionId, () => {
      const file = this.sessionFile(session.userId, session.sessionId);
      if (fs.existsSync(file)) return false;
      return atomicWrite(file, session);
    });
  }

  async getSession(userId: string, sessionId: string): Promise<ExecutionSession | null> {
    try {
      const value = JSON.parse(fs.readFileSync(this.sessionFile(userId, sessionId), "utf8")) as ExecutionSession;
      return value?.userId === userId && value?.sessionId === sessionId ? clone(value) : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }
  }

  async listSessions(userId: string, limit = 20): Promise<ExecutionSession[]> {
    const prefix = `${safe(userId, "userId")}-`;
    const values: ExecutionSession[] = [];
    try {
      for (const name of fs.readdirSync(path.join(this.root, "sessions"))) {
        if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
        try {
          const item = JSON.parse(fs.readFileSync(path.join(this.root, "sessions", name), "utf8")) as ExecutionSession;
          if (item.userId === userId) values.push(item);
        } catch { /* malformed records fail closed */ }
      }
    } catch { return []; }
    return values.sort((a, b) => a.updatedAt - b.updatedAt).slice(-Math.max(0, limit)).map(clone);
  }

  async compareAndSetSession(next: ExecutionSession, expectedVersion: number, claim?: SessionLeaseClaim): Promise<boolean> {
    return this.withGuard(next.userId, next.sessionId, async () => {
      const current = await this.getSession(next.userId, next.sessionId);
      if (!current || current.version !== expectedVersion || next.version !== expectedVersion + 1) return false;
      if (claim) {
        const lease = this.readLease(next.userId, next.sessionId);
        if (!matches(lease, claim) || lease!.expiresAt <= this.now()) return false;
      }
      return atomicWrite(this.sessionFile(next.userId, next.sessionId), next);
    });
  }

  async acquireSessionLease(userId: string, sessionId: string, workerId: string, ttlMs: number): Promise<SessionLease | null> {
    if (!validTtl(ttlMs) || !(await this.getSession(userId, sessionId))) return null;
    return this.withGuard(userId, sessionId, () => {
      const current = this.readLease(userId, sessionId);
      const now = this.now();
      if (current && current.expiresAt > now) return null;
      const lease: SessionLease = {
        userId, sessionId, workerId, leaseToken: randomUUID(), fencingToken: (current?.fencingToken ?? 0) + 1,
        acquiredAt: now, heartbeatAt: now, expiresAt: now + ttlMs,
      };
      return atomicWrite(this.leaseFile(userId, sessionId), lease) ? lease : null;
    });
  }

  async renewSessionLease(claim: SessionLeaseClaim & { userId: string; sessionId: string }, ttlMs: number): Promise<SessionLease | null> {
    if (!validTtl(ttlMs)) return null;
    return this.withGuard(claim.userId, claim.sessionId, () => {
      const current = this.readLease(claim.userId, claim.sessionId);
      const now = this.now();
      if (!matches(current, claim) || current!.expiresAt <= now) return null;
      const renewed = { ...current!, heartbeatAt: now, expiresAt: now + ttlMs };
      return atomicWrite(this.leaseFile(claim.userId, claim.sessionId), renewed) ? renewed : null;
    });
  }

  async releaseSessionLease(claim: SessionLeaseClaim & { userId: string; sessionId: string }): Promise<boolean> {
    return this.withGuard(claim.userId, claim.sessionId, () => {
      const current = this.readLease(claim.userId, claim.sessionId);
      if (!current) return true;
      if (!matches(current, claim)) return false;
      try { fs.unlinkSync(this.leaseFile(claim.userId, claim.sessionId)); return true; } catch { return false; }
    });
  }

  private readLease(userId: string, sessionId: string): SessionLease | null {
    try {
      const lease = JSON.parse(fs.readFileSync(this.leaseFile(userId, sessionId), "utf8")) as SessionLease;
      return lease?.userId === userId && lease?.sessionId === sessionId ? lease : null;
    } catch { return null; }
  }

  private async withGuard<T>(userId: string, sessionId: string, work: () => T | Promise<T>): Promise<T> {
    const guard = path.join(this.root, "guards", `${this.key(userId, sessionId)}.lock`);
    let handle: number | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { handle = fs.openSync(guard, "wx"); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    if (handle === null) throw new Error("LocalExecutionSessionStore: concurrent update timeout");
    try { return await work(); }
    finally {
      try { fs.closeSync(handle); } catch { /* best effort */ }
      try { fs.unlinkSync(guard); } catch { /* best effort */ }
    }
  }
}

function atomicWrite(file: string, value: unknown): boolean {
  const temp = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
    fs.renameSync(temp, file); return true;
  } catch {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ }
    return false;
  }
}
function validTtl(ttlMs: number): boolean {
  return Number.isFinite(ttlMs) && ttlMs >= EXECUTION_SESSION_LIMITS.minLeaseTtlMs && ttlMs <= EXECUTION_SESSION_LIMITS.maxLeaseTtlMs;
}
function matches(lease: SessionLease | null, claim: SessionLeaseClaim): boolean {
  return Boolean(lease && lease.workerId === claim.workerId && lease.leaseToken === claim.leaseToken && lease.fencingToken === claim.fencingToken);
}
