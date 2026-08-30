import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProactiveSpeechPolicy, DEFAULT_PROACTIVE_CONFIG, createProactiveSpeechPolicy } from "./proactiveSpeech";
import { CognitiveState, DEFAULT_COGNITIVE_STATE } from "./cognitiveState";

function makeState(overrides: Partial<CognitiveState> = {}): CognitiveState {
  return { ...DEFAULT_COGNITIVE_STATE, ...overrides };
}

describe("ProactiveSpeechPolicy", () => {
  let p: ProactiveSpeechPolicy;
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    p = createProactiveSpeechPolicy({ minSilenceMs: 100, maxSilenceMs: 60000, speakCooldownMs: 0, minConfidence: 0.3 });
  });

  it("should return null when silence too short", () => {
    const result = p.evaluate(makeState({ lastUserActivity: Date.now() }));
    expect(result).toBeNull();
  });

  it("should return null when silence too long", () => {
    const result = p.evaluate(makeState({ lastUserActivity: Date.now() - 70000 }));
    expect(result).toBeNull();
  });

  it("should return null when confidence too low", () => {
    const result = p.evaluate(makeState({ confidence: 0.1, lastUserActivity: Date.now() - 200 }));
    expect(result).toBeNull();
  });

  it("should detect unfinished conversation", () => {
    const now = Date.now();
    const result = p.evaluate(makeState({
      lastUserActivity: now - 200,
      confidence: 0.8,
      workingMemory: {
        ...DEFAULT_COGNITIVE_STATE.workingMemory,
        currentConversation: [
          { role: "user", content: "help me", timestamp: now - 100 },
        ],
      },
    }));
    expect(result).not.toBeNull();
    expect(result!.shouldSpeak).toBe(true);
  });

  it("should detect pending high-priority goals", () => {
    const now = Date.now();
    const result = p.evaluate(makeState({
      lastUserActivity: now - 200,
      confidence: 0.8,
      pendingTasks: [
        { id: "1", description: "urgent task", status: "pending", createdAt: now, updatedAt: now, priority: 0.9 },
      ],
    }));
    expect(result).not.toBeNull();
  });

  it("should respect hourly rate limit", () => {
    p = createProactiveSpeechPolicy({ maxProactivePerHour: 1, minSilenceMs: 100, maxSilenceMs: 60000, speakCooldownMs: 0, minConfidence: 0.3 });
    const now = Date.now();
    p.evaluate(makeState({
      lastUserActivity: now - 200,
      confidence: 0.8,
      pendingTasks: [
        { id: "1", description: "task", status: "pending", createdAt: now, updatedAt: now, priority: 0.9 },
      ],
    }));
    const r2 = p.evaluate(makeState({
      lastUserActivity: now - 200,
      confidence: 0.8,
      pendingTasks: [
        { id: "2", description: "task2", status: "pending", createdAt: now, updatedAt: now, priority: 0.9 },
      ],
    }));
    expect(r2).toBeNull();
  });

  it("should reset state", () => {
    p.reset();
    const stats = p.getStats();
    expect(stats.proactiveCountThisHour).toBe(0);
  });

  it("should report stats", () => {
    const stats = p.getStats();
    expect(stats).toHaveProperty("lastProactiveTime");
    expect(stats).toHaveProperty("proactiveCountThisHour");
  });
});

describe("DEFAULT_PROACTIVE_CONFIG", () => {
  it("should have sensible defaults", () => {
    expect(DEFAULT_PROACTIVE_CONFIG.minSilenceMs).toBe(10000);
    expect(DEFAULT_PROACTIVE_CONFIG.maxSilenceMs).toBe(120000);
    expect(DEFAULT_PROACTIVE_CONFIG.maxProactivePerHour).toBe(3);
  });
});
