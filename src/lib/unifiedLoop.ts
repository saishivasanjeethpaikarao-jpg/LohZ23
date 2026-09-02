// ── Phase 19: Unified Autonomous Cognitive Architecture ──
// Composes the existing Phase 1-18 modules into one controlled loop:
// perception -> situation -> memory -> decision -> plan -> execute ->
// observe -> self-evaluate -> reflect -> learn -> update memory.
//
// This file is an integration layer only. Individual cognitive modules
// are reused unchanged.

import { EventBus, LoopEvent, LoopEventType, makeEvent } from "./unifiedEventBus";
import { SituationEngine } from "./situationEngine";
import type { SituationEvent, SituationState, SituationEventType } from "./situationTypes";
import { MemoryRetrieval } from "./memoryRetrieval";
import { Memory } from "./memoryTypes";
import {
  CognitiveState,
  DEFAULT_COGNITIVE_STATE,
  UnifiedCognitiveStatus,
} from "./cognitiveState";
import { DecisionEngine } from "./decisionEngine";
import { TaskPlanner, Plan } from "./taskPlanner";
import { SelfEvaluationEngine, Evaluation, TaskOutcome } from "./selfEvaluation";
import { ReflectionEngine } from "./reflectionEngine";
import { InterruptionController } from "./interruptionControl";
import { InteractionIntelligence } from "./interactionIntelligence";

// ── Public interfaces ──

export interface UnifiedLoopCallbacks {
  onSpeech?: (userId: string, text: string) => void;
  onToolUse?: (userId: string, tool: string, args: Record<string, unknown>) => void;
  onAsk?: (userId: string, question: string) => void;
  onEvaluation?: (userId: string, evaluation: Evaluation) => void;
  onMemoryUpdate?: (userId: string, memory: Memory) => void;
  getExistingMemories?: () => Promise<Memory[]>;
}

export interface UnifiedLoopConfig {
  speechCooldownMs: number;
  toolCooldownMs: number;
  reflectionCooldownMs: number;
  reflectionTurnThreshold: number;
  reflectionTimeoutMs: number;
  complexityWordThreshold: number;
  maxToolRepeats: number;
  toolRepeatWindowMs: number;
  autoProactive: boolean;
  proactiveIntervalMs: number;
}

export const DEFAULT_UNIFIED_LOOP_CONFIG: UnifiedLoopConfig = {
  speechCooldownMs: 2000,
  toolCooldownMs: 1000,
  reflectionCooldownMs: 300_000,
  reflectionTurnThreshold: 6,
  reflectionTimeoutMs: 10_000,
  complexityWordThreshold: 8,
  maxToolRepeats: 3,
  toolRepeatWindowMs: 30_000,
  autoProactive: true,
  proactiveIntervalMs: 30_000,
};

/** Injectable dependencies — lets hosts and tests swap engines without rewrites. */
export interface UnifiedLoopDependencies {
  bus?: EventBus;
  situations?: SituationEngine;
  retrieval?: MemoryRetrieval;
  decision?: DecisionEngine;
  planner?: TaskPlanner;
  evaluator?: SelfEvaluationEngine;
  reflector?: ReflectionEngine;
  interruption?: InterruptionController;
  intel?: InteractionIntelligence;
}

export interface ModelBudgetConfig {
  maxCallsPerMinute: number;
  maxCallsTotal: number;
}

export const DEFAULT_MODEL_BUDGET_CONFIG: ModelBudgetConfig = {
  maxCallsPerMinute: 20,
  maxCallsTotal: 200,
};

export interface ModelUsage {
  total: number;
  lastMinute: number;
  skippedOverBudget: number;
  reasons: string[];
}

/** Every model-backed step must pass through here with a reason. */
export class ModelBudgetTracker {
  private config: ModelBudgetConfig;
  private calls: Array<{ ts: number; reason: string }> = [];
  private skipped = 0;

  constructor(config: Partial<ModelBudgetConfig> = {}) {
    this.config = { ...DEFAULT_MODEL_BUDGET_CONFIG, ...config };
  }

  tryCall(reason: string): boolean {
    const now = Date.now();
    if (this.calls.length >= this.config.maxCallsTotal) {
      this.skipped++;
      return false;
    }
    const lastMinute = this.calls.filter((c) => now - c.ts < 60_000);
    if (lastMinute.length >= this.config.maxCallsPerMinute) {
      this.skipped++;
      return false;
    }
    this.calls.push({ ts: now, reason });
    return true;
  }

  usage(): ModelUsage {
    const now = Date.now();
    return {
      total: this.calls.length,
      lastMinute: this.calls.filter((c) => now - c.ts < 60_000).length,
      skippedOverBudget: this.skipped,
      reasons: this.calls.map((c) => c.reason),
    };
  }

  reset(): void {
    this.calls = [];
    this.skipped = 0;
  }
}

export interface LoopSnapshot {
  userId: string;
  conversationPhase: string;
  userActivity: string;
  currentTopic: string | null;
  userIntent: string | null;
  lastDecision: string;
  decisionReason: string;
  confidence: number;
  urgency: number;
  silenceDuration: number;
  pendingTasks: number;
  planStatus: string | null;
  status: UnifiedCognitiveStatus;
  modelUsage: ModelUsage;
  aborted: boolean;
  abortReason: string | null;
}

/**
 * Serializable per-user state for crash/restart recovery.
 * Phase 22 durable backends implement persistence on top of these
 * plain-JSON snapshots; the loop itself stays storage-agnostic.
 */
export interface UserStateSnapshot {
  userId: string;
  cognitiveState: CognitiveState;
  memories: Memory[];
  turnsSinceReflection: number;
  exportedAt: number;
}

interface PendingAction {
  userId: string;
  tool: string;
  startTs: number;
  intendedOutcome: string;
}

interface UserCooldowns {
  speech: number;
  tool: number;
  reflection: number;
}

const CORRECTION_PATTERNS = [
  "actually,", "that's not right", "you're wrong", "incorrect",
  "wrong,", "no, that's", "not quite", "i meant", "i said",
  "let me correct", "that's not what i meant",
];

const MAX_CONVERSATION = 50;
const MAX_TOOL_ACTIONS = 20;
const MAX_CONTEXT_SIGNALS = 20;

// ── The unified architecture ──

export class UnifiedCognitiveArchitecture {
  readonly bus: EventBus;
  private situations: SituationEngine;
  private retrieval: MemoryRetrieval;
  private decision: DecisionEngine;
  private planner: TaskPlanner;
  private evaluator: SelfEvaluationEngine;
  private reflector: ReflectionEngine;
  private interruption: InterruptionController;
  private intel: InteractionIntelligence;
  private budget: ModelBudgetTracker;
  private callbacks: UnifiedLoopCallbacks;
  private config: UnifiedLoopConfig;

  private states = new Map<string, CognitiveState>();
  private turnsSinceReflection = new Map<string, number>();
  private lastDecisions = new Map<string, { decision: string; reason: string }>();
  /** Cooldowns are strictly per-user so switching accounts never carries state. */
  private userCooldowns = new Map<string, UserCooldowns>();
  private toolLogs = new Map<string, Array<{ tool: string; ts: number }>>();
  private pendingActions = new Map<string, PendingAction>();
  private taskCounter = 0;

  private abortedFlag = false;
  private abortReason: string | null = null;
  private proactiveTimer: ReturnType<typeof setInterval> | null = null;
  private proactiveEnabled = true;
  private inflight: Promise<void> | null = null;

  constructor(
    callbacks: UnifiedLoopCallbacks = {},
    config: Partial<UnifiedLoopConfig> = {},
    deps: UnifiedLoopDependencies = {},
    budgetConfig: Partial<ModelBudgetConfig> = {}
  ) {
    this.callbacks = callbacks;
    this.config = { ...DEFAULT_UNIFIED_LOOP_CONFIG, ...config };
    this.bus = deps.bus ?? new EventBus();
    this.situations = deps.situations ?? new SituationEngine();
    this.retrieval = deps.retrieval ?? new MemoryRetrieval();
    this.decision = deps.decision ?? new DecisionEngine();
    this.planner = deps.planner ?? new TaskPlanner();
    this.evaluator = deps.evaluator ?? new SelfEvaluationEngine();
    this.reflector = deps.reflector ?? new ReflectionEngine();
    this.interruption = deps.interruption ?? new InterruptionController();
    this.intel = deps.intel ?? new InteractionIntelligence();
    this.budget = new ModelBudgetTracker(budgetConfig);

    this.bus.subscribe((event) => this.handleEvent(event));

    if (this.config.autoProactive) {
      this.proactiveTimer = setInterval(
        () => this.tickProactive(),
        this.config.proactiveIntervalMs
      );
    }
  }

  // ── Perception API ──

  submitText(text: string, userId: string = "default"): boolean {
    return this.emit(userId, "user_message", { text }, "user");
  }

  submitVoiceTranscript(text: string, userId: string = "default"): boolean {
    return this.emit(userId, "voice_transcript", { text }, "voice");
  }

  reportSilence(durationMs: number, userId: string = "default"): boolean {
    return this.emit(userId, "silence", { durationMs }, "system");
  }

  reportToolStarted(tool: string, userId: string = "default"): boolean {
    return this.emit(userId, "tool_started", { tool }, "tool");
  }

  reportToolResult(
    tool: string,
    result: unknown,
    success: boolean,
    userId: string = "default"
  ): boolean {
    return this.emit(userId, "tool_result", { tool, result, success }, "tool");
  }

  reportGoalChange(
    action: "created" | "updated" | "completed" | "failed",
    goals: unknown[],
    userId: string = "default"
  ): boolean {
    return this.emit(userId, "goal_change", { action, goals }, "system");
  }

  reportError(message: string, userId: string = "default"): boolean {
    return this.emit(userId, "error", { message }, "system");
  }

  ingestMemory(memory: Memory): boolean {
    return this.emit(memory.metadata.userId, "memory_update", { memory }, "system");
  }

  reportTaskCompleted(
    taskId: string,
    description: string,
    success: boolean = true,
    userId: string = "default"
  ): boolean {
    return this.emit(userId, "task_completed", { taskId, description, success }, "system");
  }

  addPendingTask(description: string, priority: number = 1, userId: string = "default"): string {
    this.taskCounter += 1;
    const id = `task_${Date.now()}_${this.taskCounter}`;
    const state = this.getStateFor(userId);
    const now = Date.now();
    state.pendingTasks.push({
      id,
      description,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      priority,
    });
    return id;
  }

  completePendingTask(taskId: string, success: boolean = true, userId: string = "default"): void {
    const state = this.getStateFor(userId);
    const task = state.pendingTasks.find((t) => t.id === taskId);
    if (!task) return;
    task.status = "completed";
    task.updatedAt = Date.now();
    this.evaluateAndLearn(userId, taskId, task.description, success, []);
    this.scheduleReflection(userId, "task_completion");
  }

  /** Convenience hook for controlled ACT dispatch (used by tests and hosts). */
  requestTool(tool: string, intendedOutcome: string, userId: string = "default"): boolean {
    return this.dispatchTool(userId, tool, intendedOutcome);
  }

  /** Explicit planning entry point. Returns null when an active plan already exists. */
  createGoalPlan(goal: string, userId: string = "default"): Plan | null {
    if (this.abortedFlag || goal.trim().length === 0) return null;
    if (this.planner.getActivePlan(userId)) return null;
    return this.planner.createPlan(userId, goal);
  }

  setUser(userId: string): void {
    this.intel.setUserId(userId);
  }

  updateInteractionPreferences(
    updates: Partial<import("./userPreferences").UserInteractionPreferences>,
    userId: string = "default"
  ): void {
    this.intel.updatePreferences(userId, updates);
  }

  setProactiveEnabled(enabled: boolean): void {
    this.proactiveEnabled = enabled;
  }

  // ── Introspection ──

  getCognitiveState(userId: string = "default"): CognitiveState {
    return this.getStateFor(userId);
  }

  getSituation(userId: string = "default"): SituationState {
    return this.situations.getState(userId);
  }

  getMemories(query: Parameters<MemoryRetrieval["query"]>[0]) {
    return this.retrieval.query(query);
  }

  snapshot(userId: string = "default"): LoopSnapshot {
    const sit = this.getSituation(userId);
    const state = this.getCognitiveState(userId);
    const lastDecision = this.lastDecisions.get(userId) ?? { decision: "NONE", reason: "" };
    const activePlan = this.planner.getActivePlan(userId);
    return {
      userId,
      conversationPhase: sit.conversationPhase,
      userActivity: sit.userActivity,
      currentTopic: state.currentTopic,
      userIntent: state.userIntent,
      lastDecision: lastDecision.decision,
      decisionReason: lastDecision.reason,
      confidence: state.confidence,
      urgency: state.urgency,
      silenceDuration: state.silenceDuration,
      pendingTasks: state.pendingTasks.filter(
        (t) => t.status === "pending" || t.status === "in_progress"
      ).length,
      planStatus: activePlan ? activePlan.status : null,
      status: this.getStatusForState(state),
      modelUsage: this.budget.usage(),
      aborted: this.abortedFlag,
      abortReason: this.abortReason,
    };
  }

  getBudgetUsage(): ModelUsage {
    return this.budget.usage();
  }

  isAborted(): boolean {
    return this.abortedFlag;
  }

  abort(reason: string = "manual abort"): void {
    this.abortedFlag = true;
    this.abortReason = reason;
  }

  resume(): void {
    this.abortedFlag = false;
    this.abortReason = null;
  }

  tickProactive(): void {
    if (!this.proactiveEnabled) return;
    for (const userId of [...this.states.keys()]) {
      this.checkProactiveForUser(userId);
    }
  }

  whenIdle(): Promise<void> {
    return this.inflight ?? Promise.resolve();
  }

  dispose(): void {
    if (this.proactiveTimer) {
      clearInterval(this.proactiveTimer);
      this.proactiveTimer = null;
    }
  }

  // ── Crash-safety seam (Phase 22 durable backends build on this) ──

  exportSnapshot(userId: string = "default"): UserStateSnapshot | null {
    const state = this.states.get(userId);
    if (!state) return null;
    return {
      userId,
      cognitiveState: structuredCloneState(state),
      memories: this.retrieval.query({ userId, limit: 10000 }).map((r) => r.memory),
      turnsSinceReflection: this.turnsSinceReflection.get(userId) ?? 0,
      exportedAt: Date.now(),
    };
  }

  exportAllSnapshots(): UserStateSnapshot[] {
    return [...this.states.keys()]
      .map((userId) => this.exportSnapshot(userId))
      .filter((s): s is UserStateSnapshot => s !== null);
  }

  restoreSnapshot(snapshot: UserStateSnapshot): boolean {
    if (!snapshot || typeof snapshot.userId !== "string" || !snapshot.cognitiveState) {
      return false;
    }
    this.states.set(snapshot.userId, structuredCloneState(snapshot.cognitiveState));
    if (typeof snapshot.turnsSinceReflection === "number") {
      this.turnsSinceReflection.set(snapshot.userId, snapshot.turnsSinceReflection);
    }
    for (const memory of snapshot.memories ?? []) {
      if (memory && memory.id && memory.metadata) {
        this.retrieval.addMemory(memory);
      }
    }
    return true;
  }

  reset(): void {
    this.states.clear();
    this.turnsSinceReflection.clear();
    this.lastDecisions.clear();
    this.userCooldowns.clear();
    this.toolLogs.clear();
    this.pendingActions.clear();
    this.abortedFlag = false;
    this.abortReason = null;
    this.bus.reset();
    this.budget.reset();
    this.retrieval = new MemoryRetrieval();
    this.decision.reset();
    this.evaluator.reset();
    this.reflector.reset();
    this.intel.reset();
  }

  // ── Pipeline stages ──

  /** Invoke an external callback, isolating host-subsystem failures from the loop. */
  private safeInvoke(
    name: "onSpeech" | "onToolUse" | "onAsk" | "onEvaluation" | "onMemoryUpdate",
    ...args: unknown[]
  ): void {
    const cb = this.callbacks[name] as ((...a: unknown[]) => void) | undefined;
    if (!cb) return;
    try {
      cb(...args);
    } catch {
      // External subsystem failure (TTS, persistence, tools…) must not crash the loop.
    }
  }

  private processSituation(
    userId: string,
    type: SituationEventType,
    payload: unknown,
    timestamp: number
  ): void {
    const event: SituationEvent = { type, payload, timestamp, userId };
    this.situations.processEvent(event);
  }

  private emit(
    userId: string,
    type: LoopEventType,
    payload: unknown,
    source: LoopEvent["source"]
  ): boolean {
    return this.bus.publish(makeEvent({ userId, type, payload, source }));
  }

  private getStateFor(userId: string): CognitiveState {
    let state = this.states.get(userId);
    if (!state) {
      state = structuredCloneState(DEFAULT_COGNITIVE_STATE);
      state.lastUserActivity = Date.now();
      state.status = "UNCERTAIN";
      this.states.set(userId, state);
    }
    return state;
  }

  private getStatusForState(state: CognitiveState): UnifiedCognitiveStatus {
    const recent = state.workingMemory.recentToolActions;
    if (recent.some((a) => !a.success)) return "FAILED";
    if (state.pendingTasks.some((task) => task.status === "blocked")) return "BLOCKED";
    const text = state.workingMemory.currentConversation
      .map((turn) => turn.content)
      .join(" ")
      .toLowerCase();
    if (/(not enough evidence|don't have enough evidence|insufficient evidence|need more info|need clarification|uncertain)/i.test(text)) {
      return "UNCERTAIN";
    }
    if (state.workingMemory.currentConversation.some((turn) => turn.role === "assistant")) {
      return "SUCCESS";
    }
    return state.status ?? "UNCERTAIN";
  }

  private updateStatus(userId: string, state: CognitiveState): void {
    const next = this.getStatusForState(state);
    state.status = next;
    this.lastDecisions.set(userId, {
      decision: this.lastDecisions.get(userId)?.decision ?? "LISTEN",
      reason: this.lastDecisions.get(userId)?.reason ?? "authoritative lifecycle update",
    });
  }

  private cooldownsFor(userId: string): UserCooldowns {
    let cd = this.userCooldowns.get(userId);
    if (!cd) {
      cd = { speech: 0, tool: 0, reflection: 0 };
      this.userCooldowns.set(userId, cd);
    }
    return cd;
  }

  private handleEvent(event: LoopEvent): void {
    if (this.abortedFlag) return;
    try {
      const state = this.getStateFor(event.userId);
      switch (event.type) {
        case "user_message":
        case "voice_transcript":
          this.onUserUtterance(event, state, event.type === "voice_transcript");
          break;
        case "silence":
          this.onSilence(event, state);
          break;
        case "tool_started":
          this.processSituation(event.userId, "TOOL_STARTED", event.payload, event.timestamp);
          break;
        case "tool_result":
          this.onToolResult(event, state);
          break;
        case "goal_change":
          this.onGoalChange(event, state);
          break;
        case "memory_update": {
          const payload = event.payload as { memory: Memory };
          this.learnMemory(payload.memory);
          break;
        }
        case "error":
          state.urgency = Math.min(1, state.urgency + 0.3);
          this.scheduleReflection(event.userId, "error");
          break;
        case "external_event":
          state.workingMemory.contextSignals.push({
            type: "screen_change",
            value: event.payload,
            timestamp: event.timestamp,
          });
          trim(state.workingMemory.contextSignals, MAX_CONTEXT_SIGNALS);
          break;
        case "speech_start":
          state.lastLohzSpeech = event.timestamp;
          break;
        case "speech_end":
          this.processSituation(event.userId, "LOHZ_RESPONSE", { description: "spoke" }, event.timestamp);
          break;
        case "task_completed": {
          const payload = event.payload as { taskId: string; description: string; success?: boolean };
          this.evaluateAndLearn(
            event.userId,
            payload.taskId,
            payload.description,
            payload.success ?? true,
            []
          );
          this.scheduleReflection(event.userId, "task_completion");
          break;
        }
      }
    } catch {
      // A malformed payload must never crash the loop.
    }
  }

  private onUserUtterance(event: LoopEvent, state: CognitiveState, isVoice: boolean): void {
    const text = (event.payload as { text?: string })?.text ?? "";
    if (typeof text !== "string" || text.trim().length === 0) return;

    const now = event.timestamp;
    state.lastUserActivity = now;
    state.silenceDuration = 0;
    state.conversationState = "active";
    state.workingMemory.currentConversation.push({
      role: "user",
      content: text,
      timestamp: now,
    });
    trim(state.workingMemory.currentConversation, MAX_CONVERSATION);

    this.processSituation(
      event.userId,
      isVoice ? "USER_SPEECH" : "USER_MESSAGE",
      { text },
      now
    );
    const sit = this.situations.getState(event.userId);
    state.currentTopic = sit.currentTopic;
    state.userIntent = sit.userIntent;
    state.status = /(?:not enough evidence|don't have enough evidence|insufficient evidence|need more info|need clarification|uncertain)/i.test(text)
      ? "UNCERTAIN"
      : "SUCCESS";

    this.retrieveRelevantMemories(event.userId, state);

    const turns = (this.turnsSinceReflection.get(event.userId) ?? 0) + 1;
    this.turnsSinceReflection.set(event.userId, turns);

    if (isExplicitCorrection(text)) {
      this.scheduleReflection(event.userId, "user_correction");
    } else if (turns >= this.config.reflectionTurnThreshold) {
      this.turnsSinceReflection.set(event.userId, 0);
      this.scheduleReflection(event.userId, "conversation_segment");
    }

    this.runDecisionCycle(event.userId, state);
  }

  private retrieveRelevantMemories(userId: string, state: CognitiveState): void {
    const query = [state.currentTopic, state.userIntent]
      .filter((v): v is string => typeof v === "string")
      .join(" ");
    const results = this.retrieval.query({ userId, query, limit: 5 });
    state.relevantMemories = results.map((r) => ({
      id: r.memory.id,
      layer: r.memory.layer,
      content: r.memory.text,
      relevance: r.score,
      metadata: r.memory.metadata,
    }));
  }

  private onSilence(event: LoopEvent, state: CognitiveState): void {
    const duration = (event.payload as { durationMs?: number })?.durationMs ?? 0;
    state.silenceDuration += duration;
    this.processSituation(event.userId, "SILENCE", {}, event.timestamp);
  }

  private onGoalChange(event: LoopEvent, state: CognitiveState): void {
    const payload = event.payload as { action: string; goals: unknown[] };
    const map: Record<string, SituationEventType> = {
      created: "GOAL_CREATED",
      updated: "GOAL_UPDATED",
      completed: "GOAL_COMPLETED",
      failed: "GOAL_UPDATED",
    };
    this.processSituation(event.userId, map[payload.action] ?? "GOAL_UPDATED", payload, event.timestamp);
    const goals = payload.goals as Array<{ title?: string; status?: string }>;
    const active = goals.find((g) => g.status === "active");
    state.activeGoal = active?.title ?? null;
  }

  private onToolResult(event: LoopEvent, state: CognitiveState): void {
    const payload = event.payload as { tool: string; result: unknown; success: boolean };
    state.workingMemory.recentToolActions.push({
      tool: payload.tool,
      args: {},
      result: payload.result,
      timestamp: event.timestamp,
      success: payload.success,
    });
    trim(state.workingMemory.recentToolActions, MAX_TOOL_ACTIONS);

    this.processSituation(
      event.userId,
      payload.success ? "TOOL_COMPLETED" : "TOOL_FAILED",
      { tool: payload.tool, success: payload.success },
      event.timestamp
    );
    state.status = payload.success ? "SUCCESS" : "FAILED";

    // Observe the real result — never assume success.
    this.rememberObservation(event.userId, payload.tool, payload.success);

    if (this.pendingActions.get(event.userId) &&
        this.pendingActions.get(event.userId)!.userId === event.userId &&
        this.pendingActions.get(event.userId)!.tool === payload.tool) {
      const action = this.pendingActions.get(event.userId)!;
      this.pendingActions.delete(event.userId);
      this.evaluateAndLearn(
        event.userId,
        `act_${action.startTs}`,
        action.intendedOutcome,
        payload.success,
        [payload.tool],
        action.startTs
      );
      if (!payload.success) this.scheduleReflection(event.userId, "tool_failure");
    } else if (!payload.success) {
      this.scheduleReflection(event.userId, "tool_failure");
    }
  }

  private rememberObservation(userId: string, tool: string, success: boolean): void {
    const now = Date.now();
    this.learnMemory({
      id: `obs_${now}_${Math.random().toString(36).slice(2, 8)}`,
      layer: "episodic",
      category: "fact",
      text: `Tool ${tool} ${success ? "completed" : "failed"} for ${userId}`,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      metadata: {
        importance: success ? 0.4 : 0.6,
        confidence: 0.9,
        source: "tool_result",
        timestamp: now,
        lastAccessed: now,
        lastReinforced: now,
        category: "fact",
        relationships: [],
        userId,
      },
    });
  }

  // ── Decision + execution ──

  private runDecisionCycle(userId: string, state: CognitiveState): void {
    if (this.abortedFlag) return;
    const reason = this.decision.evaluate(state);
    this.lastDecisions.set(userId, { decision: reason.decision, reason: reason.reason });
    state.confidence = reason.confidence;

    switch (reason.decision) {
      case "SPEAK":
        this.attemptSpeak(userId, state);
        break;
      case "ACT": {
        const goal = state.workingMemory.activeTask ?? state.currentTopic ?? "user request";
        const firstStepTool = this.planIfComplex(userId, goal, state);
        if (firstStepTool) {
          this.dispatchTool(userId, firstStepTool, `Plan step: ${goal}`);
        } else {
          this.dispatchTool(userId, "web_search", `Help with: ${goal}`);
        }
        break;
      }
      case "ASK": {
        const topic = state.currentTopic ?? "your request";
        this.attemptAsk(userId, `Could you clarify: ${topic}?`);
        break;
      }
      default:
        break;
    }
  }

  /** Create a plan when the request looks complex; returns the first tool to run. */
  private planIfComplex(userId: string, goal: string, state: CognitiveState): string | null {
    const words = goal.split(/\s+/).length;
    const existing = this.planner.getActivePlan(userId);
    if (existing) return pickFirstTool(existing);
    if (words < this.config.complexityWordThreshold && !state.userIntent) return null;
    const plan: Plan = this.planner.createPlan(userId, goal);
    return pickFirstTool(plan);
  }

  private dispatchTool(userId: string, tool: string, intendedOutcome: string): boolean {
    if (this.abortedFlag || !tool) return false;
    const now = Date.now();
    if (now - this.cooldownsFor(userId).tool < this.config.toolCooldownMs) return false;
    if (this.isRepeatedTool(userId, tool, now)) return false;

    this.safeInvoke("onToolUse", userId, tool, {});
    this.cooldownsFor(userId).tool = now;
    const log = this.toolLogs.get(userId) ?? [];
    log.push({ tool, ts: now });
    this.toolLogs.set(userId, log);
    this.pendingActions.set(userId, { userId, tool, startTs: now, intendedOutcome });
    return true;
  }

  private isRepeatedTool(userId: string, tool: string, now: number): boolean {
    const log = (this.toolLogs.get(userId) ?? []).filter(
      (e) => now - e.ts < this.config.toolRepeatWindowMs
    );
    this.toolLogs.set(userId, log);
    const repeats = log.filter((e) => e.tool === tool).length;
    return repeats >= this.config.maxToolRepeats;
  }

  private attemptSpeak(userId: string, state: CognitiveState): void {
    const now = Date.now();
    if (now - this.cooldownsFor(userId).speech < this.config.speechCooldownMs) return;

    const raw = this.composeSpeech(userId, state);
    if (!raw) return;

    const filtered = this.intel.filterSpeech(raw, state);
    if (!filtered.approved) return; // repeated speech / fillers blocked here

    this.deliverSpeech(userId, filtered.text, now);
  }

  private attemptAsk(userId: string, question: string): void {
    const now = Date.now();
    if (now - this.cooldownsFor(userId).speech < this.config.speechCooldownMs) return;
    const state = this.getStateFor(userId);
    const filtered = this.intel.filterSpeech(question, state);
    if (!filtered.approved) return;
    this.cooldownsFor(userId).speech = now;
    this.safeInvoke("onAsk", userId, filtered.text);
  }

  private composeSpeech(userId: string, state: CognitiveState): string | null {
    const pending = state.pendingTasks.find(
      (t) => t.status === "pending" || t.status === "in_progress"
    );
    if (pending) return `Working on it: ${pending.description}`;

    const lastUser = [...state.workingMemory.currentConversation]
      .reverse()
      .find((t) => t.role === "user");
    if (!lastUser) return null;

    const topic = state.currentTopic;
    if (state.userIntent === "question") {
      return topic ? `Checking into: ${topic}` : null;
    }
    return topic ? `Noted. Focusing on: ${topic}` : null;
  }

  private deliverSpeech(userId: string, text: string, now: number): void {
    this.safeInvoke("onSpeech", userId, text);
    const state = this.getStateFor(userId);
    state.lastLohzSpeech = now;
    this.cooldownsFor(userId).speech = now;
    state.workingMemory.currentConversation.push({
      role: "assistant",
      content: text,
      timestamp: now,
    });
    trim(state.workingMemory.currentConversation, MAX_CONVERSATION);
    state.status = "SUCCESS";
    this.processSituation(userId, "LOHZ_RESPONSE", { description: text }, now);
  }

  // ── Proactive speech ──

  private checkProactiveForUser(userId: string): void {
    if (this.abortedFlag || this.bus.getQueueSize() > 0) return;
    const state = this.getStateFor(userId);

    const decision = this.intel.evaluateProactive(state);
    if (!decision.shouldSpeak) return;

    const now = Date.now();
    const check = this.interruption.checkSafe({
      userIsTyping: false,
      userIsSpeaking: false,
      lohzRecentlySpoke: now - state.lastLohzSpeech < 3000,
      lohzSpeechTimestamp: state.lastLohzSpeech,
      activeTaskInProgress: state.workingMemory.activeTask !== null,
      timeSinceLastUserActivity: now - state.lastUserActivity,
      conversationState: state.conversationState,
    });
    if (!check.safe) return;

    const pending = state.pendingTasks.find(
      (t) => t.status === "pending" || t.status === "in_progress"
    );
    const raw = pending ? `Still working on: ${pending.description}` : null;
    if (!raw) return;

    const filtered = this.intel.filterSpeech(raw, state);
    if (!filtered.approved) return;
    if (now - this.cooldownsFor(userId).speech < this.config.speechCooldownMs) return;

    this.deliverSpeech(userId, filtered.text, now);
  }

  // ── Self-evaluation → learning ──

  private evaluateAndLearn(
    userId: string,
    taskId: string,
    description: string,
    success: boolean,
    tools: string[],
    startTs: number = Date.now()
  ): void {
    const state = this.getStateFor(userId);
    const outcome: TaskOutcome = {
      taskId,
      userId,
      intendedOutcome: description,
      actualOutcome: success ? `Completed: ${description}` : `Failed: ${description}`,
      success,
      confidence: state.confidence,
      timestamp: Date.now(),
      toolPerformance: tools.length > 0 ? {
        toolName: tools[0],
        success,
        latencyMs: Date.now() - startTs,
        retryCount: tools.length - 1,
      } : undefined,
    };
    const evaluation = this.evaluator.evaluateOutcome(outcome);
    this.emitEvaluation(userId, evaluation);
  }

  private emitEvaluation(userId: string, evaluation: Evaluation): void {
    this.safeInvoke("onEvaluation", userId, evaluation);

    if (evaluation.reflectionInsight) {
      this.learnMemory(normalizeToMemory(
        { ...(evaluation.reflectionInsight as unknown as Record<string, unknown>), id: `eval_${evaluation.id}` },
        userId,
        "strategy"
      ));
    }
    if (evaluation.memoryCandidates) {
      for (const candidate of evaluation.memoryCandidates) {
        this.learnMemory(normalizeToMemory(candidate as unknown as Record<string, unknown>, userId));
      }
    }
  }

  // ── Reflection ──

  private scheduleReflection(userId: string, trigger: string): void {
    if (this.abortedFlag) return;
    const now = Date.now();
    if (now - this.cooldownsFor(userId).reflection < this.config.reflectionCooldownMs) return;
    this.cooldownsFor(userId).reflection = now;

    const run = this.runReflection(userId, trigger)
      .catch(() => { /* reflection failure never crashes the loop */ })
      .finally(() => { this.inflight = null; });
    this.inflight = run;
  }

  private async runReflection(userId: string, trigger: string): Promise<void> {
    if (!this.budget.tryCall(`reflection:${trigger}`)) return;

    const state = this.getStateFor(userId);
    const conversation = state.workingMemory.currentConversation.slice(-30);
    if (conversation.length < 4) return;

    let existingMemories: Memory[] = [];
    try {
      const fetch = this.callbacks.getExistingMemories?.() ?? Promise.resolve([]);
      existingMemories = await withTimeout(fetch, this.config.reflectionTimeoutMs);
    } catch {
      // proceed with empty memories
    }

    const result = await withTimeout(
      this.reflector.reflect(conversation, existingMemories, userId, `ref-${Date.now()}`),
      this.config.reflectionTimeoutMs
    );

    if (result) {
      for (const update of result.memoryUpdates) {
        this.learnMemory(normalizeToMemory(update as unknown as Record<string, unknown>, userId));
      }
    }
  }

  // ── Learning / memory updates ──

  private learnMemory(memory: Memory): void {
    if (!memory || !memory.id) return;
    if (!memory.metadata || typeof memory.metadata.userId !== "string") return;
    this.retrieval.addMemory(memory);
    this.safeInvoke("onMemoryUpdate", memory.metadata.userId, memory);
  }
}

// ── Helpers ──

function structuredCloneState(state: CognitiveState): CognitiveState {
  return JSON.parse(JSON.stringify(state)) as CognitiveState;
}

function trim<T>(arr: T[], max: number): void {
  if (arr.length > max) arr.splice(0, arr.length - max);
}

function pickFirstTool(plan: Plan): string | null {
  const step = plan.steps.find(
    (s) => s.status === "pending" && s.toolRequired && !s.requiresConfirmation
  );
  return step?.toolRequired ?? null;
}

function isExplicitCorrection(text: string): boolean {
  const lower = text.toLowerCase();
  return CORRECTION_PATTERNS.some((p) => lower.includes(p));
}

function normalizeToMemory(
  raw: Record<string, unknown>,
  userId: string,
  fallbackCategory: Memory["category"] = "concept"
): Memory {
  const now = Date.now();
  const meta = (raw.metadata ?? {}) as Partial<Memory["metadata"]>;
  const category = (raw.category as Memory["category"]) ?? fallbackCategory;
  return {
    id: (raw.id as string) ?? `mem_${now}_${Math.random().toString(36).slice(2, 8)}`,
    layer: (raw.layer as Memory["layer"]) ?? "semantic",
    category,
    text: (raw.text as string) ?? (raw.content as string) ?? "",
    createdAt: (raw.createdAt as string) ?? new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    metadata: {
      importance: meta.importance ?? 0.5,
      confidence: meta.confidence ?? 0.6,
      source: (meta.source as Memory["metadata"]["source"]) ?? "reflection",
      timestamp: meta.timestamp ?? now,
      lastAccessed: meta.lastAccessed ?? now,
      lastReinforced: meta.lastReinforced ?? now,
      category: meta.category ?? String(category),
      relationships: meta.relationships ?? [],
      userId: meta.userId ?? userId,
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}
