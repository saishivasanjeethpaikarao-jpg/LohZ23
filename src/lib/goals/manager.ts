/**
 * Phase 26 — AutonomousGoalManager.
 *
 * Composes the EXISTING Phase 22 goal persistence seam
 * (`FirestoreUserStore.putGoal/listGoals/deleteGoal` at
 * `users/{uid}/goals/{goalId}`) with a controlled lifecycle state
 * machine, authority model, dependency graph (cycle-safe), bounded
 * hierarchy, candidate proposals, staleness, attention scoring, and
 * TemporalService event emission.
 *
 * Hard guarantees:
 * - GoalSystem (in-memory class) is untouched; no second goal DB — this
 *   manager IS the durable layer over the existing Phase 22 docs.
 * - No tool execution. Autonomy levels are policy metadata only (§17).
 * - evaluateGoals() returns recommendations (WAIT/MAINTAIN/PROPOSE/
 *   UPDATE/REQUEST_CLARIFICATION) and performs zero side effects (§18).
 * - Event emission is one-way: mutations → temporal.record(). Nothing
 *   recorded re-enters the manager, so no event loops (§29).
 * - Optimistic versioning: stale concurrent writes are rejected
 *   deterministically; failed persistence rolls back in-memory state.
 */
import type {
  FirestoreUserStore,
  GoalRecord,
} from "../persistence/firestoreUserStore";
import type { TemporalService } from "../temporal/temporalService";
import {
  canTransition,
  DEFAULT_DERIVED_AUTONOMY,
  DEFAULT_USER_AUTONOMY,
  GOAL_LIMITS,
  GOAL_STALE_DAYS,
  levelFromPriority,
  PRIORITY_LEVEL_BASE,
  SOURCE_AUTHORITY,
  type GoalLifecycle,
  type GoalSource,
  type PriorityLevel,
} from "./types";
import { attentionScore } from "./attention";
import {
  checkDuplicate,
  scoreCandidate,
  type CandidateInput,
  type DuplicateCheck,
} from "./candidates";

export interface CreateGoalInput {
  title: string;
  description?: string;
  source: GoalSource;
  priorityLevel?: PriorityLevel;
  deadline?: number;
  parentGoalId?: string;
  relatedProjectKey?: string;
  evidenceMemoryIds?: string[];
  confidence?: number;
  autonomyLevel?: number;
}

export interface GoalOperationResult {
  ok: boolean;
  reason?: string;
  goal?: GoalRecord;
  duplicate?: DuplicateCheck;
}

export interface EvaluationItem {
  goalId: string;
  title: string;
  status: GoalRecord["status"];
  attention: number;
  recommendation:
    | "MAINTAIN" | "UPDATE" | "REQUEST_CLARIFICATION"
    | "PROPOSE_CONFIRMATION" | "REACTIVATE_CANDIDATE";
}

export interface EvaluationResult {
  verdict: "WAIT" | "MAINTAIN" | "PROPOSE" | "UPDATE" | "REQUEST_CLARIFICATION";
  items: EvaluationItem[];      // bounded, sorted by attention desc
  pendingProposals: number;
  conflictedCount: number;
}

const DAY = 24 * 3600_000;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export interface ManagerDeps {
  store: FirestoreUserStore;
  temporal?: TemporalService;
  now?: () => number;
}

interface UserGoalCache {
  goals: Map<string, GoalRecord>;
  loaded: boolean;
}

export class AutonomousGoalManager {
  private readonly store: FirestoreUserStore;
  private readonly temporal: TemporalService | undefined;
  private readonly now: () => number;
  private cache = new Map<string, UserGoalCache>();

  constructor(deps: ManagerDeps) {
    if (!deps.store) throw new Error("AutonomousGoalManager: store is required");
    this.store = deps.store;
    this.temporal = deps.temporal;
    this.now = deps.now ?? Date.now;
  }

  resetCache(uid?: string): void {
    if (uid) this.cache.delete(uid);
    else this.cache.clear();
  }

  /** Load (or refresh) the user's goal cache from durable storage. */
  async load(uid: string): Promise<GoalRecord[]> {
    if (!uid) throw new Error("AutonomousGoalManager: uid is required");
    const existing = this.cache.get(uid);
    if (existing?.loaded) return [...existing.goals.values()];
    let records: GoalRecord[] | null = null;
    try {
      records = await this.store.listGoals(uid);
    } catch {
      records = null;
    }
    const goals = new Map<string, GoalRecord>();
    for (const r of records ?? []) {
      if (r && typeof r.id === "string") goals.set(r.id, r);
    }
    this.cache.set(uid, { goals, loaded: true });
    return [...goals.values()];
  }

  private peekCache(uid: string): UserGoalCache | undefined {
    return this.cache.get(uid);
  }

  private async persist(uid: string, goal: GoalRecord): Promise<boolean> {
    return this.store.putGoal(uid, JSON.parse(JSON.stringify(goal)));
  }

  private async emit(
    uid: string,
    type: Parameters<TemporalService["record"]>[0]["type"],
    fields: Partial<{ projectKey: string | null; goalId: string; description: string; importance: number }>
  ): Promise<void> {
    if (!this.temporal) return;
    await this.temporal.record({
      userId: uid,
      type,
      source: "goal_system",
      ...fields,
    }, this.now());
  }

  // ── Creation ──

  async createGoal(uid: string, input: CreateGoalInput): Promise<GoalOperationResult> {
    const goals = await this.load(uid);

    // Bounded per-user count (§ budget bounds)
    const liveGoals = goals.filter((g) => g.status !== "cancelled");
    if (liveGoals.length >= GOAL_LIMITS.maxPerUser) {
      return { ok: false, reason: `goal limit reached (${GOAL_LIMITS.maxPerUser})` };
    }

    // Duplicate/conflict gate (§12, §13)
    const dup = checkDuplicate(input.title, goals);
    if (dup.relation === "exact" || dup.relation === "near") {
      const existing = goals.find((g) => g.id === dup.existingId)!;
      // Reinforce repetition instead of double-creating.
      existing.repetitionCount = (existing.repetitionCount ?? 1) + 1;
      existing.confidence = clamp01(Math.max(existing.confidence ?? 0.6, input.confidence ?? 0.6));
      existing.updatedAt = this.now();
      const saved = await this.persist(uid, existing);
      return saved
        ? { ok: true, reason: "reinforced existing duplicate", goal: existing, duplicate: dup }
        : { ok: false, reason: "persistence failed on duplicate reinforcement" };
    }
    if (dup.relation === "conflicting") {
      const existing = goals.find((g) => g.id === dup.existingId)!;
      // Mark BOTH conflicted — never auto-resolve (§13).
      existing.conflictWith = [...new Set([...(existing.conflictWith ?? []), "__pending__"])];
      existing.updatedAt = this.now();
      await this.persist(uid, existing);
      return { ok: false, reason: "conflicting with existing goal — clarification required", duplicate: dup };
    }

    // Hierarchy bounds (§9)
    if (input.parentGoalId) {
      const parent = goals.find((g) => g.id === input.parentGoalId);
      if (!parent) return { ok: false, reason: "unknown parent goal" };
      const depth = this.depthOf(goals, input.parentGoalId) + 1;
      if (depth > GOAL_LIMITS.maxDepth) return { ok: false, reason: `hierarchy depth > ${GOAL_LIMITS.maxDepth}` };
      const childCount = goals.filter((g) => g.parentGoalId === input.parentGoalId).length;
      if (childCount >= GOAL_LIMITS.maxChildren) return { ok: false, reason: `parent at child limit (${GOAL_LIMITS.maxChildren})` };
    }

    const basePriority = PRIORITY_LEVEL_BASE[input.priorityLevel ?? "medium"];
    const now = this.now();
    // Derived goals start as PROPOSALS; user/explicit/system may go active (§3).
    const initialStatus: GoalLifecycle = input.source === "derived" ? "proposed" : "active";

    const goal: GoalRecord = {
      id: slug(input.title).slice(0, 40) + "-" + Math.random().toString(36).slice(2, 7),
      title: input.title.slice(0, 120),
      description: (input.description ?? "").slice(0, 300),
      status: initialStatus,
      createdAt: now,
      updatedAt: now,
      source: input.source,
      priority: basePriority,
      priorityLevel: input.priorityLevel ?? "medium",
      progress: 0,
      lastProgressAt: now,
      ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
      ...(input.parentGoalId ? { parentGoalId: input.parentGoalId } : {}),
      ...(input.relatedProjectKey ? { relatedProjectKey: slug(input.relatedProjectKey) } : {}),
      relatedMemoryIds: (input.evidenceMemoryIds ?? []).slice(0, GOAL_LIMITS.maxRelatedMemoryIds),
      confidence: clamp01(input.confidence ?? (input.source === "user" ? 1 : 0.6)),
      autonomyLevel:
        input.autonomyLevel ??
        (input.source === "derived" || input.source === "system"
          ? DEFAULT_DERIVED_AUTONOMY
          : DEFAULT_USER_AUTONOMY),
      repetitionCount: 1,
      dependsOn: [],
      version: 1,
    };

    const saved = await this.persist(uid, goal);
    if (!saved) return { ok: false, reason: "goal persistence failed" };

    const cacheEntry = this.cache.get(uid)!;
    cacheEntry.goals.set(goal.id, goal);
    await this.emit(uid, "goal_created", { goalId: goal.id, description: goal.title });
    return { ok: true, goal, duplicate: dup };
  }

  /** Explicit confirmation promotes a proposal to active (§3). */
  async confirmProposal(uid: string, goalId: string, priorityLevel?: PriorityLevel): Promise<GoalOperationResult> {
    return this.transition(uid, goalId, "active", {
      reason: "proposal confirmed",
      requireSource: ["user", "explicit_request"],
      priorityOverride: priorityLevel,
    });
  }

  // ── Transitions ──

  async transition(
    uid: string,
    goalId: string,
    to: GoalLifecycle,
    opts: { reason?: string; requireSource?: GoalSource[]; priorityOverride?: PriorityLevel; blockedReason?: string; blockingGoalId?: string } = {}
  ): Promise<GoalOperationResult> {
    const goals = await this.load(uid);
    const goal = goals.find((g) => g.id === goalId);
    if (!goal) return { ok: false, reason: "goal not found" };

    if (opts.requireSource && !opts.requireSource.includes(goal.source as GoalSource)) {
      return { ok: false, reason: `source '${goal.source}' lacks authority for this transition` };
    }
    if (to === "active" && goal.status === "completed") {
      // completed → active requires explicit reopen path only (§4)
      return { ok: false, reason: "completed goals need explicit reopen()" };
    }
    if (!canTransition(goal.status as GoalLifecycle, to)) {
      return { ok: false, reason: `invalid transition ${goal.status} → ${to}` };
    }

    const previous = JSON.parse(JSON.stringify(goal)) as GoalRecord;
    goal.status = to;
    goal.updatedAt = this.now();
    goal.version = (goal.version ?? 1) + 1;
    if (opts.reason) goal.description = `${goal.description.split(" || ")[0]} || ${opts.reason}`.slice(0, 300);
    if (opts.priorityOverride) {
      goal.priorityLevel = opts.priorityOverride;
      goal.priority = PRIORITY_LEVEL_BASE[opts.priorityOverride];
    }
    if (to === "blocked") {
      goal.blockedReason = (opts.blockedReason ?? "unspecified").slice(0, 200);
      if (opts.blockingGoalId) goal.blockingGoalId = opts.blockingGoalId;
    }
    if (to === "active" && previous.status === "blocked") {
      const mutable = goal as unknown as Record<string, unknown>;
      delete mutable.blockedReason;
      delete mutable.blockingGoalId;
    }

    const saved = await this.persist(uid, goal);
    if (!saved) {
      // Roll back in-memory to prior state — atomicity (§25).
      const entry = this.cache.get(uid)!;
      entry.goals.set(goalId, previous);
      return { ok: false, reason: "goal persistence failed — rolled back" };
    }

    const eventType =
      to === "completed" ? "goal_completed" as const
      : to === "paused" ? "goal_paused" as const
      : to === "blocked" ? "goal_blocked" as const
      : to === "cancelled" ? "goal_cancelled" as const
      : to === "progressing" ? "goal_updated" as const
      : to === "stale" ? "goal_updated" as const
      : previous.status === "blocked" && to === "active" ? "goal_unblocked" as const
      : "goal_updated" as const;
    await this.emit(uid, eventType, { goalId: goal.id, description: opts.reason ?? goal.title });

    return { ok: true, goal };
  }

  /** completed → active explicitly; user-authority goals only (§4). */
  async reopen(uid: string, goalId: string, reason = "explicitly reopened"): Promise<GoalOperationResult> {
    const res = await this.transition(uid, goalId, "active", { reason, requireSource: ["user", "explicit_request"] });
    if (!res.ok && res.reason === "completed goals need explicit reopen()") {
      // Reopen is the sanctioned path: bypass the machine's closed set by
      // direct validated write (still persisted + evented).
      const goals = await this.load(uid);
      const goal = goals.find((g) => g.id === goalId);
      if (!goal) return { ok: false, reason: "goal not found" };
      if (goal.status !== "completed") return { ok: false, reason: `reopen applies to completed goals (got ${goal.status})` };
      if (goal.source !== "user" && goal.source !== "explicit_request") {
        return { ok: false, reason: "only user/explicit_request goals can be reopened" };
      }
      const previous = JSON.parse(JSON.stringify(goal)) as GoalRecord;
      goal.status = "active";
      goal.progress = Math.min(goal.progress ?? 0, 0.99); // reopening implies not-finished
      goal.updatedAt = this.now();
      goal.version = (goal.version ?? 1) + 1;
      const saved = await this.persist(uid, goal);
      if (!saved) {
        this.cache.get(uid)!.goals.set(goalId, previous);
        return { ok: false, reason: "goal persistence failed — rolled back" };
      }
      await this.emit(uid, "goal_resumed", { goalId, description: reason });
      return { ok: true, goal };
    }
    return res;
  }

  // ── Progress (§6) ──

  async updateProgress(
    uid: string,
    goalId: string,
    progress: number,
    evidence: { source: "user_statement" | "task_completed" | "verified_action" | "model_inference"; memoryId?: string; worldAssertionId?: string }
  ): Promise<GoalOperationResult> {
    if (!Number.isFinite(progress)) return { ok: false, reason: "progress must be numeric" };
    const p = clamp01(progress);
    const goals = await this.load(uid);
    const goal = goals.find((g) => g.id === goalId);
    if (!goal) return { ok: false, reason: "goal not found" };
    if (["completed", "cancelled"].includes(goal.status)) {
      return { ok: false, reason: `cannot update progress on ${goal.status} goal` };
    }

    // Model inference alone has lower confidence weight (§6).
    const delta = p - (goal.progress ?? 0);
    if (evidence.source === "model_inference" && delta > 0.5) {
      return { ok: false, reason: "model-inferred progress jump too large — requires verification" };
    }

    const previous = JSON.parse(JSON.stringify(goal)) as GoalRecord;
    goal.progress = p;
    goal.lastProgressAt = this.now();
    goal.updatedAt = this.now();
    goal.version = (goal.version ?? 1) + 1;
    if (evidence.memoryId) {
      const ids = new Set([...(goal.relatedMemoryIds ?? []), evidence.memoryId]);
      goal.relatedMemoryIds = [...ids].slice(-GOAL_LIMITS.maxRelatedMemoryIds);
    }
    if (evidence.worldAssertionId) {
      const ids = new Set([...(goal.relatedWorldAssertionIds ?? []), evidence.worldAssertionId]);
      goal.relatedWorldAssertionIds = [...ids].slice(-GOAL_LIMITS.maxRelatedMemoryIds);
    }

    let transitioned: GoalLifecycle | null = null;
    if (p >= 1) {
      goal.status = "completed";
      transitioned = "completed";
    } else if (p > 0 && (goal.status === "active")) {
      goal.status = "progressing";
      transitioned = "progressing";
    }

    const saved = await this.persist(uid, goal);
    if (!saved) {
      this.cache.get(uid)!.goals.set(goalId, previous);
      return { ok: false, reason: "goal persistence failed — rolled back" };
    }
    await this.emit(uid, transitioned === "completed" ? "goal_completed" : "goal_progressed", {
      goalId,
      description: `progress ${Math.round(p * 100)}% (${evidence.source})`,
    });
    return { ok: true, goal };
  }

  // ── Dependencies (§8) ──

  async addDependency(uid: string, goalId: string, dependsOnGoalId: string): Promise<GoalOperationResult> {
    if (goalId === dependsOnGoalId) return { ok: false, reason: "self-dependency rejected" };
    const goals = await this.load(uid);
    const goal = goals.find((g) => g.id === goalId);
    const dep = goals.find((g) => g.id === dependsOnGoalId);
    if (!goal || !dep) return { ok: false, reason: "unknown goal in dependency" };
    if ((goal.dependsOn ?? []).length >= GOAL_LIMITS.maxDependencies) {
      return { ok: false, reason: `dependency limit reached (${GOAL_LIMITS.maxDependencies})` };
    }
    // Cycle check: DFS from dependsOn following dependsOn edges; reaching goalId → cycle.
    if (this.reaches(goals, dependsOnGoalId, goalId)) {
      return { ok: false, reason: "dependency cycle rejected" };
    }
    const previous = JSON.parse(JSON.stringify(goal)) as GoalRecord;
    goal.dependsOn = [...new Set([...(goal.dependsOn ?? []), dependsOnGoalId])];
    goal.updatedAt = this.now();
    goal.version = (goal.version ?? 1) + 1;
    const saved = await this.persist(uid, goal);
    if (!saved) {
      this.cache.get(uid)!.goals.set(goalId, previous);
      return { ok: false, reason: "goal persistence failed — rolled back" };
    }
    return { ok: true, goal };
  }

  private reaches(goals: GoalRecord[], fromId: string, targetId: string, seen = new Set<string>()): boolean {
    if (fromId === targetId) return true;
    if (seen.has(fromId)) return false;
    seen.add(fromId);
    const node = goals.find((g) => g.id === fromId);
    for (const next of node?.dependsOn ?? []) {
      if (this.reaches(goals, next, targetId, seen)) return true;
    }
    return false;
  }

  private depthOf(goals: GoalRecord[], goalId: string, depth = 0): number {
    if (depth > GOAL_LIMITS.maxDepth + 2) return depth; // defensive bound
    const goal = goals.find((g) => g.id === goalId);
    if (!goal?.parentGoalId) return depth;
    return this.depthOf(goals, goal.parentGoalId, depth + 1);
  }

  // ── Staleness (§14) ──

  async refreshStaleness(uid: string): Promise<string[]> {
    const goals = await this.load(uid);
    const now = this.now();
    const newlyStale: string[] = [];
    for (const goal of goals) {
      if (goal.status !== "active" && goal.status !== "progressing") continue;
      const idleDays = (now - Math.max(goal.lastProgressAt ?? 0, goal.updatedAt)) / DAY;
      if (idleDays > GOAL_STALE_DAYS) {
        const r = await this.transition(uid, goal.id, "stale", { reason: `no activity for ${Math.floor(idleDays)} days` });
        if (r.ok) newlyStale.push(goal.id);
      }
    }
    return newlyStale;
  }

  /** Reactivation when fresh evidence appears on a stale goal (§14). */
  async reactivate(uid: string, goalId: string, evidenceMemoryId?: string): Promise<GoalOperationResult> {
    const goals = await this.load(uid);
    const goal = goals.find((g) => g.id === goalId);
    if (!goal) return { ok: false, reason: "goal not found" };
    if (goal.status !== "stale") return { ok: false, reason: `reactivation applies to stale goals (got ${goal.status})` };
    if (evidenceMemoryId) {
      goal.relatedMemoryIds = [...new Set([...(goal.relatedMemoryIds ?? []), evidenceMemoryId])]
        .slice(-GOAL_LIMITS.maxRelatedMemoryIds);
    }
    return this.transition(uid, goalId, "active", { reason: "reactivated by fresh evidence" });
  }

  // ── Candidate derivation (§10–§12) ──

  async proposeFromEvidence(uid: string, inputs: CandidateInput[]): Promise<{
    proposed: GoalRecord[];
    reinforced: Array<{ goalId: string; relation: DuplicateCheck["relation"] }>;
    conflicts: Array<{ candidateTitle: string; existingId: string }>;
    dropped: number;
  }> {
    const goals = await this.load(uid);
    const recentTexts = inputs.map((i) => i.text);
    const bounded = inputs.slice(0, GOAL_LIMITS.maxCandidatesEvaluated);

    const proposed: GoalRecord[] = [];
    const reinforced: Array<{ goalId: string; relation: DuplicateCheck["relation"] }> = [];
    const conflicts: Array<{ candidateTitle: string; existingId: string }> = [];
    let dropped = 0;

    for (const input of bounded) {
      const candidate = scoreCandidate(input, goals, recentTexts, undefined, this.now());
      if (!candidate) { dropped++; continue; }

      const dup = checkDuplicate(candidate.title, goals);
      if (dup.relation === "exact" || dup.relation === "near") {
        const existing = goals.find((g) => g.id === dup.existingId)!;
        existing.repetitionCount = (existing.repetitionCount ?? 1) + 1;
        existing.confidence = clamp01(Math.max(existing.confidence ?? 0.5, candidate.confidence));
        existing.updatedAt = this.now();
        if (await this.persist(uid, existing)) {
          reinforced.push({ goalId: existing.id, relation: dup.relation });
        }
        continue;
      }
      if (dup.relation === "conflicting") {
        conflicts.push({ candidateTitle: candidate.title, existingId: dup.existingId! });
        continue;
      }
      // Related/child candidates attach evidence to the existing goal instead of creating noise.
      if (dup.relation === "related" || dup.relation === "child") {
        const existing = goals.find((g) => g.id === dup.existingId)!;
        if (candidate.evidenceMemoryIds[0]) {
          existing.relatedMemoryIds = [
            ...new Set([...(existing.relatedMemoryIds ?? []), candidate.evidenceMemoryIds[0]]),
          ].slice(-GOAL_LIMITS.maxRelatedMemoryIds);
          existing.updatedAt = this.now();
          await this.persist(uid, existing);
        }
        continue;
      }

      const created = await this.createGoal(uid, {
        title: candidate.title,
        description: candidate.description,
        source: "derived",
        relatedProjectKey: candidate.relatedProjectKey,
        evidenceMemoryIds: candidate.evidenceMemoryIds,
        confidence: candidate.confidence,
      });
      if (created.ok && created.goal) proposed.push(created.goal);
      else dropped++;
    }

    return { proposed, reinforced, conflicts, dropped };
  }

  // ── Attention + evaluation (§15, §18) — READ ONLY ──

  async evaluateGoals(uid: string): Promise<EvaluationResult> {
    const goals = await this.load(uid);
    const now = this.now();

    const items: EvaluationItem[] = [];
    let pendingProposals = 0;
    let conflictedCount = 0;

    for (const goal of goals) {
      if (goal.conflictWith?.length) conflictedCount++;
      if (goal.status === "proposed") pendingProposals++;
      if (["cancelled"].includes(goal.status)) continue;

      const { score } = attentionScore(goal, now);
      let recommendation: EvaluationItem["recommendation"] = "MAINTAIN";
      if (goal.status === "proposed") recommendation = "PROPOSE_CONFIRMATION";
      else if (goal.conflictWith?.length) recommendation = "REQUEST_CLARIFICATION";
      else if (goal.status === "blocked") recommendation = "REQUEST_CLARIFICATION";
      else if (goal.status === "stale") recommendation = "REACTIVATE_CANDIDATE";
      else if (goal.nextAction) recommendation = "UPDATE";

      items.push({
        goalId: goal.id,
        title: goal.title,
        status: goal.status,
        attention: score,
        recommendation,
      });
    }

    items.sort((a, b) => b.attention - a.attention);
    const top = items[0];

    const verdict: EvaluationResult["verdict"] =
      conflictedCount > 0 ? "REQUEST_CLARIFICATION"
      : pendingProposals > 0 ? "PROPOSE"
      : !top ? "WAIT"
      : top.recommendation === "UPDATE" ? "UPDATE"
      : top.attention < 0.35 ? "WAIT"
      : "MAINTAIN";

    return {
      verdict,
      items: items.slice(0, 20),
      pendingProposals,
      conflictedCount,
    };
  }

  /** Bounded nextAction setter — metadata only; nothing executes (§16). */
  async setNextAction(uid: string, goalId: string, action: string): Promise<GoalOperationResult> {
    const goals = await this.load(uid);
    const goal = goals.find((g) => g.id === goalId);
    if (!goal) return { ok: false, reason: "goal not found" };
    if (action.length > 140) return { ok: false, reason: "nextAction exceeds 140 chars" };
    const previous = JSON.parse(JSON.stringify(goal)) as GoalRecord;
    goal.nextAction = action;
    goal.updatedAt = this.now();
    goal.version = (goal.version ?? 1) + 1;
    const saved = await this.persist(uid, goal);
    if (!saved) {
      this.cache.get(uid)!.goals.set(goalId, previous);
      return { ok: false, reason: "goal persistence failed — rolled back" };
    }
    return { ok: true, goal };
  }

  /** Effective authority comparison helper exposed for tests/callers. */
  authorityOf(source: GoalSource): number {
    return SOURCE_AUTHORITY[source];
  }

  currentVerdictLabel(p: number): PriorityLevel {
    return levelFromPriority(p);
  }
}
