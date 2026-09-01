import type {
  ConversationMode,
  ConversationParticipantState,
  ConversationSpeaker,
  ConversationSpeakerRole,
  ProviderSpeakerMetadata,
  SpeakerId,
  SpeakerTurn,
} from "./types";
import { normalizeVoiceSpeaker } from "./speakerNormalization";
import { isExplicitlyAddressedToLohz } from "./responseEligibility";

export const CONVERSATION_LIMITS = {
  speakers: 8,
  recentTurns: 16,
  turnChars: 1_000,
} as const;

export interface AddTurnInput {
  text: string;
  source: "voice" | "text";
  provider?: ProviderSpeakerMetadata;
  speakerId?: SpeakerId;
  speakerRole?: ConversationSpeakerRole;
  addressedToLohz?: boolean | null;
  startedAt?: number;
  endedAt?: number;
}

export class ConversationSession {
  private state: ConversationParticipantState;
  private sequence = 0;
  private updateChain: Promise<void> = Promise.resolve();

  constructor(
    sessionId: string,
    authenticatedUserId: string,
    private readonly now: () => number = Date.now
  ) {
    if (!sessionId || !authenticatedUserId) throw new Error("ConversationSession requires session and authenticated user IDs");
    const iso = new Date(this.now()).toISOString();
    const primary: ConversationSpeaker = {
      speakerId: "primary_user",
      role: "primary_user",
      confidence: { value: 1, kind: "explicit_session", level: "high" },
      firstSeenAt: iso,
      lastSeenAt: iso,
      turnCount: 0,
      explicitlyIdentified: true,
    };
    this.state = {
      sessionId,
      primaryUserId: authenticatedUserId,
      conversationMode: "single_user",
      speakers: [primary],
      participantCount: 1,
      confidence: primary.confidence,
      recentSpeakerTurns: [],
      overlapDetected: false,
      lastUpdatedAt: iso,
    };
  }

  setMode(mode: ConversationMode): ConversationParticipantState {
    this.state.conversationMode = mode;
    this.state.lastUpdatedAt = new Date(this.now()).toISOString();
    return this.snapshot();
  }

  async addTurn(input: AddTurnInput): Promise<SpeakerTurn> {
    let result!: SpeakerTurn;
    const operation = async () => { result = this.addTurnSerial(input); };
    this.updateChain = this.updateChain.then(operation, operation);
    await this.updateChain;
    return result;
  }

  private addTurnSerial(input: AddTurnInput): SpeakerTurn {
    const text = String(input.text ?? "").replace(/\s+/g, " ").trim().slice(0, CONVERSATION_LIMITS.turnChars);
    if (!text) throw new Error("Conversation turn text is required");
    const normalized = input.source === "text"
      ? {
          speakerId: input.speakerId ?? "primary_user" as SpeakerId,
          role: input.speakerRole ?? "primary_user" as ConversationSpeakerRole,
          confidence: { value: 1, kind: "explicit_session" as const, level: "high" as const },
          overlapDetected: Boolean(input.provider?.overlapDetected),
        }
      : normalizeVoiceSpeaker(this.state.conversationMode, input.provider);
    const started = input.startedAt ?? this.now();
    const ended = input.endedAt ?? this.now();
    const turn: SpeakerTurn = {
      turnId: `${this.state.sessionId}:${++this.sequence}`,
      sessionId: this.state.sessionId,
      speakerId: normalized.speakerId,
      speakerRole: normalized.role,
      authenticatedUserId: this.state.primaryUserId,
      text,
      startedAt: new Date(started).toISOString(),
      endedAt: new Date(ended).toISOString(),
      confidence: normalized.confidence,
      source: input.source,
      isFinal: true,
      overlapDetected: normalized.overlapDetected,
      addressedToLohz: input.addressedToLohz ?? isExplicitlyAddressedToLohz(text),
    };

    const idx = this.state.speakers.findIndex((s) => s.speakerId === turn.speakerId);
    if (idx >= 0) {
      const speaker = this.state.speakers[idx];
      this.state.speakers[idx] = {
        ...speaker,
        lastSeenAt: turn.endedAt!,
        turnCount: speaker.turnCount + 1,
        confidence: turn.confidence,
      };
    } else if (this.state.speakers.length < CONVERSATION_LIMITS.speakers) {
      this.state.speakers.push({
        speakerId: turn.speakerId,
        role: turn.speakerRole,
        confidence: turn.confidence,
        firstSeenAt: turn.startedAt,
        lastSeenAt: turn.endedAt!,
        turnCount: 1,
        explicitlyIdentified: false,
      });
    }
    this.state.activeSpeakerId = turn.speakerId;
    this.state.participantCount = this.state.speakers.length;
    this.state.confidence = turn.confidence;
    this.state.overlapDetected = turn.overlapDetected;
    this.state.recentSpeakerTurns.push(turn);
    this.state.recentSpeakerTurns = this.state.recentSpeakerTurns.slice(-CONVERSATION_LIMITS.recentTurns);
    this.state.lastUpdatedAt = turn.endedAt!;
    return { ...turn, confidence: { ...turn.confidence } };
  }

  identifyParticipant(speakerId: SpeakerId, displayName: string): boolean {
    if (speakerId === "primary_user") return false;
    const safe = String(displayName).replace(/\s+/g, " ").trim().slice(0, 80);
    const speaker = this.state.speakers.find((item) => item.speakerId === speakerId);
    if (!safe || !speaker) return false;
    speaker.displayName = safe;
    speaker.explicitlyIdentified = true;
    this.state.lastUpdatedAt = new Date(this.now()).toISOString();
    return true;
  }

  snapshot(): ConversationParticipantState {
    return {
      ...this.state,
      speakers: this.state.speakers.map((speaker) => ({ ...speaker, confidence: { ...speaker.confidence } })),
      recentSpeakerTurns: this.state.recentSpeakerTurns.map((turn) => ({ ...turn, confidence: { ...turn.confidence } })),
      confidence: { ...this.state.confidence },
    };
  }
}

