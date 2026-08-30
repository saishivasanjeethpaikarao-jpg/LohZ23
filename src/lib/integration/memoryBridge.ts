/**
 * Phase 31 - memory bridge adapter.
 *
 * Converts durable Phase 23 memories (post-consolidation) into bounded
 * UserModel outcomes. Complements outcomesFromProcessResult() by working
 * directly from the persisted memory list that processConversationSlice
 * returns, using the enrichment fields Phase 23 already stores.
 */
import type { Memory } from "../memoryTypes";
import type { ModelOutcome } from "../userModel/engine";
import { readEnrichment } from "../memoryIntelligence/enrichment";

export function outcomesFromProcessResultLite(memories: Memory[]): ModelOutcome[] {
  const out: ModelOutcome[] = [];
  for (const m of memories) {
    const kind = readEnrichment(m).kind;
    const base = {
      text: m.text,
      memoryId: m.id,
      confidence: m.metadata.confidence,
    };
    switch (kind) {
      case "preference":
        out.push({ kind: "preference", ...base, source: "explicit" });
        break;
      case "fact":
        out.push({ kind: "identity", ...base, source: "explicit" });
        break;
      case "goal":
        out.push({ kind: "project", ...base, source: "derived" });
        break;
      case "behavior":
      case "learning":
      case "procedure":
        out.push({ kind: "interest", ...base });
        break;
      case "event":
        out.push({ kind: "world_event", ...base });
        break;
      default:
        // Legacy memories without enrichment fall back to category.
        if (m.category === "preference") out.push({ kind: "preference", ...base, source: "derived" });
        else if (m.category === "identity") out.push({ kind: "identity", ...base, source: "derived" });
        else if (m.category === "goal" || m.category === "project") out.push({ kind: "project", ...base, source: "derived" });
        // everything else is not model-worthy
        break;
    }
  }
  return out;
}
