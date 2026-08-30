import { describe, it, expect } from "vitest";
import { retrieve, scoreMemory } from "./retrieval";
import { DEFAULT_MEMORY_BUDGET } from "./types";
import type { Memory } from "../memoryTypes";

function mk(id: string, text: string, uid = "u1", importance = 0.6, ageDays = 1): Memory {
  const now = Date.now();
  return {
    id, layer: "semantic", category: "preference", text,
    createdAt: new Date(now - ageDays * 86400_000).toISOString(),
    updatedAt: new Date(now - ageDays * 86400_000).toISOString(),
    metadata: {
      importance, confidence: 0.8,
      source: "conversation",
      timestamp: now - ageDays * 86400_000, lastAccessed: now, lastReinforced: now,
      category: "preference", relationships: [], userId: uid,
    },
  };
}

describe("retrieval ranking", () => {
  const mems = [
    mk("a1", "The user loves Python tooling", "u1", 0.9, 0),
    mk("a2", "User had lunch with Sam", "u1", 0.3, 40),
    mk("a3", "Python dependency pinning strategy", "u1", 0.7, 2),
    mk("b1", "Someone else's memory", "u2", 0.9, 0),
  ];

  it("excludes other users' memories from results", () => {
    const out = retrieve(mems, { userId: "u1" }, DEFAULT_MEMORY_BUDGET);
    expect(out.every((s) => s.memory.metadata.userId === "u1")).toBe(true);
  });

  it("goal alignment surfaces goal-relevant entries in results", () => {
    const out = retrieve(
      mems,
      { userId: "u1", activeGoals: ["ship Python report"] },
      DEFAULT_MEMORY_BUDGET
    );
    const ids = out.map((s) => s.memory.id);
    expect(ids).toContain("a3");
    const scoreA3 = out.find((s) => s.memory.id === "a3")!;
    expect(scoreA3.breakdown.goalAlignment).toBeGreaterThan(0);
  });

  it("topic query returns the closest matches first", () => {
    const out = retrieve(
      mems,
      { userId: "u1", query: "python" },
      DEFAULT_MEMORY_BUDGET
    );
    expect(out.length).toBeGreaterThan(0);
    const top = out[0].memory.id;
    expect(["a1", "a3"]).toContain(top);
  });

  it("respects retrieval budget cap", () => {
    const many = Array.from({ length: 50 }, (_, i) => mk(`m${i}`, `fact ${i}`));
    const out = retrieve(many, { userId: "u1" }, DEFAULT_MEMORY_BUDGET);
    expect(out.length).toBeLessThanOrEqual(DEFAULT_MEMORY_BUDGET.maxRetrievalResults);
  });

  it("null scoreMemory rejects cross-user reads", () => {
    expect(scoreMemory(mems[3], { userId: "u1" })).toBeNull();
  });

  it("minImportance filter applies", () => {
    const out = retrieve(mems, { userId: "u1", minImportance: 0.8 }, DEFAULT_MEMORY_BUDGET);
    expect(out).toHaveLength(1);
    expect(out[0].memory.id).toBe("a1");
  });

  it("archived memories still surface but flagged", () => {
    const archived: Memory = {
      ...mems[0],
      metadata: { ...mems[0].metadata, status: "archived" } as Memory["metadata"],
    };
    const out = retrieve([archived], { userId: "u1" }, DEFAULT_MEMORY_BUDGET);
    expect(out[0].archived).toBe(true);
  });

  it("goal alignment boosts relevant memories", () => {
    const out = retrieve(
      mems,
      { userId: "u1", activeGoals: ["ship Python report"] },
      DEFAULT_MEMORY_BUDGET
    );
    const ids = out.map((s) => s.memory.id);
    expect(ids).toContain("a3");
    const scoreA3 = out.find((s) => s.memory.id === "a3")!;
    expect(scoreA3.breakdown.goalAlignment).toBeGreaterThan(0);
  });
});
