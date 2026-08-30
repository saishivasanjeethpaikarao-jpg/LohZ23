import { describe, it, expect, beforeEach, vi } from "vitest";
import { UserPreferenceStore } from "./userPreferences";

describe("UserPreferenceStore", () => {
  let store: UserPreferenceStore;

  beforeEach(() => {
    store = new UserPreferenceStore();
  });

  it("should return default preferences for new user", () => {
    const prefs = store.getPreferences("user1");
    expect(prefs.userId).toBe("user1");
    expect(prefs.proactiveFrequency).toBe("moderate");
    expect(prefs.conversationStyle).toBe("balanced");
    expect(prefs.quietHoursEnabled).toBe(false);
    expect(prefs.allowTaskReminders).toBe(true);
    expect(prefs.allowMemorySharing).toBe(true);
    expect(prefs.maxProactivePerHour).toBe(3);
    expect(prefs.interruptionTolerance).toBe("medium");
  });

  it("should return same preferences on repeated calls", () => {
    const prefs1 = store.getPreferences("user1");
    const prefs2 = store.getPreferences("user1");
    expect(prefs1).toBe(prefs2);
  });

  it("should update preferences", () => {
    store.updatePreferences("user1", { proactiveFrequency: "frequent" });
    const prefs = store.getPreferences("user1");
    expect(prefs.proactiveFrequency).toBe("frequent");
    expect(prefs.maxProactivePerHour).toBe(6);
  });

  it("should update maxProactivePerHour when frequency changes", () => {
    store.updatePreferences("user1", { proactiveFrequency: "none" });
    expect(store.getMaxProactivePerHour("user1")).toBe(0);

    store.updatePreferences("user1", { proactiveFrequency: "minimal" });
    expect(store.getMaxProactivePerHour("user1")).toBe(1);

    store.updatePreferences("user1", { proactiveFrequency: "moderate" });
    expect(store.getMaxProactivePerHour("user1")).toBe(3);

    store.updatePreferences("user1", { proactiveFrequency: "frequent" });
    expect(store.getMaxProactivePerHour("user1")).toBe(6);
  });

  it("should update lastUpdated timestamp", () => {
    const before = Date.now();
    store.updatePreferences("user1", { conversationStyle: "detailed" });
    const prefs = store.getPreferences("user1");
    expect(prefs.lastUpdated).toBeGreaterThanOrEqual(before);
  });

  it("should return correct style", () => {
    expect(store.getStyle("user1")).toBe("balanced");
    store.updatePreferences("user1", { conversationStyle: "concise" });
    expect(store.getStyle("user1")).toBe("concise");
  });

  it("should return correct interruption tolerance", () => {
    expect(store.getInterruptionTolerance("user1")).toBe("medium");
    store.updatePreferences("user1", { interruptionTolerance: "low" });
    expect(store.getInterruptionTolerance("user1")).toBe("low");
  });

  it("should check quiet hours when disabled", () => {
    expect(store.isQuietHour("user1")).toBe(false);
  });

  it("should check quiet hours when enabled (non-crossing range)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 0, 1, 23, 0, 0));

    store.updatePreferences("user1", {
      quietHoursEnabled: true,
      quietHoursStart: 22,
      quietHoursEnd: 7,
    });

    expect(store.isQuietHour("user1")).toBe(true);
    vi.useRealTimers();
  });

  it("should check quiet hours outside range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 0, 1, 12, 0, 0));

    store.updatePreferences("user1", {
      quietHoursEnabled: true,
      quietHoursStart: 22,
      quietHoursEnd: 7,
    });

    expect(store.isQuietHour("user1")).toBe(false);
    vi.useRealTimers();
  });

  it("should check crossing midnight quiet hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 0, 1, 2, 0, 0));

    store.updatePreferences("user1", {
      quietHoursEnabled: true,
      quietHoursStart: 22,
      quietHoursEnd: 7,
    });

    expect(store.isQuietHour("user1")).toBe(true);
    vi.useRealTimers();
  });

  it("should check canBeProactive when frequency is none", () => {
    store.updatePreferences("user1", { proactiveFrequency: "none" });
    expect(store.canBeProactive("user1")).toBe(false);
  });

  it("should check canBeProactive when not in quiet hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 0, 1, 12, 0, 0));

    store.updatePreferences("user1", {
      proactiveFrequency: "moderate",
      quietHoursEnabled: true,
      quietHoursStart: 22,
      quietHoursEnd: 7,
    });

    expect(store.canBeProactive("user1")).toBe(true);
    vi.useRealTimers();
  });

  it("should check canBeProactive during quiet hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 0, 1, 23, 0, 0));

    store.updatePreferences("user1", {
      proactiveFrequency: "moderate",
      quietHoursEnabled: true,
      quietHoursStart: 22,
      quietHoursEnd: 7,
    });

    expect(store.canBeProactive("user1")).toBe(false);
    vi.useRealTimers();
  });

  it("should handle multiple users independently", () => {
    store.updatePreferences("user1", { proactiveFrequency: "none" });
    store.updatePreferences("user2", { proactiveFrequency: "frequent" });

    expect(store.getMaxProactivePerHour("user1")).toBe(0);
    expect(store.getMaxProactivePerHour("user2")).toBe(6);
  });

  it("should reset all preferences", () => {
    store.updatePreferences("user1", { proactiveFrequency: "frequent" });
    store.reset();

    const prefs = store.getPreferences("user1");
    expect(prefs.proactiveFrequency).toBe("moderate");
  });

  it("should preserve non-updated fields on partial update", () => {
    store.updatePreferences("user1", { conversationStyle: "detailed" });
    const prefs = store.getPreferences("user1");
    expect(prefs.proactiveFrequency).toBe("moderate");
    expect(prefs.conversationStyle).toBe("detailed");
  });
});
