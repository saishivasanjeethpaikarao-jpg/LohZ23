import { describe, it, expect, beforeEach } from "vitest";
import {
  ToolDecisionEngine,
  AVAILABLE_TOOLS,
  DEFAULT_TOOL_CONFIG,
  createToolDecisionEngine,
} from "./toolDecisionEngine";
import { CognitiveState, DEFAULT_COGNITIVE_STATE } from "./cognitiveState";

function makeState(overrides: Partial<CognitiveState> = {}): CognitiveState {
  return { ...DEFAULT_COGNITIVE_STATE, ...overrides };
}

describe("AVAILABLE_TOOLS", () => {
  it("should contain expected tools", () => {
    const names = AVAILABLE_TOOLS.map((t) => t.name);
    expect(names).toContain("conversation");
    expect(names).toContain("memory_retrieval");
    expect(names).toContain("web_search");
    expect(names).toContain("browser_open");
    expect(names).toContain("windows_open_app");
    expect(names).toContain("filesystem_read");
  });

  it("should have valid risk levels", () => {
    for (const tool of AVAILABLE_TOOLS) {
      expect(["LOW", "MEDIUM", "HIGH"]).toContain(tool.riskLevel);
    }
  });

  it("should have positive latency", () => {
    for (const tool of AVAILABLE_TOOLS) {
      expect(tool.estimatedLatencyMs).toBeGreaterThan(0);
    }
  });
});

describe("ToolDecisionEngine", () => {
  let engine: ToolDecisionEngine;

  beforeEach(() => {
    engine = createToolDecisionEngine();
  });

  it("should return a ToolDecision with all required fields", () => {
    const result = engine.decide(makeState());
    expect(result).toHaveProperty("primaryTool");
    expect(result).toHaveProperty("chainedTools");
    expect(result).toHaveProperty("reasoning");
    expect(result).toHaveProperty("confidence");
    expect(result).toHaveProperty("estimatedTotalLatencyMs");
    expect(result).toHaveProperty("riskLevel");
  });

  it("should select conversation tool for simple user query", () => {
    const state = makeState({ userIntent: "hello" });
    const result = engine.decide(state);
    expect(result.primaryTool).toBe("conversation");
  });

  it("should select web_search when external info is needed and latency budget is generous", () => {
    const highLatencyEngine = new ToolDecisionEngine({ latencyBudgetMs: 10000 });
    const state = makeState({ userIntent: "search for latest news about AI" });
    const result = highLatencyEngine.decide(state);
    expect(result.primaryTool).toBe("web_search");
  });

  it("should filter tools by availableTools parameter", () => {
    const result = engine.decide(makeState({ userIntent: "search for something" }), ["conversation"]);
    expect(result.primaryTool).toBe("conversation");
  });

  it("should return valid confidence between 0 and 1", () => {
    const result = engine.decide(makeState());
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("should return valid risk level", () => {
    const result = engine.decide(makeState());
    expect(["LOW", "MEDIUM", "HIGH"]).toContain(result.riskLevel);
  });

  it("should return non-negative latency", () => {
    const result = engine.decide(makeState());
    expect(result.estimatedTotalLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("should generate non-empty reasoning", () => {
    const result = engine.decide(makeState());
    expect(result.reasoning.length).toBeGreaterThan(0);
  });

  it("should track history", () => {
    engine.decide(makeState());
    engine.decide(makeState());
    expect(engine.getHistory().length).toBe(2);
  });

  it("should return copy of history", () => {
    engine.decide(makeState());
    const h1 = engine.getHistory();
    const h2 = engine.getHistory();
    expect(h1).not.toBe(h2);
  });

  it("should report stats", () => {
    engine.decide(makeState());
    const stats = engine.getStats();
    expect(stats.totalDecisions).toBe(1);
    expect(stats.avgConfidence).toBeGreaterThanOrEqual(0);
  });

  it("should reset history", () => {
    engine.decide(makeState());
    engine.reset();
    expect(engine.getHistory()).toEqual([]);
  });

  it("should cap history at 100", () => {
    for (let i = 0; i < 120; i++) {
      engine.decide(makeState());
    }
    expect(engine.getHistory().length).toBeLessThanOrEqual(100);
  });

  it("should prefer low risk tools by default", () => {
    const state = makeState({ userIntent: "open the app and search" });
    const result = engine.decide(state);
    expect(result.riskLevel).not.toBe("HIGH");
  });
});

describe("DEFAULT_TOOL_CONFIG", () => {
  it("should have sensible defaults", () => {
    expect(DEFAULT_TOOL_CONFIG.maxToolsPerDecision).toBe(3);
    expect(DEFAULT_TOOL_CONFIG.preferLowRisk).toBe(true);
    expect(DEFAULT_TOOL_CONFIG.maxChainLength).toBe(3);
    expect(DEFAULT_TOOL_CONFIG.latencyBudgetMs).toBe(5000);
  });
});

describe("createToolDecisionEngine", () => {
  it("should return a ToolDecisionEngine instance", () => {
    const e = createToolDecisionEngine();
    expect(e).toBeInstanceOf(ToolDecisionEngine);
  });
});
