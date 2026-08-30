import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  UserModelEngine,
  classifyPreferenceKey,
  type ModelOutcome,
  type UserModelPersistence,
} from "./engine";
import {
  createUserModelBundle,
  USER_MODEL_LIMITS,
  USER_MODEL_SCHEMA_VERSION,
} from "./types";
import { FirestoreUserStoreImpl } from "../persistence/firestoreUserStore";
import { MockFirestore } from "../persistence/mockFirestore";
import type { UserModelBundle } from "./types";

// ── Test persistence: in-memory map with failure injection ──

class MemoryPersistence implements UserModelPersistence {
  public store = new Map<string, UserModelBundle>();
  public failSave = false;
  public failLoad = false;
  saved: string[] = [];

  async load(uid: string): Promise<UserModelBundle | null> {
    if (this.failLoad) throw new Error("load down");
    return this.store.get(uid) ?? null;
  }
  async save(uid: string, bundle: UserModelBundle): Promise<boolean> {
    if (this.failSave) return false;
    this.store.set(uid, JSON.parse(JSON.stringify(bundle)));
    this.saved.push(uid);
    return true;
  }
}

function outcome(overrides: Partial<ModelOutcome> = {}): ModelOutcome {
  return { kind: "preference", text: "I prefer short answers", memoryId: "m1", ...overrides };
}

describe("UserModelEngine", () => {
  let p: MemoryPersistence;
  let engine: UserModelEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    p = new MemoryPersistence();
    engine = new UserModelEngine(p, { debounceMs: 1000 });
  });

  afterEach(() => {
    engine.dispose();
    vi.useRealTimers();
  });

  async function settledFlush(): Promise<void> {
    await engine.flushAll();
    await vi.advanceTimersByTimeAsync(0);
  }

  it("creates a default bundle on first load", async () => {
    const m = await engine.load("u1");
    expect(m.uid).toBe("u1");
    expect(m.schemaVersion).toBe(USER_MODEL_SCHEMA_VERSION);
    expect(m.projects).toEqual([]);
    expect(m.world.recentEvents).toEqual([]);
    expect(m.createdAt).toBeGreaterThan(0);
  });

  it("explicit preference → confirmed, high confidence, evidence reference", async () => {
    await engine.applyMemoryOutcome("u1", outcome({ text: "Keep your answers short", memoryId: "mem-9" }));
    const m = await engine.load("u1");
    const slot = m.preferences.responseLength;
    expect(slot).toBeDefined();
    expect(slot.current.state).toBe("confirmed");
    expect(slot.current.source).toBe("explicit");
    expect(slot.current.confidence).toBeGreaterThanOrEqual(0.9);
    expect(slot.current.evidenceMemoryIds).toContain("mem-9");
  });

  it("preference change supersedes and preserves history (current vs previous)", async () => {
    await engine.applyMemoryOutcome("u1", outcome({ text: "Give me long detailed answers", memoryId: "mA" }));
    await engine.applyMemoryOutcome(
      "u1",
      outcome({ text: "Actually keep your answers short.", memoryId: "mB", isCorrection: true })
    );

    const m = await engine.load("u1");
    const slot = m.preferences.responseLength;
    expect(slot.current.value.toLowerCase()).toContain("short");
    expect(slot.current.state).toBe("updated");
    expect(slot.previous).toHaveLength(1);
    expect(slot.previous[0].value.toLowerCase()).toContain("long");
    expect(slot.previous[0].reason).toBe("explicit user correction");
    expect(slot.previous[0].evidenceMemoryIds).toContain("mA");
    expect(slot.current.evidenceMemoryIds).toContain("mB");
  });

  it("same-value reinforcement raises confidence but never duplicates history", async () => {
    await engine.applyMemoryOutcome("u1", outcome({ text: "prefer concise answers", confidence: 0.8 }));
    const before = (await engine.load("u1")).preferences.responseLength.current.confidence;
    await engine.applyMemoryOutcome("u1", outcome({ text: "prefer concise answers", confidence: 0.8 }));
    const slot = (await engine.load("u1")).preferences.responseLength;
    expect(slot.current.confidence).toBeGreaterThan(before);
    expect(slot.previous).toHaveLength(0);
  });

  it("ambiguous overlapping evidence marks conflicted instead of overwriting", async () => {
    await engine.applyMemoryOutcome("u1", outcome({ text: "prefer technical documentation with diagrams" }));
    const r = await engine.applyMemoryOutcome(
      "u1",
      outcome({ text: "prefer technical tutorials with diagrams", source: "derived", confidence: 0.55 })
    );
    expect(r.reason).toContain("conflicted");
    expect((await engine.load("u1")).preferences.style.current.state).toBe("conflicted");
  });

  it("classifyPreferenceKey maps to a bounded namespace", () => {
    expect(classifyPreferenceKey("keep answers brief")).toBe("responseLength");
    expect(classifyPreferenceKey("speak up more proactively")).toBe("proactivity");
    expect(classifyPreferenceKey("be more casual please")).toBe("style");
    expect(classifyPreferenceKey("random statement")).toBe("general");
  });

  it("identity attributes set, reinforce, and mark conflict without blind overwrite", async () => {
    await engine.applyMemoryOutcome("u1", outcome({ kind: "identity", text: "Priya Sharma", memoryId: "i1" }));
    let m = await engine.load("u1");
    expect(m.identity.name.value).toBe("Priya Sharma");

    await engine.applyMemoryOutcome("u1", outcome({ kind: "identity", text: "Priya Sharma", memoryId: "i2" }));
    m = await engine.load("u1");
    expect(m.identity.name.confidence).toBeGreaterThanOrEqual(0.9);

    const r = await engine.applyMemoryOutcome("u1", outcome({ kind: "identity", text: "Completely Different Name Here", memoryId: "i3" }));
    expect(r.reason).toContain("conflict");
    expect((await engine.load("u1")).identity.name.state).toBe("conflicted");
    // Original value preserved — no blind overwrite
    expect((await engine.load("u1")).identity.name.value).toBe("Priya Sharma");
  });

  it("projects upsert, support multiple simultaneous projects, statuses", async () => {
    vi.setSystemTime(1_000);
    await engine.applyMemoryOutcome("u1", outcome({ kind: "project", text: "working on Aurora Dashboard migration", memoryId: "p1" }));
    vi.setSystemTime(2_000); // later activity → becomes the active focus
    await engine.applyMemoryOutcome("u1", outcome({ kind: "project", text: "working on Beacon API rewrite", memoryId: "p2" }));

    let m = await engine.load("u1");
    expect(m.projects.map((x) => x.key).sort()).toEqual(["aurora-dashboard-migration", "beacon-api-rewrite"]);
    expect(m.world.activeProjectKey).toBe("beacon-api-rewrite"); // most recent

    const r = engine.setProjectStatus("u1", "Aurora Dashboard migration", "paused");
    expect(r.applied).toBe(true);
    m = await engine.load("u1");
    expect(m.projects.find((x) => x.key === "aurora-dashboard-migration")!.status).toBe("paused");

    engine.setProjectStatus("u1", "Beacon API rewrite", "completed");
    m = await engine.load("u1");
    expect(m.projects.find((x) => x.key === "beacon-api-rewrite")!.status).toBe("completed");
  });

  it("goal references stay bounded and mirror into world state", async () => {
    await engine.load("u1");
    for (let i = 0; i < 15; i++) {
      engine.syncGoalRefs("u1", Array.from({ length: i + 1 }, (_, j) => `g${j}`));
    }
    const m = engine.peekCached("u1")!;
    expect(m.activeGoalIds.length).toBeLessThanOrEqual(USER_MODEL_LIMITS.activeGoalIds);
    expect(m.activeGoalIds[m.activeGoalIds.length - 1]).toBe(`g${USER_MODEL_LIMITS.activeGoalIds - 1}`);
    expect(m.world.activeGoalIds).toEqual(m.activeGoalIds);
  });

  it("project evidence references are bounded", async () => {
    const memIds = Array.from({ length: 20 }, (_, i) => `pm${i}`);
    for (const id of memIds) {
      await engine.applyMemoryOutcome("u1", outcome({ kind: "project", text: "working on Zephyr CLI", memoryId: id }));
    }
    const project = (await engine.load("u1")).projects.find((x) => x.key === "zephyr-cli")!;
    expect(project.relatedMemoryIds.length).toBeLessThanOrEqual(USER_MODEL_LIMITS.relatedMemoryIdsPerProject);
  });

  it("stale projects lose confidence, get flagged, and reactivate on evidence", async () => {
    vi.setSystemTime(0);
    await engine.applyMemoryOutcome("u1", outcome({ kind: "project", text: "working on Old Saga" }));
    const fresh = (await engine.load("u1")).projects[0];
    const confBefore = fresh.confidence;

    vi.setSystemTime(30 * 24 * 3600 * 1000); // +30 days
    const staleCount = engine.markStale("u1");
    expect(staleCount).toBe(1);
    let project = (await engine.load("u1")).projects[0];
    expect(project.stale).toBe(true);
    expect(project.confidence).toBeLessThan(confBefore);

    // Reactivation by new evidence — not deletion (§13)
    const beforeCount = (await engine.load("u1")).projects.length;
    await engine.applyMemoryOutcome("u1", outcome({ kind: "project", text: "working on Old Saga", memoryId: "revive" }));
    project = (await engine.load("u1")).projects[0];
    expect((await engine.load("u1")).projects.length).toBe(beforeCount); // no duplicate project row
    expect(project.stale).toBe(false);
    expect(project.status).toBe("active");
    expect(project.relatedMemoryIds).toContain("revive");
  });

  it("world observation updates bounded ring + time context", async () => {
    await engine.load("u1");
    for (let i = 0; i < 15; i++) {
      engine.observeWorld("u1", { eventText: `event number ${i}`, eventKind: "tool_result", interactionMode: "text", pendingTaskCount: i });
    }
    const w = (await engine.load("u1")).world;
    expect(w.recentEvents.length).toBeLessThanOrEqual(USER_MODEL_LIMITS.recentEvents);
    expect(w.interactionMode).toBe("text");
    expect(w.pendingTaskCount).toBe(14);
    expect(w.timeContext.recordedAt).toBeGreaterThan(0);
    // oldest evicted
    expect(w.recentEvents.some((e) => e.text.includes("event number 0"))).toBe(false);
    expect(w.recentEvents.some((e) => e.text.includes("event number 14"))).toBe(true);
  });

  it("privacy denylist blocks sensitive topics from the derived model", async () => {
    const r1 = await engine.applyMemoryOutcome("u1", outcome({ kind: "interest", text: "user follows a political party closely" }));
    const r2 = await engine.applyMemoryOutcome("u1", outcome({ kind: "identity", text: "user manages diabetes medication daily" }));
    expect(r1.applied).toBe(false);
    expect(r2.applied).toBe(false);
    const m = await engine.load("u1");
    expect(m.interests).toHaveLength(0);
    expect(Object.keys(m.identity)).toHaveLength(0);
  });

  it("bounded model size: preferences/interests/projects all trim", async () => {
    for (let i = 0; i < 30; i++) {
      await engine.applyMemoryOutcome("u1", outcome({
        kind: "preference",
        text: `availability preference variant ${i}`,
        confidence: 0.95,
      }));
    }
    for (let i = 0; i < 20; i++) {
      await engine.applyMemoryOutcome("u1", outcome({ kind: "interest", text: `unique interest topic ${i}` }));
    }
    for (let i = 0; i < 12; i++) {
      await engine.applyMemoryOutcome("u1", outcome({ kind: "project", text: `working on Project Alpha ${i}`, priorityHint: i } as never));
    }
    const m = await engine.load("u1");
    expect(Object.keys(m.preferences).length).toBeLessThanOrEqual(USER_MODEL_LIMITS.preferenceKeys);
    expect(m.interests.length).toBeLessThanOrEqual(USER_MODEL_LIMITS.interests);
    expect(m.projects.length).toBeLessThanOrEqual(USER_MODEL_LIMITS.projects);
  });

  describe("debounced persistence", () => {
    it("coalesces rapid updates into one save after debounce window", async () => {
      await engine.load("u2");
      engine.syncGoalRefs("u2", ["g1"]);
      engine.syncGoalRefs("u2", ["g1", "g2"]);
      engine.syncGoalRefs("u2", ["g1", "g2", "g3"]);
      expect(p.saved.filter((u) => u === "u2")).toHaveLength(0); // nothing yet

      await vi.advanceTimersByTimeAsync(1100);
      expect(p.saved.filter((u) => u === "u2")).toHaveLength(1); // coalesced

      // further flushes are no-ops when clean
      await engine.flushAll();
      expect(p.saved.filter((u) => u === "u2")).toHaveLength(1);
    });

    it("manual flush persists immediately and clears dirty flag", async () => {
      await engine.load("u3");
      engine.syncGoalRefs("u3", ["gx"]);
      const ok = await engine.flush("u3");
      expect(ok).toBe(true);
      expect(p.store.get("u3")!.activeGoalIds).toEqual(["gx"]);
    });
  });

  describe("restart recovery", () => {
    it("persisted state round-trips exactly through a recreated engine", async () => {
      await engine.applyMemoryOutcome("r1", outcome({ kind: "preference", text: "prefer short answers", memoryId: "m1" }));
      await engine.applyMemoryOutcome("r1", outcome({ kind: "project", text: "working on Nova Engine", memoryId: "m2" }));
      engine.observeWorld("r1", { activity: "coding", interactionMode: "voice" });
      await engine.flush("r1");

      const persistedSnapshot = JSON.parse(JSON.stringify(p.store.get("r1")));

      const engine2 = new UserModelEngine(p, { debounceMs: 1000 });
      const reloaded = await engine2.load("r1");
      expect(JSON.parse(JSON.stringify(reloaded))).toEqual(persistedSnapshot);
      expect(reloaded.preferences.responseLength.current.evidenceMemoryIds).toContain("m1");
      expect(reloaded.projects[0].displayName).toBe("Nova Engine");
      engine2.dispose();
    });
  });

  describe("failure handling", () => {
    it("save failure retains in-memory state and flags error; retry succeeds later", async () => {
      p.failSave = true;
      await engine.load("f1");
      engine.syncGoalRefs("f1", ["g1"]);
      const okFirst = await engine.flush("f1");
      expect(okFirst).toBe(false);
      expect(engine.lastPersistError.has("f1")).toBe(true);
      // In-memory state intact
      expect(engine.peekCached("f1")!.activeGoalIds).toEqual(["g1"]);

      p.failSave = false;
      const okRetry = await engine.flush("f1"); // still dirty → retried
      expect(okRetry).toBe(true);
      expect(engine.lastPersistError.has("f1")).toBe(false);
      expect(p.store.get("f1")!.activeGoalIds).toEqual(["g1"]);
    });

    it("load failure falls back to a fresh empty model (never fabricates)", async () => {
      p.failLoad = true;
      const m = await engine.load("f2");
      expect(m.preferences).toEqual({});
      expect(m.projects).toEqual([]);
    });
  });

  describe("multi-user isolation (A / B / C)", () => {
    it("keeps models fully independent; cross-user writes impossible", async () => {
      await engine.applyMemoryOutcome("userA", outcome({ kind: "preference", text: "prefer short answers", memoryId: "a-mem" }));
      await engine.applyMemoryOutcome("userB", outcome({ kind: "preference", text: "prefer long detailed answers", memoryId: "b-mem" }));
      await engine.applyMemoryOutcome("userC", outcome({ kind: "project", text: "working on Cirrus Stack", memoryId: "c-mem" }));

      const a = await engine.load("userA");
      const b = await engine.load("userB");
      const c = await engine.load("userC");

      expect(a.preferences.responseLength.current.value.toLowerCase()).toContain("short");
      expect(b.preferences.responseLength.current.value.toLowerCase()).not.toContain("short");
      expect(a.projects).toHaveLength(0);
      expect(c.projects.map((x) => x.key)).toEqual(["cirrus-stack"]);

      // A's evidence never appears in B or C
      const bJson = JSON.stringify(b);
      const cJson = JSON.stringify(c);
      expect(bJson).not.toContain("a-mem");
      expect(cJson).not.toContain("a-mem");
      expect(bJson).not.toContain("cirrus");

      // Mutating A repeatedly leaves B/C untouched snapshots
      const beforeB = JSON.stringify(b);
      const beforeC = JSON.stringify(c);
      for (let i = 0; i < 5; i++) {
        await engine.applyMemoryOutcome("userA", outcome({ kind: "preference", text: `style tweak pass ${i}` }));
      }
      expect(JSON.stringify(await engine.load("userB"))).toBe(beforeB);
      expect(JSON.stringify(await engine.load("userC"))).toBe(beforeC);
    });
  });
});

describe("UserModel via FirestoreUserStore (mock backend)", () => {
  it("bundle round-trips through Firestore and fails safely when down", async () => {
    const db = new MockFirestore();
    const store = new FirestoreUserStoreImpl({ db, log: () => undefined });

    const uid = "fs-user-24";
    const bundle = createUserModelBundle(uid);
    bundle.identity.name = {
      value: "Test User",
      confidence: 0.95,
      state: "confirmed",
      temporalStatus: "current",
      source: "explicit",
      updatedAt: Date.now(),
      evidenceMemoryIds: ["e1"],
    };
    expect(await store.setModelBundle(uid, { uid, bundle, updatedAt: Date.now() })).toBe(true);

    const back = await store.getModelBundle(uid);
    expect(back).not.toBeNull();
    expect(back!.uid).toBe(uid);
    expect((back!.bundle as UserModelBundle).identity.name.value).toBe("Test User");

    // Foreign record refusal
    expect(await store.getModelBundle("someone-else")).toBeNull();

    // Outage → null/false, never throws
    db.failureMode = new Error("down");
    expect(await store.getModelBundle(uid)).toBeNull();
    expect(await store.setModelBundle(uid, { uid, bundle, updatedAt: Date.now() })).toBe(false);

    db.failureMode = null;
    expect(await store.getModelBundle(uid)).not.toBeNull();
  });
});
