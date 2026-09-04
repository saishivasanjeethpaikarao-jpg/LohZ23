export type ModelCapability =
  | "text_generation"
  | "reasoning"
  | "memory_consolidation"
  | "reflection"
  | "planning"
  | "vision"
  | "audio";

export type ProviderName = "gemini" | "nvidia" | "groq" | "openai" | "anthropic";

export interface GenerateRequest {
  prompt: string;
  capability: ModelCapability;
  responseFormat?: "text" | "json";
  responseSchema?: object;
  maxTokens?: number;
  temperature?: number;
  systemInstruction?: string;
  /** Owning user — required for production cost attribution. */
  userId?: string;
  /** Why this call exists (e.g. "memory_extraction"). Recorded in the cost log. */
  reason?: string;
  /** Optional inline images for multimodal/vision reasoning */
  images?: Array<{ mimeType: string; data: string }>;
}

export interface GenerateResult {
  text: string;
  provider: ProviderName;
  model: string;
  capability: ModelCapability;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  latencyMs: number;
}

export interface CostEntry {
  provider: ProviderName;
  capability: ModelCapability;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  timestamp: number;
  success: boolean;
  fallbackUsed: boolean;
  userId?: string;
  reason?: string;
}

export interface ProviderHealth {
  healthy: boolean;
  latencyMs: number;
  error?: string;
}

export interface ModelProvider {
  name: ProviderName;
  capabilities: ModelCapability[];

  generate(request: GenerateRequest): Promise<GenerateResult>;
  healthCheck(userId?: string): Promise<ProviderHealth>;
}

export interface RoutingRule {
  primary: ProviderName;
  fallback?: ProviderName;
}

export interface GatewayConfig {
  routing: Partial<Record<ModelCapability, RoutingRule>>;
  maxRetries: number;
  /** Max tokens per rolling hour across all providers. */
  costLimitPerHour?: number;
  /**
   * When true, generate() throws CostLimitExceededError instead of proceeding
   * once costLimitPerHour is exceeded. Default false (warn only).
   */
  enforceCostLimit?: boolean;
  /** Max retained cost-log entries (oldest evicted). Default 1000. */
  maxCostLogEntries: number;
  /** Hard response deadline for one provider attempt. */
  requestTimeoutMs: number;
}

export class CostLimitExceededError extends Error {
  constructor(public readonly tokensLastHour: number, public readonly limit: number) {
    super(`Cost limit exceeded: ${tokensLastHour} tokens in the last hour (limit ${limit})`);
    this.name = "CostLimitExceededError";
  }
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  routing: {
    text_generation: { primary: "gemini", fallback: "nvidia" },
    reasoning: { primary: "gemini", fallback: "nvidia" },
    memory_consolidation: { primary: "gemini", fallback: "nvidia" },
    reflection: { primary: "gemini", fallback: "nvidia" },
    planning: { primary: "gemini", fallback: "nvidia" },
    vision: { primary: "gemini" },
  },
  maxRetries: 1,
  enforceCostLimit: false,
  maxCostLogEntries: 1000,
  requestTimeoutMs: 8_000,
};
