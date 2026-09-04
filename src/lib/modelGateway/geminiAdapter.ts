import { GoogleGenAI, Type } from "@google/genai";
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
  "memory_consolidation",
  "reflection",
  "planning",
  "vision",
];

export class GeminiAdapter implements ModelProvider {
  name: ProviderName = "gemini";
  capabilities: ModelCapability[] = [...SUPPORTED];

  private modelMap: Partial<Record<ModelCapability, string>> = {
    text_generation: "gemini-3.5-flash",
    reasoning: "gemini-3.5-flash",
    memory_consolidation: "gemini-3.5-flash",
    reflection: "gemini-3.5-flash",
    planning: "gemini-3.5-flash",
    vision: "gemini-3.5-flash",
  };

  private getClient(apiKey: string): GoogleGenAI {
    return new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { "User-Agent": "lohz-gateway" } },
    });
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const apiKey = await credentialStore.getCredential("gemini", request.userId);
    if (!apiKey) {
      throw new Error("Gemini API key not configured");
    }

    const defaultModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    let model = this.modelMap[request.capability] || defaultModel;
    if (model === "gemini-3.5-flash") {
      model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    }
    const client = this.getClient(apiKey);
    const start = Date.now();

    const config: Record<string, unknown> = {};

    if (request.responseFormat === "json" && request.responseSchema) {
      config.responseMimeType = "application/json";
      config.responseSchema = request.responseSchema;
    }
    if (request.maxTokens) {
      config.maxOutputTokens = request.maxTokens;
    }
    if (request.temperature !== undefined) {
      config.temperature = request.temperature;
    }
    if (request.systemInstruction) {
      config.systemInstruction = request.systemInstruction;
    }

    let contents: any = request.prompt;
    if (request.images && request.images.length > 0) {
      contents = [
        ...request.images.map((img) => ({
          inlineData: { mimeType: img.mimeType, data: img.data },
        })),
        { text: request.prompt },
      ];
    }

    let response: any;
    try {
      response = await client.models.generateContent({
        model,
        contents,
        config,
      });
    } catch (err) {
      // Fallback model trial if specific version failed
      const fallbackModel = model.includes("2.5") ? "gemini-2.0-flash" : "gemini-1.5-flash";
      try {
        response = await client.models.generateContent({
          model: fallbackModel,
          contents,
          config,
        });
        model = fallbackModel;
      } catch {
        throw err;
      }
    }

    const latencyMs = Date.now() - start;
    const text = response.text?.trim() || "";

    const usage = response.usageMetadata
      ? {
          promptTokens: response.usageMetadata.promptTokenCount || 0,
          completionTokens: response.usageMetadata.candidatesTokenCount || 0,
          totalTokens: response.usageMetadata.totalTokenCount || 0,
        }
      : undefined;

    return {
      text,
      provider: "gemini",
      model,
      capability: request.capability,
      usage,
      latencyMs,
    };
  }

  async healthCheck(userId?: string): Promise<ProviderHealth> {
    const apiKey = await credentialStore.getCredential("gemini", userId);
    if (!apiKey) {
      return { healthy: false, latencyMs: 0, error: "API key not configured" };
    }

    const start = Date.now();
    try {
      const client = this.getClient(apiKey);
      await client.models.list({});
      return { healthy: true, latencyMs: Date.now() - start };
    } catch (e: any) {
      return { healthy: false, latencyMs: Date.now() - start, error: e.message };
    }
  }
}
