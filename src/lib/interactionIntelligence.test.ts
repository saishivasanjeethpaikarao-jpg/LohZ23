import { describe, it, expect, beforeEach, vi } from "vitest";
import { InteractionIntelligence } from "./interactionIntelligence";
import { CognitiveState, CognitiveEvent } from "./cognitiveState";

function makeEvent(type: string, payload: unknown = {}): CognitiveEvent {
  return { type, payload, timestamp: Date.now(), significance: "low" } as CognitiveEvent;
}

function makeState(overrides: Partial<CognitiveState> = {}): CognitiveState {
  return {
    currentTopic: null,
    userIntent: null,
    emotionalContext: "neutral",
    activeGoal: null,
    workingMemory: {
      currentConversation: [],
      recentToolActions: [],
      activeTask: null,
      contextSignals: [],
    },
    relevantMemories: [],
    candidateActions: [],
    confidence: 0.5,
    urgency: 0,
    lastUserActivity: Date.now() - 60000,
    lastLohzSpeech: Date.now() - 60000,
    silenceDuration: 0,
    conversationState: "active",
    pendingTasks: [],
    ...overrides,
  };
}

describe("InteractionIntelligence", () => {
  let intel: InteractionIntelligence;

  beforeEach(() => {
    vi.useRealTimers();
    intel = new InteractionIntelligence();
  });

  it("should initialize in LISTENING mode", () => {
    expect(intel.getMode()).toBe("LISTENING");
  });

  it("should process user message event", () => {
    const state = makeState();
    const decision = intel.processEvent(makeEvent("user_message"), state);
    expect(decision.mode).toBe("LISTENING");
  });

  it("should process voice transcript event", () => {
    const state = makeState();
    const decision = intel.processEvent(makeEvent("voice_transcript", { text: "hello" }), state);
    expect(decision.mode).toBe("LISTENING");
  });

  it("should transition to ACTIVE_CONVERSATION on speech_start", () => {
    const state = makeState();
    intel.processEvent(makeEvent("speech_start"), state);
    expect(intel.getMode()).toBe("ACTIVE_CONVERSATION");
  });

  it("should transition to WAITING on speech_end", () => {
    const state = makeState();
    intel.processEvent(makeEvent("speech_start"), state);
    intel.processEvent(makeEvent("speech_end"), state);
    expect(intel.getMode()).toBe("WAITING");
  });

  it("should transition to TASK_FOCUSED on tool_result", () => {
    const state = makeState();
    intel.processEvent(makeEvent("tool_result", { tool: "search" }), state);
    expect(intel.getMode()).toBe("TASK_FOCUSED");
  });

  it("should return no-initiation for non-silence events", () => {
    const state = makeState();
    const decision = intel.processEvent(makeEvent("user_message"), state);
    expect(decision.shouldSpeak).toBe(false);
  });

  // ── Proactive Evaluation ──

  it("should not initiate proactive when frequency is none", () => {
    intel.updatePreferences("default", { proactiveFrequency: "none" });
    const state = makeState({ silenceDuration: 20000 });
    const decision = intel.evaluateProactive(state);
    expect(decision.shouldSpeak).toBe(false);
    expect(decision.reason).toContain("User preferences disable");
  });

  it("should initiate proactive when silence is long enough and conditions met", () => {
    intel.updatePreferences("default", { proactiveFrequency: "frequent" });
    const state = makeState({
      silenceDuration: 20000,
      pendingTasks: [{
        id: "t1",
        description: "Finish report",
        status: "pending" as const,
        createdAt: Date.now() - 60000,
        updatedAt: Date.now(),
        priority: 1,
      }],
      lastLohzSpeech: Date.now() - 10000,
      workingMemory: {
        currentConversation: [
          { role: "user", content: "Help me with this", timestamp: Date.now() - 30000 },
          { role: "assistant", content: "Sure, working on it", timestamp: Date.now() - 20000 },
        ],
        recentToolActions: [],
        activeTask: null,
        contextSignals: [],
      },
    });
    const decision = intel.evaluateProactive(state);
    expect(decision.shouldSpeak).toBe(true);
    expect(decision.mode).toBe("PROACTIVE");
    expect(decision.reason).toContain("Task reminder");
  });

  it("should not initiate proactive when user is typing", () => {
    intel.updatePreferences("default", { proactiveFrequency: "frequent" });
    const state = makeState({
      silenceDuration: 20000,
      lastLohzSpeech: Date.now() - 10000,
      workingMemory: {
        currentConversation: [],
        recentToolActions: [],
        activeTask: null,
        contextSignals: [{ type: "user_typing", value: true, timestamp: Date.now() }],
      },
    });
    const decision = intel.evaluateProactive(state);
    expect(decision.shouldSpeak).toBe(false);
    expect(decision.blocked).toBe(true);
    expect(decision.blockReason).toBe("user_active");
  });

  it("should not initiate proactive when LOHZ spoke too recently", () => {
    intel.updatePreferences("default", { proactiveFrequency: "frequent" });
    const state = makeState({
      silenceDuration: 20000,
      lastLohzSpeech: Date.now() - 500,
    });
    const decision = intel.evaluateProactive(state);
    expect(decision.shouldSpeak).toBe(false);
    expect(decision.blocked).toBe(true);
    expect(decision.blockReason).toBe("recent_speech");
  });

  it("should respect hourly proactive limit", () => {
    intel.updatePreferences("default", { proactiveFrequency: "minimal" });
    const state = makeState({
      silenceDuration: 20000,
      lastLohzSpeech: Date.now() - 10000,
      pendingTasks: [{
        id: "t1",
        description: "Finish report",
        status: "pending" as const,
        createdAt: Date.now() - 60000,
        updatedAt: Date.now(),
        priority: 1,
      }],
      workingMemory: {
        currentConversation: [
          { role: "user", content: "Help me with this", timestamp: Date.now() - 30000 },
          { role: "assistant", content: "Sure, working on it", timestamp: Date.now() - 20000 },
        ],
        recentToolActions: [],
        activeTask: null,
        contextSignals: [],
      },
    });

    for (let i = 0; i < 2; i++) {
      intel.evaluateProactive(state);
    }

    const decision = intel.evaluateProactive(state);
    expect(decision.shouldSpeak).toBe(false);
    expect(decision.reason).toContain("Proactive limit reached");
  });

  it("should reset proactive count after an hour", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());

    intel.updatePreferences("default", { proactiveFrequency: "minimal" });
    const state = makeState({
      silenceDuration: 20000,
      lastLohzSpeech: Date.now() - 10000,
      pendingTasks: [{
        id: "t1",
        description: "Finish report",
        status: "pending" as const,
        createdAt: Date.now() - 60000,
        updatedAt: Date.now(),
        priority: 1,
      }],
      workingMemory: {
        currentConversation: [
          { role: "user", content: "Help me with this", timestamp: Date.now() - 30000 },
          { role: "assistant", content: "Sure, working on it", timestamp: Date.now() - 20000 },
        ],
        recentToolActions: [],
        activeTask: null,
        contextSignals: [],
      },
    });

    intel.evaluateProactive(state);
    vi.advanceTimersByTime(3601000);

    const decision = intel.evaluateProactive(state);
    expect(decision.shouldSpeak).toBe(true);
    vi.useRealTimers();
  });

  it("should not initiate proactive in quiet hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 0, 1, 23, 0, 0));

    intel.updatePreferences("default", {
      proactiveFrequency: "frequent",
      quietHoursEnabled: true,
      quietHoursStart: 22,
      quietHoursEnd: 7,
    });

    const state = makeState({ silenceDuration: 20000 });
    const decision = intel.evaluateProactive(state);
    expect(decision.shouldSpeak).toBe(false);
    expect(decision.reason).toContain("User preferences disable");
    vi.useRealTimers();
  });

  it("should provide confidence for proactive decisions", () => {
    intel.updatePreferences("default", { proactiveFrequency: "frequent" });
    const state = makeState({
      silenceDuration: 15000,
      lastLohzSpeech: Date.now() - 10000,
    });
    const decision = intel.evaluateProactive(state);
    expect(decision.confidence).toBeGreaterThan(0);
    expect(typeof decision.confidence).toBe("number");
  });

  // ── Speech Filtering ──

  it("should approve clean speech text", () => {
    const state = makeState();
    const result = intel.filterSpeech("The information you requested is available", state);
    expect(result.approved).toBe(true);
  });

  it("should filter filler words from speech", () => {
    const state = makeState();
    const result = intel.filterSpeech("Um, here are the results", state);
    expect(result.approved).toBe(true);
    expect(result.text).not.toContain("Um");
  });

  it("should reject repetitive text", () => {
    const state = makeState();
    intel.filterSpeech("My cat sat on the mat", state);
    const result = intel.filterSpeech("My cat sat on the mat", state);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Repetition");
  });

  it("should block artificial fillers in speech", () => {
    const state = makeState();
    const result = intel.filterSpeech("Are you there?", state);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Artificial filler");
  });

  it("should track spoken phrases across filter calls", () => {
    const state = makeState();
    intel.filterSpeech("Hello world", state);
    intel.filterSpeech("Goodbye world", state);
    expect(intel.getQualityChecker().getPhraseDiversity()).toBeGreaterThan(0.5);
  });

  // ── Preferences ──

  it("should get and update user preferences", () => {
    intel.updatePreferences("user1", { conversationStyle: "detailed" });
    const prefs = intel.getPreferences("user1");
    expect(prefs.conversationStyle).toBe("detailed");
  });

  it("should set user ID", () => {
    intel.setUserId("user-abc");
    const prefs = intel.getPreferences("user-abc");
    expect(prefs.userId).toBe("user-abc");
  });

  it("should report canInitiate based on mode", () => {
    expect(intel.canInitiateNow()).toBe(true);
    intel.processEvent(makeEvent("speech_start"), makeState());
    expect(intel.canInitiateNow()).toBe(false);
  });

  it("should reset all state", () => {
    intel.processEvent(makeEvent("speech_start"), makeState());
    intel.updatePreferences("user1", { proactiveFrequency: "frequent" });
    intel.reset();

    expect(intel.getMode()).toBe("LISTENING");
  });
});
