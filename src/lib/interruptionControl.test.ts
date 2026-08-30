import { describe, it, expect, beforeEach } from "vitest";
import { InterruptionController, InterruptionContext } from "./interruptionControl";

function makeContext(overrides: Partial<InterruptionContext> = {}): InterruptionContext {
  return {
    userIsTyping: false,
    userIsSpeaking: false,
    lohzRecentlySpoke: false,
    lohzSpeechTimestamp: 0,
    activeTaskInProgress: false,
    timeSinceLastUserActivity: 30000,
    conversationState: "active",
    ...overrides,
  };
}

describe("InterruptionController", () => {
  let controller: InterruptionController;

  beforeEach(() => {
    controller = new InterruptionController();
  });

  it("should be safe when no blocking factors", () => {
    const result = controller.checkSafe(makeContext());
    expect(result.safe).toBe(true);
    expect(result.blockingFactor).toBeNull();
  });

  // ── User Typing ──

  it("should block when user is typing", () => {
    const result = controller.checkSafe(makeContext({ userIsTyping: true }));
    expect(result.safe).toBe(false);
    expect(result.blockingFactor).toBe("user_active");
  });

  it("should block when user is speaking", () => {
    const result = controller.checkSafe(makeContext({ userIsSpeaking: true }));
    expect(result.safe).toBe(false);
    expect(result.blockingFactor).toBe("user_active");
  });

  it("should block when user recently active", () => {
    const result = controller.checkSafe(makeContext({
      timeSinceLastUserActivity: 3000,
    }));
    expect(result.safe).toBe(false);
    expect(result.blockingFactor).toBe("user_active");
  });

  it("should not block when user activity is old enough", () => {
    const result = controller.checkSafe(makeContext({
      timeSinceLastUserActivity: 15000,
    }));
    expect(result.safe).toBe(true);
  });

  // ── Recent LOHZ Speech ──

  it("should block when LOHZ spoke too recently", () => {
    const now = Date.now();
    const result = controller.checkSafe(makeContext({
      lohzRecentlySpoke: true,
      lohzSpeechTimestamp: now - 1000,
    }));
    expect(result.safe).toBe(false);
    expect(result.blockingFactor).toBe("recent_speech");
  });

  it("should not block when enough time passed since LOHZ speech", () => {
    const now = Date.now();
    const result = controller.checkSafe(makeContext({
      lohzRecentlySpoke: true,
      lohzSpeechTimestamp: now - 5000,
    }));
    expect(result.safe).toBe(true);
  });

  // ── Active Task ──

  it("should block when task is in progress", () => {
    const result = controller.checkSafe(makeContext({
      activeTaskInProgress: true,
    }));
    expect(result.safe).toBe(false);
    expect(result.blockingFactor).toBe("task_in_progress");
  });

  // ── Conversation Ended ──

  it("should block when conversation is ended", () => {
    const result = controller.checkSafe(makeContext({
      conversationState: "ended",
    }));
    expect(result.safe).toBe(false);
    expect(result.blockingFactor).toBe("conversation_ended");
  });

  it("should not block when conversation is paused", () => {
    const result = controller.checkSafe(makeContext({
      conversationState: "paused",
    }));
    expect(result.safe).toBe(true);
  });

  // ── Multiple Factors ──

  it("should prioritize user_active over other factors", () => {
    const now = Date.now();
    const result = controller.checkSafe(makeContext({
      userIsTyping: true,
      lohzRecentlySpoke: true,
      lohzSpeechTimestamp: now - 500,
      activeTaskInProgress: true,
    }));
    expect(result.safe).toBe(false);
    expect(result.blockingFactor).toBe("user_active");
  });

  it("should check recent_speech when user is not active", () => {
    const now = Date.now();
    const result = controller.checkSafe(makeContext({
      lohzRecentlySpoke: true,
      lohzSpeechTimestamp: now - 500,
    }));
    expect(result.safe).toBe(false);
    expect(result.blockingFactor).toBe("recent_speech");
  });

  // ── Edge Cases ──

  it("should handle LOHZ speech timestamp of 0", () => {
    const result = controller.checkSafe(makeContext({
      lohzRecentlySpoke: false,
      lohzSpeechTimestamp: 0,
    }));
    expect(result.safe).toBe(true);
  });

  it("should handle very recent user activity", () => {
    const result = controller.checkSafe(makeContext({
      timeSinceLastUserActivity: 0,
    }));
    expect(result.safe).toBe(false);
  });

  it("should provide reasons for all outcomes", () => {
    const safe = controller.checkSafe(makeContext());
    expect(safe.reason).toBeTruthy();

    const blocked = controller.checkSafe(makeContext({ userIsTyping: true }));
    expect(blocked.reason).toBeTruthy();
  });

  it("should reset without error", () => {
    controller.checkSafe(makeContext({ userIsTyping: true }));
    controller.reset();
    const result = controller.checkSafe(makeContext());
    expect(result.safe).toBe(true);
  });
});
