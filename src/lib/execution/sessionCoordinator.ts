import { createHash, randomUUID } from "node:crypto";
import type { RiskLevel } from "../planner/types";
import type { ExecutionSessionStore } from "./sessionStore";
import {
  EXECUTION_SESSION_LIMITS,
  TERMINAL_SESSION_STATUSES,
  type ExecutionCheckpoint,
  type ExecutionSession,
  type ResumeVerification,
  type SessionAuthorizationScope,
  type SessionLease,
  type SessionLeaseClaim,
} from "./sessionTypes";

export interface CreateExecutionSessionInput {
  userId: string;
  objective: string;
  planId: string;
  planVersion: number;
  requestId: string;
  allowedTools: string[];
  maxRisk: RiskLevel;
  confirmed?: boolean;
  authorizationTtlMs?: number;
  sessionTimeoutMs?: number;
  nextAction?: string;
}

export interface SessionRunResult {
  status: "completed" | "partial" | "failed" | "paused";
  reason: string;
  executionRecordVersion?: number | null;
  completedStepIds?: string[];
  verificationStatus?: "VERIFIED" | "FAILED" | "INCONCLUSIVE";
  worldStateToken?: string | null;
  nextAction?: string | null;
  failureCode?: string;
  retryable?: boolean;
  interruption?: "provider_outage" | "windows_agent_outage" | "persistence_outage" | "user_interruption";
}

export interface SessionRunControl {
  signal: AbortSignal;
  checkpoint(input: Omit<ExecutionCheckpoint, "checkpointId" | "sequence" | "recordedAt" | "planId" | "planVersion" | "requestId">): Promise<boolean>;
  heartbeat(): Promise<boolean>;
  shouldStop(): Promise<boolean>;
}

export interface ExecutionSessionCoordinatorDeps {
  store: ExecutionSessionStore;
  verifyResume(session: ExecutionSession, input: { checkpointStale: boolean }): Promise<ResumeVerification>;
  run(session: ExecutionSession, control: SessionRunControl): Promise<SessionRunResult>;
  now?: () => number;
  leaseTtlMs?: number;
  checkpointMaxAgeMs?: number;
}

export interface ResumeResult {
  ok: boolean;
  code: string;
  session: ExecutionSession | null;
}

export class ExecutionSessionCoordinator {
  private readonly now: () => number;
  private readonly leaseTtlMs: number;
  private readonly checkpointMaxAgeMs: number;

  constructor(private readonly deps: ExecutionSessionCoordinatorDeps) {
    this.now = deps.now ?? Date.now;
    this.leaseTtlMs = bounded(
      deps.leaseTtlMs ?? EXECUTION_SESSION_LIMITS.defaultLeaseTtlMs,
      EXECUTION_SESSION_LIMITS.minLeaseTtlMs,
      EXECUTION_SESSION_LIMITS.maxLeaseTtlMs,
    );
    this.checkpointMaxAgeMs = Math.max(1_000, deps.checkpointMaxAgeMs ?? EXECUTION_SESSION_LIMITS.defaultCheckpointMaxAgeMs);
  }

  async create(input: CreateExecutionSessionInput): Promise<ExecutionSession | null> {
    const objective = input.objective.trim().slice(0, EXECUTION_SESSION_LIMITS.maxObjectiveChars);
    if (!validId(input.userId) || !validId(input.planId) || !validId(input.requestId) || !objective || !Number.isInteger(input.planVersion) || input.planVersion < 1) return null;
    const now = this.now();
    const authTtl = bounded(input.authorizationTtlMs ?? EXECUTION_SESSION_LIMITS.defaultAuthorizationTtlMs,
      EXECUTION_SESSION_LIMITS.minAuthorizationTtlMs, EXECUTION_SESSION_LIMITS.maxAuthorizationTtlMs);
    const sessionTtl = bounded(input.sessionTimeoutMs ?? EXECUTION_SESSION_LIMITS.defaultSessionTimeoutMs,
      EXECUTION_SESSION_LIMITS.minSessionTimeoutMs, EXECUTION_SESSION_LIMITS.maxSessionTimeoutMs);
    const sessionId = randomUUID();
    const digest = objectiveDigest(objective);
    const authorizationScope: SessionAuthorizationScope = {
      grantId: randomUUID(), grantedBy: "authenticated_user", grantedAt: now, expiresAt: now + authTtl,
      objectiveDigest: digest, planId: input.planId, planVersion: input.planVersion,
      allowedTools: [...new Set(input.allowedTools.filter(validToolName))].slice(0, 50).sort(),
      maxRisk: input.maxRisk, confirmed: input.confirmed === true, revokedAt: null,
    };
    const session: ExecutionSession = {
      sessionId, userId: input.userId, objective, objectiveDigest: digest,
      planId: input.planId, planVersion: input.planVersion, requestId: input.requestId,
      status: "created", currentCheckpoint: null, checkpoints: [], authorizationScope,
      createdAt: now, updatedAt: now, timeoutAt: now + sessionTtl,
      nextAction: cleanText(input.nextAction ?? "verify and begin", EXECUTION_SESSION_LIMITS.maxNextActionChars),
      interruptionReason: null, failure: null, version: 1,
    };
    return await this.deps.store.createSession(session) ? session : null;
  }

  async get(userId: string, sessionId: string): Promise<ExecutionSession | null> {
    return this.deps.store.getSession(userId, sessionId);
  }

  async list(userId: string, limit = 20): Promise<ExecutionSession[]> {
    return this.deps.store.listSessions(userId, Math.min(Math.max(limit, 0), 100));
  }

  async pause(userId: string, sessionId: string, reason = "paused by authenticated user"): Promise<boolean> {
    return this.interrupt(userId, sessionId, "paused", reason);
  }

  async cancel(userId: string, sessionId: string, reason = "cancelled by authenticated user"): Promise<boolean> {
    return this.interrupt(userId, sessionId, "cancelled", reason);
  }

  async recordOutage(userId: string, sessionId: string, kind: "provider_outage" | "windows_agent_outage"): Promise<boolean> {
    return this.interrupt(userId, sessionId, "paused", kind);
  }

  async reauthorize(input: {
    userId: string; sessionId: string; planId: string; planVersion: number;
    allowedTools: string[]; maxRisk: RiskLevel; confirmed?: boolean; authorizationTtlMs?: number;
  }): Promise<ExecutionSession | null> {
    const current = await this.deps.store.getSession(input.userId, input.sessionId);
    if (!current || TERMINAL_SESSION_STATUSES.has(current.status) || current.planId !== input.planId || current.planVersion !== input.planVersion) return null;
    const now = this.now();
    const ttl = bounded(input.authorizationTtlMs ?? EXECUTION_SESSION_LIMITS.defaultAuthorizationTtlMs,
      EXECUTION_SESSION_LIMITS.minAuthorizationTtlMs, EXECUTION_SESSION_LIMITS.maxAuthorizationTtlMs);
    const next: ExecutionSession = {
      ...current,
      authorizationScope: {
        grantId: randomUUID(), grantedBy: "authenticated_user", grantedAt: now, expiresAt: now + ttl,
        objectiveDigest: current.objectiveDigest, planId: current.planId, planVersion: current.planVersion,
        allowedTools: [...new Set(input.allowedTools.filter(validToolName))].slice(0, 50).sort(),
        maxRisk: input.maxRisk, confirmed: input.confirmed === true, revokedAt: null,
      },
      status: "paused", nextAction: "resume after state verification", interruptionReason: "authorization renewed",
      updatedAt: now, version: current.version + 1,
    };
    return await this.deps.store.compareAndSetSession(next, current.version) ? next : null;
  }

  async resume(userId: string, sessionId: string, workerId: string): Promise<ResumeResult> {
    if (!validId(userId) || !validId(sessionId) || !validId(workerId)) return { ok: false, code: "invalid_identity", session: null };
    const lease = await this.deps.store.acquireSessionLease(userId, sessionId, workerId, this.leaseTtlMs);
    if (!lease) return { ok: false, code: "lease_unavailable", session: await this.get(userId, sessionId) };
    const claim = claimOf(lease);
    const controller = new AbortController();
    let leaseLost = false;
    let renewing = false;
    const interval = setInterval(async () => {
      if (renewing || leaseLost) return;
      renewing = true;
      try {
        const renewed = await this.deps.store.renewSessionLease({ userId, sessionId, ...claim }, this.leaseTtlMs);
        if (!renewed) { leaseLost = true; controller.abort("distributed lease lost"); }
      } finally { renewing = false; }
    }, Math.max(250, Math.floor(this.leaseTtlMs / 3)));
    interval.unref?.();

    try {
      let session = await this.deps.store.getSession(userId, sessionId);
      if (!session || session.userId !== userId) return { ok: false, code: "not_found", session: null };
      if (TERMINAL_SESSION_STATUSES.has(session.status)) return { ok: false, code: "terminal", session };
      if (session.timeoutAt <= this.now()) {
        session = await this.workerTransition(session, claim, { status: "timed_out", interruptionReason: "session timeout elapsed", nextAction: null });
        return { ok: false, code: "timed_out", session };
      }
      const authFailure = validateAuthorization(session, this.now());
      if (authFailure) {
        session = await this.workerTransition(session, claim, { status: "awaiting_reauthorization", interruptionReason: authFailure, nextAction: "reauthorize this plan version" });
        return { ok: false, code: "reauthorization_required", session };
      }
      const stale = Boolean(session.currentCheckpoint && this.now() - session.currentCheckpoint.recordedAt > this.checkpointMaxAgeMs);
      const verification = await this.deps.verifyResume(session, { checkpointStale: stale });
      if (verification.status !== "VERIFIED") {
        const status = verification.status === "FAILED" ? "blocked" : "paused";
        session = await this.workerTransition(session, claim, {
          status, interruptionReason: `resume verification ${verification.status.toLowerCase()}: ${cleanText(verification.reason, 300)}`,
          nextAction: verification.status === "FAILED" ? "resolve changed world state and reauthorize if needed" : "retry verification when state is observable",
        });
        return { ok: false, code: verification.status === "FAILED" ? "world_state_changed" : "verification_inconclusive", session };
      }

      session = await this.workerTransition(session, claim, { status: "running", interruptionReason: null, nextAction: session.nextAction ?? "continue plan" });
      if (!session) return { ok: false, code: "checkpoint_conflict", session: await this.get(userId, sessionId) };
      const control: SessionRunControl = {
        signal: controller.signal,
        checkpoint: async (input) => {
          if (leaseLost) return false;
          const live = await this.deps.store.getSession(userId, sessionId);
          if (!live || live.status !== "running") { controller.abort("session interrupted"); return false; }
          const checkpoint = makeCheckpoint(live, input, this.now());
          const next = appendCheckpoint(live, checkpoint, this.now());
          return this.deps.store.compareAndSetSession(next, live.version, claim);
        },
        heartbeat: async () => {
          if (leaseLost) return false;
          const renewed = await this.deps.store.renewSessionLease({ userId, sessionId, ...claim }, this.leaseTtlMs);
          if (!renewed) { leaseLost = true; controller.abort("distributed lease lost"); return false; }
          return true;
        },
        shouldStop: async () => {
          if (leaseLost || controller.signal.aborted) return true;
          const live = await this.deps.store.getSession(userId, sessionId);
          const stop = !live || live.status !== "running" || live.timeoutAt <= this.now();
          if (stop) controller.abort("session interrupted");
          return stop;
        },
      };
      const result = await this.deps.run(session, control);
      if (leaseLost) return { ok: false, code: "lease_lost", session: await this.get(userId, sessionId) };
      const live = await this.deps.store.getSession(userId, sessionId);
      if (!live || live.status !== "running") return { ok: false, code: "interrupted", session: live };
      const checkpoint = makeCheckpoint(live, {
        executionRecordVersion: result.executionRecordVersion ?? null,
        completedStepIds: result.completedStepIds ?? [],
        verificationStatus: result.verificationStatus ?? (result.status === "completed" ? "VERIFIED" : "INCONCLUSIVE"),
        worldStateToken: result.worldStateToken ?? verification.worldStateToken ?? null,
        note: result.reason,
        nextAction: result.nextAction ?? null,
      }, this.now());
      let next = appendCheckpoint(live, checkpoint, this.now());
      next = finalize(next, result, this.now());
      if (!(await this.deps.store.compareAndSetSession(next, live.version, claim))) {
        return { ok: false, code: "checkpoint_conflict", session: await this.get(userId, sessionId) };
      }
      return { ok: next.status === "completed", code: next.status, session: next };
    } catch (error) {
      const current = await this.deps.store.getSession(userId, sessionId);
      if (current && current.status === "running" && !leaseLost) {
        const failed = await this.workerTransition(current, claim, {
          status: "failed", interruptionReason: "runner exception", nextAction: "inspect failure before retry",
          failure: { code: "runner_exception", message: error instanceof Error ? cleanText(error.message, 300) : "unknown runner exception", retryable: false },
        });
        return { ok: false, code: "runner_exception", session: failed };
      }
      return { ok: false, code: leaseLost ? "lease_lost" : "runner_exception", session: current };
    } finally {
      clearInterval(interval);
      await this.deps.store.releaseSessionLease({ userId, sessionId, ...claim });
    }
  }

  private async interrupt(userId: string, sessionId: string, status: "paused" | "cancelled", reason: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.deps.store.getSession(userId, sessionId);
      if (!current || current.userId !== userId || TERMINAL_SESSION_STATUSES.has(current.status)) return false;
      const next: ExecutionSession = {
        ...current, status, interruptionReason: cleanText(reason, 300), nextAction: status === "paused" ? "resume after verification" : null,
        authorizationScope: status === "cancelled" ? { ...current.authorizationScope, revokedAt: this.now() } : current.authorizationScope,
        updatedAt: this.now(), version: current.version + 1,
      };
      if (await this.deps.store.compareAndSetSession(next, current.version)) return true;
    }
    return false;
  }

  private async workerTransition(current: ExecutionSession, claim: SessionLeaseClaim, patch: Partial<ExecutionSession>): Promise<ExecutionSession | null> {
    const next = { ...current, ...patch, updatedAt: this.now(), version: current.version + 1 };
    return await this.deps.store.compareAndSetSession(next, current.version, claim) ? next : null;
  }
}

export function objectiveDigest(objective: string): string {
  return createHash("sha256").update(objective.trim(), "utf8").digest("hex");
}

function validateAuthorization(session: ExecutionSession, now: number): string | null {
  const scope = session.authorizationScope;
  if (scope.revokedAt !== null) return "authorization was revoked";
  if (scope.expiresAt <= now) return "authorization expired";
  if (scope.grantedBy !== "authenticated_user") return "authorization source is invalid";
  if (scope.objectiveDigest !== session.objectiveDigest || objectiveDigest(session.objective) !== session.objectiveDigest) return "objective changed";
  if (scope.planId !== session.planId || scope.planVersion !== session.planVersion) return "plan version changed";
  return null;
}

function makeCheckpoint(session: ExecutionSession, input: Omit<ExecutionCheckpoint, "checkpointId" | "sequence" | "recordedAt" | "planId" | "planVersion" | "requestId">, now: number): ExecutionCheckpoint {
  return {
    checkpointId: randomUUID(), sequence: (session.currentCheckpoint?.sequence ?? 0) + 1,
    planId: session.planId, planVersion: session.planVersion, requestId: session.requestId,
    executionRecordVersion: input.executionRecordVersion,
    completedStepIds: [...new Set(input.completedStepIds)].slice(0, EXECUTION_SESSION_LIMITS.maxCompletedStepIds),
    verificationStatus: input.verificationStatus, worldStateToken: input.worldStateToken ?? null,
    recordedAt: now, note: cleanText(input.note, 500), nextAction: input.nextAction ? cleanText(input.nextAction, EXECUTION_SESSION_LIMITS.maxNextActionChars) : null,
  };
}

function appendCheckpoint(session: ExecutionSession, checkpoint: ExecutionCheckpoint, now: number): ExecutionSession {
  return {
    ...session, currentCheckpoint: checkpoint,
    checkpoints: [...session.checkpoints, checkpoint].slice(-EXECUTION_SESSION_LIMITS.maxCheckpoints),
    nextAction: checkpoint.nextAction, updatedAt: now, version: session.version + 1,
  };
}

function finalize(session: ExecutionSession, result: SessionRunResult, now: number): ExecutionSession {
  if (result.status === "completed" && result.verificationStatus !== "VERIFIED") {
    return { ...session, status: "paused", interruptionReason: "completion was not verified", nextAction: "verify outcome before completion", updatedAt: now };
  }
  if (result.status === "completed") return { ...session, status: "completed", interruptionReason: null, nextAction: null, failure: null, updatedAt: now };
  if (result.status === "partial" || result.status === "paused" || result.interruption) {
    return { ...session, status: "paused", interruptionReason: result.interruption ?? cleanText(result.reason, 300), nextAction: result.nextAction ?? "resume after verification", updatedAt: now };
  }
  return {
    ...session, status: "failed", interruptionReason: cleanText(result.reason, 300), nextAction: result.retryable ? "inspect and retry after verification" : null,
    failure: { code: result.failureCode ?? "execution_failed", message: cleanText(result.reason, 300), retryable: result.retryable === true }, updatedAt: now,
  };
}

function claimOf(lease: SessionLease): SessionLeaseClaim {
  return { workerId: lease.workerId, leaseToken: lease.leaseToken, fencingToken: lease.fencingToken };
}
function validId(value: string): boolean { return /^[A-Za-z0-9#_.:-]{1,160}$/.test(value); }
function validToolName(value: string): boolean { return /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(value); }
function cleanText(value: string, max: number): string { return String(value ?? "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, max); }
function bounded(value: number, min: number, max: number): number { return Math.min(Math.max(Number.isFinite(value) ? value : min, min), max); }
