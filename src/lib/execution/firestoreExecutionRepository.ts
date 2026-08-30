/**
 * Firestore-backed Phase 33 execution repository.
 *
 * All paths are rooted beneath the authenticated user's document. Records
 * carry their owner as well, and every read validates that owner before data
 * is returned. The repository contains bounded operational metadata only.
 */
import type { FirestoreLike } from "../persistence/firestoreUserStore";
import type { PlanStore } from "../planner/planPersistence";
import type { Plan } from "../planner/types";
import type { ObservationStore } from "../observation/observationStore";
import type { Observation } from "../observation/types";
import { OBSERVATION_LIMITS } from "../observation/types";
import type { ExecutionStore } from "./persistence";
import type { ExecutionRecord } from "./types";
import type { IdempotencyRecord, IdempotencyStore } from "./idempotency";

interface ObservationDocument {
  uid: string;
  requestId: string;
  observations: Observation[];
  updatedAt: number;
  version: 1;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function safeSegment(value: string, label: string): string {
  if (!value || value.length > 512 || value.includes("/") || value.includes("\0") || value === "." || value === "..") {
    throw new Error(`FirestoreExecutionRepository: invalid ${label}`);
  }
  return value;
}

function encodedKey(value: string): string {
  if (!value || value.length > 2048) throw new Error("FirestoreExecutionRepository: invalid idempotency key");
  return Buffer.from(value, "utf8").toString("base64url");
}

export class FirestoreExecutionRepository implements PlanStore, ExecutionStore, ObservationStore, IdempotencyStore {
  constructor(
    private readonly db: FirestoreLike,
    private readonly log: (message: string, error?: unknown) => void = (message, error) => console.warn(`[firestore-execution] ${message}`, error ?? ""),
  ) {}

  private path(uid: string, collection: "plans" | "executions" | "observations" | "idempotency", id: string): string {
    return `users/${safeSegment(uid, "uid")}/${collection}/${safeSegment(id, "document id")}`;
  }

  async listUserIds(): Promise<string[]> {
    try {
      return (await this.db.collection("users").listIds()).filter((uid) => {
        try { safeSegment(uid, "uid"); return true; } catch { return false; }
      });
    } catch (error) {
      this.log("listUserIds failed", error);
      return [];
    }
  }

  async savePlan(uid: string, plan: Plan): Promise<boolean> {
    if (!plan || plan.userId !== uid) return false;
    try {
      await this.db.doc(this.path(uid, "plans", plan.id)).set(clone(plan));
      return true;
    } catch (error) { this.log("savePlan failed", error); return false; }
  }

  async getPlan(uid: string, planId: string): Promise<Plan | null> {
    try {
      const snap = await this.db.doc(this.path(uid, "plans", planId)).get();
      if (!snap.exists) return null;
      const plan = snap.data() as Plan;
      return plan?.userId === uid ? clone(plan) : null;
    } catch (error) { this.log("getPlan failed", error); return null; }
  }

  async deletePlan(uid: string, planId: string): Promise<boolean> {
    try {
      const ref = this.db.doc(this.path(uid, "plans", planId));
      if (!(await ref.get()).exists) return false;
      await ref.delete();
      return true;
    } catch (error) { this.log("deletePlan failed", error); return false; }
  }

  async listPlans(uid: string, limit = 20): Promise<Plan[]> {
    try {
      const collection = this.db.collection(`users/${safeSegment(uid, "uid")}/plans`);
      const plans: Plan[] = [];
      for (const id of await collection.listIds()) {
        const plan = await this.getPlan(uid, id);
        if (plan) plans.push(plan);
      }
      return plans.sort((a, b) => a.updatedAt - b.updatedAt).slice(-Math.max(0, limit));
    } catch (error) { this.log("listPlans failed", error); return []; }
  }

  async getExecution(uid: string, requestId: string): Promise<ExecutionRecord | null> {
    try {
      const snap = await this.db.doc(this.path(uid, "executions", requestId)).get();
      if (!snap.exists) return null;
      const record = snap.data() as ExecutionRecord;
      return record?.uid === uid && record?.requestId === requestId ? clone(record) : null;
    } catch (error) { this.log("getExecution failed", error); return null; }
  }

  async saveExecution(record: ExecutionRecord): Promise<boolean> {
    if (!record?.uid || !record?.requestId) return false;
    try {
      const ref = this.db.doc(this.path(record.uid, "executions", record.requestId));
      if ((await ref.get()).exists) return false;
      await ref.set(clone(record));
      return true;
    } catch (error) { this.log("saveExecution failed", error); return false; }
  }

  async updateExecution(record: ExecutionRecord): Promise<boolean> {
    if (!record?.uid || !record?.requestId) return false;
    try {
      const ref = this.db.doc(this.path(record.uid, "executions", record.requestId));
      if (!(await ref.get()).exists) return false;
      await ref.set(clone(record));
      return true;
    } catch (error) { this.log("updateExecution failed", error); return false; }
  }

  async deleteExecution(uid: string, requestId: string): Promise<boolean> {
    try {
      const ref = this.db.doc(this.path(uid, "executions", requestId));
      if (!(await ref.get()).exists) return false;
      await ref.delete();
      return true;
    } catch (error) { this.log("deleteExecution failed", error); return false; }
  }

  async listExecutions(uid: string, limit = 20): Promise<ExecutionRecord[]> {
    try {
      const collection = this.db.collection(`users/${safeSegment(uid, "uid")}/executions`);
      const records: ExecutionRecord[] = [];
      for (const id of await collection.listIds()) {
        const record = await this.getExecution(uid, id);
        if (record) records.push(record);
      }
      return records.sort((a, b) => a.startedAt - b.startedAt).slice(-Math.max(0, limit));
    } catch (error) { this.log("listExecutions failed", error); return []; }
  }

  async add(uid: string, requestId: string, observation: Observation): Promise<boolean> {
    if (!observation || observation.uid !== uid || observation.requestId !== requestId) return false;
    try {
      const path = this.path(uid, "observations", requestId);
      return await this.db.runTransaction(async (tx) => {
        const snap = await tx.get({ path });
        const existing = snap.exists ? snap.data() as ObservationDocument : null;
        if (existing && (existing.uid !== uid || existing.requestId !== requestId)) return false;
        const observations = clone(existing?.observations ?? []);
        if (observations.length >= OBSERVATION_LIMITS.perPlan) return false;
        if (observations.filter((item) => item.stepId === observation.stepId).length >= OBSERVATION_LIMITS.perStep) return false;
        observations.push(clone(observation));
        tx.set({ path }, { uid, requestId, observations, updatedAt: Date.now(), version: 1 } satisfies ObservationDocument);
        return true;
      });
    } catch (error) { this.log("add observation failed", error); return false; }
  }

  async listForRequest(uid: string, requestId: string): Promise<Observation[]> {
    try {
      const snap = await this.db.doc(this.path(uid, "observations", requestId)).get();
      if (!snap.exists) return [];
      const record = snap.data() as ObservationDocument;
      if (record?.uid !== uid || record?.requestId !== requestId || !Array.isArray(record.observations)) return [];
      return clone(record.observations);
    } catch (error) { this.log("listForRequest failed", error); return []; }
  }

  async listForStep(uid: string, requestId: string, stepId: string): Promise<Observation[]> {
    return (await this.listForRequest(uid, requestId)).filter((item) => item.stepId === stepId);
  }

  async get(uid: string, key: string): Promise<IdempotencyRecord | null> {
    try {
      const snap = await this.db.doc(this.path(uid, "idempotency", encodedKey(key))).get();
      if (!snap.exists) return null;
      const record = snap.data() as IdempotencyRecord;
      return record?.uid === uid && record?.key === key ? clone(record) : null;
    } catch (error) { this.log("get idempotency failed", error); return null; }
  }

  async put(record: IdempotencyRecord): Promise<boolean> {
    if (!record?.uid || !record?.key) return false;
    try {
      await this.db.doc(this.path(record.uid, "idempotency", encodedKey(record.key))).set(clone(record));
      return true;
    } catch (error) { this.log("put idempotency failed", error); return false; }
  }

  async delete(uid: string, key: string): Promise<boolean> {
    try {
      const ref = this.db.doc(this.path(uid, "idempotency", encodedKey(key)));
      if (!(await ref.get()).exists) return false;
      await ref.delete();
      return true;
    } catch (error) { this.log("delete idempotency failed", error); return false; }
  }
}
