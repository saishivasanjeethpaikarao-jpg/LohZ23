/**
 * Phase 32 - ContextAssembler.
 *
 * Gathers ONLY the bounded subset relevant to this request from EXISTING
 * systems (UserModel, MemoryStore, TemporalService, goal manager,
 * optional world-assertion seam). Deterministic, read-only, fail-safe:
 * any provider failure degrades to "missing provider" and processing
 * continues. Zero LLM calls.
 */
import type {
  FrameEvent,
  FrameGoal,
  FrameMemory,
  SituationFrame,
} from "./types";
import { FRAME_LIMITS } from "./types";
import { createSituationFrame } from "./situationFrame";
import type { RoutingResult } from "../router/types";

export interface ContextProviders {
  /** Durable memory reader (e.g. MemoryStore.load) — implementer bounds results. */
  loadMemories?: (uid: string) => Promise<Array<{ id: string; text: string }>>;
  /** UserModel bundle reader. */
  loadUserModel?: (uid: string) => Promise<{
    interactionMode: SituationFrame["interactionMode"];
    preferences: Record<string, unknown>;
    projects: Array<{ key: string; displayName: string; status: string }>;
    currentTaskState: string | null;
  } | null>;
  /** Goal reader (AutonomousGoalManager.load shape). */
  loadGoals?: (uid: string) => Promise<Array<{ id: string; title: string; status: string; priority?: number }>>;
  /** TemporalService recent-events reader (already bounded by rings). */
  loadRecentEvents?: (uid: string, limit: number) => Promise<FrameEvent[]>;
  /** Phase 33 seam — external assertion source. */
  worldAssertions?: (uid: string, limit: number) => Promise<string[]>;
}

function clip(s: unknown, max: number = FRAME_LIMITS.snippetChars): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

async function safe<T>(fn: (() => Promise<T>) | undefined): Promise<{ value: T | undefined; ok: boolean }> {
  if (!fn) return { value: undefined as T | undefined, ok: false };
  try {
    return { value: await fn(), ok: true };
  } catch {
    return { value: undefined as T | undefined, ok: false };
  }
}

export interface AssembledContext {
  frame: SituationFrame;
  uncertaintyMissing: string[];
}

/** Relevance filter: keyword overlap with the request, bounded output. */
function pickRelevantMemories(
  mems: Array<{ id: string; text: string }>,
  query: string,
  limit: number
): FrameMemory[] {
  const qTokens = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const scored = mems.map((m) => {
    const t = m.text.toLowerCase();
    const hits = qTokens.filter((w) => w.length > 3 && t.includes(w)).length;
    return { m, hits };
  });
  scored.sort((a, b) => b.hits - a.hits);
  return scored.slice(0, limit).map(({ m }) => ({ id: m.id, text: clip(m.text) }));
}

export class ContextAssembler {
  constructor(
    private providers: ContextProviders,
    private capabilities: import("./types").LohzCapabilitySnapshot
  ) {}

  async assemble(
    userId: string,
    requestId: string,
    classification: Pick<RoutingResult, "intent" | "confidence" | "riskLevel" | "tier">,
    rawInput: string
  ): Promise<AssembledContext> {
    const nowMs = Date.now();
    const missing: string[] = [];

    const um = await safe(() => this.providers.loadUserModel?.(userId));
    if (!um.ok || !um.value) missing.push("userModel");
    const bundle = um.value;

    let interactionMode: SituationFrame["interactionMode"] = null;
    let currentTaskState: string | null = null;
    let activeProject: SituationFrame["activeProject"] = null;
    const projects: NonNullable<SituationFrame["activeProject"]>[] = [];
    const relevantUserPreferences: Record<string, string> = {};

    if (bundle) {
      interactionMode = bundle.interactionMode ?? null;
      currentTaskState = bundle.currentTaskState ?? null;
      for (const p of (bundle.projects ?? []).slice(0, FRAME_LIMITS.projects)) {
        projects.push({ key: p.key, displayName: clip(p.displayName), status: p.status });
      }
      activeProject = projects.find((p) => p.status === "active") ?? projects[0] ?? null;
      for (const [k, v] of Object.entries(bundle.preferences ?? {}).slice(0, 6)) {
        if (typeof v === "string") relevantUserPreferences[k] = clip(v, FRAME_LIMITS.preferenceChars);
        else if (v && typeof v === "object" && "value" in (v as Record<string, unknown>)) {
          relevantUserPreferences[k] = clip(String((v as { value: unknown }).value), FRAME_LIMITS.preferenceChars);
        }
      }
    }

    const memsRaw = await safe(() => this.providers.loadMemories?.(userId));
    if (!memsRaw.ok) missing.push("memory");
    const memories: FrameMemory[] = pickRelevantMemories(
      Array.isArray(memsRaw.value) ? memsRaw.value : [],
      rawInput,
      FRAME_LIMITS.memories
    );

    const goalsRaw = await safe(() => this.providers.loadGoals?.(userId));
    if (!goalsRaw.ok) missing.push("goals");
    const activeGoals: FrameGoal[] = ((goalsRaw.value ?? []) as FrameGoal[])
      .filter((g) => g.status === "active" || g.status === "proposed" || g.status === "progressing")
      .sort((a, b) => (b.priority ?? 0.5) - (a.priority ?? 0.5))
      .slice(0, FRAME_LIMITS.goals)
      .map((g) => ({ id: g.id, title: clip(g.title), status: g.status, priority: g.priority }));

    const eventsRaw = await safe(() => this.providers.loadRecentEvents?.(userId, FRAME_LIMITS.events));
    if (!eventsRaw.ok) missing.push("temporal");
    const recentEvents = ((eventsRaw.value ?? []) as FrameEvent[]).slice(0, FRAME_LIMITS.events);

    const waRaw = await safe(() => this.providers.worldAssertions?.(userId, FRAME_LIMITS.topics));
    if (!waRaw.ok) missing.push("worldAssertions");
    const worldAssertions = ((waRaw.value ?? []) as string[]).map((a) => clip(a));

    const frame = createSituationFrame(
      {
        requestId,
        userId,
        classification,
        interactionMode,
        timeContext: { hourOfDay: new Date(nowMs).getUTCHours(), dayOfWeek: new Date(nowMs).getUTCDay(), isoDate: new Date(nowMs).toISOString().slice(0, 10), epochMs: nowMs },
        activeProject,
        activeGoals,
        relevantMemories: memories,
        relevantUserPreferences,
        worldAssertions,
        recentEvents,
        recentTopics: [],
        absenceMs: null,
        currentTaskState,
        capabilities: this.capabilities,
        uncertainty: {
          missingProviders: missing.slice(0, 6),
          lowConfidenceIntent: classification.confidence < 0.75,
        },
        assembledAt: nowMs,
      },
      rawInput
    );

    return { frame, uncertaintyMissing: missing };
  }
}
