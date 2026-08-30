import { ConversationTurn } from "./cognitiveState";

export type SilenceType =
  | "short_pause"
  | "conversation_end"
  | "extended_inactivity"
  | "deep_idle";

export interface SilenceClassification {
  type: SilenceType;
  durationMs: number;
  confidence: number;
  contextContribution: number;
  shouldInitiate: boolean;
  reason: string;
}

export interface SilenceContext {
  lastConversationTopic: string | null;
  activeGoals: boolean;
  pendingTasks: boolean;
  timeSinceLastLohzSpeech: number;
  userActivity: "typing" | "speaking" | "idle" | "reading" | "waiting";
  recentToolActivity: boolean;
  conversationTurns: number;
}

export interface SilenceAnalyzerConfig {
  shortPauseMaxMs: number;
  conversationEndMaxMs: number;
  extendedInactivityMaxMs: number;
  unresolvedTopicBonus: number;
  activeGoalBonus: number;
  pendingTaskBonus: number;
  toolActivityReduction: number;
  minConfidenceToInitiate: number;
}

const DEFAULT_CONFIG: SilenceAnalyzerConfig = {
  shortPauseMaxMs: 5000,
  conversationEndMaxMs: 30000,
  extendedInactivityMaxMs: 300000,
  unresolvedTopicBonus: 0.2,
  activeGoalBonus: 0.15,
  pendingTaskBonus: 0.1,
  toolActivityReduction: 0.1,
  minConfidenceToInitiate: 0.5,
};

export class SilenceAnalyzer {
  private config: SilenceAnalyzerConfig;

  constructor(config?: Partial<SilenceAnalyzerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  classify(durationMs: number, context: SilenceContext): SilenceClassification {
    if (durationMs <= this.config.shortPauseMaxMs) {
      return this.classifyShortPause(durationMs, context);
    }
    if (durationMs <= this.config.conversationEndMaxMs) {
      return this.classifyConversationEnd(durationMs, context);
    }
    if (durationMs <= this.config.extendedInactivityMaxMs) {
      return this.classifyExtendedInactivity(durationMs, context);
    }
    return this.classifyDeepIdle(durationMs, context);
  }

  private classifyShortPause(
    durationMs: number,
    _context: SilenceContext
  ): SilenceClassification {
    return {
      type: "short_pause",
      durationMs,
      confidence: 0.9,
      contextContribution: 0,
      shouldInitiate: false,
      reason: "Normal thinking pause — no action needed",
    };
  }

  private classifyConversationEnd(
    durationMs: number,
    context: SilenceContext
  ): SilenceClassification {
    const resolved = this.wasConversationResolved(context);
    const hasWork = this.hasUnresolvedBusiness(context);

    let confidence = 0.5;
    let shouldInitiate = false;
    let reason = "Conversation may be ending";

    if (resolved && !hasWork) {
      confidence = 0.8;
      shouldInitiate = false;
      reason = "Conversation resolved, likely ending naturally";
    } else if (!resolved && hasWork) {
      confidence = 0.7;
      shouldInitiate = true;
      reason = "Unresolved discussion with pending work — consider follow-up";
    } else if (context.activeGoals) {
      confidence = 0.6;
      shouldInitiate = true;
      reason = "Active goal exists — gentle reminder appropriate";
    } else {
      confidence = 0.5;
      shouldInitiate = false;
      reason = "Ambiguous silence — waiting for user";
    }

    const contextContribution = this.calculateContextContribution(context);

    return {
      type: "conversation_end",
      durationMs,
      confidence,
      contextContribution,
      shouldInitiate,
      reason,
    };
  }

  private classifyExtendedInactivity(
    durationMs: number,
    context: SilenceContext
  ): SilenceClassification {
    const hasWork = this.hasUnresolvedBusiness(context);
    const userActive = context.userActivity === "typing" || context.userActivity === "speaking";

    let confidence = 0.7;
    let shouldInitiate = false;
    let reason = "Extended inactivity detected";

    if (userActive) {
      confidence = 0.8;
      shouldInitiate = false;
      reason = "User is active but silent — they may be thinking or reading";
    } else if (hasWork && context.activeGoals) {
      confidence = 0.75;
      shouldInitiate = true;
      reason = "User inactive with pending work — gentle nudge appropriate";
    } else if (context.recentToolActivity) {
      confidence = 0.65;
      shouldInitiate = false;
      reason = "Recent tool activity — user may be waiting for results";
    } else {
      confidence = 0.7;
      shouldInitiate = false;
      reason = "User appears away — no intervention";
    }

    const contextContribution = this.calculateContextContribution(context);

    return {
      type: "extended_inactivity",
      durationMs,
      confidence,
      contextContribution,
      shouldInitiate,
      reason,
    };
  }

  private classifyDeepIdle(
    durationMs: number,
    context: SilenceContext
  ): SilenceClassification {
    return {
      type: "deep_idle",
      durationMs,
      confidence: 0.95,
      contextContribution: 0,
      shouldInitiate: false,
      reason: "User likely away — no intervention after extended idle",
    };
  }

  private wasConversationResolved(context: SilenceContext): boolean {
    if (context.conversationTurns < 2) return true;
    if (context.pendingTasks) return false;
    if (context.recentToolActivity) return false;
    return true;
  }

  private hasUnresolvedBusiness(context: SilenceContext): boolean {
    if (context.pendingTasks) return true;
    if (context.activeGoals) return true;
    if (context.recentToolActivity) return true;
    return false;
  }

  private calculateContextContribution(context: SilenceContext): number {
    let contribution = 0;
    if (context.activeGoals) contribution += this.config.activeGoalBonus;
    if (context.pendingTasks) contribution += this.config.pendingTaskBonus;
    if (context.recentToolActivity) contribution -= this.config.toolActivityReduction;
    return Math.max(0, Math.min(1, contribution));
  }

  reset(): void {}
}
