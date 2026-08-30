import { describe, it, expect, beforeEach } from "vitest";
import { ConversationQualityChecker, QualityContext } from "./conversationQuality";

function makeContext(overrides: Partial<QualityContext> = {}): QualityContext {
  return {
    recentTurns: [],
    activeTopic: null,
    userEmotionalState: "neutral",
    ...overrides,
  };
}

describe("ConversationQualityChecker", () => {
  let checker: ConversationQualityChecker;

  beforeEach(() => {
    checker = new ConversationQualityChecker();
  });

  it("should pass quality check for normal text", () => {
    const result = checker.checkQuality("I found the information you requested.", makeContext());
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  // ── Repetition Detection ──

  it("should detect repetition when phrases overlap significantly", () => {
    checker.recordSpoken("I found the search results for your query about TypeScript patterns");
    const result = checker.checkQuality(
      "I found the search results for your query about TypeScript patterns",
      makeContext()
    );
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.includes("Repetition"))).toBe(true);
  });

  it("should not flag different phrases as repetition", () => {
    checker.recordSpoken("The weather is nice today");
    const result = checker.checkQuality("Let me search for that information", makeContext());
    expect(result.passed).toBe(true);
  });

  // ── Filler Detection ──

  it("should detect filler words", () => {
    const result = checker.checkQuality("Um, I think we should look at this", makeContext());
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.includes("Filler"))).toBe(true);
  });

  it("should detect multiple filler words", () => {
    const result = checker.checkQuality("Well, basically, like, I found it", makeContext());
    expect(result.passed).toBe(false);
    const fillerIssues = result.issues.filter((i) => i.includes("Filler"));
    expect(fillerIssues.length).toBeGreaterThanOrEqual(2);
  });

  it("should not flag clean text as having fillers", () => {
    const result = checker.checkQuality("The information you requested is available", makeContext());
    expect(result.passed).toBe(true);
  });

  // ── Question Limiting ──

  it("should allow first two consecutive questions", () => {
    checker.recordSpoken("What do you need?");
    const result = checker.checkQuality("How can I help?", makeContext());
    expect(result.passed).toBe(true);
  });

  it("should block third consecutive question", () => {
    checker.recordSpoken("What do you need?");
    checker.recordSpoken("How can I help?");
    const result = checker.checkQuality("Where should I look?", makeContext());
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.includes("consecutive questions"))).toBe(true);
  });

  it("should reset consecutive count after non-question", () => {
    checker.recordSpoken("What do you need?");
    checker.recordSpoken("Here are the results");
    checker.recordSpoken("Where should I look?");
    const result = checker.checkQuality("How does this work?", makeContext());
    expect(result.passed).toBe(true);
  });

  it("should block when session question limit reached", () => {
    for (let i = 0; i < 8; i++) {
      checker.recordSpoken(`Question ${i}?`);
    }
    const result = checker.checkQuality("Another question?", makeContext());
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.includes("question limit"))).toBe(true);
  });

  // ── Artificial Filler Detection ──

  it("should block artificial fillers", () => {
    const result = checker.checkQuality("Are you there?", makeContext());
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.includes("Artificial filler"))).toBe(true);
  });

  it("should block various artificial fillers", () => {
    const fillers = ["How are you?", "Want to talk?", "Just checking in!", "Got a minute?"];
    for (const filler of fillers) {
      checker.reset();
      const result = checker.checkQuality(filler, makeContext());
      expect(result.passed).toBe(false);
    }
  });

  it("should not flag genuine questions as artificial", () => {
    const result = checker.checkQuality("Which testing frameworks are commonly used?", makeContext());
    expect(result.passed).toBe(true);
  });

  // ── Phrase Diversity ──

  it("should track phrase diversity", () => {
    checker.recordSpoken("Hello world");
    checker.recordSpoken("Goodbye world");
    const diversity = checker.getPhraseDiversity();
    expect(diversity).toBeGreaterThan(0.5);
  });

  it("should detect low diversity", () => {
    for (let i = 0; i < 10; i++) {
      checker.recordSpoken("Same phrase over and over again");
    }
    const diversity = checker.getPhraseDiversity();
    expect(diversity).toBeLessThan(0.5);
  });

  it("should flag low diversity in quality check", () => {
    for (let i = 0; i < 10; i++) {
      checker.recordSpoken("Same phrase over and over again");
    }
    const result = checker.checkQuality("Another instance of the same phrase", makeContext());
    expect(result.issues.some((i) => i.includes("diversity"))).toBe(true);
  });

  // ── Quality Score ──

  it("should give high score for clean text", () => {
    const result = checker.checkQuality("The information you requested is available", makeContext());
    expect(result.score).toBe(1);
  });

  it("should reduce score for each issue", () => {
    checker.recordSpoken("The answer is 42 and it is correct");
    const result = checker.checkQuality(
      "The answer is 42 and it is correct",
      makeContext()
    );
    expect(result.score).toBeLessThan(1);
  });

  it("should not go below 0", () => {
    for (let i = 0; i < 10; i++) {
      checker.recordSpoken("Are you there?");
    }
    const result = checker.checkQuality("Are you there?", makeContext());
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  // ── Record Spoken ──

  it("should track questions asked", () => {
    checker.recordSpoken("What do you think?");
    checker.recordSpoken("How about this?");
    expect(checker.getQuestionsThisSession()).toBe(2);
  });

  it("should track consecutive questions", () => {
    checker.recordSpoken("What?");
    checker.recordSpoken("How?");
    expect(checker.getConsecutiveQuestions()).toBe(2);
  });

  it("should reset consecutive on non-question", () => {
    checker.recordSpoken("What?");
    checker.recordSpoken("Here is the answer");
    expect(checker.getConsecutiveQuestions()).toBe(0);
  });

  // ── Reset ──

  it("should reset all tracking state", () => {
    checker.recordSpoken("Hello");
    checker.recordSpoken("What?");
    checker.reset();

    expect(checker.getConsecutiveQuestions()).toBe(0);
    expect(checker.getQuestionsThisSession()).toBe(0);
    expect(checker.getPhraseDiversity()).toBe(1);
  });

  // ── Multiple Issues ──

  it("should catch multiple issues in one text", () => {
    checker.recordSpoken("Um, well, are you there?");
    const result = checker.checkQuality("Um, well, are you there?", makeContext());
    expect(result.passed).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });
});
