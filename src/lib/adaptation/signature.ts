import type { RoutingResult } from "../router/types";

const STOP = new Set(["the", "and", "for", "with", "this", "that", "from", "into", "please", "lohz"]);

export function adaptiveTaskType(intent: string, input: string): string {
  const tokens = input.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !STOP.has(token)).slice(0, 5);
  return `intent:${String(intent).toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 40)}:${tokens.join("-")}`.slice(0, 240);
}

export function approachForRouting(result: Pick<RoutingResult, "tier" | "needsClarification">): import("./types").RoutingApproach {
  if (result.needsClarification) return "clarification";
  if (result.tier === "tier0_direct") return "deterministic";
  if (result.tier === "tier2_reasoning") return "model_reasoning";
  if (result.tier === "tier3_autonomous") return "planner";
  return "deterministic";
}

export function safeAdaptiveTaskType(value: string): boolean {
  return /^(?:intent|workflow):[a-z0-9._:>|-]{1,230}$/.test(value) && !/(ignore|instruction|prompt|auth|credential|password|token|permission|policy|execute|command)/i.test(value);
}

