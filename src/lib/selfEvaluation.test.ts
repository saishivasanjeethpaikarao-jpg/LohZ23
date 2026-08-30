import { describe, it, expect, beforeEach } from "vitest";
import {
  SelfEvaluationEngine,
  TaskOutcome,
  UserFeedback,
  DEFAULT_EVALUATION_CONFIG,
} from "./selfEvaluation";

// ── Helpers ──

function successOutcome(overrides: Partial<TaskOutcome> = {}): TaskOutcome {
  return {
    taskId: "task_1",
    userId: "u1",
    intendedOutcome: "Search for TypeScript patterns",
    actualOutcome: "Found 5 relevant results",
    success: true,
    confidence: 0.9,
    timestamp: Date.now(),
    ...overrides,
  };
}

function failureOutcome(overrides: Partial<TaskOutcome> = {}): TaskOutcome {
  return {
    taskId: "task_1",
    userId: "u1",
    intendedOutcome: "Search for TypeScript patterns",
    actualOutcome: "Tool failed: timeout error",
    success: false,
    confidence: 0.2,
    timestamp: Date.now(),
    ...overrides,
  };
}

function correctionFeedback(text: string = "That's wrong."): UserFeedback {
  return {
    text,
    type: "correction",
    importance: 0.9,
    timestamp: Date.now(),
    explicit: true,
  };
}

function preferenceFeedback(text: string = "I prefer dark mode."): UserFeedback {
  return {
    text,
    type: "preference",
    importance: 0.7,
    timestamp: Date.now(),
    explicit: true,
  };
}

// ── Tests ──

describe("SelfEvaluationEngine", () => {
  let engine: SelfEvaluationEngine;

  beforeEach(() => {
    engine = new SelfEvaluationEngine({
      minConfidenceForAction: 0.3,
      maxRetriesForRecovery: 3,
      feedbackDecayHours: 24,
      minFeedbackForPattern: 2,
      learningThreshold: 0.6,
    });
  });

  // ── 1. Success Evaluation ──

  describe("success evaluation", () => {
    it("should evaluate successful outcome", () => {
      const eval_ = engine.evaluateOutcome(successOutcome());
      expect(eval_.success).toBe(true);
      expect(eval_.failureCategory).toBeUndefined();
      expect(eval_.recoveryAction).toBeUndefined();
      expect(eval_.shouldLearn).toBe(true);
    });

    it("should build reflection insight for success", () => {
      const eval_ = engine.evaluateOutcome(successOutcome());
      expect(eval_.reflectionInsight).not.toBeUndefined();
      expect(eval_.reflectionInsight!.type).toBe("learning");
      expect(eval_.reflectionInsight!.confidence).toBe(0.9);
    });

    it("should build memory candidates for success", () => {
      const outcome = successOutcome({
        planEfficiency: {
          stepsPlanned: 3,
          stepsExecuted: 3,
          stepsSucceeded: 3,
          stepsFailed: 0,
          totalDurationMs: 1500,
          replannedCount: 0,
        },
      });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.memoryCandidates!.length).toBe(1);
      expect(eval_.memoryCandidates![0].layer).toBe("procedural");
    });

    it("should record evaluation", () => {
      const eval_ = engine.evaluateOutcome(successOutcome());
      const retrieved = engine.getEvaluation(eval_.id);
      expect(retrieved).not.toBeUndefined();
      expect(retrieved!.taskId).toBe("task_1");
    });

    it("should calculate success rate", () => {
      engine.evaluateOutcome(successOutcome({ taskId: "t1" }));
      engine.evaluateOutcome(successOutcome({ taskId: "t2" }));
      engine.evaluateOutcome(failureOutcome({ taskId: "t3" }));

      expect(engine.getSuccessRate("u1")).toBeCloseTo(2 / 3);
    });
  });

  // ── 2. Failure Classification ──

  describe("failure classification", () => {
    it("should classify USER_ERROR from correction feedback", () => {
      const outcome = failureOutcome({
        userFeedback: correctionFeedback("You used the wrong tool"),
      });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.failureCategory).toBe("USER_ERROR");
    });

    it("should classify NETWORK_ERROR from timeout", () => {
      const outcome = failureOutcome({
        actualOutcome: "Request timed out after 30s",
      });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.failureCategory).toBe("NETWORK_ERROR");
    });

    it("should classify AUTH_ERROR from permission denied", () => {
      const outcome = failureOutcome({
        actualOutcome: "Permission denied: insufficient access",
      });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.failureCategory).toBe("AUTH_ERROR");
    });

    it("should classify TOOL_ERROR from tool failure", () => {
      const outcome = failureOutcome({
        actualOutcome: "Tool execution error: command failed",
      });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.failureCategory).toBe("TOOL_ERROR");
    });

    it("should classify MODEL_ERROR from model failure", () => {
      const outcome = failureOutcome({
        actualOutcome: "Model inference failed: context length exceeded",
      });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.failureCategory).toBe("MODEL_ERROR");
    });

    it("should classify PLANNING_ERROR from planning failure", () => {
      const outcome = failureOutcome({
        actualOutcome: "Step dependency missed: step 3 requires step 2",
      });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.failureCategory).toBe("PLANNING_ERROR");
    });

    it("should classify TOOL_ERROR from tool performance metrics", () => {
      const outcome = failureOutcome({
        actualOutcome: "Something happened",
        toolPerformance: {
          toolName: "web_search",
          success: false,
          latencyMs: 5000,
          error: "connection refused",
          retryCount: 2,
        },
      });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.failureCategory).toBe("TOOL_ERROR");
    });

    it("should classify PLANNING_ERROR from high step failure rate", () => {
      const outcome = failureOutcome({
        actualOutcome: "Partial completion",
        planEfficiency: {
          stepsPlanned: 4,
          stepsExecuted: 4,
          stepsSucceeded: 1,
          stepsFailed: 3,
          totalDurationMs: 5000,
          replannedCount: 2,
        },
      });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.failureCategory).toBe("PLANNING_ERROR");
    });

    it("should classify UNKNOWN for unrecognized patterns", () => {
      const outcome = failureOutcome({
        actualOutcome: "Something unexpected happened",
      });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.failureCategory).toBe("UNKNOWN");
    });
  });

  // ── 3. Recovery ──

  describe("recovery", () => {
    it("should retry on NETWORK_ERROR with few failures", () => {
      const outcome = failureOutcome({ actualOutcome: "timeout error" });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.recoveryAction).toBe("retry");
    });

    it("should stop on NETWORK_ERROR after max retries", () => {
      for (let i = 0; i < 4; i++) {
        engine.evaluateOutcome(failureOutcome({
          actualOutcome: "timeout error",
          timestamp: Date.now() - i * 1000,
        }));
      }
      const eval_ = engine.evaluateOutcome(failureOutcome({
        actualOutcome: "timeout error again",
      }));
      expect(eval_.recoveryAction).toBe("stop");
    });

    it("should replan on TOOL_ERROR", () => {
      const outcome = failureOutcome({
        actualOutcome: "tool execution error",
      });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.recoveryAction).toBe("replan");
    });

    it("should ask on AUTH_ERROR", () => {
      const outcome = failureOutcome({
        actualOutcome: "permission denied",
      });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.recoveryAction).toBe("ask");
    });

    it("should learn on USER_ERROR", () => {
      const outcome = failureOutcome({
        userFeedback: correctionFeedback("Wrong approach"),
      });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.recoveryAction).toBe("learn");
    });

    it("should replan on MODEL_ERROR with low confidence", () => {
      const outcome = failureOutcome({
        actualOutcome: "model inference failed",
        confidence: 0.1,
      });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.recoveryAction).toBe("replan");
    });

    it("should retry on MODEL_ERROR with higher confidence", () => {
      const outcome = failureOutcome({
        actualOutcome: "model inference failed",
        confidence: 0.5,
      });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.recoveryAction).toBe("retry");
    });

    it("should replan on PLANNING_ERROR", () => {
      const outcome = failureOutcome({
        actualOutcome: "step dependency missed",
      });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.recoveryAction).toBe("replan");
    });

    it("should ask on UNKNOWN with low confidence", () => {
      const outcome = failureOutcome({
        actualOutcome: "something weird",
        confidence: 0.1,
      });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.recoveryAction).toBe("ask");
    });

    it("should retry on UNKNOWN with adequate confidence", () => {
      const outcome = failureOutcome({
        actualOutcome: "something weird",
        confidence: 0.5,
      });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.recoveryAction).toBe("retry");
    });

    it("should stop on UNKNOWN after max retries", () => {
      for (let i = 0; i < 4; i++) {
        engine.evaluateOutcome(failureOutcome({
          actualOutcome: "something weird",
          confidence: 0.5,
          timestamp: Date.now() - i * 1000,
        }));
      }
      const eval_ = engine.evaluateOutcome(failureOutcome({
        actualOutcome: "something weird again",
        confidence: 0.5,
      }));
      expect(eval_.recoveryAction).toBe("stop");
    });
  });

  // ── 4. User Feedback ──

  describe("user feedback", () => {
    it("should process correction feedback", () => {
      const result = engine.processUserFeedback("u1", correctionFeedback("That's wrong"));
      expect(result.isCorrection).toBe(true);
      expect(result.feedbackType).toBe("correction");
      expect(result.learningWeight).toBeGreaterThan(0);
    });

    it("should process preference feedback", () => {
      const result = engine.processUserFeedback("u1", preferenceFeedback("Use bullet points"));
      expect(result.isCorrection).toBe(false);
      expect(result.feedbackType).toBe("preference");
      expect(result.preferenceUpdate).not.toBeUndefined();
      expect(result.preferenceUpdate!.preference).toBe("Use bullet points");
    });

    it("should process confirmation feedback", () => {
      const feedback: UserFeedback = {
        text: "Looks good",
        type: "confirmation",
        importance: 0.3,
        timestamp: Date.now(),
        explicit: false,
      };
      const result = engine.processUserFeedback("u1", feedback);
      expect(result.isCorrection).toBe(false);
      expect(result.feedbackType).toBe("confirmation");
    });

    it("should strengthen existing preference on repeat", () => {
      engine.processUserFeedback("u1", preferenceFeedback("Use bullet points"));
      const result = engine.processUserFeedback("u1", preferenceFeedback("Use bullet points"));
      expect(result.preferenceUpdate!.evidenceCount).toBe(2);
      expect(result.preferenceUpdate!.strength).toBeGreaterThan(0.7);
    });

    it("should not mark non-explicit correction as correction", () => {
      const feedback: UserFeedback = {
        text: "That's wrong",
        type: "correction",
        importance: 0.9,
        timestamp: Date.now(),
        explicit: false,
      };
      const result = engine.processUserFeedback("u1", feedback);
      expect(result.isCorrection).toBe(false);
    });

    it("should store feedback for user", () => {
      engine.processUserFeedback("u1", correctionFeedback("Wrong"));
      engine.processUserFeedback("u1", preferenceFeedback("Better way"));

      const evals = engine.getRecentEvaluations("u1");
      expect(evals.length).toBe(0); // No task evaluations yet, just feedback
    });
  });

  // ── 5. Overlearning Prevention ──

  describe("overlearning prevention", () => {
    it("should learn from high-confidence success", () => {
      const outcome = successOutcome({ confidence: 0.9 });
      expect(engine.shouldLearnFromEvent(outcome)).toBe(true);
    });

    it("should not learn from low-confidence success", () => {
      const outcome = successOutcome({ confidence: 0.3 });
      expect(engine.shouldLearnFromEvent(outcome)).toBe(false);
    });

    it("should learn from failure with enough evidence", () => {
      // Record enough feedback to trigger learning
      for (let i = 0; i < 2; i++) {
        engine.processUserFeedback("u1", correctionFeedback(`Wrong approach ${i}`));
      }
      const outcome = failureOutcome({ confidence: 0.2 });
      expect(engine.shouldLearnFromEvent(outcome)).toBe(true);
    });

    it("should not learn from single failure without feedback", () => {
      const outcome = failureOutcome({ confidence: 0.2 });
      expect(engine.shouldLearnFromEvent(outcome)).toBe(false);
    });

    it("should learn from explicit high-importance feedback", () => {
      const outcome = successOutcome({
        confidence: 0.3,
        userFeedback: {
          text: "Great job",
          type: "confirmation",
          importance: 0.9,
          timestamp: Date.now(),
          explicit: true,
        },
      });
      expect(engine.shouldLearnFromEvent(outcome)).toBe(true);
    });

    it("should apply learning based on confidence threshold", () => {
      expect(engine.shouldApplyLearning("u1", "event_1", 0.8)).toBe(true);
      expect(engine.shouldApplyLearning("u1", "event_1", 0.2)).toBe(false);
    });

    it("should rate-limit repeated learning events", () => {
      // First application
      engine.shouldApplyLearning("u1", "event_1", 0.9);
      // Immediate second application of same event should be rate-limited
      // (within 1 hour with count > 3)
      for (let i = 0; i < 3; i++) {
        engine.shouldApplyLearning("u1", "event_1", 0.9);
      }
      // Now at count=4, within 1 hour → should be rate-limited
      expect(engine.shouldApplyLearning("u1", "event_1", 0.9)).toBe(false);
    });
  });

  // ── 6. Reflection Integration ──

  describe("reflection integration", () => {
    it("should build learning insight for success", () => {
      const eval_ = engine.evaluateOutcome(successOutcome());
      expect(eval_.reflectionInsight).not.toBeUndefined();
      expect(eval_.reflectionInsight!.type).toBe("learning");
      expect(eval_.reflectionInsight!.evidence.length).toBeGreaterThan(0);
    });

    it("should build correction insight for user error", () => {
      const eval_ = engine.evaluateOutcome(failureOutcome({
        userFeedback: correctionFeedback("Wrong tool"),
      }));
      expect(eval_.reflectionInsight).not.toBeUndefined();
      expect(eval_.reflectionInsight!.type).toBe("correction");
    });

    it("should build pattern insight for non-user failure", () => {
      const eval_ = engine.evaluateOutcome(failureOutcome({
        actualOutcome: "timeout error",
      }));
      expect(eval_.reflectionInsight).not.toBeUndefined();
      expect(eval_.reflectionInsight!.type).toBe("pattern");
    });

    it("should not build insight for low-confidence success", () => {
      const eval_ = engine.evaluateOutcome(successOutcome({ confidence: 0.3 }));
      expect(eval_.reflectionInsight).toBeUndefined();
    });

    it("should build strategy update from plan efficiency", () => {
      const outcome = successOutcome({
        planEfficiency: {
          stepsPlanned: 3,
          stepsExecuted: 4,
          stepsSucceeded: 3,
          stepsFailed: 1,
          totalDurationMs: 2000,
          replannedCount: 1,
        },
      });
      const eval_ = engine.evaluateOutcome(outcome);
      const strategy = engine.buildStrategyUpdate(outcome);
      expect(strategy).not.toBeUndefined();
      expect(strategy!.successRate).toBeCloseTo(3 / 3);
      expect(strategy!.useCount).toBe(4);
    });
  });

  // ── 7. Procedural Memory ──

  describe("procedural memory", () => {
    it("should create procedural memory for successful strategy", () => {
      const outcome = successOutcome({
        planEfficiency: {
          stepsPlanned: 3,
          stepsExecuted: 3,
          stepsSucceeded: 3,
          stepsFailed: 0,
          totalDurationMs: 1500,
          replannedCount: 0,
        },
      });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.memoryCandidates!.length).toBe(1);
      expect(eval_.memoryCandidates![0].layer).toBe("procedural");
      expect(eval_.memoryCandidates![0].category).toBe("strategy");
    });

    it("should create user model memory for correction", () => {
      const outcome = failureOutcome({
        userFeedback: correctionFeedback("Don't use that approach"),
      });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.memoryCandidates!.length).toBe(1);
      expect(eval_.memoryCandidates![0].layer).toBe("user_model");
      expect(eval_.memoryCandidates![0].category).toBe("preference");
    });

    it("should not create memory for non-learnable events", () => {
      const outcome = successOutcome({ confidence: 0.3 });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.memoryCandidates!.length).toBe(0);
    });

    it("should include task relationships in memory", () => {
      const outcome = successOutcome({
        planEfficiency: {
          stepsPlanned: 2,
          stepsExecuted: 2,
          stepsSucceeded: 2,
          stepsFailed: 0,
          totalDurationMs: 1000,
          replannedCount: 0,
        },
      });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.memoryCandidates![0].metadata.relationships).toContain("task_1");
    });
  });

  // ── 8. Repeated Failure ──

  describe("repeated failure", () => {
    it("should track failure patterns", () => {
      engine.evaluateOutcome(failureOutcome({ actualOutcome: "timeout error" }));
      engine.evaluateOutcome(failureOutcome({ actualOutcome: "timeout error" }));

      const patterns = engine.getFailurePatterns("u1");
      expect(patterns.length).toBe(1);
      expect(patterns[0].category).toBe("NETWORK_ERROR");
      expect(patterns[0].count).toBe(2);
    });

    it("should accumulate examples up to 5", () => {
      for (let i = 0; i < 7; i++) {
        engine.evaluateOutcome(failureOutcome({ actualOutcome: `error ${i}` }));
      }
      const patterns = engine.getFailurePatterns("u1");
      expect(patterns[0].examples.length).toBe(5);
    });

    it("should stop recovery after max retries", () => {
      for (let i = 0; i < 5; i++) {
        engine.evaluateOutcome(failureOutcome({
          actualOutcome: "timeout",
          timestamp: Date.now() - i * 1000,
        }));
      }
      const eval_ = engine.evaluateOutcome(failureOutcome({ actualOutcome: "timeout" }));
      expect(eval_.recoveryAction).toBe("stop");
    });

    it("should classify repeated failures consistently", () => {
      engine.evaluateOutcome(failureOutcome({ actualOutcome: "permission denied" }));
      engine.evaluateOutcome(failureOutcome({ actualOutcome: "access forbidden" }));

      const patterns = engine.getFailurePatterns("u1");
      expect(patterns.length).toBe(1);
      expect(patterns[0].category).toBe("AUTH_ERROR");
      expect(patterns[0].count).toBe(2);
    });
  });

  // ── 9. Low Confidence ──

  describe("low confidence", () => {
    it("should ask for help on low-confidence unknown failure", () => {
      const eval_ = engine.evaluateOutcome(failureOutcome({
        actualOutcome: "something happened",
        confidence: 0.1,
      }));
      expect(eval_.recoveryAction).toBe("ask");
    });

    it("should replan on low-confidence model error", () => {
      const eval_ = engine.evaluateOutcome(failureOutcome({
        actualOutcome: "model inference failed",
        confidence: 0.15,
      }));
      expect(eval_.recoveryAction).toBe("replan");
    });

    it("should not learn from low-confidence success", () => {
      const eval_ = engine.evaluateOutcome(successOutcome({ confidence: 0.2 }));
      expect(eval_.shouldLearn).toBe(false);
    });

    it("should calculate low learning weight for low confidence", () => {
      const outcome = successOutcome({ confidence: 0.4 });
      const eval_ = engine.evaluateOutcome(outcome);
      expect(eval_.learningWeight).toBeLessThan(0.5);
    });
  });

  // ── 10. User Preference ──

  describe("user preference", () => {
    it("should retrieve user preferences", () => {
      engine.processUserFeedback("u1", preferenceFeedback("Use bullet points"));
      engine.processUserFeedback("u1", preferenceFeedback("Keep it short"));

      const prefs = engine.getUserPreferences("u1");
      expect(prefs.length).toBe(2);
    });

    it("should find preference by key", () => {
      engine.processUserFeedback("u1", preferenceFeedback("Use bullet points"));
      const pref = engine.getUserPreference("u1", "bullet");
      expect(pref).not.toBeUndefined();
      expect(pref!.preference).toBe("Use bullet points");
    });

    it("should return undefined for unknown preference", () => {
      const pref = engine.getUserPreference("u1", "nonexistent");
      expect(pref).toBeUndefined();
    });

    it("should decay feedback weight over time", () => {
      const oldFeedback: UserFeedback = {
        text: "Old correction",
        type: "correction",
        importance: 0.9,
        timestamp: Date.now() - 48 * 3600000, // 48 hours ago
        explicit: true,
      };
      const result = engine.processUserFeedback("u1", oldFeedback);
      expect(result.learningWeight).toBeLessThan(0.9);
    });
  });

  // ── 11. Retrieval ──

  describe("retrieval", () => {
    it("should get evaluations for task", () => {
      engine.evaluateOutcome(successOutcome({ taskId: "t1" }));
      engine.evaluateOutcome(failureOutcome({ taskId: "t1" }));
      engine.evaluateOutcome(successOutcome({ taskId: "t2" }));

      expect(engine.getEvaluationsForTask("t1").length).toBe(2);
      expect(engine.getEvaluationsForTask("t2").length).toBe(1);
    });

    it("should get recent evaluations sorted by time", () => {
      engine.evaluateOutcome(successOutcome({ taskId: "t1" }));
      engine.evaluateOutcome(failureOutcome({ taskId: "t2" }));
      engine.evaluateOutcome(successOutcome({ taskId: "t3" }));

      const recent = engine.getRecentEvaluations("u1", 2);
      expect(recent.length).toBe(2);
      expect(recent[0].timestamp).toBeGreaterThanOrEqual(recent[1].timestamp);
    });

    it("should calculate average confidence", () => {
      engine.evaluateOutcome(successOutcome({ confidence: 0.8 }));
      engine.evaluateOutcome(failureOutcome({ confidence: 0.2 }));

      expect(engine.getAverageConfidence("u1")).toBeCloseTo(0.5);
    });

    it("should return default values for empty user", () => {
      expect(engine.getSuccessRate("nonexistent")).toBe(1);
      expect(engine.getAverageConfidence("nonexistent")).toBe(1);
    });
  });
});
