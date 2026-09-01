import type { ExperienceRecord, ExperienceReflection, LessonRecord, SkillReliabilityRecord, SkillVersion, ToolReliabilityRecord } from "./types";
import type { AdaptationVersion, DecisionObservation } from "../adaptation/types";
import { LEARNING_LIMITS } from "./types";

export interface LearningStore {
  addExperience(record: ExperienceRecord): Promise<boolean>;
  getExperience(uid: string, id: string): Promise<ExperienceRecord | null>;
  listExperiences(uid: string, limit?: number): Promise<ExperienceRecord[]>;
  putReflection(record: ExperienceReflection): Promise<boolean>;
  getReflection(uid: string, experienceId: string): Promise<ExperienceReflection | null>;
  listReflections(uid: string, limit?: number): Promise<ExperienceReflection[]>;
  /** Optimistic compare-and-set. null creates; a number must match the current revision. */
  putLesson(record: LessonRecord, expectedRevision: number | null): Promise<boolean>;
  getLesson(uid: string, lessonId: string): Promise<LessonRecord | null>;
  listLessons(uid: string, limit?: number): Promise<LessonRecord[]>;
  addDecisionObservation(record: DecisionObservation): Promise<boolean>;
  listDecisionObservations(uid: string, limit?: number): Promise<DecisionObservation[]>;
  putAdaptationVersion(record: AdaptationVersion, expectedLatestVersion: number | null): Promise<boolean>;
  getAdaptationVersion(uid: string, adaptationId: string, version: number): Promise<AdaptationVersion | null>;
  listAdaptationVersions(uid: string, adaptationId?: string): Promise<AdaptationVersion[]>;
  transitionAdaptationStatus(uid: string, adaptationId: string, version: number, from: AdaptationVersion["status"], to: AdaptationVersion["status"], patch?: Partial<AdaptationVersion>): Promise<boolean>;
  putSkillVersion(record: SkillVersion, expectedLatestVersion: number | null): Promise<boolean>;
  getSkillVersion(uid: string, skillId: string, version: number): Promise<SkillVersion | null>;
  listSkillVersions(uid: string, skillId?: string): Promise<SkillVersion[]>;
  transitionSkillStatus(uid: string, skillId: string, version: number, from: SkillVersion["status"], to: SkillVersion["status"], patch?: Partial<SkillVersion>): Promise<boolean>;
  getSkillReliability(uid: string, skillId: string, version: number, environment: string): Promise<SkillReliabilityRecord | null>;
  putSkillReliability(record: SkillReliabilityRecord): Promise<boolean>;
  getToolReliability(uid: string, toolName: string, environment: string, contextSignature: string): Promise<ToolReliabilityRecord | null>;
  putToolReliability(record: ToolReliabilityRecord): Promise<boolean>;
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function key(...parts: Array<string | number>): string { return parts.join("::"); }

export class InMemoryLearningStore implements LearningStore {
  private experiences = new Map<string, ExperienceRecord>();
  private reflections = new Map<string, ExperienceReflection>();
  private lessons = new Map<string, LessonRecord>();
  private decisions = new Map<string, DecisionObservation>();
  private adaptations = new Map<string, AdaptationVersion>();
  private skills = new Map<string, SkillVersion>();
  private skillReliability = new Map<string, SkillReliabilityRecord>();
  private toolReliability = new Map<string, ToolReliabilityRecord>();

  async addExperience(record: ExperienceRecord): Promise<boolean> {
    const k = key(record.uid, record.id);
    if (this.experiences.has(k)) return false;
    const count = [...this.experiences.values()].filter((item) => item.uid === record.uid).length;
    if (count >= LEARNING_LIMITS.maxExperiencesPerUser) return false;
    this.experiences.set(k, clone(record)); return true;
  }
  async getExperience(uid: string, id: string): Promise<ExperienceRecord | null> {
    const value = this.experiences.get(key(uid, id)); return value?.uid === uid ? clone(value) : null;
  }
  async listExperiences(uid: string, limit = LEARNING_LIMITS.maxExperiencesPerUser): Promise<ExperienceRecord[]> {
    return [...this.experiences.values()].filter((item) => item.uid === uid).sort((a, b) => a.createdAt - b.createdAt).slice(-limit).map(clone);
  }
  async putReflection(record: ExperienceReflection): Promise<boolean> {
    const k = key(record.uid, record.experienceId);
    if (this.reflections.has(k)) return false;
    const count = [...this.reflections.values()].filter((item) => item.uid === record.uid).length;
    if (count >= LEARNING_LIMITS.maxReflectionsPerUser) return false;
    this.reflections.set(k, clone(record)); return true;
  }
  async getReflection(uid: string, experienceId: string): Promise<ExperienceReflection | null> {
    const value = this.reflections.get(key(uid, experienceId)); return value?.uid === uid ? clone(value) : null;
  }
  async listReflections(uid: string, limit = LEARNING_LIMITS.maxReflectionsPerUser): Promise<ExperienceReflection[]> {
    return [...this.reflections.values()].filter((item) => item.uid === uid).sort((a, b) => a.generatedAt - b.generatedAt).slice(-limit).map(clone);
  }
  async putLesson(record: LessonRecord, expectedRevision: number | null): Promise<boolean> {
    const k = key(record.uid, record.lessonId); const current = this.lessons.get(k);
    if ((current?.revision ?? null) !== expectedRevision) return false;
    if (!current) {
      const count = [...this.lessons.values()].filter((item) => item.uid === record.uid).length;
      if (count >= LEARNING_LIMITS.maxLessonsPerUser) return false;
    }
    this.lessons.set(k, clone(record)); return true;
  }
  async getLesson(uid: string, lessonId: string): Promise<LessonRecord | null> {
    const value = this.lessons.get(key(uid, lessonId)); return value?.uid === uid ? clone(value) : null;
  }
  async listLessons(uid: string, limit = LEARNING_LIMITS.maxLessonsPerUser): Promise<LessonRecord[]> {
    return [...this.lessons.values()].filter((item) => item.uid === uid).sort((a, b) => a.updatedAt - b.updatedAt).slice(-limit).map(clone);
  }
  async addDecisionObservation(record: DecisionObservation): Promise<boolean> {
    const k = key(record.uid, record.observationId); if (this.decisions.has(k)) return false;
    this.decisions.set(k, clone(record)); return true;
  }
  async listDecisionObservations(uid: string, limit = 1000): Promise<DecisionObservation[]> {
    return [...this.decisions.values()].filter((item) => item.uid === uid).sort((a, b) => a.createdAt - b.createdAt).slice(-Math.max(1, Math.min(1000, limit))).map(clone);
  }
  async putAdaptationVersion(record: AdaptationVersion, expectedLatestVersion: number | null): Promise<boolean> {
    const versions = [...this.adaptations.values()].filter((item) => item.uid === record.uid && item.adaptationId === record.adaptationId);
    const latest = versions.length ? Math.max(...versions.map((item) => item.version)) : null;
    if (latest !== expectedLatestVersion || this.adaptations.has(key(record.uid, record.adaptationId, record.version))) return false;
    this.adaptations.set(key(record.uid, record.adaptationId, record.version), clone(record)); return true;
  }
  async getAdaptationVersion(uid: string, adaptationId: string, version: number): Promise<AdaptationVersion | null> {
    const value = this.adaptations.get(key(uid, adaptationId, version)); return value?.uid === uid ? clone(value) : null;
  }
  async listAdaptationVersions(uid: string, adaptationId?: string): Promise<AdaptationVersion[]> {
    return [...this.adaptations.values()].filter((item) => item.uid === uid && (!adaptationId || item.adaptationId === adaptationId)).sort((a, b) => a.version - b.version).map(clone);
  }
  async transitionAdaptationStatus(uid: string, adaptationId: string, version: number, from: AdaptationVersion["status"], to: AdaptationVersion["status"], patch: Partial<AdaptationVersion> = {}): Promise<boolean> {
    const k = key(uid, adaptationId, version); const current = this.adaptations.get(k);
    if (!current || current.uid !== uid || current.status !== from) return false;
    this.adaptations.set(k, clone({ ...current, ...patch, uid, adaptationId, version, status: to })); return true;
  }
  async putSkillVersion(record: SkillVersion, expectedLatestVersion: number | null): Promise<boolean> {
    const versions = [...this.skills.values()].filter((item) => item.uid === record.uid && item.skillId === record.skillId);
    const latest = versions.length ? Math.max(...versions.map((item) => item.version)) : null;
    if (latest !== expectedLatestVersion || this.skills.has(key(record.uid, record.skillId, record.version))) return false;
    if (versions.length >= LEARNING_LIMITS.maxVersionsPerSkill) return false;
    this.skills.set(key(record.uid, record.skillId, record.version), clone(record)); return true;
  }
  async getSkillVersion(uid: string, skillId: string, version: number): Promise<SkillVersion | null> {
    const value = this.skills.get(key(uid, skillId, version)); return value?.uid === uid ? clone(value) : null;
  }
  async listSkillVersions(uid: string, skillId?: string): Promise<SkillVersion[]> {
    return [...this.skills.values()].filter((item) => item.uid === uid && (!skillId || item.skillId === skillId)).sort((a, b) => a.version - b.version).map(clone);
  }
  async transitionSkillStatus(uid: string, skillId: string, version: number, from: SkillVersion["status"], to: SkillVersion["status"], patch: Partial<SkillVersion> = {}): Promise<boolean> {
    const k = key(uid, skillId, version); const current = this.skills.get(k);
    if (!current || current.uid !== uid || current.status !== from) return false;
    this.skills.set(k, clone({
      ...current, uid, skillId, version, status: to,
      ...(patch.validation ? { validation: patch.validation } : {}),
      ...(patch.replay ? { replay: patch.replay } : {}),
      ...(patch.approval ? { approval: patch.approval } : {}),
      ...(patch.lastVerifiedAt !== undefined ? { lastVerifiedAt: patch.lastVerifiedAt } : {}),
      ...(patch.updatedAt !== undefined ? { updatedAt: patch.updatedAt } : {}),
      ...(patch.degradation !== undefined ? { degradation: patch.degradation } : {}),
    })); return true;
  }
  async getSkillReliability(uid: string, skillId: string, version: number, environment: string): Promise<SkillReliabilityRecord | null> {
    const value = this.skillReliability.get(key(uid, skillId, version, environment)); return value?.uid === uid ? clone(value) : null;
  }
  async putSkillReliability(record: SkillReliabilityRecord): Promise<boolean> {
    this.skillReliability.set(key(record.uid, record.skillId, record.version, record.environment), clone(record)); return true;
  }
  async getToolReliability(uid: string, toolName: string, environment: string, contextSignature: string): Promise<ToolReliabilityRecord | null> {
    const value = this.toolReliability.get(key(uid, toolName, environment, contextSignature)); return value?.uid === uid ? clone(value) : null;
  }
  async putToolReliability(record: ToolReliabilityRecord): Promise<boolean> {
    this.toolReliability.set(key(record.uid, record.toolName, record.environment, record.contextSignature), clone(record)); return true;
  }
}
