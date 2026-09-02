import fs from "node:fs";
import path from "node:path";
import type { LearningStore } from "./store";
import type { ExperienceRecord, ExperienceReflection, LessonRecord, SkillReliabilityRecord, SkillVersion, ToolReliabilityRecord } from "./types";
import type { AdaptationVersion, DecisionObservation } from "../adaptation/types";
import { LEARNING_LIMITS } from "./types";
import { runtimeDataRoot } from "../runtimePaths";

interface LearningData {
  uid: string;
  schemaVersion: 1;
  experiences: Record<string, ExperienceRecord>;
  reflections?: Record<string, ExperienceReflection>;
  lessons?: Record<string, LessonRecord>;
  decisions?: Record<string, DecisionObservation>;
  adaptations?: Record<string, AdaptationVersion>;
  skills: Record<string, SkillVersion>;
  skillReliability: Record<string, SkillReliabilityRecord>;
  toolReliability: Record<string, ToolReliabilityRecord>;
  updatedAt: number;
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function safeUid(uid: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new Error("LocalLearningStore: invalid uid");
  return Buffer.from(uid, "utf8").toString("base64url");
}
function key(...parts: Array<string | number>): string { return parts.join("::"); }

/** Restart-safe, user-scoped fallback. Writes are serialized and atomically renamed. */
export class LocalLearningStore implements LearningStore {
  private root: string;
  private queues = new Map<string, Promise<void>>();
  constructor(root = runtimeDataRoot("phase36-learning")) {
    this.root = path.resolve(root); fs.mkdirSync(this.root, { recursive: true });
  }
  private file(uid: string): string { return path.join(this.root, `${safeUid(uid)}.json`); }
  private load(uid: string): LearningData {
    const file = this.file(uid);
    if (!fs.existsSync(file)) return { uid, schemaVersion: 1, experiences: {}, reflections: {}, lessons: {}, decisions: {}, adaptations: {}, skills: {}, skillReliability: {}, toolReliability: {}, updatedAt: Date.now() };
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as LearningData;
    if (data.uid !== uid || data.schemaVersion !== 1) throw new Error("LocalLearningStore: owner/schema mismatch");
    data.reflections ??= {};
    data.lessons ??= {};
    data.decisions ??= {};
    data.adaptations ??= {};
    return data;
  }
  private save(uid: string, data: LearningData): boolean {
    if (data.uid !== uid) return false;
    const file = this.file(uid); const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      data.updatedAt = Date.now(); fs.writeFileSync(temp, JSON.stringify(data), { encoding: "utf8", flag: "wx" }); fs.renameSync(temp, file); return true;
    } catch { try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ } return false; }
  }
  private async locked<T>(uid: string, fn: (data: LearningData) => T): Promise<T> {
    const previous = this.queues.get(uid) ?? Promise.resolve(); let result!: T;
    const work = previous.catch(() => undefined).then(() => { result = fn(this.load(uid)); });
    const marker = work.then(() => undefined, () => undefined); this.queues.set(uid, marker); await work;
    if (this.queues.get(uid) === marker) this.queues.delete(uid); return result;
  }
  private async settled(uid: string): Promise<void> { await (this.queues.get(uid) ?? Promise.resolve()); }

  async addExperience(record: ExperienceRecord): Promise<boolean> {
    return this.locked(record.uid, (data) => {
      if (data.experiences[record.id] || Object.keys(data.experiences).length >= LEARNING_LIMITS.maxExperiencesPerUser) return false;
      data.experiences[record.id] = clone(record); return this.save(record.uid, data);
    });
  }
  async getExperience(uid: string, id: string): Promise<ExperienceRecord | null> { await this.settled(uid); const value = this.load(uid).experiences[id]; return value?.uid === uid ? clone(value) : null; }
  async listExperiences(uid: string, limit = LEARNING_LIMITS.maxExperiencesPerUser): Promise<ExperienceRecord[]> { await this.settled(uid); return Object.values(this.load(uid).experiences).sort((a, b) => a.createdAt - b.createdAt).slice(-limit).map(clone); }
  async putReflection(record: ExperienceReflection): Promise<boolean> {
    return this.locked(record.uid, (data) => {
      const reflections = data.reflections!;
      if (reflections[record.experienceId] || Object.keys(reflections).length >= LEARNING_LIMITS.maxReflectionsPerUser) return false;
      reflections[record.experienceId] = clone(record); return this.save(record.uid, data);
    });
  }
  async getReflection(uid: string, experienceId: string): Promise<ExperienceReflection | null> { await this.settled(uid); const value = this.load(uid).reflections![experienceId]; return value?.uid === uid ? clone(value) : null; }
  async listReflections(uid: string, limit = LEARNING_LIMITS.maxReflectionsPerUser): Promise<ExperienceReflection[]> { await this.settled(uid); return Object.values(this.load(uid).reflections!).sort((a, b) => a.generatedAt - b.generatedAt).slice(-limit).map(clone); }
  async putLesson(record: LessonRecord, expectedRevision: number | null): Promise<boolean> {
    return this.locked(record.uid, (data) => {
      const lessons = data.lessons!; const current = lessons[record.lessonId];
      if ((current?.revision ?? null) !== expectedRevision) return false;
      if (!current && Object.keys(lessons).length >= LEARNING_LIMITS.maxLessonsPerUser) return false;
      lessons[record.lessonId] = clone(record); return this.save(record.uid, data);
    });
  }
  async getLesson(uid: string, lessonId: string): Promise<LessonRecord | null> { await this.settled(uid); const value = this.load(uid).lessons![lessonId]; return value?.uid === uid ? clone(value) : null; }
  async listLessons(uid: string, limit = LEARNING_LIMITS.maxLessonsPerUser): Promise<LessonRecord[]> { await this.settled(uid); return Object.values(this.load(uid).lessons!).sort((a, b) => a.updatedAt - b.updatedAt).slice(-limit).map(clone); }
  async addDecisionObservation(record: DecisionObservation): Promise<boolean> {
    return this.locked(record.uid, (data) => {
      const decisions = data.decisions!; if (decisions[record.observationId] || Object.keys(decisions).length >= LEARNING_LIMITS.maxDecisionObservationsPerUser) return false;
      decisions[record.observationId] = clone(record); return this.save(record.uid, data);
    });
  }
  async listDecisionObservations(uid: string, limit = LEARNING_LIMITS.maxDecisionObservationsPerUser): Promise<DecisionObservation[]> { await this.settled(uid); return Object.values(this.load(uid).decisions!).sort((a, b) => a.createdAt - b.createdAt).slice(-Math.max(1, Math.min(LEARNING_LIMITS.maxDecisionObservationsPerUser, limit))).map(clone); }
  async putAdaptationVersion(record: AdaptationVersion, expectedLatestVersion: number | null): Promise<boolean> {
    return this.locked(record.uid, (data) => {
      const values = Object.values(data.adaptations!).filter((item) => item.adaptationId === record.adaptationId);
      const latest = values.length ? Math.max(...values.map((item) => item.version)) : null;
      if (latest !== expectedLatestVersion || data.adaptations![key(record.adaptationId, record.version)] || values.length >= LEARNING_LIMITS.maxAdaptationVersions) return false;
      data.adaptations![key(record.adaptationId, record.version)] = clone(record); return this.save(record.uid, data);
    });
  }
  async getAdaptationVersion(uid: string, adaptationId: string, version: number): Promise<AdaptationVersion | null> { await this.settled(uid); const value = this.load(uid).adaptations![key(adaptationId, version)]; return value?.uid === uid ? clone(value) : null; }
  async listAdaptationVersions(uid: string, adaptationId?: string): Promise<AdaptationVersion[]> { await this.settled(uid); return Object.values(this.load(uid).adaptations!).filter((item) => !adaptationId || item.adaptationId === adaptationId).sort((a, b) => a.version - b.version).map(clone); }
  async transitionAdaptationStatus(uid: string, adaptationId: string, version: number, from: AdaptationVersion["status"], to: AdaptationVersion["status"], patch: Partial<AdaptationVersion> = {}): Promise<boolean> {
    return this.locked(uid, (data) => { const k = key(adaptationId, version); const current = data.adaptations![k]; if (!current || current.uid !== uid || current.status !== from) return false; data.adaptations![k] = clone({ ...current, ...patch, uid, adaptationId, version, status: to }); return this.save(uid, data); });
  }
  async putSkillVersion(record: SkillVersion, expectedLatestVersion: number | null): Promise<boolean> {
    return this.locked(record.uid, (data) => {
      const versions = Object.values(data.skills).filter((item) => item.skillId === record.skillId);
      const latest = versions.length ? Math.max(...versions.map((item) => item.version)) : null;
      if (latest !== expectedLatestVersion || data.skills[key(record.skillId, record.version)] || versions.length >= LEARNING_LIMITS.maxVersionsPerSkill) return false;
      data.skills[key(record.skillId, record.version)] = clone(record); return this.save(record.uid, data);
    });
  }
  async getSkillVersion(uid: string, skillId: string, version: number): Promise<SkillVersion | null> { await this.settled(uid); const value = this.load(uid).skills[key(skillId, version)]; return value?.uid === uid ? clone(value) : null; }
  async listSkillVersions(uid: string, skillId?: string): Promise<SkillVersion[]> { await this.settled(uid); return Object.values(this.load(uid).skills).filter((item) => !skillId || item.skillId === skillId).sort((a, b) => a.version - b.version).map(clone); }
  async transitionSkillStatus(uid: string, skillId: string, version: number, from: SkillVersion["status"], to: SkillVersion["status"], patch: Partial<SkillVersion> = {}): Promise<boolean> {
    return this.locked(uid, (data) => {
      const k = key(skillId, version); const current = data.skills[k]; if (!current || current.uid !== uid || current.status !== from) return false;
      data.skills[k] = clone({ ...current, status: to,
        ...(patch.validation ? { validation: patch.validation } : {}), ...(patch.replay ? { replay: patch.replay } : {}),
        ...(patch.approval ? { approval: patch.approval } : {}), ...(patch.lastVerifiedAt !== undefined ? { lastVerifiedAt: patch.lastVerifiedAt } : {}),
        ...(patch.updatedAt !== undefined ? { updatedAt: patch.updatedAt } : {}),
        ...(patch.degradation !== undefined ? { degradation: patch.degradation } : {}),
      }); return this.save(uid, data);
    });
  }
  async getSkillReliability(uid: string, skillId: string, version: number, environment: string): Promise<SkillReliabilityRecord | null> { await this.settled(uid); return clone(this.load(uid).skillReliability[key(skillId, version, environment)] ?? null); }
  async putSkillReliability(record: SkillReliabilityRecord): Promise<boolean> { return this.locked(record.uid, (data) => { data.skillReliability[key(record.skillId, record.version, record.environment)] = clone(record); return this.save(record.uid, data); }); }
  async getToolReliability(uid: string, toolName: string, environment: string, contextSignature: string): Promise<ToolReliabilityRecord | null> { await this.settled(uid); return clone(this.load(uid).toolReliability[key(toolName, environment, contextSignature)] ?? null); }
  async putToolReliability(record: ToolReliabilityRecord): Promise<boolean> { return this.locked(record.uid, (data) => { data.toolReliability[key(record.toolName, record.environment, record.contextSignature)] = clone(record); return this.save(record.uid, data); }); }
}
