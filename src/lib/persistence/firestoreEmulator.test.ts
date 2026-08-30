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
    ] as const;
    for (const [documentPath, value] of allowed) {
      await assertSucceeds(setDoc(doc(alice, documentPath), value));
      await assertFails(setDoc(doc(alice, `${documentPath}-forged`), { ...value, uid: "bob" }));
      await assertSucceeds(deleteDoc(doc(alice, documentPath)));
    }
  });
});

describe("Firestore execution persistence", () => {
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
        store, planStore: store, idempotency: store,
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
});
