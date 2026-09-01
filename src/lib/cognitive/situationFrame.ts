/**
 * Phase 32 - SituationFrame construction.
 * Pure/bounded: every collection clamped, every snippet sanitized.
 */
import type { RoutingResult } from "../router/types";
import {
  FRAME_LIMITS,
  LohzCapabilitySnapshot,
  SituationFrame,
  TimeContext,
} from "./types";

function clip(s: string, max: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

export function buildTimeContext(nowMs: number): TimeContext {
  const d = new Date(nowMs);
  return {
    hourOfDay: d.getUTCHours(),
    dayOfWeek: d.getUTCDay(),
    isoDate: d.toISOString().slice(0, 10),
    epochMs: nowMs,
  };
}

export interface FrameInput {
  requestId: string;
  userId: string;
  classification: Pick<RoutingResult, "intent" | "confidence" | "riskLevel" | "tier">;
  interactionMode: SituationFrame["interactionMode"];
  timeContext: TimeContext;
  activeProject: SituationFrame["activeProject"];
  activeGoals: SituationFrame["activeGoals"];
  relevantMemories: SituationFrame["relevantMemories"];
  relevantUserPreferences: Record<string, string>;
  worldAssertions: SituationFrame["relevantWorldAssertions"];
  conversationContext?: SituationFrame["conversationContext"];
  recentEvents: SituationFrame["temporalContext"]["recentImportantEvents"];
  recentTopics: string[];
  absenceMs: number | null;
  currentTaskState: string | null;
  capabilities: LohzCapabilitySnapshot;
  uncertainty: SituationFrame["uncertainty"];
  assembledAt: number;
}

/** Voice-style transcripts (wake words/fillers) — same heuristic as router tests. */
export function isVoiceStyle(raw: string): boolean {
  return /(^hey\s+lohz|^\s*um+[\s.,!]|please\b.*for\s+me\b)/i.test(raw);
}

export function createSituationFrame(
  input: FrameInput,
  rawInputText: string
): SituationFrame {
  return {
    requestId: input.requestId,
    userId: input.userId,
    inputMetadata: {
      length: Math.min(9999, rawInputText.length),
      isVoiceStyle: isVoiceStyle(rawInputText),
    },
    intent: input.classification.intent,
    intentConfidence: Math.max(0, Math.min(1, input.classification.confidence)),
    interactionMode: input.interactionMode,
    currentTimeContext: input.timeContext,
    activeProject: input.activeProject,
    activeGoals: input.activeGoals.slice(0, FRAME_LIMITS.goals),
    relevantMemories: input.relevantMemories
      .slice(0, FRAME_LIMITS.memories)
      .map((m) => ({ id: m.id, text: clip(m.text, FRAME_LIMITS.snippetChars) })),
    relevantUserPreferences: Object.fromEntries(
      Object.entries(input.relevantUserPreferences)
        .slice(0, 6)
        .map(([k, v]) => [k, clip(v, FRAME_LIMITS.preferenceChars)])
    ),
    relevantWorldAssertions: input.worldAssertions
      .slice(0, FRAME_LIMITS.topics)
      .map((a) => ({
        id: clip(a.id, 160), entity: clip(a.entity, 160), relation: clip(a.relation, 64),
        value: typeof a.value === "string" ? clip(a.value, FRAME_LIMITS.snippetChars) : a.value,
        observedAt: Number.isFinite(a.observedAt) ? a.observedAt : input.assembledAt,
        confidence: Math.max(0, Math.min(1, a.confidence)), source: clip(a.source, 160),
        status: a.status === "stale" ? "stale" : "active",
      })),
    conversationContext: input.conversationContext
      ? {
          conversationMode: input.conversationContext.conversationMode,
          participantCount: Math.max(1, Math.min(8, input.conversationContext.participantCount)),
          activeSpeaker: input.conversationContext.activeSpeaker
            ? { ...input.conversationContext.activeSpeaker }
            : null,
          recentSpeakerTurns: input.conversationContext.recentSpeakerTurns
            .slice(-FRAME_LIMITS.speakerTurns)
            .map((turn) => ({ ...turn, text: clip(turn.text, FRAME_LIMITS.snippetChars) })),
          speakerConfidence: {
            ...input.conversationContext.speakerConfidence,
            value: Math.max(0, Math.min(1, input.conversationContext.speakerConfidence.value)),
          },
          overlapDetected: Boolean(input.conversationContext.overlapDetected),
          addressedToLohz: input.conversationContext.addressedToLohz,
        }
      : null,
    temporalContext: {
      recentImportantEvents: input.recentEvents.slice(0, FRAME_LIMITS.events),
      recentTopics: input.recentTopics.slice(0, FRAME_LIMITS.topics),
      absenceMs: input.absenceMs === null ? null : Math.max(0, input.absenceMs),
    },
    currentTaskState: input.currentTaskState ? clip(input.currentTaskState, FRAME_LIMITS.snippetChars) : null,
    lohzCapabilities: input.capabilities,
    uncertainty: {
      missingProviders: input.uncertainty.missingProviders.slice(0, 6),
      lowConfidenceIntent: input.uncertainty.lowConfidenceIntent,
    },
    constraints: [
      "tiered_routing",
      "no_chain_of_thought_persistence",
      "privacy_denylist_enforced",
      "execution_requires_authorization",
    ],
    riskLevel: input.classification.riskLevel,
    assembledAt: input.assembledAt,
  };
}
