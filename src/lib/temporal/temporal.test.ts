import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TemporalService, type TemporalPersistence, type RecordInput } from "./temporalService";
import {
  DEFAULT_TEMPORAL_LIMITS,
  type TemporalEvent,
  type TemporalState,
} from "./types";
import { MockFirestore } from "../persistence/mockFirestore";
import { FirestoreUserStoreImpl } from "../persistence/firestoreUserStore";
import { relativeBucket, startOfUtcDay, utcDayDiff } from "./clock";
import { relationOf, during, overlaps, sameUtcPeriod, sortEvents, compareEvents } from "./ordering";
import { detectChanges } from "./changeDetection";
import { projectTemporalState, goalTemporalState, buildCurrentContext, continuityHint } from "./currentContext";
import type { UserModelBundle, UserProject } from "../userModel/types";
import { createUserModelBundle } from "../userModel/types";

// ── In-memory persistence with failure injection ──
class MemTemporalPersistence implements TemporalPersistence {
  store = new Map<string, TemporalState>();
  failSave = false;
  failLoad = false;
  async load(uid: string) {
    if (this.failLoad) throw new Error("down");
    return this.store.get(uid) ?? null;
  }
  async save(uid: string, state: TemporalState) {
    if (this.failSave) return false;
    this.store.set(uid, JSON.parse(JSON.stringify(state)));
    return true;
  }
}

const DAY = 24 * 60 * 60_000;
/** Fixed UTC instants — deterministic across DST/locales. */
const T0 = Date.UTC(2026, 0, 10, 9, 0, 0); // Sat Jan 10 2026 09:00 UTC

function svc(p?: MemTemporalPersistence): { s: TemporalService; p: MemTemporalPersistence } {
  const pers = p ?? new MemTemporalPersistence();
  const s = new TemporalService(pers, { limits: { maxEvents: 50 } });
  return { s, p: pers };
}

async function ev(
  s: TemporalService,
  over: Partial<RecordInput> & { userId: string; type: RecordInput["type"] },
  ts = T0
): Promise<TemporalEvent | null> {
  return s.record({ timestamp: ts, ...over }, ts + 1);
}

describe("temporal events", () => {
  let t: ReturnType<typeof svc>;
  beforeEach(() => (t = svc()));
  afterEach(() => t.s.dispose());

  it("creates, stores, and reads bounded events", async () => {
    await t.s.load("u1", T0);
    const e = await ev(t.s, { userId: "u1", type: "project_activity", projectKey: "Aurora Dashboard" });
    expect(e).not.toBeNull();
    expect(e!.projectKey).toBe("aurora-dashboard");
    expect(t.s.getRecentEvents("u1", "immediate", T0 + DAY)).toHaveLength(0); // outside window
    expect(t.s.getEventsForProject("u1", "Aurora Dashboard")).toHaveLength(1);
  });

  it("rejects unknown event types (closed vocabulary)", async () => {
    await t.s.load("u1", T0);
    // @ts-expect-error deliberate invalid type at runtime boundary
    const r = await t.s.record({ userId: "u1", type: "user_got_angry" }, T0);
    expect(r).toBeNull();
  });

  it("orders deterministically; identical timestamps break by id", async () => {
    await t.s.load("u1", T0);
    await ev(t.s, { userId: "u1", type: "task_started" }, T0);
    await ev(t.s, { userId: "u1", type: "task_completed" }, T0);
    await ev(t.s, { userId: "u1", type: "memory_created" }, T0 - 5);
    const read = t.s.getEventsSince("u1", 0, 50);
    expect(read.map((e) => e.timestamp)).toEqual([...read.map((e) => e.timestamp)].sort((a, b) => a - b));
    const [a, b] = read.filter((e) => e.timestamp === T0);
    expect(relationOf(a, b)).toBe("before"); // id tiebreak, stable
    expect(relationOf(b, a)).toBe("after");
  });

  it("interval semantics: during / overlaps / same-period", () => {
    const mk = (id: string, timestamp: number, endTime?: number): TemporalEvent =>
      ({ id, type: "task_started", timestamp, userId: "u1", source: "observation", confidence: 1, importance: 1, endTime } as TemporalEvent);
    const long = mk("L", T0, T0 + 2 * DAY);
    const inner = mk("I", T0 + DAY, T0 + 1.5 * DAY);
    const apart = mk("P", T0 + 5 * DAY);
    expect(during(inner, long)).toBe(true);
    expect(during(long, inner)).toBe(false);
    expect(overlaps(inner, long)).toBe(true);
    expect(overlaps(apart, long)).toBe(false);
    expect(sameUtcPeriod(mk("X", T0), mk("Y", T0 + 3600_000))).toBe(true);
    expect(sameUtcPeriod(mk("X", T0), mk("Y", T0 + 26 * 3600_000))).toBe(false);
  });

  it("sortEvents never mutates input and is total under shuffles", () => {
    const arr: TemporalEvent[] = [
      { id: "b", type: "task_started", timestamp: T0, userId: "u", source: "observation", confidence: 1, importance: 1 },
      { id: "a", type: "task_started", timestamp: T0, userId: "u", source: "observation", confidence: 1, importance: 1 },
      { id: "c", type: "task_started", timestamp: T0 - 1000, userId: "u", source: "observation", confidence: 1, importance: 1 },
    ];
    const copy = [...arr];
    const sorted = sortEvents(arr);
    expect(arr).toEqual(copy); // untouched
    expect(sorted[0].timestamp).toBeLessThanOrEqual(sorted[1].timestamp);
    expect(compareEvents(sorted[0], sorted[1])).toBeLessThanOrEqual(0);
  });
});

describe("relative time + windows (UTC calendar safety)", () => {
  it("bucket ladder including day rollover, month rollover, year rollover", () => {
    const now = Date.UTC(2026, 2, 1, 12, 0, 0); // Mar 1 2026 12:00 UTC
    expect(relativeBucket(now - 60_000, now)).toBe("just_now");
    expect(relativeBucket(now - 30 * 60_000, now)).toBe("minutes_ago");
    expect(relativeBucket(now - 5 * 3_600_000, now)).toBe("hours_ago");
    // Midnight boundary: delta crosses the 12h ladder into calendar-day logic
    expect(relativeBucket(startOfUtcDay(now), now)).toBe("today");
    expect(relativeBucket(Date.UTC(2026, 1, 28, 23, 0, 0), now)).toBe("yesterday"); // month rollover Feb→Mar (1 day back)
    expect(relativeBucket(Date.UTC(2025, 11, 31, 12, 0, 0), now)).toBe("stale"); // year rollover Dec→Jan (~60d, correctly stale)
    expect(relativeBucket(Date.UTC(2026, 1, 20, 12, 0, 0), now)).toBe("last_week");
    expect(relativeBucket(Date.UTC(2025, 11, 15, 12, 0, 0), now)).toBe("stale");
  });

  it("utcDayDiff handles boundaries without local-time drift", () => {
    expect(utcDayDiff(Date.UTC(2026, 0, 10, 23, 59), Date.UTC(2026, 0, 11, 0, 1))).toBe(1);
    expect(utcDayDiff(Date.UTC(2026, 0, 10, 0, 1), Date.UTC(2026, 0, 10, 23, 59))).toBe(0);
  });

  it("window queries respect explicit durations", async () => {
    const { s } = svc();
    await s.load("u1", T0);
    await ev(s, { userId: "u1", type: "memory_created" }, T0 - 4 * 60_000);
    await ev(s, { userId: "u1", type: "memory_updated" }, T0 - 2 * DAY);
    await ev(s, { userId: "u1", type: "important_decision" }, T0 - 40 * DAY);
    expect(s.getRecentEvents("u1", "immediate", T0)).toHaveLength(1);
    expect(s.getRecentEvents("u1", "short_term", T0)).toHaveLength(2);
    expect(s.getRecentEvents("u1", "long_term", T0)).toHaveLength(3);
    s.dispose();
  });
});

describe("change detection", () => {
  const uid = "cd";
  function bundleWith(prefVal: string, projects: Array<Partial<UserProject>>): UserModelBundle {
    const b = createUserModelBundle(uid, T0);
    b.preferences.responseLength = {
      current: { value: prefVal, confidence: 0.9, state: "confirmed", temporalStatus: "current", source: "explicit", updatedAt: T0, evidenceMemoryIds: [] },
      previous: [],
    };
    b.projects = projects.map((p) => ({
      key: p.key ?? "k", displayName: p.displayName ?? "K", status: p.status ?? "active",
      priority: 0.6, currentFocus: null, lastActivity: p.lastActivity ?? T0,
      relatedGoalIds: [], relatedMemoryIds: [], confidence: 0.8, stale: false, state: "confirmed",
    }));
    return b;
  }

  it("emits preference_changed / project transitions only for real diffs", () => {
    const prev = bundleWith("long answers", [{ key: "alpha" }]);
    const curr = bundleWith("short answers", [{ key: "alpha", status: "paused" }]);
    const changes = detectChanges(prev, curr, { nowUtc: T0, userId: uid });
    const types = changes.map((e) => e.type);
    expect(types).toContain("preference_changed");
    expect(types).toContain("project_paused");

    // No-op diff → zero events (no trivial noise)
    expect(detectChanges(curr, JSON.parse(JSON.stringify(curr)), { nowUtc: T0, userId: uid })).toHaveLength(0);

    // First observation emits nothing (baseline, not change)
    expect(detectChanges(null, curr, { nowUtc: T0, userId: uid })).toHaveLength(0);
  });

  it("resumed projects emit project_resumed; new goals emit goal_created", () => {
    const prev = bundleWith("x", [{ key: "beta", status: "paused" }]);
    prev.activeGoalIds = ["g1"];
    const curr = bundleWith("x", [{ key: "beta", status: "active" }]);
    curr.activeGoalIds = ["g1", "g2"];
    const types = detectChanges(prev, curr, { nowUtc: T0, userId: uid }).map((e) => e.type);
    expect(types).toContain("project_resumed");
    expect(types).toContain("goal_created");
  });
});

describe("session continuity + absence", () => {
  let t: ReturnType<typeof svc>;
  beforeEach(() => (t = svc()));
  afterEach(() => t.s.dispose());

  it("first_visit → same_session → returning_user classification", async () => {
    expect((await t.s.touchSession("u1", T0)).kind).toBe("first_visit");
    expect((await t.s.touchSession("u1", T0 + 5 * 60_000)).kind).toBe("same_session");
    const r = await t.s.touchSession("u1", T0 + 10 * 60 * 60_000); // 10h gap
    expect(r.kind).toBe("returning_user");
    expect(r.gapMs).toBeGreaterThan(0);

    // Absence bookkeeping only — no interpretation fields exist
    const abs = t.s.getAbsence("u1", T0 + 10 * 60 * 60_000 + 60_000);
    expect(abs.lastInteractionAt).not.toBeNull();
    expect(abs.inactiveDurationMs).toBeGreaterThan(0);
    const state = t.s.peekCached("u1")!;
    expect(Object.keys(state.session!)).not.toContain("mood");
  });

  it("new_session within threshold does not mark returning_user", async () => {
    await t.s.touchSession("u2", T0);
    const r = await t.s.touchSession("u2", T0 + 2 * 60 * 60_000); // 2h gap
    expect(r.kind).toBe("new_session");
  });

  it("user_returned event recorded exactly once per session reopen", async () => {
    await t.s.touchSession("u3", T0);
    await t.s.touchSession("u3", T0 + 8 * 60 * 60_000);
    await t.s.flush("u3");
    const count = (t.p.store.get("u3")!.events).filter((e) => e.type === "user_returned").length;
    expect(count).toBe(1);
  });
});

describe("topic continuity + derived temporal states", () => {
  it("topics activate via events and derive statuses non-destructively", async () => {
    const { s } = svc();
    await s.load("u1", T0);
    await ev(s, { userId: "u1", type: "project_activity", projectKey: "Nova Engine" }, T0 - 2 * HOURISH());
    await ev(s, { userId: "u1", type: "project_activity", projectKey: "Nova Engine" }, T0);
    s.refreshTopicStatuses("u1", T0);
    let topics = s.getTopics("u1");
    expect(topics).toHaveLength(1);
    expect(topics[0].status).toBe("active");

    // 20 days later → stale, but topic row preserved (never deleted)
    s.refreshTopicStatuses("u1", T0 + 20 * DAY);
    topics = s.getTopics("u1");
    expect(topics[0].status).toBe("stale");
    s.dispose();
    function HOURISH() { return 3_600_000; }
  });

  it("projectTemporalState derives without mutating schema", () => {
    const mk = (over: Partial<UserProject>): UserProject => ({
      key: "k", displayName: "K", status: "active", priority: 0.6, currentFocus: null,
      lastActivity: T0 - 60_000, relatedGoalIds: [], relatedMemoryIds: [],
      confidence: 0.8, stale: false, state: "confirmed", ...over,
    });
    expect(projectTemporalState(mk({}), T0)).toBe("just_active");
    expect(projectTemporalState(mk({ lastActivity: T0 - 5 * DAY }), T0)).toBe("quiet");
    expect(projectTemporalState(mk({ lastActivity: T0 - 40 * DAY }), T0)).toBe("stale");
    expect(projectTemporalState(mk({ status: "completed" }), T0)).toBe("quiet");
  });

  it("goalTemporalState derives from referenced records only", () => {
    expect(goalTemporalState({ id: "g", status: "completed", updatedAt: T0 }, T0)).toBe("completed");
    expect(goalTemporalState({ id: "g", status: "blocked", updatedAt: T0 }, T0)).toBe("blocked");
    expect(goalTemporalState({ id: "g", status: "active", updatedAt: T0 - 20 * DAY }, T0)).toBe("stale");
    expect(goalTemporalState({ id: "g", status: "active", updatedAt: T0, progress: 0.4 }, T0)).toBe("progressing");
    expect(goalTemporalState({ id: "g", status: "active", updatedAt: T0 - 0.5 * DAY }, T0)).toBe("new");
  });

  it("continuityHint offers evidence-based continuation, not assumption", () => {
    const topics = [
      { key: "fresh", displayName: "fresh", status: "active" as const, lastSeenAt: T0 - 3600_000, refMemoryIds: [] },
      { key: "old", displayName: "old", status: "stale" as const, lastSeenAt: T0 - 90 * DAY, refMemoryIds: [] },
    ];
    expect(continuityHint(topics, [], T0).basis).toBe("active_topic");
    // All topics ancient → no hint rather than a wrong assumption
    expect(continuityHint([topics[1]], [], T0).basis).toBeNull();
    expect(continuityHint([], [], T0).topicKey).toBeNull();
  });
});

describe("snapshots + before/after queries", () => {
  it("captures bounded snapshots; getPreviousState returns latest before cutoff", async () => {
    const { s } = svc();
    await s.load("u1", T0);
    s.captureSnapshot("u1", "before refactor", { activeProjectKey: "alpha", openGoalCount: 2, preferenceKeyCount: 3 }, T0);
    s.captureSnapshot("u1", "mid", { activeProjectKey: "beta", openGoalCount: 1, preferenceKeyCount: 3 }, T0 + DAY);
    for (let i = 0; i < 8; i++) {
      s.captureSnapshot("u1", `s${i}`, { activeProjectKey: null, openGoalCount: 0, preferenceKeyCount: 0 }, T0 + (i + 2) * DAY);
    }
    const snaps = s.peekCached("u1")!.snapshots;
    expect(snaps.length).toBeLessThanOrEqual(DEFAULT_TEMPORAL_LIMITS.maxSnapshots);
    // Oldest snapshots were evicted by the ring; latest-before-cutoff still answers.
    const beforeLate = s.getPreviousState("u1", T0 + 8 * DAY);
    expect(beforeLate!.label).toBe("s5");
    expect(s.getPreviousState("u1", T0)).toBeNull(); // nothing before first
    s.dispose();
  });

  it("getChangesSince filters to meaningful structured changes", async () => {
    const { s } = svc();
    await s.load("u1", T0);
    await ev(s, { userId: "u1", type: "preference_changed" }, T0 + 1);
    await ev(s, { userId: "u1", type: "memory_created" }, T0 + 2);
    await ev(s, { userId: "u1", type: "goal_completed", goalId: "g1" }, T0 + 3);
    const changes = s.getChangesSince("u1", T0);
    expect(changes.map((e) => e.type).sort()).toEqual(["goal_completed", "preference_changed"]);
    s.dispose();
  });
});

describe("dedup, out-of-order, concurrency, bounded storage", () => {
  it("duplicate events are ignored (fingerprint dedup)", async () => {
    const { s } = svc();
    await s.load("u1", T0);
    const payload = { userId: "u1", type: "important_decision" as const, description: "chose postgres" };
    await s.record(payload, T0);
    const second = await s.record(payload, T0);
    expect(second).toBeNull();
    expect(s.getEventsSince("u1", 0, 50)).toHaveLength(1);
    s.dispose();
  });

  it("out-of-order inserts still read ascending", async () => {
    const { s } = svc();
    await s.load("u1", T0);
    await ev(s, { userId: "u1", type: "memory_created" }, T0 + 300);
    await ev(s, { userId: "u1", type: "memory_created", memoryId: "m2" }, T0 + 100);
    await ev(s, { userId: "u1", type: "memory_created", memoryId: "m3" }, T0 + 200);
    const ts = s.getEventsSince("u1", 0, 50).map((e) => e.timestamp);
    expect(ts).toEqual([T0 + 100, T0 + 200, T0 + 300]);
    s.dispose();
  });

  it("rapid concurrent writes converge to deterministic bounded state", async () => {
    const { s } = svc();
    await s.load("u1", T0);
    const stamps = Array.from({ length: 120 }, (_, i) => T0 + ((i * 37) % 5000));
    await Promise.all(stamps.map((ts, i) =>
      s.record({ userId: "u1", type: i % 2 ? "memory_created" : "memory_updated", memoryId: `m${i}`, timestamp: ts }, ts)
    ));
    await Promise.all(stamps.slice(0, 20).map((ts, i) =>
      s.record({ userId: "u1", type: "memory_created", memoryId: `m${i}`, timestamp: ts }, ts) // exact dups
    ));
    const state = s.peekCached("u1")!;
    const fps = new Set(state.events.map((e) => `${e.type}|${e.memoryId}|${e.timestamp}`));
    expect(state.events.length).toBe(fps.size); // no duplicates survived
    expect(state.events.length).toBeLessThanOrEqual(DEFAULT_TEMPORAL_LIMITS.maxEvents);
    for (let i = 1; i < state.events.length; i++) {
      expect(state.events[i].timestamp).toBeGreaterThanOrEqual(state.events[i - 1].timestamp);
    }
    s.dispose();
  });

  it("event ring evicts oldest beyond limit", async () => {
    const { s } = svc();
    await s.load("u1", T0);
    for (let i = 0; i < 60; i++) {
      await ev(s, { userId: "u1", type: "memory_created", memoryId: `m${i}` }, T0 + i);
    }
    const all = s.getEventsSince("u1", 0, 50);
    expect(all.length).toBeLessThanOrEqual(DEFAULT_TEMPORAL_LIMITS.maxQueryResults);
    expect(s.peekCached("u1")!.events.length).toBeLessThanOrEqual(50);
    expect(s.peekCached("u1")!.events[0].timestamp).toBe(T0 + 10); // oldest 10 evicted
    s.dispose();
  });
});

describe("restart recovery + persistence failure", () => {
  it("does not clear a newer mutation that arrives during an in-flight flush", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const saveStarted = new Promise<void>((resolve) => { started = resolve; });
    let saves = 0;
    const persisted = new Map<string, TemporalState>();
    const service = new TemporalService({
      load: async () => null,
      save: async (uid, state) => {
        saves += 1;
        if (saves === 1) { started(); await gate; }
        persisted.set(uid, JSON.parse(JSON.stringify(state)));
        return true;
      },
    });
    await service.load("u-race", T0);
    await ev(service, { userId: "u-race", type: "task_started" }, T0);
    const firstFlush = service.flush("u-race");
    await saveStarted;
    await ev(service, { userId: "u-race", type: "task_completed" }, T0 + 1);
    const concurrentFlush = service.flush("u-race");
    release();
    expect(await firstFlush).toBe(true);
    expect(await concurrentFlush).toBe(true);
    expect(persisted.get("u-race")?.events.map((event) => event.type)).toEqual(["task_started", "task_completed"]);
    expect(service.hasPending("u-race")).toBe(false);
    service.dispose();
  });

  it("persist → recreate → load yields equivalent state; re-record dedups", async () => {
    const shared = new MemTemporalPersistence();
    const a = svc(shared);
    await a.s.load("u1", T0);
    await ev(a.s, { userId: "u1", type: "project_activity", projectKey: "Alpha" }, T0);
    await a.s.touchSession("u1", T0);
    await a.s.captureSnapshot("u1", "s1", { activeProjectKey: "alpha", openGoalCount: 1, preferenceKeyCount: 1 }, T0);
    await a.s.flush("u1");
    const snapshotBefore = JSON.stringify(a.p.store.get("u1"));

    const b = svc(shared);
    await b.s.load("u1", T0);
    // Replaying identical events after restart must NOT duplicate anything.
    await ev(b.s, { userId: "u1", type: "project_activity", projectKey: "Alpha" }, T0);
    await b.s.flush("u1");
    expect(JSON.stringify(b.p.store.get("u1"))).toBe(snapshotBefore);

    const loaded = await b.s.load("u1", T0);
    expect(JSON.parse(JSON.stringify(loaded))).toEqual(JSON.parse(snapshotBefore));
    b.s.dispose();
  });

  it("save failure keeps dirty state for retry; load failure starts fresh", async () => {
    const p = new MemTemporalPersistence();
    p.failSave = true;
    const { s } = svc(p);
    await s.load("u1", T0);
    await ev(s, { userId: "u1", type: "memory_created", memoryId: "m1" }, T0);
    expect(await s.flush("u1")).toBe(false);
    expect(s.peekCached("u1")!.events).toHaveLength(1); // retained

    const p2 = new MemTemporalPersistence();
    p2.failLoad = true;
    const s2 = new TemporalService(p2);
    await s2.load("u1", T0);
    expect(s2.peekCached("u1")!.events).toEqual([]);
    s2.dispose();
    s.dispose();
  });
});

describe("multi-user isolation (A/B/C)", () => {
  it("events/topics/sessions/absence never cross users", async () => {
    const { s } = svc();
    await s.load("userA", T0);
    await s.load("userB", T0);
    await s.load("userC", T0);

    await ev(s, { userId: "userA", type: "project_activity", projectKey: "Project A Only" }, T0);
    await ev(s, { userId: "userB", type: "goal_completed", goalId: "goal-b" }, T0);
    await s.touchSession("userC", T0);
    await s.touchSession("userA", T0);

    expect(s.getEventsForProject("userB", "project-a-only")).toHaveLength(0);
    expect(s.getEventsForProject("userA", "project-a-only")).toHaveLength(1);
    expect(s.getEventsForGoal("userA", "goal-b")).toHaveLength(0);
    expect(s.getTopics("userA").map((t) => t.key)).toEqual(["project-a-only"]);
    expect(s.getTopics("userC")).toHaveLength(0);
    expect(s.getLastActivity("userB")).toBe(T0);
    expect(s.getAbsence("userA", T0 + 60_000).inactiveDurationMs).toBe(60_000);

    // Sessions exist per user but are distinct — no cross-user session state
    const sa = s.peekCached("userA")!.session!;
    const sc = s.peekCached("userC")!.session!;
    expect(sa.sessionId).not.toBe(sc.sessionId);
    s.dispose();
  });
});

describe("loop prevention + Firestore-backed persistence", () => {
  it("recording events never cascades into more recordings (fixed point)", async () => {
    const { s } = svc();
    await s.load("u1", T0);
    const before = s.getEventsSince("u1", 0, 50).length;
    for (let i = 0; i < 25; i++) {
      await s.record({ userId: "u1", type: "memory_updated", memoryId: "same-mem", description: "identical" }, T0);
    }
    expect(s.getEventsSince("u1", 0, 50).length).toBe(before + 1); // exactly one stored, rest deduped — fixed point
    s.dispose();
  });

  it("temporal state round-trips through FirestoreUserStore (mock)", async () => {
    const db = new MockFirestore();
    const store = new FirestoreUserStoreImpl({ db, log: () => undefined });
    const persistence: TemporalPersistence = {
      load: async (uid) => (await store.getTemporalState(uid)) as unknown as TemporalState | null,
      save: async (uid, st) => store.setTemporalState(uid, st as unknown as Record<string, unknown>),
    };
    const s = new TemporalService(persistence);
    await s.load("fs-user", T0);
    await ev(s, { userId: "fs-user", type: "important_decision", description: "picked rust" }, T0);
    expect(await s.flush("fs-user")).toBe(true);

    const back = await store.getTemporalState("fs-user");
    expect(back).not.toBeNull();
    expect((back as unknown as TemporalState).events).toHaveLength(1);

    db.failureMode = new Error("down");
    expect(await store.getTemporalState("fs-user")).toBeNull();
    expect(await store.setTemporalState("fs-user", back!)).toBe(false);
    s.dispose();
  });
});

describe("current context builder", () => {
  it("builds a bounded derived snapshot", async () => {
    const { s } = svc();
    await s.load("u1", T0);
    await ev(s, { userId: "u1", type: "project_activity", projectKey: "Aurora", importance: 0.7 }, T0 - 3600_000);
    await ev(s, { userId: "u1", type: "preference_changed", importance: 0.75 }, T0 - 60_000);
    await ev(s, { userId: "u1", type: "memory_created" }, T0 - 30_000);

    const bundle = createUserModelBundle("u1", T0);
    bundle.world.interactionMode = "voice";
    bundle.projects.push({
      key: "aurora", displayName: "Aurora", status: "active", priority: 0.6, currentFocus: "migration",
      lastActivity: T0 - 60_000, relatedGoalIds: [], relatedMemoryIds: [], confidence: 0.9, stale: false, state: "confirmed",
    });
    bundle.activeGoalIds = ["g1"];

    const ctx = buildCurrentContext({
      uid: "u1",
      bundle,
      events: s.getEventsSince("u1", 0, 50),
      topics: s.getTopics("u1"),
      absenceMs: null,
      sessionKindHint: "same_session",
      memoryUpdatesLastWindow: 2,
      nowUtc: T0,
    });

    expect(ctx.activeProject!.key).toBe("aurora");
    expect(ctx.activeProject!.temporalState).toBe("just_active");
    expect(ctx.activeGoals).toEqual(["g1"]);
    expect(ctx.recentImportantEvents.map((e) => e.type)).toContain("preference_changed");
    expect(ctx.topics.map((t) => t.key)).toEqual(["aurora"]);
    expect(ctx.timeContext.utcDate).toBe("2026-01-10");
    expect(ctx.conversationContinuity.sessionKindHint).toBe("same_session");
    s.dispose();
  });
});
