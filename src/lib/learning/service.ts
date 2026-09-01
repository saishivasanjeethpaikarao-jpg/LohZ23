import type { RiskLevel } from "../planner/types";
import { objectiveTokens } from "./experienceBuilder";
import { validateSkillCandidate, validateStepGraph } from "./policy";
import type { LearningStore } from "./store";
import type {
  ExperienceRecord, SkillMetrics, SkillReliabilityRecord, SkillSelection,
  SkillStep, SkillVersion, ToolReliabilityRecord, UserCorrectionEvidence,
} from "./types";
import { LEARNING_LIMITS } from "./types";

const RISK_ORDER: Record<RiskLevel, number> = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };

function safeId(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) hash = Math.imul(hash ^ input.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

function rates(successes: number, failures: number, inconclusive = 0): Pick<SkillMetrics, "successRate" | "failureRate"> {
  const samples = successes + failures + inconclusive;
  if (samples < LEARNING_LIMITS.minimumRateSamples) return { successRate: null, failureRate: null };
  return { successRate: successes / samples, failureRate: failures / samples };
}

function maxRisk(steps: SkillStep[]): RiskLevel {
  return steps.reduce<RiskLevel>((max, step) => RISK_ORDER[step.riskLevel] > RISK_ORDER[max] ? step.riskLevel : max, "safe");
}

function stepsFromExperience(experience: ExperienceRecord): SkillStep[] {
  return experience.steps.slice(0, LEARNING_LIMITS.maxSteps).map((step) => ({
    id: step.stepId, index: step.index, title: step.title,
    description: `Verified step for: ${step.expectedOutcome}`.slice(0, 300),
    toolName: step.toolName, arguments: JSON.parse(JSON.stringify(step.arguments)),
    dependencies: [...step.dependencies], expectedOutcome: step.expectedOutcome,
    riskLevel: step.riskLevel, timeoutMs: 30_000, maxRetries: Math.min(2, Math.max(0, step.attempts - 1)),
  }));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function graphFingerprint(steps: Array<{ toolName: string | null; arguments: Record<string, unknown>; dependencies: string[]; riskLevel: RiskLevel }>): string {
  return steps.map((step) => `${step.toolName ?? "manual"}|${stable(step.arguments)}|${step.dependencies.length}|${step.riskLevel}`).join(">");
}

export class SkillLearningService {
  private now: () => number;
  private queues = new Map<string, Promise<void>>();
  constructor(
    private store: LearningStore,
    private toolCatalog: () => string[],
    now: () => number = Date.now,
    /** Phase 38 — single-tool fingerprint oracle (returns null when unknown). */
    private toolFingerprint: (tool: string) => string | null = () => null,
  ) { this.now = now; }

  private captureToolFingerprints(steps: SkillStep[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const step of steps) {
      if (!step.toolName) continue;
      if (Object.prototype.hasOwnProperty.call(out, step.toolName)) continue;
      const fp = this.toolFingerprint(step.toolName);
      if (fp) out[step.toolName] = fp;
    }
    return out;
  }

  async ingestExperience(experience: ExperienceRecord): Promise<boolean> {
    return this.serialized(experience.uid, () => this.ingestExperienceSerial(experience));
  }

  private async ingestExperienceSerial(experience: ExperienceRecord): Promise<boolean> {
    if (!experience.uid || experience.steps.length > LEARNING_LIMITS.maxSteps) return false;
    const added = await this.store.addExperience(experience);
    if (!added) return false;
    for (const step of experience.steps.filter((item) => item.toolName)) {
      await this.updateToolReliability(experience.uid, step.toolName!, experience.context.environment, experience.context.signature, step.verification, step.failureCode);
    }
    return true;
  }

  async recordCorrection(uid: string, experienceId: string, correction: UserCorrectionEvidence): Promise<boolean> {
    return Boolean(await this.recordCorrectionRecord(uid, experienceId, correction));
  }

  /** Phase 39: returns the immutable correction experience so it can be reflected exactly once. */
  async recordCorrectionRecord(uid: string, experienceId: string, correction: UserCorrectionEvidence): Promise<ExperienceRecord | null> {
    const source = await this.store.getExperience(uid, experienceId);
    if (!source || correction.explicit !== true) return null;
    const now = this.now();
    const correctionRecord: ExperienceRecord = {
      ...source,
      id: `${source.id}:correction:${now}`,
      outcome: "failure",
      success: false,
      verification: "FAILED",
      userCorrections: [...source.userCorrections, { ...correction, text: correction.text.slice(0, LEARNING_LIMITS.maxTextChars) }].slice(-10),
      failures: [...source.failures, { stepId: null, code: "user_correction", kind: "user_correction", retryable: false }],
      createdAt: now,
    };
    // A correction is learning evidence about intent/outcome, not evidence that
    // the underlying tool itself failed. Store it without distorting tool
    // reliability statistics.
    const added = await this.serialized(uid, () => this.store.addExperience(correctionRecord));
    return added ? correctionRecord : null;
  }

  async detectCandidates(uid: string): Promise<SkillVersion[]> {
    const experiences = await this.store.listExperiences(uid);
    const groups = new Map<string, ExperienceRecord[]>();
    for (const experience of experiences) {
      if (!experience.success || !["VERIFIED", "NOT_APPLICABLE"].includes(experience.verification) || experience.userCorrections.length) continue;
      const list = groups.get(experience.context.signature) ?? [];
      list.push(experience); groups.set(experience.context.signature, list);
    }
    const created: SkillVersion[] = [];
    for (const [signature, sources] of groups) {
      if (sources.length < LEARNING_LIMITS.minimumPatternSamples) continue;
      const skillId = `skill_${safeId(signature)}`;
      const existing = await this.store.listSkillVersions(uid, skillId);
      if (existing.length > 0) continue; // revisions are always explicit
      const representative = sources.at(-1)!;
      const steps = stepsFromExperience(representative);
      const successes = sources.filter((item) => item.success).length;
      const failures = sources.length - successes;
      const rate = rates(successes, failures);
      const risk = maxRisk(steps);
      const now = this.now();
      const skill: SkillVersion = {
        uid, skillId, version: 1,
        name: `Procedure: ${steps.map((step) => step.toolName ?? step.title).join(" -> ")}`.slice(0, 160),
        description: `Candidate reusable procedure for ${representative.objective}`.slice(0, LEARNING_LIMITS.maxTextChars),
        trigger: { signature, objectiveTokens: objectiveTokens(representative.objective) },
        requiredContext: { environment: representative.context.environment, tags: [...representative.context.tags] },
        stepGraph: steps,
        riskProfile: {
          maximumRisk: risk,
          tools: [...new Set(steps.flatMap((step) => step.toolName ? [step.toolName] : []))],
          requiresConfirmation: RISK_ORDER[risk] >= RISK_ORDER.medium,
          policyMutable: false,
        },
        sourceExperienceIds: sources.slice(-LEARNING_LIMITS.maxSourceExperiences).map((item) => item.id),
        metrics: { samples: sources.length, successes, failures, ...rate },
        status: "candidate",
        validation: { validatedAt: null, issues: [] },
        replay: { verifiedAt: null, sourceExperienceIds: [], failures: [] },
        approval: { requestedAt: null, approvedAt: null, approvalRequestId: null },
        createdAt: now, updatedAt: now, lastVerifiedAt: null, replacesVersion: null, schemaVersion: 1,
        inputSchema: null,
        toolFingerprints: this.captureToolFingerprints(steps),
        degradation: null,
      };
      if (await this.store.putSkillVersion(skill, null)) created.push(skill);
    }
    return created;
  }

  async validate(uid: string, skillId: string, version: number): Promise<{ ok: boolean; issues: string[] }> {
    const skill = await this.store.getSkillVersion(uid, skillId, version);
    if (!skill || skill.status !== "candidate") return { ok: false, issues: ["candidate_not_found"] };
    const experiences = (await Promise.all(skill.sourceExperienceIds.map((id) => this.store.getExperience(uid, id)))).filter(Boolean) as ExperienceRecord[];
    const result = validateSkillCandidate(skill, experiences, this.toolCatalog());
    const now = this.now();
    await this.store.transitionSkillStatus(uid, skillId, version, "candidate", result.ok ? "validated" : "rejected", {
      validation: { validatedAt: now, issues: result.issues }, updatedAt: now,
    });
    return result;
  }

  async replay(uid: string, skillId: string, version: number): Promise<{ ok: boolean; failures: string[] }> {
    const skill = await this.store.getSkillVersion(uid, skillId, version);
    if (!skill || skill.status !== "validated") return { ok: false, failures: ["validated_skill_not_found"] };
    const failures = validateStepGraph(skill.stepGraph);
    const sources = (await Promise.all(skill.sourceExperienceIds.map((id) => this.store.getExperience(uid, id)))).filter(Boolean) as ExperienceRecord[];
    const candidateFingerprint = graphFingerprint(skill.stepGraph);
    for (const source of sources) {
      if (!source.success || graphFingerprint(source.steps) !== candidateFingerprint) failures.push(`source_replay_mismatch:${source.id}`);
      if (source.steps.some((step) => step.outcome !== "completed" || !["VERIFIED", "NOT_APPLICABLE"].includes(step.verification))) failures.push(`source_not_verified:${source.id}`);
    }
    const unique = [...new Set(failures)]; const ok = unique.length === 0;
    const now = this.now();
    await this.store.transitionSkillStatus(uid, skillId, version, "validated", ok ? "replay_verified" : "rejected", {
      replay: { verifiedAt: now, sourceExperienceIds: sources.map((item) => item.id), failures: unique },
      ...(ok ? { lastVerifiedAt: now } : {}),
      updatedAt: now,
    });
    return { ok, failures: unique };
  }

  async requestApproval(uid: string, skillId: string, version: number, approvalRequestId: string): Promise<boolean> {
    if (!approvalRequestId) return false;
    const now = this.now();
    return this.store.transitionSkillStatus(uid, skillId, version, "replay_verified", "pending_approval", {
      approval: { requestedAt: now, approvedAt: null, approvalRequestId }, updatedAt: now,
    });
  }

  async reject(uid: string, skillId: string, version: number): Promise<boolean> {
    const skill = await this.store.getSkillVersion(uid, skillId, version);
    if (!skill || !["candidate", "validated", "replay_verified", "pending_approval"].includes(skill.status)) return false;
    return this.store.transitionSkillStatus(uid, skillId, version, skill.status, "rejected", { updatedAt: this.now() });
  }

  async approveAndPromote(uid: string, skillId: string, version: number, input: { authenticatedUserId: string; approvalRequestId: string; approved: true }): Promise<boolean> {
    if (input.authenticatedUserId !== uid || input.approved !== true) return false;
    const skill = await this.store.getSkillVersion(uid, skillId, version);
    if (!skill || skill.status !== "pending_approval" || skill.approval.approvalRequestId !== input.approvalRequestId) return false;
    const now = this.now();
    return this.store.transitionSkillStatus(uid, skillId, version, "pending_approval", "promoted", {
      approval: { ...skill.approval, approvedAt: now }, lastVerifiedAt: skill.lastVerifiedAt, updatedAt: now,
    });
  }

  async revise(uid: string, skillId: string, baseVersion: number, stepGraph: SkillStep[], options?: { inputSchema?: SkillVersion["inputSchema"] | null }): Promise<SkillVersion | null> {
    const base = await this.store.getSkillVersion(uid, skillId, baseVersion);
    if (!base || validateStepGraph(stepGraph).length) return null;
    const versions = await this.store.listSkillVersions(uid, skillId); const latest = versions.at(-1)?.version ?? null;
    if (latest === null) return null;
    const now = this.now();
    const resolvedInputSchema = options && "inputSchema" in options ? options.inputSchema ?? null : base.inputSchema ?? null;
    const next: SkillVersion = {
      ...base, version: latest + 1, stepGraph: JSON.parse(JSON.stringify(stepGraph)),
      riskProfile: { ...base.riskProfile, maximumRisk: maxRisk(stepGraph), tools: [...new Set(stepGraph.flatMap((step) => step.toolName ? [step.toolName] : []))], requiresConfirmation: stepGraph.some((step) => RISK_ORDER[step.riskLevel] >= RISK_ORDER.medium), policyMutable: false },
      status: "candidate", validation: { validatedAt: null, issues: [] },
      replay: { verifiedAt: null, sourceExperienceIds: [], failures: [] },
      approval: { requestedAt: null, approvedAt: null, approvalRequestId: null },
      createdAt: now, updatedAt: now, lastVerifiedAt: null, replacesVersion: baseVersion,
      inputSchema: resolvedInputSchema,
      toolFingerprints: this.captureToolFingerprints(stepGraph),
      degradation: null,
    };
    return await this.store.putSkillVersion(next, latest) ? next : null;
  }

  async rollback(uid: string, skillId: string, targetVersion: number, input: { authenticatedUserId: string; approvalRequestId: string; approved: true }): Promise<SkillVersion | null> {
    if (input.authenticatedUserId !== uid || input.approved !== true || !input.approvalRequestId) return null;
    const target = await this.store.getSkillVersion(uid, skillId, targetVersion);
    const versions = await this.store.listSkillVersions(uid, skillId); const latest = versions.at(-1);
    if (!target || !latest || !["promoted", "retired", "unreliable", "degraded"].includes(target.status)) return null;
    const now = this.now();
    const rollback: SkillVersion = {
      ...target, version: latest.version + 1, status: "promoted", createdAt: now, updatedAt: now,
      approval: { requestedAt: now, approvedAt: now, approvalRequestId: input.approvalRequestId },
      replacesVersion: latest.version,
      degradation: null,
      toolFingerprints: this.captureToolFingerprints(target.stepGraph),
    };
    if (!(await this.store.putSkillVersion(rollback, latest.version))) return null;
    for (const active of versions.filter((item) => ["promoted", "unreliable", "degraded"].includes(item.status))) {
      await this.store.transitionSkillStatus(uid, skillId, active.version, active.status, "retired", { updatedAt: now });
    }
    return rollback;
  }

  /**
   * Phase 38 — explicit deprecation. Transitions any non-terminal status
   * to "retired" (the library maps retired -> "deprecated"). The skill
   * record itself is preserved; selection and execution both refuse it.
   */
  async deprecate(uid: string, skillId: string, version: number): Promise<boolean> {
    const skill = await this.store.getSkillVersion(uid, skillId, version);
    if (!skill) return false;
    const from = skill.status;
    if (!["promoted", "unreliable", "degraded"].includes(from)) return false;
    return this.store.transitionSkillStatus(uid, skillId, version, from, "retired", { updatedAt: this.now() });
  }

  /**
   * Phase 38 — registry-drift marker. Transitions promoted -> "degraded"
   * while preserving the original stepGraph intact (never silently
   * mutated). The companion caller is responsible for creating the
   * candidate v2; the service does NOT auto-revise to avoid creating
   * unlimited candidates when the registry is volatile.
   */
  async markDegraded(uid: string, skillId: string, version: number, reason: string, catalogFingerprint: string | null): Promise<boolean> {
    const skill = await this.store.getSkillVersion(uid, skillId, version);
    if (!skill || skill.status !== "promoted") return false;
    const boundedReason = String(reason ?? "").slice(0, 200);
    const now = this.now();
    return this.store.transitionSkillStatus(uid, skillId, version, "promoted", "degraded", {
      degradation: { at: now, reason: boundedReason, catalogFingerprint },
      updatedAt: now,
    });
  }

  async select(uid: string, signature: string, environment: string): Promise<SkillSelection | null> {
    const skills = (await this.store.listSkillVersions(uid)).filter((skill) => skill.status === "promoted" && skill.trigger.signature === signature && skill.requiredContext.environment === environment);
    const selections: SkillSelection[] = [];
    for (const skill of skills) {
      const reliability = await this.store.getSkillReliability(uid, skill.skillId, skill.version, environment);
      if (reliability?.unreliable) continue;
      const evidenceScore = Math.min(1, skill.metrics.samples / 10);
      const rateScore = reliability?.successRate ?? skill.metrics.successRate ?? 0.5;
      selections.push({ skill, score: 0.4 * evidenceScore + 0.6 * rateScore, reason: reliability ? "verified_runtime_reliability" : "verified_source_experience" });
    }
    return selections.sort((a, b) => b.score - a.score || b.skill.version - a.skill.version)[0] ?? null;
  }

  async recordSkillOutcome(uid: string, skillId: string, version: number, environment: string, verdict: "VERIFIED" | "FAILED" | "INCONCLUSIVE", failureKind = "unknown"): Promise<SkillReliabilityRecord | null> {
    return this.serialized(uid, () => this.recordSkillOutcomeSerial(uid, skillId, version, environment, verdict, failureKind));
  }

  private async recordSkillOutcomeSerial(uid: string, skillId: string, version: number, environment: string, verdict: "VERIFIED" | "FAILED" | "INCONCLUSIVE", failureKind: string): Promise<SkillReliabilityRecord | null> {
    const skill = await this.store.getSkillVersion(uid, skillId, version);
    if (!skill || !["promoted", "unreliable"].includes(skill.status)) return null;
    const existing = await this.store.getSkillReliability(uid, skillId, version, environment);
    const next: SkillReliabilityRecord = existing ?? {
      uid, skillId, version, environment, attempts: 0, verifiedSuccesses: 0, failures: 0, inconclusive: 0,
      consecutiveFailures: 0, successRate: null, failureRate: null, unreliable: false, failureKinds: {}, updatedAt: this.now(),
    };
    next.attempts += 1;
    if (verdict === "VERIFIED") { next.verifiedSuccesses += 1; next.consecutiveFailures = 0; }
    else if (verdict === "FAILED") { next.failures += 1; next.consecutiveFailures += 1; next.failureKinds[failureKind] = (next.failureKinds[failureKind] ?? 0) + 1; }
    else { next.inconclusive += 1; next.consecutiveFailures = 0; }
    Object.assign(next, rates(next.verifiedSuccesses, next.failures, next.inconclusive));
    next.unreliable = next.consecutiveFailures >= LEARNING_LIMITS.unreliableConsecutiveFailures;
    next.updatedAt = this.now();
    await this.store.putSkillReliability(next);
    if (next.unreliable && skill.status === "promoted") await this.store.transitionSkillStatus(uid, skillId, version, "promoted", "unreliable", { updatedAt: next.updatedAt });
    return next;
  }

  private async updateToolReliability(uid: string, toolName: string, environment: string, contextSignature: string, verdict: "VERIFIED" | "FAILED" | "INCONCLUSIVE" | "NOT_APPLICABLE", failureKind: string | null): Promise<void> {
    if (verdict === "NOT_APPLICABLE") return;
    const existing = await this.store.getToolReliability(uid, toolName, environment, contextSignature);
    const next: ToolReliabilityRecord = existing ?? { uid, toolName, environment, contextSignature, samples: 0, verifiedSuccesses: 0, failures: 0, inconclusive: 0, successRate: null, failureRate: null, failureKinds: {}, updatedAt: this.now() };
    next.samples += 1;
    if (verdict === "VERIFIED") next.verifiedSuccesses += 1;
    else if (verdict === "FAILED") { next.failures += 1; const kind = failureKind ?? "unknown"; next.failureKinds[kind] = (next.failureKinds[kind] ?? 0) + 1; }
    else next.inconclusive += 1;
    Object.assign(next, rates(next.verifiedSuccesses, next.failures, next.inconclusive)); next.updatedAt = this.now();
    await this.store.putToolReliability(next);
  }

  private async serialized<T>(uid: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(uid) ?? Promise.resolve(); let result!: T;
    const run = previous.catch(() => undefined).then(async () => { result = await work(); });
    const marker = run.then(() => undefined, () => undefined); this.queues.set(uid, marker); await run;
    if (this.queues.get(uid) === marker) this.queues.delete(uid); return result;
  }
}
