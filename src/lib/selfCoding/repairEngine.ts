import { createHash, randomUUID } from "node:crypto";
import type { HealthEngine } from "../health/engine";
import type { CodeChangeProposalEngine, CreateProposalInput } from "./engine";
import type { ControlledRepository } from "./repository";
import type { RepairSandboxExecutor } from "./sandbox";
import type { SelfCodingStore } from "./store";
import type {
  BugEvidence, BugIncident, BugSignal, RegressionMemory, RepairAttempt,
  ReproductionTarget,
} from "./repairTypes";
import { REPAIR_LIMITS } from "./repairTypes";

const SOURCES = new Set(["runtime_error", "test_failure", "typescript_error", "build_error", "integration_failure", "execution_failure", "health_degradation", "provider_failure"]);
const REPEATED = new Set(["execution_failure", "health_degradation", "provider_failure"]);
const TERMINAL = new Set(["repaired", "dismissed"]);

export interface RepairCandidateInput extends Omit<CreateProposalInput, "uid" | "diagnosis" | "rootCauseHypothesis"> {
  reproductionTarget: ReproductionTarget;
}

export class AutonomousRepairEngine {
  private readonly now: () => number;
  constructor(private readonly deps: {
    store: SelfCodingStore;
    repository: ControlledRepository;
    proposals: CodeChangeProposalEngine;
    sandbox: RepairSandboxExecutor;
    health?: HealthEngine;
    now?: () => number;
  }) { this.now = deps.now ?? Date.now; }

  async detect(input: BugSignal): Promise<BugIncident | null> {
    const signal = normalizeSignal(input, this.now()); if (!signal) return null;
    const fingerprint = signalFingerprint(signal);
    const prior = (await this.deps.store.listIncidents(signal.uid)).reverse()
      .find((item) => item.fingerprint === fingerprint && !TERMINAL.has(item.status));
    const evidence = this.evidence("signal", signal.source, `${signal.summary}${signal.evidence ? ` | ${signal.evidence}` : ""}`, signal.occurredAt!, signal.authoritative === true);
    if (prior) {
      const occurrences = prior.occurrences + 1;
      const threshold = thresholdFor(prior.source);
      const next: BugIncident = {
        ...prior,
        occurrences,
        status: prior.status === "observing" && occurrences >= threshold ? "detected" : prior.status,
        detectedAt: prior.detectedAt ?? (occurrences >= threshold ? signal.occurredAt! : null),
        evidence: [...prior.evidence, evidence].slice(-REPAIR_LIMITS.evidencePerIncident),
        updatedAt: this.now(), revision: prior.revision + 1,
      };
      return await this.deps.store.compareAndSetIncident(next, prior.revision) ? next : this.deps.store.getIncident(signal.uid, prior.incidentId);
    }
    const threshold = thresholdFor(signal.source); const detected = threshold === 1;
    const incident: BugIncident = {
      uid: signal.uid, incidentId: randomUUID(), fingerprint, source: signal.source,
      component: signal.component, status: detected ? "detected" : "observing",
      summary: signal.summary, errorCode: signal.errorCode ?? null, occurrences: 1,
      evidence: [evidence], hypothesis: null, reproduction: null, attempts: [], linkedProposal: null,
      detectedAt: detected ? signal.occurredAt! : null, createdAt: signal.occurredAt!, updatedAt: signal.occurredAt!,
      resolvedAt: null, revision: 1, schemaVersion: 1,
    };
    return await this.deps.store.createIncident(incident) ? incident : null;
  }

  async investigate(uid: string, incidentId: string): Promise<BugIncident | null> {
    const current = await this.deps.store.getIncident(uid, incidentId);
    if (!current || !["detected", "needs_user"].includes(current.status)) return null;
    const diagnostic = current.evidence.map((item) => item.summary).join("\n").slice(-20_000);
    this.deps.repository.recordDiagnostic("error_log", diagnostic);
    const result = this.deps.proposals.diagnose(`${current.component} ${current.summary}`, diagnostic);
    const memories = await this.retrieveRegressionMemory(uid, `${current.component} ${current.summary}`);
    const repoEvidence = this.evidence(
      "repository", "controlled_repository",
      result.affectedFiles.length ? `Affected files: ${result.affectedFiles.map((item) => item.path).slice(0, 8).join(", ")}` : "No affected file was identified",
      this.now(), true,
    );
    const distinctKinds = new Set([...current.evidence.map((item) => item.kind), repoEvidence.kind]).size;
    const heuristicConfidence = result.affectedFiles.length
      ? Math.min(0.84, 0.42 + distinctKinds * 0.13 + (memories.length ? 0.08 : 0)) : 0.2;
    const hypothesis = {
      summary: clean(result.rootCauseHypothesis, 2_000), affectedFiles: result.affectedFiles,
      supportingEvidenceIds: [...current.evidence.map((item) => item.evidenceId), repoEvidence.evidenceId].slice(-20),
      heuristicConfidence, confidenceMeaning: "heuristic_not_probability" as const, createdAt: this.now(),
    };
    const next: BugIncident = {
      ...current, hypothesis, evidence: [...current.evidence, repoEvidence].slice(-REPAIR_LIMITS.evidencePerIncident),
      status: heuristicConfidence >= 0.6 ? "hypothesis_ready" : "needs_user",
      updatedAt: this.now(), revision: current.revision + 1,
    };
    return await this.deps.store.compareAndSetIncident(next, current.revision) ? next : null;
  }

  async reproduce(uid: string, incidentId: string, target: ReproductionTarget): Promise<BugIncident | null> {
    const current = await this.deps.store.getIncident(uid, incidentId);
    if (!current || current.status !== "hypothesis_ready" || !current.hypothesis || current.hypothesis.heuristicConfidence < 0.6) return null;
    let run;
    try { run = await this.deps.sandbox.reproduce(target); }
    catch (error) {
      run = { target, passed: false, exitCode: 1, durationMs: 0, output: error instanceof Error ? error.message : "reproduction runner failed" };
    }
    const reproduced = !run.passed && run.exitCode !== 124 && current.hypothesis.affectedFiles.length > 0;
    const reproductionEvidence = this.evidence(
      "reproduction", "fixed_sandbox", reproduced ? `Reproduced with exit ${run.exitCode}` : `Reproduction inconclusive (exit ${run.exitCode})`,
      this.now(), reproduced,
    );
    const next: BugIncident = {
      ...current, reproduction: run,
      hypothesis: { ...current.hypothesis, heuristicConfidence: reproduced ? Math.max(0.78, current.hypothesis.heuristicConfidence) : current.hypothesis.heuristicConfidence },
      status: reproduced ? "reproduced" : "needs_user",
      evidence: [...current.evidence, reproductionEvidence].slice(-REPAIR_LIMITS.evidencePerIncident),
      updatedAt: this.now(), revision: current.revision + 1,
    };
    return await this.deps.store.compareAndSetIncident(next, current.revision) ? next : null;
  }

  async createVerifiedCandidate(uid: string, incidentId: string, input: RepairCandidateInput): Promise<BugIncident | null> {
    const current = await this.deps.store.getIncident(uid, incidentId);
    if (!current || current.status !== "reproduced" || !current.hypothesis || current.hypothesis.heuristicConfidence < 0.65 || current.attempts.length >= REPAIR_LIMITS.attemptsPerIncident) return null;
    let targeted;
    try { targeted = await this.deps.sandbox.verifyTargeted(input.patches, input.reproductionTarget); }
    catch (error) { targeted = { target: input.reproductionTarget, passed: false, exitCode: 1, durationMs: 0, output: error instanceof Error ? error.message : "targeted verification failed" }; }
    let proposal = null;
    let verified = null;
    if (targeted.passed) {
      proposal = await this.deps.proposals.create({
        ...input, uid, diagnosis: current.hypothesis.summary,
        rootCauseHypothesis: current.hypothesis.summary,
      });
      if (proposal) verified = await this.deps.proposals.verify(uid, proposal.proposalId, proposal.version);
    }
    const passed = targeted.passed && verified?.status === "sandbox_verified";
    const attempt: RepairAttempt = {
      attempt: current.attempts.length + 1,
      proposalId: proposal?.proposalId ?? null, proposalVersion: proposal?.version ?? null,
      targeted, regression: verified?.verification ?? [], verified: passed,
      failureCode: passed ? null : !targeted.passed ? "targeted_verification_failed" : proposal ? "full_regression_failed" : "proposal_rejected",
      attemptedAt: this.now(),
    };
    const attempts = [...current.attempts, attempt];
    const next: BugIncident = {
      ...current, attempts, linkedProposal: passed && proposal ? { proposalId: proposal.proposalId, version: proposal.version } : current.linkedProposal,
      status: passed ? "candidate_verified" : attempts.length >= REPAIR_LIMITS.attemptsPerIncident ? "needs_user" : "reproduced",
      evidence: [...current.evidence, this.evidence("verification", "phase43_sandbox", passed ? "Targeted and full regression verification passed" : `Repair candidate failed: ${attempt.failureCode}`, this.now(), passed)].slice(-REPAIR_LIMITS.evidencePerIncident),
      updatedAt: this.now(), revision: current.revision + 1,
    };
    const saved = await this.deps.store.compareAndSetIncident(next, current.revision);
    if (!passed && this.deps.health) await this.deps.health.record({ uid, capabilityId: "self_repair", category: "integration", verdict: "failure", source: "repair_verification", detailCode: attempt.failureCode });
    return saved ? next : null;
  }

  async finalizeAppliedRepair(uid: string, incidentId: string): Promise<RegressionMemory | null> {
    const current = await this.deps.store.getIncident(uid, incidentId);
    if (!current || current.status !== "candidate_verified" || !current.linkedProposal || !current.hypothesis) return null;
    const proposal = await this.deps.proposals.get(uid, current.linkedProposal.proposalId, current.linkedProposal.version);
    if (!proposal || proposal.status !== "applied" || !proposal.appliedAt) return null;
    const memory: RegressionMemory = {
      uid, memoryId: `regression_${digest(`${uid}|${current.fingerprint}|${proposal.proposalId}|${proposal.version}`)}`,
      incidentId, fingerprint: current.fingerprint, bug: clean(current.summary, 1_000), cause: clean(current.hypothesis.summary, 2_000),
      fix: clean(`${proposal.title}: ${proposal.reason}`, 2_000), tests: proposal.tests.slice(0, 50),
      affectedComponents: [...new Set([current.component, ...proposal.affectedFiles.map((item) => item.path)])].slice(0, 30),
      proposalId: proposal.proposalId, proposalVersion: proposal.version, verifiedAt: proposal.appliedAt,
      lastRetrievedAt: null, retrievalCount: 0, untrustedData: true, schemaVersion: 1,
    };
    if (!(await this.deps.store.putRegressionMemory(memory))) {
      const existing = (await this.deps.store.listRegressionMemories(uid)).find((item) => item.memoryId === memory.memoryId);
      if (!existing) return null;
    }
    const next: BugIncident = { ...current, status: "repaired", resolvedAt: this.now(), updatedAt: this.now(), revision: current.revision + 1 };
    if (!(await this.deps.store.compareAndSetIncident(next, current.revision))) return null;
    if (this.deps.health) await this.deps.health.record({ uid, capabilityId: "self_repair", category: "integration", verdict: "success", source: "applied_verified_repair", detailCode: "repair_applied_and_verified", authoritative: true });
    return memory;
  }

  async retrieveRegressionMemory(uid: string, query: string): Promise<RegressionMemory[]> {
    const tokens = meaningfulTokens(query); if (!tokens.length) return [];
    return (await this.deps.store.listRegressionMemories(uid)).map((memory) => {
      const haystack = `${memory.bug} ${memory.cause} ${memory.fix} ${memory.affectedComponents.join(" ")}`.toLowerCase();
      return { memory, score: tokens.filter((token) => haystack.includes(token)).length };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || b.memory.verifiedAt - a.memory.verifiedAt)
      .slice(0, REPAIR_LIMITS.retrievalResults).map((item) => item.memory);
  }

  async listIncidents(uid: string): Promise<BugIncident[]> { return this.deps.store.listIncidents(uid); }
  async getIncident(uid: string, incidentId: string): Promise<BugIncident | null> { return this.deps.store.getIncident(uid, incidentId); }
  async metrics(uid: string) {
    const incidents = await this.deps.store.listIncidents(uid); const attempts = incidents.flatMap((item) => item.attempts);
    return {
      observedSignals: incidents.reduce((sum, item) => sum + item.occurrences, 0),
      incidents: incidents.length,
      detected: incidents.filter((item) => item.status !== "observing").length,
      reproduced: incidents.filter((item) => item.reproduction && !item.reproduction.passed).length,
      repairAttempts: attempts.length,
      verifiedCandidates: attempts.filter((item) => item.verified).length,
      repaired: incidents.filter((item) => item.status === "repaired").length,
      needsUser: incidents.filter((item) => item.status === "needs_user").length,
    };
  }

  private evidence(kind: BugEvidence["kind"], source: string, summary: string, capturedAt: number, authoritative: boolean): BugEvidence {
    return { evidenceId: randomUUID(), kind, source: clean(source, 80), summary: clean(summary, REPAIR_LIMITS.signalTextChars), capturedAt, authoritative };
  }
}

function normalizeSignal(input: BugSignal, now: number): BugSignal | null {
  if (!input || !/^[A-Za-z0-9_-]{1,128}$/.test(input.uid) || !SOURCES.has(input.source)) return null;
  const component = clean(input.component, 120); const summary = clean(input.summary, REPAIR_LIMITS.signalTextChars);
  if (!component || !summary) return null;
  return { ...input, component, summary, errorCode: clean(input.errorCode ?? "", 120) || null, evidence: clean(input.evidence ?? "", REPAIR_LIMITS.signalTextChars), occurredAt: Math.min(now + 60_000, Number.isFinite(input.occurredAt) ? input.occurredAt! : now) };
}
function thresholdFor(source: BugSignal["source"]): number { return REPEATED.has(source) ? REPAIR_LIMITS.repeatedSignalThreshold : 1; }
function clean(value: unknown, max: number): string { return String(value ?? "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, max); }
function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32); }
function signalFingerprint(signal: BugSignal): string {
  const normalized = `${signal.source}|${signal.component}|${signal.errorCode ?? ""}|${signal.summary}`.toLowerCase().replace(/\b\d+\b/g, "#").replace(/[a-f0-9]{12,}/g, "#");
  return digest(normalized);
}
function meaningfulTokens(value: string): string[] {
  return [...new Set((value.toLowerCase().match(/[a-z][a-z0-9_.-]{2,}/g) ?? []).filter((item) => !["the", "and", "for", "with", "from", "error", "failed"].includes(item)))].slice(0, 16);
}
