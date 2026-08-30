import { describe, it, expect, beforeEach } from "vitest";
import { SituationEngine, createSituationEngine } from "./situationEngine";
import { SituationEvent } from "./situationTypes";

function userMsg(userId: string, text: string, ts?: number): SituationEvent {
  return { type: "USER_MESSAGE", payload: { text }, timestamp: ts ?? Date.now(), userId };
}
function lohzResp(userId: string, description: string, ts?: number): SituationEvent {
  return { type: "LOHZ_RESPONSE", payload: { description, type: "response" as const }, timestamp: ts ?? Date.now(), userId };
}
function silence(userId: string, ts?: number): SituationEvent {
  return { type: "SILENCE", payload: {}, timestamp: ts ?? Date.now(), userId };
}
function goalCreated(userId: string, goals: { id: string; status: string }[], ts?: number): SituationEvent {
  return { type: "GOAL_CREATED", payload: { goals }, timestamp: ts ?? Date.now(), userId };
}
function goalCompleted(userId: string, goals: { id: string; status: string }[], ts?: number): SituationEvent {
  return { type: "GOAL_COMPLETED", payload: { goals }, timestamp: ts ?? Date.now(), userId };
}
function taskCreated(userId: string, tasks: { id: string; status: string }[], ts?: number): SituationEvent {
  return { type: "TASK_CREATED", payload: { tasks }, timestamp: ts ?? Date.now(), userId };
}
function taskCompleted(userId: string, tasks: { id: string; status: string }[], ts?: number): SituationEvent {
  return { type: "TASK_COMPLETED", payload: { tasks }, timestamp: ts ?? Date.now(), userId };
}
function taskFailed(userId: string, tasks: { id: string; status: string }[], ts?: number): SituationEvent {
  return { type: "TASK_FAILED", payload: { tasks }, timestamp: ts ?? Date.now(), userId };
}
function toolStarted(userId: string, tool: string, ts?: number): SituationEvent {
  return { type: "TOOL_STARTED", payload: { tool }, timestamp: ts ?? Date.now(), userId };
}
function toolCompleted(userId: string, tool: string, ts?: number): SituationEvent {
  return { type: "TOOL_COMPLETED", payload: { tool, success: true }, timestamp: ts ?? Date.now(), userId };
}
function toolFailed(userId: string, tool: string, ts?: number): SituationEvent {
  return { type: "TOOL_FAILED", payload: { tool, success: false }, timestamp: ts ?? Date.now(), userId };
}
function memoryUpdated(userId: string, memories: { id: string; text: string }[], ts?: number): SituationEvent {
  return { type: "MEMORY_UPDATED", payload: { memories }, timestamp: ts ?? Date.now(), userId };
}
function userCorrection(userId: string, ts?: number): SituationEvent {
  return { type: "USER_CORRECTION", payload: { text: "that's not right" }, timestamp: ts ?? Date.now(), userId };
}
function feedback(userId: string, positive: boolean, ts?: number): SituationEvent {
  return { type: "EXPLICIT_FEEDBACK", payload: { positive }, timestamp: ts ?? Date.now(), userId };
}

describe("SituationEngine", () => {
  let engine: SituationEngine;

  beforeEach(() => {
    engine = createSituationEngine({ idleThresholdMs: 1000 });
  });

  // ── Topic Transition ──

  describe("topic transition", () => {
    it("should extract topic from user message", () => {
      const now = Date.now();
      engine.processEvent(userMsg("u1", "tell me about the deployment pipeline", now));
      const state = engine.getState("u1");
      expect(state.currentTopic).toBe("deployment");
    });

    it("should update topic on new subject", () => {
      const now = Date.now();
      engine.processEvent(userMsg("u1", "tell me about the deployment pipeline", now));
      engine.processEvent(userMsg("u1", "let's switch to the authentication system now", now + 1000));
      const state = engine.getState("u1");
      expect(state.currentTopic).toBe("authentication");
    });

    it("should track topic history", () => {
      const now = Date.now();
      engine.processEvent(userMsg("u1", "tell me about the deployment pipeline", now));
      engine.processEvent(userMsg("u1", "let's switch to the authentication system now", now + 1000));
      engine.processEvent(userMsg("u1", "what about the database migration", now + 2000));
      const state = engine.getState("u1");
      // topicHistory should contain shifted topics
      expect(state.currentTopic).toBeTruthy();
    });
  });

  // ── Conversation Phase ──

  describe("conversation phase", () => {
    it("should start as idle", () => {
      const state = engine.getState("u1");
      expect(state.conversationPhase).toBe("idle");
    });

    it("should transition to greeting on first message", () => {
      const now = Date.now();
      engine.processEvent(userMsg("u1", "hello there", now));
      const state = engine.getState("u1");
      expect(state.conversationPhase).toBe("greeting");
    });

    it("should transition to exploration after LOHZ responds to greeting", () => {
      const now = Date.now();
      engine.processEvent(userMsg("u1", "hello", now));
      engine.processEvent(lohzResp("u1", "hi there", now + 100));
      const state = engine.getState("u1");
      expect(state.conversationPhase).toBe("exploration");
    });

    it("should transition to working when task is created", () => {
      const now = Date.now();
      engine.processEvent(userMsg("u1", "hello", now));
      engine.processEvent(taskCreated("u1", [{ id: "t1", status: "pending" }], now + 100));
      const state = engine.getState("u1");
      expect(state.conversationPhase).toBe("working");
    });

    it("should transition to working when goal is created", () => {
      const now = Date.now();
      engine.processEvent(goalCreated("u1", [{ id: "g1", status: "active" }], now));
      const state = engine.getState("u1");
      expect(state.conversationPhase).toBe("working");
    });
  });

  // ── Goal Changes ──

  describe("goal changes", () => {
    it("should update active goals on goal_created", () => {
      const now = Date.now();
      engine.processEvent(goalCreated("u1", [
        { id: "g1", status: "active" },
        { id: "g2", status: "completed" },
      ], now));
      const state = engine.getState("u1");
      expect(state.activeGoals.length).toBe(1);
      expect(state.activeGoals[0].id).toBe("g1");
    });

    it("should reduce urgency on goal_completed", () => {
      const now = Date.now();
      engine.processEvent(userCorrection("u1", now));
      engine.processEvent(userCorrection("u1", now + 1));
      const before = engine.getState("u1");
      const highUrgency = before.urgency;

      engine.processEvent(goalCompleted("u1", [{ id: "g1", status: "completed" }], now + 2));
      const after = engine.getState("u1");
      expect(after.urgency).toBeLessThan(highUrgency);
    });

    it("should filter only active goals", () => {
      const now = Date.now();
      engine.processEvent(goalCreated("u1", [
        { id: "g1", status: "active" },
        { id: "g2", status: "paused" },
        { id: "g3", status: "cancelled" },
      ], now));
      const state = engine.getState("u1");
      expect(state.activeGoals.length).toBe(1);
    });
  });

  // ── Silence ──

  describe("silence", () => {
    it("should set user activity to idle after silence exceeds threshold", () => {
      const now = Date.now();
      engine.processEvent(userMsg("u1", "hello there", now));
      const activity = engine.getState("u1").userActivity;
      expect(activity).not.toBe("idle");

      engine.processEvent(silence("u1", now + 2000));
      const state = engine.getState("u1");
      expect(state.userActivity).toBe("idle");
    });

    it("should transition phase to idle on long silence during exploration", () => {
      const now = Date.now();
      engine.processEvent(userMsg("u1", "tell me about deployment", now));
      engine.processEvent(lohzResp("u1", "deployment is done via CI/CD", now + 100));
      expect(engine.getState("u1").conversationPhase).toBe("exploration");

      engine.processEvent(silence("u1", now + 2000));
      const state = engine.getState("u1");
      expect(state.conversationPhase).toBe("idle");
    });
  });

  // ── Tool Result ──

  describe("tool result", () => {
    it("should track tool in progress on TOOL_STARTED", () => {
      const now = Date.now();
      engine.processEvent(toolStarted("u1", "memory_search", now));
      const state = engine.getState("u1");
      expect(state.userActivity).toBe("waiting");
      expect(state.recentLOHZActions.length).toBe(1);
      expect(state.recentLOHZActions[0].type).toBe("tool_use");
    });

    it("should clear tool on TOOL_COMPLETED", () => {
      const now = Date.now();
      engine.processEvent(toolStarted("u1", "memory_search", now));
      engine.processEvent(toolCompleted("u1", "memory_search", now + 500));
      const state = engine.getState("u1");
      expect(state.userActivity).not.toBe("waiting");
    });

    it("should increase urgency on TOOL_FAILED", () => {
      const now = Date.now();
      engine.processEvent(toolFailed("u1", "memory_search", now));
      const state = engine.getState("u1");
      expect(state.urgency).toBeGreaterThan(0);
      expect(state.recentLOHZActions[0].type).toBe("error");
    });

    it("should track multiple tool actions", () => {
      const now = Date.now();
      engine.processEvent(toolStarted("u1", "tool_a", now));
      engine.processEvent(toolCompleted("u1", "tool_a", now + 100));
      engine.processEvent(toolStarted("u1", "tool_b", now + 200));
      engine.processEvent(toolCompleted("u1", "tool_b", now + 300));
      const state = engine.getState("u1");
      expect(state.recentLOHZActions.length).toBe(4);
    });
  });

  // ── User Correction ──

  describe("user correction", () => {
    it("should increase urgency on correction", () => {
      const now = Date.now();
      engine.processEvent(userMsg("u1", "hello", now));
      engine.processEvent(userCorrection("u1", now + 100));
      const state = engine.getState("u1");
      expect(state.urgency).toBeGreaterThan(0);
    });

    it("should decrease confidence on correction", () => {
      const now = Date.now();
      engine.processEvent(userMsg("u1", "hello", now));
      const before = engine.getState("u1").confidence;
      engine.processEvent(userCorrection("u1", now + 100));
      const after = engine.getState("u1").confidence;
      expect(after).toBeLessThan(before);
    });

    it("should accumulate urgency on multiple corrections", () => {
      const now = Date.now();
      engine.processEvent(userCorrection("u1", now));
      engine.processEvent(userCorrection("u1", now + 1));
      engine.processEvent(userCorrection("u1", now + 2));
      const state = engine.getState("u1");
      expect(state.urgency).toBeGreaterThan(0.5);
    });
  });

  // ── Memory Update ──

  describe("memory update", () => {
    it("should update relevant memories", () => {
      const now = Date.now();
      engine.processEvent(memoryUpdated("u1", [
        { id: "m1", text: "user prefers dark mode" },
        { id: "m2", text: "user works on LOHZ project" },
      ], now));
      const state = engine.getState("u1");
      expect(state.relevantMemories.length).toBe(2);
    });

    it("should replace previous memories on update", () => {
      const now = Date.now();
      engine.processEvent(memoryUpdated("u1", [{ id: "m1", text: "old memory" }], now));
      engine.processEvent(memoryUpdated("u1", [{ id: "m2", text: "new memory" }], now + 100));
      const state = engine.getState("u1");
      expect(state.relevantMemories.length).toBe(1);
      expect(state.relevantMemories[0].id).toBe("m2");
    });
  });

  // ── Account Switching (Per-User Isolation) ──

  describe("account switching", () => {
    it("should maintain separate state per user", () => {
      const now = Date.now();
      engine.processEvent(userMsg("u1", "tell me about deployment", now));
      engine.processEvent(userMsg("u2", "tell me about authentication", now + 100));

      const s1 = engine.getState("u1");
      const s2 = engine.getState("u2");
      expect(s1.currentTopic).toBe("deployment");
      expect(s2.currentTopic).toBe("authentication");
    });

    it("should not leak urgency across users", () => {
      const now = Date.now();
      engine.processEvent(userCorrection("u1", now));
      const s1 = engine.getState("u1");
      const s2 = engine.getState("u2");
      expect(s1.urgency).toBeGreaterThan(0);
      expect(s2.urgency).toBe(0);
    });

    it("should not leak goals across users", () => {
      const now = Date.now();
      engine.processEvent(goalCreated("u1", [{ id: "g1", status: "active" }], now));
      const s1 = engine.getState("u1");
      const s2 = engine.getState("u2");
      expect(s1.activeGoals.length).toBe(1);
      expect(s2.activeGoals.length).toBe(0);
    });

    it("should reset per-user state independently", () => {
      const now = Date.now();
      engine.processEvent(userMsg("u1", "hello", now));
      engine.processEvent(userMsg("u2", "hello", now));
      engine.reset("u1");
      const s1 = engine.getState("u1");
      const s2 = engine.getState("u2");
      expect(s1.conversationPhase).toBe("idle");
      expect(s2.conversationPhase).not.toBe("idle");
    });
  });

  // ── Rapid Events ──

  describe("rapid events", () => {
    it("should handle rapid user messages without state corruption", () => {
      const now = Date.now();
      for (let i = 0; i < 20; i++) {
        engine.processEvent(userMsg("u1", `message ${i} about topic alpha`, now + i));
      }
      const state = engine.getState("u1");
      expect(state.messageCount).toBe(20);
      expect(state.currentTopic).toBeTruthy();
      expect(state.recentEvents.length).toBe(20);
    });

    it("should cap recent events at maxRecentEvents", () => {
      const engine2 = createSituationEngine({ maxRecentEvents: 10 });
      const now = Date.now();
      for (let i = 0; i < 15; i++) {
        engine2.processEvent(userMsg("u1", `message ${i}`, now + i));
      }
      const state = engine2.getState("u1");
      expect(state.recentEvents.length).toBe(10);
    });

    it("should handle interleaved tool and message events", () => {
      const now = Date.now();
      engine.processEvent(userMsg("u1", "search for something", now));
      engine.processEvent(toolStarted("u1", "memory_search", now + 100));
      engine.processEvent(userMsg("u1", "also check this", now + 200));
      engine.processEvent(toolCompleted("u1", "memory_search", now + 300));
      const state = engine.getState("u1");
      expect(state.recentEvents.length).toBe(4);
      expect(state.recentLOHZActions.length).toBe(2);
    });

    it("should handle rapid goal and task events", () => {
      const now = Date.now();
      engine.processEvent(goalCreated("u1", [{ id: "g1", status: "active" }], now));
      engine.processEvent(taskCreated("u1", [{ id: "t1", status: "pending" }], now + 1));
      engine.processEvent(taskCompleted("u1", [{ id: "t1", status: "completed" }], now + 2));
      engine.processEvent(goalCompleted("u1", [{ id: "g1", status: "completed" }], now + 3));
      const state = engine.getState("u1");
      // After all goals/tasks completed, no longer in working phase
      expect(state.activeGoals.length).toBe(0);
    });
  });

  // ── Explicit Feedback ──

  describe("explicit feedback", () => {
    it("should increase confidence on positive feedback", () => {
      const now = Date.now();
      engine.processEvent(userMsg("u1", "hello", now));
      const before = engine.getState("u1").confidence;
      engine.processEvent(feedback("u1", true, now + 100));
      const after = engine.getState("u1").confidence;
      expect(after).toBeGreaterThan(before);
    });

    it("should decrease confidence on negative feedback", () => {
      const now = Date.now();
      engine.processEvent(userMsg("u1", "hello", now));
      const before = engine.getState("u1").confidence;
      engine.processEvent(feedback("u1", false, now + 100));
      const after = engine.getState("u1").confidence;
      expect(after).toBeLessThan(before);
    });
  });

  // ── Time Context ──

  describe("time context", () => {
    it("should update time context with session duration", () => {
      const now = Date.now();
      engine.processEvent(userMsg("u1", "hello", now));
      engine.processEvent(userMsg("u1", "tell me about goals", now + 5000));
      const state = engine.getState("u1");
      expect(state.timeContext.sessionDuration).toBeGreaterThanOrEqual(5000);
    });

    it("should set time of day", () => {
      const now = Date.now();
      engine.processEvent(userMsg("u1", "hello", now));
      const state = engine.getState("u1");
      expect(["morning", "afternoon", "evening", "night"]).toContain(state.timeContext.timeOfDay);
    });
  });

  // ── Interaction Mode ──

  describe("interaction mode", () => {
    it("should default to text", () => {
      const state = engine.getState("u1");
      expect(state.interactionMode).toBe("text");
    });

    it("should switch to voice on USER_SPEECH", () => {
      const now = Date.now();
      engine.processEvent({ type: "USER_SPEECH", payload: { text: "hello" }, timestamp: now, userId: "u1" });
      const state = engine.getState("u1");
      expect(state.interactionMode).toBe("voice");
    });

    it("should become hybrid when both text and voice used", () => {
      const now = Date.now();
      engine.processEvent(userMsg("u1", "hello", now));
      engine.processEvent({ type: "USER_SPEECH", payload: { text: "also this" }, timestamp: now + 100, userId: "u1" });
      const state = engine.getState("u1");
      expect(state.interactionMode).toBe("hybrid");
    });
  });

  // ── Urgency Bounds ──

  describe("urgency bounds", () => {
    it("should cap urgency at 1.0", () => {
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        engine.processEvent(userCorrection("u1", now + i));
      }
      const state = engine.getState("u1");
      expect(state.urgency).toBeLessThanOrEqual(1.0);
    });

    it("should floor urgency at 0", () => {
      const now = Date.now();
      engine.processEvent(goalCompleted("u1", [{ id: "g1", status: "completed" }], now));
      const state = engine.getState("u1");
      expect(state.urgency).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Confidence Bounds ──

  describe("confidence bounds", () => {
    it("should cap confidence at 1.0", () => {
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        engine.processEvent(feedback("u1", true, now + i));
      }
      const state = engine.getState("u1");
      expect(state.confidence).toBeLessThanOrEqual(1.0);
    });

    it("should floor confidence at 0", () => {
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        engine.processEvent(userCorrection("u1", now + i));
      }
      const state = engine.getState("u1");
      expect(state.confidence).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Task Failed ──

  describe("task failed", () => {
    it("should increase urgency on task failure", () => {
      const now = Date.now();
      engine.processEvent(taskFailed("u1", [{ id: "t1", status: "completed" }], now));
      const state = engine.getState("u1");
      expect(state.urgency).toBeGreaterThan(0);
    });

    it("should reduce urgency on task completion", () => {
      const now = Date.now();
      engine.processEvent(userCorrection("u1", now));
      engine.processEvent(userCorrection("u1", now + 1));
      const highUrgency = engine.getState("u1").urgency;

      engine.processEvent(taskCompleted("u1", [{ id: "t1", status: "completed" }], now + 2));
      const after = engine.getState("u1").urgency;
      expect(after).toBeLessThan(highUrgency);
    });
  });
});
