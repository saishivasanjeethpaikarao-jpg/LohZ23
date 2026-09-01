import { describe, expect, it } from "vitest";
import { MockFirestore } from "../persistence/mockFirestore";
import { FirestoreLearningStore } from "./firestoreStore";
import type { ExperienceRecord, ExperienceReflection, LessonRecord, SkillVersion } from "./types";
import type { AdaptationVersion, DecisionObservation } from "../adaptation/types";

const experience = (uid: string, id: string): ExperienceRecord => ({
  id, uid, objective: "test", context: { environment: "windows", signature: "sig", tags: [] }, planId: "p", planVersion: 1, requestId: "r",
  steps: [], outcome: "success", failures: [], recovery: { attempted: false, succeeded: false, actions: [] }, replans: { count: 0, planIds: [] },
  verification: "NOT_APPLICABLE", success: true, userCorrections: [], source: { executionRequestIds: [], observationIds: [] }, createdAt: 1, schemaVersion: 1,
});
const skill = (uid: string): SkillVersion => ({
  uid, skillId: "s", version: 1, name: "Skill", description: "data", trigger: { signature: "sig", objectiveTokens: [] }, requiredContext: { environment: "windows", tags: [] }, stepGraph: [],
  riskProfile: { maximumRisk: "safe", tools: [], requiresConfirmation: false, policyMutable: false }, sourceExperienceIds: [], metrics: { samples: 0, successes: 0, failures: 0, successRate: null, failureRate: null },
  status: "candidate", validation: { validatedAt: null, issues: [] }, replay: { verifiedAt: null, sourceExperienceIds: [], failures: [] }, approval: { requestedAt: null, approvedAt: null, approvalRequestId: null },
  createdAt: 1, lastVerifiedAt: null, replacesVersion: null, schemaVersion: 1,
});
const reflection = (uid: string): ExperienceReflection => ({
  reflectionId: "reflection:e1", uid, experienceId: "e1", taskType: "sig", outcome: "success", status: "completed",
  lessonIds: ["lesson-1"], rejectedCandidateCodes: [], generatedAt: 2, deterministic: true, modelCallsUsed: 0, schemaVersion: 1,
});
const lesson = (uid: string, revision = 1): LessonRecord => ({
  lessonId: "lesson-1", uid, type: "procedural", topicKey: "procedure:sig", statement: "Verified procedure evidence.", polarity: "positive",
  context: { environment: "windows", signature: "sig" }, sourceExperienceIds: ["e1"], evidenceCount: 1, confidence: 0.6, confidenceKind: "heuristic",
  contradictionIds: [], status: "candidate", createdAt: 2, updatedAt: 2, lastReinforcedAt: 2, expiresAt: 3, revision,
  safety: { dataOnly: true, executable: false, policyMutable: false, authorizationEffect: "none" }, schemaVersion: 1,
});
const decision = (uid: string): DecisionObservation => ({ observationId: "d1", uid, requestId: "r1", taskType: "intent:chat:test", approach: "deterministic", predictedConfidence: 0.8, confidenceKind: "heuristic", actualOutcome: "VERIFIED_SUCCESS", source: "execution", environment: "windows", createdAt: 1, schemaVersion: 1 });
const adaptation = (uid: string): AdaptationVersion => ({ uid, adaptationId: "a1", version: 1, taskType: "intent:chat:test", recommendedApproach: "model_reasoning", baselineApproach: "deterministic", evidenceObservationIds: ["d1"], evaluation: { samples: 6, recommendedSuccessRate: 1, baselineSuccessRate: 0, improvement: 1, evaluatedAt: null, issues: [] }, status: "candidate", approval: { requestedAt: null, approvedAt: null, approvalRequestId: null }, createdAt: 1, updatedAt: 1, replacesVersion: null, safety: { policyMutable: false, authorizationEffect: "none", riskReductionAllowed: false, toolArgumentsMutable: false }, schemaVersion: 1 });

describe("Phase 36 Firestore learning persistence", () => {
  it("roots every record below the explicit owner and rejects cross-user reads", async () => {
    const db = new MockFirestore(); const store = new FirestoreLearningStore(db, () => undefined);
    expect(await store.addExperience(experience("userA", "e1"))).toBe(true);
    expect((await store.getExperience("userA", "e1"))?.uid).toBe("userA");
    expect(await store.getExperience("userB", "e1")).toBeNull();
    expect(db.ops.every((op) => !op.path.includes("users/userB/learningExperiences") || op.op === "get")).toBe(true);
  });

  it("uses a transactional head to enforce immutable version progression", async () => {
    const store = new FirestoreLearningStore(new MockFirestore(), () => undefined);
    expect(await store.putSkillVersion(skill("u1"), null)).toBe(true);
    expect(await store.putSkillVersion({ ...skill("u1"), version: 2 }, null)).toBe(false);
    expect(await store.putSkillVersion({ ...skill("u1"), version: 2 }, 1)).toBe(true);
    expect((await store.listSkillVersions("u1", "s")).map((item) => item.version)).toEqual([1, 2]);
  });

  it("fails closed on backend outage", async () => {
    const db = new MockFirestore({ failureMode: new Error("offline") });
    const store = new FirestoreLearningStore(db, () => undefined);
    expect(await store.addExperience(experience("u1", "e1"))).toBe(false);
    expect(await store.listExperiences("u1")).toEqual([]);
  });

  it("persists Phase 39 reflections once and uses optimistic lesson revisions", async () => {
    const store = new FirestoreLearningStore(new MockFirestore(), () => undefined);
    expect(await store.putReflection(reflection("u1"))).toBe(true);
    expect(await store.putReflection(reflection("u1"))).toBe(false);
    expect((await store.getReflection("u1", "e1"))?.uid).toBe("u1");
    expect(await store.getReflection("u2", "e1")).toBeNull();
    expect(await store.putLesson(lesson("u1"), null)).toBe(true);
    expect(await store.putLesson({ ...lesson("u1", 2), evidenceCount: 2 }, null)).toBe(false);
    expect(await store.putLesson({ ...lesson("u1", 2), evidenceCount: 2 }, 1)).toBe(true);
    expect((await store.getLesson("u1", "lesson-1"))?.evidenceCount).toBe(2);
    expect(await store.getLesson("u2", "lesson-1")).toBeNull();
  });

  it("persists Phase 40 observations immutably and versions adaptations transactionally", async () => {
    const store = new FirestoreLearningStore(new MockFirestore(), () => undefined);
    expect(await store.addDecisionObservation(decision("u1"))).toBe(true);
    expect(await store.addDecisionObservation(decision("u1"))).toBe(false);
    expect(await store.listDecisionObservations("u2")).toEqual([]);
    expect(await store.putAdaptationVersion(adaptation("u1"), null)).toBe(true);
    expect(await store.putAdaptationVersion({ ...adaptation("u1"), version: 2, replacesVersion: 1 }, null)).toBe(false);
    expect(await store.putAdaptationVersion({ ...adaptation("u1"), version: 2, replacesVersion: 1 }, 1)).toBe(true);
    expect(await store.getAdaptationVersion("u2", "a1", 1)).toBeNull();
  });
});
