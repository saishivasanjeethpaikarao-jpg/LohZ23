import { GeminiAdapter } from "../src/lib/modelGateway/geminiAdapter";
import { NvidiaAdapter } from "../src/lib/modelGateway/nvidiaAdapter";
import { ModelGateway } from "../src/lib/modelGateway/gateway";
import type { ModelProvider } from "../src/lib/modelGateway/types";

const prompt = "Reply with only LOHZ_OK.";
const request = {
  prompt,
  capability: "text_generation" as const,
  maxTokens: 64,
  temperature: 0,
  userId: "live-provider-readiness",
  reason: "pre-phase-34-live-e2e",
};

const gemini = new GeminiAdapter();
const nvidia = new NvidiaAdapter();
const [geminiHealth, nvidiaHealth] = await Promise.all([gemini.healthCheck(), nvidia.healthCheck()]);
const geminiResult = await gemini.generate(request);
const nvidiaResult = await nvidia.generate(request);

const failingPrimary: ModelProvider = {
  name: "gemini",
  capabilities: ["text_generation"],
  async generate() { throw new Error("intentional primary failure for live fallback check"); },
  async healthCheck() { return { healthy: false, latencyMs: 0 }; },
};
const gateway = new ModelGateway({
  routing: { text_generation: { primary: "gemini", fallback: "nvidia" } },
  requestTimeoutMs: 30_000,
  costLimitPerHour: 1_000,
  enforceCostLimit: true,
});
gateway.registerProvider(failingPrimary);
gateway.registerProvider(nvidia);
const fallbackResult = await gateway.generate(request);
const cost = gateway.getCostSummary();

const result = {
  passed: geminiHealth.healthy && nvidiaHealth.healthy
    && Boolean(geminiResult.text.trim()) && Boolean(nvidiaResult.text.trim())
    && fallbackResult.provider === "nvidia" && cost.totalCalls === 2,
  health: {
    gemini: { healthy: geminiHealth.healthy, latencyMs: geminiHealth.latencyMs },
    nvidia: { healthy: nvidiaHealth.healthy, latencyMs: nvidiaHealth.latencyMs },
  },
  generation: {
    gemini: { model: geminiResult.model, nonempty: Boolean(geminiResult.text.trim()), usage: geminiResult.usage, latencyMs: geminiResult.latencyMs },
    nvidia: { model: nvidiaResult.model, nonempty: Boolean(nvidiaResult.text.trim()), usage: nvidiaResult.usage, latencyMs: nvidiaResult.latencyMs },
  },
  fallback: { provider: fallbackResult.provider, nonempty: Boolean(fallbackResult.text.trim()), costEntries: cost.totalCalls },
};
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
