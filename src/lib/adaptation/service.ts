import type { LearningStore } from "../learning/store";
import type { ExperienceRecord, LessonRecord } from "../learning/types";
import { adaptiveTaskType, safeAdaptiveTaskType } from "./signature";
import type {
  AdaptationVersion, AdaptiveRecommendation, CalibrationMetrics, ConfidenceKind, DecisionActualOutcome,
  DecisionObservation, PersonalizationEvidenceItem, PersonalizationSnapshot, RoutingApproach,
} from "./types";

const APPROACHES = new Set<RoutingApproach>(["deterministic", "clarification", "model_reasoning", "planner", "known_skill", "recovery_strategy"]);
const MIN_CALIBRATION_SAMPLES = 5;
const MIN_APPROACH_SAMPLES = 3;
const MIN_IMPROVEMENT = 0.15;

function stableId(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

function safeToken(value: unknown, max = 240): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function actualFromExperience(experience: ExperienceRecord): DecisionActualOutcome {
  if (experience.success && ["VERIFIED", "NOT_APPLICABLE"].includes(experience.verification)) return "VERIFIED_SUCCESS";
  if (experience.outcome === "failure" && experience.verification === "FAILED") return "VERIFIED_FAILURE";
  return experience.verification === "NOT_APPLICABLE" ? "NOT_APPLICABLE" : "INCONCLUSIVE";
}

function rate(records: DecisionObservation[]): number {
  if (!records.length) return 0;
  return records.filter((item) => item.actualOutcome === "VERIFIED_SUCCESS").length / records.length;
}

function preferenceValue(lesson: LessonRecord): string {
  return lesson.topicKey.replace(/^preference:/, "").replace(/-/g, " ").slice(0, 120);
}

export interface AdaptiveDecisionServiceDeps {
  store: LearningStore;
  now?: () => number;
  loadProjects?: (uid: string) => Promise<Array<{ key: string; displayName: string; confidence: number; stale: boolean }>>;
}

export class AdaptiveDecisionService {
  private readonly now: () => number;
  private queues = new Map<string, Promise<void>>();

  constructor(private readonly deps: AdaptiveDecisionServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async observe(record: DecisionObservation): Promise<boolean> {
    if (!this.validObservation(record)) return false;
    try {
      return await this.deps.store.addDecisionObservation({
        ...record,
        predictedConfidence: Math.max(0, Math.min(1, record.predictedConfidence)),
        environment: safeToken(record.environment, 80),
        schemaVersion: 1,
      });
    } catch {
      return false; // adaptation evidence must never alter execution truth
    }
  }

  async observeExperience(experience: ExperienceRecord): Promise<boolean> {
    if (!experience.decision || !experience.uid || !safeAdaptiveTaskType(experience.decision.taskType)) return false;
    return this.observe({
      observationId: `decision:${stableId(`${experience.uid}|${experience.id}`)}`,
      uid: experience.uid,
      requestId: safeToken(experience.requestId, 160),
      taskType: experience.decision.taskType,
      approach: experience.decision.approach,
      predictedConfidence: experience.decision.predictedConfidence,
      confidenceKind: experience.decision.confidenceKind,
      actualOutcome: actualFromExperience(experience),
      source: experience.userCorrections.length ? "user_correction" : "execution",
      environment: experience.context.environment,
      createdAt: experience.createdAt,
      schemaVersion: 1,
    });
  }

  async calibration(uid: string, taskType?: string, confidenceKind: ConfidenceKind = "heuristic"): Promise<CalibrationMetrics> {
    const now = this.now();
    const records = (await this.deps.store.listDecisionObservations(uid, 1000)).filter((item) =>
      item.uid === uid && item.confidenceKind === confidenceKind && (!taskType || item.taskType === taskType)
      && ["VERIFIED_SUCCESS", "VERIFIED_FAILURE"].includes(item.actualOutcome));
    const interpretation = confidenceKind === "heuristic" ? "heuristic_score_diagnostic" as const : "calibrated_probability_diagnostic" as const;
    if (records.length < MIN_CALIBRATION_SAMPLES) return { uid, taskType: taskType ?? null, confidenceKind, status: "insufficient_evidence", sampleSize: records.length, meanScore: null, empiricalSuccessRate: null, meanAbsoluteGap: null, diagnosticBrierScore: null, bins: [], generatedAt: now, interpretation };
    const actual = records.map((item) => item.actualOutcome === "VERIFIED_SUCCESS" ? 1 : 0);
    const meanScore = records.reduce((sum, item) => sum + item.predictedConfidence, 0) / records.length;
    const empiricalSuccessRate = actual.reduce((sum, item) => sum + item, 0) / actual.length;
    const meanAbsoluteGap = records.reduce((sum, item, index) => sum + Math.abs(item.predictedConfidence - actual[index]), 0) / records.length;
    const diagnosticBrierScore = records.reduce((sum, item, index) => sum + (item.predictedConfidence - actual[index]) ** 2, 0) / records.length;
    const bins = Array.from({ length: 5 }, (_, index) => {
      const lower = index / 5; const upper = (index + 1) / 5;
      const items = records.filter((item) => item.predictedConfidence >= lower && (index === 4 ? item.predictedConfidence <= upper : item.predictedConfidence < upper));
      return items.length ? { lower, upper, samples: items.length, meanScore: items.reduce((sum, item) => sum + item.predictedConfidence, 0) / items.length, empiricalSuccessRate: rate(items) } : null;
    }).filter((item): item is NonNullable<typeof item> => Boolean(item));
    return { uid, taskType: taskType ?? null, confidenceKind, status: "measured", sampleSize: records.length, meanScore, empiricalSuccessRate, meanAbsoluteGap, diagnosticBrierScore, bins, generatedAt: now, interpretation };
  }

  async propose(uid: string, taskType: string, baselineApproach: RoutingApproach): Promise<AdaptationVersion | null> {
    if (!uid || !safeAdaptiveTaskType(taskType) || !APPROACHES.has(baselineApproach)) return null;
    return this.serialized(uid, async () => {
      const verified = (await this.deps.store.listDecisionObservations(uid, 1000)).filter((item) => item.taskType === taskType && ["VERIFIED_SUCCESS", "VERIFIED_FAILURE"].includes(item.actualOutcome));
      const grouped = new Map<RoutingApproach, DecisionObservation[]>();
      for (const item of verified) grouped.set(item.approach, [...(grouped.get(item.approach) ?? []), item]);
      const baseline = grouped.get(baselineApproach) ?? [];
      const eligible = [...grouped.entries()].filter(([, items]) => items.length >= MIN_APPROACH_SAMPLES);
      if (baseline.length < MIN_APPROACH_SAMPLES || eligible.length < 2) return null;
      const ranked = eligible.map(([approach, items]) => ({ approach, items, successRate: rate(items) })).sort((a, b) => b.successRate - a.successRate || b.items.length - a.items.length);
      const best = ranked[0]; const baselineSuccessRate = rate(baseline);
      if (!best || best.approach === baselineApproach || best.successRate - baselineSuccessRate < MIN_IMPROVEMENT) return null;
      const adaptationId = `adapt_${stableId(`${uid}|${taskType}`)}`;
      const versions = await this.deps.store.listAdaptationVersions(uid, adaptationId); const latest = versions.at(-1)?.version ?? null;
      const now = this.now();
      const record: AdaptationVersion = {
        uid, adaptationId, version: (latest ?? 0) + 1, taskType, recommendedApproach: best.approach, baselineApproach,
        evidenceObservationIds: [...new Set([...baseline, ...best.items].map((item) => item.observationId))].slice(-50),
        evaluation: { samples: baseline.length + best.items.length, recommendedSuccessRate: best.successRate, baselineSuccessRate, improvement: best.successRate - baselineSuccessRate, evaluatedAt: null, issues: [] },
        status: "candidate", approval: { requestedAt: null, approvedAt: null, approvalRequestId: null }, createdAt: now, updatedAt: now, replacesVersion: latest,
        safety: { policyMutable: false, authorizationEffect: "none", riskReductionAllowed: false, toolArgumentsMutable: false }, schemaVersion: 1,
      };
      return await this.deps.store.putAdaptationVersion(record, latest) ? record : null;
    });
  }

  async evaluate(uid: string, adaptationId: string, version: number): Promise<{ ok: boolean; issues: string[] }> {
    const record = await this.deps.store.getAdaptationVersion(uid, adaptationId, version);
    if (!record || record.status !== "candidate") return { ok: false, issues: ["candidate_not_found"] };
    const observations = await Promise.all(record.evidenceObservationIds.map(async (id) => (await this.deps.store.listDecisionObservations(uid, 1000)).find((item) => item.observationId === id) ?? null));
    const issues: string[] = [];
    if (!safeAdaptiveTaskType(record.taskType)) issues.push("unsafe_task_type");
    if (!APPROACHES.has(record.recommendedApproach) || !APPROACHES.has(record.baselineApproach)) issues.push("unsupported_approach");
    if (observations.filter(Boolean).length !== record.evidenceObservationIds.length) issues.push("missing_evidence");
    if (record.evaluation.samples < MIN_APPROACH_SAMPLES * 2 || record.evaluation.improvement < MIN_IMPROVEMENT) issues.push("insufficient_comparative_evidence");
    const now = this.now(); const ok = issues.length === 0;
    await this.deps.store.transitionAdaptationStatus(uid, adaptationId, version, "candidate", ok ? "evaluated" : "rejected", { evaluation: { ...record.evaluation, evaluatedAt: now, issues }, updatedAt: now });
    return { ok, issues };
  }

  async requestApproval(uid: string, adaptationId: string, version: number, approvalRequestId: string): Promise<boolean> {
    if (!approvalRequestId) return false; const now = this.now();
    return this.deps.store.transitionAdaptationStatus(uid, adaptationId, version, "evaluated", "pending_approval", { approval: { requestedAt: now, approvedAt: null, approvalRequestId }, updatedAt: now });
  }

  async approveAndDeploy(uid: string, adaptationId: string, version: number, input: { authenticatedUserId: string; approvalRequestId: string; approved: true }): Promise<boolean> {
    if (input.authenticatedUserId !== uid || input.approved !== true) return false;
    return this.serialized(uid, async () => {
      const record = await this.deps.store.getAdaptationVersion(uid, adaptationId, version);
      if (!record || record.status !== "pending_approval" || record.approval.approvalRequestId !== input.approvalRequestId) return false;
      const now = this.now();
      const deployed = await this.deps.store.transitionAdaptationStatus(uid, adaptationId, version, "pending_approval", "deployed", { approval: { ...record.approval, approvedAt: now }, updatedAt: now });
      if (!deployed) return false;
      for (const old of (await this.deps.store.listAdaptationVersions(uid, adaptationId)).filter((item) => item.version !== version && item.status === "deployed")) {
        await this.deps.store.transitionAdaptationStatus(uid, adaptationId, old.version, "deployed", "retired", { updatedAt: now });
      }
      return true;
    });
  }

  async recommend(uid: string, taskType: string): Promise<AdaptiveRecommendation | null> {
    if (!uid || !safeAdaptiveTaskType(taskType)) return null;
    const deployed = (await this.deps.store.listAdaptationVersions(uid)).filter((item) => item.taskType === taskType && item.status === "deployed").sort((a, b) => b.version - a.version)[0];
    return deployed ? { taskType, approach: deployed.recommendedApproach, adaptationId: deployed.adaptationId, version: deployed.version, evidenceSamples: deployed.evaluation.samples, advisoryOnly: true } : null;
  }

  async recommendForInput(uid: string, intent: string, input: string): Promise<AdaptiveRecommendation | null> {
    return this.recommend(uid, adaptiveTaskType(intent, input));
  }

  async personalization(uid: string): Promise<PersonalizationSnapshot> {
    const experiences = await this.deps.store.listExperiences(uid, 500); const lessons = await this.deps.store.listLessons(uid, 300);
    const explicit = lessons.filter((item) => item.uid === uid && item.type === "user_preference" && item.status !== "stale" && item.status !== "contradicted" && item.polarity === "positive");
    const preferenceItems = (matcher: RegExp): PersonalizationEvidenceItem[] => explicit.filter((item) => matcher.test(preferenceValue(item))).map((item) => ({ value: preferenceValue(item), evidenceCount: item.evidenceCount, source: "explicit_preference_lesson" as const })).slice(0, 8);
    const count = (values: string[], minimum: number, source: PersonalizationEvidenceItem["source"]): PersonalizationEvidenceItem[] => [...new Map(values.map((value) => [value, values.filter((item) => item === value).length])).entries()].filter(([, n]) => n >= minimum).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([value, evidenceCount]) => ({ value, evidenceCount, source }));
    const verified = experiences.filter((item) => item.uid === uid && item.success && ["VERIFIED", "NOT_APPLICABLE"].includes(item.verification));
    const apps = verified.flatMap((item) => item.steps.filter((step) => ["openApp", "focusApp"].includes(step.toolName ?? "")).map((step) => safeToken(step.arguments.name, 80)).filter(Boolean));
    const workflows = verified.map((item) => safeToken(item.context.signature, 200));
    const projects = await this.deps.loadProjects?.(uid) ?? [];
    const approaches = (await this.deps.store.listDecisionObservations(uid, 1000)).map((item) => item.approach);
    return {
      uid,
      communicationStyles: preferenceItems(/concise|detailed|formal|casual|friendly|technical|simple/),
      preferredApplications: count(apps, 2, "verified_experience"),
      preferredOutputFormats: preferenceItems(/markdown|json|table|bullet|list|code|summary|format/),
      recurringWorkflows: count(workflows, 3, "verified_experience"),
      recurringProjects: projects.filter((item) => !item.stale && item.confidence >= 0.6).slice(0, 8).map((item) => ({ value: item.displayName || item.key, evidenceCount: 1, source: "user_model" })),
      interactionPatterns: count(approaches, 3, "verified_experience"),
      generatedAt: this.now(), sensitiveInferencePerformed: false,
    };
  }

  private validObservation(record: DecisionObservation): boolean {
    return Boolean(record.uid && /^[A-Za-z0-9_-]{1,128}$/.test(record.uid) && /^[A-Za-z0-9:_-]{1,220}$/.test(record.observationId)
      && safeAdaptiveTaskType(record.taskType) && APPROACHES.has(record.approach) && Number.isFinite(record.predictedConfidence)
      && record.predictedConfidence >= 0 && record.predictedConfidence <= 1 && ["heuristic", "provider_calibrated"].includes(record.confidenceKind)
      && ["VERIFIED_SUCCESS", "VERIFIED_FAILURE", "INCONCLUSIVE", "NOT_APPLICABLE"].includes(record.actualOutcome));
  }

  private async serialized<T>(uid: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(uid) ?? Promise.resolve(); let result!: T;
    const run = previous.catch(() => undefined).then(async () => { result = await work(); }); const marker = run.then(() => undefined, () => undefined);
    this.queues.set(uid, marker); await run; if (this.queues.get(uid) === marker) this.queues.delete(uid); return result;
  }
}
