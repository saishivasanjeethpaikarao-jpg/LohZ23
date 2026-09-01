/**
 * Phase 36 conversation metadata. Speaker identity is session-local and is
 * intentionally distinct from the authenticated account identity.
 */
export type SpeakerId = "primary_user" | "unknown_participant" | `speaker_${string}`;
export type ConversationSpeakerRole = "primary_user" | "participant" | "unknown";
export type ConversationMode = "single_user" | "multi_person";
export type SpeakerConfidenceKind =
  | "explicit_session"
  | "provider_calibrated"
  | "provider_unscaled"
  | "fallback";

export interface SpeakerConfidence {
  /** 0..1. Only provider_calibrated may be interpreted as a probability. */
  value: number;
  kind: SpeakerConfidenceKind;
  level: "high" | "medium" | "low";
}

export interface ConversationSpeaker {
  speakerId: SpeakerId;
  role: ConversationSpeakerRole;
  displayName?: string;
  confidence: SpeakerConfidence;
  firstSeenAt: string;
  lastSeenAt: string;
  turnCount: number;
  explicitlyIdentified: boolean;
}

export interface SpeakerTurn {
  turnId: string;
  sessionId: string;
  speakerId: SpeakerId;
  speakerRole: ConversationSpeakerRole;
  authenticatedUserId: string;
  text: string;
  startedAt: string;
  endedAt?: string;
  confidence: SpeakerConfidence;
  source: "voice" | "text";
  isFinal: boolean;
  overlapDetected: boolean;
  addressedToLohz: boolean | null;
}

export interface ConversationParticipantState {
  sessionId: string;
  primaryUserId: string;
  conversationMode: ConversationMode;
  speakers: ConversationSpeaker[];
  activeSpeakerId?: SpeakerId;
  participantCount: number;
  confidence: SpeakerConfidence;
  recentSpeakerTurns: SpeakerTurn[];
  overlapDetected: boolean;
  lastUpdatedAt: string;
}

export interface ProviderSpeakerMetadata {
  /** Optional future/provider-supplied tag. The installed Gemini Live SDK does not expose one. */
  speakerTag?: string;
  confidence?: number;
  confidenceCalibrated?: boolean;
  overlapDetected?: boolean;
}

export interface NormalizedSpeaker {
  speakerId: SpeakerId;
  role: ConversationSpeakerRole;
  confidence: SpeakerConfidence;
  overlapDetected: boolean;
}

export type SpeakerAuthorization = "primary_user" | "participant" | "unknown";

