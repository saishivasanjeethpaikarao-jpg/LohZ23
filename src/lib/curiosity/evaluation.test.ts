import { describe, expect, it } from "vitest";
import { runCuriosityEvaluation, type EvalScenario } from "./evaluation";

/** Deterministic corpus: one scenario per cell of the expected behavior matrix. */
const CORPUS: EvalScenario[] = [
  {
    id: "ask-when-nothing-known",
    input: { intent: "chat", confidence: 0.4, success: false, inputText: "open the thing" },
    providers: {},
    oracle: { answerResolves: true, userAnswerTruthful: true },
  },
  {
    id: "memory-first-no-pestering",
    input: { intent: "chat", confidence: 0.9, success: true, inputText: "I don't know which folder it went into" },
    providers: { memoryHasAnswer: true, memoryAnswerTruthful: true },
  },
  {
    id: "probe-unverified-outcome",
    input: { intent: "open_app", confidence: 0.98, success: false, verificationStatus: "INCONCLUSIVE" },
    providers: { probeSafe: true },
  },
  {
    id: "ask-when-probe-unsafe",
    input: { intent: "open_app", confidence: 0.98, success: false, verificationStatus: "FAILED" },
    providers: { probeSafe: false },
    oracle: { answerResolves: true, userAnswerTruthful: true },
  },
  {
    id: "world-state-first",
    input: { intent: "open_app", confidence: 0.9, success: true, staleReference: "chrome open" },
    providers: { worldHasAnswer: true },
  },
  {
    id: "withhold-when-no-safe-source",
    input: { intent: "open_app", confidence: 0.9, success: true, staleReference: "chrome open" },
    providers: { worldHasAnswer: false, probeSafe: false, memoryHasAnswer: false },
  },
  {
    id: "unverified-probe-wins-over-asking",
    input: { intent: "open_app", confidence: 0.98, success: false, verificationStatus: "INCONCLUSIVE" },
    providers: { probeSafe: true, memoryHasAnswer: false, worldHasAnswer: false },
  },
  {
    id: "bad-memory-never-fully-resolves",
    input: { intent: "chat", confidence: 0.9, success: true, inputText: "I don't know the gateway port" },
    providers: { memoryHasAnswer: true, memoryAnswerTruthful: false },
  },
];

describe("Phase 42 — offline curiosity evaluation harness", () => {
  it("runs the corpus and produces the mandated metrics", async () => {
    const run = await runCuriosityEvaluation(CORPUS);
    expect(run.metrics.scenarios).toBe(8);
    // per-scenario columns are complete and inspectable
    expect(run.perScenario).toHaveLength(8);
    for (const row of run.perScenario) {
      expect(["ask_user", "use_memory", "inspect_state", "safe_probe", "withhold"]).toContain(row.action);
    }
  });

  it("never asks a question a free source could have answered", async () => {
    const run = await runCuriosityEvaluation(CORPUS);
    expect(run.metrics.unnecessaryQuestions).toBe(0);
  });

  it("asks at least one genuinely useful question", async () => {
    const run = await runCuriosityEvaluation(CORPUS);
    expect(run.metrics.usefulQuestions).toBeGreaterThanOrEqual(1);
    expect(run.metrics.questionsAsked).toBeGreaterThanOrEqual(run.metrics.usefulQuestions);
  });

  it("reduces uncertainty meaningfully on resolved gaps", async () => {
    const run = await runCuriosityEvaluation(CORPUS);
    expect(run.metrics.uncertaintyReduction).toBeGreaterThan(0.5);
  });

  it("makes zero incorrect assumptions (memory hits never fully resolve)", async () => {
    const run = await runCuriosityEvaluation(CORPUS);
    expect(run.metrics.incorrectAssumptions).toBe(0);
  });

  it("withholds when no safe source exists (action avoidance)", async () => {
    const run = await runCuriosityEvaluation(CORPUS);
    expect(run.metrics.actionAvoidance).toBeGreaterThanOrEqual(1);
    const withheld = run.perScenario.filter((s) => s.action === "withhold").map((s) => s.id);
    expect(withheld).toContain("withhold-when-no-safe-source");
  });

  it("probes before asking when a verified outcome is missing", async () => {
    const run = await runCuriosityEvaluation(CORPUS);
    const row = run.perScenario.find((s) => s.id === "unverified-probe-wins-over-asking")!;
    expect(row.action).toBe("safe_probe");
    expect(row.resolved).toBe(true);
    expect(row.finalUncertainty).toBeLessThan(row.initialUncertainty);
  });

  it("uses world state before asking", async () => {
    const run = await runCuriosityEvaluation(CORPUS);
    const row = run.perScenario.find((s) => s.id === "world-state-first")!;
    expect(row.action).toBe("inspect_state");
  });
});
