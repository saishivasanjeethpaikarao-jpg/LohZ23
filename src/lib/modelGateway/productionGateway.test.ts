import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getProductionGateway,
  resetProductionGateway,
} from "./productionGateway";
import { ModelGateway } from "./gateway";
import {
  CostLimitExceededError,
  GenerateRequest,
  GenerateResult,
  ModelProvider,
} from "./types";

function makeMockProvider(
  name: "gemini" | "nvidia",
  overrides?: Partial<ModelProvider>
): ModelProvider & { generate: ReturnType<typeof vi.fn> } {
  return {
    name,
    capabilities: ["text_generation", "memory_consolidation", "reflection"],
    generate: vi.fn(async (request: GenerateRequest): Promise<GenerateResult> => ({
      text: "ok",
      provider: name,
      model: "mock-model",
      capability: request.capability,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      latencyMs: 1,
    })),
    healthCheck: async () => ({ healthy: true, latencyMs: 0 }),
    ...overrides,
  } as ModelProvider & { generate: ReturnType<typeof vi.fn> };
}

describe("Production gateway (cost enforcement default ON)", () => {
  beforeEach(() => {
    resetProductionGateway();
    delete process.env.LOHZ_COST_ENFORCEMENT;
    delete process.env.LOHZ_COST_LIMIT_TOKENS_PER_HOUR;
  });

  it("enforces cost limits by default", () => {
    const gateway = getProductionGateway();
    expect(gateway.getConfig().enforceCostLimit).toBe(true);
    expect(gateway.getConfig().costLimitPerHour).toBeGreaterThan(0);
  });

  it("can be downgraded to warn-only via options or env", () => {
    const viaOptions = getProductionGateway({ enforceCostLimit: false });
    expect(viaOptions.getConfig().enforceCostLimit).toBe(false);

    resetProductionGateway();
    process.env.LOHZ_COST_ENFORCEMENT = "0";
    const viaEnv = getProductionGateway();
    expect(viaEnv.getConfig().enforceCostLimit).toBe(false);
  });

  it("throws CostLimitExceededError before calling the provider once the budget is spent", async () => {
    const mock = makeMockProvider("gemini");
    const gateway = getProductionGateway({ costLimitPerHour: 10, enforceCostLimit: true });
    gateway.registerProvider(mock);
    gateway.registerProvider(makeMockProvider("nvidia"));

    // First call passes (0 tokens used) and records 15 tokens.
    await gateway.generate({ prompt: "one", capability: "text_generation", userId: "u1", reason: "test" });
    expect(mock.generate).toHaveBeenCalledTimes(1);

    // Second call would exceed the hourly budget — must fail safely.
    await expect(
      gateway.generate({ prompt: "two", capability: "text_generation", userId: "u1", reason: "test" })
    ).rejects.toBeInstanceOf(CostLimitExceededError);
    expect(mock.generate).toHaveBeenCalledTimes(1);
  });

  it("records userId and reason on every cost entry", async () => {
    const mock = makeMockProvider("gemini");
    const gateway = getProductionGateway({ enforceCostLimit: false });
    gateway.registerProvider(mock);

    await gateway.generate({
      prompt: "hello",
      capability: "memory_consolidation",
      userId: "user42",
      reason: "memory_extraction",
    });

    const log = gateway.getCostLog();
    const last = log[log.length - 1];
    expect(last.userId).toBe("user42");
    expect(last.reason).toBe("memory_extraction");
    expect(last.capability).toBe("memory_consolidation");
    expect(last.provider).toBe("gemini");
  });

  it("records failed calls with attribution too", async () => {
    const fail = (): never => {
      throw new Error("provider down");
    };
    const gateway = getProductionGateway({ enforceCostLimit: false });
    gateway.registerProvider(makeMockProvider("gemini", { generate: vi.fn(fail) } as Partial<ModelProvider>));
    gateway.registerProvider(makeMockProvider("nvidia", { generate: vi.fn(fail) } as Partial<ModelProvider>));

    await expect(
      gateway.generate({ prompt: "x", capability: "reflection", userId: "u9", reason: "unit-test" })
    ).rejects.toThrow("provider down");

    const log = gateway.getCostLog();
    const last = log[log.length - 1];
    expect(last.success).toBe(false);
    expect(last.userId).toBe("u9");
    expect(last.reason).toBe("unit-test");
  });
});
