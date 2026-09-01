export class LiveConnectionCounter {
  private active = 0;

  acquire(onFirst: () => void, onLast: () => void): () => void {
    this.active += 1;
    if (this.active === 1) onFirst();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      if (this.active === 0) onLast();
    };
  }

  count(): number {
    return this.active;
  }
}

export function isLegacyClientToolResponse(message: unknown): boolean {
  return Boolean(message && typeof message === "object" && (message as { type?: unknown }).type === "toolResponse");
}

export function boundedDialogueSlice(
  history: Array<{ role: string; text: string; memoryScope?: "primary_user" | "participant" | "session" }>,
  maxEntries = 20
): Array<{ role: string; text: string; memoryScope?: "primary_user" | "participant" | "session" }> {
  return history.slice(-Math.max(2, maxEntries)).map((entry) => ({
    role: entry.role === "user" ? "user" : "model",
    text: String(entry.text).slice(0, 1000),
    ...(entry.memoryScope ? { memoryScope: entry.memoryScope } : {}),
  }));
}

export interface LiveTranscriptChunk {
  text: string;
  finished: boolean;
  speakerTag?: string;
  confidence?: number;
  confidenceCalibrated?: boolean;
  overlapDetected?: boolean;
}

/** Defensive normalization for current and future provider metadata. */
export function liveInputTranscriptChunk(message: unknown): LiveTranscriptChunk | null {
  const content = (message as any)?.serverContent;
  const transcription = content?.inputTranscription;
  const text = transcription?.text ?? content?.userTurn?.parts?.[0]?.text;
  if (typeof text !== "string" || !text.trim()) return null;
  return {
    text: text.trim(),
    finished: transcription?.finished === true,
    ...(typeof transcription?.speakerTag === "string" ? { speakerTag: transcription.speakerTag } : {}),
    ...(typeof transcription?.confidence === "number" ? { confidence: transcription.confidence } : {}),
    ...(typeof transcription?.confidenceCalibrated === "boolean" ? { confidenceCalibrated: transcription.confidenceCalibrated } : {}),
    ...(typeof transcription?.overlapDetected === "boolean" ? { overlapDetected: transcription.overlapDetected } : {}),
  };
}

export function liveInputTranscript(message: unknown): string | null {
  return liveInputTranscriptChunk(message)?.text ?? null;
}

export function liveOutputTranscript(message: unknown): string | null {
  const content = (message as any)?.serverContent;
  const text = content?.outputTranscription?.text ?? content?.modelTurn?.parts?.[0]?.text;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}
