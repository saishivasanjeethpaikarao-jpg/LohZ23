import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockFirestore } from "../persistence/mockFirestore";
import { FirestoreExecutionSessionStore } from "./firestoreSessionStore";
import { LocalExecutionSessionStore } from "./localSessionStore";
import { ExecutionSessionCoordinator, type SessionRunResult } from "./sessionCoordinator";
import { InMemoryExecutionSessionStore, type ExecutionSessionStore } from "./sessionStore";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function baseInput(now: number) {
  return {
    userId: "user-a", objective: "Prepare the project and verify the build", planId: "plan-1", planVersion: 1,
    requestId: "request-1", allowedTools: ["readFile", "openApp"], maxRisk: "low" as const,
    authorizationTtlMs: 10_000, sessionTimeoutMs: 60_000, nextAction: "run tests", _now: now,
  };
}

function coordinator(store: ExecutionSessionStore, options: {
  now?: () => number;
  verify?: (stale: boolean) => "VERIFIED" | "FAILED" | "INCONCLUSIVE";
  run?: (control: Parameters<ConstructorParameters<typeof ExecutionSessionCoordinator>[0]["run"]>[1]) => Promise<SessionRunResult>;
} = {}) {
  return new ExecutionSessionCoordinator({
    store, now: options.now,
    leaseTtlMs: 1_000, checkpointMaxAgeMs: 1_000,
    verifyResume: async (_session, input) => ({ status: options.verify?.(input.checkpointStale) ?? "VERIFIED", reason: "state checked", worldStateToken: "world-v1" }),
    run: async (_session, control) => options.run?.(control) ?? ({
      status: "completed", reason: "build verified", completedStepIds: ["s1"], executionRecordVersion: 2,
      verificationStatus: "VERIFIED", worldStateToken: "world-v2",
    }),
  });
}

describe("Phase 41 durable execution sessions", () => {
  it("survives process restart through the local durable store", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lohz-phase41-")); tempDirs.push(dir);
    const first = coordinator(new LocalExecutionSessionStore(dir));
    const created = await first.create(baseInput(Date.now()));
    expect(created).not.toBeNull();

    const afterRestart = coordinator(new LocalExecutionSessionStore(dir));
    expect((await afterRestart.get("user-a", created!.sessionId))?.objective).toContain("Prepare");
    const result = await afterRestart.resume("user-a", created!.sessionId, "worker-after-restart");
    expect(result.session?.status).toBe("completed");
    expect(result.session?.currentCheckpoint?.verificationStatus).toBe("VERIFIED");
  });

  it("allows only one of two distributed workers to acquire the Firestore lease", async () => {
    const store = new FirestoreExecutionSessionStore(new MockFirestore(), Date.now, () => undefined);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runs = vi.fn(async () => {
      await gate;
      return { status: "completed", reason: "done", verificationStatus: "VERIFIED" } as SessionRunResult;
    });
    const a = coordinator(store, { run: runs });
    const b = coordinator(store, { run: runs });
    const session = await a.create(baseInput(Date.now()));
    const first = a.resume("user-a", session!.sessionId, "worker-a");
    await vi.waitFor(() => expect(runs).toHaveBeenCalledTimes(1));
    const duplicate = await b.resume("user-a", session!.sessionId, "worker-b");
    expect(duplicate.code).toBe("lease_unavailable");
    release();
    expect((await first).session?.status).toBe("completed");
    expect(runs).toHaveBeenCalledTimes(1);
  });

  it("serializes a direct lease race in the Firestore test backend", async () => {
    const store = new FirestoreExecutionSessionStore(new MockFirestore(), Date.now, () => undefined);
    const service = coordinator(store);
    const session = await service.create(baseInput(Date.now()));
    const leases = await Promise.all([
      store.acquireSessionLease("user-a", session!.sessionId, "worker-a", 1_000),
      store.acquireSessionLease("user-a", session!.sessionId, "worker-b", 1_000),
    ]);
    expect(leases.filter(Boolean)).toHaveLength(1);
  });

  it("rejects an expired grant and resumes only after explicit reauthorization", async () => {
    let now = 1_000;
    const store = new InMemoryExecutionSessionStore(() => now);
    const service = coordinator(store, { now: () => now });
    const session = await service.create({ ...baseInput(now), authorizationTtlMs: 1_000 });
    now = 2_001;
    const expired = await service.resume("user-a", session!.sessionId, "worker-a");
    expect(expired.code).toBe("reauthorization_required");
    expect(expired.session?.status).toBe("awaiting_reauthorization");
    const renewed = await service.reauthorize({
      userId: "user-a", sessionId: session!.sessionId, planId: "plan-1", planVersion: 1,
      allowedTools: ["readFile", "openApp"], maxRisk: "low", authorizationTtlMs: 5_000,
    });
    expect(renewed?.authorizationScope.grantId).not.toBe(session!.authorizationScope.grantId);
    expect((await service.resume("user-a", session!.sessionId, "worker-b")).session?.status).toBe("completed");
  });

  it("does not let a running worker overwrite cancellation", async () => {
    const store = new InMemoryExecutionSessionStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = coordinator(store, { run: async () => {
      await gate;
      return { status: "completed", reason: "late result", verificationStatus: "VERIFIED" };
    } });
    const session = await service.create(baseInput(Date.now()));
    const running = service.resume("user-a", session!.sessionId, "worker-a");
    await vi.waitFor(async () => expect((await service.get("user-a", session!.sessionId))?.status).toBe("running"));
    expect(await service.cancel("user-a", session!.sessionId)).toBe(true);
    release();
    const result = await running;
    expect(result.code).toBe("interrupted");
    expect((await service.get("user-a", session!.sessionId))?.status).toBe("cancelled");
  });

  it("supports an explicit pause followed by a newly verified resume", async () => {
    const service = coordinator(new InMemoryExecutionSessionStore());
    const session = await service.create(baseInput(Date.now()));
    expect(await service.pause("user-a", session!.sessionId, "user needs a break")).toBe(true);
    expect((await service.get("user-a", session!.sessionId))?.status).toBe("paused");
    expect((await service.resume("user-a", session!.sessionId, "worker-resume")).session?.status).toBe("completed");
  });

  it("persists partial completion and safely continues from its checkpoint", async () => {
    const store = new InMemoryExecutionSessionStore();
    let attempt = 0;
    const service = coordinator(store, { run: async () => {
      attempt += 1;
      return attempt === 1
        ? { status: "partial", reason: "provider outage", interruption: "provider_outage", completedStepIds: ["s1"], verificationStatus: "VERIFIED", nextAction: "run s2" }
        : { status: "completed", reason: "s2 verified", completedStepIds: ["s1", "s2"], verificationStatus: "VERIFIED" };
    } });
    const session = await service.create(baseInput(Date.now()));
    const partial = await service.resume("user-a", session!.sessionId, "worker-a");
    expect(partial.session?.status).toBe("paused");
    expect(partial.session?.currentCheckpoint?.completedStepIds).toEqual(["s1"]);
    const recovered = await service.resume("user-a", session!.sessionId, "worker-b");
    expect(recovered.session?.status).toBe("completed");
    expect(recovered.session?.checkpoints).toHaveLength(2);
  });

  it("refuses stale checkpoints when state verification is inconclusive", async () => {
    let now = 1_000;
    const store = new InMemoryExecutionSessionStore(() => now);
    let runCount = 0;
    const service = coordinator(store, {
      now: () => now,
      verify: (stale) => stale ? "INCONCLUSIVE" : "VERIFIED",
      run: async () => { runCount += 1; return { status: "partial", reason: "pause", verificationStatus: "VERIFIED" }; },
    });
    const session = await service.create(baseInput(now));
    await service.resume("user-a", session!.sessionId, "worker-a");
    now += 1_001;
    const stale = await service.resume("user-a", session!.sessionId, "worker-b");
    expect(stale.code).toBe("verification_inconclusive");
    expect(stale.session?.status).toBe("paused");
    expect(runCount).toBe(1);
  });

  it("isolates sessions by authenticated user", async () => {
    const service = coordinator(new InMemoryExecutionSessionStore());
    const session = await service.create(baseInput(Date.now()));
    expect(await service.get("user-b", session!.sessionId)).toBeNull();
    expect((await service.resume("user-b", session!.sessionId, "worker-b")).code).toBe("lease_unavailable");
    expect(await service.cancel("user-b", session!.sessionId)).toBe(false);
  });

  it("uses fencing tokens so an expired worker cannot write after takeover", async () => {
    let now = 1_000;
    const store = new InMemoryExecutionSessionStore(() => now);
    const service = coordinator(store, { now: () => now });
    const session = await service.create(baseInput(now));
    const oldLease = await store.acquireSessionLease("user-a", session!.sessionId, "old", 1_000);
    now = 2_001;
    const newLease = await store.acquireSessionLease("user-a", session!.sessionId, "new", 1_000);
    expect(newLease!.fencingToken).toBeGreaterThan(oldLease!.fencingToken);
    const current = await store.getSession("user-a", session!.sessionId);
    const staleWrite = { ...current!, status: "completed" as const, version: current!.version + 1 };
    expect(await store.compareAndSetSession(staleWrite, current!.version, oldLease!)).toBe(false);
  });

  it("renews the distributed lease while a long runner is active", async () => {
    const store = new InMemoryExecutionSessionStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = coordinator(store, { run: async () => {
      await gate;
      return { status: "completed", reason: "long task done", verificationStatus: "VERIFIED" };
    } });
    const session = await service.create(baseInput(Date.now()));
    const running = service.resume("user-a", session!.sessionId, "long-worker");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await store.acquireSessionLease("user-a", session!.sessionId, "duplicate", 1_000)).toBeNull();
    release();
    expect((await running).session?.status).toBe("completed");
  });

  it("persists a terminal failure and never silently retries it", async () => {
    const run = vi.fn(async () => ({ status: "failed" as const, reason: "verification mismatch", failureCode: "state_mismatch", retryable: false, verificationStatus: "FAILED" as const }));
    const service = coordinator(new InMemoryExecutionSessionStore(), { run });
    const session = await service.create(baseInput(Date.now()));
    expect((await service.resume("user-a", session!.sessionId, "worker-a")).session?.failure?.code).toBe("state_mismatch");
    expect((await service.resume("user-a", session!.sessionId, "worker-b")).code).toBe("terminal");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("times out durably without invoking the runner", async () => {
    let now = 1_000;
    const run = vi.fn(async () => ({ status: "completed" as const, reason: "done", verificationStatus: "VERIFIED" as const }));
    const store = new InMemoryExecutionSessionStore(() => now);
    const service = coordinator(store, { now: () => now, run });
    const session = await service.create({ ...baseInput(now), sessionTimeoutMs: 60_000 });
    now = 61_001;
    const result = await service.resume("user-a", session!.sessionId, "worker-a");
    expect(result.session?.status).toBe("timed_out");
    expect(run).not.toHaveBeenCalled();
  });
});
