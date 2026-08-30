/**
 * Phase 24 — Bridge from the Phase 23 memory-intelligence pipeline to
 * the UserModelEngine. Maps DecidedActions + persisted memories into
 * bounded ModelOutcomes. Pure functions — no I/O, no model calls.
 */
import type { Memory } from "../memoryTypes";
import type { DecidedAction } from "../memoryIntelligence/types";
import type { ModelOutcome } from "./engine";

export interface ProcessResultLike {
  actions: DecidedAction[];
  persistenceVerified: boolean;
}

/**
 * Derive ModelOutcomes from a MemoryIntelligenceService.process() result.
 *
 * Evidence references: after the pipeline saves, the caller passes the
 * post-save memory list; outcomes link to the matching memory's id so
 * the user model stores references, not content.
 */
export function outcomesFromProcessResult(
  result: ProcessResultLike,
  memoriesAfter?: Memory[]
): ModelOutcome[] {
  const outcomes: ModelOutcome[] = [];

  const findMemoryId = (candidateText: string): string | undefined => {
    if (!memoriesAfter) return undefined;
    const needle = candidateText.toLowerCase().slice(0, 24);
    const hit = memoriesAfter.find((m) => m.text.toLowerCase().includes(needle));
    return hit?.id;
  };

  for (const action of result.actions) {
    // Only evidence that actually entered (or reinforced) durable memory
    // may drive the derived model — IGNOREd chatter must not.
    if (action.action === "IGNORE") continue;

    const c = action.candidate;
    const memoryId = findMemoryId(c.text);
    const source =
      c.confidenceSource === "explicit" ? ("explicit" as const) : ("derived" as const);

    switch (c.kind) {
      case "preference":
        outcomes.push({
          kind: "preference",
          text: c.text,
          memoryId,
          confidence: c.confidence,
          source,
          isCorrection: /actually|instead of|not anymore|\bdon't\b/i.test(c.evidence[0] ?? ""),
        });
        break;
      case "fact":
        outcomes.push({ kind: "identity", text: c.text, memoryId, confidence: c.confidence, source });
        break;
      case "goal":
        outcomes.push({ kind: "project", text: c.text, memoryId, confidence: c.confidence, source });
        break;
      case "behavior":
      case "learning":
      case "procedure":
        outcomes.push({ kind: "interest", text: c.text, memoryId });
        break;
      case "event":
        outcomes.push({ kind: "world_event", text: c.text, memoryId });
        break;
      case "correction":
        // Corrections target preferences/identity depending on category.
        outcomes.push({
          kind: c.category === "preference" ? "preference" : "identity",
          text: c.text,
          memoryId,
          confidence: c.confidence,
          source,
          isCorrection: true,
        });
        break;
    }
  }

  return outcomes;
}
