import { randomUUID } from "node:crypto";
import type { ControlledRepository } from "./repository";
import type { SandboxExecutor } from "./sandbox";
import type { SelfCodingStore } from "./store";
import type {
  ChangeKind,
  CodeChangeAuditEvent,
  CodeChangeProposal,
  FileReference,
  ProposedFilePatch,
} from "./types";
import { SELF_CODING_LIMITS } from "./types";
import { evaluatePatchSecurity, proposalContentDigest, verifiedApprovalDigest } from "./policy";

export interface CreateProposalInput {
  uid: string;
  proposalId?: string;
  kind: ChangeKind;
  title: string;
  reason: string;
  requirement: string;
  errorLog?: string;
  diagnosis?: string;
  rootCauseHypothesis?: string;
  patches: ProposedFilePatch[];
  tests: string[];
}

export interface DiagnosisResult {
  diagnosis: string;
  rootCauseHypothesis: string;
  affectedFiles: FileReference[];
}

export class CodeChangeProposalEngine {
  private readonly now: () => number;
  constructor(private readonly deps: {
    repository: ControlledRepository;
    store: SelfCodingStore;
    sandbox: SandboxExecutor;
    now?: () => number;
  }) { this.now = deps.now ?? Date.now; }

  diagnose(requirement: string, errorLog = ""): DiagnosisResult {
    const affectedFiles = this.deps.repository.identifyAffectedFiles(requirement, errorLog);
    const names = affectedFiles.slice(0, 5).map((file) => file.path);
    return {
      diagnosis: errorLog.trim()
        ? `The bounded error evidence points to ${names.length ? names.join(", ") : "no confidently matched source file"}.`
        : `Architecture search found ${affectedFiles.length} potentially affected file(s).`,
      rootCauseHypothesis: names.length
        ? `The defect or missing behavior is likely within ${names.join(", ")} or their direct import relationships; sandbox verification is required.`
        : "The available repository evidence is insufficient for a reliable root-cause hypothesis.",
      affectedFiles,
    };
  }

  async create(input: CreateProposalInput): Promise<CodeChangeProposal | null> {
    const normalizedPatches = normalizePatches(input.patches as unknown[]);
    if (!validUid(input.uid) || !["bug_fix", "feature"].includes(input.kind) || !normalizedPatches || normalizedPatches.length > SELF_CODING_LIMITS.maxPatches) return null;
    const proposalId = input.proposalId && validId(input.proposalId) ? input.proposalId : randomUUID();
    const prior = await this.deps.store.listProposals(input.uid, proposalId);
    const version = prior.length ? Math.max(...prior.map((item) => item.version)) + 1 : 1;
    const inferred = this.diagnose(input.requirement, input.errorLog ?? "");
    const affected = mergeReferences(inferred.affectedFiles, normalizedPatches.flatMap((patch) => {
      const source = this.deps.repository.readSource(patch.path); return source ? [source.reference] : [];
    }));
    const dependencySummary = affected.flatMap((file) => this.deps.repository.dependencies(file.path)).slice(0, 200);
    const now = this.now();
    const core = {
      kind: input.kind,
      title: clean(input.title, 160), reason: clean(input.reason, 1_000), requirement: clean(input.requirement, 2_000),
      diagnosis: clean(input.diagnosis ?? inferred.diagnosis, 2_000),
      rootCauseHypothesis: clean(input.rootCauseHypothesis ?? inferred.rootCauseHypothesis, 2_000),
      patches: clone(normalizedPatches), tests: Array.isArray(input.tests) ? input.tests.filter((test): test is string => typeof test === "string").map((test) => clean(test, 300)).filter(Boolean).slice(0, 50) : [], version,
    };
    if (!core.title || !core.reason || !core.requirement || !core.diagnosis || !core.rootCauseHypothesis) return null;
    const security = evaluatePatchSecurity(core.patches, core.tests, now);
    const proposal: CodeChangeProposal = {
      uid: input.uid, proposalId, version, kind: core.kind, status: "proposed",
      title: core.title, reason: core.reason, requirement: core.requirement,
      diagnosis: core.diagnosis, rootCauseHypothesis: core.rootCauseHypothesis,
      affectedFiles: affected.slice(0, SELF_CODING_LIMITS.maxAffectedFiles), dependencySummary,
      patches: core.patches, tests: core.tests, verification: [], security,
      approval: { requestId: null, requestedAt: null, approvedAt: null, approvedBy: null, approvedDigest: null },
      proposalDigest: proposalContentDigest(core), createdAt: now, updatedAt: now, appliedAt: null, revision: 1, schemaVersion: 1,
    };
    const event = this.event(proposal, "proposal_created", "system", null, `proposal created; security=${security.passed ? "pass" : "fail"}`);
    return await this.deps.store.createProposal(proposal, event) ? proposal : null;
  }

  async verify(uid: string, proposalId: string, version: number): Promise<CodeChangeProposal | null> {
    const current = await this.deps.store.getProposal(uid, proposalId, version);
    if (!current || current.uid !== uid || !["proposed", "verification_failed"].includes(current.status)) return null;
    const security = evaluatePatchSecurity(current.patches, current.tests, this.now());
    let verification = [] as CodeChangeProposal["verification"];
    if (security.passed) {
      try {
        this.deps.repository.previewPatches(current.patches);
        verification = await this.deps.sandbox.verify(current.patches, ["security", "tests", "typecheck", "build"]);
        const build = verification.find((run) => run.check === "build");
        if (build) this.deps.repository.recordDiagnostic("build_output", build.output);
        const failedRun = verification.find((run) => !run.passed);
        if (failedRun) this.deps.repository.recordDiagnostic("error_log", `${failedRun.check}: ${failedRun.output}`);
      } catch (error) {
        verification = [{ check: "security", passed: false, exitCode: 1, durationMs: 0, output: error instanceof Error ? error.message : "patch preview failed" }];
      }
    }
    const required = new Set(["security", "tests", "typecheck", "build"]);
    const passed = security.passed && verification.every((run) => run.passed) && verification.length === required.size && verification.every((run) => required.delete(run.check)) && required.size === 0;
    const next: CodeChangeProposal = {
      ...current, status: passed ? "sandbox_verified" : "verification_failed", security, verification: clone(verification),
      approval: { requestId: null, requestedAt: null, approvedAt: null, approvedBy: null, approvedDigest: null },
      updatedAt: this.now(), revision: current.revision + 1,
    };
    const event = this.event(next, "verification_completed", "system", null, passed ? "all fixed sandbox checks passed" : "sandbox or security verification failed");
    return await this.deps.store.compareAndSetProposal(next, current.revision, event) ? next : null;
  }

  async requestApproval(uid: string, proposalId: string, version: number): Promise<{ proposal: CodeChangeProposal; approvalRequestId: string } | null> {
    const current = await this.deps.store.getProposal(uid, proposalId, version);
    if (!current || current.status !== "sandbox_verified" || !allVerified(current)) return null;
    const requestId = randomUUID(); const now = this.now();
    const next: CodeChangeProposal = {
      ...current, status: "pending_approval",
      approval: { requestId, requestedAt: now, approvedAt: null, approvedBy: null, approvedDigest: null },
      updatedAt: now, revision: current.revision + 1,
    };
    const event = this.event(next, "approval_requested", "authenticated_user", uid, "human approval requested for verified proposal digest");
    return await this.deps.store.compareAndSetProposal(next, current.revision, event) ? { proposal: next, approvalRequestId: requestId } : null;
  }

  async approve(input: { uid: string; proposalId: string; version: number; approvalRequestId: string; approved: boolean }): Promise<CodeChangeProposal | null> {
    if (input.approved !== true) return null;
    const current = await this.deps.store.getProposal(input.uid, input.proposalId, input.version);
    if (!current || current.status !== "pending_approval" || current.approval.requestId !== input.approvalRequestId || !allVerified(current)) return null;
    const now = this.now();
    const next: CodeChangeProposal = {
      ...current, status: "approved",
      approval: { ...current.approval, approvedAt: now, approvedBy: input.uid, approvedDigest: verifiedApprovalDigest(current) },
      updatedAt: now, revision: current.revision + 1,
    };
    const event = this.event(next, "approved", "authenticated_user", input.uid, "explicit human approval recorded");
    return await this.deps.store.compareAndSetProposal(next, current.revision, event) ? next : null;
  }

  async reject(uid: string, proposalId: string, version: number, reason: string): Promise<boolean> {
    const current = await this.deps.store.getProposal(uid, proposalId, version);
    if (!current || ["applied", "applying", "rejected"].includes(current.status)) return false;
    const next = { ...current, status: "rejected" as const, updatedAt: this.now(), revision: current.revision + 1 };
    return this.deps.store.compareAndSetProposal(next, current.revision, this.event(next, "rejected", "authenticated_user", uid, clean(reason, 500) || "rejected"));
  }

  async apply(uid: string, proposalId: string, version: number): Promise<CodeChangeProposal | null> {
    const current = await this.deps.store.getProposal(uid, proposalId, version);
    if (!current || current.status !== "approved" || current.approval.approvedBy !== uid || !current.approval.approvedDigest || !allVerified(current)) return null;
    if (verifiedApprovalDigest({ ...current, approval: { ...current.approval, approvedDigest: null } }) !== current.approval.approvedDigest) return null;
    const security = evaluatePatchSecurity(current.patches, current.tests, this.now());
    if (!security.passed || !affectedFilesUnchanged(this.deps.repository, current.affectedFiles)) return null;
    try { this.deps.repository.previewPatches(current.patches); } catch { return null; }
    const applying: CodeChangeProposal = { ...current, status: "applying", updatedAt: this.now(), revision: current.revision + 1 };
    const started = this.event(applying, "apply_started", "authenticated_user", uid, "approved patch application started");
    if (!(await this.deps.store.compareAndSetProposal(applying, current.revision, started))) return null;
    const result = this.deps.repository.applyPatches(applying.patches);
    const final: CodeChangeProposal = {
      ...applying, status: result.ok ? "applied" : "apply_failed",
      appliedAt: result.ok ? this.now() : null,
      updatedAt: this.now(), revision: applying.revision + 1,
    };
    const event = this.event(final, result.ok ? "applied" : "apply_failed", "system", null, result.ok ? "approved patch applied" : `patch apply failed: ${clean(result.error ?? "unknown", 500)}`);
    return await this.deps.store.compareAndSetProposal(final, applying.revision, event) ? final : null;
  }

  async get(uid: string, proposalId: string, version: number): Promise<CodeChangeProposal | null> { return this.deps.store.getProposal(uid, proposalId, version); }
  async list(uid: string, proposalId?: string): Promise<CodeChangeProposal[]> { return this.deps.store.listProposals(uid, proposalId); }
  async audit(uid: string, proposalId: string) { return this.deps.store.listAudit(uid, proposalId); }

  private event(proposal: CodeChangeProposal, type: CodeChangeAuditEvent["type"], actor: CodeChangeAuditEvent["actor"], actorUid: string | null, details: string): CodeChangeAuditEvent {
    return {
      uid: proposal.uid, eventId: randomUUID(), proposalId: proposal.proposalId, proposalVersion: proposal.version,
      type, actor, actorUid, proposalDigest: proposal.proposalDigest,
      details: clean(details, SELF_CODING_LIMITS.maxAuditDetailChars), timestamp: this.now(),
    };
  }
}

function allVerified(proposal: CodeChangeProposal): boolean {
  return proposal.security?.passed === true && ["security", "tests", "typecheck", "build"].every((check) => proposal.verification.some((run) => run.check === check && run.passed));
}
function affectedFilesUnchanged(repository: ControlledRepository, references: FileReference[]): boolean {
  return references.every((reference) => repository.readSource(reference.path)?.reference.sha256 === reference.sha256);
}
function mergeReferences(a: FileReference[], b: FileReference[]): FileReference[] {
  const map = new Map<string, FileReference>(); for (const value of [...a, ...b]) map.set(value.path, value); return [...map.values()];
}
function clean(value: string, max: number): string { return String(value ?? "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, max); }
function validUid(value: string): boolean { return /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function validId(value: string): boolean { return /^[A-Za-z0-9_.:-]{1,160}$/.test(value); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function normalizePatches(values: unknown[]): ProposedFilePatch[] | null {
  if (!Array.isArray(values)) return null;
  const output: ProposedFilePatch[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object") return null;
    const item = value as Record<string, unknown>;
    if (typeof item.path !== "string" || !["create", "update"].includes(String(item.operation)) || !(item.expectedSha256 === null || typeof item.expectedSha256 === "string") || !Array.isArray(item.hunks)) return null;
    const hunks: Array<{ oldText: string; newText: string }> = [];
    for (const hunk of item.hunks) {
      if (!hunk || typeof hunk !== "object" || typeof (hunk as Record<string, unknown>).oldText !== "string" || typeof (hunk as Record<string, unknown>).newText !== "string") return null;
      hunks.push({ oldText: (hunk as { oldText: string }).oldText, newText: (hunk as { newText: string }).newText });
    }
    output.push({ path: item.path, operation: item.operation as "create" | "update", expectedSha256: item.expectedSha256 as string | null, hunks });
  }
  return output;
}
