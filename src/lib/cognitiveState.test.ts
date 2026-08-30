import { describe, it, expect } from "vitest";
import {
  DEFAULT_COGNITIVE_STATE,
  CognitiveDecision,
  DecisionReason,
  CognitiveState,
  WorkingMemory,
  ConversationTurn,
  ToolAction,
  ContextSignal,
  MemoryReference,
  CandidateAction,
  PendingTask,
  CognitiveEvent,
} from "./cognitiveState";

describe("DEFAULT_COGNITIVE_STATE", () => {
  it("should have correct initial values", () => {
    expect(DEFAULT_COGNITIVE_STATE.currentTopic).toBeNull();
    expect(DEFAULT_COGNITIVE_STATE.userIntent).toBeNull();
    expect(DEFAULT_COGNITIVE_STATE.emotionalContext).toBe("neutral");
    expect(DEFAULT_COGNITIVE_STATE.activeGoal).toBeNull();
    expect(DEFAULT_COGNITIVE_STATE.confidence).toBe(0.5);
    expect(DEFAULT_COGNITIVE_STATE.urgency).toBe(0);
    expect(DEFAULT_COGNITIVE_STATE.silenceDuration).toBe(0);
    expect(DEFAULT_COGNITIVE_STATE.conversationState).toBe("active");
  });

  it("should have empty working memory arrays", () => {
    const wm = DEFAULT_COGNITIVE_STATE.workingMemory;
    expect(wm.currentConversation).toEqual([]);
    expect(wm.recentToolActions).toEqual([]);
    expect(wm.activeTask).toBeNull();
    expect(wm.contextSignals).toEqual([]);
  });

  it("should have empty related memories and candidate actions", () => {
    expect(DEFAULT_COGNITIVE_STATE.relevantMemories).toEqual([]);
    expect(DEFAULT_COGNITIVE_STATE.candidateActions).toEqual([]);
  });

  it("should have empty pending tasks", () => {
    expect(DEFAULT_COGNITIVE_STATE.pendingTasks).toEqual([]);
  });

  it("should have numeric timestamps for lastUserActivity and lastLohzSpeech", () => {
    expect(typeof DEFAULT_COGNITIVE_STATE.lastUserActivity).toBe("number");
    expect(typeof DEFAULT_COGNITIVE_STATE.lastLohzSpeech).toBe("number");
  });
});

describe("CognitiveState type shape", () => {
  it("should accept all valid emotional contexts", () => {
    const validEmotions: CognitiveState["emotionalContext"][] = [
      "neutral", "positive", "negative", "curious", "frustrated", "excited",
    ];
    for (const emotion of validEmotions) {
      const state: CognitiveState = { ...DEFAULT_COGNITIVE_STATE, emotionalContext: emotion };
      expect(state.emotionalContext).toBe(emotion);
    }
  });

  it("should accept all valid conversation states", () => {
    const validStates: CognitiveState["conversationState"][] = [
      "active", "paused", "ended", "awaiting_response",
    ];
    for (const cs of validStates) {
      const state: CognitiveState = { ...DEFAULT_COGNITIVE_STATE, conversationState: cs };
      expect(state.conversationState).toBe(cs);
    }
  });
});

describe("CognitiveDecision type", () => {
  it("should include all expected decisions", () => {
    const decisions: CognitiveDecision[] = ["SPEAK", "LISTEN", "WAIT", "ASK", "ACT", "IGNORE"];
    expect(decisions).toHaveLength(6);
  });
});

describe("DecisionReason type", () => {
  it("should accept valid decision with required fields", () => {
    const reason: DecisionReason = {
      decision: "SPEAK",
      reason: "User asked a question",
      confidence: 0.85,
    };
    expect(reason.decision).toBe("SPEAK");
    expect(reason.confidence).toBe(0.85);
  });

  it("should accept optional metadata", () => {
    const reason: DecisionReason = {
      decision: "ACT",
      reason: "Urgent action needed",
      confidence: 0.9,
      metadata: { toolName: "web_search", latency: 3000 },
    };
    expect(reason.metadata).toBeDefined();
    expect((reason.metadata as Record<string, unknown>).toolName).toBe("web_search");
  });
});

describe("WorkingMemory type", () => {
  it("should accept valid working memory", () => {
    const wm: WorkingMemory = {
      currentConversation: [
        { role: "user", content: "Hello", timestamp: Date.now() },
      ],
      activeTask: "research topic",
      recentToolActions: [],
      contextSignals: [],
    };
    expect(wm.currentConversation).toHaveLength(1);
    expect(wm.activeTask).toBe("research topic");
  });
});

describe("PendingTask type", () => {
  it("should accept all valid statuses", () => {
    const statuses: PendingTask["status"][] = ["pending", "in_progress", "completed", "blocked"];
    for (const status of statuses) {
      const task: PendingTask = {
        id: "1",
        description: "test",
        status,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        priority: 0.5,
      };
      expect(task.status).toBe(status);
    }
  });
});

describe("CognitiveEvent type", () => {
  it("should include all expected event types", () => {
    const eventTypes: CognitiveEvent["type"][] = [
      "user_message", "voice_transcript", "speech_start", "speech_end",
      "app_state_change", "timer", "tool_result", "task_completion",
      "meaningful_silence", "external_event", "scheduled_reflection",
    ];
    expect(eventTypes).toHaveLength(11);
  });

  it("should accept all significance levels", () => {
    const levels: CognitiveEvent["significance"][] = ["low", "medium", "high", "critical"];
    for (const sig of levels) {
      const event: CognitiveEvent = {
        type: "timer",
        payload: null,
        timestamp: Date.now(),
        significance: sig,
      };
      expect(event.significance).toBe(sig);
    }
  });
});
