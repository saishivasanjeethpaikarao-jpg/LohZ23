/**
 * Phase 42 — deterministic gap detection from a finished route outcome.
 * Pure function: given what just happened, produce zero or one bounded
 * gap seed. NO model calls. No dedupe/persistence here (service owns it).
 */
import type { GapSourceKind, InfoSourceKind, KnowledgeGap } from "./types";

export interface GapDetectionInput {
  intent: string;
  confidence: number;
  success: boolean;
  /** From RouteOutcome.verificationStatus when present. */
  verificationStatus?: "VERIFIED" | "FAILED" | "INCONCLUSIVE" | "UNVERIFIED" | "NOT_APPLICABLE";
  /** Router lifecycle contained an ASK (clarification loop). */
  askedClarification?: boolean;
  /** Text the user sent (bounded read for explicit-unknown phrases). */
  inputText?: string;
  /** World-model said a referenced assertion is stale. */
  staleReference?: string | null;
}

export interface GapSeed {
  question: string;
  missingInformation: string;
  importance: number;
  uncertainty: number;
  possibleSources: InfoSourceKind[];
  source: GapSourceKind;
}

function clip(text: unknown, max: number): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

const EXPLICIT_UNKNOWN = /\b(i (don'?t|do not) know|not sure|no idea|can'?t remember|don'?t recall)\b/i;

export function detectGap(input: GapDetectionInput): GapSeed | null {
  // Explicit user-side ignorance — LOHZ may help by finding the fact.
  if (input.inputText && EXPLICIT_UNKNOWN.test(input.inputText)) {
    const topic = clip(input.inputText, 90);
    return {
      question: `The user is unsure about: "${topic}". What fact would resolve it?`,
      missingInformation: `answer to '${topic}'`,
      importance: 0.55,
      uncertainty: 0.85,
      possibleSources: ["use_memory", "inspect_state", "safe_probe", "ask_user"],
      source: "explicit_unknown",
    };
  }

  // Referenced world fact is stale.
  if (input.staleReference) {
    return {
      question: `Is it still true that: ${clip(input.staleReference, 120)}?`,
      missingInformation: `current value of '${clip(input.staleReference, 120)}'`,
      importance: 0.5,
      uncertainty: 0.7,
      possibleSources: ["inspect_state", "safe_probe"],
      source: "stale_knowledge",
    };
  }

  // Ran a tool but could not confirm its effect.
  if (input.verificationStatus === "FAILED" || input.verificationStatus === "INCONCLUSIVE") {
    return {
      question: `Did the last action on '${clip(input.intent, 60)}' actually succeed?`,
      missingInformation: `verified outcome of ${clip(input.intent, 80)}`,
      importance: 0.75,
      uncertainty: 0.9,
      possibleSources: ["safe_probe", "ask_user"],
      source: "unverified_outcome",
    };
  }

  // Router needed clarification / intent confidence too low to act safely.
  if (input.askedClarification || input.confidence < 0.6) {
    const topic = clip(input.inputText ?? input.intent, 100);
    return {
      question: `What did the user actually mean by "${topic}"?`,
      // The topic is part of the identity so unrelated ambiguous requests do
      // not collapse into one permanent generic gap.
      missingInformation: `user intent disambiguation for '${topic}'`,
      importance: 0.65,
      uncertainty: 0.8,
      possibleSources: ["ask_user"],
      source: "low_confidence_intent",
    };
  }

  return null;
}

/** Deterministic gap id from (uid, missingInformation). */
export function gapIdFor(uid: string, missingInformation: string): string {
  const key = `${uid}|${missingInformation.toLowerCase().replace(/\s+/g, " ").trim()}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return `gap_${(h >>> 0).toString(36)}`;
}

export type { GapSeed as Seed, KnowledgeGap };
