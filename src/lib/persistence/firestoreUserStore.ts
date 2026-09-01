/**
 * Firestore-backed durable storage for LOHZ user data.
 *
 * One thin, storage-agnostic abstraction so the rest of the codebase never
 * imports firebase-admin directly. All read/write methods take an explicit
 * `uid`; callers MUST pass an authenticated UID (server middleware verifies
 * the bearer token before forwarding here).
 *
 * Backend = firebase-admin. The frontend Firebase client config in
 * `src/lib/firebase.ts` is auth-only and does NOT see this surface.
 *
 * Failure mode: every method returns `null` or `false` on backend failure
 * instead of throwing — callers degrade gracefully and report the failure.
 * Credentials are never stored here; they remain in the encrypted
 * `credentialStore` (AES-256-GCM on disk).
 */
import * as admin from "firebase-admin";
// firebase-admin v14+ exposes Firestore ONLY via this subpath.
import { getFirestore as adminGetFirestore } from "firebase-admin/firestore";
import type { Memory } from "../memoryTypes";
import type { UserInteractionPreferences } from "../userPreferences";

export interface UserProfile {
  uid: string;
  displayName: string | null;
  createdAt: number;
  lastSeenAt: number;
  schemaVersion: number;
}

export interface CognitiveStateRecord {
  uid: string;
  cognitiveState: Record<string, unknown>;
  turnsSinceReflection: number;
  pendingActions: Array<{ tool: string; intendedOutcome: string; startTs: number }>;
  updatedAt: number;
}

/**
 * Phase 26 — widened goal record. Original Phase 22 fields are intact;
 * autonomous-goal metadata rides as OPTIONAL fields so legacy writers
 * and readers remain compatible. `status` union gained lifecycle states
 * (proposed/paused/stale/cancelled/progressing) — purely additive.
 */
export interface GoalRecord {
  id: string;
  title: string;
  description: string;
  status:
    | "active" | "completed" | "blocked" | "dropped"
    | "proposed" | "progressing" | "paused" | "cancelled" | "stale";
  createdAt: number;
  updatedAt: number;
  // ── Phase 26 optional metadata ──
  source?: "user" | "explicit_request" | "derived" | "system";
  priority?: number;                       // 0..1 effective
  priorityLevel?: "critical" | "high" | "medium" | "low";
  progress?: number;                       // 0..1
  lastProgressAt?: number;
  deadline?: number;
  parentGoalId?: string;
  relatedProjectKey?: string;
  relatedMemoryIds?: string[];
  relatedWorldAssertionIds?: string[];
  confidence?: number;
  blockedReason?: string;
  blockingGoalId?: string;
  conflictWith?: string[];
  dependsOn?: string[];
  nextAction?: string;
  autonomyLevel?: number;                  // 0..5 policy metadata only
  repetitionCount?: number;
  version?: number;                        // optimistic lock
}

export interface LearningPattern {
  id: string;
  type: string;
  confidence: number;
  data: Record<string, unknown>;
  updatedAt: number;
}

export interface MigrationReceipt {
  source: string;
  sourceCount: number;
  fingerprint: string;
  migratedAt: number;
}

/**
 * Phase 24 — persisted UserModel/WorldState bundle record.
 * The bundle itself is opaque JSON (validated by UserModelEngine);
 * this layer only guarantees uid-scoped storage.
 */
export interface UserModelBundleRecord {
  uid: string;
  bundle: unknown;
  updatedAt: number;
}

export interface FirestoreUserStore {
  // Profile
  ensureProfile(uid: string, displayName?: string | null): Promise<UserProfile | null>;
  getProfile(uid: string): Promise<UserProfile | null>;

  // Preferences
  getPreferences(uid: string): Promise<UserInteractionPreferences | null>;
  setPreferences(uid: string, prefs: UserInteractionPreferences): Promise<boolean>;

  // Memories
  listMemories(uid: string): Promise<Memory[] | null>;
  putMemory(uid: string, memory: Memory): Promise<boolean>;
  deleteMemory(uid: string, memoryId: string): Promise<boolean>;
  replaceMemories(uid: string, memories: Memory[]): Promise<boolean>;

  // Cognitive state
  getCognitiveState(uid: string): Promise<CognitiveStateRecord | null>;
  setCognitiveState(uid: string, state: CognitiveStateRecord): Promise<boolean>;

  // Goals
  listGoals(uid: string): Promise<GoalRecord[] | null>;
  putGoal(uid: string, goal: GoalRecord): Promise<boolean>;
  deleteGoal(uid: string, goalId: string): Promise<boolean>;

  // Learning patterns
  listLearning(uid: string): Promise<LearningPattern[] | null>;
  putLearning(uid: string, pattern: LearningPattern): Promise<boolean>;

  // Migration bookkeeping
  getMigrationReceipt(uid: string, source: string): Promise<MigrationReceipt | null>;
  recordMigrationReceipt(uid: string, source: string, receipt: MigrationReceipt): Promise<boolean>;

  // Phase 24 — user model bundle
  getModelBundle(uid: string): Promise<UserModelBundleRecord | null>;
  setModelBundle(uid: string, record: UserModelBundleRecord): Promise<boolean>;

  // Phase 25 — bounded temporal state (ring-buffered events/topics/sessions)
  getTemporalState(uid: string): Promise<Record<string, unknown> | null>;
  setTemporalState(uid: string, state: Record<string, unknown>): Promise<boolean>;

  // Phase 34 — durable plan/execution/observation seams
  getUserDoc(uid: string, collection: "plans" | "executions" | "observations", id: string): Promise<Record<string, unknown> | null>;
  setUserDoc(uid: string, collection: "plans" | "executions" | "observations", id: string, data: Record<string, unknown>): Promise<boolean>;
  deleteUserDoc(uid: string, collection: "plans" | "executions" | "observations", id: string): Promise<boolean>;
  listUserDocs(uid: string, collection: "plans" | "executions" | "observations"): Promise<Array<{ id: string; data: Record<string, unknown> }> | null>;

  // Diagnostic
  isHealthy(): Promise<boolean>;
  close(): Promise<void>;
}

const SCHEMA_VERSION = 1;

/** Validate a uid for path safety — Firestore paths reject certain chars. */
function assertSafeUid(uid: string): void {
  if (!uid || typeof uid !== "string") {
    throw new Error("FirestoreUserStore: uid is required");
  }
  if (uid.length > 128) {
    throw new Error("FirestoreUserStore: uid too long");
  }
  if (uid.includes("/") || uid.includes("..") || uid.includes("\0")) {
    throw new Error("FirestoreUserStore: uid contains illegal characters");
  }
}

export interface FirestoreDocHandle {
  get(): Promise<{ exists: boolean; data(): unknown }>;
  set(value: unknown, opts?: { merge?: boolean }): Promise<void>;
  delete(): Promise<void>;
}

export interface FirestoreCollectionHandle {
  doc(id: string): FirestoreDocHandle;
  /** Non-standard helper implemented by the MockFirestore and by the
   *  production adapter wrapping firebase-admin's CollectionReference. */
  listIds(): Promise<string[]>;
}

export interface FirestoreLike {
  collection(path: string): FirestoreCollectionHandle;
  doc(path: string): FirestoreDocHandle;
  runTransaction<T>(fn: (tx: {
    get(ref: { path: string }): Promise<{ exists: boolean; data(): unknown }>;
    set(ref: { path: string }, value: unknown): void;
    delete(ref: { path: string }): void;
  }) => Promise<T>): Promise<T>;
}

export interface FirestoreConfig {
  /** Firestore instance from firebase-admin.firestore() — pass-through for tests */
  db: FirestoreLike;
  /** Optional logger — captures failures without throwing */
  log?: (msg: string, err?: unknown) => void;
}

export class FirestoreUserStoreImpl implements FirestoreUserStore {
  private db: FirestoreLike;
  private log: (msg: string, err?: unknown) => void;

  constructor(cfg: FirestoreConfig) {
    this.db = cfg.db;
    this.log = cfg.log ?? ((m, e) => console.warn(`[firestore] ${m}`, e ?? ""));
  }

  private user(uid: string): FirestoreLike["doc"] extends (p: string) => infer R ? R : never {
    assertSafeUid(uid);
    return this.db.doc(`users/${uid}`) as never;
  }

  private sub(uid: string, sub: string): never {
    assertSafeUid(uid);
    if (!/^[a-zA-Z0-9_]+$/.test(sub)) {
      throw new Error(`FirestoreUserStore: invalid subcollection name '${sub}'`);
    }
    return this.db.doc(`users/${uid}/${sub}/_root`) as never;
  }

  private memoryRef(uid: string, id: string): never {
    assertSafeUid(uid);
    if (!id || id.includes("/")) throw new Error("invalid memory id");
    return this.db.doc(`users/${uid}/memories/${id}`) as never;
  }

  private goalRef(uid: string, id: string): never {
    assertSafeUid(uid);
    if (!id || id.includes("/")) throw new Error("invalid goal id");
    return this.db.doc(`users/${uid}/goals/${id}`) as never;
  }

  private learningRef(uid: string, id: string): never {
    assertSafeUid(uid);
    if (!id || id.includes("/")) throw new Error("invalid learning id");
    return this.db.doc(`users/${uid}/learning/${id}`) as never;
  }

  private migrationRef(uid: string, source: string): never {
    assertSafeUid(uid);
    if (!/^[a-zA-Z0-9_-]+$/.test(source)) {
      throw new Error("invalid migration source");
    }
    return this.db.doc(`users/${uid}/migrations/${source}`) as never;
  }

  async ensureProfile(uid: string, displayName?: string | null): Promise<UserProfile | null> {
    assertSafeUid(uid); // uid validation is a contract violation → reject, don't degrade
    try {
      const now = Date.now();
      const existing = (await (this.user(uid) as any).get()).data() as UserProfile | undefined;
      if (existing && (existing as any).uid) {
        const update = { lastSeenAt: now, displayName: displayName ?? existing.displayName ?? null };
        await (this.user(uid) as any).set(update, { merge: true });
        return { ...existing, ...update };
      }
      const profile: UserProfile = {
        uid,
        displayName: displayName ?? null,
        createdAt: now,
        lastSeenAt: now,
        schemaVersion: SCHEMA_VERSION,
      };
      await (this.user(uid) as any).set(profile);
      return profile;
    } catch (e) {
      this.log("ensureProfile failed", e);
      return null;
    }
  }

  async getProfile(uid: string): Promise<UserProfile | null> {
    assertSafeUid(uid);
    try {
      const snap = await (this.user(uid) as any).get();
      if (!snap.exists) return null;
      return snap.data() as UserProfile;
    } catch (e) {
      this.log("getProfile failed", e);
      return null;
    }
  }

  async getPreferences(uid: string): Promise<UserInteractionPreferences | null> {
    assertSafeUid(uid);
    try {
      const snap = await (this.sub(uid, "preferences") as any).get();
      if (!snap.exists) return null;
      const data = snap.data() as UserInteractionPreferences;
      return data?.userId === uid ? data : null;
    } catch (e) {
      this.log("getPreferences failed", e);
      return null;
    }
  }

  async setPreferences(uid: string, prefs: UserInteractionPreferences): Promise<boolean> {
    assertSafeUid(uid);
    if (!prefs || prefs.userId !== uid) return false;
    try {
      await (this.sub(uid, "preferences") as any).set(prefs);
      return true;
    } catch (e) {
      this.log("setPreferences failed", e);
      return false;
    }
  }

  async listMemories(uid: string): Promise<Memory[] | null> {
    assertSafeUid(uid);
    try {
      const col = this.db.collection(`users/${uid}/memories`);
      // Minimal implementation: fetch all docs via underlying transaction.
      // (Firestore SDK has listDocuments / getDocs; the abstraction above
      //  keeps things storage-agnostic. Real firebase-admin maps cleanly.)
      const ids = await this.listDocIds(col);
      const out: Memory[] = [];
      for (const id of ids) {
        const snap = await (this.memoryRef(uid, id) as any).get();
        if (snap.exists) {
          const memory = snap.data() as Memory;
          if (memory?.metadata?.userId === uid) out.push(memory);
        }
      }
      return out;
    } catch (e) {
      this.log("listMemories failed", e);
      return null;
    }
  }

  async putMemory(uid: string, memory: Memory): Promise<boolean> {
    assertSafeUid(uid);
    if (!memory || !memory.id || memory.metadata.userId !== uid) return false;
    try {
      await (this.memoryRef(uid, memory.id) as any).set(memory);
      return true;
    } catch (e) {
      this.log("putMemory failed", e);
      return false;
    }
  }

  async deleteMemory(uid: string, memoryId: string): Promise<boolean> {
    assertSafeUid(uid);
    try {
      await (this.memoryRef(uid, memoryId) as any).delete();
      return true;
    } catch (e) {
      this.log("deleteMemory failed", e);
      return false;
    }
  }

  async replaceMemories(uid: string, memories: Memory[]): Promise<boolean> {
    assertSafeUid(uid);
    try {
      // Batch via transaction so partial failures roll back.
      await this.db.runTransaction(async (tx) => {
        const col = this.db.collection(`users/${uid}/memories`);
        const existingIds = await this.listDocIds(col);
        const newIds = new Set(memories.map((m) => m.id));
        for (const id of existingIds) {
          if (!newIds.has(id)) {
            tx.delete({ path: `users/${uid}/memories/${id}` });
          }
        }
        for (const m of memories) {
          if (m.metadata.userId !== uid) {
            throw new Error("memory userId mismatch — refusing to write cross-user data");
          }
          tx.set({ path: `users/${uid}/memories/${m.id}` }, m);
        }
      });
      return true;
    } catch (e) {
      this.log("replaceMemories failed", e);
      return false;
    }
  }

  async getCognitiveState(uid: string): Promise<CognitiveStateRecord | null> {
    assertSafeUid(uid);
    try {
      const snap = await (this.sub(uid, "cognitiveState") as any).get();
      if (!snap.exists) return null;
      const data = snap.data() as CognitiveStateRecord;
      return data?.uid === uid ? data : null;
    } catch (e) {
      this.log("getCognitiveState failed", e);
      return null;
    }
  }

  async setCognitiveState(uid: string, state: CognitiveStateRecord): Promise<boolean> {
    assertSafeUid(uid);
    if (!state || state.uid !== uid) return false;
    try {
      await (this.sub(uid, "cognitiveState") as any).set(state);
      return true;
    } catch (e) {
      this.log("setCognitiveState failed", e);
      return false;
    }
  }

  async listGoals(uid: string): Promise<GoalRecord[] | null> {
    try {
      const ids = await this.listDocIds(this.db.collection(`users/${uid}/goals`));
      const out: GoalRecord[] = [];
      for (const id of ids) {
        const snap = await (this.goalRef(uid, id) as any).get();
        if (snap.exists) out.push(snap.data() as GoalRecord);
      }
      return out;
    } catch (e) {
      this.log("listGoals failed", e);
      return null;
    }
  }

  async putGoal(uid: string, goal: GoalRecord): Promise<boolean> {
    if (!goal || !goal.id) return false;
    try {
      await (this.goalRef(uid, goal.id) as any).set(goal);
      return true;
    } catch (e) {
      this.log("putGoal failed", e);
      return false;
    }
  }

  async deleteGoal(uid: string, goalId: string): Promise<boolean> {
    try {
      await (this.goalRef(uid, goalId) as any).delete();
      return true;
    } catch (e) {
      this.log("deleteGoal failed", e);
      return false;
    }
  }

  async listLearning(uid: string): Promise<LearningPattern[] | null> {
    try {
      const ids = await this.listDocIds(this.db.collection(`users/${uid}/learning`));
      const out: LearningPattern[] = [];
      for (const id of ids) {
        const snap = await (this.learningRef(uid, id) as any).get();
        if (snap.exists) out.push(snap.data() as LearningPattern);
      }
      return out;
    } catch (e) {
      this.log("listLearning failed", e);
      return null;
    }
  }

  async putLearning(uid: string, pattern: LearningPattern): Promise<boolean> {
    if (!pattern || !pattern.id) return false;
    try {
      await (this.learningRef(uid, pattern.id) as any).set(pattern);
      return true;
    } catch (e) {
      this.log("putLearning failed", e);
      return false;
    }
  }

  async getMigrationReceipt(uid: string, source: string): Promise<MigrationReceipt | null> {
    try {
      const snap = await (this.migrationRef(uid, source) as any).get();
      if (!snap.exists) return null;
      return snap.data() as MigrationReceipt;
    } catch (e) {
      this.log("getMigrationReceipt failed", e);
      return null;
    }
  }

  async recordMigrationReceipt(uid: string, source: string, receipt: MigrationReceipt): Promise<boolean> {
    try {
      await (this.migrationRef(uid, source) as any).set(receipt);
      return true;
    } catch (e) {
      this.log("recordMigrationReceipt failed", e);
      return false;
    }
  }

  private userModelRef(uid: string): never {
    assertSafeUid(uid);
    return this.db.doc(`users/${uid}/userModel/_root`) as never;
  }

  async getModelBundle(uid: string): Promise<UserModelBundleRecord | null> {
    assertSafeUid(uid);
    try {
      const snap = await (this.userModelRef(uid) as any).get();
      if (!snap.exists) return null;
      const data = snap.data() as UserModelBundleRecord;
      if (!data || data.uid !== uid) return null; // refuse foreign records
      return data;
    } catch (e) {
      this.log("getModelBundle failed", e);
      return null;
    }
  }

  async setModelBundle(uid: string, record: UserModelBundleRecord): Promise<boolean> {
    assertSafeUid(uid);
    if (!record || record.uid !== uid) return false;
    try {
      await (this.userModelRef(uid) as any).set(record);
      return true;
    } catch (e) {
      this.log("setModelBundle failed", e);
      return false;
    }
  }

  private temporalRef(uid: string): never {
    assertSafeUid(uid);
    return this.db.doc(`users/${uid}/temporal/_root`) as never;
  }

  async getTemporalState(uid: string): Promise<Record<string, unknown> | null> {
    assertSafeUid(uid);
    try {
      const snap = await (this.temporalRef(uid) as any).get();
      if (!snap.exists) return null;
      const data = snap.data() as Record<string, unknown> | undefined;
      if (!data || (data as { uid?: string }).uid !== uid) return null;
      return data;
    } catch (e) {
      this.log("getTemporalState failed", e);
      return null;
    }
  }

  async setTemporalState(uid: string, stateData: Record<string, unknown>): Promise<boolean> {
    assertSafeUid(uid);
    if (!stateData || (stateData as { uid?: string }).uid !== uid) return false;
    try {
      await (this.temporalRef(uid) as any).set(stateData);
      return true;
    } catch (e) {
      this.log("setTemporalState failed", e);
      return false;
    }
  }

  // ── Phase 34 generic durable records (plans/executions/observations) ──

  private docFor(uid: string, collection: "plans" | "executions" | "observations", id: string): never {
    assertSafeUid(uid);
    if (!id || id.includes("/") || id.length > 200) throw new Error("invalid record id");
    return this.db.doc(`users/${uid}/${collection}/${id}`) as never;
  }

  async getUserDoc(uid: string, collection: "plans" | "executions" | "observations", id: string): Promise<Record<string, unknown> | null> {
    assertSafeUid(uid);
    try {
      const snap = await (this.docFor(uid, collection, id) as any).get();
      if (!snap.exists) return null;
      const data = snap.data() as Record<string, unknown> | undefined;
      if (!data) return null;
      return data;
    } catch (e) {
      this.log("getUserDoc failed", e);
      return null;
    }
  }

  async setUserDoc(uid: string, collection: "plans" | "executions" | "observations", id: string, data: Record<string, unknown>): Promise<boolean> {
    assertSafeUid(uid);
    if (!data) return false;
    try {
      await (this.docFor(uid, collection, id) as any).set(data);
      return true;
    } catch (e) {
      this.log("setUserDoc failed", e);
      return false;
    }
  }

  async deleteUserDoc(uid: string, collection: "plans" | "executions" | "observations", id: string): Promise<boolean> {
    assertSafeUid(uid);
    try {
      await (this.docFor(uid, collection, id) as any).delete();
      return true;
    } catch (e) {
      this.log("deleteUserDoc failed", e);
      return false;
    }
  }

  async listUserDocs(uid: string, collection: "plans" | "executions" | "observations"): Promise<Array<{ id: string; data: Record<string, unknown> }> | null> {
    assertSafeUid(uid);
    try {
      const ids = await this.listDocIds(this.db.collection(`users/${uid}/${collection}`));
      const out: Array<{ id: string; data: Record<string, unknown> }> = [];
      for (const id of ids) {
        const snap = await (this.docFor(uid, collection, id) as any).get();
        if (snap.exists) out.push({ id, data: snap.data() as Record<string, unknown> });
      }
      return out;
    } catch (e) {
      this.log("listUserDocs failed", e);
      return null;
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      // Best-effort: read any sentinel doc and ignore result.
      await (this.db.doc(`_health/ping`) as any).get();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    // No-op: firebase-admin manages its own connections.
  }

  /** Internal helper: list doc ids inside a collection via the handle. */
  private async listDocIds(collection: FirestoreCollectionHandle): Promise<string[]> {
    return collection.listIds();
  }
}

/**
 * Wrap a firebase-admin `Firestore` instance in the minimal `FirestoreLike`
 * surface the store needs. The wrapper's `listIds` uses
 * `CollectionReference.listDocuments()`, which the Admin SDK always supports
 * (client SDKs don't, so this is server-only by construction).
 */
export function wrapAdminFirestore(adminFirestore: any): FirestoreLike {
  const wrapDoc = (ref: any): FirestoreDocHandle => ({
    get: () => ref.get(),
    set: (value: unknown, opts?: { merge?: boolean }) =>
      opts?.merge ? ref.set(value, { merge: true }) : ref.set(value),
    delete: () => ref.delete(),
  });
  const wrapCollection = (ref: any): FirestoreCollectionHandle => ({
    doc: (id: string) => wrapDoc(ref.doc(id)),
    listIds: async () => (await ref.listDocuments()).map((d: any) => d.id as string),
  });
  return {
    doc: (p: string) => wrapDoc(adminFirestore.doc(p)),
    collection: (p: string) => wrapCollection(adminFirestore.collection(p)),
    runTransaction: <T,>(fn: any) => adminFirestore.runTransaction((adminTx: any) => fn({
      get: (ref: { path: string }) => adminTx.get(adminFirestore.doc(ref.path)),
      set: (ref: { path: string }, value: unknown) => adminTx.set(adminFirestore.doc(ref.path), value),
      delete: (ref: { path: string }) => adminTx.delete(adminFirestore.doc(ref.path)),
    })),
  };
}

/**
 * Resolve a Firestore factory across firebase-admin versions and
 * ESM/CJS interop shapes:
 * - legacy callable:        admin.firestore()
 * - v14+ namespace export:  admin.firestore.getFirestore()
 * - default-export nesting: admin.default.{...}
 */
function resolveFirestoreFactory(): () => any {
  // Preferred: direct subpath import (works on every firebase-admin ≥ v10).
  if (typeof adminGetFirestore === "function") {
    return () => adminGetFirestore();
  }
  const mod = admin as unknown as Record<string, any>;
  for (const candidate of [mod, mod.default]) {
    if (!candidate || typeof candidate !== "object") continue;
    if (typeof candidate.firestore === "function") {
      const c = candidate;
      return () => c.firestore();
    }
    const getFirestore =
      candidate.firestore?.getFirestore ?? candidate.getFirestore;
    if (typeof getFirestore === "function") {
      return () => (getFirestore as () => any)();
    }
  }
  throw new TypeError(
    "firebase-admin Firestore API not found in this runtime's module shape"
  );
}

/** Return the same minimal Admin SDK adapter used by the user store. */
export function createProductionFirestoreLike(): FirestoreLike {
  return wrapAdminFirestore(resolveFirestoreFactory()());
}

/**
 * Build the production FirestoreUserStore using firebase-admin.
 * Caller is responsible for initializing firebase-admin (authMiddleware does this).
 */
export function createProductionFirestoreUserStore(
  configOverride?: Partial<FirestoreConfig>
): FirestoreUserStore {
  const db = configOverride?.db ?? wrapAdminFirestore(resolveFirestoreFactory()());
  return new FirestoreUserStoreImpl({ db, ...configOverride });
}

let cachedStore: FirestoreUserStore | null = null;
export function getFirestoreUserStore(): FirestoreUserStore {
  if (!cachedStore) cachedStore = createProductionFirestoreUserStore();
  return cachedStore;
}
export function resetFirestoreUserStore(): void {
  cachedStore = null;
}
