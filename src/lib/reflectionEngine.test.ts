import { describe, it, expect, beforeEach, vi } from "vitest";
import { ReflectionEngine, createReflectionEngine } from "./reflectionEngine";
import { Memory, ConversationTurn } from "./memoryTypes";

function mem(id: string, overrides: Partial<Memory> = {}): Memory {
  return {
    id, layer: "semantic", category: "concept", text: `memory ${id}`,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    metadata: {
      importance: 0.7, confidence: 0.8, source: "conversation",
      timestamp: Date.now(), lastAccessed: Date.now(), lastReinforced: Date.now(),
      category: "concept", relationships: [], userId: "u1",
    },
    ...overrides,
  };
}

function turns(...contents: string[]): ConversationTurn[] {
  return contents.map((c) => ({ role: "user" as const, content: c, timestamp: Date.now() }));
}

describe("ReflectionEngine", () => {
  let re: ReflectionEngine;
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    re = createReflectionEngine({ reflectionIntervalMs: 0 });
  });

  it("should reflect on a 4+ turn conversation", async () => {
    const result = await re.reflect(turns("a", "b", "c", "d"), [], "u1", "c1");
    expect(result).not.toBeNull();
    expect(result!.conversationId).toBe("c1");
  });

  it("should return null for too-short conversation", async () => {
    const result = await re.reflect(turns("hi"), [], "u1", "c1");
    expect(result).toBeNull();
  });

  it("should return null when rate-limited", async () => {
    const re2 = createReflectionEngine({ reflectionIntervalMs: 5000 });
    await re2.reflect(turns("a", "b", "c", "d"), [], "u1", "c1");
    const r2 = await re2.reflect(turns("a", "b", "c", "d"), [], "u1", "c2");
    expect(r2).toBeNull();
  });

  it("should detect new topic learnings", async () => {
    const result = await re.reflect(
      turns("quantum physics", "entanglement", "superposition", "wave functions"),
      [], "u1", "c1"
    );
    expect(result!.insights.some((i) => i.type === "learning")).toBe(true);
  });

  it("should detect user corrections", async () => {
    const existing = mem("c1", { text: "blue is favorite color", category: "preference", layer: "semantic" });
    const result = await re.reflect(
      turns("actually, blue is not my favorite", "red is better", "red is great", "definitely red"),
      [existing], "u1", "c1"
    );
    expect(result!.insights.some((i) => i.type === "correction")).toBe(true);
  });

  it("should return result with insights and memory updates", async () => {
    const result = await re.reflect(turns("a", "b", "c", "d"), [], "u1", "c1");
    expect(Array.isArray(result!.insights)).toBe(true);
    expect(Array.isArray(result!.memoryUpdates)).toBe(true);
    expect(Array.isArray(result!.strategyUpdates)).toBe(true);
  });

  it("should cap history at 50", async () => {
    for (let i = 0; i < 60; i++) {
      vi.advanceTimersByTime(1000);
      await re.reflect(turns("a", "b", "c", "d"), [], "u1", `c${i}`);
    }
    expect(re.getHistory().length).toBeLessThanOrEqual(50);
  });

  it("should reset state", async () => {
    await re.reflect(turns("a", "b", "c", "d"), [], "u1", "c1");
    re.reset();
    expect(re.getHistory()).toEqual([]);
  });

  it("should report stats", async () => {
    await re.reflect(turns("a", "b", "c", "d"), [], "u1", "c1");
    const stats = re.getStats();
    expect(stats.totalReflections).toBe(1);
  });
});
