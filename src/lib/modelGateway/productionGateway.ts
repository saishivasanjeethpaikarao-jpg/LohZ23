// Production ModelGateway singleton.
//
// All non-Live server-side model calls must go through this instance so that
// cost attribution (userId + reason) and enforcement apply uniformly.
// Gemini Live voice keeps its direct transport by design.

import { ModelGateway } from "./gateway";
import { GeminiAdapter } from "./geminiAdapter";
import { NvidiaAdapter } from "./nvidiaAdapter";
import { DEFAULT_GATEWAY_CONFIG, GatewayConfig } from "./types";

let instance: ModelGateway | null = null;

export interface ProductionGatewayOptions {
  /** Hard token ceiling per rolling hour. Default 200000. */
  costLimitPerHour?: number;
  /** Set LOHZ_COST_ENFORCEMENT=0 to downgrade to warn-only. */
  enforceCostLimit?: boolean;
}

function resolveConfig(options: ProductionGatewayOptions = {}): GatewayConfig {
  const envEnforce = process.env.LOHZ_COST_ENFORCEMENT !== "0";
  const envLimit = Number(process.env.LOHZ_COST_LIMIT_TOKENS_PER_HOUR);
  return {
    ...DEFAULT_GATEWAY_CONFIG,
    enforceCostLimit: options.enforceCostLimit ?? envEnforce,
    costLimitPerHour:
      options.costLimitPerHour ??
      (Number.isFinite(envLimit) && envLimit > 0 ? envLimit : 200_000),
    maxCostLogEntries: 5000,
  };
}

export function getProductionGateway(options?: ProductionGatewayOptions): ModelGateway {
  if (!instance || options) {
    const gateway = new ModelGateway(resolveConfig(options));
    // Adapters read keys from the shared CredentialStore at call time.
    gateway.registerProvider(new GeminiAdapter());
    gateway.registerProvider(new NvidiaAdapter());
    if (options) {
      // Test/diagnostic override path returns a fresh instance.
      return gateway;
    }
    instance = gateway;
  }
  return instance;
}

export function resetProductionGateway(): void {
  instance = null;
}
