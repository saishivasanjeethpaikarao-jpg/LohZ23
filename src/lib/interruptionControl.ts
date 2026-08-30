export interface InterruptionCheck {
  safe: boolean;
  reason: string;
  blockingFactor: string | null;
}

export interface InterruptionContext {
  userIsTyping: boolean;
  userIsSpeaking: boolean;
  lohzRecentlySpoke: boolean;
  lohzSpeechTimestamp: number;
  activeTaskInProgress: boolean;
  timeSinceLastUserActivity: number;
  conversationState: "active" | "paused" | "ended" | "awaiting_response";
}

export interface InterruptionControllerConfig {
  minSpeechGapMs: number;
  typingWindowMs: number;
  userActivityWindowMs: number;
}

const DEFAULT_CONFIG: InterruptionControllerConfig = {
  minSpeechGapMs: 3000,
  typingWindowMs: 5000,
  userActivityWindowMs: 10000,
};

export class InterruptionController {
  private config: InterruptionControllerConfig;

  constructor(config?: Partial<InterruptionControllerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  checkSafe(context: InterruptionContext): InterruptionCheck {
    if (this.isUserActive(context)) {
      return {
        safe: false,
        reason: "User is actively engaged (typing or speaking)",
        blockingFactor: "user_active",
      };
    }

    if (this.isRecentSpeech(context)) {
      return {
        safe: false,
        reason: "LOHZ spoke too recently — waiting for user response window",
        blockingFactor: "recent_speech",
      };
    }

    if (context.activeTaskInProgress) {
      return {
        safe: false,
        reason: "Task in progress — avoiding interruption during work",
        blockingFactor: "task_in_progress",
      };
    }

    if (context.conversationState === "ended") {
      return {
        safe: false,
        reason: "Conversation was ended — respecting user's choice",
        blockingFactor: "conversation_ended",
      };
    }

    return {
      safe: true,
      reason: "No blocking factors — safe to speak",
      blockingFactor: null,
    };
  }

  private isUserActive(context: InterruptionContext): boolean {
    if (context.userIsTyping) return true;
    if (context.userIsSpeaking) return true;
    if (context.timeSinceLastUserActivity < this.config.userActivityWindowMs) return true;
    return false;
  }

  private isRecentSpeech(context: InterruptionContext): boolean {
    if (!context.lohzRecentlySpoke) return false;
    const timeSince = Date.now() - context.lohzSpeechTimestamp;
    return timeSince < this.config.minSpeechGapMs;
  }

  reset(): void {}
}
