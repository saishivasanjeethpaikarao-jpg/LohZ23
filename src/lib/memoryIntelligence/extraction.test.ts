import { describe, it, expect } from "vitest";
import { extractCandidates, classifyUtterance } from "./extraction";
import { fingerprint, normalizeText, tokenSimilarity } from "./fingerprint";
import type { ExtractionContext } from "./extraction";

const ctx: ExtractionContext = { userId: "u1" };

function turns(...texts: string[]): Array<{ role: string; content: string }> {
  return texts.map((content) => ({ role: "user", content }));
}

describe("candidate extraction", () => {
  it("classifies identity, preference, goal, behavior, event, correction, learning", () => {
    const r = extractCandidates(turns(
      "my name is Priya Sharma",
      "I really like dark roast coffee in the morning",
      "my goal is to finish the novel draft this winter",
      "I usually take a walk after dinner",
      "yesterday I lost my umbrella on the train",
      "actually I prefer tea over coffee",
      "this method worked better for pinning dependencies",
    ), ctx);
    const kinds = r.candidates.map((c) => c.kind);
    expect(kinds).toContain("fact");
    expect(kinds).toContain("preference");
    expect(kinds).toContain("goal");
    expect(kinds).toContain("behavior");
    expect(kinds).toContain("event");
    expect(kinds).toContain("correction");
    expect(kinds).toContain("learning");
  });

  it("rejects short chatter without yielding candidates", () => {
    const r = extractCandidates(turns("okay", "thanks", "yes", "what?", "tell me more"), ctx);
    expect(r.candidates).toHaveLength(0);
    expect(r.dropped).toBe(5);
  });

  it("never yields candidates from assistant turns", () => {
    const r = extractCandidates(
      [{ role: "assistant", content: "my name is LOHZ and I like chess" }],
      ctx
    );
    expect(r.candidates).toHaveLength(0);
  });

  it("produces deterministic fingerprints for equivalent statements", () => {
    expect(fingerprint("My favorite language is Python"))
      .toBe(fingerprint("MY FAVORITE LANGUAGE IS PYTHON"));
  });

  it("normalizeText strips stopwords and punctuation", () => {
    const n = normalizeText("I really, really prefer Python for scripting!");
    expect(n.tokens).toContain("python");
    expect(n.tokens).toContain("scripting");
    expect(n.tokens).not.toContain("prefer");
    expect(n.tokens).not.toContain("really");
  });

  it("tokenSimilarity distinguishes paraphrase from unrelated text", () => {
    expect(tokenSimilarity("I prefer Python as a language", "favorite language is Python")).toBeGreaterThan(0.5);
    expect(tokenSimilarity("I love hiking", "SQL performance tuning")).toBeLessThan(0.2);
  });

  it("classifyUtterance marks chatter", () => {
    expect(classifyUtterance("okay")).toBe("chatter");
    expect(classifyUtterance("tell me more")).toBe("chatter");
    expect(classifyUtterance("my name is Kai")).toBe("fact");
  });
});
