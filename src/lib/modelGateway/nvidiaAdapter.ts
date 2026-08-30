import { credentialStore } from "../../credentialStore";
import {
  ModelProvider,
  ProviderName,
  ModelCapability,
  GenerateRequest,
  GenerateResult,
  ProviderHealth,
} from "./types";

const SUPPORTED: ModelCapability[] = [
  "text_generation",
  "reasoning",
  "reflection",
  "planning",
];

const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1";

export class NvidiaAdapter implements ModelProvider {
  name: ProviderName = "nvidia";
  capabilities: ModelCapability[] = [...SUPPORTED];

  private model = "meta/llama-3.1-8b-instruct";

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    if (!this.capabilities.includes(request.capability)) {
      return {
        text: "",
        provider: "nvidia",
        model: this.model,
        capability: request.capability,
        latencyMs: 0,
      };
    }

    const apiKey = await credentialStore.getCredential("nvidia");
    if (!apiKey) {
      throw new Error("NVIDIA API key not configured");
    }

    const messages: Array<{ role: string; content: string }> = [];
    if (request.systemInstruction) {
      messages.push({ role: "system", content: request.systemInstruction });
    }
    messages.push({ role: "user", content: request.prompt });

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: request.maxTokens || 1024,
      temperature: request.temperature ?? 0.7,
    };

    if (request.responseFormat === "json") {
      body.response_format = { type: "json_object" };
    }

    const start = Date.now();
    const res = await fetch(`${NVIDIA_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`NVIDIA NIM error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const latencyMs = Date.now() - start;
    const text = data.choices?.[0]?.message?.content?.trim() || "";
    const usage = data.usage
      ? {
          promptTokens: data.usage.prompt_tokens || 0,
          completionTokens: data.usage.completion_tokens || 0,
          totalTokens: data.usage.total_tokens || 0,
        }
      : undefined;

    return {
      text,
      provider: "nvidia",
      model: this.model,
      capability: request.capability,
      usage,
      latencyMs,
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const apiKey = await credentialStore.getCredential("nvidia");
    if (!apiKey) {
      return { healthy: false, latencyMs: 0, error: "API key not configured" };
    }

    const start = Date.now();
    try {
      const res = await fetch(`${NVIDIA_BASE}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) {
        return { healthy: false, latencyMs: Date.now() - start, error: `HTTP ${res.status}` };
      }
      return { healthy: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { healthy: false, latencyMs: Date.now() - start, error: e.message };
    }
  }
}
