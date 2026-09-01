/**
 * MemoryIntelligenceService — the Phase 23 pipeline:
 *
 *   conversation turns
 *     → extract candidates (deterministic)
 *     → dedupe against existing (deterministic, fingerprint-first)
 *     → contradiction detection (deterministic)
 *     → decide action (ADD/UPDATE/KEEP/IGNORE/ARCHIVE/REMOVE)
 *     → persist via MemoryStore (Phase 22 seam — storage-agnostic)
 *     → verify
 *
 * Loop safety: never triggers another extraction (no memory→reflection→
 * memory cycles). Internal single-shot per call. Model escalation is
 * opt-in only through the caller.
 */
import type { Memory } from "../memoryTypes";
import type { MemoryStore } from "../persistence/memoryStore";
import type { MemoryBudget, MemoryCandidate, DecidedAction } from "./types";
import { DEFAULT_MEMORY_BUDGET } from "./types";
import { extractCandidates, ExtractionContext, ExtractionResult } from "./extraction";
import { findDuplicate, findContradiction } from "./dedupe";
import { decideAction } from "./resolution";
import { fingerprint, tokenSimilarity } from "./fingerprint";
import { writeEnrichment } from "./enrichment";

export interface ProcessInput {
  turns: Array<{ role: string; content: string }>;
  userId: string;
  activeGoals?: string[];
}

export interface ProcessResult {
  extracted: ExtractionResult;
  actions: DecidedAction[];
  persisted: {
    added: number;
    updated: number;
    kept: number;
    ignored: number;
    archived: number;
    removed: number;
  };
  failures: string[];
  persistenceVerified: boolean;
}

const USER_ID_FALLBACK = "default";

function genId(): string {
  return Math.random().toString(36).substring(2, 11);
}

export class MemoryIntelligenceService {
  private readonly budget: MemoryBudget;

  constructor(
    private readonly store: MemoryStore,
    budget: Partial<MemoryBudget> = {}
  ) {
    if (!store) throw new Error("MemoryIntelligenceService: MemoryStore is required");
    this.budget = { ...DEFAULT_MEMORY_BUDGET, ...budget };
  }

  /**
   * Run the full pipeline over a conversation slice. Returns a structured
   * outcome so callers can log/alert — never throws for backend or model
   * failures.
   */
  async process(input: ProcessInput): Promise<ProcessResult> {
    const failures: string[] = [];
    const actions: DecidedAction[] = [];

    if (!input.userId || !input.userId.trim()) {
      throw new Error("MemoryIntelligenceService: authenticated userId is required");
    }
    if (input.userId === USER_ID_FALLBACK && !process.env.LOHZ_ALLOW_DEFAULT_UID) {
      // Default UID means auth bypassed — refuse to persist to avoid
      // cross-user contamination through the shared fallback bucket.
      return {
        extracted: { candidates: [], dropped: input.turns.length },
        actions: [],
        persisted: { added: 0, updated: 0, kept: 0, ignored: 0, archived: 0, removed: 0 },
        failures: ["refused: default uid not allowed"],
        persistenceVerified: false,
      };
    }

    const loaded = await this.store.load(input.userId);
    if (loaded === null) {
      return {
        extracted: { candidates: [], dropped: input.turns.length },
        actions: [],
        persisted: { added: 0, updated: 0, kept: 0, ignored: 0, archived: 0, removed: 0 },
        failures: ["persistence load unavailable — refusing to overwrite unknown state"],
        persistenceVerified: false,
      };
    }
    // One-way compatibility migration: Phase 35 removed the duplicate
    // user_model memory layer. User profile facts are semantic evidence.
    const existing = loaded.map((memory) =>
      (memory.layer as string) === "user_model" ? { ...memory, layer: "semantic" as const } : memory);

    const ctx: ExtractionContext = {
      userId: input.userId,
      activeGoals: input.activeGoals,
      existingCount: existing.length,
      recentMemoryTexts: existing.slice(0, 50).map((m) => m.text),
    };

    const extracted = extractCandidates(input.turns, ctx);
    const windowed = extracted.candidates.slice(0, this.budget.maxCandidatesPerSlice);
    if (windowed.length < extracted.candidates.length) {
      failures.push(`slice bounded to ${this.budget.maxCandidatesPerSlice} candidates`);
    }

    const existingById = new Map(existing.map((m) => [m.id, m]));
    const next = [...existing.map((m) => this.touch(m))];
    let added = 0, updated = 0, kept = 0, ignored = 0, archived = 0, removed = 0;

    for (const candidate of windowed) {
      const duplicate = findDuplicate(candidate, next);
      const contradiction = findContradiction(candidate, next);
      const action = decideAction({
        candidate,
        duplicate,
        contradiction,
        existingLookup: (id) => next.find((m) => m.id === id),
      });
      actions.push(action);

      switch (action.action) {
        case "ADD": {
          const newMemory = this.candidateToMemory(candidate);
          next.push(newMemory);
          added++;
          break;
        }
        case "UPDATE": {
          const target = action.targetId ? next.find((m) => m.id === action.targetId) : undefined;
          if (target) {
            Object.assign(target, this.mergeMemory(target, candidate));
            updated++;
          } else {
            const newMemory = this.candidateToMemory(candidate);
            next.push(newMemory);
            added++;
          }
          break;
        }
        case "KEEP": {
          const target = action.targetId ? next.find((m) => m.id === action.targetId) : undefined;
          if (target) {
            target.metadata.lastReinforced = Date.now();
            target.metadata.confidence = Math.min(1, target.metadata.confidence + 0.05);
          }
          kept++;
          break;
        }
        case "IGNORE": {
          ignored++;
          break;
        }
        case "ARCHIVE": {
          const target = action.targetId ? next.find((m) => m.id === action.targetId) : undefined;
          if (target) {
            writeEnrichment(target, {
              status: "archived",
              archivedAt: Date.now(),
              archiveReason: "superseded",
            });
            const newMemory = this.candidateToMemory(candidate);
            writeEnrichment(newMemory, { supersedes: target.id });
            next.push(newMemory);
            archived++;
            added++;
          }
          break;
        }
        case "REMOVE": {
          const before = next.length;
          const target = action.targetId ? next.find((m) => m.id === action.targetId) : undefined;
          if (target) {
            const md = target.metadata as unknown as Record<string, unknown>;
            if (Array.isArray(md.evidence) && md.evidence.length > 0) {
              writeEnrichment(target, {
                status: "archived",
                archivedAt: Date.now(),
                archiveReason: "user_requested",
              });
              archived++;
            } else {
              next.splice(next.indexOf(target), 1);
              removed++;
            }
          }
          if (next.length === before && !target) {
            failures.push(`REMOVE target ${action.targetId} not found`);
          }
          break;
        }
      }
    }

    const verified = await this.store.save(input.userId, next);
    if (!verified) {
      failures.push("persistence save returned false — memories may be unwritten");
      return {
        extracted,
        actions,
        persisted: { added: 0, updated: 0, kept, ignored, archived, removed: 0 },
        failures,
        persistenceVerified: false,
      };
    }

    const persisted = { added, updated, kept, ignored, archived, removed };
    return { extracted, actions, persisted, failures, persistenceVerified: true };
  }

  private candidateToMemory(candidate: MemoryCandidate): Memory {
    const now = new Date().toISOString();
    const base: Memory = {
      id: genId(),
      layer: candidate.layer,
      category: candidate.category,
      text: candidate.text,
      createdAt: now,
      updatedAt: now,
      metadata: {
        importance: candidate.importance,
        confidence: candidate.confidence,
        source: candidate.source,
        timestamp: Date.now(),
        lastAccessed: Date.now(),
        lastReinforced: Date.now(),
        category: candidate.category,
        relationships: [],
        userId: candidate.userId,
      },
    };
    writeEnrichment(base, {
      kind: candidate.kind,
      status: "active",
      fingerprint: candidate.fingerprint || fingerprint(candidate.text),
      evidence: candidate.evidence,
    });
    return base;
  }

  private mergeMemory(target: Memory, candidate: MemoryCandidate): Memory {
    const md = target.metadata;
    return {
      ...target,
      text: candidate.text.length > target.text.length ? candidate.text : target.text,
      updatedAt: new Date().toISOString(),
      metadata: {
        ...md,
        importance: Math.max(md.importance, candidate.importance),
        confidence: Math.min(1, md.confidence + 0.05),
        lastReinforced: Date.now(),
        relationships: [
          ...new Set([...(md.relationships || []), ...candidate.evidence.slice(0, 3)]),
        ],
      },
    };
  }

  private touch(mem: Memory): Memory {
    return { ...mem, metadata: { ...mem.metadata, lastAccessed: Date.now() } };
  }
}
