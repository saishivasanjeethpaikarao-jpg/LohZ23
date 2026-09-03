import {
  ModelProvider,
  ProviderName,
  ModelCapability,
  GenerateRequest,
  GenerateResult,
  CostEntry,
  GatewayConfig,
  DEFAULT_GATEWAY_CONFIG,
  CostLimitExceededError,
} from "./types";
import { GeminiAdapter } from "./geminiAdapter";
import { NvidiaAdapter } from "./nvidiaAdapter";

export class ModelGateway {
  private providers: Map<ProviderName, ModelProvider> = new Map();
  private config: GatewayConfig;
  private costLog: CostEntry[] = [];
  private outcomeListeners = new Set<(entry: Readonly<CostEntry>) => void>();

  constructor(config?: Partial<GatewayConfig>) {
    this.config = {
      ...DEFAULT_GATEWAY_CONFIG,
      ...config,
      routing: { ...DEFAULT_GATEWAY_CONFIG.routing, ...(config?.routing ?? {}) },
    };
    this.providers.set("gemini", new GeminiAdapter());
    this.providers.set("nvidia", new NvidiaAdapter());
  }

  getProvider(name: ProviderName): ModelProvider | undefined {
    return this.providers.get(name);
  }

  registerProvider(provider: ModelProvider): void {
    this.providers.set(provider.name, provider);
  }

  getConfig(): GatewayConfig {
    return { ...this.config };
  }

  getCostLog(): readonly CostEntry[] {
    return this.costLog;
  }

  /** Passive observation seam; it never initiates a provider call. */
  onOutcome(listener: (entry: Readonly<CostEntry>) => void): () => void {
    this.outcomeListeners.add(listener);
    return () => this.outcomeListeners.delete(listener);
  }

  getCostSummary(): {
    totalCalls: number;
    totalTokens: number;
    byProvider: Record<string, { calls: number; tokens: number }>;
    byCapability: Record<string, { calls: number; tokens: number }>;
  } {
    const byProvider: Record<string, { calls: number; tokens: number }> = {};
    const byCapability: Record<string, { calls: number; tokens: number }> = {};
    let totalTokens = 0;

    for (const entry of this.costLog) {
      const tokens = entry.promptTokens + entry.completionTokens;
      totalTokens += tokens;

      if (!byProvider[entry.provider]) {
        byProvider[entry.provider] = { calls: 0, tokens: 0 };
      }
      byProvider[entry.provider].calls++;
      byProvider[entry.provider].tokens += tokens;

      if (!byCapability[entry.capability]) {
        byCapability[entry.capability] = { calls: 0, tokens: 0 };
      }
      byCapability[entry.capability].calls++;
      byCapability[entry.capability].tokens += tokens;
    }

    return {
      totalCalls: this.costLog.length,
      totalTokens,
      byProvider,
      byCapability,
    };
  }

  private resolveProvider(
    capability: ModelCapability
  ): { provider: ModelProvider; fallbackUsed: boolean } | null {
    const rule = this.config.routing[capability];

    if (rule) {
      const primary = this.providers.get(rule.primary);
      if (primary && primary.capabilities.includes(capability)) {
        return { provider: primary, fallbackUsed: false };
      }

      if (rule.fallback) {
        const fallback = this.providers.get(rule.fallback);
        if (fallback && fallback.capabilities.includes(capability)) {
          return { provider: fallback, fallbackUsed: true };
        }
      }
    }

    for (const [, provider] of this.providers) {
      if (provider.capabilities.includes(capability)) {
        return { provider, fallbackUsed: false };
      }
    }

    return null;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    if (!request || typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.length > 100_000) {
      throw new Error("ModelGateway: prompt must be a non-empty bounded string");
    }
    if (this.config.enforceCostLimit && this.config.costLimitPerHour) {
      const { tokensLastHour } = this.tokensLastHour();
      if (tokensLastHour >= this.config.costLimitPerHour) {
        throw new CostLimitExceededError(tokensLastHour, this.config.costLimitPerHour);
      }
    }

    const resolved = this.resolveProvider(request.capability);
    if (!resolved) {
      throw new Error(
        `No provider available for capability "${request.capability}"`
      );
    }

    const { provider, fallbackUsed } = resolved;
    const start = Date.now();

    try {
      const result = await this.callProvider(provider, request);
      if (!result.text?.trim()) throw new Error(`${provider.name} returned an empty response`);
      this.recordCost({
        provider: result.provider,
        capability: result.capability,
        model: result.model,
        promptTokens: result.usage?.promptTokens || 0,
        completionTokens: result.usage?.completionTokens || 0,
        latencyMs: result.latencyMs,
        timestamp: Date.now(),
        success: true,
        fallbackUsed,
        userId: request.userId,
        reason: request.reason,
      });
      return result;
    } catch (error) {
      this.recordCost({
        provider: provider.name,
        capability: request.capability,
        model: "unknown",
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: Date.now() - start,
        timestamp: Date.now(),
        success: false,
        fallbackUsed,
        userId: request.userId,
        reason: request.reason,
      });

      if (!fallbackUsed) {
        const rule = this.config.routing[request.capability];
        if (rule?.fallback) {
          const fallbackProvider = this.providers.get(rule.fallback);
          if (
            fallbackProvider &&
            fallbackProvider.capabilities.includes(request.capability)
          ) {
            const fallbackStart = Date.now();
            try {
              const fallbackResult = await this.callProvider(fallbackProvider, request);
              if (!fallbackResult.text?.trim()) throw new Error(`${fallbackProvider.name} returned an empty response`);
              this.recordCost({
                provider: fallbackResult.provider,
                capability: fallbackResult.capability,
                model: fallbackResult.model,
                promptTokens: fallbackResult.usage?.promptTokens || 0,
                completionTokens: fallbackResult.usage?.completionTokens || 0,
                latencyMs: fallbackResult.latencyMs,
                timestamp: Date.now(), success: true, fallbackUsed: true,
                userId: request.userId, reason: request.reason,
              });
              return fallbackResult;
            } catch (fallbackError) {
              this.recordCost({
                provider: fallbackProvider.name, capability: request.capability,
                model: "unknown", promptTokens: 0, completionTokens: 0,
                latencyMs: Date.now() - fallbackStart, timestamp: Date.now(),
                success: false, fallbackUsed: true, userId: request.userId, reason: request.reason,
              });
              throw fallbackError;
            }
          }
        }
      }

      throw error;
    }
  }

  private async callProvider(provider: ModelProvider, request: GenerateRequest): Promise<GenerateResult> {
    const timeoutMs = Math.max(100, Math.min(this.config.requestTimeoutMs, 120_000));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${provider.name} request timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([provider.generate(request), timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  async healthCheckAll(userId?: string): Promise<
    Record<ProviderName, { healthy: boolean; latencyMs: number; error?: string }>
  > {
    const results: Record<
      string,
      { healthy: boolean; latencyMs: number; error?: string }
    > = {};

    for (const [name, provider] of this.providers) {
      results[name] = await provider.healthCheck(userId);
    }

    return results;
  }

  private recordCost(entry: CostEntry): void {
    this.costLog.push(entry);
    if (this.costLog.length > this.config.maxCostLogEntries) {
      this.costLog.splice(0, this.costLog.length - this.config.maxCostLogEntries);
    }
    for (const listener of this.outcomeListeners) {
      try { listener(Object.freeze({ ...entry })); } catch { /* diagnostics never affect model truth */ }
    }

    if (this.config.costLimitPerHour && !this.config.enforceCostLimit) {
      const { tokensLastHour } = this.tokensLastHour();
      if (tokensLastHour >= this.config.costLimitPerHour) {
        console.warn(
          `[ModelGateway] Cost limit exceeded: ${tokensLastHour} tokens in last hour (limit ${this.config.costLimitPerHour})`
        );
      }
    }
  }

  private tokensLastHour(): { tokensLastHour: number } {
    const oneHourAgo = Date.now() - 3600000;
    const tokensLastHour = this.costLog
      .filter((e) => e.timestamp > oneHourAgo)
      .reduce((sum, e) => sum + e.promptTokens + e.completionTokens, 0);
    return { tokensLastHour };
  }
}
