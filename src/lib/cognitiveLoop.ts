import {
  CognitiveState,
  CognitiveEvent,
  CognitiveDecision,
  DEFAULT_COGNITIVE_STATE,
} from "./cognitiveState";
import { DecisionEngine } from "./decisionEngine";
import { MemoryConsolidation } from "./memoryConsolidation";
import { ProactiveSpeechPolicy } from "./proactiveSpeech";
import { ReflectionEngine } from "./reflectionEngine";
import { GoalSystem } from "./goalSystem";
import { ToolDecisionEngine } from "./toolDecisionEngine";
import { Memory } from "./memoryTypes";
import { SelfEvaluationEngine, Evaluation, TaskOutcome } from "./selfEvaluation";
import { InteractionIntelligence, InteractionDecision } from "./interactionIntelligence";
import { InteractionMode } from "./interactionModes";

export interface CognitiveLoopCallbacks {
  onSpeech: (text: string) => void;
  onToolUse: (tool: string, args: Record<string, unknown>) => void;
  onMemoryUpdate: (key: string, value: unknown) => void;
  onStateChanged: (state: CognitiveState) => void;
  onTranscription: (role: "user" | "assistant", text: string) => void;
  onEvaluation?: (evaluation: Evaluation) => void;
  getExistingMemories: () => Promise<Memory[]>;
}

const MAX_CONVERSATION = 50;
const MAX_CONTEXT_SIGNALS = 20;
const MAX_TOOL_ACTIONS = 20;
const CONSOLIDATION_DEBOUNCE_MS = 1000;
const STATE_TICK_INTERVAL_MS = 200;

export class CognitiveLoop {
  private state: CognitiveState = { ...DEFAULT_COGNITIVE_STATE };
  private engine: DecisionEngine;
  private consolidation: MemoryConsolidation;
  private proactiveSpeech: ProactiveSpeechPolicy;
  private reflection: ReflectionEngine;
  private goalSystem: GoalSystem;
  private toolEngine: ToolDecisionEngine;
  private selfEvaluation: SelfEvaluationEngine;
  private interactionIntel: InteractionIntelligence;
  private callbacks: CognitiveLoopCallbacks;
  private userId: string;
  private eventQueue: CognitiveEvent[] = [];
  private processing = false;
  private cooldowns = {
    decision: 0,
    speech: 0,
    memory: 0,
    tool: 0,
    reflection: 0,
    evaluation: 0,
  };
  private readonly COOLDOWN = {
    decision: 500,
    speech: 2000,
    memory: 1000,
    tool: 3000,
    reflection: 300000,
    evaluation: 5000,
  };

  private consolidationTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingConsolidationTurns: Array<{ role: "user" | "assistant"; content: string; timestamp: number }> = [];
  private stateCache: CognitiveState | null = null;
  private stateDirty = true;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private turnsSinceLastReflection = 0;
  private reflectionScheduled = false;
  private reflectionTimer: ReturnType<typeof setTimeout> | null = null;
  private proactiveTimer: ReturnType<typeof setInterval> | null = null;
  private proactiveEnabled = true;
  private readonly PROACTIVE_INTERVAL_MS = 30000;
  private pendingTaskOutcomes: Map<string, { intendedOutcome: string; startTime: number; toolCalls: string[] }> = new Map();

  constructor(callbacks: CognitiveLoopCallbacks, userId: string = "default") {
    this.callbacks = callbacks;
    this.userId = userId;
    this.engine = new DecisionEngine();
    this.consolidation = new MemoryConsolidation();
    this.proactiveSpeech = new ProactiveSpeechPolicy();
    this.reflection = new ReflectionEngine();
    this.goalSystem = new GoalSystem();
    this.toolEngine = new ToolDecisionEngine();
    this.selfEvaluation = new SelfEvaluationEngine();
    this.interactionIntel = new InteractionIntelligence();
    this.interactionIntel.setUserId(this.userId);
    this.tickTimer = setInterval(() => this.flushConsolidation(), STATE_TICK_INTERVAL_MS);
    this.proactiveTimer = setInterval(() => this.checkProactiveSpeech(), this.PROACTIVE_INTERVAL_MS);
  }

  getState(): CognitiveState {
    if (this.stateDirty || !this.stateCache) {
      this.stateCache = { ...this.state };
      this.stateDirty = false;
    }
    return this.stateCache;
  }

  setUserId(userId: string): void {
    this.userId = userId;
    this.interactionIntel.setUserId(userId);
  }

  setProactiveEnabled(enabled: boolean): void {
    this.proactiveEnabled = enabled;
  }

  dispatch(event: CognitiveEvent): void {
    this.eventQueue.push(event);
    this.processEvent(event);
    if (!this.processing) {
      this.processLoop();
    }
  }

  private trimArray<T>(arr: T[], max: number): T[] {
    if (arr.length > max) {
      return arr.slice(arr.length - max);
    }
    return arr;
  }

  private processEvent(event: CognitiveEvent): void {
    const now = Date.now();
    this.state.lastUserActivity = now;
    this.stateDirty = true;

    if (event.significance === "critical") {
      this.state.urgency = Math.min(this.state.urgency + 0.3, 1.0);
    } else if (event.significance === "high") {
      this.state.urgency = Math.min(this.state.urgency + 0.15, 1.0);
    } else if (event.significance === "medium") {
      this.state.urgency = Math.min(this.state.urgency + 0.05, 1.0);
    }

    switch (event.type) {
      case "user_message": {
        const payload = event.payload as { text: string; role: "user" | "assistant" };
        this.state.workingMemory.currentConversation.push({
          role: payload.role,
          content: payload.text,
          timestamp: event.timestamp,
        });
        this.state.workingMemory.currentConversation = this.trimArray(
          this.state.workingMemory.currentConversation,
          MAX_CONVERSATION
        );
        this.state.silenceDuration = 0;
        this.state.conversationState = "active";
        this.enqueueConsolidation(payload.role, payload.text, event.timestamp);
        break;
      }
      case "voice_transcript": {
        const payload = event.payload as { text: string; role: "user" | "assistant" };
        this.state.workingMemory.currentConversation.push({
          role: payload.role,
          content: payload.text,
          timestamp: event.timestamp,
        });
        this.state.workingMemory.currentConversation = this.trimArray(
          this.state.workingMemory.currentConversation,
          MAX_CONVERSATION
        );
        this.state.silenceDuration = 0;
        this.enqueueConsolidation(payload.role, payload.text, event.timestamp);
        break;
      }
      case "meaningful_silence": {
        this.state.silenceDuration += event.payload as number;
        break;
      }
      case "tool_result": {
        const payload = event.payload as { tool: string; result: unknown; success: boolean };
        this.state.workingMemory.recentToolActions.push({
          tool: payload.tool,
          args: {},
          result: payload.result,
          timestamp: event.timestamp,
          success: payload.success,
        });
        this.state.workingMemory.recentToolActions = this.trimArray(
          this.state.workingMemory.recentToolActions,
          MAX_TOOL_ACTIONS
        );
        // Track tool calls for pending task evaluation
        this.trackToolCall(payload.tool, payload.success);
        break;
      }
      case "task_completion": {
        const payload = event.payload as { taskId: string; description: string; success?: boolean };
        this.goalSystem.completeTask(payload.taskId);
        this.evaluateTaskCompletion(payload.taskId, payload.description, payload.success ?? true);
        break;
      }
      case "speech_start": {
        this.state.lastLohzSpeech = event.timestamp;
        this.state.conversationState = "active";
        break;
      }
      case "speech_end": {
        break;
      }
      case "app_state_change": {
        const payload = event.payload as { active: boolean };
        this.state.workingMemory.contextSignals.push({
          type: "app_focus",
          value: payload.active,
          timestamp: event.timestamp,
        });
        this.state.workingMemory.contextSignals = this.trimArray(
          this.state.workingMemory.contextSignals,
          MAX_CONTEXT_SIGNALS
        );
        break;
      }
      case "scheduled_reflection": {
        this.runReflection();
        break;
      }
    }

    // Feed event into interaction intelligence for mode tracking
    this.interactionIntel.processEvent(event, this.state);

    this.callbacks.onStateChanged(this.getState());

    // Check reflection triggers after every event
    this.checkReflectionTriggers(event);

    // Check for user corrections and process feedback
    this.checkUserFeedback(event);
  }

  private async processLoop(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.eventQueue.length > 0) {
      const event = this.eventQueue.shift()!;
      const decision = this.evaluateDecision();
      await this.executeDecision(decision);
      this.decayUrgency();
    }

    this.processing = false;
  }

  private evaluateDecision(): { decision: CognitiveDecision; reason: string; confidence: number } {
    return this.engine.evaluate(this.state);
  }

  private async executeDecision(result: {
    decision: CognitiveDecision;
    reason: string;
    confidence: number;
  }): Promise<void> {
    const now = Date.now();

    switch (result.decision) {
      case "SPEAK": {
        if (now - this.cooldowns.speech < this.COOLDOWN.speech) return;
        const rawText = this.generateSpeech();
        if (rawText) {
          const filtered = this.interactionIntel.filterSpeech(rawText, this.state);
          if (filtered.approved) {
            this.callbacks.onSpeech(filtered.text);
            this.state.lastLohzSpeech = now;
            this.state.workingMemory.currentConversation.push({
              role: "assistant",
              content: filtered.text,
              timestamp: now,
            });
            this.cooldowns.speech = now;
          }
        }
        break;
      }
      case "ACT": {
        if (now - this.cooldowns.tool < this.COOLDOWN.tool) return;
        const toolDecision = this.toolEngine.decide(this.state);
        if (toolDecision.primaryTool) {
          this.callbacks.onToolUse(toolDecision.primaryTool, {});
          this.cooldowns.tool = now;
        }
        break;
      }
      case "WAIT": {
        break;
      }
      case "LISTEN": {
        break;
      }
      case "ASK": {
        break;
      }
      case "IGNORE": {
        break;
      }
    }

    this.state.confidence = result.confidence;
  }

  private generateSpeech(): string | null {
    const recentUser = [...this.state.workingMemory.currentConversation]
      .reverse()
      .find((t) => t.role === "user");

    if (!recentUser) return null;

    const pending = this.goalSystem.getPendingTasks(this.userId);
    if (pending.length > 0) {
      return `I'm working on: ${pending[0].description}. Let me know if you need anything.`;
    }

    return null;
  }

  private checkProactiveSpeech(): void {
    if (!this.proactiveEnabled) return;
    if (this.state.conversationState === "ended") return;
    if (this.processing) return;

    const decision = this.interactionIntel.evaluateProactive(this.state);
    if (!decision.shouldSpeak) return;

    const text = this.generateProactiveSpeech(decision.reason);
    if (!text) return;

    // Filter through quality checker
    const filtered = this.interactionIntel.filterSpeech(text, this.state);
    if (!filtered.approved) return;

    const now = Date.now();
    if (now - this.cooldowns.speech < this.COOLDOWN.speech) return;

    this.callbacks.onSpeech(filtered.text);
    this.state.lastLohzSpeech = now;
    this.state.workingMemory.currentConversation.push({
      role: "assistant",
      content: filtered.text,
      timestamp: now,
    });
    this.cooldowns.speech = now;
  }

  private generateProactiveSpeech(reason: string): string | null {
    const pending = this.goalSystem.getPendingTasks(this.userId);
    if (pending.length > 0) {
      return `Just a heads up — I'm still working on: ${pending[0].description}. I'll let you know when it's done.`;
    }

    const recentConversation = this.state.workingMemory.currentConversation;
    const lastUser = [...recentConversation].reverse().find(t => t.role === "user");
    if (lastUser) {
      const lastAssistant = [...recentConversation].reverse().find(t => t.role === "assistant");
      if (lastAssistant && lastAssistant.content.includes("...")) {
        return `I was in the middle of something. Let me know when you're ready to continue.`;
      }
    }

    return null;
  }

  private decayUrgency(): void {
    this.state.urgency = Math.max(0, this.state.urgency * 0.92);
  }

  private checkReflectionTriggers(event: CognitiveEvent): void {
    const now = Date.now();

    // Track conversation turns for segment-based triggering
    if (event.type === "user_message" || event.type === "voice_transcript") {
      this.turnsSinceLastReflection++;
    }

    // --- Trigger 1: Conversation segment end ---
    // After 6+ new turns, schedule reflection with 5s debounce
    if (this.turnsSinceLastReflection >= 6 && !this.reflectionScheduled) {
      this.reflectionScheduled = true;
      if (this.reflectionTimer) clearTimeout(this.reflectionTimer);
      this.reflectionTimer = setTimeout(() => {
        this.reflectionScheduled = false;
        this.turnsSinceLastReflection = 0;
        this.runReflection();
      }, 5000);
    }

    // --- Trigger 2: Task completion (immediate) ---
    if (event.type === "task_completion") {
      this.scheduleReflectionImmediate();
    }

    // --- Trigger 3: Tool failure (immediate) ---
    if (event.type === "tool_result") {
      const payload = event.payload as { tool: string; result: unknown; success: boolean };
      if (payload.success === false) {
        this.scheduleReflectionImmediate();
      }
    }

    // --- Trigger 4: Explicit correction (immediate) ---
    if (event.type === "user_message" || event.type === "voice_transcript") {
      const payload = event.payload as { text: string };
      if (payload.text && this.isExplicitCorrection(payload.text)) {
        this.scheduleReflectionImmediate();
      }
    }
  }

  private isExplicitCorrection(text: string): boolean {
    const lower = text.toLowerCase();
    const correctionPatterns = [
      "actually,",
      "that's not right",
      "you're wrong",
      "incorrect",
      "wrong,",
      "no, that's",
      "not quite",
      "i meant",
      "i said",
      "let me correct",
    ];
    return correctionPatterns.some(p => lower.includes(p));
  }

  private scheduleReflectionImmediate(): void {
    // Cancel any pending debounced reflection and run immediately
    if (this.reflectionTimer) {
      clearTimeout(this.reflectionTimer);
      this.reflectionTimer = null;
      this.reflectionScheduled = false;
    }
    this.turnsSinceLastReflection = 0;
    this.runReflection();
  }

  private async runReflection(): Promise<void> {
    const now = Date.now();
    if (now - this.cooldowns.reflection < this.COOLDOWN.reflection) return;
    this.cooldowns.reflection = now;

    const conversation = this.state.workingMemory.currentConversation.slice(-30);
    if (conversation.length < 4) return;

    try {
      // Fetch existing memories from the server for contradiction/learning detection
      let existingMemories: Memory[] = [];
      try {
        existingMemories = await this.callbacks.getExistingMemories();
      } catch {
        // Memory fetch failed — proceed with empty memories (reflection still works)
      }

      const result = await this.reflection.reflect(
        conversation,
        existingMemories,
        this.userId,
        `ref-${Date.now()}`
      );

      if (result) {
        // Forward memory updates to callback for persistence
        for (const update of result.memoryUpdates) {
          this.callbacks.onMemoryUpdate(update.id, update);
        }
      }
    } catch (err) {
      // Reflection failure must not crash the conversation
      console.error("[CognitiveLoop] Reflection error:", err);
    }
  }

  private enqueueConsolidation(role: "user" | "assistant", content: string, timestamp: number): void {
    this.pendingConsolidationTurns.push({ role, content, timestamp });
    if (this.consolidationTimer) return;
    this.consolidationTimer = setTimeout(() => this.flushConsolidation(), CONSOLIDATION_DEBOUNCE_MS);
  }

  private flushConsolidation(): void {
    if (this.consolidationTimer) {
      clearTimeout(this.consolidationTimer);
      this.consolidationTimer = null;
    }
    if (this.pendingConsolidationTurns.length === 0) return;
    const turns = this.pendingConsolidationTurns;
    this.pendingConsolidationTurns = [];
    this.consolidation.processConversation(turns, [], this.userId).catch(() => {});
  }

  // ── Self-Evaluation Integration ──

  private evaluateTaskCompletion(taskId: string, description: string, success: boolean): void {
    const now = Date.now();
    if (now - this.cooldowns.evaluation < this.COOLDOWN.evaluation) return;

    const pending = this.pendingTaskOutcomes.get(taskId);
    const durationMs = pending ? now - pending.startTime : 0;
    const toolCalls = pending?.toolCalls ?? [];

    const outcome: TaskOutcome = {
      taskId,
      userId: this.userId,
      intendedOutcome: description,
      actualOutcome: success ? `Completed: ${description}` : `Failed: ${description}`,
      success,
      confidence: this.state.confidence,
      timestamp: now,
      toolPerformance: toolCalls.length > 0 ? {
        toolName: toolCalls[0],
        success,
        latencyMs: durationMs,
        retryCount: toolCalls.length - 1,
      } : undefined,
    };

    const evaluation = this.selfEvaluation.evaluateOutcome(outcome);
    this.cooldowns.evaluation = now;
    this.pendingTaskOutcomes.delete(taskId);

    this.emitEvaluation(evaluation);
  }

  private emitEvaluation(evaluation: Evaluation): void {
    if (this.callbacks.onEvaluation) {
      this.callbacks.onEvaluation(evaluation);
    }

    // Wire reflection insights into memory updates
    if (evaluation.reflectionInsight) {
      this.callbacks.onMemoryUpdate(`eval_${evaluation.id}`, evaluation.reflectionInsight);
    }

    // Wire memory candidates into memory updates
    if (evaluation.memoryCandidates) {
      for (const candidate of evaluation.memoryCandidates) {
        this.callbacks.onMemoryUpdate(candidate.id, candidate);
      }
    }
  }

  private trackToolCall(toolName: string, success: boolean): void {
    // Attach to most recent pending task
    const taskIds = Array.from(this.pendingTaskOutcomes.keys());
    if (taskIds.length > 0) {
      const latest = this.pendingTaskOutcomes.get(taskIds[taskIds.length - 1]);
      if (latest) {
        latest.toolCalls.push(toolName);
      }
    }
  }

  private checkUserFeedback(event: CognitiveEvent): void {
    if (event.type !== "user_message" && event.type !== "voice_transcript") return;

    const payload = event.payload as { text: string };
    if (!payload.text) return;

    const lower = payload.text.toLowerCase();
    const correctionPatterns = [
      "that's wrong",
      "you're wrong",
      "incorrect",
      "not quite",
      "i meant",
      "i said",
      "let me correct",
      "do it this way",
      "don't do that",
      "actually,",
      "no, that's",
    ];

    const isCorrection = correctionPatterns.some(p => lower.includes(p));
    if (!isCorrection) return;

    const now = Date.now();
    // Use separate cooldown for feedback to avoid blocking on task evaluations
    if (now - this.cooldowns.evaluation < 1000) return;

    const feedbackResult = this.selfEvaluation.processUserFeedback(this.userId, {
      text: payload.text,
      type: "correction",
      importance: 0.8,
      timestamp: now,
      explicit: true,
    });

    this.emitEvaluation({
      id: `fb_${Date.now()}`,
      taskId: "feedback",
      userId: this.userId,
      intendedOutcome: "User correction",
      actualOutcome: payload.text,
      success: false,
      confidence: 0.5,
      failureCategory: "USER_ERROR",
      recoveryAction: "learn",
      userFeedback: { text: payload.text, type: "correction", importance: 0.8, timestamp: now, explicit: true },
      shouldLearn: feedbackResult.isCorrection,
      learningWeight: feedbackResult.learningWeight,
      timestamp: now,
    });
  }

  getInteractionMode(): InteractionMode {
    return this.interactionIntel.getMode();
  }

  setUserPreferences(userId: string, updates: Partial<import("./userPreferences").UserInteractionPreferences>): void {
    this.interactionIntel.updatePreferences(userId, updates);
  }

  filterSpeech(text: string): { approved: boolean; text: string; reason: string } {
    return this.interactionIntel.filterSpeech(text, this.state);
  }

  getRecentEvaluations(limit: number = 10): Evaluation[] {
    return this.selfEvaluation.getRecentEvaluations(this.userId, limit);
  }

  getSuccessRate(): number {
    return this.selfEvaluation.getSuccessRate(this.userId);
  }

  reset(): void {
    this.state = { ...DEFAULT_COGNITIVE_STATE };
    this.eventQueue = [];
    this.processing = false;
    this.stateCache = null;
    this.stateDirty = true;
    this.pendingConsolidationTurns = [];
    this.pendingTaskOutcomes.clear();
    this.selfEvaluation.reset();
    this.interactionIntel.reset();
    this.interactionIntel.setUserId(this.userId);
    if (this.consolidationTimer) {
      clearTimeout(this.consolidationTimer);
      this.consolidationTimer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.proactiveTimer) {
      clearInterval(this.proactiveTimer);
      this.proactiveTimer = null;
    }
    this.cooldowns = {
      decision: 0,
      speech: 0,
      memory: 0,
      tool: 0,
      reflection: 0,
      evaluation: 0,
    };
    this.turnsSinceLastReflection = 0;
    this.reflectionScheduled = false;
    if (this.reflectionTimer) {
      clearTimeout(this.reflectionTimer);
      this.reflectionTimer = null;
    }
  }
}

export default CognitiveLoop;