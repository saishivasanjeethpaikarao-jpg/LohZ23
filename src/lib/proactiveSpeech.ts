import { CognitiveState, CognitiveDecision } from "./cognitiveState";

export interface ProactiveSpeechConfig {
  minSilenceMs: number;
  maxSilenceMs: number;
  speakCooldownMs: number;
  minConfidence: number;
  unfinishedConversationWindowMs: number;
  reminderIntervalMs: number;
  memoryRelevanceThreshold: number;
  maxProactivePerHour: number;
}

export const DEFAULT_PROACTIVE_CONFIG: ProactiveSpeechConfig = {
  minSilenceMs: 10000,
  maxSilenceMs: 120000,
  speakCooldownMs: 30000,
  minConfidence: 0.65,
  unfinishedConversationWindowMs: 60000,
  reminderIntervalMs: 300000,
  memoryRelevanceThreshold: 0.7,
  maxProactivePerHour: 3,
};

interface ProactiveState {
  lastProactiveTime: number;
  proactiveCountThisHour: number;
  hourWindowStart: number;
}

export class ProactiveSpeechPolicy {
  private config: ProactiveSpeechConfig;
  private state: ProactiveState;

  constructor(config: Partial<ProactiveSpeechConfig> = {}) {
    this.config = { ...DEFAULT_PROACTIVE_CONFIG, ...config };
    this.state = {
      lastProactiveTime: 0,
      proactiveCountThisHour: 0,
      hourWindowStart: Date.now(),
    };
  }

  evaluate(state: CognitiveState): { shouldSpeak: boolean; reason: string; confidence: number } | null {
    const now = Date.now();
    const silenceDuration = now - state.lastUserActivity;
    const timeSinceLastSpeak = now - state.lastLohzSpeech;

    // Check hourly rate limit
    this.updateHourlyWindow(now);
    if (this.state.proactiveCountThisHour >= this.config.maxProactivePerHour) {
      return null;
    }

    // Check speak cooldown
    if (timeSinceLastSpeak < this.config.speakCooldownMs) {
      return null;
    }

    // Silence duration check
    if (silenceDuration < this.config.minSilenceMs || silenceDuration > this.config.maxSilenceMs) {
      return null;
    }

    // Confidence threshold
    if (state.confidence < this.config.minConfidence) {
      return null;
    }

    // Evaluate proactive triggers in priority order
    const triggers = [
      this.checkUnfinishedConversation(state, now),
      this.checkActiveTaskReminder(state, now),
      this.checkRelevantMemory(state),
      this.checkPendingGoal(state),
      this.checkUserEngagement(state),
    ];

    for (const trigger of triggers) {
      if (trigger) {
        this.recordProactive(now);
        return trigger;
      }
    }

    return null;
  }

  private checkUnfinishedConversation(state: CognitiveState, now: number): { shouldSpeak: boolean; reason: string; confidence: number } | null {
    const userTurns = state.workingMemory.currentConversation.filter(t => t.role === "user");
    if (userTurns.length === 0) return null;

    const lastUserTurn = userTurns[userTurns.length - 1];
    const timeSinceLastUser = now - lastUserTurn.timestamp;

    if (timeSinceLastUser < this.config.unfinishedConversationWindowMs) {
      // Check if conversation seems incomplete (no clear closing)
      const lastAssistantTurn = state.workingMemory.currentConversation
        .filter(t => t.role === "assistant")
        .pop();
      
      if (!lastAssistantTurn || 
          lastAssistantTurn.content.includes("...") || 
          lastAssistantTurn.content.includes("let me") ||
          lastAssistantTurn.content.includes("working on")) {
        return {
          shouldSpeak: true,
          reason: "Conversation appears unfinished - user may be waiting for completion",
          confidence: Math.min(0.85, state.confidence + 0.1),
        };
      }
    }
    return null;
  }

  private checkActiveTaskReminder(state: CognitiveState, now: number): { shouldSpeak: boolean; reason: string; confidence: number } | null {
    if (!state.activeGoal || !state.workingMemory.activeTask) return null;

    const taskAge = now - (state.workingMemory.activeTask as any)?.timestamp || 0;
    if (taskAge > this.config.reminderIntervalMs) {
      const lastReminder = this.state.lastProactiveTime;
      if (now - lastReminder > this.config.reminderIntervalMs) {
        return {
          shouldSpeak: true,
          reason: `Gentle reminder about active task: ${state.activeGoal}`,
          confidence: 0.7,
        };
      }
    }
    return null;
  }

  private checkRelevantMemory(state: CognitiveState): { shouldSpeak: boolean; reason: string; confidence: number } | null {
    const relevantMemory = state.relevantMemories.find(m => 
      m.relevance > this.config.memoryRelevanceThreshold && 
      m.metadata.importance > 0.6 &&
      Date.now() - m.metadata.lastAccessed > 3600000 && // Not accessed in last hour
      m.layer === "semantic" || m.layer === "procedural"
    );

    if (relevantMemory && state.currentTopic && 
        relevantMemory.content.toLowerCase().includes(state.currentTopic.toLowerCase())) {
      return {
        shouldSpeak: true,
        reason: `Relevant knowledge surfaced: ${relevantMemory.content.substring(0, 60)}...`,
        confidence: 0.75,
      };
    }
    return null;
  }

  private checkPendingGoal(state: CognitiveState): { shouldSpeak: boolean; reason: string; confidence: number } | null {
    const pendingGoals = state.pendingTasks.filter(t => t.status === "pending" && t.priority > 0.7);
    if (pendingGoals.length > 0) {
      const topGoal = pendingGoals.sort((a, b) => b.priority - a.priority)[0];
      return {
        shouldSpeak: true,
        reason: `Pending high-priority goal: ${topGoal.description}`,
        confidence: 0.65,
      };
    }
    return null;
  }

  private checkUserEngagement(state: CognitiveState): { shouldSpeak: boolean; reason: string; confidence: number } | null {
    // Don't speak if user appears busy (rapid context signals)
    const recentSignals = state.workingMemory.contextSignals.filter(
      s => Date.now() - s.timestamp < 30000
    );
    
    const busySignals = recentSignals.filter(s => 
      s.type === "app_focus" || s.type === "screen_change"
    ).length;

    if (busySignals > 3) {
      // User appears actively engaged elsewhere
      return null;
    }

    // If user was recently engaged but went silent, they might be thinking
    const recentUserActivity = state.workingMemory.contextSignals.filter(
      s => s.type === "user_typing" && Date.now() - s.timestamp < 120000
    );
    
    if (recentUserActivity.length > 0 && state.silenceDuration > 30000) {
      return {
        shouldSpeak: true,
        reason: "User was recently active but now silent - may need assistance",
        confidence: 0.6,
      };
    }
    return null;
  }

  private updateHourlyWindow(now: number): void {
    if (now - this.state.hourWindowStart > 3600000) {
      this.state.hourWindowStart = now;
      this.state.proactiveCountThisHour = 0;
    }
  }

  private recordProactive(now: number): void {
    this.state.lastProactiveTime = now;
    this.state.proactiveCountThisHour++;
  }

  reset(): void {
    this.state = {
      lastProactiveTime: 0,
      proactiveCountThisHour: 0,
      hourWindowStart: Date.now(),
    };
  }

  getStats() {
    return { ...this.state };
  }
}

export function createProactiveSpeechPolicy(config?: Partial<ProactiveSpeechConfig>): ProactiveSpeechPolicy {
  return new ProactiveSpeechPolicy(config);
}