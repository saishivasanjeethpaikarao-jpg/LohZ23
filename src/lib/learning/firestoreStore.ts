import type { FirestoreLike } from "../persistence/firestoreUserStore";
import type { LearningStore } from "./store";
import type { ExperienceRecord, ExperienceReflection, LessonRecord, SkillReliabilityRecord, SkillVersion, ToolReliabilityRecord } from "./types";
import type { AdaptationVersion, DecisionObservation } from "../adaptation/types";

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function safe(value: string, label: string): string {
  if (!value || value.length > 2048) throw new Error(`FirestoreLearningStore: invalid ${label}`);
  return Buffer.from(value, "utf8").toString("base64url");
}
function safeUid(uid: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new Error("FirestoreLearningStore: invalid uid");
  return uid;
}

export class FirestoreLearningStore implements LearningStore {
  constructor(private db: FirestoreLike, private log: (message: string, error?: unknown) => void = (message, error) => console.warn(`[firestore-learning] ${message}`, error ?? "")) {}
  private path(uid: string, collection: string, id: string): string { return `users/${safeUid(uid)}/${collection}/${safe(id, "id")}`; }
  private async list<T>(uid: string, collection: string, owner: (value: T) => boolean): Promise<T[]> {
    try {
      const output: T[] = [];
      for (const id of await this.db.collection(`users/${safeUid(uid)}/${collection}`).listIds()) {
        const snap = await this.db.doc(`users/${safeUid(uid)}/${collection}/${id}`).get();
        if (snap.exists) { const value = snap.data() as T; if (owner(value)) output.push(clone(value)); }
      }
      return output;
    } catch (error) { this.log(`list ${collection} failed`, error); return []; }
  }
  async addExperience(record: ExperienceRecord): Promise<boolean> {
    try { const path = this.path(record.uid, "learningExperiences", record.id); return await this.db.runTransaction(async (tx) => { if ((await tx.get({ path })).exists) return false; tx.set({ path }, clone(record)); return true; }); }
    catch (error) { this.log("add experience failed", error); return false; }
  }
  async getExperience(uid: string, id: string): Promise<ExperienceRecord | null> {
    try { const snap = await this.db.doc(this.path(uid, "learningExperiences", id)).get(); const value = snap.exists ? snap.data() as ExperienceRecord : null; return value?.uid === uid ? clone(value) : null; }
    catch (error) { this.log("get experience failed", error); return null; }
  }
  async listExperiences(uid: string, limit = 500): Promise<ExperienceRecord[]> { return (await this.list<ExperienceRecord>(uid, "learningExperiences", (item) => item.uid === uid)).sort((a, b) => a.createdAt - b.createdAt).slice(-limit); }
  async putReflection(record: ExperienceReflection): Promise<boolean> {
    try { const path = this.path(record.uid, "experienceReflections", record.experienceId); return await this.db.runTransaction(async (tx) => { if ((await tx.get({ path })).exists) return false; tx.set({ path }, clone(record)); return true; }); }
    catch (error) { this.log("put reflection failed", error); return false; }
  }
  async getReflection(uid: string, experienceId: string): Promise<ExperienceReflection | null> {
    try { const snap = await this.db.doc(this.path(uid, "experienceReflections", experienceId)).get(); const value = snap.exists ? snap.data() as ExperienceReflection : null; return value?.uid === uid && value.experienceId === experienceId ? clone(value) : null; }
    catch (error) { this.log("get reflection failed", error); return null; }
  }
  async listReflections(uid: string, limit = 500): Promise<ExperienceReflection[]> { return (await this.list<ExperienceReflection>(uid, "experienceReflections", (item) => item.uid === uid)).sort((a, b) => a.generatedAt - b.generatedAt).slice(-limit); }
  async putLesson(record: LessonRecord, expectedRevision: number | null): Promise<boolean> {
    try { const path = this.path(record.uid, "lessons", record.lessonId); return await this.db.runTransaction(async (tx) => {
      const snap = await tx.get({ path }); const current = snap.exists ? snap.data() as LessonRecord : null;
      if ((current?.revision ?? null) !== expectedRevision) return false;
      tx.set({ path }, clone(record)); return true;
    }); } catch (error) { this.log("put lesson failed", error); return false; }
  }
  async getLesson(uid: string, lessonId: string): Promise<LessonRecord | null> {
    try { const snap = await this.db.doc(this.path(uid, "lessons", lessonId)).get(); const value = snap.exists ? snap.data() as LessonRecord : null; return value?.uid === uid && value.lessonId === lessonId ? clone(value) : null; }
    catch (error) { this.log("get lesson failed", error); return null; }
  }
  async listLessons(uid: string, limit = 300): Promise<LessonRecord[]> { return (await this.list<LessonRecord>(uid, "lessons", (item) => item.uid === uid)).sort((a, b) => a.updatedAt - b.updatedAt).slice(-limit); }
  async addDecisionObservation(record: DecisionObservation): Promise<boolean> {
    try { const path = this.path(record.uid, "decisionObservations", record.observationId); return await this.db.runTransaction(async (tx) => { if ((await tx.get({ path })).exists) return false; tx.set({ path }, clone(record)); return true; }); }
    catch (error) { this.log("add decision observation failed", error); return false; }
  }
  async listDecisionObservations(uid: string, limit = 1000): Promise<DecisionObservation[]> { return (await this.list<DecisionObservation>(uid, "decisionObservations", (item) => item.uid === uid)).sort((a, b) => a.createdAt - b.createdAt).slice(-Math.max(1, Math.min(1000, limit))); }
  async putAdaptationVersion(record: AdaptationVersion, expectedLatestVersion: number | null): Promise<boolean> {
    try {
      const versionPath = this.path(record.uid, "adaptations", `${record.adaptationId}:v${record.version}`); const headPath = this.path(record.uid, "adaptationHeads", record.adaptationId);
      return await this.db.runTransaction(async (tx) => { const [versionSnap, headSnap] = await Promise.all([tx.get({ path: versionPath }), tx.get({ path: headPath })]); const latest = headSnap.exists ? Number((headSnap.data() as { latestVersion?: unknown }).latestVersion) : null; if (versionSnap.exists || latest !== expectedLatestVersion) return false; tx.set({ path: versionPath }, clone(record)); tx.set({ path: headPath }, { uid: record.uid, adaptationId: record.adaptationId, latestVersion: record.version, updatedAt: record.updatedAt }); return true; });
    } catch (error) { this.log("put adaptation failed", error); return false; }
  }
  async getAdaptationVersion(uid: string, adaptationId: string, version: number): Promise<AdaptationVersion | null> { try { const snap = await this.db.doc(this.path(uid, "adaptations", `${adaptationId}:v${version}`)).get(); const value = snap.exists ? snap.data() as AdaptationVersion : null; return value?.uid === uid && value.adaptationId === adaptationId && value.version === version ? clone(value) : null; } catch { return null; } }
  async listAdaptationVersions(uid: string, adaptationId?: string): Promise<AdaptationVersion[]> { return (await this.list<AdaptationVersion>(uid, "adaptations", (item) => item.uid === uid && (!adaptationId || item.adaptationId === adaptationId))).sort((a, b) => a.version - b.version); }
  async transitionAdaptationStatus(uid: string, adaptationId: string, version: number, from: AdaptationVersion["status"], to: AdaptationVersion["status"], patch: Partial<AdaptationVersion> = {}): Promise<boolean> {
    try { const path = this.path(uid, "adaptations", `${adaptationId}:v${version}`); return await this.db.runTransaction(async (tx) => { const snap = await tx.get({ path }); if (!snap.exists) return false; const current = snap.data() as AdaptationVersion; if (current.uid !== uid || current.adaptationId !== adaptationId || current.version !== version || current.status !== from) return false; tx.set({ path }, clone({ ...current, ...patch, uid, adaptationId, version, status: to })); return true; }); } catch { return false; }
  }
  async putSkillVersion(record: SkillVersion, expectedLatestVersion: number | null): Promise<boolean> {
    try {
      const versionPath = this.path(record.uid, "skills", `${record.skillId}:v${record.version}`);
      const headPath = this.path(record.uid, "skillHeads", record.skillId);
      return await this.db.runTransaction(async (tx) => {
        const [versionSnap, headSnap] = await Promise.all([tx.get({ path: versionPath }), tx.get({ path: headPath })]);
        const latest = headSnap.exists ? Number((headSnap.data() as { latestVersion?: unknown }).latestVersion) : null;
        if (versionSnap.exists || latest !== expectedLatestVersion) return false;
        tx.set({ path: versionPath }, clone(record)); tx.set({ path: headPath }, { uid: record.uid, skillId: record.skillId, latestVersion: record.version, updatedAt: Date.now() }); return true;
      });
    } catch (error) { this.log("put skill version failed", error); return false; }
  }
  async getSkillVersion(uid: string, skillId: string, version: number): Promise<SkillVersion | null> {
    try { const snap = await this.db.doc(this.path(uid, "skills", `${skillId}:v${version}`)).get(); const value = snap.exists ? snap.data() as SkillVersion : null; return value?.uid === uid && value.skillId === skillId && value.version === version ? clone(value) : null; }
    catch (error) { this.log("get skill failed", error); return null; }
  }
  async listSkillVersions(uid: string, skillId?: string): Promise<SkillVersion[]> { return (await this.list<SkillVersion>(uid, "skills", (item) => item.uid === uid && (!skillId || item.skillId === skillId))).sort((a, b) => a.version - b.version); }
  async transitionSkillStatus(uid: string, skillId: string, version: number, from: SkillVersion["status"], to: SkillVersion["status"], patch: Partial<SkillVersion> = {}): Promise<boolean> {
    try { const path = this.path(uid, "skills", `${skillId}:v${version}`); return await this.db.runTransaction(async (tx) => {
      const snap = await tx.get({ path }); if (!snap.exists) return false; const current = snap.data() as SkillVersion;
      if (current.uid !== uid || current.skillId !== skillId || current.version !== version || current.status !== from) return false;
      tx.set({ path }, clone({ ...current, status: to,
        ...(patch.validation ? { validation: patch.validation } : {}), ...(patch.replay ? { replay: patch.replay } : {}),
        ...(patch.approval ? { approval: patch.approval } : {}), ...(patch.lastVerifiedAt !== undefined ? { lastVerifiedAt: patch.lastVerifiedAt } : {}),
        ...(patch.updatedAt !== undefined ? { updatedAt: patch.updatedAt } : {}),
        ...(patch.degradation !== undefined ? { degradation: patch.degradation } : {}),
      })); return true;
    }); } catch (error) { this.log("transition skill failed", error); return false; }
  }
  async getSkillReliability(uid: string, skillId: string, version: number, environment: string): Promise<SkillReliabilityRecord | null> {
    try { const snap = await this.db.doc(this.path(uid, "skillReliability", `${skillId}:v${version}:${environment}`)).get(); const value = snap.exists ? snap.data() as SkillReliabilityRecord : null; return value?.uid === uid ? clone(value) : null; } catch { return null; }
  }
  async putSkillReliability(record: SkillReliabilityRecord): Promise<boolean> { try { await this.db.doc(this.path(record.uid, "skillReliability", `${record.skillId}:v${record.version}:${record.environment}`)).set(clone(record)); return true; } catch { return false; } }
  async getToolReliability(uid: string, toolName: string, environment: string, contextSignature: string): Promise<ToolReliabilityRecord | null> {
    try { const snap = await this.db.doc(this.path(uid, "toolReliability", `${toolName}:${environment}:${contextSignature}`)).get(); const value = snap.exists ? snap.data() as ToolReliabilityRecord : null; return value?.uid === uid ? clone(value) : null; } catch { return null; }
  }
  async putToolReliability(record: ToolReliabilityRecord): Promise<boolean> { try { await this.db.doc(this.path(record.uid, "toolReliability", `${record.toolName}:${record.environment}:${record.contextSignature}`)).set(clone(record)); return true; } catch { return false; } }
}
