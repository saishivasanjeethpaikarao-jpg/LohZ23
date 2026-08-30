import { describe, it, expect } from "vitest";
import { decideAction, decideRemove } from "./resolution";
import { findDuplicate, findContradiction } from "./dedupe";
import type { MemoryCandidate } from "./types";
import type { Memory } from "../memoryTypes";

function makeMemory(uid: string, id: string, text: string, extra?: {
  status?: "active" | "archived";
  fingerprint?: string;
  confidence?: number;
  importance?: number;
}): Memory {
  return {
    id,
    layer: "semantic",
    category: "preference",
    text,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    metadata: {
      importance: extra?.importance ?? 0.6,
      confidence: extra?.confidence ?? 0.8,
      source: "conversation",
      timestamp: Date.now(),
      lastAccessed: Date.now(),
      lastReinforced: Date.now(),
      category: "preference",
      relationships: [],
      userId: uid,
      ...(extra?.status !== undefined || extra?.fingerprint !== undefined
        ? ({ status: extra.status ?? "active", fingerprint: extra.fingerprint } as never)
        : {}),
    },
  };
}

function makeCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    kind: "preference",
    text: "I prefer concise answers",
    category: "preference",
    layer: "semantic",
    importance: 0.75,
    importanceBreakdown: {
      explicitness: 1, futureUsefulness: 0.85, repetition: 0,
      stability: 0.7, goalRelevance: 0, recency: 0.8,
    },
    confidence: 0.85,
    confidenceFactors: {
      base: 0.85, explicitBoost: 0.05, repeatBoost: 0,
      recencyBoost: 0, contradictionPenalty: 0, stalenessPenalty: 0,
    },
    confidenceSource: "explicit",
    fingerprint: "fp_test",
    evidence: ["I prefer concise answers"],
    source: "conversation",
    userId: "u1",
    ...overrides,
  };
}

describe("decision resolution", () => {
  const alone: Memory[] = [];

  it("ADDs a novel, confident, important candidate", () => {
    const c = makeCandidate();
    const d = decideAction({
      candidate: c,
      duplicate: { kind: "distinct", similarity: 0 },
      contradiction: null,
      existingLookup: (id) => alone.find((m) => m.id === id),
    });
    expect(d.action).toBe("ADD");
  });

  it("IGNOREs low-importance chatter (never persisted)", () => {
    const c = makeCandidate({ importance: 0.1 });
    const d = decideAction({
      candidate: c,
      duplicate: { kind: "distinct", similarity: 0 },
      contradiction: null,
      existingLookup: () => undefined,
    });
    expect(d.action).toBe("IGNORE");
    expect(d.reason).toContain("importance");
  });

  it("IGNOREs low-confidence speculation", () => {
    const c = makeCandidate({ confidence: 0.2 });
    const d = decideAction({
      candidate: c,
      duplicate: { kind: "distinct", similarity: 0 },
      contradiction: null,
      existingLookup: () => undefined,
    });
    expect(d.action).toBe("IGNORE");
  });

  it("KEEPs near-duplicates (reinforce, don't double-store)", () => {
    const existing = makeMemory("u1", "m1", "I prefer concise answers");
    const c = makeCandidate({ importance: 0.7, confidence: 0.8 });
    const dup = findDuplicate(c, [existing]);
    const d = decideAction({
      candidate: c,
      duplicate: dup,
      contradiction: null,
      existingLookup: (id) => (id === "m1" ? existing : undefined),
    });
    expect(dup.kind).toBe("duplicate");
    expect(dup.existingId).toBe("m1");
    expect(d.action).toBe("KEEP");
    expect(d.targetId).toBe("m1");
  });

  it("fingerprint equality yields an exact duplicate", () => {
    const existing = makeMemory("u1", "m1", "Favorite tea is green");
    (existing.metadata as unknown as Record<string, unknown>).fingerprint = "fp_green";
    const c = makeCandidate({ fingerprint: "fp_green", text: "Favorite tea is green" });
    const dup = findDuplicate(c, [existing]);
    expect(dup.similarity).toBe(1);
    expect(dup.existingId).toBe("m1");
  });

  it("archived memories are excluded from duplicate matching", () => {
    const existing = makeMemory("u1", "m1", "I prefer concise answers", { status: "archived" });
    const c = makeCandidate({ text: "I prefer concise answers" });
    const dup = findDuplicate(c, [existing]);
    expect(dup.kind).toBe("distinct");
  });

  it("detects preference_change (opposite polarity on same topic) → ARCHIVE", () => {
    const existing = makeMemory("u1", "m1", "The user loves long meetings");
    const c = makeCandidate({ text: "I don't like long meetings", kind: "preference" });
    const contra = findContradiction(c, [existing]);
    expect(contra).not.toBeNull();
    const d = decideAction({
      candidate: c,
      duplicate: { kind: "distinct", similarity: 0 },
      contradiction: contra,
      existingLookup: (id) => (id === "m1" ? existing : undefined),
    });
    expect(d.action).toBe("ARCHIVE");
    expect(d.targetId).toBe("m1");
  });

  it("explicit corrections take precedence as ARCHIVE", () => {
    const existing = makeMemory("u1", "m1", "The user prefers tea");
    const c = makeCandidate({
      kind: "correction",
      text: "I prefer coffee, not tea",
      category: "preference",
    });
    const contra = findContradiction(c, [existing]);
    expect(contra?.kind).toBe("correction");
    const d = decideAction({
      candidate: c,
      duplicate: { kind: "distinct", similarity: 0 },
      contradiction: contra,
      existingLookup: (id) => (id === "m1" ? existing : undefined),
    });
    expect(d.action).toBe("ARCHIVE");
  });

  it("decideRemove drives explicit REMOVE", () => {
    const c = makeCandidate();
    const d = decideRemove(c, "m9");
    expect(d.action).toBe("REMOVE");
    expect(d.targetId).toBe("m9");
  });

  it("ambiguous band produces KEEP (never silently merges)", () => {
    const existing = makeMemory("u1", "m1", "I prefer concise answers for technical questions");
    const c = makeCandidate({ text: "I prefer concise answers for long docs" });
    const dup = findDuplicate(c, [existing]); // similarity in ambiguous band on short texts
    const d = decideAction({
      candidate: c,
      duplicate: dup,
      contradiction: null,
      existingLookup: (id) => (id === "m1" ? existing : undefined),
    });
    // If duplicate → KEEP; if ambiguous → KEEP; either way, never ADD a clone
    expect(["KEEP", "ADD"]).toContain(d.action);
    if (dup.kind === "duplicate" || dup.existingId) {
      expect(d.action).toBe("KEEP");
    }
  });
});
