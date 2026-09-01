import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, setDoc } from "firebase/firestore";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { FirestoreUserStoreImpl, wrapAdminFirestore } from "./firestoreUserStore";
import { FirestoreExecutionRepository } from "../execution/firestoreExecutionRepository";
import { PlanExecutionEngine } from "../execution/planExecutor";
import type { Plan } from "../planner/types";
import { FirestoreWorldStateStore } from "../worldModel/firestoreStore";
import { WorldModelService } from "../worldModel/service";
import { FirestoreExecutionSessionStore } from "../execution/firestoreSessionStore";
import type { ExecutionSession } from "../execution/sessionTypes";

const projectId = "demo-lohz-phase33";
let environment: RulesTestEnvironment;

function clipboardPlan(uid: string): Plan {
  const now = Date.now();
  return {
    id: "plan-confirm", userId: uid, requestId: "request-confirm", title: "Clipboard write",
    objective: "Write a bounded value", kind: "single_step", status: "ready", confidence: 1,
    createdAt: now, updatedAt: now, constraints: ["authorization_required"],
    expectedOutcome: "clipboard updated", failurePolicy: "stop", autonomyLevel: 1,
    version: 1, generatedBy: "deterministic", modelCallsUsed: 0,
    steps: [{
      id: "s1", index: 0, title: "clipboardWrite", description: "write clipboard",
      intent: "clipboard_write", status: "ready", dependencies: [], requiredTool: "clipboardWrite",
      arguments: { content: "hello" }, expectedOutcome: "clipboard updated", riskLevel: "medium",
      confidence: 1, retryPolicy: { maxRetries: 0 }, timeoutMs: 1_000,
    }],
  };
}

function systemPlan(uid: string): Plan {
  const value = clipboardPlan(uid);
  value.id = "plan-distributed-lease";
  value.requestId = "request-distributed-lease";
  value.title = "Read system information";
  value.steps = [{
    ...value.steps[0], id: "system-step", title: "getSystemInfo", intent: "get_system_info",
    requiredTool: "getSystemInfo", arguments: {}, expectedOutcome: "system information returned", riskLevel: "safe",
  }];
  return value;
}

beforeAll(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: fs.readFileSync(path.resolve("firestore.rules"), "utf8") },
  });
});

afterEach(async () => environment.clearFirestore());
afterAll(async () => environment.cleanup());

describe("Firestore emulator ownership rules", () => {
  it("allows each authenticated user only inside their own execution namespace", async () => {
    const alice = environment.authenticatedContext("alice").firestore();
    const bob = environment.authenticatedContext("bob").firestore();
    const guest = environment.unauthenticatedContext().firestore();
    const planPath = "users/alice/plans/p1";

    await assertSucceeds(setDoc(doc(alice, planPath), { userId: "alice", status: "ready" }));
    await assertSucceeds(getDoc(doc(alice, planPath)));
    await assertFails(getDoc(doc(bob, planPath)));
    await assertFails(getDoc(doc(guest, planPath)));
    await assertFails(setDoc(doc(bob, planPath), { userId: "bob" }));
    await assertFails(setDoc(doc(alice, "users/alice/plans/forged"), { userId: "bob" }));
  });

  it("enforces owner fields for every persisted execution artifact", async () => {
    const alice = environment.authenticatedContext("alice").firestore();
    const allowed = [
      ["users/alice/executions/r1", { uid: "alice", requestId: "r1" }],
      ["users/alice/observations/r1", { uid: "alice", requestId: "r1", observations: [] }],
      ["users/alice/idempotency/k1", { uid: "alice", key: "k1" }],
      ["users/alice/leases/p1", { uid: "alice", planId: "p1", requestId: "r1", acquiredAt: 1, expiresAt: 2, version: 1 }],
    ] as const;
    for (const [documentPath, value] of allowed) {
      await assertSucceeds(setDoc(doc(alice, documentPath), value));
      await assertFails(setDoc(doc(alice, `${documentPath}-forged`), { ...value, uid: "bob" }));
      await assertSucceeds(deleteDoc(doc(alice, documentPath)));
    }
  });

  it("enforces embedded ownership for memory, preference, model, and temporal documents", async () => {
    const alice = environment.authenticatedContext("alice").firestore();
    const cases = [
      ["users/alice/memories/m1", { metadata: { userId: "alice" }, text: "safe" }, { metadata: { userId: "bob" }, text: "forged" }],
      ["users/alice/preferences/_root", { userId: "alice" }, { userId: "bob" }],
      ["users/alice/cognitiveState/_root", { uid: "alice" }, { uid: "bob" }],
      ["users/alice/userModel/_root", { uid: "alice" }, { uid: "bob" }],
      ["users/alice/temporal/_root", { uid: "alice" }, { uid: "bob" }],
    ] as const;
    for (const [documentPath, owned, forged] of cases) {
      await assertSucceeds(setDoc(doc(alice, documentPath), owned));
      await assertFails(setDoc(doc(alice, documentPath), forged));
    }
  });

  it("allows owner reads but blocks clients from forging authoritative world state", async () => {
    const alice = environment.authenticatedContext("alice").firestore();
    const bob = environment.authenticatedContext("bob").firestore();
    await environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/alice/worldState/_root"), { uid: "alice", schemaVersion: 1, assertions: [] });
    });
    await assertSucceeds(getDoc(doc(alice, "users/alice/worldState/_root")));
    await assertFails(getDoc(doc(bob, "users/alice/worldState/_root")));
    await assertFails(setDoc(doc(alice, "users/alice/worldState/_root"), { uid: "alice", schemaVersion: 1, assertions: [{ verification: "VERIFIED" }] }));
  });

  it("allows owner reads but keeps verified learning and promotion writes server-mediated", async () => {
    const alice = environment.authenticatedContext("alice").firestore();
    const bob = environment.authenticatedContext("bob").firestore();
    const paths = [
      "users/alice/learningExperiences/e1",
      "users/alice/experienceReflections/e1",
      "users/alice/lessons/l1",
      "users/alice/decisionObservations/d1",
      "users/alice/adaptations/a1",
      "users/alice/adaptationHeads/a1",
      "users/alice/skills/s1",
      "users/alice/skillHeads/s1",
      "users/alice/skillReliability/r1",
      "users/alice/toolReliability/t1",
    ];
    await environment.withSecurityRulesDisabled(async (context) => {
      for (const documentPath of paths) await setDoc(doc(context.firestore(), documentPath), { uid: "alice" });
    });
    for (const documentPath of paths) {
      await assertSucceeds(getDoc(doc(alice, documentPath)));
      await assertFails(getDoc(doc(bob, documentPath)));
      await assertFails(setDoc(doc(alice, documentPath), { uid: "alice", forged: true }));
    }
  });

  it("allows owner session reads but blocks client checkpoint and lease forgery", async () => {
    const alice = environment.authenticatedContext("alice").firestore();
    const bob = environment.authenticatedContext("bob").firestore();
    const sessionPath = "users/alice/executionSessions/s1";
    const leasePath = "users/alice/executionSessionLeases/s1";
    await environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), sessionPath), { userId: "alice", sessionId: "s1", status: "paused" });
      await setDoc(doc(context.firestore(), leasePath), { userId: "alice", sessionId: "s1", workerId: "server" });
    });
    await assertSucceeds(getDoc(doc(alice, sessionPath)));
    await assertFails(getDoc(doc(bob, sessionPath)));
    await assertFails(setDoc(doc(alice, sessionPath), { userId: "alice", status: "completed" }));
    await assertFails(getDoc(doc(alice, leasePath)));
    await assertFails(setDoc(doc(alice, leasePath), { userId: "alice", workerId: "browser" }));
  });

  it("allows owner proposal/audit reads but blocks client verification and approval forgery", async () => {
    const alice = environment.authenticatedContext("alice").firestore();
    const bob = environment.authenticatedContext("bob").firestore();
    const paths = [
      "users/alice/codeChangeProposals/p1",
      "users/alice/codeChangeHeads/p1",
      "users/alice/codeChangeAudit/e1",
    ];
    await environment.withSecurityRulesDisabled(async (context) => {
      for (const documentPath of paths) await setDoc(doc(context.firestore(), documentPath), { uid: "alice", status: "pending_approval" });
    });
    for (const documentPath of paths) {
      await assertSucceeds(getDoc(doc(alice, documentPath)));
      await assertFails(getDoc(doc(bob, documentPath)));
      await assertFails(setDoc(doc(alice, documentPath), { uid: "alice", status: "approved", forged: true }));
    }
  });

  it("allows owner repair-history reads but blocks cross-user reads and client repair forgery", async () => {
    const alice = environment.authenticatedContext("alice").firestore();
    const bob = environment.authenticatedContext("bob").firestore();
    const paths = ["users/alice/bugIncidents/i1", "users/alice/regressionMemories/m1"];
    await environment.withSecurityRulesDisabled(async (context) => {
      for (const documentPath of paths) await setDoc(doc(context.firestore(), documentPath), { uid: "alice", status: "repaired", verifiedAt: 1 });
    });
    for (const documentPath of paths) {
      await assertSucceeds(getDoc(doc(alice, documentPath)));
      await assertFails(getDoc(doc(bob, documentPath)));
      await assertFails(setDoc(doc(alice, documentPath), { uid: "alice", status: "repaired", forged: true }));
    }
  });

  it("allows owner self-model reads but blocks cross-user reads and client health forgery", async () => {
    const alice = environment.authenticatedContext("alice").firestore();
    const bob = environment.authenticatedContext("bob").firestore();
    const documentPath = "users/alice/selfModel/_root";
    await environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), documentPath), { uid: "alice", schemaVersion: 1, capabilities: [], updatedAt: 1 });
    });
    await assertSucceeds(getDoc(doc(alice, documentPath)));
    await assertFails(getDoc(doc(bob, documentPath)));
    await assertFails(setDoc(doc(alice, documentPath), { uid: "alice", schemaVersion: 1, capabilities: [{ available: true }] }));
  });
});

describe("Firestore execution persistence", () => {
  it("transactionally persists concurrent world assertions across restart with UID isolation", async () => {
    const app = initializeApp({ projectId }, `world-${Date.now()}`);
    try {
      const db = wrapAdminFirestore(getFirestore(app));
      const first = new WorldModelService(new FirestoreWorldStateStore(db, () => undefined));
      const t = Date.now() - 1_000;
      const assertion = (uid: string, value: string, at: number) => ({
        uid, entity: { id: "application:chrome", label: "Chrome", type: "application" as const },
        relation: "STATUS", value, scope: "environment" as const, verification: "VERIFIED" as const,
        confidence: 1, observedAt: at, source: { kind: "verified_observation" as const, id: `${uid}-${at}`, evidence: value },
      });
      await Promise.all([
        first.record(assertion("alice", "OPEN", t)),
        first.record(assertion("alice", "CLOSED", t + 1)),
        first.record(assertion("bob", "OPEN", t)),
      ]);
      const restarted = new WorldModelService(new FirestoreWorldStateStore(wrapAdminFirestore(getFirestore(app)), () => undefined));
      expect((await restarted.current("alice"))[0].value).toBe("CLOSED");
      expect(await restarted.history("alice")).toHaveLength(2);
      expect(await restarted.history("bob")).toHaveLength(1);
      expect(JSON.stringify(await restarted.history("bob"))).not.toContain("alice");
    } finally {
      await deleteApp(app);
    }
  });

  it("survives repository/engine recreation, resumes confirmation once, and isolates two users", async () => {
    const app = initializeApp({ projectId }, `phase33-${Date.now()}`);
    try {
      const adminDb = getFirestore(app);
      const repository = new FirestoreExecutionRepository(wrapAdminFirestore(adminDb));
      await adminDb.doc("users/alice").set({ uid: "alice" });
      await adminDb.doc("users/bob").set({ uid: "bob" });
      const plan = clipboardPlan("alice");
      expect(await repository.savePlan("alice", plan)).toBe(true);
      expect(await repository.savePlan("bob", plan)).toBe(false);

      let calls = 0;
      const makeEngine = (store: FirestoreExecutionRepository) => new PlanExecutionEngine({
        store, planStore: store, idempotency: store, lease: store,
        toolCatalog: () => ["clipboardWrite"],
        runner: async () => { calls += 1; return { ok: true, result: "written" }; },
      });
      const waiting = await makeEngine(repository).executePlanManaged(plan, {
        userId: "alice", requestId: "request-confirm",
      });
      expect(waiting.recordStatus).toBe("awaiting_confirmation");
      expect(calls).toBe(0);

      const restarted = new FirestoreExecutionRepository(wrapAdminFirestore(getFirestore(app)));
      const resumed = await makeEngine(restarted).executePlanManaged(plan, {
        userId: "alice", requestId: "request-confirm", confirmed: true,
      });
      expect(resumed.recordStatus).toBe("completed");
      expect(calls).toBe(1);
      const replay = await makeEngine(restarted).executePlanManaged(plan, {
        userId: "alice", requestId: "request-confirm", confirmed: true,
      });
      expect(replay.idempotent).toBe(true);
      expect(calls).toBe(1);
      expect(await restarted.getExecution("bob", "request-confirm")).toBeNull();
      expect(await restarted.listUserIds()).toEqual(expect.arrayContaining(["alice", "bob"]));

      // The same emulator-backed namespace also round-trips the existing
      // Temporal/UserModel/Goal stores across object recreation.
      const userStore = new FirestoreUserStoreImpl({ db: wrapAdminFirestore(adminDb), log: () => undefined });
      expect(await userStore.setTemporalState("alice", { uid: "alice", events: [{ type: "task_completed" }] })).toBe(true);
      expect(await userStore.setModelBundle("alice", { uid: "alice", bundle: { activeProject: "LOHZ" }, updatedAt: Date.now() })).toBe(true);
      expect(await userStore.putGoal("alice", { id: "g1", title: "Ship", description: "Ship safely", status: "active", createdAt: 1, updatedAt: 1 })).toBe(true);
      expect(await userStore.setTemporalState("bob", { uid: "alice", events: [] })).toBe(false);
      expect(await userStore.setModelBundle("bob", { uid: "alice", bundle: {}, updatedAt: 1 })).toBe(false);

      const restartedUserStore = new FirestoreUserStoreImpl({ db: wrapAdminFirestore(getFirestore(app)), log: () => undefined });
      expect((await restartedUserStore.getTemporalState("alice"))?.uid).toBe("alice");
      expect((await restartedUserStore.getModelBundle("alice"))?.bundle).toEqual({ activeProject: "LOHZ" });
      expect((await restartedUserStore.listGoals("alice"))?.map((goal) => goal.id)).toEqual(["g1"]);
      expect(await restartedUserStore.getTemporalState("bob")).toBeNull();
    } finally {
      await deleteApp(app);
    }
  });

  it("transactionally suppresses one plan across independent server repositories", async () => {
    const app = initializeApp({ projectId }, `lease-${Date.now()}`);
    try {
      const firstStore = new FirestoreExecutionRepository(wrapAdminFirestore(getFirestore(app)));
      const secondStore = new FirestoreExecutionRepository(wrapAdminFirestore(getFirestore(app)));
      const plan = systemPlan("alice");
      await getFirestore(app).doc("users/alice").set({ uid: "alice" });
      expect(await firstStore.savePlan("alice", plan)).toBe(true);
      let calls = 0;
      const build = (store: FirestoreExecutionRepository) => new PlanExecutionEngine({
        store, planStore: store, idempotency: store, lease: store,
        toolCatalog: () => ["getSystemInfo"],
        runner: async () => {
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { ok: true, result: "system" };
        },
      });

      const [first, second] = await Promise.all([
        build(firstStore).executePlan(plan, { userId: "alice", requestId: "server-a" }),
        build(secondStore).executePlan(plan, { userId: "alice", requestId: "server-b" }),
      ]);

      expect(calls).toBe(1);
      expect([first.recordStatus, second.recordStatus]).toContain("completed");
      expect([first.recordStatus, second.recordStatus].every((status) => status === "completed" || status === "rejected")).toBe(true);
    } finally {
      await deleteApp(app);
    }
  });

  it("transactionally grants one fenced Phase 41 session lease across servers", async () => {
    const app = initializeApp({ projectId }, `session-lease-${Date.now()}`);
    try {
      const now = Date.now();
      const db = wrapAdminFirestore(getFirestore(app));
      const first = new FirestoreExecutionSessionStore(db, () => now, () => undefined);
      const second = new FirestoreExecutionSessionStore(wrapAdminFirestore(getFirestore(app)), () => now, () => undefined);
      const session: ExecutionSession = {
        sessionId: "session-41", userId: "alice", objective: "verify build", objectiveDigest: "digest",
        planId: "plan-41", planVersion: 1, requestId: "request-41", status: "created",
        currentCheckpoint: null, checkpoints: [],
        authorizationScope: { grantId: "grant", grantedBy: "authenticated_user", grantedAt: now, expiresAt: now + 10_000,
          objectiveDigest: "digest", planId: "plan-41", planVersion: 1, allowedTools: ["getSystemInfo"], maxRisk: "safe", confirmed: false, revokedAt: null },
        createdAt: now, updatedAt: now, timeoutAt: now + 60_000, nextAction: "run", interruptionReason: null, failure: null, version: 1,
      };
      expect(await first.createSession(session)).toBe(true);
      const leases = await Promise.all([
        first.acquireSessionLease("alice", session.sessionId, "server-a", 5_000),
        second.acquireSessionLease("alice", session.sessionId, "server-b", 5_000),
      ]);
      expect(leases.filter(Boolean)).toHaveLength(1);
      expect(leases.find(Boolean)?.fencingToken).toBe(1);
    } finally {
      await deleteApp(app);
    }
  });
});
