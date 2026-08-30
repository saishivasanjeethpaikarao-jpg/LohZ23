/**
 * Phase 23 learning seam (interface only).
 *
 * Phase 28 will implement advanced strategy learning. This phase only
 * fixes the seam: a successful interaction becomes a candidate lesson,
 * gains confidence from evidence, and eventually lands as a learning
 * memory — routed through the standard MemoryIntelligence pipeline so
 * dedup, contradiction, and persistence stay in one place.
 */
import type { MemoryIntelligenceService } from "./memoryIntelligence";

export interface CandidateLesson {
  userId: string;
  /** What worked — third-person declarative, e.g. "The user responded well to concise answers." */
  text: string;
  confidence: number;
  evidence: string[];
}

/**
 * Submit a lesson candidate. The lesson flows through the normal
 * extraction/dedupe pipeline as a "learning"-kind candidate so it gets
 * the same persistence, fingerprinting, and contradiction handling as
 * any other memory. Returns the DecidedActions for callers/testing.
 */
export async function recordLesson(
  service: MemoryIntelligenceService,
  lesson: CandidateLesson
) {
  return service.process({
    turns: [{ role: "user", content: `remember this: ${lesson.text}` }],
    userId: lesson.userId,
  });
}
