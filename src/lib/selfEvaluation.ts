import { MemoryTransaction } from "./memoryTypes";
import { ReflectionInsight, StrategyUpdate } from "./reflectionEngine";

// ── Types ──

export type FailureCategory =
  | "USER_ERROR"
  | "MODEL_ERROR"
  | "TOOL_ERROR"
  | "NETWORK_ERROR"
  | "AUTH_ERROR"
  | "PLANNING_ERROR"
  | "UNKNOWN";

export type RecoveryAction = "retry" | "replan" | "ask" | "stop" | "learn";

export type FeedbackType = "correction" | "preference" | "confirmation" | "complaint" | "suggestion";

export interface EvaluationConfig {
  minConfidenceForAction: number;
  maxRetriesForRecovery: number;
  feedbackDecayHours: number;
  minFeedbackForPattern: number;
  learningThreshold: number;
}

export const DEFAULT_EVALUATION_CONFIG: EvaluationConfig = {
  minConfidenceForAction: 0.3,
  maxRetriesForRecovery: 3,
  feedbackDecayHours: 24,
  minFeedbackForPattern: 2,
  learningThreshold: 0.6,
};

export interface TaskOutcome {
  taskId: string;
  userId: string;
  intendedOutcome: string;
  actualOutcome: string;
  success: boolean;
  confidence: number;
  failureCategory?: FailureCategory;
  userFeedback?: UserFeedback;
  toolPerformance?: ToolPerformanceMetrics;
  planEfficiency?: PlanEfficiencyMetrics;
  timestamp: number;
}

export interface UserFeedback {
  text: string;
  type: FeedbackType;
  importance: number;
  timestamp: number;
  explicit: boolean;
}

export interface ToolPerformanceMetrics {
  toolName: string;
  success: boolean;
  latencyMs: number;
  error?: string;
  retryCount: number;
}

export interface PlanEfficiencyMetrics {
  stepsPlanned: number;
  stepsExecuted: number;
  stepsSucceeded: number;
  stepsFailed: number;
  totalDurationMs: number;
  replannedCount: number;
}

export interface Evaluation {
  id: string;
  taskId: string;
  userId: string;
  intendedOutcome: string;
  actualOutcome: string;
  success: boolean;
  confidence: number;
  failureCategory?: FailureCategory;
  recoveryAction?: RecoveryAction;
  userFeedback?: UserFeedback;
  toolPerformance?: ToolPerformanceMetrics;
  planEfficiency?: PlanEfficiencyMetrics;
  shouldLearn: boolean;
  learningWeight: number;
  reflectionInsight?: ReflectionInsight;
  memoryCandidates?: MemoryTransaction[];
  timestamp: number;
}

export interface FailurePattern {
  category: FailureCategory;
  count: number;
  lastOccurrence: number;
  examples: string[];
}

export interface UserPreference {
  userId: string;
  preference: string;
  strength: number;
  lastReinforced: number;
  evidenceCount: number;
}

// ── SelfEvaluationEngine ──

export class SelfEvaluationEngine {
  private config: EvaluationConfig;
  private evaluations: Map<string, Evaluation> = new Map();
  private userFeedback: Map<string, UserFeedback[]> = new Map();
  private failurePatterns: Map<string, FailurePattern[]> = new Map();
  private userPreferences: Map<string, UserPreference[]> = new Map();
  private learningEvents: Map<string, { count: number; lastLearned: number }> = new Map();

  constructor(config: Partial<EvaluationConfig> = {}) {
    this.config = { ...DEFAULT_EVALUATION_CONFIG, ...config };
  }

  // ── 1. After-Action Evaluation ──

  evaluateOutcome(outcome: TaskOutcome): Evaluation {
    const failureCategory = outcome.success
      ? undefined
      : this.classifyFailure(outcome);

    const recoveryAction = failureCategory
      ? this.determineRecovery(failureCategory, outcome.confidence, outcome.taskId)
      : undefined;

    const shouldLearn = this.shouldLearnFromEvent(outcome);
    const learningWeight = shouldLearn
      ? this.calculateLearningWeight(outcome)
      : 0;

    const reflectionInsight = this.buildReflectionInsight(outcome, failureCategory);
    const memoryCandidates = shouldLearn
      ? this.buildMemoryCandidates(outcome)
      : [];

    const evaluation: Evaluation = {
      id: `eval_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      taskId: outcome.taskId,
      userId: outcome.userId,
      intendedOutcome: outcome.intendedOutcome,
      actualOutcome: outcome.actualOutcome,
      success: outcome.success,
      confidence: outcome.confidence,
      failureCategory,
      recoveryAction,
      userFeedback: outcome.userFeedback,
      toolPerformance: outcome.toolPerformance,
      planEfficiency: outcome.planEfficiency,
      shouldLearn,
      learningWeight,
      reflectionInsight,
      memoryCandidates,
      timestamp: Date.now(),
    };

    this.evaluations.set(evaluation.id, evaluation);

    if (outcome.userFeedback) {
      this.recordFeedback(outcome.userId, outcome.userFeedback);
    }

    if (failureCategory) {
      this.recordFailurePattern(outcome.userId, failureCategory, outcome.actualOutcome);
    }

    return evaluation;
  }

  // ── 2. Failure Classification ──

  classifyFailure(outcome: TaskOutcome): FailureCategory {
    const errorText = [
      outcome.userFeedback?.text ?? "",
      outcome.toolPerformance?.error ?? "",
      outcome.actualOutcome,
    ].join(" ").toLowerCase();

    // Explicit user corrections (highest priority)
    if (outcome.userFeedback?.type === "correction") {
      return "USER_ERROR";
    }

    // Structural signals (before text regex — text may be ambiguous)
    // Tool performance signals
    if (outcome.toolPerformance && !outcome.toolPerformance.success) {
      return "TOOL_ERROR";
    }

    // Plan efficiency signals
    if (outcome.planEfficiency) {
      const failRate = outcome.planEfficiency.stepsFailed / Math.max(outcome.planEfficiency.stepsPlanned, 1);
      if (failRate > 0.5) return "PLANNING_ERROR";
    }

    // Error message patterns
    if (/(timeout|timed out|slow|latency)/i.test(errorText)) {
      return "NETWORK_ERROR";
    }
    if (/(unauthorized|forbidden|permission|denied|auth|token|expired)/i.test(errorText)) {
      return "AUTH_ERROR";
    }
    if (/(tool.*fail|tool.*error|command.*fail|execution.*error)/i.test(errorText)) {
      return "TOOL_ERROR";
    }
    if (/(model|llm|generation|inference|complet)/i.test(errorText)) {
      return "MODEL_ERROR";
    }
    if (/(plan|step|sequence|order|dependency|miss)/i.test(errorText)) {
      return "PLANNING_ERROR";
    }

    return "UNKNOWN";
  }

  // ── 3. Recovery ──

  determineRecovery(
    category: FailureCategory,
    confidence: number,
    taskId: string
  ): RecoveryAction {
    const recentFailures = this.getRecentFailureCount(taskId);

    switch (category) {
      case "NETWORK_ERROR":
        return recentFailures < this.config.maxRetriesForRecovery ? "retry" : "stop";

      case "TOOL_ERROR":
        return recentFailures < this.config.maxRetriesForRecovery ? "replan" : "stop";

      case "AUTH_ERROR":
        return "ask";

      case "USER_ERROR":
        return "learn";

      case "MODEL_ERROR":
        return confidence < this.config.minConfidenceForAction ? "replan" : "retry";

      case "PLANNING_ERROR":
        return "replan";

      case "UNKNOWN":
      default:
        if (recentFailures >= this.config.maxRetriesForRecovery) return "stop";
        if (confidence < this.config.minConfidenceForAction) return "ask";
        return "retry";
    }
  }

  // ── 4. User Feedback ──

  processUserFeedback(userId: string, feedback: UserFeedback): {
    isCorrection: boolean;
    feedbackType: FeedbackType;
    learningWeight: number;
    preferenceUpdate?: UserPreference;
  } {
    const isCorrection = feedback.type === "correction" && feedback.explicit;
    const learningWeight = this.calculateFeedbackWeight(feedback);

    let preferenceUpdate: UserPreference | undefined;

    if (feedback.type === "correction" || feedback.type === "preference") {
      preferenceUpdate = this.updateUserPreference(userId, feedback);
    }

    this.recordFeedback(userId, feedback);

    return {
      isCorrection,
      feedbackType: feedback.type,
      learningWeight,
      preferenceUpdate,
    };
  }

  // ── 5. Overlearning Prevention ──

  shouldLearnFromEvent(outcome: TaskOutcome): boolean {
    // Successes with high confidence → learn procedural strategies
    if (outcome.success && outcome.confidence >= this.config.learningThreshold) {
      return true;
    }

    // Failures → learn if we have enough evidence
    if (!outcome.success) {
      const similarFailures = this.getSimilarFailureCount(
        outcome.userId,
        outcome.actualOutcome
      );
      if (similarFailures >= this.config.minFeedbackForPattern) {
        return true;
      }
    }

    // Explicit user feedback → always learn
    if (outcome.userFeedback?.explicit && outcome.userFeedback.importance > 0.5) {
      return true;
    }

    return false;
  }

  shouldApplyLearning(userId: string, eventKey: string, confidence: number): boolean {
    if (confidence < this.config.learningThreshold) return false;

    const event = this.learningEvents.get(eventKey);
    if (!event) {
      this.trackLearningEvent(eventKey);
      return true;
    }

    // Rate-limit: after 3+ applications within 1 hour, suppress
    const hoursSinceLastLearned = (Date.now() - event.lastLearned) / (1000 * 60 * 60);
    if (hoursSinceLastLearned < 1 && event.count >= 3) return false;

    this.trackLearningEvent(eventKey);
    return true;
  }

  // ── 6. Reflection Integration ──

  buildReflectionInsight(
    outcome: TaskOutcome,
    failureCategory?: FailureCategory
  ): ReflectionInsight | undefined {
    if (outcome.success && outcome.confidence >= this.config.learningThreshold) {
      return {
        type: "learning",
        description: `Task "${outcome.intendedOutcome}" succeeded. ${outcome.actualOutcome}`,
        confidence: outcome.confidence,
        evidence: [outcome.intendedOutcome, outcome.actualOutcome],
        relatedMemoryIds: [],
      };
    }

    if (!outcome.success && failureCategory) {
      const insightType = outcome.userFeedback?.type === "correction"
        ? "correction"
        : "pattern";

      return {
        type: insightType,
        description: `Task "${outcome.intendedOutcome}" failed (${failureCategory}). ${outcome.actualOutcome}`,
        confidence: 1 - outcome.confidence,
        evidence: [
          failureCategory,
          outcome.actualOutcome,
          outcome.userFeedback?.text ?? "",
        ].filter(Boolean),
        relatedMemoryIds: [],
      };
    }

    return undefined;
  }

  buildStrategyUpdate(outcome: TaskOutcome): StrategyUpdate | undefined {
    if (!outcome.planEfficiency) return undefined;

    const pe = outcome.planEfficiency;
    const successRate = pe.stepsPlanned > 0 ? pe.stepsSucceeded / pe.stepsPlanned : 0;

    return {
      strategyId: `strategy_${outcome.taskId}`,
      name: outcome.intendedOutcome,
      description: outcome.actualOutcome,
      successRate,
      useCount: pe.stepsExecuted,
      lastUpdated: Date.now(),
      context: outcome.failureCategory ?? "success",
      improvement: pe.replannedCount > 0
        ? `Replanned ${pe.replannedCount} time(s)`
        : "No replanning needed",
    };
  }

  // ── 7. Procedural Memory Candidates ──

  buildMemoryCandidates(outcome: TaskOutcome): MemoryTransaction[] {
    const candidates: MemoryTransaction[] = [];

    if (outcome.success && outcome.planEfficiency) {
      const pe = outcome.planEfficiency;
      if (pe.stepsSucceeded > 0) {
        candidates.push({
          action: "ADD",
          id: `mem_${Date.now()}_proc`,
          layer: "procedural",
          category: "strategy",
          text: `Strategy for "${outcome.intendedOutcome}": ${pe.stepsSucceeded}/${pe.stepsPlanned} steps succeeded in ${pe.totalDurationMs}ms`,
          metadata: {
            importance: outcome.confidence * 0.8,
            confidence: outcome.confidence,
            source: "conversation",
            timestamp: Date.now(),
            lastAccessed: Date.now(),
            lastReinforced: Date.now(),
            category: "strategy",
            relationships: [outcome.taskId],
            userId: outcome.userId,
          },
        });
      }
    }

    if (outcome.userFeedback?.type === "correction") {
      candidates.push({
        action: "ADD",
        id: `mem_${Date.now()}_corr`,
        layer: "semantic",
        category: "preference",
        text: `User correction: "${outcome.userFeedback.text}" for task "${outcome.intendedOutcome}"`,
        metadata: {
          importance: outcome.userFeedback.importance,
          confidence: 0.9,
          source: "user_correction",
          timestamp: Date.now(),
          lastAccessed: Date.now(),
          lastReinforced: Date.now(),
          category: "preference",
          relationships: [outcome.taskId],
          userId: outcome.userId,
        },
      });
    }

    return candidates;
  }

  // ── 8. Retrieval ──

  getEvaluation(evalId: string): Evaluation | undefined {
    return this.evaluations.get(evalId);
  }

  getEvaluationsForTask(taskId: string): Evaluation[] {
    return Array.from(this.evaluations.values()).filter(e => e.taskId === taskId);
  }

  getEvaluationsForUser(userId: string): Evaluation[] {
    return Array.from(this.evaluations.values()).filter(e => e.userId === userId);
  }

  getRecentEvaluations(userId: string, limit: number = 10): Evaluation[] {
    return this.getEvaluationsForUser(userId)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  getSuccessRate(userId: string): number {
    const evals = this.getEvaluationsForUser(userId);
    if (evals.length === 0) return 1;
    return evals.filter(e => e.success).length / evals.length;
  }

  getAverageConfidence(userId: string): number {
    const evals = this.getEvaluationsForUser(userId);
    if (evals.length === 0) return 1;
    return evals.reduce((sum, e) => sum + e.confidence, 0) / evals.length;
  }

  getFailurePatterns(userId: string): FailurePattern[] {
    return this.failurePatterns.get(userId) ?? [];
  }

  getUserPreferences(userId: string): UserPreference[] {
    return this.userPreferences.get(userId) ?? [];
  }

  getUserPreference(userId: string, preferenceKey: string): UserPreference | undefined {
    return this.getUserPreferences(userId).find(p =>
      p.preference.toLowerCase().includes(preferenceKey.toLowerCase())
    );
  }

  // ── 9. Reset ──

  reset(): void {
    this.evaluations.clear();
    this.userFeedback.clear();
    this.failurePatterns.clear();
    this.userPreferences.clear();
    this.learningEvents.clear();
  }

  // ── Internal Helpers ──

  private recordFeedback(userId: string, feedback: UserFeedback): void {
    const existing = this.userFeedback.get(userId) ?? [];
    existing.push(feedback);
    this.userFeedback.set(userId, existing);
  }

  private recordFailurePattern(userId: string, category: FailureCategory, example: string): void {
    const patterns = this.failurePatterns.get(userId) ?? [];
    const existing = patterns.find(p => p.category === category);

    if (existing) {
      existing.count++;
      existing.lastOccurrence = Date.now();
      if (existing.examples.length < 5) {
        existing.examples.push(example);
      }
    } else {
      patterns.push({
        category,
        count: 1,
        lastOccurrence: Date.now(),
        examples: [example],
      });
    }

    this.failurePatterns.set(userId, patterns);
  }

  private updateUserPreference(userId: string, feedback: UserFeedback): UserPreference {
    const preferences = this.userPreferences.get(userId) ?? [];
    let pref = preferences.find(p =>
      p.preference.toLowerCase() === feedback.text.toLowerCase()
    );

    if (pref) {
      pref.strength = Math.min(1, pref.strength + 0.1);
      pref.lastReinforced = Date.now();
      pref.evidenceCount++;
    } else {
      pref = {
        userId,
        preference: feedback.text,
        strength: Math.min(1, feedback.importance),
        lastReinforced: Date.now(),
        evidenceCount: 1,
      };
      preferences.push(pref);
    }

    this.userPreferences.set(userId, preferences);
    return pref;
  }

  private getRecentFailureCount(taskId: string): number {
    return Array.from(this.evaluations.values()).filter(
      e => e.taskId === taskId && !e.success &&
        (Date.now() - e.timestamp) < this.config.feedbackDecayHours * 3600000
    ).length;
  }

  private getSimilarFailureCount(userId: string, actualOutcome: string): number {
    const feedback = this.userFeedback.get(userId) ?? [];
    return feedback.filter(f =>
      f.type === "correction" &&
      (Date.now() - f.timestamp) < this.config.feedbackDecayHours * 3600000
    ).length;
  }

  private calculateFeedbackWeight(feedback: UserFeedback): number {
    let weight = feedback.importance;

    if (feedback.explicit) weight *= 1.5;

    const hoursSinceFeedback = (Date.now() - feedback.timestamp) / (1000 * 60 * 60);
    const decay = Math.exp(-hoursSinceFeedback / this.config.feedbackDecayHours);
    weight *= decay;

    return Math.min(1, Math.max(0, weight));
  }

  private calculateLearningWeight(outcome: TaskOutcome): number {
    let weight = outcome.confidence;

    if (outcome.userFeedback?.explicit) {
      weight = Math.max(weight, outcome.userFeedback.importance);
    }

    if (outcome.planEfficiency) {
      const efficiency = outcome.planEfficiency.stepsSucceeded /
        Math.max(outcome.planEfficiency.stepsPlanned, 1);
      weight = (weight + efficiency) / 2;
    }

    return Math.min(1, Math.max(0, weight));
  }

  private trackLearningEvent(eventKey: string): void {
    const event = this.learningEvents.get(eventKey);
    if (event) {
      event.count++;
      event.lastLearned = Date.now();
    } else {
      this.learningEvents.set(eventKey, { count: 1, lastLearned: Date.now() });
    }
  }
}
