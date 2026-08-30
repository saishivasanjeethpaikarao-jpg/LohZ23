/**
 * Phase 24 — UserModelEngine.
 *
 * Derives and maintains the compact UserModel/WorldState from evidence
 * produced by the Phase 23 memory-intelligence pipeline. Deterministic
 * only: no LLM is invoked for timestamps, counters, IDs, explicit
 * preference statements, goal references, or memory references.
 *
 * Update pipeline (§7):
 *   conversation → memory intelligence → candidate durable memories
 *     → applyMemoryOutcome() → confidence update → debounced persist
 *
 * Failure handling (§19): persistence failure retains in-memory state
 * and records lastPersistError; ambiguous evidence preserves previous
 * state and marks uncertainty. Never fabricates certainty.
 */
import {
  AttributedValue,
  PreferenceSlot,
  SupersededValue,
  USER_MODEL_LIMITS,
  USER_MODEL_SCHEMA_VERSION,
  UserProject,
  UserModelBundle,
  WorldEvent,
  createUserModelBundle,
  isSensitiveTopic,
  STALE_PROJECT_DAYS,
  STALE_CONFIDENCE_FACTOR,
  MIN_STALE_CONFIDENCE,
} from "./types";
import { tokenSimilarity } from "../memoryIntelligence/fingerprint";

export interface UserModelPersistence {
  load(uid: string): Promise<UserModelBundle | null>;
  save(uid: string, bundle: UserModelBundle): Promise<boolean>;
}

/** Evidence event fed from the memory pipeline or goal system. */
export interface ModelOutcome {
  kind:
    | "preference"
    | "identity"
    | "project"
    | "interest"
    | "goal_ref"
    | "world_event";
  text: string;
  memoryId?: string;
  goalId?: string;
  confidence?: number;
  source?: "explicit" | "derived" | "observed";
  /** For corrections — drives supersession instead of reinforcement. */
  isCorrection?: boolean;
}

export interface ApplyResult {
  applied: boolean;
  reason: string;
  attributeKey?: string;
  superseded?: boolean;
}

export interface EngineOptions {
  debounceMs?: number;
  now?: () => number;
}

const DUPLICATE_SIMILARITY = 0.8;
const CONFLICT_SIMILARITY = 0.5;

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function snippet(text: string, max = 80): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

/**
 * Map a free-form preference statement to a bounded key set so the
 * preference namespace cannot grow unboundedly.
 */
export function classifyPreferenceKey(text: string): string {
  const t = text.toLowerCase();
  if (/\b(short|brief|concise|long|detailed|verbose)\b/.test(t)) return "responseLength";
  if (/\b(proactive|proactively|interrupt|ask first|speak up|quiet)\b/.test(t)) return "proactivity";
  if (/\b(formal|casual|friendly|technical|direct|professional)\b/.test(t)) return "style";
  if (/\b(morning|night|evening|schedule|hours)\b/.test(t)) return "availability";
  if (/\b(email|notification|reminder)s?\b/.test(t)) return "notifications";
  return "general";
}

function pushBounded<T>(arr: T[], item: T, max: number): void {
  arr.push(item);
  while (arr.length > max) arr.shift();
}

function addEvidence(ids: string[], id: string | undefined, max: number): void {
  if (!id || ids.includes(id)) return;
  ids.push(id);
  while (ids.length > max) ids.shift();
}

export class UserModelEngine {
  private readonly persistence: UserModelPersistence;
  private readonly debounceMs: number;
  private readonly now: () => number;

  private cache = new Map<string, UserModelBundle>();
  private dirty = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** uid → timestamp of most recent failed save (§19). */
  lastPersistError = new Map<string, number>();

  constructor(persistence: UserModelPersistence, opts: EngineOptions = {}) {
    if (!persistence) throw new Error("UserModelEngine: persistence is required");
    this.persistence = persistence;
    this.debounceMs = opts.debounceMs ?? 2000;
    this.now = opts.now ?? Date.now;
  }

  /** Load (or initialize) the bundle for a user. Load failure → fresh state. */
  async load(uid: string): Promise<UserModelBundle> {
    if (!uid) throw new Error("UserModelEngine: uid is required");
    const cached = this.cache.get(uid);
    if (cached) return cached;
    try {
      const persisted = await this.persistence.load(uid);
      if (persisted && persisted.uid === uid && persisted.schemaVersion === USER_MODEL_SCHEMA_VERSION) {
        this.cache.set(uid, persisted);
        return persisted;
      }
    } catch {
      // Load failure → fresh empty model; never fabricate persisted state.
    }
    const fresh = createUserModelBundle(uid, this.now());
    this.cache.set(uid, fresh);
    return fresh;
  }

  peekCached(uid: string): UserModelBundle | undefined {
    return this.cache.get(uid);
  }

  resetCache(uid: string): void {
    this.cache.delete(uid);
    this.dirty.delete(uid);
  }

  // ── Update pipeline ──

  /**
   * Apply one evidence outcome to the user model. Sensitive-topic
   * candidates are refused outright (privacy §15).
   */
  async applyMemoryOutcome(uid: string, outcome: ModelOutcome): Promise<ApplyResult> {
    if (!uid) throw new Error("UserModelEngine: uid is required");
    if (isSensitiveTopic(outcome.text)) {
      return { applied: false, reason: "sensitive topic excluded by privacy denylist" };
    }
    const model = await this.load(uid);

    let result: ApplyResult = { applied: false, reason: "unhandled kind" };
    switch (outcome.kind) {
      case "preference": result = this.applyPreference(model, outcome); break;
      case "identity": result = this.applyIdentity(model, outcome); break;
      case "project": result = this.applyProject(model, outcome); break;
      case "interest": result = this.applyInterest(model, outcome); break;
      case "goal_ref": result = this.applyGoalRef(model, outcome); break;
      case "world_event": result = this.applyWorldEvent(model, outcome); break;
    }

    if (result.applied) {
      model.updatedAt = this.now();
      this.markDirty(uid);
    }
    return result;
  }

  /** Batch convenience for pipeline sync. */
  async applyOutcomes(uid: string, outcomes: ModelOutcome[]): Promise<ApplyResult[]> {
    const results: ApplyResult[] = [];
    for (const o of outcomes) results.push(await this.applyMemoryOutcome(uid, o));
    return results;
  }

  private applyPreference(model: UserModelBundle, o: ModelOutcome): ApplyResult {
    const key = classifyPreferenceKey(o.text);
    const value = snippet(o.text);
    const source = o.source ?? "explicit";
    const baseConfidence = clamp01(o.confidence ?? (source === "explicit" ? 0.9 : 0.6));

    let slot = model.preferences[key];
    if (!slot) {
      slot = { current: this.makeValue(value, baseConfidence, source, o.memoryId), previous: [] };
      model.preferences[key] = slot;
      this.trimPreferenceKeys(model);
      return { applied: true, reason: `new preference ${key}`, attributeKey: key };
    }

    const sim = tokenSimilarity(value, slot.current.value);
    if (sim >= DUPLICATE_SIMILARITY || value === slot.current.value) {
      // Reinforcement — same meaning, raise confidence, keep history.
      slot.current.confidence = clamp01(Math.max(slot.current.confidence, baseConfidence) + 0.05);
      slot.current.updatedAt = this.now();
      addEvidence(slot.current.evidenceMemoryIds, o.memoryId, USER_MODEL_LIMITS.evidencePerAttribute);
      return { applied: true, reason: `reinforced preference ${key}`, attributeKey: key };
    }

    if (o.isCorrection || sim < CONFLICT_SIMILARITY || slot.current.state === "uncertain") {
      // Genuine change / correction — supersede, keep previous (§8).
      const prev: SupersededValue = {
        value: slot.current.value,
        supersededAt: this.now(),
        reason: o.isCorrection ? "explicit user correction" : "user statement supersedes prior value",
        evidenceMemoryIds: [...slot.current.evidenceMemoryIds],
        confidence: slot.current.confidence,
      };
      slot.previous.push(prev);
      while (slot.previous.length > USER_MODEL_LIMITS.previousPerPreference) slot.previous.shift();
      slot.current = this.makeValue(value, Math.min(0.95, baseConfidence + (o.isCorrection ? 0.05 : 0)), source, o.memoryId);
      slot.current.state = "updated";
      return { applied: true, reason: `superseded preference ${key}`, attributeKey: key, superseded: true };
    }

    // Ambiguous overlap — preserve previous state, mark uncertainty (§19).
    slot.current.state = "conflicted";
    slot.current.updatedAt = this.now();
    addEvidence(slot.current.evidenceMemoryIds, o.memoryId, USER_MODEL_LIMITS.evidencePerAttribute);
    return { applied: true, reason: `conflicting evidence for ${key} — marked conflicted`, attributeKey: key };
  }

  private applyIdentity(model: UserModelBundle, o: ModelOutcome): ApplyResult {
    const key = /\bname\b/i.test(o.text) || o.text.split(/\s+/).length <= 4 ? "name" : slug(o.text).slice(0, 24) || "fact";
    const value = snippet(o.text, 60);
    const existing = model.identity[key];
    if (!existing) {
      model.identity[key] = this.makeValue(value, o.confidence ?? 0.9, o.source ?? "explicit", o.memoryId);
      this.trimIdentityKeys(model);
      return { applied: true, reason: `identity ${key} set`, attributeKey: key };
    }
    if (existing.value === value || tokenSimilarity(value, existing.value) >= DUPLICATE_SIMILARITY) {
      existing.confidence = clamp01(Math.max(existing.confidence, o.confidence ?? 0.9) + 0.05);
      existing.updatedAt = this.now();
      addEvidence(existing.evidenceMemoryIds, o.memoryId, USER_MODEL_LIMITS.evidencePerAttribute);
      return { applied: true, reason: `identity ${key} reinforced`, attributeKey: key };
    }
    // Contradiction on identity — keep old as historical context via world event,
    // mark current uncertain rather than silently overwriting (§14).
    existing.state = "conflicted";
    existing.updatedAt = this.now();
    addEvidence(existing.evidenceMemoryIds, o.memoryId, USER_MODEL_LIMITS.evidencePerAttribute);
    return { applied: true, reason: `identity ${key} conflict — marked conflicted`, attributeKey: key };
  }

  private applyProject(model: UserModelBundle, o: ModelOutcome): ApplyResult {
    const name = this.extractProjectName(o.text);
    if (!name) return { applied: false, reason: "no project name extractable" };
    const key = slug(name);
    const now = this.now();

    let project = model.projects.find((p) => p.key === key);
    if (!project) {
      project = {
        key,
        displayName: name,
        status: "active",
        priority: 0.6,
        currentFocus: null,
        lastActivity: now,
        relatedGoalIds: [],
        relatedMemoryIds: [],
        confidence: clamp01(o.confidence ?? 0.7),
        stale: false,
        state: "confirmed",
      };
      model.projects.push(project);
      this.trimProjects(model);
    } else {
      project.lastActivity = now;
      project.stale = false; // evidence reactivates stale projects (§13)
      project.status = project.status === "archived" ? "active" : project.status;
      project.confidence = clamp01(Math.min(1, project.confidence + 0.05));
    }
    if (o.memoryId) {
      addEvidence(project.relatedMemoryIds, o.memoryId, USER_MODEL_LIMITS.relatedMemoryIdsPerProject);
    }
    if (o.source === "explicit") project.state = "confirmed";

    // Most recently touched active project becomes the world's active focus.
    const activeSorted = model.projects
      .filter((p) => p.status === "active")
      .sort((a, b) => b.lastActivity - a.lastActivity);
    model.world.activeProjectKey = activeSorted[0]?.key ?? null;

    return { applied: true, reason: `project ${key} updated`, attributeKey: key };
  }

  private applyInterest(model: UserModelBundle, o: ModelOutcome): ApplyResult {
    const interest = snippet(o.text, 40).toLowerCase();
    if (!model.interests.includes(interest)) {
      model.interests.push(interest);
      while (model.interests.length > USER_MODEL_LIMITS.interests) model.interests.shift();
      return { applied: true, reason: "interest added" };
    }
    return { applied: false, reason: "interest already present" };
  }

  private applyGoalRef(model: UserModelBundle, o: ModelOutcome): ApplyResult {
    if (!o.goalId) return { applied: false, reason: "missing goalId" };
    if (!model.activeGoalIds.includes(o.goalId)) {
      model.activeGoalIds.push(o.goalId);
      while (model.activeGoalIds.length > USER_MODEL_LIMITS.activeGoalIds) model.activeGoalIds.shift();
    }
    model.world.activeGoalIds = [...model.activeGoalIds];
    // Link into matching project too.
    if (o.text) {
      const key = slug(this.extractProjectName(o.text) ?? "");
      const project = model.projects.find((p) => p.key === key);
      if (project) {
        addEvidence(project.relatedGoalIds, o.goalId, USER_MODEL_LIMITS.relatedGoalIdsPerProject);
      }
    }
    return { applied: true, reason: `goal ref ${o.goalId}` };
  }

  private applyWorldEvent(model: UserModelBundle, o: ModelOutcome): ApplyResult {
    const event: WorldEvent = { kind: "memory", text: snippet(o.text), at: this.now() };
    pushBounded(model.world.recentEvents, event, USER_MODEL_LIMITS.recentEvents);
    model.world.updatedAt = this.now();
    return { applied: true, reason: "world event recorded" };
  }

  // ── World state observation ──

  observeWorld(
    uid: string,
    patch: {
      activity?: string | null;
      projectName?: string | null;
      interactionMode?: "voice" | "text" | "hybrid" | null;
      pendingTaskCount?: number;
      environment?: Record<string, string>;
      eventText?: string;
      eventKind?: string;
    }
  ): void {
    const model = this.cache.get(uid);
    if (!model) return; // observe only after load — no fabrication
    const w = model.world;
    if (patch.activity !== undefined) w.currentActivity = patch.activity;
    if (patch.projectName !== undefined) {
      w.activeProjectKey = patch.projectName ? slug(patch.projectName) : null;
    }
    if (patch.interactionMode !== undefined) w.interactionMode = patch.interactionMode;
    if (patch.pendingTaskCount !== undefined) w.pendingTaskCount = patch.pendingTaskCount;
    if (patch.environment) {
      for (const [k, v] of Object.entries(patch.environment)) {
        w.environmentContext[k] = snippet(v, 40);
      }
      const keys = Object.keys(w.environmentContext);
      while (keys.length > USER_MODEL_LIMITS.environmentKeys) delete w.environmentContext[keys.shift()!];
    }
    if (patch.eventText) {
      pushBounded(
        w.recentEvents,
        { kind: patch.eventKind ?? "observation", text: snippet(patch.eventText), at: this.now() },
        USER_MODEL_LIMITS.recentEvents
      );
    }
    w.timeContext = {
      hourOfDay: new Date(this.now()).getHours(),
      dayOfWeek: new Date(this.now()).getDay(),
      recordedAt: this.now(),
    };
    w.updatedAt = this.now();
    model.updatedAt = this.now();
    this.markDirty(uid);
  }

  /** Sync goal references from the GoalSystem without duplicating goals. */
  syncGoalRefs(uid: string, goalIds: string[]): ApplyResult {
    const model = this.cache.get(uid);
    if (!model) return { applied: false, reason: "model not loaded" };
    model.activeGoalIds = goalIds.slice(0, USER_MODEL_LIMITS.activeGoalIds);
    model.world.activeGoalIds = [...model.activeGoalIds];
    model.world.updatedAt = this.now();
    model.updatedAt = this.now();
    this.markDirty(uid);
    return { applied: true, reason: `${model.activeGoalIds.length} goal refs` };
  }

  setProjectStatus(uid: string, projectKey: string, status: UserProject["status"]): ApplyResult {
    const model = this.cache.get(uid);
    if (!model) return { applied: false, reason: "model not loaded" };
    const key = slug(projectKey);
    const project = model.projects.find((p) => p.key === key);
    if (!project) return { applied: false, reason: "unknown project" };
    project.status = status;
    project.lastActivity = this.now();
    project.stale = false;
    model.updatedAt = this.now();
    this.markDirty(uid);
    return { applied: true, reason: `project ${key} → ${status}`, attributeKey: key };
  }

  /**
   * Staleness sweep (§13): reduce confidence + mark STALE for projects
   * untouched beyond STALE_PROJECT_DAYS. Never deletes — future
   * evidence reactivates.
   */
  markStale(uid: string): number {
    const model = this.cache.get(uid);
    if (!model) return 0;
    const now = this.now();
    let count = 0;
    for (const p of model.projects) {
      if (p.status !== "active") continue;
      const ageDays = (now - p.lastActivity) / (1000 * 60 * 60 * 24);
      if (ageDays > STALE_PROJECT_DAYS) {
        p.stale = true;
        p.confidence = Math.max(MIN_STALE_CONFIDENCE, p.confidence * STALE_CONFIDENCE_FACTOR);
        count++;
      }
    }
    if (count > 0) {
      model.updatedAt = now;
      this.markDirty(uid);
    }
    return count;
  }

  // ── Persistence ──

  private markDirty(uid: string): void {
    this.dirty.add(uid);
    if (this.timers.has(uid)) clearTimeout(this.timers.get(uid)!);
    const t = setTimeout(() => {
      this.timers.delete(uid);
      void this.flush(uid);
    }, this.debounceMs);
    this.timers.set(uid, t);
    if (typeof t.unref === "function") t.unref(); // don't hold process open
  }

  /** Persist immediately if dirty. Returns false when nothing was written or the write failed. */
  async flush(uid: string): Promise<boolean> {
    if (!this.dirty.has(uid)) return false;
    const model = this.cache.get(uid);
    if (!model) return false;
    model.updatedAt = this.now();
    let ok = false;
    try {
      ok = await this.persistence.save(uid, JSON.parse(JSON.stringify(model)));
    } catch {
      ok = false;
    }
    if (ok) {
      this.dirty.delete(uid);
      this.lastPersistError.delete(uid);
    } else {
      this.lastPersistError.set(uid, this.now());
      // Keep dirty — a later flush retries. In-memory state retained (§19).
    }
    return ok;
  }

  async flushAll(): Promise<number> {
    const uids = [...this.dirty];
    let saved = 0;
    for (const uid of uids) {
      if (await this.flush(uid)) saved++;
    }
    return saved;
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // ── Helpers ──

  private makeValue(value: string, confidence: number, source: "explicit" | "derived" | "observed", memoryId?: string): AttributedValue {
    const v: AttributedValue = {
      value: snippet(value),
      confidence: clamp01(confidence),
      state: source === "explicit" ? "confirmed" : "uncertain",
      temporalStatus: "current",
      source,
      updatedAt: this.now(),
      evidenceMemoryIds: [],
    };
    addEvidence(v.evidenceMemoryIds, memoryId, USER_MODEL_LIMITS.evidencePerAttribute);
    return v;
  }

  private extractProjectName(text: string): string | null {
    const m = text.match(/\b(?:working on|building|creating|writing|developing|project)\s+([A-Za-z0-9][\w\s'-]{1,48})/i);
    if (m?.[1]) {
      return m[1].trim().split(/\s+/).slice(0, 4).join(" ");
    }
    // Fallback: leading capitalized multi-word phrase ("Aurora Dashboard").
    const cap = text.match(/\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+){0,3})\b/);
    return cap?.[1]?.trim() ?? null;
  }

  private trimPreferenceKeys(model: UserModelBundle): void {
    const keys = Object.keys(model.preferences);
    while (keys.length > USER_MODEL_LIMITS.preferenceKeys) {
      const oldest = keys.shift()!;
      delete model.preferences[oldest];
    }
  }

  private trimIdentityKeys(model: UserModelBundle): void {
    const keys = Object.keys(model.identity);
    while (keys.length > USER_MODEL_LIMITS.identityKeys) {
      const oldest = keys.shift()!;
      delete model.identity[oldest];
    }
  }

  /** Trim projects beyond the limit — lowest priority, oldest activity first. */
  private trimProjects(model: UserModelBundle): void {
    while (model.projects.length > USER_MODEL_LIMITS.projects) {
      let victimIdx = 0;
      let victimScore = Number.POSITIVE_INFINITY;
      model.projects.forEach((p, i) => {
        const score = p.priority * 10 - (this.now() - p.lastActivity) / (1000 * 60 * 60 * 24 * 100);
        if (score < victimScore) {
          victimScore = score;
          victimIdx = i;
        }
      });
      model.projects.splice(victimIdx, 1);
    }
  }
}
