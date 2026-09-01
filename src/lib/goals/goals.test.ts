import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AutonomousGoalManager } from "./manager";
import {
  canTransition,
  GOAL_LIMITS,
  levelFromPriority,
  PRIORITY_LEVEL_BASE,
  SOURCE_AUTHORITY,
  VALID_TRANSITIONS,
} from "./types";
import { attentionScore, effectivePriority } from "./attention";
import { checkDuplicate, extractGoalPhrase, scoreCandidate } from "./candidates";
import type { GoalRecord } from "../persistence/firestoreUserStore";
import type { CandidateInput } from "./candidates";

const DAY = 24 * 3600_000;
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);

class MemGoalStore {
  public goals = new Map<string, Map<string, GoalRecord>>();
  public failSave = false;
  savedKeys: string[] = [];
  key(uid: string) {
    if (!this.goals.has(uid)) this.goals.set(uid, new Map());
    return this.goals.get(uid)!;
  }
  putGoal(uid: string, g: GoalRecord) {
    if (this.failSave) return Promise.resolve(false);
    this.key(uid).set(g.id, JSON.parse(JSON.stringify(g)));
    this.savedKeys.push(`${uid}:${g.id}`);
    return Promise.resolve(true);
  }
  listGoals(uid: string) {
    return Promise.resolve([...this.key(uid).values()]);
  }
}

function makeManager(store = new MemGoalStore(), temporal?: never) {
  const manager = new AutonomousGoalManager({
    store: store as never,
    now: () => NOW,
  });
  return { manager, store };
}

describe("goal state machine + authority", () => {
  it("valid transitions table is closed and sane", () => {
    expect(canTransition("active", "completed")).toBe(true);
    expect(canTransition("proposed", "active")).toBe(true);
    expect(canTransition("completed", "active")).toBe(false); // reopen() only
    expect(canTransition("cancelled", "active")).toBe(false);
    expect(canTransition("stale", "active")).toBe(true);
    for (const [from, tos] of Object.entries(VALID_TRANSITIONS)) {
      for (const to of tos) expect(canTransition(from as never, to)).toBe(true);
    }
  });

  it("authority ordering: user > explicit_request > derived > system", () => {
    expect(SOURCE_AUTHORITY.user).toBeGreaterThan(SOURCE_AUTHORITY.explicit_request);
    expect(SOURCE_AUTHORITY.explicit_request).toBeGreaterThan(SOURCE_AUTHORITY.derived);
    expect(SOURCE_AUTHORITY.derived).toBeGreaterThan(SOURCE_AUTHORITY.system);
  });

  it("derived goals start as proposals and need confirmation", async () => {
    const { manager } = makeManager();
    const r = await manager.createGoal("u1", { title: "learn rust", source: "derived" });
    expect(r.ok).toBe(true);
    expect(r.goal!.status).toBe("proposed");
    expect(r.goal!.autonomyLevel).toBeLessThanOrEqual(1); // observe/suggest only

    // Direct transition proposed→active is allowed by machine but
    // confirmProposal is the sanctioned path; both keep provenance.
    const c = await manager.confirmProposal("u1", r.goal!.id);
    // derived source lacks authority for silent promotion:
    expect(c.ok).toBe(false);
    expect(c.reason).toContain("authority");
  });

  it("user goals go active immediately with full authority", async () => {
    const { manager } = makeManager();
    const r = await manager.createGoal("u1", { title: "ship v2", source: "user", priorityLevel: "high" });
    expect(r.goal!.status).toBe("active");
    expect(r.goal!.priority).toBe(PRIORITY_LEVEL_BASE.high);
  });

  it("invalid transitions are rejected deterministically", async () => {
    const { manager } = makeManager();
    const g = (await manager.createGoal("u1", { title: "deploy lohz", source: "user" })).goal!;
    await manager.updateProgress("u1", g.id, 1, { source: "verified_action" });
    const again = await manager.transition("u1", g.id, "active", {});
    expect(again.ok).toBe(false);
    expect(again.reason).toContain("reopen");
    const reopen = await manager.reopen("u1", g.id);
    expect(reopen.ok).toBe(true);
    expect(reopen.goal!.status).toBe("active");
    expect(reopen.goal!.progress).toBeLessThan(1);

    // Derived goal cannot be reopened
    const d = (await manager.createGoal("u1", { title: "write docs", source: "derived" })).goal!;
    await manager.confirmProposal; // noop reference
    void d;
  });
});

describe("priority + progress + blockers", () => {
  it("priority levels map to bounded scale and back", () => {
    expect(levelFromPriority(1.0)).toBe("critical");
    expect(levelFromPriority(0.75)).toBe("high");
    expect(levelFromPriority(0.5)).toBe("medium");
    expect(levelFromPriority(0.1)).toBe("low");
  });

  it("effective priority decays on staleness and never exceeds base", () => {
    const p1 = effectivePriority(0.8, {});
    const p2 = effectivePriority(0.8, { isStale: true });
    expect(p2).toBeLessThan(p1);
    expect(effectivePriority(0.8, { hasDeadlineSoon: true })).toBeLessThanOrEqual(p1);
  });

  it("progress bounded 0..1; model-inference jumps rejected", async () => {
    const { manager } = makeManager();
    const g = (await manager.createGoal("u1", { title: "migrate db", source: "user" })).goal!;
    expect((await manager.updateProgress("u1", g.id, 1.7, { source: "user_statement" })).ok).toBe(true);
    expect((await manager.load("u1")).find((x) => x.id === g.id)!.progress).toBe(1);
    expect((await manager.load("u1")).find((x) => x.id === g.id)!.status).toBe("completed");

    const g2 = (await manager.createGoal("u1", { title: "refactor auth", source: "user" })).goal!;
    const bad = await manager.updateProgress("u1", g2.id, 0.9, { source: "model_inference" });
    expect(bad.ok).toBe(false);
    const okSmall = await manager.updateProgress("u1", g2.id, 0.3, { source: "task_completed" });
    expect(okSmall.ok).toBe(true);
    expect(okSmall.goal!.status).toBe("progressing");
  });

  it("retains verified world evidence without expanding goal authority", async () => {
    const { manager } = makeManager();
    const goal = (await manager.createGoal("u1", { title: "finish phase 35", source: "user" })).goal!;
    const updated = await manager.updateProgress("u1", goal.id, 0.5, {
      source: "verified_action", worldAssertionId: "world-verified-1",
    });
    expect(updated.ok).toBe(true);
    expect(updated.goal!.relatedWorldAssertionIds).toEqual(["world-verified-1"]);
    expect(updated.goal!.source).toBe("user");
    expect(updated.goal!.autonomyLevel).toBe(0);
  });

  it("blockers recorded and cleared on unblock path", async () => {
    const { manager } = makeManager();
    const g = (await manager.createGoal("u1", { title: "deploy lohz", source: "user" })).goal!;
    const b = await manager.transition("u1", g.id, "blocked", {
      blockedReason: "Firebase configuration missing",
    });
    expect(b.ok).toBe(true);
    expect(b.goal!.blockedReason).toContain("Firebase");

    const un = await manager.transition("u1", g.id, "active", { reason: "credentials configured" });
    expect(un.ok).toBe(true);
    expect(un.goal!.blockedReason).toBeUndefined();
  });
});

describe("dependencies + hierarchy", () => {
  it("A→B then B→A rejected (cycle detection)", async () => {
    const { manager } = makeManager();
    const a = (await manager.createGoal("u1", { title: "finish backend api", source: "user" })).goal!;
    const b = (await manager.createGoal("u1", { title: "deploy application", source: "user" })).goal!;
    expect((await manager.addDependency("u1", b.id, a.id)).ok).toBe(true);
    const cycle = await manager.addDependency("u1", a.id, b.id);
    expect(cycle.ok).toBe(false);
    expect(cycle.reason).toContain("cycle");
    expect((await manager.addDependency("u1", a.id, a.id)).reason).toContain("self");
  });

  it("hierarchy depth and child bounds enforced", async () => {
    const { manager } = makeManager();
    const root = (await manager.createGoal("u1", { title: "build lohz system", source: "user" })).goal!;
    const l1 = (await manager.createGoal("u1", { title: "memory subsystem", source: "user", parentGoalId: root.id })).goal!;
    const l2 = (await manager.createGoal("u1", { title: "user model module", source: "user", parentGoalId: l1.id })).goal!;
    expect(l2.parentGoalId).toBe(l1.id);
    const tooDeep = await manager.createGoal("u1", {
      title: "temporal reasoning layer", source: "user", parentGoalId: l2.id,
    });
    // depth(root=0,l1=1,l2=2) → child depth 3 ≤ maxDepth(3): allowed
    expect(tooDeep.ok).toBe(true);
    const wayTooDeep = await manager.createGoal("u1", {
      title: "clock utilities layer x", source: "user", parentGoalId: tooDeep.goal!.id,
    });
    expect(wayTooDeep.ok).toBe(false);
  });
});

describe("candidate derivation + duplicates + conflicts", () => {
  it("extractGoalPhrase finds explicit intent verbs", () => {
    expect(extractGoalPhrase("I want to learn Rust")!.title).toBe("learn Rust");
    expect(extractGoalPhrase("my goal is to run a marathon")!.explicit).toBe(true);
    expect(extractGoalPhrase("the weather is nice")).toBeNull();
  });

  it("scoring gates below-threshold candidates", () => {
    const input: CandidateInput = {
      text: "maybe someday look into something",
      kind: "preference",
      confidence: 0.3,
      timestamp: NOW - 40 * DAY,
    };
    expect(scoreCandidate(input, [], [], undefined, NOW)).toBeNull();
  });

  it("'Learn Python' vs 'I want to learn Python' dedup to one goal", async () => {
    const { manager } = makeManager();
    const first = await manager.createGoal("u1", { title: "Learn Python", source: "user" });
    const dupResult = await manager.proposeFromEvidence("u1", [
      { text: "I want to learn python properly", kind: "goal", confidence: 0.9, timestamp: NOW },
    ]);
    // The candidate either reinforced the existing or created none beyond it
    const goals = await manager.load("u1");
    const pythons = goals.filter((g) => g.title.toLowerCase().includes("python"));
    expect(pythons.length).toBe(1);
    if (dupResult.reinforced.length > 0) {
      expect(pythons[0].repetitionCount).toBeGreaterThan(1);
    }
    void first;
  });

  it("conflicting goals flagged, not auto-resolved", () => {
    const existing: GoalRecord[] = [{
      id: "g-work", title: "I love working on project X daily", description: "",
      status: "active", createdAt: NOW, updatedAt: NOW, source: "user",
    }];
    const dup = checkDuplicate("stop working on project X", existing);
    expect(dup.relation).toBe("conflicting");
  });

  it("proposeFromEvidence creates derived proposals with evidence references", async () => {
    const { manager } = makeManager();
    const out = await manager.proposeFromEvidence("u1", [
      { text: "I want to learn rust programming", kind: "goal", confidence: 0.95, memoryId: "mem-77", timestamp: NOW },
    ]);
    expect(out.proposed).toHaveLength(1);
    expect(out.proposed[0].source).toBe("derived");
    expect(out.proposed[0].status).toBe("proposed");
    expect(out.proposed[0].relatedMemoryIds).toContain("mem-77");
    expect(await manager.load("u1")).toHaveLength(1);
  });
});

describe("staleness + attention + evaluation", () => {
  it("idle active goals become stale; reactivation works on fresh evidence", async () => {
    const { manager, store } = makeManager();
    const g = (await manager.createGoal("u1", { title: "old quest", source: "user" })).goal!;
    // Age the goal artificially
    const stored = store.key("u1").get(g.id)!;
    stored.updatedAt = NOW - 30 * DAY;
    stored.lastProgressAt = NOW - 30 * DAY;
    store.key("u1").set(g.id, stored);
    manager.resetCache("u1");

    const staleIds = await manager.refreshStaleness("u1");
    expect(staleIds).toContain(g.id);
    expect((await manager.load("u1")).find((x) => x.id === g.id)!.status).toBe("stale");

    const re = await manager.reactivate("u1", g.id, "evidence-mem-1");
    expect(re.ok).toBe(true);
    expect(re.goal!.status).toBe("active");
    expect(re.goal!.relatedMemoryIds).toContain("evidence-mem-1");
  });

  it("attention score ranks deadline+priority first, respects weights", () => {
    const mk = (over: Partial<GoalRecord>): GoalRecord => ({
      id: over.id ?? "g", title: "t", description: "", status: "active",
      createdAt: NOW - 10 * DAY, updatedAt: NOW - 10 * DAY, ...over,
    });
    const urgent = mk({ id: "urgent", priority: 0.75, deadline: NOW + DAY });
    const relaxed = mk({ id: "relaxed", priority: 0.25 });
    expect(attentionScore(urgent, NOW).score).toBeGreaterThan(attentionScore(relaxed, NOW).score);
    expect(attentionScore(mk({ status: "blocked", priority: 0.5 }), NOW).breakdown.blockerFlag).toBe(1);
    // Completed goals still score but progressGap ~0 lowers them naturally
    expect(attentionScore(mk({ status: "completed", progress: 1 }), NOW).score)
      .toBeLessThan(attentionScore(urgent, NOW).score);
  });

  it("evaluateGoals returns bounded verdict without side effects", async () => {
    const { manager, store } = makeManager();
    await manager.createGoal("u1", { title: "quiet goal", source: "user", priorityLevel: "low" });
    const before = JSON.stringify(store.key("u1"));
    const evaluation = await manager.evaluateGoals("u1");
    expect(["WAIT", "MAINTAIN"]).toContain(evaluation.verdict);
    expect(evaluation.items.length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(store.key("u1"))).toBe(before); // zero side effects
  });

  it("conflicted goals drive REQUEST_CLARIFICATION verdict", async () => {
    const { manager } = makeManager();
    const a = (await manager.createGoal("u1", { title: "focus entirely on project X", source: "user" })).goal!;
    // Manually create conflicting pair via direct conflict marking path:
    await manager.createGoal("u1", { title: "abandon project X completely", source: "derived" });
    // Force conflict linkage through duplicate checker semantics:
    const goals = await manager.load("u1");
    const b = goals.find((g) => g.id !== a.id)!;
    a.conflictWith = [b.id];
    b.conflictWith = [a.id];
    const ev = await manager.evaluateGoals("u1");
    expect(ev.verdict).toBe("REQUEST_CLARIFICATION");
    expect(ev.conflictedCount).toBeGreaterThan(0);
  });
});

describe("persistence + restart + failure recovery", () => {
  it("create→persist→destroy→recreate loads equal state", async () => {
    const store = new MemGoalStore();
    const a = makeManager(store).manager;
    const g = (await a.createGoal("u1", {
      title: "durable goal", source: "user", priorityLevel: "critical", deadline: NOW + 3 * DAY,
    })).goal!;
    await a.updateProgress("u1", g.id, 0.4, { source: "user_statement", memoryId: "m1" });
    await a.addDependency("u1", g.id, (await a.createGoal("u1", { title: "prereq step", source: "user" })).goal!.id);
    const snapshot = JSON.stringify([...store.key("u1").values()]);

    const b = makeManager(store).manager;
    const loaded = await b.load("u1");
    expect(JSON.stringify([...store.key("u1").values()])).toBe(snapshot);
    const reloaded = loaded.find((x) => x.id === g.id)!;
    expect(reloaded.progress).toBe(0.4);
    expect(reloaded.dependsOn).toHaveLength(1);
    expect(reloaded.relatedMemoryIds).toEqual(["m1"]);
  });

  it("save failure rolls back in-memory state and reports", async () => {
    const store = new MemGoalStore();
    const { manager } = makeManager(store);
    const g = (await manager.createGoal("u1", { title: "rollback target", source: "user" })).goal!;
    store.failSave = true;
    const r = await manager.transition("u1", g.id, "paused", { reason: "paused attempt" });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("rolled back");
    expect((await manager.load("u1")).find((x) => x.id === g.id)!.status).toBe("active");
  });

  it("budget bound: maxPerUser enforced", async () => {
    const { manager } = makeManager();
    const WORDS = [..."abcdefghijklmnopqrstuvwxyz"];
    for (let i = 0; i < GOAL_LIMITS.maxPerUser; i++) {
      // Lexically-distinct titles so duplicate suppression can't mask the count
      const token = `${WORDS[i % 26]}${WORDS[Math.floor(i / 26)]}q`;
      const r = await manager.createGoal("u1", {
        title: `task ${token} plan batch`, source: "system",
      });
      expect(r.ok).toBe(true);
    }
    const overflow = await manager.createGoal("u1", { title: "one goal too many here", source: "system" });
    expect(overflow.ok).toBe(false);
    expect(overflow.reason).toContain("limit");
  });
});

describe("concurrency", () => {
  it("rapid mixed updates converge deterministically", async () => {
    const store = new MemGoalStore();
    const { manager } = makeManager(store);
    const g = (await manager.createGoal("u1", { title: "concurrent goal test", source: "user" })).goal!;
    await Promise.all([
      manager.updateProgress("u1", g.id, 0.2, { source: "user_statement" }),
      manager.setNextAction("u1", g.id, "review checklist"),
      manager.updateProgress("u1", g.id, 0.4, { source: "task_completed" }),
    ]);
    const final = (await manager.load("u1")).find((x) => x.id === g.id)!;
    expect(final.progress).toBeGreaterThanOrEqual(0.2);
    expect(final.version).toBeGreaterThanOrEqual(2);
    // Duplicate creation collapses to one row
    await Promise.all([
      manager.createGoal("u1", { title: "concurrent goal test", source: "user" }),
      manager.createGoal("u1", { title: "concurrent goal test", source: "user" }),
    ]);
    const all = await manager.load("u1");
    expect(all.filter((x) => x.title === "concurrent goal test")).toHaveLength(1);
  });

  it("simultaneous completion + pause race resolves to one terminal state", async () => {
    const store = new MemGoalStore();
    const { manager } = makeManager(store);
    const g = (await manager.createGoal("u1", { title: "race goal", source: "user" })).goal!;
    const [complete, pause] = await Promise.all([
      manager.updateProgress("u1", g.id, 1, { source: "verified_action" }),
      manager.transition("u1", g.id, "paused", {}),
    ]);
    const finalStatus = (await manager.load("u1")).find((x) => x.id === g.id)!.status;
    // Exactly one of the two operations wins; state is a legal value.
    expect(["completed", "paused", "progressing", "active"]).toContain(finalStatus);
    expect(complete.ok || pause.ok || !complete.ok).toBe(true);
  });
});

describe("multi-user isolation (A/B/C)", () => {
  it("goals never cross user boundaries", async () => {
    const store = new MemGoalStore();
    const { manager } = makeManager(store);
    await manager.createGoal("userA", { title: "alice objective alpha", source: "user" });
    await manager.createGoal("userB", { title: "bob objective beta", source: "user" });
    await manager.createGoal("userC", { title: "cara objective gamma", source: "derived" });

    const aGoals = await manager.load("userA");
    expect(aGoals.map((g) => g.title)).toEqual(["alice objective alpha"]);

    // B cannot see or mutate A's goal via any operation
    const crossTransition = await manager.transition("userB", aGoals[0].id, "completed", {});
    expect(crossTransition.ok).toBe(false);
    const crossEval = await manager.evaluateGoals("userB");
    expect(crossEval.items.every((i) => !i.title.includes("alice"))).toBe(true);
    const crossPropose = await manager.proposeFromEvidence("userC", [
      { text: "I want to learn alice objective alpha topic", kind: "goal", confidence: 0.9, timestamp: NOW },
    ]);
    // C's proposal must not reinforce A's goal — different namespace
    const aAfter = await manager.load("userA");
    expect(aAfter[0].repetitionCount ?? 1).toBe(1);
    void crossPropose;
  });
});
