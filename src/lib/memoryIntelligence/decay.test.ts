import { describe, it, expect } from "vitest";
import { decayScore, shouldArchive, sweep, DEFAULT_DECAY_RULES } from "./decay";
import type { Memory } from "../memoryTypes";

function mk(overrides: Partial<Memory["metadata"]> & { layer?: string } = {}): Memory {
  const now = Date.now();
  return {
    id: "m" + Math.random().toString(36).slice(2, 8),
    layer: (overrides.layer as Memory["layer"]) ?? "semantic",
    category: "preference",
    text: "The user likes squash.",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    metadata: {
      importance: 0.7,
      confidence: 0.8,
      source: "conversation",
      timestamp: now,
      lastAccessed: now,
      lastReinforced: now,
      category: "preference",
      relationships: [],
      userId: "u1",
      ...overrides,
    },
  };
}

describe("decay + archival", () => {
  it("stable semantic identity evidence decays slowly without a duplicate user-model layer", () => {
    const old = mk({
      layer: "semantic",
      timestamp: Date.now() - 365 * 86400_000, // 1 year old
      lastReinforced: Date.now() - 365 * 86400_000,
    });
    expect(shouldArchive(old, { now: Date.now() })).toBe(false);
    expect(decayScore(old, { now: Date.now() })).toBeGreaterThan(0.5);
  });

  it("working memories decay faster than semantic at the same age", () => {
    const ninetyDaysAgo = Date.now() - 90 * 86400_000;
    const working = mk({ layer: "working", timestamp: ninetyDaysAgo, lastReinforced: ninetyDaysAgo, importance: 0.7 });
    const semantic = mk({ layer: "semantic", timestamp: ninetyDaysAgo, lastReinforced: ninetyDaysAgo, importance: 0.7 });
    const w = decayScore(working, { now: Date.now() });
    const s = decayScore(semantic, { now: Date.now() });
    expect(w).toBeLessThan(s);
    expect(w).toBeLessThan(0.7);
    expect(s).toBeGreaterThan(0.6);
  });

  it("very old low-importance working memories reach archive threshold", () => {
    const now = Date.now();
    const stale = mk({
      layer: "working",
      importance: 0.1,
      timestamp: now - 300 * 86400_000,
      lastReinforced: now - 300 * 86400_000,
    });
    expect(shouldArchive(stale, { now })).toBe(true);
  });

  it("fresh working memories never archive", () => {
    const fresh = mk({ layer: "working" });
    expect(shouldArchive(fresh, { now: Date.now() })).toBe(false);
  });

  it("already archived memories are excluded from sweep suggestions", () => {
    const m = mk({ timestamp: Date.now() - 300 * 86400_000 });
    const archived: Memory = {
      ...m,
      metadata: { ...m.metadata, status: "archived" } as Memory["metadata"],
    };
    const results = sweep([archived], { now: Date.now() });
    expect(results[0].action).toBe("KEEP");
  });

  it("fresh important semantic memories stay active", () => {
    const m = mk({ importance: 0.95 });
    expect(shouldArchive(m, { now: Date.now() })).toBe(false);
    expect(decayScore(m, { now: Date.now() })).toBeGreaterThan(0.6);
  });

  it("sweep is idempotent and non-destructive", () => {
    const memories = [mk(), mk({ importance: 0.05, timestamp: Date.now() - 90 * 86400_000 })];
    const first = sweep(memories, { now: Date.now() });
    const second = sweep(memories, { now: Date.now() });
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(first.every((r) => r.memory.metadata.userId === "u1")).toBe(true);
  });

  it("DEFAULT_DECAY_RULES covers all layers we use", () => {
    const layers = DEFAULT_DECAY_RULES.map((r) => r.layer);
    for (const l of ["working", "episodic", "semantic", "procedural"]) {
      expect(layers).toContain(l);
    }
    expect(layers).not.toContain("user_model");
  });
});
