import type {
  ConversationMode,
  NormalizedSpeaker,
  ProviderSpeakerMetadata,
  SpeakerConfidence,
} from "./types";

export const SPEAKER_CONFIDENCE_THRESHOLDS = {
  high: 0.8,
  medium: 0.5,
} as const;

function level(value: number): SpeakerConfidence["level"] {
  if (value >= SPEAKER_CONFIDENCE_THRESHOLDS.high) return "high";
  if (value >= SPEAKER_CONFIDENCE_THRESHOLDS.medium) return "medium";
  return "low";
}

function safeTag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 48);
  return cleaned ? cleaned : null;
}

function boundedConfidence(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : null;
}

/**
 * Normalizes metadata without inferring identity from audio characteristics.
 * Untagged group audio is unknown. Low-confidence provider tags are also
 * unknown rather than confidently wrong.
 */
export function normalizeVoiceSpeaker(
  mode: ConversationMode,
  metadata: ProviderSpeakerMetadata = {}
): NormalizedSpeaker {
  if (mode === "single_user") {
    return {
      speakerId: "primary_user",
      role: "primary_user",
      confidence: { value: 1, kind: "explicit_session", level: "high" },
      overlapDetected: Boolean(metadata.overlapDetected),
    };
  }

  const tag = safeTag(metadata.speakerTag);
  const supplied = boundedConfidence(metadata.confidence);
  const confidence: SpeakerConfidence = supplied === null
    ? { value: tag ? 0.6 : 0, kind: tag ? "provider_unscaled" : "fallback", level: tag ? "medium" : "low" }
    : {
        value: supplied,
        kind: metadata.confidenceCalibrated ? "provider_calibrated" : "provider_unscaled",
        level: level(supplied),
      };

  if (!tag || confidence.level === "low") {
    return {
      speakerId: "unknown_participant",
      role: "unknown",
      confidence,
      overlapDetected: Boolean(metadata.overlapDetected),
    };
  }

  return {
    speakerId: `speaker_${tag}`,
    role: "participant",
    confidence,
    overlapDetected: Boolean(metadata.overlapDetected),
  };
}

