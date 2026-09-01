import { describe, it, expect, beforeEach, vi } from "vitest";
import { ModelGateway } from "./gateway";
import { GeminiAdapter } from "./geminiAdapter";
import { NvidiaAdapter } from "./nvidiaAdapter";
import { DEFAULT_GATEWAY_CONFIG, GenerateRequest, ModelCapability } from "./types";

vi.mock("../../credentialStore", () => ({
  credentialStore: {
    getCredential: vi.fn().mockResolvedValue("test-api-key"),
    hasCredential: vi.fn().mockResolvedValue(true),
  },
}));

function makeRequest(
  capability: ModelCapability,
  opts?: { prompt?: string; responseFormat?: "text" | "json" }
): GenerateRequest {
  return {
    prompt: opts?.prompt || "Test prompt",
    capability,
    responseFormat: opts?.responseFormat,
  };
}

describe("ModelGateway", () => {
  let gateway: ModelGateway;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new ModelGateway();
  });

  describe("provider registration", () => {
    it("should have gemini and nvidia registered by default", () => {
      expect(gateway.getProvider("gemini")).toBeInstanceOf(GeminiAdapter);
      expect(gateway.getProvider("nvidia")).toBeInstanceOf(NvidiaAdapter);
    });

    it("should return undefined for unregistered provider", () => {
      expect(gateway.getProvider("openai")).toBeUndefined();
    });

    it("should register a custom provider", () => {
      const mock = {
        name: "openai" as const,
        capabilities: ["text_generation" as const],
        generate: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 10 }),
      };
      gateway.registerProvider(mock);
      expect(gateway.getProvider("openai")).toBe(mock);
    });
  });

  describe("capability routing", () => {
    it("should route text_generation to gemini by default", async () => {
      const gemini = gateway.getProvider("gemini")!;
      vi.spyOn(gemini, "generate").mockResolvedValue({
        text: "hello",
        provider: "gemini",
        model: "gemini-3.5-flash",
        capability: "text_generation",
        latencyMs: 100,
      });

      const result = await gateway.generate(makeRequest("text_generation"));
      expect(result.provider).toBe("gemini");
      expect(gemini.generate).toHaveBeenCalled();
    });

    it("should route reasoning to nvidia by default", async () => {
      const nvidia = gateway.getProvider("nvidia")!;
      vi.spyOn(nvidia, "generate").mockResolvedValue({
        text: "reasoning result",
        provider: "nvidia",
        model: "meta/llama-3.1-8b-instruct",
        capability: "reasoning",
        latencyMs: 150,
      });

      const result = await gateway.generate(makeRequest("reasoning"));
      expect(result.provider).toBe("nvidia");
    });

    it("should route memory_consolidation to gemini by default", async () => {
      const gemini = gateway.getProvider("gemini")!;
      vi.spyOn(gemini, "generate").mockResolvedValue({
        text: '{"transactions":[]}',
        provider: "gemini",
        model: "gemini-3.5-flash",
        capability: "memory_consolidation",
        latencyMs: 200,
      });

      const result = await gateway.generate(
        makeRequest("memory_consolidation", { responseFormat: "json" })
      );
      expect(result.provider).toBe("gemini");
    });

    it("should route vision to gemini by default", async () => {
      const gemini = gateway.getProvider("gemini")!;
      vi.spyOn(gemini, "generate").mockResolvedValue({
        text: "I see a cat",
        provider: "gemini",
        model: "gemini-3.5-flash",
        capability: "vision",
        latencyMs: 300,
      });

      const result = await gateway.generate(makeRequest("vision"));
      expect(result.provider).toBe("gemini");
    });
  });

  describe("fallback", () => {
    it("should fallback to nvidia when gemini fails for text_generation", async () => {
      const gemini = gateway.getProvider("gemini")!;
      const nvidia = gateway.getProvider("nvidia")!;
      vi.spyOn(gemini, "generate").mockRejectedValue(new Error("Gemini down"));
      vi.spyOn(nvidia, "generate").mockResolvedValue({
        text: "fallback result",
        provider: "nvidia",
        model: "meta/llama-3.1-8b-instruct",
        capability: "text_generation",
        latencyMs: 100,
      });

      const result = await gateway.generate(makeRequest("text_generation"));
      expect(result.provider).toBe("nvidia");
      expect(result.text).toBe("fallback result");
    });

    it("should fallback to gemini when nvidia fails for reasoning", async () => {
      const gemini = gateway.getProvider("gemini")!;
      const nvidia = gateway.getProvider("nvidia")!;
      vi.spyOn(nvidia, "generate").mockRejectedValue(new Error("NVIDIA down"));
      vi.spyOn(gemini, "generate").mockResolvedValue({
        text: "gemini reasoning",
        provider: "gemini",
        model: "gemini-3.5-flash",
        capability: "reasoning",
        latencyMs: 100,
      });

      const result = await gateway.generate(makeRequest("reasoning"));
      expect(result.provider).toBe("gemini");
    });

    it("should throw when no provider available", async () => {
      const gemini = gateway.getProvider("gemini")!;
      vi.spyOn(gemini, "generate").mockRejectedValue(new Error("fail"));

      await expect(
        gateway.generate(makeRequest("audio"))
      ).rejects.toThrow("No provider available");
    });

    it("should throw when primary fails and no fallback configured", async () => {
      const customGateway = new ModelGateway({
        routing: {
          text_generation: { primary: "gemini" },
        },
      });
      const gemini = customGateway.getProvider("gemini")!;
      vi.spyOn(gemini, "generate").mockRejectedValue(new Error("fail"));

      await expect(
        customGateway.generate(makeRequest("text_generation"))
      ).rejects.toThrow("fail");
    });
  });

  describe("cost tracking", () => {
    it("should record successful calls", async () => {
      const gemini = gateway.getProvider("gemini")!;
      vi.spyOn(gemini, "generate").mockResolvedValue({
        text: "result",
        provider: "gemini",
        model: "gemini-3.5-flash",
        capability: "text_generation",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        latencyMs: 100,
      });

      await gateway.generate(makeRequest("text_generation"));
      const log = gateway.getCostLog();
      expect(log).toHaveLength(1);
      expect(log[0].success).toBe(true);
      expect(log[0].promptTokens).toBe(10);
      expect(log[0].completionTokens).toBe(20);
      expect(log[0].fallbackUsed).toBe(false);
    });

    it("should record failed calls", async () => {
      const gemini = gateway.getProvider("gemini")!;
      vi.spyOn(gemini, "generate").mockRejectedValue(new Error("fail"));

      try {
        await gateway.generate(makeRequest("text_generation"));
      } catch {
        // expected
      }
      const log = gateway.getCostLog();
      expect(log).toHaveLength(2); // primary and fallback failures are both attributable
      expect(log[0].success).toBe(false);
      expect(log[1]).toMatchObject({ success: false, fallbackUsed: true });
    });

    it("should record fallback usage", async () => {
      const gemini = gateway.getProvider("gemini")!;
      const nvidia = gateway.getProvider("nvidia")!;
      vi.spyOn(gemini, "generate").mockRejectedValue(new Error("fail"));
      vi.spyOn(nvidia, "generate").mockResolvedValue({
        text: "fallback",
        provider: "nvidia",
        model: "meta/llama-3.1-8b-instruct",
        capability: "text_generation",
        usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
        latencyMs: 50,
      });

      await gateway.generate(makeRequest("text_generation"));
      const log = gateway.getCostLog();
      expect(log).toHaveLength(2);
      expect(log[0].success).toBe(false);
      expect(log[0].fallbackUsed).toBe(false);
      expect(log[1].success).toBe(true);
      expect(log[1].fallbackUsed).toBe(true);
    });

    it("should compute cost summary", async () => {
      const gemini = gateway.getProvider("gemini")!;
      vi.spyOn(gemini, "generate").mockResolvedValue({
        text: "result",
        provider: "gemini",
        model: "gemini-3.5-flash",
        capability: "text_generation",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        latencyMs: 100,
      });

      await gateway.generate(makeRequest("text_generation"));
      await gateway.generate(makeRequest("text_generation"));
      const summary = gateway.getCostSummary();
      expect(summary.totalCalls).toBe(2);
      expect(summary.totalTokens).toBe(60);
      expect(summary.byProvider.gemini.calls).toBe(2);
      expect(summary.byCapability.text_generation.calls).toBe(2);
    });

    it("passively emits real provider outcomes without initiating another call", async () => {
      const gemini = gateway.getProvider("gemini")!;
      vi.spyOn(gemini, "generate").mockResolvedValue({
        text: "result", provider: "gemini", model: "gemini-3.5-flash",
        capability: "text_generation", latencyMs: 7,
      });
      const observed: Array<{ success: boolean; userId?: string }> = [];
      const unsubscribe = gateway.onOutcome((entry) => observed.push({ success: entry.success, userId: entry.userId }));
      await gateway.generate({ ...makeRequest("text_generation"), userId: "u1" });
      unsubscribe();
      expect(observed).toEqual([{ success: true, userId: "u1" }]);
      expect(gemini.generate).toHaveBeenCalledTimes(1);
    });
  });

  describe("health check", () => {
    it("should check all providers", async () => {
      const results = await gateway.healthCheckAll();
      expect(results).toHaveProperty("gemini");
      expect(results).toHaveProperty("nvidia");
    });
  });

  describe("custom routing", () => {
    it("should respect custom routing config", async () => {
      const customGateway = new ModelGateway({
        routing: {
          reasoning: { primary: "gemini", fallback: "nvidia" },
        },
      });

      const gemini = customGateway.getProvider("gemini")!;
      vi.spyOn(gemini, "generate").mockResolvedValue({
        text: "gemini reasoning",
        provider: "gemini",
        model: "gemini-3.5-flash",
        capability: "reasoning",
        latencyMs: 100,
      });

      const result = await customGateway.generate(makeRequest("reasoning"));
      expect(result.provider).toBe("gemini");
    });
  });

  describe("unsupported capability", () => {
    it("should reject direct unsupported provider capability calls", async () => {
      const nvidia = gateway.getProvider("nvidia")!;
      await expect(nvidia.generate(makeRequest("audio"))).rejects.toThrow("does not support");
    });
  });

  it("preserves default routes when only one routing rule is overridden", () => {
    const custom = new ModelGateway({ routing: { reasoning: { primary: "gemini" } } });
    expect(custom.getConfig().routing.text_generation).toEqual(DEFAULT_GATEWAY_CONFIG.routing.text_generation);
  });

  it("records both failures when primary and fallback fail", async () => {
    const gemini = gateway.getProvider("gemini")!;
    const nvidia = gateway.getProvider("nvidia")!;
    vi.spyOn(gemini, "generate").mockRejectedValue(new Error("primary down"));
    vi.spyOn(nvidia, "generate").mockRejectedValue(new Error("fallback down"));
    await expect(gateway.generate(makeRequest("text_generation"))).rejects.toThrow("fallback down");
    expect(gateway.getCostLog().map((entry) => [entry.success, entry.fallbackUsed])).toEqual([[false, false], [false, true]]);
  });

  it("treats empty provider output as malformed and falls back", async () => {
    const gemini = gateway.getProvider("gemini")!;
    const nvidia = gateway.getProvider("nvidia")!;
    vi.spyOn(gemini, "generate").mockResolvedValue({ text: "", provider: "gemini", model: "g", capability: "text_generation", latencyMs: 1 });
    vi.spyOn(nvidia, "generate").mockResolvedValue({ text: "valid", provider: "nvidia", model: "n", capability: "text_generation", latencyMs: 1 });
    expect((await gateway.generate(makeRequest("text_generation"))).text).toBe("valid");
  });
});
