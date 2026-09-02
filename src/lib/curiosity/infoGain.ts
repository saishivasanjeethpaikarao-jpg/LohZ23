/**
 * Phase 42 — information-gain ranking.
 *
 * For a given knowledge gap, score each possible source and return them
 * in deterministic order. Pure: no IO, no model calls.
 *
 * score = expectedGain × safetyFactor − λ·cost
 *
 * - expectedGain  : how much uncertainty the source would remove (0..1).
 * - safetyFactor  : 0 for sources forbidden by policy (e.g. trusted_query
 *                   is disabled by default → never surfaces).
 * - cost          : user friction / resource use.
 * - Free-info rule: asking the user is heavily discounted when a free
 *   source (memory or world state) has the answer — never pester the
 *   user for what LOHZ can look up itself.
 *
 * The caller still gates on a minimum score; below it the recommendation
 * is "withhold" (action avoidance when information is insufficient).
 */
import { CURIOSITY_LIMITS, type GapSourceKind, type InfoSourceKind, type KnowledgeGap } from "./types";

export interface SourceContext {
  /** True when durable memory plausibly contains the answer. */
  memoryHasAnswer: boolean;
  /** True when the world model has a current assertion for the subject. */
  worldHasAnswer: boolean;
  /** True when probing would be LOW risk on the current registry. */
  probeWouldBeSafe: boolean;
  /** True when inspect_file (MEDIUM risk) is allowed (normally requires confirmation). */
  fileReadPermitted: boolean;
  /** trusted_query feature flag (default OFF). */
  trustedQueryEnabled: boolean;
  /** A no-questions window is NOT currently active. */
  questionsUnmuted: boolean;
}

export interface RankedSource {
  source: InfoSourceKind | "withhold";
  expectedGain: number;
  cost: number;
  score: number;
  safetyFactor: number;
  rationale: string[];
}

const BASE_GAIN: Record<InfoSourceKind, number> = {
  ask_user: 0.85,
  use_memory: 0.6,
  inspect_state: 0.55,
  safe_probe: 0.8,
  inspect_file: 0.55,
  trusted_query: 0.45,
};

const COST: Record<InfoSourceKind, number> = {
  ask_user: 0.45,
  use_memory: 0.02,
  inspect_state: 0.03,
  safe_probe: 0.1,
  inspect_file: 0.3,
  trusted_query: 0.4,
};

const LAMBDA = 0.6;

/** Gap kinds where a probe genuinely helps (environment-state questions). */
const PROBE_RELEVANT: ReadonlySet<GapSourceKind> = new Set([
  "missing_context", "unverified_outcome", "stale_knowledge", "explicit_unknown",
]);
const STATE_RELEVANT: ReadonlySet<GapSourceKind> = new Set([
  "missing_context", "missing_entity", "stale_knowledge", "unverified_outcome",
]);

export function rankGapActions(gap: Pick<KnowledgeGap, "possibleSources" | "source" | "importance">, ctx: SourceContext): RankedSource[] {
  const ranked: RankedSource[] = [];
  for (const source of gap.possibleSources) {
    let safetyFactor = 1;
    const rationale: string[] = [];
    let gain = BASE_GAIN[source];
    const cost = COST[source];

    if (source === "trusted_query" && !ctx.trustedQueryEnabled) {
      safetyFactor = 0;
      rationale.push("trusted_query disabled");
    }
    if (source === "inspect_file" && !ctx.fileReadPermitted) {
      safetyFactor = 0;
      rationale.push("file read requires confirmation");
    }
    if (source === "safe_probe") {
      if (!ctx.probeWouldBeSafe) { safetyFactor = 0; rationale.push("probe not LOW risk"); }
      if (!PROBE_RELEVANT.has(gap.source)) { gain *= 0.3; rationale.push("probe irrelevant to this gap kind"); }
    }
    if (source === "inspect_state") {
      if (ctx.worldHasAnswer) {
        // Reading an already-current assertion is cheaper and more direct
        // than probing the environment again.
        gain = Math.max(gain, 0.9);
        rationale.push("current world assertion available");
      } else {
        gain *= 0.15;
        rationale.push("no current world assertion");
      }
      if (!STATE_RELEVANT.has(gap.source)) { gain *= 0.4; rationale.push("state query marginal here"); }
    }
    if (source === "use_memory" && !ctx.memoryHasAnswer) {
      gain *= 0.15;
      rationale.push("no plausible memory");
    }
    if (source === "ask_user") {
      if (!ctx.questionsUnmuted) { safetyFactor = 0; rationale.push("ask cooldown active"); }
      if (ctx.memoryHasAnswer || ctx.worldHasAnswer) {
        gain *= 0.25;
        rationale.push("free source available first");
      }
      if (gap.importance >= 0.8 && (ctx.memoryHasAnswer || ctx.worldHasAnswer)) {
        gain *= 0.5;
        rationale.push("high-stakes gap wants corroboration before asking");
      }
    }

    const expectedGain = clamp01(gain);
    const score = expectedGain * safetyFactor - LAMBDA * cost;
    ranked.push({ source, expectedGain, cost, score, safetyFactor, rationale });
  }
  ranked.sort((a, b) => b.score - a.score || a.source.localeCompare(b.source));

  const best = ranked[0];
  if (!best || best.score < CURIOSITY_LIMITS.recommendationThreshold) {
    ranked.unshift({
      source: "withhold",
      expectedGain: 0,
      cost: 0,
      score: 0,
      safetyFactor: 1,
      rationale: ["no source clears the recommendation threshold — do not act"],
    });
    return ranked;
  }
  return ranked;
}

export function bestSource(gap: Pick<KnowledgeGap, "possibleSources" | "source" | "importance">, ctx: SourceContext): InfoSourceKind | "withhold" {
  return rankGapActions(gap, ctx)[0].source;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
