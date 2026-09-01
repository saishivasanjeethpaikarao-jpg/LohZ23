/**
 * Logical decay + archival.
 *
 * Philosophy (locked in code): important stable memories decay slowly
 * or not at all; temporary ones decay faster. Nothing important is
 * physically deleted by decay — "active → less relevant → archived"
 * replaces "active → deleted".
 */
import type { Memory } from "../memoryTypes";
import { isArchived } from "./enrichment";

export interface DecayRule {
  layer: string;
  /** Halflife in days; Infinity = never decays. */
  halflifeDays: number;
  /** Score below which a memory gets archived. */
  archiveBelow: number;
}

export const DEFAULT_DECAY_RULES: DecayRule[] = [
  { layer: "working",    halflifeDays: 30,   archiveBelow: 0.1 },
  { layer: "episodic",   halflifeDays: 60,   archiveBelow: 0.15 },
  { layer: "semantic",   halflifeDays: 180,  archiveBelow: 0.1 },
  { layer: "procedural", halflifeDays: 90,   archiveBelow: 0.15 },
];

export interface DecayContext {
  now?: number;
  activeGoalTexts?: string[];
}

function decayHalflife(mem: Memory): number {
  const layer = mem.layer;
  const rule = DEFAULT_DECAY_RULES.find((r) => r.layer === layer);
  return rule?.halflifeDays ?? 30;
}

function daysBetween(a: number, b: number): number {
  return Math.max(0, (b - a) / (1000 * 60 * 60 * 24));
}

/** Score ∈ [0,1]. Incorporates importance, stability, reinforcement, access count. */
export function decayScore(mem: Memory, ctx: DecayContext = {}): number {
  const now = ctx.now ?? Date.now();
  const halflife = decayHalflife(mem);
  const ageDays = daysBetween(mem.metadata.timestamp, now);
  const reinforcedDays = daysBetween(mem.metadata.lastReinforced || mem.metadata.timestamp, now);

  const decayFactor = Number.isFinite(halflife)
    ? Math.pow(0.5, ageDays / halflife)
    : 1;
  const reinforcementBoost = Math.min(0.15, reinforcedDays < 1 ? 0.1 : 0);

  const importance = Math.max(0, Math.min(1, mem.metadata.importance ?? 0.5));
  const base = importance * 0.6 + decayFactor * 0.4;
  return Math.max(0, Math.min(1, Math.max(0, base + reinforcementBoost)));
}

/** True when the memory should be archived due to decay. */
export function shouldArchive(mem: Memory, ctx: DecayContext = {}): boolean {
  if (isArchived(mem)) return false;
  const halflife = decayHalflife(mem);
  if (!Number.isFinite(halflife)) return false;
  const score = decayScore(mem, ctx);
  const rule = DEFAULT_DECAY_RULES.find((r) => r.layer === mem.layer);
  return score < (rule?.archiveBelow ?? 0.15);
}

/**
 * Sweep memories and produce ARCHIVE actions for low-relevance entries.
 * Caller decides whether/how to persist (seam with `MemoryStore`).
 * Non-destructive: nothing is REMOVED by decay. Returns the sweep
 * results even when nothing should change (tests use this for assertions).
 */
export function sweep(
  memories: Memory[],
  ctx: DecayContext = {}
): { memory: Memory; action: "KEEP" | "ARCHIVE"; score: number }[] {
  return memories.map((memory) => {
    if (isArchived(memory)) {
      return { memory, action: "KEEP" as const, score: decayScore(memory, ctx) };
    }
    const score = decayScore(memory, ctx);
    const archive = shouldArchive(memory, ctx);
    return { memory, action: (archive ? "ARCHIVE" : "KEEP") as "KEEP" | "ARCHIVE", score };
  });
}
