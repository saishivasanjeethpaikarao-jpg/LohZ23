/**
 * Restart-safe local repository used when Firestore is unavailable. It keeps
 * user-owned execution metadata in separate atomic JSON files. This is a
 * durable fallback, not a claim of production Firestore deployment.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { PlanStore } from "../planner/planPersistence";
import type { Plan } from "../planner/types";
import type { ObservationStore } from "../observation/observationStore";
import type { Observation } from "../observation/types";
import { OBSERVATION_LIMITS } from "../observation/types";
import type { ExecutionStore } from "./persistence";
import type { ExecutionRecord } from "./types";
import { runtimeDataRoot } from "../runtimePaths";
import type { IdempotencyRecord, IdempotencyStore } from "./idempotency";
import type { ExecutionLease, ExecutionLeaseStore } from "./executionLease";

interface UserExecutionData {
  uid: string;
  version: 1;
  plans: Record<string, Plan>;
  executions: Record<string, ExecutionRecord>;
  observations: Record<string, Observation[]>;
  idempotency: Record<string, IdempotencyRecord>;
  updatedAt: number;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function safeUid(uid: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new Error("DurableExecutionRepository: invalid uid");
  return Buffer.from(uid, "utf8").toString("base64url");
}

export class DurableExecutionRepository implements PlanStore, ExecutionStore, ObservationStore, IdempotencyStore, ExecutionLeaseStore {
  private readonly root: string;

  constructor(root = runtimeDataRoot("phase33")) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
    fs.mkdirSync(path.join(this.root, "leases"), { recursive: true });
  }

  private file(uid: string): string {
    return path.join(this.root, `${safeUid(uid)}.json`);
  }

  listUserIds(): string[] {
    try {
      return fs.readdirSync(this.root)
        .filter((name) => name.endsWith(".json"))
        .map((name) => Buffer.from(name.slice(0, -5), "base64url").toString("utf8"))
        .filter((uid) => /^[A-Za-z0-9_-]{1,128}$/.test(uid));
    } catch { return []; }
  }

  private load(uid: string): UserExecutionData {
    const file = this.file(uid);
    if (!fs.existsSync(file)) {
      return { uid, version: 1, plans: {}, executions: {}, observations: {}, idempotency: {}, updatedAt: Date.now() };
    }
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as UserExecutionData;
      if (data.uid !== uid || data.version !== 1) throw new Error("owner/schema mismatch");
      return data;
    } catch {
      throw new Error("DurableExecutionRepository: persistence unavailable or malformed");
    }
  }

  private save(uid: string, data: UserExecutionData): boolean {
    if (data.uid !== uid) return false;
    const file = this.file(uid);
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      data.updatedAt = Date.now();
      fs.writeFileSync(temp, JSON.stringify(data), { encoding: "utf8", flag: "wx" });
      fs.renameSync(temp, file);
      return true;
    } catch {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ }
      return false;
    }
  }

  async savePlan(uid: string, plan: Plan): Promise<boolean> {
    if (plan.userId !== uid) return false;
    const data = this.load(uid); data.plans[plan.id] = clone(plan); return this.save(uid, data);
  }
  async getPlan(uid: string, planId: string): Promise<Plan | null> {
    const value = this.load(uid).plans[planId]; return value ? clone(value) : null;
  }
  async deletePlan(uid: string, planId: string): Promise<boolean> {
    const data = this.load(uid); if (!data.plans[planId]) return false; delete data.plans[planId]; return this.save(uid, data);
  }
  async listPlans(uid: string, limit = 20): Promise<Plan[]> {
    return Object.values(this.load(uid).plans).sort((a, b) => a.updatedAt - b.updatedAt).slice(-limit).map(clone);
  }

  async getExecution(uid: string, requestId: string): Promise<ExecutionRecord | null> {
    const value = this.load(uid).executions[requestId]; return value ? clone(value) : null;
  }
  async saveExecution(record: ExecutionRecord): Promise<boolean> {
    const data = this.load(record.uid); if (data.executions[record.requestId]) return false;
    data.executions[record.requestId] = clone(record); return this.save(record.uid, data);
  }
  async updateExecution(record: ExecutionRecord): Promise<boolean> {
    const data = this.load(record.uid); if (!data.executions[record.requestId]) return false;
    data.executions[record.requestId] = clone(record); return this.save(record.uid, data);
  }
  async deleteExecution(uid: string, requestId: string): Promise<boolean> {
    const data = this.load(uid); if (!data.executions[requestId]) return false;
    delete data.executions[requestId]; return this.save(uid, data);
  }
  async listExecutions(uid: string, limit = 20): Promise<ExecutionRecord[]> {
    return Object.values(this.load(uid).executions).sort((a, b) => a.startedAt - b.startedAt).slice(-limit).map(clone);
  }

  async add(uid: string, requestId: string, obs: Observation): Promise<boolean> {
    if (obs.uid !== uid || obs.requestId !== requestId) return false;
    const data = this.load(uid); const list = data.observations[requestId] ?? [];
    if (list.length >= OBSERVATION_LIMITS.perPlan) return false;
    if (list.filter((o) => o.stepId === obs.stepId).length >= OBSERVATION_LIMITS.perStep) return false;
    list.push(clone(obs)); data.observations[requestId] = list; return this.save(uid, data);
  }
  async listForStep(uid: string, requestId: string, stepId: string): Promise<Observation[]> {
    return (await this.listForRequest(uid, requestId)).filter((o) => o.stepId === stepId);
  }
  async listForRequest(uid: string, requestId: string): Promise<Observation[]> {
    return clone(this.load(uid).observations[requestId] ?? []);
  }

  async get(uid: string, key: string): Promise<IdempotencyRecord | null> {
    const value = this.load(uid).idempotency[key]; return value ? clone(value) : null;
  }
  async put(record: IdempotencyRecord): Promise<boolean> {
    if (record.uid.length === 0) return false;
    const data = this.load(record.uid); data.idempotency[record.key] = clone(record); return this.save(record.uid, data);
  }
  async delete(uid: string, key: string): Promise<boolean> {
    const data = this.load(uid); if (!data.idempotency[key]) return false; delete data.idempotency[key]; return this.save(uid, data);
  }

  private leaseFile(uid: string, planId: string): string {
    const planKey = createHash("sha256").update(planId).digest("hex");
    return path.join(this.root, "leases", `${safeUid(uid)}-${planKey}.json`);
  }

  async acquireExecutionLease(uid: string, planId: string, requestId: string, ttlMs: number): Promise<boolean> {
    if (!planId || !requestId || !Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60 * 1_000) return false;
    const file = this.leaseFile(uid, planId);
    const now = Date.now();
    const lease: ExecutionLease = { uid, planId, requestId, acquiredAt: now, expiresAt: now + ttlMs, version: 1 };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.writeFileSync(file, JSON.stringify(lease), { encoding: "utf8", flag: "wx" });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      }
      try {
        const current = JSON.parse(fs.readFileSync(file, "utf8")) as ExecutionLease;
        if (current.uid !== uid || current.planId !== planId) return false;
        if (current.requestId === requestId && current.expiresAt > now) return true;
        if (current.expiresAt > now) return false;
        const stale = `${file}.${process.pid}.${Date.now()}.stale`;
        fs.renameSync(file, stale);
        try { fs.unlinkSync(stale); } catch { /* best effort */ }
      } catch {
        return false;
      }
    }
    return false;
  }

  async releaseExecutionLease(uid: string, planId: string, requestId: string): Promise<boolean> {
    const file = this.leaseFile(uid, planId);
    try {
      if (!fs.existsSync(file)) return true;
      const current = JSON.parse(fs.readFileSync(file, "utf8")) as ExecutionLease;
      if (current.uid !== uid || current.planId !== planId || current.requestId !== requestId) return false;
      fs.unlinkSync(file);
      return true;
    } catch { return false; }
  }
}
