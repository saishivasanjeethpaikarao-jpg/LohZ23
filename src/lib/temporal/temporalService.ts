/**
 * Phase 25 — TemporalService.
 *
 * Bounded, per-user temporal state: event ring, topic continuity,
 * session tracking, snapshots. All reads are bounded; all writes are
 * deduplicated and sorted deterministically. Zero LLM usage.
 *
 * Loop safety (§27): record() is a pure append against temporal state
 * only. It never invokes the memory pipeline or the model engine's
 * outcome path; WorldState updates flow one-way through the caller
 * passing an optional engine reference for `observeWorld`. There is no
 * path from a recorded event back into record().
 */
import crypto from "crypto";
import {
  DEFAULT_TEMPORAL_LIMITS,
  DEFAULT_TEMPORAL_WINDOWS,
  SESSION_NEW_MS,
  SESSION_SAME_MS,
  TEMPORAL_EVENT_TYPES,
  TEMPORAL_SCHEMA_VERSION,
  TemporalEvent,
  TemporalEventType,
  TemporalLimits,
  TemporalState,
  TemporalWindows,
  TopicContinuity,
  WindowName,
  SessionKind,
  StateSnapshot,
} from "./types";
import { inWindow, relativeBucket, CLOCK_CONSTANTS } from "./clock";
import { relationOf, sortEvents } from "./ordering";
import type { UserModelEngine } from "../userModel/engine";

export interface TemporalPersistence {
  load(uid: string): Promise<TemporalState | null>;
  save(uid: string, state: TemporalState): Promise<boolean>;
}

export interface RecordInput {
  type: TemporalEventType;
  userId: string;
  timestamp?: number;
  source?: TemporalEvent["source"];
  memoryId?: string;
  goalId?: string;
  projectKey?: string | null;
  description?: string;
  confidence?: number;
  importance?: number;
  durationMs?: number;
  endTime?: number;
}

function snippet(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= 80 ? t : t.slice(0, 79) + "…";
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

export class TemporalService {
  private readonly persistence: TemporalPersistence;
  private readonly limits: TemporalLimits;
  private readonly windows: TemporalWindows;

  private cache = new Map<string, TemporalState>();
  private dirty = new Set<string>();
  private flushLocks = new Map<string, Promise<boolean>>();
  private mutationVersions = new Map<string, number>();

  constructor(
    persistence: TemporalPersistence,
    opts: { limits?: Partial<TemporalLimits>; windows?: Partial<TemporalWindows> } = {}
  ) {
    if (!persistence) throw new Error("TemporalService: persistence is required");
    this.persistence = persistence;
    this.limits = { ...DEFAULT_TEMPORAL_LIMITS, ...opts.limits };
    this.windows = { ...DEFAULT_TEMPORAL_WINDOWS, ...opts.windows };
  }

  async load(uid: string, nowUtc = Date.now()): Promise<TemporalState> {
    if (!uid) throw new Error("TemporalService: uid is required");
    const cached = this.cache.get(uid);
    if (cached) return cached;
    let state: TemporalState | null = null;
    try {
      const persisted = await this.persistence.load(uid);
      if (persisted && persisted.uid === uid && persisted.schemaVersion === TEMPORAL_SCHEMA_VERSION) {
        state = persisted;
      }
    } catch {
      state = null; // fresh on failure — never fabricate history
    }
    if (!state) {
      state = {
        uid,
        schemaVersion: TEMPORAL_SCHEMA_VERSION,
        events: [],
        topics: [],
        snapshots: [],
        session: null,
        updatedAt: nowUtc,
      };
    }
    // Deterministic order after reload; dedupe defensively (restart §24).
    state.events = this.dedupe(sortEvents(state.events)).slice(-this.limits.maxEvents);
    this.cache.set(uid, state);
    return state;
  }

  peekCached(uid: string): TemporalState | undefined {
    return this.cache.get(uid);
  }

  resetCache(uid: string): void {
    this.cache.delete(uid);
    this.dirty.delete(uid);
    this.mutationVersions.delete(uid);
  }

  private markDirty(uid: string): void {
    this.dirty.add(uid);
    this.mutationVersions.set(uid, (this.mutationVersions.get(uid) ?? 0) + 1);
  }

  private fingerprint(e: Omit<TemporalEvent, "id">): string {
    return crypto
      .createHash("sha1")
      .update([e.type, e.userId, e.timestamp, e.memoryId ?? "", e.goalId ?? "", e.projectKey ?? "", e.description ?? ""].join("|"))
      .digest("hex")
      .slice(0, 16);
  }

  private dedupe(events: TemporalEvent[]): TemporalEvent[] {
    const seenFp = new Set<string>();
    const seenId = new Set<string>();
    const out: TemporalEvent[] = [];
    for (const e of events) {
      const fp = this.fingerprint(e);
      if (seenFp.has(fp) || seenId.has(e.id)) continue;
      seenFp.add(fp);
      seenId.add(e.id);
      out.push(e);
    }
    return out;
  }

  /**
   * Record an event. Returns the stored event, or null when it was a
   * duplicate / invalid. Out-of-order timestamps are fine — reads sort.
   */
  async record(input: RecordInput, nowUtc = Date.now()): Promise<TemporalEvent | null> {
    const { userId } = input;
    if (!userId) throw new Error("TemporalService.record: userId is required");
    if (!TEMPORAL_EVENT_TYPES.includes(input.type)) return null;

    const state = await this.load(userId, nowUtc);
    const ts = input.timestamp ?? nowUtc;

    const candidate: Omit<TemporalEvent, "id"> = {
      type: input.type,
      timestamp: ts,
      userId,
      source: input.source ?? "observation",
      ...(input.memoryId ? { memoryId: input.memoryId } : {}),
      ...(input.goalId ? { goalId: input.goalId } : {}),
      ...(input.projectKey ? { projectKey: slug(input.projectKey) } : {}),
      description: snippet(input.description),
      confidence: Math.max(0, Math.min(1, input.confidence ?? 0.8)),
      importance: Math.max(0, Math.min(1, input.importance ?? 0.6)),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.endTime !== undefined ? { endTime: input.endTime } : {}),
    };
    const fp = this.fingerprint(candidate);

    const existingFps = new Set(state.events.map((e) => this.fingerprint(e)));
    if (existingFps.has(fp)) return null; // duplicate — ignore silently

    const event: TemporalEvent = {
      ...candidate,
      id: crypto.createHash("sha1").update(`${fp}|${state.events.length}`).digest("hex").slice(0, 12),
    };

    state.events.push(event);
    state.events = sortEvents(state.events).slice(-this.limits.maxEvents); // bounded ring, oldest dropped

    // Topic continuity update via controlled project references (§9)
    if (event.projectKey) this.touchTopic(state, event.projectKey, event.timestamp, event.memoryId);

    state.updatedAt = nowUtc;
    this.markDirty(userId);
    return event;
  }

  private touchTopic(state: TemporalState, projectKey: string, at: number, memoryId?: string): void {
    let topic = state.topics.find((t) => t.key === projectKey);
    if (!topic) {
      topic = {
        key: projectKey,
        displayName: projectKey.replace(/-/g, " "),
        status: "active",
        lastSeenAt: at,
        refMemoryIds: [],
      };
      state.topics.push(topic);
      while (state.topics.length > this.limits.maxTopics) state.topics.shift();
    }
    topic.lastSeenAt = Math.max(topic.lastSeenAt, at);
    if (memoryId && !topic.refMemoryIds.includes(memoryId)) {
      topic.refMemoryIds.push(memoryId);
      while (topic.refMemoryIds.length > this.limits.maxRefMemoryIdsPerTopic) topic.refMemoryIds.shift();
    }
    if (topic.status === "completed") return; // completed stays completed until caller changes it
    topic.status = "active";
  }

  /** Derive topic statuses from activity age (pure, non-destructive). */
  refreshTopicStatuses(uid: string, nowUtc: number): void {
    const state = this.cache.get(uid);
    if (!state) return;
    for (const t of state.topics) {
      if (t.status === "completed") continue;
      const bucket = relativeBucket(t.lastSeenAt, nowUtc);
      t.status =
        bucket === "just_now" || bucket === "minutes_ago" || bucket === "hours_ago" || bucket === "today"
          ? "active"
          : bucket === "yesterday" || bucket === "this_week"
            ? "recent"
            : bucket === "last_week" || bucket === "recent"
              ? "stale"
              : "stale";
    }
    state.updatedAt = nowUtc;
    this.markDirty(uid);
  }

  setTopicStatus(uid: string, key: string, status: TopicContinuity["status"]): boolean {
    const state = this.cache.get(uid);
    if (!state) return false;
    const topic = state.topics.find((t) => t.key === slug(key));
    if (!topic) return false;
    topic.status = status;
    state.updatedAt = Date.now();
    this.markDirty(uid);
    return true;
  }

  // ── Session continuity (§14) ──

  /** Classify the current visit and open/continue the session accordingly. */
  async touchSession(userId: string, nowUtc = Date.now()): Promise<{ kind: SessionKind; gapMs: number | null }> {
    const state = await this.load(userId, nowUtc);
    const s = state.session;

    if (!s) {
      state.session = {
        sessionId: crypto.randomUUID(),
        startedAt: nowUtc,
        lastInteractionAt: nowUtc,
        previousSessionEndedAt: null,
        lastInactivityGapMs: null,
      };
      state.updatedAt = nowUtc;
      this.markDirty(userId);
      await this.record({ type: "conversation_started", userId, source: "session", timestamp: nowUtc }, nowUtc);
      return { kind: "first_visit", gapMs: null };
    }

    const gap = nowUtc - s.lastInteractionAt;
    if (gap <= SESSION_SAME_MS) {
      s.lastInteractionAt = nowUtc;
      state.updatedAt = nowUtc;
      this.markDirty(userId);
      return { kind: "same_session", gapMs: gap };
    }

    // New session — close previous implicitly, keep evidence only.
    const kind: SessionKind = gap > SESSION_NEW_MS ? "returning_user" : "new_session";
    s.previousSessionEndedAt = s.lastInteractionAt;
    s.lastInactivityGapMs = gap;
    s.sessionId = crypto.randomUUID();
    s.startedAt = nowUtc;
    s.lastInteractionAt = nowUtc;
    state.updatedAt = nowUtc;
    this.markDirty(userId);
    await this.record({ type: "user_returned", userId, source: "session", timestamp: nowUtc, confidence: 0.9, importance: 0.7 }, nowUtc);
    return { kind, gapMs: gap };
  }

  endSession(userId: string, nowUtc = Date.now()): boolean {
    const state = this.cache.get(userId);
    if (!state?.session) return false;
    state.session.lastInteractionAt = nowUtc;
    state.session.previousSessionEndedAt = nowUtc;
    void this.record({ type: "conversation_ended", userId, source: "session", timestamp: nowUtc }, nowUtc);
    return true;
  }

  /** Absence bookkeeping ONLY — deliberately no interpretation (§15). */
  getAbsence(userId: string, nowUtc = Date.now()): { lastInteractionAt: number | null; inactiveDurationMs: number | null } {
    const state = this.cache.get(userId);
    const last = state?.session?.lastInteractionAt ?? null;
    return {
      lastInteractionAt: last,
      inactiveDurationMs: last === null ? null : Math.max(0, nowUtc - last),
    };
  }

  // ── Snapshots (§13 before/after) ──

  captureSnapshot(userId: string, label: string, data: Omit<StateSnapshot, "at" | "label">, nowUtc = Date.now()): StateSnapshot {
    const state = this.cache.get(userId);
    if (!state) throw new Error("TemporalService.captureSnapshot: load() first");
    const snap: StateSnapshot = { at: nowUtc, label: snippet(label) ?? "snapshot", ...data };
    state.snapshots.push(snap);
    while (state.snapshots.length > this.limits.maxSnapshots) state.snapshots.shift();
    state.updatedAt = nowUtc;
    this.markDirty(userId);
    return snap;
  }

  // ── Queries — all bounded (§21) ──

  getRecentEvents(userId: string, window: WindowName, nowUtc = Date.now(), limit = 20): TemporalEvent[] {
    const ms = this.windows[`${window === "short_term" ? "shortTerm" : window === "medium_term" ? "mediumTerm" : window === "long_term" ? "longTerm" : window}Ms` as keyof TemporalWindows];
    const state = this.cache.get(userId);
    if (!state) return [];
    const from = nowUtc - ms;
    return state.events.filter((e) => inWindow(e.timestamp, nowUtc, nowUtc - from)).slice(-Math.min(limit, this.limits.maxQueryResults));
  }

  getEventsSince(userId: string, sinceTs: number, limit = 20): TemporalEvent[] {
    const state = this.cache.get(userId);
    if (!state) return [];
    return state.events.filter((e) => e.timestamp >= sinceTs).slice(-Math.min(limit, this.limits.maxQueryResults));
  }

  getEventsForProject(userId: string, projectKey: string, limit = 20): TemporalEvent[] {
    const key = slug(projectKey);
    const state = this.cache.get(userId);
    if (!state) return [];
    return state.events.filter((e) => e.projectKey === key).slice(-Math.min(limit, this.limits.maxQueryResults));
  }

  getEventsForGoal(userId: string, goalId: string, limit = 20): TemporalEvent[] {
    const state = this.cache.get(userId);
    if (!state) return [];
    return state.events.filter((e) => e.goalId === goalId).slice(-Math.min(limit, this.limits.maxQueryResults));
  }

  getLastActivity(userId: string): number | null {
    const state = this.cache.get(userId);
    if (!state || state.events.length === 0) return null;
    return state.events[state.events.length - 1].timestamp;
  }

  getTopics(userId: string): TopicContinuity[] {
    return [...(this.cache.get(userId)?.topics ?? [])];
  }

  getPreviousState(userId: string, beforeTs?: number): StateSnapshot | null {
    const state = this.cache.get(userId);
    if (!state) return null;
    const cutoff = beforeTs ?? Number.MAX_SAFE_INTEGER;
    for (let i = state.snapshots.length - 1; i >= 0; i--) {
      if (state.snapshots[i].at < cutoff) return state.snapshots[i];
    }
    return null;
  }

  getChangesSince(userId: string, sinceTs: number, limit = 10): TemporalEvent[] {
    return this.getEventsSince(userId, sinceTs, limit).filter(
      (e) =>
        e.type === "preference_changed" ||
        e.type.startsWith("project_") ||
        e.type.startsWith("goal_")
    );
  }

  getWindowMs(window: WindowName): number {
    return this.windows[`${window === "short_term" ? "shortTerm" : window === "medium_term" ? "mediumTerm" : window === "long_term" ? "longTerm" : window}Ms` as keyof TemporalWindows];
  }

  // ── Persistence ──

  async flush(uid: string): Promise<boolean> {
    if (!this.dirty.has(uid)) return false;
    const active = this.flushLocks.get(uid);
    if (active) {
      const saved = await active;
      return this.dirty.has(uid) ? this.flush(uid) : saved;
    }
    const work = this.flushWithRetry(uid);
    this.flushLocks.set(uid, work);
    let saved = false;
    try {
      saved = await work;
    } finally {
      this.flushLocks.delete(uid);
    }
    // A mutation can arrive while persistence is awaiting I/O even when no
    // second caller invokes flush(). Drain that newer version before claiming
    // the flush completed.
    return saved && this.dirty.has(uid) ? this.flush(uid) : saved;
  }

  hasPending(uid: string): boolean {
    return this.dirty.has(uid);
  }

  private async flushWithRetry(uid: string): Promise<boolean> {
    const state = this.cache.get(uid);
    if (!state) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshotVersion = this.mutationVersions.get(uid) ?? 0;
      let ok = false;
      try {
        ok = await this.persistence.save(uid, JSON.parse(JSON.stringify(state)));
      } catch {
        ok = false;
      }
      if (ok) {
        if ((this.mutationVersions.get(uid) ?? 0) === snapshotVersion) this.dirty.delete(uid);
        return true;
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
    return false;
  }

  async flushAll(): Promise<number> {
    let n = 0;
    for (const uid of [...this.dirty]) if (await this.flush(uid)) n++;
    return n;
  }

  dispose(): void {
    this.cache.clear();
    this.dirty.clear();
    this.flushLocks.clear();
    this.mutationVersions.clear();
  }
}

/** Re-exported so callers can build window math without magic numbers. */
export { CLOCK_CONSTANTS };
