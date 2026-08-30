import { 
  CognitiveState, 
  CognitiveDecision, 
  DecisionReason, 
  CandidateAction,
  DEFAULT_COGNITIVE_STATE 
} from "./cognitiveState";

export interface DecisionEngineConfig {
  speakCooldownMs: number;
  minConfidenceToSpeak: number;
  minConfidenceToAct: number;
  maxSilenceBeforeProactiveMs: number;
  minSilenceBeforeProactiveMs: number;
}

export const DEFAULT_DECISION_CONFIG: DecisionEngineConfig = {
  speakCooldownMs: 30000,
  minConfidenceToSpeak: 0.7,
  minConfidenceToAct: 0.6,
  maxSilenceBeforeProactiveMs: 120000,
  minSilenceBeforeProactiveMs: 10000,
};

export class DecisionEngine {
  private config: DecisionEngineConfig;
  private lastSpeakTime: number = 0;
  private lastDecision: CognitiveDecision = "LISTEN";
  private decisionHistory: DecisionReason[] = [];

  constructor(config: Partial<DecisionEngineConfig> = {}) {
    this.config = { ...DEFAULT_DECISION_CONFIG, ...config };
  }

  evaluate(state: CognitiveState): DecisionReason {
    const now = Date.now();
    const silenceDuration = now - state.lastUserActivity;
    const timeSinceLastSpeak = now - state.lastLohzSpeech;

    // Check cooldown
    if (timeSinceLastSpeak < this.config.speakCooldownMs) {
      return this.createDecision("WAIT", `Speak cooldown active (${Math.round((this.config.speakCooldownMs - timeSinceLastSpeak) / 1000)}s remaining)`, 0.9);
    }

    // High urgency - check for critical actions
    if (state.urgency > 0.8) {
      if (state.candidateActions.some(a => a.type === "ACT" && a.priority > 0.8)) {
        return this.createDecision("ACT", "High urgency action required", state.confidence);
      }
    }

    // User explicitly asked a question or needs clarification
    if (state.userIntent && (state.userIntent.includes("?") || state.userIntent.toLowerCase().includes("how") || state.userIntent.toLowerCase().includes("what"))) {
      if (state.confidence > this.config.minConfidenceToSpeak) {
        return this.createDecision("SPEAK", "User asked a question", state.confidence);
      } else {
        return this.createDecision("ASK", "Need clarification to answer", 0.7);
      }
    }

    // Active conversation - listen and respond
    if (state.conversationState === "active" && state.workingMemory.currentConversation.length > 0) {
      const lastTurn = state.workingMemory.currentConversation[state.workingMemory.currentConversation.length - 1];
      if (lastTurn.role === "user") {
        if (state.confidence > this.config.minConfidenceToSpeak) {
          return this.createDecision("SPEAK", "User spoke, responding", state.confidence);
        }
      }
    }

    // Proactive speech evaluation
    if (silenceDuration >= this.config.minSilenceBeforeProactiveMs && silenceDuration <= this.config.maxSilenceBeforeProactiveMs) {
      const proactiveReason = this.evaluateProactiveSpeech(state, silenceDuration);
      if (proactiveReason) {
        return proactiveReason;
      }
    }

    // Long silence - wait or check for unfinished business
    if (silenceDuration > this.config.maxSilenceBeforeProactiveMs) {
      if (state.pendingTasks.some(t => t.status === "in_progress" || t.status === "pending")) {
        return this.createDecision("WAIT", "Long silence but pending tasks exist", 0.6);
      }
      return this.createDecision("IGNORE", "Extended silence, no active context", 0.5);
    }

    // Default: listen
    return this.createDecision("LISTEN", "Awaiting user input", 0.8);
  }

  private evaluateProactiveSpeech(state: CognitiveState, silenceDuration: number): DecisionReason | null {
    // Don't speak if we just spoke
    if (Date.now() - state.lastLohzSpeech < this.config.speakCooldownMs) {
      return null;
    }

    // Check for unfinished conversation
    const lastUserTurn = state.workingMemory.currentConversation
      .filter(t => t.role === "user")
      .pop();
    
    if (lastUserTurn) {
      const timeSinceLastUser = Date.now() - lastUserTurn.timestamp;
      if (timeSinceLastUser < 60000 && state.confidence > 0.6) {
        return this.createDecision("SPEAK", "Conversation appears unfinished", state.confidence * 0.8);
      }
    }

    // Check for useful reminders
    const activeGoal = state.activeGoal;
    if (activeGoal && state.workingMemory.activeTask) {
      const timeSinceTask = Date.now() - (state.workingMemory.activeTask as any)?.timestamp || 0;
      if (timeSinceTask > 300000) { // 5 minutes
        return this.createDecision("SPEAK", `Gentle reminder about: ${activeGoal}`, 0.65);
      }
    }

    // Check for relevant memory that became applicable
    const relevantMemory = state.relevantMemories.find(m => 
      m.relevance > 0.7 && m.metadata.importance > 0.6 && Date.now() - m.metadata.lastAccessed > 3600000
    );
    if (relevantMemory && state.confidence > 0.65) {
      return this.createDecision("SPEAK", `Relevant memory surfaced: ${relevantMemory.content.substring(0, 50)}...`, 0.7);
    }

    return null;
  }

  private createDecision(decision: CognitiveDecision, reason: string, confidence: number): DecisionReason {
    const result: DecisionReason = { decision, reason, confidence };
    this.lastDecision = decision;
    this.decisionHistory.push(result);
    if (this.decisionHistory.length > 100) {
      this.decisionHistory.shift();
    }
    if (decision === "SPEAK") {
      this.lastSpeakTime = Date.now();
    }
    return result;
  }

  getHistory(): DecisionReason[] {
    return [...this.decisionHistory];
  }

  getLastDecision(): CognitiveDecision {
    return this.lastDecision;
  }

  reset() {
    this.lastSpeakTime = 0;
    this.lastDecision = "LISTEN";
    this.decisionHistory = [];
  }
}

export function createDefaultDecisionEngine(): DecisionEngine {
  return new DecisionEngine();
}