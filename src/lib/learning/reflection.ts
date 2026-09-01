import type { LearningStore } from "./store";
import type {
  ExperienceRecord, ExperienceReflection, LessonPolarity, LessonRecord, LessonStatus, LessonType,
} from "./types";
import { LEARNING_LIMITS } from "./types";

const DAY = 86_400_000;
const TTL_DAYS: Record<LessonType, number> = {
  procedural: 180,
  tool_reliability: 30,
  user_preference: 365,
  planning: 90,
  recovery: 90,
  contextual: 60,
};

interface LessonCandidate {
  type: LessonType;
  topicKey: string;
  statement: string;
  polarity: LessonPolarity;
}

export interface ReflectionRunResult {
  reflection: ExperienceReflection;
  lessons: LessonRecord[];
}

function stableId(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) hash = Math.imul(hash ^ input.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

function bounded(value: unknown, max = 240): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function keyPart(value: unknown): string {
  return bounded(value, 160).toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
}

const UNSAFE_LESSON_CONTENT = [
  /ignore\s+(?:all\s+)?(?:previous|system|developer)\s+instructions?/i,
  /system\s+prompt|developer\s+message/i,
  /auth(?:entication|orization)|security\s+policy|safety\s+policy|system\s+permissions?/i,
  /credentials?|api[_ -]?keys?|access[_ -]?tokens?|passwords?/i,
  /execute\s+(?:this\s+)?code|run\s+(?:this\s+)?command|powershell|cmd\.exe|<script|javascript:/i,
  /rm\s+-rf|delete\s+(?:all|every)/i,
];

function safeLessonText(value: string): boolean {
  return value.length > 0 && value.length <= 500 && !UNSAFE_LESSON_CONTENT.some((pattern) => pattern.test(value));
}

function terminalOutcome(value: ExperienceRecord["outcome"]): value is ExperienceReflection["outcome"] {
  return value === "success" || value === "failure" || value === "partial";
}

function preferenceCandidate(correction: string): LessonCandidate | null {
  const text = bounded(correction, 240);
  if (!safeLessonText(text)) return null;
  const negative = text.match(/^(?:no[, ]+)?i\s+(?:do\s+not|don't|dont)\s+(?:prefer|like|want)\s+(.+?)[.!]?$/i)
    ?? text.match(/^(?:no[, ]+)?i\s+(?:dislike|hate)\s+(.+?)[.!]?$/i);
  const positive = text.match(/^(?:actually[, ]+)?i\s+(?:prefer|like|want)\s+(.+?)[.!]?$/i);
  const match = negative ?? positive;
  if (!match) return null;
  const subject = bounded(match[1], 160);
  if (!subject || !safeLessonText(subject)) return null;
  const polarity: LessonPolarity = negative ? "negative" : "positive";
  return {
    type: "user_preference",
    topicKey: `preference:${keyPart(subject)}`,
    statement: `Explicit user preference evidence: ${polarity === "positive" ? "prefers" : "does not prefer"} ${subject}.`,
    polarity,
  };
}

function buildCandidates(experience: ExperienceRecord): { candidates: LessonCandidate[]; rejected: string[] } {
  const candidates: LessonCandidate[] = [];
  const rejected: string[] = [];
  const environment = keyPart(experience.context.environment) || "unknown";
  const signature = keyPart(experience.context.signature) || stableId(experience.id);
  const safeSteps = experience.steps.filter((step) => !step.toolName || /^[A-Za-z0-9._:-]{1,120}$/.test(step.toolName));
  if (safeSteps.length !== experience.steps.length) rejected.push("unsafe_tool_identifier");

  const toolNames = safeSteps.flatMap((step) => step.toolName ? [step.toolName] : []);
  if (experience.success && ["VERIFIED", "NOT_APPLICABLE"].includes(experience.verification) && safeSteps.length > 1) {
    const sequence = safeSteps.map((step) => step.toolName ?? `manual:${keyPart(step.title)}`).join(" -> ");
    candidates.push({
      type: "procedural", topicKey: `procedure:${signature}`,
      statement: `Verified procedure evidence for task ${signature}: ${bounded(sequence, 280)}.`, polarity: "positive",
    });
  }

  for (const step of safeSteps.filter((item) => item.toolName)) {
    const verdict = step.verification === "VERIFIED" ? "verified" : step.verification === "FAILED" ? "failed" : "inconclusive";
    const polarity: LessonPolarity = verdict === "verified" ? "positive" : verdict === "failed" ? "negative" : "neutral";
    const failure = step.failureCode && /^[A-Za-z0-9._:-]{1,100}$/.test(step.failureCode) ? ` (${step.failureCode})` : "";
    candidates.push({
      type: "tool_reliability", topicKey: `tool:${keyPart(step.toolName)}:${environment}:${signature}`,
      statement: `Tool outcome evidence: ${step.toolName} was ${verdict}${failure} in ${environment}.`, polarity,
    });
  }

  if (experience.outcome !== "success" || experience.replans.count > 0) {
    const code = experience.failures.map((item) => item.code).find((item) => /^[A-Za-z0-9._:-]{1,100}$/.test(item)) ?? "unspecified";
    candidates.push({
      type: "planning", topicKey: `planning:${signature}`,
      statement: `Planning outcome evidence for task ${signature}: ${experience.outcome}; replans=${Math.max(0, experience.replans.count)}; failure=${code}.`,
      polarity: experience.outcome === "failure" ? "negative" : "neutral",
    });
  }

  if (experience.recovery.attempted) {
    candidates.push({
      type: "recovery", topicKey: `recovery:${signature}`,
      statement: `Recovery evidence for task ${signature}: ${experience.recovery.succeeded ? "succeeded" : "did not produce a verified success"}.`,
      polarity: experience.recovery.succeeded ? "positive" : "negative",
    });
  }

  if (toolNames.length > 0) {
    candidates.push({
      type: "contextual", topicKey: `context:${environment}:${signature}`,
      statement: `Context evidence: task ${signature} had outcome ${experience.outcome} in ${environment}.`,
      polarity: experience.outcome === "success" ? "positive" : experience.outcome === "failure" ? "negative" : "neutral",
    });
  }

  for (const correction of experience.userCorrections.filter((item) => item.explicit === true)) {
    const candidate = preferenceCandidate(correction.text);
    if (candidate) candidates.push(candidate); else rejected.push("correction_not_safe_explicit_preference");
  }

  return { candidates, rejected: [...new Set(rejected)] };
}

function lessonId(uid: string, candidate: LessonCandidate, contextSignature: string): string {
  return `lesson_${stableId(`${uid}|${candidate.type}|${candidate.topicKey}|${candidate.polarity}|${contextSignature}`)}`;
}

export class ExperienceReflectionService {
  private readonly now: () => number;
  private queues = new Map<string, Promise<void>>();

  constructor(private readonly store: LearningStore, now: () => number = Date.now) {
    this.now = now;
  }

  async reflect(uid: string, experienceId: string): Promise<ReflectionRunResult | null> {
    if (!uid || !experienceId) return null;
    return this.serialized(uid, async () => {
      const prior = await this.store.getReflection(uid, experienceId);
      if (prior) return { reflection: prior, lessons: await this.lessonsById(uid, prior.lessonIds) };
      const experience = await this.store.getExperience(uid, experienceId);
      if (!experience || experience.uid !== uid) return null;
      const now = this.now();
      if (!terminalOutcome(experience.outcome)) {
        const skipped = this.reflectionRecord(experience, "skipped", [], ["non_terminal_experience"], now);
        const persisted = await this.store.putReflection(skipped);
        const stored = await this.store.getReflection(uid, experienceId);
        return persisted || stored ? { reflection: stored ?? skipped, lessons: [] } : null;
      }

      const generated = buildCandidates(experience);
      const lessons: LessonRecord[] = [];
      for (const candidate of generated.candidates) {
        if (!safeLessonText(candidate.statement) || !candidate.topicKey) {
          generated.rejected.push("unsafe_generated_candidate"); continue;
        }
        const lesson = await this.upsertCandidate(experience, candidate, now);
        if (lesson) lessons.push(lesson);
      }
      await this.linkContradictions(uid, lessons, now);
      const refreshed = await this.lessonsById(uid, lessons.map((item) => item.lessonId));
      const reflection = this.reflectionRecord(experience, "completed", refreshed.map((item) => item.lessonId), generated.rejected, now);
      const persisted = await this.store.putReflection(reflection);
      const stored = await this.store.getReflection(uid, experienceId);
      return persisted || stored ? { reflection: stored ?? reflection, lessons: refreshed } : null;
    }).catch(() => null);
  }

  async listLessons(uid: string, limit: number = LEARNING_LIMITS.maxLessonsPerUser): Promise<LessonRecord[]> {
    await this.refreshStaleness(uid);
    return this.store.listLessons(uid, Math.max(1, Math.min(LEARNING_LIMITS.maxLessonsPerUser, limit)));
  }

  async listReflections(uid: string, limit: number = LEARNING_LIMITS.maxReflectionsPerUser): Promise<ExperienceReflection[]> {
    return this.store.listReflections(uid, Math.max(1, Math.min(LEARNING_LIMITS.maxReflectionsPerUser, limit)));
  }

  private reflectionRecord(experience: ExperienceRecord, status: ExperienceReflection["status"], lessonIds: string[], rejected: string[], now: number): ExperienceReflection {
    return {
      reflectionId: `reflection:${experience.id}`, uid: experience.uid, experienceId: experience.id,
      taskType: bounded(experience.context.signature, 300),
      outcome: terminalOutcome(experience.outcome) ? experience.outcome : "partial",
      status, lessonIds: [...new Set(lessonIds)].slice(0, 50),
      rejectedCandidateCodes: [...new Set(rejected)].slice(0, 20), generatedAt: now,
      deterministic: true, modelCallsUsed: 0, schemaVersion: 1,
    };
  }

  private async upsertCandidate(experience: ExperienceRecord, candidate: LessonCandidate, now: number): Promise<LessonRecord | null> {
    const id = lessonId(experience.uid, candidate, experience.context.signature);
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await this.store.getLesson(experience.uid, id);
      if (current?.sourceExperienceIds.includes(experience.id)) return current;
      if (!current && (await this.store.listLessons(experience.uid, LEARNING_LIMITS.maxLessonsPerUser)).length >= LEARNING_LIMITS.maxLessonsPerUser) return null;
      const sources = [...new Set([...(current?.sourceExperienceIds ?? []), experience.id])].slice(-LEARNING_LIMITS.maxLessonSources);
      const evidenceCount = sources.length;
      const status: LessonStatus = current?.status === "contradicted" ? "contradicted" : evidenceCount >= 2 ? "reinforced" : "candidate";
      const next: LessonRecord = {
        lessonId: id, uid: experience.uid, type: candidate.type, topicKey: candidate.topicKey,
        statement: candidate.statement, polarity: candidate.polarity,
        context: { environment: bounded(experience.context.environment, 80), signature: bounded(experience.context.signature, 300) },
        sourceExperienceIds: sources, evidenceCount,
        confidence: Math.min(0.9, 0.5 + evidenceCount * 0.1), confidenceKind: "heuristic",
        contradictionIds: current?.contradictionIds ?? [], status,
        createdAt: current?.createdAt ?? now, updatedAt: now, lastReinforcedAt: now,
        expiresAt: now + TTL_DAYS[candidate.type] * DAY, revision: (current?.revision ?? 0) + 1,
        safety: { dataOnly: true, executable: false, policyMutable: false, authorizationEffect: "none" },
        schemaVersion: 1,
      };
      if (await this.store.putLesson(next, current?.revision ?? null)) return next;
    }
    return null;
  }

  private async linkContradictions(uid: string, touched: LessonRecord[], now: number): Promise<void> {
    if (!touched.length) return;
    const all = await this.store.listLessons(uid);
    for (const lesson of touched) {
      if (lesson.polarity === "neutral") continue;
      for (const other of all) {
        if (other.lessonId === lesson.lessonId || other.type !== lesson.type || other.topicKey !== lesson.topicKey) continue;
        if (other.context.signature !== lesson.context.signature || other.polarity === "neutral" || other.polarity === lesson.polarity) continue;
        await this.markContradicted(uid, lesson.lessonId, other.lessonId, now);
        await this.markContradicted(uid, other.lessonId, lesson.lessonId, now);
      }
    }
  }

  private async markContradicted(uid: string, lessonIdValue: string, otherId: string, now: number): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await this.store.getLesson(uid, lessonIdValue); if (!current) return;
      if (current.status === "contradicted" && current.contradictionIds.includes(otherId)) return;
      const next: LessonRecord = { ...current, status: "contradicted", contradictionIds: [...new Set([...current.contradictionIds, otherId])].slice(0, 20), updatedAt: now, revision: current.revision + 1 };
      if (await this.store.putLesson(next, current.revision)) return;
    }
  }

  private async refreshStaleness(uid: string): Promise<void> {
    const now = this.now(); const all = await this.store.listLessons(uid);
    for (const lesson of all) {
      if (lesson.status === "stale" || lesson.expiresAt > now) continue;
      const next: LessonRecord = { ...lesson, status: "stale", updatedAt: now, revision: lesson.revision + 1 };
      await this.store.putLesson(next, lesson.revision);
    }
  }

  private async lessonsById(uid: string, ids: string[]): Promise<LessonRecord[]> {
    return (await Promise.all(ids.map((id) => this.store.getLesson(uid, id)))).filter((item): item is LessonRecord => Boolean(item));
  }

  private async serialized<T>(uid: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(uid) ?? Promise.resolve(); let result!: T;
    const run = previous.catch(() => undefined).then(async () => { result = await work(); });
    const marker = run.then(() => undefined, () => undefined); this.queues.set(uid, marker); await run;
    if (this.queues.get(uid) === marker) this.queues.delete(uid); return result;
  }
}

export const __reflectionTest = { buildCandidates, preferenceCandidate, safeLessonText };
