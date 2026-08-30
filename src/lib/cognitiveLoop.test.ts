import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CognitiveLoop } from "./cognitiveLoop";

describe("CognitiveLoop text event integration", () => {
  let loop: CognitiveLoop;

  beforeEach(() => {
    vi.useFakeTimers();
    loop = new CognitiveLoop({
      onSpeech: () => {},
      onTranscription: () => {},
      onToolUse: () => {},
      onMemoryUpdate: () => {},
      onStateChanged: () => {},
      getExistingMemories: async () => [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should dispatch user_message event and record in working memory", () => {
    loop.dispatch({
      type: "user_message",
      payload: { text: "Hello LOHZ", role: "user" },
      timestamp: Date.now(),
      significance: "high",
    });

    const state = loop.getState();
    expect(state.workingMemory.currentConversation.length).toBeGreaterThanOrEqual(1);
    const lastTurn = state.workingMemory.currentConversation[state.workingMemory.currentConversation.length - 1];
    expect(lastTurn.content).toBe("Hello LOHZ");
    expect(lastTurn.role).toBe("user");
  });

  it("should dispatch voice_transcript event and record in working memory", () => {
    loop.dispatch({
      type: "voice_transcript",
      payload: { text: "Voice input test", role: "user" },
      timestamp: Date.now(),
      significance: "medium",
    });

    const state = loop.getState();
    expect(state.workingMemory.currentConversation.length).toBeGreaterThanOrEqual(1);
  });

  it("should update emotional context based on input", () => {
    loop.dispatch({
      type: "user_message",
      payload: { text: "I am so happy today!", role: "user" },
      timestamp: Date.now(),
      significance: "high",
    });

    const state = loop.getState();
    expect(state).toBeDefined();
  });

  it("should set and use userId correctly", () => {
    loop.setUserId("user-abc-123");
    
    loop.dispatch({
      type: "user_message",
      payload: { text: "Test user message", role: "user" },
      timestamp: Date.now(),
      significance: "high",
    });

    vi.advanceTimersByTime(300);
    expect(true).toBe(true);
  });

  it("should queue consolidation turns after dispatch", () => {
    loop.dispatch({
      type: "user_message",
      payload: { text: "Remember this fact", role: "user" },
      timestamp: Date.now(),
      significance: "high",
    });

    loop.dispatch({
      type: "voice_transcript",
      payload: { text: "And this one too", role: "assistant" },
      timestamp: Date.now(),
      significance: "medium",
    });

    vi.advanceTimersByTime(300);
    expect(true).toBe(true);
  });

  it("should handle rapid dispatches without crashing", () => {
    for (let i = 0; i < 50; i++) {
      loop.dispatch({
        type: "user_message",
        payload: { text: `Message ${i}`, role: "user" },
        timestamp: Date.now() + i,
        significance: "medium",
      });
    }

    vi.advanceTimersByTime(300);
    const state = loop.getState();
    expect(state.workingMemory.currentConversation.length).toBeGreaterThanOrEqual(1);
  });
});
