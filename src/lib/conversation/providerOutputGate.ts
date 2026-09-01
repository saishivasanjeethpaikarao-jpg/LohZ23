import type { ConversationMode } from "./types";

export type ProviderOutputDisposition = "pending" | "allow" | "suppress";

/** Bounded, ephemeral output buffer used to enforce the response eligibility gate. */
export class ProviderOutputGate {
  private disposition: ProviderOutputDisposition = "allow";
  private audio: string[] = [];
  private audioChars = 0;
  private captions: string[] = [];

  constructor(private readonly maxAudioChars = 8_000_000, private readonly maxAudioChunks = 256, private readonly maxCaptions = 64) {}

  begin(mode: ConversationMode): void {
    this.clear();
    this.disposition = mode === "single_user" ? "allow" : "pending";
  }

  pushAudio(chunk: string): string | null {
    if (this.disposition === "allow") return chunk;
    if (this.disposition === "suppress") return null;
    if (this.audio.length >= this.maxAudioChunks || this.audioChars + chunk.length > this.maxAudioChars) {
      this.suppress();
      return null;
    }
    this.audio.push(chunk);
    this.audioChars += chunk.length;
    return null;
  }

  pushCaption(text: string): string | null {
    if (this.disposition === "allow") return text;
    if (this.disposition === "suppress") return null;
    if (this.captions.length < this.maxCaptions) this.captions.push(text);
    return null;
  }

  allow(): { audio: string[]; captions: string[] } {
    if (this.disposition === "suppress") return { audio: [], captions: [] };
    const buffered = { audio: [...this.audio], captions: [...this.captions] };
    this.clear();
    this.disposition = "allow";
    return buffered;
  }

  suppress(): void {
    this.clear();
    this.disposition = "suppress";
  }

  getDisposition(): ProviderOutputDisposition {
    return this.disposition;
  }

  private clear(): void {
    this.audio = [];
    this.audioChars = 0;
    this.captions = [];
  }
}
