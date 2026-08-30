import { describe, it, expect, beforeEach } from "vitest";
import { SilenceAnalyzer, SilenceContext } from "./silenceAnalyzer";

function makeContext(overrides: Partial<SilenceContext> = {}): SilenceContext {
  return {
    lastConversationTopic: null,
    activeGoals: false,
    pendingTasks: false,
    timeSinceLastLohzSpeech: 10000,
    userActivity: "idle",
    recentToolActivity: false,
    conversationTurns: 4,
    ...overrides,
  };
}

describe("SilenceAnalyzer", () => {
  let analyzer: SilenceAnalyzer;

  beforeEach(() => {
    analyzer = new SilenceAnalyzer();
  });

  it("should classify short pause (1-5s)", () => {
    const result = analyzer.classify(2000, makeContext());
    expect(result.type).toBe("short_pause");
    expect(result.shouldInitiate).toBe(false);
  });

  it("should classify conversation end (5-30s)", () => {
    const result = analyzer.classify(15000, makeContext());
    expect(result.type).toBe("conversation_end");
  });

  it("should classify extended inactivity (30s-5min)", () => {
    const result = analyzer.classify(120000, makeContext());
    expect(result.type).toBe("extended_inactivity");
  });

  it("should classify deep idle (5min+)", () => {
    const result = analyzer.classify(400000, makeContext());
    expect(result.type).toBe("deep_idle");
    expect(result.shouldInitiate).toBe(false);
  });

  it("should not initiate on short pause", () => {
    const result = analyzer.classify(3000, makeContext());
    expect(result.shouldInitiate).toBe(false);
  });

  it("should initiate on conversation_end when unresolved and has work", () => {
    const result = analyzer.classify(15000, makeContext({
      pendingTasks: true,
      recentToolActivity: true,
    }));
    expect(result.shouldInitiate).toBe(true);
    expect(result.type).toBe("conversation_end");
  });

  it("should not initiate on conversation_end when resolved and no work", () => {
    const result = analyzer.classify(15000, makeContext({
      pendingTasks: false,
      activeGoals: false,
      recentToolActivity: false,
    }));
    expect(result.shouldInitiate).toBe(false);
  });

  it("should initiate on conversation_end with active goals", () => {
    const result = analyzer.classify(15000, makeContext({
      activeGoals: true,
      pendingTasks: false,
    }));
    expect(result.shouldInitiate).toBe(true);
  });

  it("should initiate on extended_inactivity with pending work and goals", () => {
    const result = analyzer.classify(120000, makeContext({
      pendingTasks: true,
      activeGoals: true,
      userActivity: "idle",
    }));
    expect(result.shouldInitiate).toBe(true);
    expect(result.type).toBe("extended_inactivity");
  });

  it("should not initiate on extended_inactivity when user is typing", () => {
    const result = analyzer.classify(120000, makeContext({
      userActivity: "typing",
    }));
    expect(result.shouldInitiate).toBe(false);
  });

  it("should not initiate on extended_inactivity with recent tool activity", () => {
    const result = analyzer.classify(120000, makeContext({
      recentToolActivity: true,
      pendingTasks: false,
    }));
    expect(result.shouldInitiate).toBe(false);
  });

  it("should not initiate on deep idle", () => {
    const result = analyzer.classify(400000, makeContext({
      pendingTasks: true,
      activeGoals: true,
    }));
    expect(result.shouldInitiate).toBe(false);
    expect(result.type).toBe("deep_idle");
  });

  it("should have higher confidence for deep idle", () => {
    const result = analyzer.classify(400000, makeContext());
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("should include context contribution when active goals exist", () => {
    const result = analyzer.classify(15000, makeContext({
      activeGoals: true,
    }));
    expect(result.contextContribution).toBeGreaterThan(0);
  });

  it("should reduce context contribution with recent tool activity", () => {
    const withTools = analyzer.classify(15000, makeContext({
      activeGoals: true,
      recentToolActivity: true,
    }));
    const withoutTools = analyzer.classify(15000, makeContext({
      activeGoals: true,
      recentToolActivity: false,
    }));
    expect(withTools.contextContribution).toBeLessThan(withoutTools.contextContribution);
  });

  it("should provide reasons for all classifications", () => {
    const durations = [2000, 15000, 120000, 400000];
    for (const d of durations) {
      const result = analyzer.classify(d, makeContext());
      expect(result.reason).toBeTruthy();
      expect(typeof result.reason).toBe("string");
    }
  });

  it("should handle edge case at boundary (5000ms)", () => {
    const result = analyzer.classify(5000, makeContext());
    expect(["short_pause", "conversation_end"]).toContain(result.type);
  });

  it("should handle edge case at boundary (30000ms)", () => {
    const result = analyzer.classify(30000, makeContext());
    expect(["conversation_end", "extended_inactivity"]).toContain(result.type);
  });

  it("should handle edge case at boundary (300000ms)", () => {
    const result = analyzer.classify(300000, makeContext());
    expect(["extended_inactivity", "deep_idle"]).toContain(result.type);
  });

  it("should reset without error", () => {
    analyzer.classify(15000, makeContext());
    analyzer.reset();
    const result = analyzer.classify(15000, makeContext());
    expect(result.type).toBe("conversation_end");
  });
});
