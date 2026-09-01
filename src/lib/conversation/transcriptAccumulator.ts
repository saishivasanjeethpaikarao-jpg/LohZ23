export interface TranscriptChunk {
  text: string;
  finished?: boolean;
  metadata?: Record<string, unknown>;
}

export interface FinalTranscript extends TranscriptChunk {
  finished: true;
}

/** Aggregates independent Live transcription chunks and suppresses duplicates. */
export class TranscriptAccumulator {
  private pending = "";
  private lastFinal = "";
  private pendingMetadata: Record<string, unknown> | undefined;

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  push(chunk: TranscriptChunk): FinalTranscript | null {
    const text = String(chunk.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    if (chunk.metadata) this.pendingMetadata = { ...(this.pendingMetadata ?? {}), ...chunk.metadata };
    if (!this.pending) this.pending = text;
    else if (text.startsWith(this.pending)) this.pending = text; // provider sent cumulative text
    else if (!this.pending.endsWith(text)) this.pending = `${this.pending} ${text}`.trim();
    if (!chunk.finished) return null;
    return this.flush(chunk.metadata);
  }

  flush(metadata?: Record<string, unknown>): FinalTranscript | null {
    const text = this.pending.replace(/\s+/g, " ").trim();
    this.pending = "";
    const finalMetadata = { ...(this.pendingMetadata ?? {}), ...(metadata ?? {}) };
    this.pendingMetadata = undefined;
    if (!text || text === this.lastFinal) return null;
    this.lastFinal = text;
    return { text, finished: true, ...(Object.keys(finalMetadata).length ? { metadata: finalMetadata } : {}) };
  }

  clear(): void {
    this.pending = "";
    this.lastFinal = "";
    this.pendingMetadata = undefined;
  }
}
