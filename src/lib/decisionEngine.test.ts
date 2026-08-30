import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DecisionEngine,
  DEFAULT_DECISION_CONFIG,
  createDefaultDecisionEngine,
} from "./decisionEngine";
import { CognitiveState, DEFAULT_COGNITIVE_STATE } from "./cognitiveState";

function makeState(overrides: Partial<CognitiveState> = {}): CognitiveState {
  return { ...DEFAULT_COGNITIVE_STATE, ...overrides };
}

describe("DecisionEngine", () => {
  let engine: DecisionEngine;

  beforeEach(() => {
    engine = createDefaultDecisionEngine();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  describe("constructor", () => {
    it("should use default config when none provided", () => {
      const e = new DecisionEngine();
      const result = e.evaluate(makeState());
      expect(result).toHaveProperty("decision");
      expect(result).toHaveProperty("reason");
      expect(result).toHaveProperty("confidence");
    });

    it("should accept partial config overrides", () => {
      const e = new DecisionEngine({ speakCooldownMs: 1000 });
      expect(e).toBeDefined();
    });
  });

  describe("evaluate", () => {
    it("should return WAIT during cooldown period", () => {
      const state = makeState({ lastLohzSpeech: Date.now() - 5000 });
      const result = engine.evaluate(state);
      expect(result.decision).toBe("WAIT");
      expect(result.reason).toContain("cooldown");
    });

    it("should return WAIT with time remaining info", () => {
      const state = makeState({ lastLohzSpeech: Date.now() - 5000 });
      const result = engine.evaluate(state);
      expect(result.reason).toContain("remaining");
    });

    it("should return ACT for high urgency with high-priority action", () => {
      const state = makeState({
        urgency: 0.9,
        candidateActions: [
          { type: "ACT", description: "Do something", priority: 0.9, estimatedValue: 0.8 },
        ],
        lastLohzSpeech: Date.now() - 60000,
      });
      const result = engine.evaluate(state);
      expect(result.decision).toBe("ACT");
    });

    it("should return SPEAK when user asked a question with high confidence", () => {
      const state = makeState({
        userIntent: "What is the weather?",
        confidence: 0.8,
        lastLohzSpeech: Date.now() - 60000,
      });
      const result = engine.evaluate(state);
      expect(result.decision).toBe("SPEAK");
      expect(result.reason).toContain("question");
    });

    it("should return ASK when user asked a question with low confidence", () => {
      const state = makeState({
        userIntent: "How do I configure this?",
        confidence: 0.5,
        lastLohzSpeech: Date.now() - 60000,
      });
      const result = engine.evaluate(state);
      expect(result.decision).toBe("ASK");
      expect(result.reason).toContain("clarification");
    });

    it("should return SPEAK for active conversation with user's last turn", () => {
      const now = Date.now();
      const state = makeState({
        conversationState: "active",
        confidence: 0.8,
        lastLohzSpeech: now - 60000,
        workingMemory: {
          ...DEFAULT_COGNITIVE_STATE.workingMemory,
          currentConversation: [
            { role: "user", content: "Tell me more", timestamp: now - 5000 },
          ],
        },
      });
      const result = engine.evaluate(state);
      expect(result.decision).toBe("SPEAK");
      expect(result.reason).toContain("responding");
    });

    it("should return IGNORE for extended silence with no pending tasks", () => {
      const state = makeState({
        lastUserActivity: Date.now() - 200000,
        lastLohzSpeech: Date.now() - 200000,
        pendingTasks: [],
      });
      const result = engine.evaluate(state);
      expect(result.decision).toBe("IGNORE");
      expect(result.reason).toContain("Extended silence");
    });

    it("should return WAIT for extended silence with pending tasks", () => {
      const state = makeState({
        lastUserActivity: Date.now() - 200000,
        lastLohzSpeech: Date.now() - 200000,
        pendingTasks: [
          { id: "1", description: "task", status: "pending", createdAt: Date.now(), updatedAt: Date.now(), priority: 0.5 },
        ],
      });
      const result = engine.evaluate(state);
      expect(result.decision).toBe("WAIT");
      expect(result.reason).toContain("pending tasks");
    });

    it("should default to LISTEN for normal state", () => {
      const state = makeState({
        lastLohzSpeech: Date.now() - 60000,
        lastUserActivity: Date.now() - 1000,
        conversationState: "active",
      });
      const result = engine.evaluate(state);
      expect(result.decision).toBe("LISTEN");
    });
  });

  describe("history tracking", () => {
    it("should track decision history", () => {
      const state = makeState({ lastLohzSpeech: Date.now() - 60000 });
      engine.evaluate(state);
      engine.evaluate(state);
      const history = engine.getHistory();
      expect(history.length).toBeGreaterThanOrEqual(2);
    });

    it("should return a copy of history", () => {
      engine.evaluate(makeState({ lastLohzSpeech: Date.now() - 60000 }));
      const h1 = engine.getHistory();
      const h2 = engine.getHistory();
      expect(h1).not.toBe(h2);
      expect(h1).toEqual(h2);
    });

    it("should track last decision", () => {
      engine.evaluate(makeState({ lastLohzSpeech: Date.now() - 60000 }));
      const last = engine.getLastDecision();
      expect(["SPEAK", "LISTEN", "WAIT", "ASK", "ACT", "IGNORE"]).toContain(last);
    });
  });

  describe("reset", () => {
    it("should clear history and state", () => {
      engine.evaluate(makeState({ lastLohzSpeech: Date.now() - 60000 }));
      engine.reset();
      expect(engine.getHistory()).toEqual([]);
      expect(engine.getLastDecision()).toBe("LISTEN");
    });
  });

  describe("history cap at 100", () => {
    it("should not exceed 100 entries", () => {
      for (let i = 0; i < 120; i++) {
        engine.evaluate(makeState({ lastLohzSpeech: Date.now() - 60000 }));
      }
      expect(engine.getHistory().length).toBeLessThanOrEqual(100);
    });
  });
});

describe("DEFAULT_DECISION_CONFIG", () => {
  it("should have sensible defaults", () => {
    expect(DEFAULT_DECISION_CONFIG.speakCooldownMs).toBe(30000);
    expect(DEFAULT_DECISION_CONFIG.minConfidenceToSpeak).toBe(0.7);
    expect(DEFAULT_DECISION_CONFIG.minConfidenceToAct).toBe(0.6);
    expect(DEFAULT_DECISION_CONFIG.maxSilenceBeforeProactiveMs).toBe(120000);
    expect(DEFAULT_DECISION_CONFIG.minSilenceBeforeProactiveMs).toBe(10000);
  });
});

describe("createDefaultDecisionEngine", () => {
  it("should return a DecisionEngine instance", () => {
    const e = createDefaultDecisionEngine();
    expect(e).toBeInstanceOf(DecisionEngine);
  });
});
