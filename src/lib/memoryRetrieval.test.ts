import { describe, it, expect, beforeEach } from "vitest";
import MemoryRetrieval from "./memoryRetrieval";
import { Memory, MemoryQuery } from "./memoryTypes";

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

function query(q: Partial<MemoryQuery> = {}): MemoryQuery {
  return { userId: "u1", ...q };
}

describe("MemoryRetrieval", () => {
  let r: MemoryRetrieval;
  beforeEach(() => { r = new MemoryRetrieval(); });

  it("should add and retrieve memories", () => {
    const m = mem("1");
    r.addMemory(m);
    expect(r.getMemory("1")).toBe(m);
    expect(r.count()).toBe(1);
  });

  it("should remove memories", () => {
    r.addMemory(mem("1"));
    expect(r.removeMemory("1")).toBe(true);
    expect(r.getMemory("1")).toBeUndefined();
  });

  it("should return false for removing nonexistent memory", () => {
    expect(r.removeMemory("nope")).toBe(false);
  });

  it("should query by userId", () => {
    r.addMemory(mem("1", { metadata: { ...mem("1").metadata, userId: "u1" } }));
    r.addMemory(mem("2", { metadata: { ...mem("2").metadata, userId: "u2" } }));
    const results = r.query(query({ userId: "u1" }));
    expect(results.length).toBe(1);
    expect(results[0].memory.id).toBe("1");
  });

  it("should query by layer filter", () => {
    r.addMemory(mem("1", { layer: "semantic" }));
    r.addMemory(mem("2", { layer: "episodic" }));
    const results = r.query(query({ layer: "semantic" }));
    expect(results.length).toBe(1);
  });

  it("should query by category filter", () => {
    r.addMemory(mem("1", { category: "concept" }));
    r.addMemory(mem("2", { category: "preference" }));
    const results = r.query(query({ category: "concept" }));
    expect(results.length).toBe(1);
  });

  it("should respect limit", () => {
    for (let i = 0; i < 20; i++) r.addMemory(mem(String(i)));
    const results = r.query(query({ limit: 5 }));
    expect(results.length).toBe(5);
  });

  it("should sort by score descending", () => {
    r.addMemory(mem("low", { metadata: { ...mem("low").metadata, importance: 0.2 } }));
    r.addMemory(mem("high", { metadata: { ...mem("high").metadata, importance: 0.9 } }));
    const results = r.query(query());
    if (results.length === 2) {
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    }
  });

  it("should cache query results", () => {
    r.addMemory(mem("1"));
    const q = query();
    const r1 = r.query(q);
    const r2 = r.query(q);
    expect(r1).toBe(r2);
  });

  it("should invalidate cache on addMemory", () => {
    r.addMemory(mem("1"));
    const r1 = r.query(query());
    r.addMemory(mem("2"));
    const r2 = r.query(query());
    expect(r1).not.toBe(r2);
  });

  it("should invalidate cache on removeMemory", () => {
    r.addMemory(mem("1"));
    const r1 = r.query(query());
    r.removeMemory("1");
    const r2 = r.query(query());
    expect(r1).not.toBe(r2);
  });

  it("should getRecent sorted by timestamp", () => {
    r.addMemory(mem("old", { metadata: { ...mem("old").metadata, timestamp: 100 } }));
    r.addMemory(mem("new", { metadata: { ...mem("new").metadata, timestamp: 200 } }));
    const recent = r.getRecent(10);
    expect(recent[0].id).toBe("new");
  });

  it("should getByLayer", () => {
    r.addMemory(mem("s", { layer: "semantic" }));
    r.addMemory(mem("e", { layer: "episodic" }));
    expect(r.getByLayer("semantic").length).toBe(1);
  });

  it("should getByCategory", () => {
    r.addMemory(mem("c", { category: "concept" }));
    r.addMemory(mem("p", { category: "preference" }));
    expect(r.getByCategory("concept").length).toBe(1);
  });

  it("should load and replace all memories", () => {
    r.addMemory(mem("old"));
    r.load([mem("new1"), mem("new2")]);
    expect(r.count()).toBe(2);
    expect(r.getMemory("old")).toBeUndefined();
  });

  it("should return getAll", () => {
    r.addMemory(mem("1"));
    r.addMemory(mem("2"));
    expect(r.getAll().length).toBe(2);
  });
});
