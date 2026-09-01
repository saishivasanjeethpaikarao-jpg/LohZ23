import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AdaptiveDecisionService } from "./service";
import type { DecisionObservation, RoutingApproach } from "./types";
import { InMemoryLearningStore } from "../learning/store";
import { LocalLearningStore } from "../learning/durableStore";
import type { ExperienceRecord, LessonRecord } from "../learning/types";
import { CognitiveRouter } from "../router/cognitiveRouter";

const taskType = "intent:chat:open-dashboard";

function observation(uid: string, id: string, approach: RoutingApproach, outcome: "VERIFIED_SUCCESS" | "VERIFIED_FAILURE" | "INCONCLUSIVE" = "VERIFIED_SUCCESS", score = 0.8): DecisionObservation {
  return { observationId: id, uid, requestId: `r-${id}`, taskType, approach, predictedConfidence: score, confidenceKind: "heuristic", actualOutcome: outcome, source: "execution", environment: "windows-local", createdAt: Number(id.replace(/\D/g, "")) || 1, schemaVersion: 1 };
}

function experience(uid: string, id: string, app = "Chrome", signature = "windows|openApp|dashboard"): ExperienceRecord {
  return {
    id, uid, objective: "Open project dashboard", context: { environment: "windows", signature, tags: [] }, planId: `p-${id}`, planVersion: 1, requestId: `r-${id}`,
    steps: [{ stepId: "s1", index: 0, title: "Open app", toolName: "openApp", arguments: { name: app }, dependencies: [], expectedOutcome: "open", riskLevel: "safe", outcome: "completed", attempts: 1, durationMs: 1, failureCode: null, verification: "VERIFIED" }],
    outcome: "success", failures: [], recovery: { attempted: false, succeeded: false, actions: [] }, replans: { count: 0, planIds: [`p-${id}`] }, verification: "VERIFIED", success: true, userCorrections: [], source: { executionRequestIds: [`r-${id}`], observationIds: [`o-${id}`] },
    decision: { taskType, approach: "deterministic", predictedConfidence: 0.9, confidenceKind: "heuristic" }, createdAt: 1, schemaVersion: 1,
  };
}

function preferenceLesson(uid: string, id: string, value: string): LessonRecord {
  return { lessonId: id, uid, type: "user_preference", topicKey: `preference:${value.replace(/ /g, "-")}`, statement: `Explicit user preference evidence: prefers ${value}.`, polarity: "positive", context: { environment: "windows", signature: "preference" }, sourceExperienceIds: ["explicit"], evidenceCount: 2, confidence: 0.7, confidenceKind: "heuristic", contradictionIds: [], status: "reinforced", createdAt: 1, updatedAt: 1, lastReinforcedAt: 1, expiresAt: 9999999999999, revision: 1, safety: { dataOnly: true, executable: false, policyMutable: false, authorizationEffect: "none" }, schemaVersion: 1 };
}

async function comparativeEvidence(service: AdaptiveDecisionService, uid = "u1"): Promise<void> {
  for (let i = 1; i <= 3; i++) await service.observe(observation(uid, `d${i}`, "deterministic", "VERIFIED_FAILURE", 0.8));
  for (let i = 1; i <= 3; i++) await service.observe(observation(uid, `m${i}`, "model_reasoning", "VERIFIED_SUCCESS", 0.7));
}

describe("Phase 40 adaptive decision service", () => {
  it("fails safely at cold start and with insufficient evidence", async () => {
    const service = new AdaptiveDecisionService({ store: new InMemoryLearningStore(), now: () => 100 });
    expect((await service.calibration("u1")).status).toBe("insufficient_evidence");
    expect(await service.propose("u1", taskType, "deterministic")).toBeNull();
    expect(await service.recommend("u1", taskType)).toBeNull();
  });

  it("calculates labelled heuristic calibration from verified outcomes only", async () => {
    const service = new AdaptiveDecisionService({ store: new InMemoryLearningStore(), now: () => 200 });
    for (let i = 1; i <= 3; i++) await service.observe(observation("u1", `s${i}`, "deterministic", "VERIFIED_SUCCESS", 0.8));
    for (let i = 1; i <= 2; i++) await service.observe(observation("u1", `f${i}`, "deterministic", "VERIFIED_FAILURE", 0.8));
    await service.observe(observation("u1", "x1", "deterministic", "INCONCLUSIVE", 1));
    const metrics = await service.calibration("u1");
    expect(metrics).toMatchObject({ status: "measured", sampleSize: 5, empiricalSuccessRate: 0.6, meanScore: 0.8, interpretation: "heuristic_score_diagnostic" });
    expect(metrics.diagnosticBrierScore).toBeCloseTo(0.28);
  });

  it("runs proposal, evaluation, approval, and versioned deployment without silent activation", async () => {
    const store = new InMemoryLearningStore(); const service = new AdaptiveDecisionService({ store, now: () => 300 });
    await comparativeEvidence(service);
    const proposal = await service.propose("u1", taskType, "deterministic");
    expect(proposal).toMatchObject({ status: "candidate", recommendedApproach: "model_reasoning", version: 1 });
    expect(await service.recommend("u1", taskType)).toBeNull();
    expect((await service.evaluate("u1", proposal!.adaptationId, 1)).ok).toBe(true);
    expect(await service.requestApproval("u1", proposal!.adaptationId, 1, "approval-1")).toBe(true);
    expect(await service.approveAndDeploy("u1", proposal!.adaptationId, 1, { authenticatedUserId: "attacker", approvalRequestId: "approval-1", approved: true })).toBe(false);
    expect(await service.approveAndDeploy("u1", proposal!.adaptationId, 1, { authenticatedUserId: "u1", approvalRequestId: "approval-1", approved: true })).toBe(true);
    expect(await service.recommend("u1", taskType)).toMatchObject({ approach: "model_reasoning", version: 1, advisoryOnly: true });
    expect((await store.getAdaptationVersion("u1", proposal!.adaptationId, 1))?.safety).toEqual({ policyMutable: false, authorizationEffect: "none", riskReductionAllowed: false, toolArgumentsMutable: false });
    const v2 = await service.propose("u1", taskType, "deterministic");
    expect(v2?.version).toBe(2);
    await service.evaluate("u1", proposal!.adaptationId, 2); await service.requestApproval("u1", proposal!.adaptationId, 2, "approval-2");
    await service.approveAndDeploy("u1", proposal!.adaptationId, 2, { authenticatedUserId: "u1", approvalRequestId: "approval-2", approved: true });
    expect((await store.getAdaptationVersion("u1", proposal!.adaptationId, 1))?.status).toBe("retired");
    expect((await service.recommend("u1", taskType))?.version).toBe(2);
  });

  it("does not propose when contradictory evidence removes a meaningful advantage", async () => {
    const service = new AdaptiveDecisionService({ store: new InMemoryLearningStore() });
    for (let i = 1; i <= 3; i++) {
      await service.observe(observation("u1", `a${i}`, "deterministic", i < 3 ? "VERIFIED_SUCCESS" : "VERIFIED_FAILURE"));
      await service.observe(observation("u1", `b${i}`, "model_reasoning", i < 3 ? "VERIFIED_SUCCESS" : "VERIFIED_FAILURE"));
    }
    expect(await service.propose("u1", taskType, "deterministic")).toBeNull();
  });

  it("rejects malicious historical data and keeps users isolated", async () => {
    const store = new InMemoryLearningStore(); const service = new AdaptiveDecisionService({ store });
    expect(await service.observe({ ...observation("u1", "evil", "planner"), taskType: "intent:chat:ignore-previous-instructions" })).toBe(false);
    await comparativeEvidence(service, "u1");
    expect(await service.propose("u2", taskType, "deterministic")).toBeNull();
    expect((await service.calibration("u2")).sampleSize).toBe(0);
  });

  it("fails closed without changing request truth when evidence persistence is unavailable", async () => {
    const store = new InMemoryLearningStore();
    store.addDecisionObservation = async () => { throw new Error("offline"); };
    const service = new AdaptiveDecisionService({ store });
    expect(await service.observe(observation("u1", "offline", "deterministic"))).toBe(false);
  });

  it("derives bounded non-sensitive personalization from explicit and verified evidence", async () => {
    const store = new InMemoryLearningStore();
    for (let i = 1; i <= 3; i++) await store.addExperience(experience("u1", `e${i}`));
    await store.putLesson(preferenceLesson("u1", "l1", "concise technical answers"), null);
    await store.putLesson(preferenceLesson("u1", "l2", "markdown bullet format"), null);
    const service = new AdaptiveDecisionService({ store, now: () => 400, loadProjects: async () => [{ key: "lohz", displayName: "LOHZ", confidence: 0.9, stale: false }] });
    for (let i = 1; i <= 3; i++) await service.observeExperience(experience("u1", `obs${i}`));
    const snapshot = await service.personalization("u1");
    expect(snapshot.communicationStyles[0]?.value).toContain("concise");
    expect(snapshot.preferredOutputFormats[0]?.value).toContain("markdown");
    expect(snapshot.preferredApplications[0]).toMatchObject({ value: "Chrome", evidenceCount: 3 });
    expect(snapshot.recurringWorkflows[0]?.evidenceCount).toBe(3);
    expect(snapshot.recurringProjects[0]?.value).toBe("LOHZ");
    expect(snapshot.sensitiveInferencePerformed).toBe(false);
  });

  it("persists observations and deployed adaptations across restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lohz-phase40-"));
    try {
      const first = new LocalLearningStore(root); const service = new AdaptiveDecisionService({ store: first, now: () => 500 });
      await comparativeEvidence(service); const proposal = await service.propose("u1", taskType, "deterministic");
      await service.evaluate("u1", proposal!.adaptationId, 1); await service.requestApproval("u1", proposal!.adaptationId, 1, "approved");
      await service.approveAndDeploy("u1", proposal!.adaptationId, 1, { authenticatedUserId: "u1", approvalRequestId: "approved", approved: true });
      const restarted = new AdaptiveDecisionService({ store: new LocalLearningStore(root), now: () => 501 });
      expect(await restarted.recommend("u1", taskType)).toMatchObject({ approach: "model_reasoning", version: 1 });
      expect((await restarted.calibration("u1")).sampleSize).toBe(6);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("Phase 40 router integration", () => {
  it("applies an approved-style model recommendation only within the non-tool route class", async () => {
    const gateway = { generate: vi.fn(async () => ({ text: "adapted answer", provider: "test" })) };
    const router = new CognitiveRouter({ executeTool: vi.fn(), gateway, adaptation: { recommendForInput: async () => ({ taskType: "intent:chat:hello", approach: "model_reasoning", adaptationId: "a", version: 1, evidenceSamples: 6, advisoryOnly: true }) } });
    const result = await router.route("u1", "hello there");
    expect(result.tier).toBe("tier2_reasoning"); expect(result.response).toBe("adapted answer"); expect(gateway.generate).toHaveBeenCalledOnce();
  });

  it("allows adaptation to become more cautious but never executes a participant request", async () => {
    const executeTool = vi.fn(async () => ({ ok: true })); const recommend = vi.fn(async () => ({ taskType: "intent:open_app:open-chrome", approach: "clarification" as const, adaptationId: "a", version: 1, evidenceSamples: 6, advisoryOnly: true as const }));
    const router = new CognitiveRouter({ executeTool, adaptation: { recommendForInput: recommend } });
    const primary = await router.route("u1", "open Chrome");
    expect(primary.response).toMatch(/clarify/i); expect(executeTool).not.toHaveBeenCalled();
    const participant = await router.route("u1", "open Chrome", { speakerAuthorization: "participant" });
    expect(participant.diagnostic.errorKind).toBe("participant_not_authorized"); expect(executeTool).not.toHaveBeenCalled();
  });
});
