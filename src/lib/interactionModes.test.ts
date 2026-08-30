import { describe, it, expect, beforeEach } from "vitest";
import { InteractionModeTracker } from "./interactionModes";

describe("InteractionModeTracker", () => {
  let tracker: InteractionModeTracker;

  beforeEach(() => {
    tracker = new InteractionModeTracker();
  });

  it("should start in LISTENING mode", () => {
    expect(tracker.getMode()).toBe("LISTENING");
  });

  it("should transition from LISTENING to THINKING", () => {
    const result = tracker.transition("THINKING", "user sent message");
    expect(result).toBe(true);
    expect(tracker.getMode()).toBe("THINKING");
  });

  it("should transition from THINKING to ACTIVE_CONVERSATION", () => {
    tracker.transition("THINKING", "processing");
    const result = tracker.transition("ACTIVE_CONVERSATION", "about to speak");
    expect(result).toBe(true);
    expect(tracker.getMode()).toBe("ACTIVE_CONVERSATION");
  });

  it("should transition from ACTIVE_CONVERSATION to WAITING", () => {
    tracker.transition("THINKING", "processing");
    tracker.transition("ACTIVE_CONVERSATION", "speaking");
    const result = tracker.transition("WAITING", "finished speaking");
    expect(result).toBe(true);
    expect(tracker.getMode()).toBe("WAITING");
  });

  it("should transition from WAITING to PROACTIVE", () => {
    tracker.transition("THINKING", "processing");
    tracker.transition("ACTIVE_CONVERSATION", "speaking");
    tracker.transition("WAITING", "done");
    const result = tracker.transition("PROACTIVE", "initiating follow-up");
    expect(result).toBe(true);
    expect(tracker.getMode()).toBe("PROACTIVE");
  });

  it("should transition from PROACTIVE to ACTIVE_CONVERSATION", () => {
    tracker.forceMode("PROACTIVE", "setup");
    const result = tracker.transition("ACTIVE_CONVERSATION", "user responded");
    expect(result).toBe(true);
    expect(tracker.getMode()).toBe("ACTIVE_CONVERSATION");
  });

  it("should reject invalid transitions", () => {
    const result = tracker.transition("PROACTIVE", "invalid jump");
    expect(result).toBe(false);
    expect(tracker.getMode()).toBe("LISTENING");
  });

  it("should allow same-mode transition (no-op)", () => {
    const result = tracker.transition("LISTENING", "still listening");
    expect(result).toBe(true);
    expect(tracker.getMode()).toBe("LISTENING");
  });

  it("should allow forced transitions", () => {
    tracker.forceMode("QUIET", "user requested quiet");
    expect(tracker.getMode()).toBe("QUIET");
  });

  it("canSpeak should be true for ACTIVE_CONVERSATION, WAITING, PROACTIVE", () => {
    tracker.forceMode("ACTIVE_CONVERSATION", "test");
    expect(tracker.canSpeak()).toBe(true);

    tracker.forceMode("WAITING", "test");
    expect(tracker.canSpeak()).toBe(true);

    tracker.forceMode("PROACTIVE", "test");
    expect(tracker.canSpeak()).toBe(true);
  });

  it("canSpeak should be false for LISTENING, THINKING, QUIET, TASK_FOCUSED", () => {
    tracker.forceMode("LISTENING", "test");
    expect(tracker.canSpeak()).toBe(false);

    tracker.forceMode("THINKING", "test");
    expect(tracker.canSpeak()).toBe(false);

    tracker.forceMode("QUIET", "test");
    expect(tracker.canSpeak()).toBe(false);

    tracker.forceMode("TASK_FOCUSED", "test");
    expect(tracker.canSpeak()).toBe(false);
  });

  it("canInitiate should be true for WAITING and LISTENING", () => {
    tracker.forceMode("WAITING", "test");
    expect(tracker.canInitiate()).toBe(true);

    tracker.forceMode("LISTENING", "test");
    expect(tracker.canInitiate()).toBe(true);
  });

  it("canInitiate should be false for other modes", () => {
    tracker.forceMode("ACTIVE_CONVERSATION", "test");
    expect(tracker.canInitiate()).toBe(false);

    tracker.forceMode("QUIET", "test");
    expect(tracker.canInitiate()).toBe(false);
  });

  it("canBeProactive should be true for WAITING, LISTENING, TASK_FOCUSED", () => {
    tracker.forceMode("WAITING", "test");
    expect(tracker.canBeProactive()).toBe(true);

    tracker.forceMode("LISTENING", "test");
    expect(tracker.canBeProactive()).toBe(true);

    tracker.forceMode("TASK_FOCUSED", "test");
    expect(tracker.canBeProactive()).toBe(true);
  });

  it("canBeProactive should be false for QUIET", () => {
    tracker.forceMode("QUIET", "test");
    expect(tracker.canBeProactive()).toBe(false);
  });

  it("should track mode history", () => {
    tracker.transition("THINKING", "step 1");
    tracker.transition("ACTIVE_CONVERSATION", "step 2");
    tracker.transition("WAITING", "step 3");

    const history = tracker.getHistory();
    expect(history.length).toBe(3);
    expect(history[0].mode).toBe("THINKING");
    expect(history[1].mode).toBe("ACTIVE_CONVERSATION");
    expect(history[2].mode).toBe("WAITING");
  });

  it("should limit history when requested", () => {
    tracker.transition("THINKING", "1");
    tracker.transition("ACTIVE_CONVERSATION", "2");
    tracker.transition("WAITING", "3");

    const history = tracker.getHistory(2);
    expect(history.length).toBe(2);
    expect(history[0].mode).toBe("ACTIVE_CONVERSATION");
    expect(history[1].mode).toBe("WAITING");
  });

  it("should calculate time in mode", () => {
    const before = Date.now();
    tracker.transition("THINKING", "start");
    const elapsed = tracker.getTimeInMode();
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(100);
  });

  it("should reset to initial state", () => {
    tracker.transition("THINKING", "1");
    tracker.transition("ACTIVE_CONVERSATION", "2");
    tracker.reset();

    expect(tracker.getMode()).toBe("LISTENING");
    expect(tracker.getHistory().length).toBe(0);
  });

  it("should handle full conversation lifecycle", () => {
    tracker.transition("THINKING", "user message received");
    tracker.transition("ACTIVE_CONVERSATION", "generating response");
    tracker.transition("WAITING", "response sent");
    tracker.transition("PROACTIVE", "follow-up after silence");
    tracker.transition("ACTIVE_CONVERSATION", "user responded");

    expect(tracker.getMode()).toBe("ACTIVE_CONVERSATION");
    expect(tracker.getHistory().length).toBe(5);
  });

  it("should transition to QUIET from multiple modes", () => {
    tracker.forceMode("ACTIVE_CONVERSATION", "test");
    expect(tracker.transition("QUIET", "quiet mode")).toBe(true);

    tracker.forceMode("WAITING", "test");
    expect(tracker.transition("QUIET", "quiet mode")).toBe(true);

    tracker.forceMode("TASK_FOCUSED", "test");
    expect(tracker.transition("QUIET", "quiet mode")).toBe(true);
  });

  it("should transition to TASK_FOCUSED from multiple modes", () => {
    tracker.forceMode("ACTIVE_CONVERSATION", "test");
    expect(tracker.transition("TASK_FOCUSED", "task started")).toBe(true);

    tracker.forceMode("WAITING", "test");
    expect(tracker.transition("TASK_FOCUSED", "task started")).toBe(true);

    tracker.forceMode("LISTENING", "test");
    expect(tracker.transition("TASK_FOCUSED", "task started")).toBe(true);
  });
});
