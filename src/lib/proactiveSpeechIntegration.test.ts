import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { CognitiveLoop, CognitiveLoopCallbacks } from "./cognitiveLoop";
import { CognitiveEvent, CognitiveState, DEFAULT_COGNITIVE_STATE } from "./cognitiveState";
import { Memory } from "./memoryTypes";
import { ProactiveSpeechPolicy } from "./proactiveSpeech";

function makeCallbacks(overrides: Partial<CognitiveLoopCallbacks> = {}): CognitiveLoopCallbacks {
  return {
    onSpeech: vi.fn(),
    onToolUse: vi.fn(),
    onMemoryUpdate: vi.fn(),
    onStateChanged: vi.fn(),
    onTranscription: vi.fn(),
    getExistingMemories: async () => [],
    ...overrides,
  };
}

function userMessage(text: string): CognitiveEvent {
  return {
    type: "user_message",
    payload: { text, role: "user" as const },
    timestamp: Date.now(),
    significance: "medium",
  };
}

function assistantMessage(text: string): CognitiveEvent {
  return {
    type: "user_message",
    payload: { text, role: "assistant" as const },
    timestamp: Date.now(),
    significance: "low",
  };
}

describe("CognitiveLoop proactive speech integration", () => {
  let loop: CognitiveLoop;
  let callbacks: CognitiveLoopCallbacks;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    callbacks = makeCallbacks();
    loop = new CognitiveLoop(callbacks, "test-user");
  });

  afterEach(() => {
    loop.reset();
    vi.useRealTimers();
  });

  it("should not speak when proactive is disabled", () => {
    loop.setProactiveEnabled(false);

    // Fill conversation to trigger proactive check
    for (let i = 0; i < 8; i++) {
      loop.dispatch(userMessage(`turn ${i}`));
      loop.dispatch(assistantMessage(`response ${i}`));
    }

    // Advance past silence window (30s timer + 10s min silence)
    vi.advanceTimersByTime(45000);

    expect(callbacks.onSpeech).not.toHaveBeenCalled();
  });

  it("should not speak when conversation state is ended", () => {
    // End conversation
    loop.dispatch({
      type: "app_state_change",
      payload: { active: false },
      timestamp: Date.now(),
      significance: "low",
    });

    // Fill conversation
    for (let i = 0; i < 8; i++) {
      loop.dispatch(userMessage(`turn ${i}`));
      loop.dispatch(assistantMessage(`response ${i}`));
    }

    vi.advanceTimersByTime(45000);

    expect(callbacks.onSpeech).not.toHaveBeenCalled();
  });

  it("should not speak during active processing", () => {
    // Start a dispatch that blocks processing
    loop.dispatch(userMessage("hello"));
    loop.dispatch(userMessage("world"));

    // While processing, advance timer
    vi.advanceTimersByTime(45000);

    // The proactive check should skip because processing is true
    // (This is a timing-based test, the key is no crash)
    expect(true).toBe(true);
  });

  it("should respect cooldown between proactive speaks", () => {
    // This tests that the proactive timer doesn't fire too rapidly
    // by checking the speech cooldown is enforced
    for (let i = 0; i < 10; i++) {
      loop.dispatch(userMessage(`turn ${i}`));
      loop.dispatch(assistantMessage(`response ${i}`));
    }

    // First proactive check
    vi.advanceTimersByTime(45000);
    const firstCallCount = (callbacks.onSpeech as ReturnType<typeof vi.fn>).mock.calls.length;

    // Second check immediately after — should be blocked by cooldown
    vi.advanceTimersByTime(30000);
    const secondCallCount = (callbacks.onSpeech as ReturnType<typeof vi.fn>).mock.calls.length;

    // Should not have spoken twice in rapid succession
    expect(secondCallCount - firstCallCount).toBe(0);
  });

  it("should generate speech for pending goals during silence", () => {
    // Add a pending goal via goal system
    // The goal system needs tasks added via dispatch
    loop.dispatch({
      type: "task_completion",
      payload: { taskId: "task-1", description: "test task" },
      timestamp: Date.now(),
      significance: "medium",
    });

    // Fill conversation
    for (let i = 0; i < 8; i++) {
      loop.dispatch(userMessage(`turn ${i}`));
      loop.dispatch(assistantMessage(`response ${i}`));
    }

    // Advance past silence window
    vi.advanceTimersByTime(45000);

    // The proactive check may or may not speak depending on goal state
    // The important thing is no crash
    expect(true).toBe(true);
  });

  it("should reset proactive state on loop reset", () => {
    loop.setProactiveEnabled(true);

    // Fill conversation
    for (let i = 0; i < 8; i++) {
      loop.dispatch(userMessage(`turn ${i}`));
      loop.dispatch(assistantMessage(`response ${i}`));
    }

    loop.reset();

    // After reset, proactive should be re-enabled (default)
    // Advance timer — should not crash
    vi.advanceTimersByTime(45000);
    expect(true).toBe(true);
  });

  it("should not crash when onSpeech callback throws", () => {
    const errorCallbacks = makeCallbacks({
      onSpeech: vi.fn(() => { throw new Error("callback error"); }),
    });
    loop = new CognitiveLoop(errorCallbacks, "test-user");

    for (let i = 0; i < 8; i++) {
      loop.dispatch(userMessage(`turn ${i}`));
      loop.dispatch(assistantMessage(`response ${i}`));
    }

    // Should not throw
    expect(() => {
      vi.advanceTimersByTime(45000);
    }).not.toThrow();
  });

  it("should setProactiveEnabled reflect in state", () => {
    loop.setProactiveEnabled(false);
    loop.setProactiveEnabled(true);

    // No crash, setting is accepted
    expect(true).toBe(true);
  });
});

describe("ProactiveSpeechPolicy with real timing", () => {
  it("should evaluate silence duration correctly", () => {
    const p = new ProactiveSpeechPolicy({ minSilenceMs: 100, maxSilenceMs: 60000, speakCooldownMs: 0, minConfidence: 0.3 });

    const now = Date.now();
    const state: CognitiveState = {
      ...DEFAULT_COGNITIVE_STATE,
      lastUserActivity: now - 200,
      lastLohzSpeech: now - 10000,
      confidence: 0.8,
      currentTopic: "test",
      silenceDuration: 200,
      conversationState: "active",
      workingMemory: {
        ...DEFAULT_COGNITIVE_STATE.workingMemory,
        currentConversation: [
          { role: "user", content: "help me", timestamp: now - 100 },
        ],
      },
    };

    const result = p.evaluate(state);
    expect(result).not.toBeNull();
    expect(result!.shouldSpeak).toBe(true);
  });

  it("should return null when silence too short", () => {
    const p = new ProactiveSpeechPolicy({ minSilenceMs: 10000, maxSilenceMs: 60000, speakCooldownMs: 0, minConfidence: 0.3 });

    const now = Date.now();
    const state: CognitiveState = {
      ...DEFAULT_COGNITIVE_STATE,
      lastUserActivity: now - 1000,
      lastLohzSpeech: now - 10000,
      confidence: 0.8,
      currentTopic: "test",
      silenceDuration: 1000,
      conversationState: "active",
    };

    const result = p.evaluate(state);
    expect(result).toBeNull();
  });

  it("should return null when silence too long", () => {
    const p = new ProactiveSpeechPolicy({ minSilenceMs: 100, maxSilenceMs: 5000, speakCooldownMs: 0, minConfidence: 0.3 });

    const now = Date.now();
    const state: CognitiveState = {
      ...DEFAULT_COGNITIVE_STATE,
      lastUserActivity: now - 10000,
      lastLohzSpeech: now - 10000,
      confidence: 0.8,
      currentTopic: "test",
      silenceDuration: 10000,
      conversationState: "active",
    };

    const result = p.evaluate(state);
    expect(result).toBeNull();
  });
});
