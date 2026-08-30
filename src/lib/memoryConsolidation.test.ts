import { describe, it, expect, beforeEach } from "vitest";
import { MemoryConsolidation, DEFAULT_CONSOLIDATION_CONFIG, createMemoryConsolidation } from "./memoryConsolidation";
import { Memory, ConversationTurn } from "./memoryTypes";

function mem(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "m1", layer: "semantic", category: "concept", text: "test",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    metadata: {
      importance: 0.7, confidence: 0.8, source: "conversation",
      timestamp: Date.now(), lastAccessed: Date.now(), lastReinforced: Date.now(),
      category: "concept", relationships: [], userId: "u1",
    },
    ...overrides,
  };
}

function turn(content: string, role: "user" | "assistant" = "user"): ConversationTurn {
  return { role, content, timestamp: Date.now() };
}

describe("MemoryConsolidation", () => {
  let mc: MemoryConsolidation;
  beforeEach(() => { mc = createMemoryConsolidation(); });

  it("should extract identity facts from conversation", async () => {
    const txns = await mc.processConversation(
      [turn("My name is Alice")], [], "u1"
    );
    expect(txns.length).toBeGreaterThanOrEqual(1);
    expect(txns.some((t) => t.text.includes("alice"))).toBe(true);
  });

  it("should extract preference facts", async () => {
    const txns = await mc.processConversation(
      [turn("I like dark mode")], [], "u1"
    );
    expect(txns.some((t) => t.category === "preference")).toBe(true);
  });

  it("should extract goal facts", async () => {
    const txns = await mc.processConversation(
      [turn("I want to learn Rust")], [], "u1"
    );
    expect(txns.some((t) => t.category === "goal")).toBe(true);
  });

  it("should extract behavior facts", async () => {
    const txns = await mc.processConversation(
      [turn("I usually code at night")], [], "u1"
    );
    expect(txns.some((t) => t.category === "behavior")).toBe(true);
  });

  it("should extract explicit remember commands", async () => {
    const txns = await mc.processConversation(
      [turn("Remember this: meeting at 3pm tomorrow")], [], "u1"
    );
    expect(txns.some((t) => t.text.includes("meeting at 3pm"))).toBe(true);
  });

  it("should produce ADD transactions for new memories", async () => {
    const txns = await mc.processConversation(
      [turn("My name is Bob")], [], "u1"
    );
    expect(txns.some((t) => t.action === "ADD")).toBe(true);
  });

  it("should detect duplicates and produce UPDATE", async () => {
    const existing = mem({
      id: "existing1", text: "Alice", category: "identity", layer: "user_model",
      metadata: {
        importance: 0.9, confidence: 0.9, source: "conversation",
        timestamp: Date.now(), lastAccessed: Date.now(), lastReinforced: Date.now(),
        category: "identity", relationships: [], userId: "u1",
      },
    });
    const txns = await mc.processConversation(
      [turn("My name is Alice")], [existing], "u1"
    );
    expect(txns.some((t) => t.action === "UPDATE")).toBe(true);
  });

  it("should filter low-importance facts", async () => {
    const txns = await mc.processConversation(
      [turn("the is a an but or")], [], "u1"
    );
    expect(txns.length).toBe(0);
  });

  it("should return empty for assistant-only conversation", async () => {
    const txns = await mc.processConversation(
      [turn("Hello there", "assistant")], [], "u1"
    );
    expect(txns.length).toBe(0);
  });

  it("should cap history at 100", async () => {
    for (let i = 0; i < 120; i++) {
      await mc.processConversation([turn(`I am person ${i}`)], [], "u1");
    }
    expect(mc.getHistory().length).toBeLessThanOrEqual(100);
  });
});

describe("DEFAULT_CONSOLIDATION_CONFIG", () => {
  it("should have sensible defaults", () => {
    expect(DEFAULT_CONSOLIDATION_CONFIG.minImportanceThreshold).toBe(0.4);
    expect(DEFAULT_CONSOLIDATION_CONFIG.minConfidenceThreshold).toBe(0.5);
    expect(DEFAULT_CONSOLIDATION_CONFIG.maxCandidatesPerConversation).toBe(10);
  });
});
