import { CognitiveEvent, CognitiveState } from "./cognitiveState";
import { InteractionMode, InteractionModeTracker } from "./interactionModes";
import { SilenceAnalyzer, SilenceClassification, SilenceContext } from "./silenceAnalyzer";
import { ConversationQualityChecker, QualityCheck } from "./conversationQuality";
import { InterruptionController, InterruptionCheck } from "./interruptionControl";
import { UserPreferenceStore, UserInteractionPreferences } from "./userPreferences";

export interface InteractionDecision {
  shouldSpeak: boolean;
  mode: InteractionMode;
  reason: string;
  confidence: number;
  qualityScore: number;
  silenceType: SilenceType;
  blocked: boolean;
  blockReason: string | null;
}

export interface InteractionConfig {
  mode: Partial<import("./interactionModes").InteractionModeConfig>;
  silence: Partial<import("./silenceAnalyzer").SilenceAnalyzerConfig>;
  quality: Partial<import("./conversationQuality").ConversationQualityConfig>;
  interruption: Partial<import("./interruptionControl").InterruptionControllerConfig>;
}

type SilenceType = import("./silenceAnalyzer").SilenceType;

const DEFAULT_CONFIG: InteractionConfig = {
  mode: {},
  silence: {},
  quality: {},
  interruption: {},
};

export class InteractionIntelligence {
  private modeTracker: InteractionModeTracker;
  private silenceAnalyzer: SilenceAnalyzer;
  private qualityChecker: ConversationQualityChecker;
  private interruptionController: InterruptionController;
  private preferenceStore: UserPreferenceStore;
  private proactiveCountThisHour: number = 0;
  private hourWindowStart: number = Date.now();
  private currentUserId: string = "default";

  constructor(config?: Partial<InteractionConfig>) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    this.modeTracker = new InteractionModeTracker(cfg.mode);
    this.silenceAnalyzer = new SilenceAnalyzer(cfg.silence);
    this.qualityChecker = new ConversationQualityChecker(cfg.quality);
    this.interruptionController = new InterruptionController(cfg.interruption);
    this.preferenceStore = new UserPreferenceStore();
  }

  processEvent(event: CognitiveEvent, state: CognitiveState): InteractionDecision {
    this.updateModeFromEvent(event, state);

    const mode = this.modeTracker.getMode();
    const interruptionCtx = this.buildInterruptionContext(state);
    const interruption = this.interruptionController.checkSafe(interruptionCtx);

    if (event.type === "meaningful_silence") {
      return this.processSilence(event, state, mode, interruption);
    }

    return this.buildDecision(false, mode, "Event processed — no initiation triggered", 0.5, "short_pause", interruption);
  }

  evaluateProactive(state: CognitiveState): InteractionDecision {
    this.pruneProactiveCount();

    if (!this.modeTracker.canBeProactive()) {
      return this.buildDecision(
        false,
        this.modeTracker.getMode(),
        `Mode "${this.modeTracker.getMode()}" does not allow proactive speech`,
        0,
        "short_pause",
        { safe: true, reason: "", blockingFactor: null }
      );
    }

    if (!this.preferenceStore.canBeProactive(this.currentUserId)) {
      return this.buildDecision(
        false,
        this.modeTracker.getMode(),
        "User preferences disable proactive speech",
        0,
        "short_pause",
        { safe: true, reason: "", blockingFactor: null }
      );
    }

    const maxPerHour = this.preferenceStore.getMaxProactivePerHour(this.currentUserId);
    if (this.proactiveCountThisHour >= maxPerHour) {
      return this.buildDecision(
        false,
        this.modeTracker.getMode(),
        `Proactive limit reached (${this.proactiveCountThisHour}/${maxPerHour} this hour)`,
        0,
        "short_pause",
        { safe: true, reason: "", blockingFactor: null }
      );
    }

    const interruptionCtx = this.buildInterruptionContext(state);
    const interruption = this.interruptionController.checkSafe(interruptionCtx);
    if (!interruption.safe) {
      return this.buildDecision(
        false,
        this.modeTracker.getMode(),
        `Interruption blocked: ${interruption.reason}`,
        0,
        "short_pause",
        interruption
      );
    }

    const silenceCtx = this.buildSilenceContext(state);
    const silence = this.silenceAnalyzer.classify(state.silenceDuration, silenceCtx);

    if (!silence.shouldInitiate) {
      return this.buildDecision(
        false,
        this.modeTracker.getMode(),
        `Silence classified as ${silence.type}: ${silence.reason}`,
        silence.confidence,
        silence.type,
        interruption
      );
    }

    const reason = this.determineProactiveReason(state, silence);
    this.proactiveCountThisHour++;
    this.modeTracker.transition("PROACTIVE", reason);

    return this.buildDecision(
      true,
      "PROACTIVE",
      reason,
      silence.confidence,
      silence.type,
      interruption
    );
  }

  filterSpeech(text: string, state: CognitiveState): { approved: boolean; text: string; reason: string } {
    const ctx = {
      recentTurns: state.workingMemory.currentConversation.map((t) => ({
        role: t.role,
        content: t.content,
        timestamp: t.timestamp,
      })),
      activeTopic: state.currentTopic,
      userEmotionalState: state.emotionalContext,
    };

    const quality = this.qualityChecker.checkQuality(text, ctx);

    if (quality.passed) {
      this.qualityChecker.recordSpoken(text);
      return { approved: true, text, reason: "Quality check passed" };
    }

    const filtered = this.applyFilters(text, quality);
    if (filtered !== text) {
      this.qualityChecker.recordSpoken(filtered);
      return { approved: true, text: filtered, reason: `Filtered: ${quality.issues.join("; ")}` };
    }

    return {
      approved: false,
      text,
      reason: `Quality check failed: ${quality.issues.join("; ")}`,
    };
  }

  getPreferences(userId: string): UserInteractionPreferences {
    return this.preferenceStore.getPreferences(userId);
  }

  updatePreferences(userId: string, updates: Partial<UserInteractionPreferences>): void {
    this.preferenceStore.updatePreferences(userId, updates);
  }

  setUserId(userId: string): void {
    this.currentUserId = userId;
  }

  getMode(): InteractionMode {
    return this.modeTracker.getMode();
  }

  canInitiateNow(): boolean {
    return this.modeTracker.canInitiate();
  }

  getQualityChecker(): ConversationQualityChecker {
    return this.qualityChecker;
  }

  reset(): void {
    this.modeTracker.reset();
    this.silenceAnalyzer.reset();
    this.qualityChecker.reset();
    this.interruptionController.reset();
    this.preferenceStore.reset();
    this.proactiveCountThisHour = 0;
    this.hourWindowStart = Date.now();
  }

  private updateModeFromEvent(event: CognitiveEvent, _state: CognitiveState): void {
    switch (event.type) {
      case "user_message":
      case "voice_transcript":
        this.modeTracker.transition("LISTENING", `User input received: ${event.type}`);
        break;
      case "speech_start":
        this.modeTracker.transition("ACTIVE_CONVERSATION", "LOHZ started speaking");
        break;
      case "speech_end":
        this.modeTracker.transition("WAITING", "LOHZ finished speaking");
        break;
      case "task_completion":
        this.modeTracker.transition("LISTENING", "Task completed");
        break;
      case "tool_result":
        if (this.modeTracker.getMode() !== "TASK_FOCUSED") {
          this.modeTracker.transition("TASK_FOCUSED", "Tool activity detected");
        }
        break;
      case "app_state_change":
        break;
    }
  }

  private processSilence(
    event: CognitiveEvent,
    state: CognitiveState,
    mode: InteractionMode,
    interruption: InterruptionCheck
  ): InteractionDecision {
    const durationMs = (event.payload as { durationMs?: number })?.durationMs ?? state.silenceDuration;
    const silenceCtx = this.buildSilenceContext(state);
    const silence = this.silenceAnalyzer.classify(durationMs, silenceCtx);

    if (!interruption.safe) {
      return this.buildDecision(
        false,
        mode,
        `Silence detected but blocked: ${interruption.reason}`,
        silence.confidence,
        silence.type,
        interruption
      );
    }

    if (silence.shouldInitiate && this.modeTracker.canInitiate()) {
      return this.buildDecision(
        true,
        mode,
        `Initiating: ${silence.reason}`,
        silence.confidence,
        silence.type,
        interruption
      );
    }

    return this.buildDecision(
      false,
      mode,
      `Silence ${silence.type}: ${silence.reason}`,
      silence.confidence,
      silence.type,
      interruption
    );
  }

  private determineProactiveReason(state: CognitiveState, silence: SilenceClassification): string {
    if (state.pendingTasks.length > 0) {
      return `Task reminder: ${state.pendingTasks[0].description}`;
    }
    if (silence.type === "conversation_end") {
      return "Follow-up on recent conversation";
    }
    if (state.activeGoal) {
      return `Goal progress check: ${state.activeGoal}`;
    }
    return silence.reason;
  }

  private buildSilenceContext(state: CognitiveState): SilenceContext {
    return {
      lastConversationTopic: state.currentTopic,
      activeGoals: state.activeGoal !== null,
      pendingTasks: state.pendingTasks.length > 0,
      timeSinceLastLohzSpeech: Date.now() - state.lastLohzSpeech,
      userActivity: this.inferUserActivity(state),
      recentToolActivity: state.workingMemory.recentToolActions.length > 0,
      conversationTurns: state.workingMemory.currentConversation.length,
    };
  }

  private buildInterruptionContext(state: CognitiveState): import("./interruptionControl").InterruptionContext {
    return {
      userIsTyping: state.workingMemory.contextSignals.some(
        (s) => s.type === "user_typing" && Date.now() - s.timestamp < 5000
      ),
      userIsSpeaking: state.workingMemory.contextSignals.some(
        (s) => s.type === "voice_activity" && Date.now() - s.timestamp < 3000
      ),
      lohzRecentlySpoke: Date.now() - state.lastLohzSpeech < 3000,
      lohzSpeechTimestamp: state.lastLohzSpeech,
      activeTaskInProgress: state.workingMemory.activeTask !== null,
      timeSinceLastUserActivity: Date.now() - state.lastUserActivity,
      conversationState: state.conversationState,
    };
  }

  private inferUserActivity(state: CognitiveState): "typing" | "speaking" | "idle" | "reading" | "waiting" {
    const recent = state.workingMemory.contextSignals;
    const now = Date.now();

    if (recent.some((s) => s.type === "user_typing" && now - s.timestamp < 5000)) return "typing";
    if (recent.some((s) => s.type === "voice_activity" && now - s.timestamp < 3000)) return "speaking";
    if (state.workingMemory.activeTask) return "waiting";
    return "idle";
  }

  private applyFilters(text: string, quality: QualityCheck): string {
    let filtered = text;
    const lower = filtered.toLowerCase();

    const fillerRemovals: Array<[RegExp, string]> = [
      [/\bum\b[,.]?\s*/gi, ""],
      [/\buh\b[,.]?\s*/gi, ""],
      [/\ber\b[,.]?\s*/gi, ""],
      [/\bah\b[,.]?\s*/gi, ""],
      [/\bbasically\b[,.]?\s*/gi, ""],
      [/\byou know\b[,.]?\s*/gi, ""],
      [/\bi mean\b[,.]?\s*/gi, ""],
    ];

    for (const [pattern, replacement] of fillerRemovals) {
      filtered = filtered.replace(pattern, replacement);
    }

    filtered = filtered.replace(/\s+/g, " ").trim();

    if (filtered.length < 3) return text;
    return filtered;
  }

  private pruneProactiveCount(): void {
    const now = Date.now();
    if (now - this.hourWindowStart > 3600000) {
      this.proactiveCountThisHour = 0;
      this.hourWindowStart = now;
    }
  }

  private buildDecision(
    shouldSpeak: boolean,
    mode: InteractionMode,
    reason: string,
    confidence: number,
    silenceType: SilenceType,
    interruption: InterruptionCheck
  ): InteractionDecision {
    return {
      shouldSpeak,
      mode,
      reason,
      confidence,
      qualityScore: 1,
      silenceType,
      blocked: !interruption.safe,
      blockReason: interruption.blockingFactor,
    };
  }
}
