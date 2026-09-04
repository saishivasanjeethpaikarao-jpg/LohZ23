/**
 * Speech Synthesis Service for LOHZ Companion Voice
 * Uses native Web Speech API (window.speechSynthesis) available in all modern browsers and Electron.
 * Provides natural voice playback, companion lip-sync/speaking states, and pitch/speed tuning.
 */

export interface SpeechOptions {
  pitch?: number;
  rate?: number;
  volume?: number;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (err: any) => void;
}

class SpeechService {
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private selectedVoice: SpeechSynthesisVoice | null = null;
  private isVoiceListLoaded = false;
  private voicePitch = 1.05;
  private voiceRate = 1.0;
  private isMuted = false;

  constructor() {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      this.loadVoices();
      if (window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.onvoiceschanged = () => this.loadVoices();
      }
    }
  }

  public getVoices(): SpeechSynthesisVoice[] {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
    return window.speechSynthesis.getVoices();
  }

  public setVoiceByName(name: string): boolean {
    const voices = this.getVoices();
    const match = voices.find((v) => v.name === name || v.name.toLowerCase().includes(name.toLowerCase()));
    if (match) {
      this.selectedVoice = match;
      return true;
    }
    return false;
  }

  private loadVoices(): void {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return;
    this.isVoiceListLoaded = true;

    // Prioritize high-quality, natural female/companion voices
    const preferredNames = [
      "Microsoft Jenny Online",
      "Microsoft Zira",
      "Google US English",
      "Samantha",
      "Victoria",
      "Karen",
      "Microsoft Aria Online",
      "Microsoft David",
      "en-US",
    ];

    for (const name of preferredNames) {
      const found = voices.find(
        (v) =>
          v.name.toLowerCase().includes(name.toLowerCase()) ||
          v.lang.toLowerCase().startsWith(name.toLowerCase())
      );
      if (found) {
        this.selectedVoice = found;
        return;
      }
    }

    // Fallback: any English voice
    const anyEnglish = voices.find((v) => v.lang.startsWith("en"));
    this.selectedVoice = anyEnglish || voices[0] || null;
  }

  public setPitchFromCents(cents: number): void {
    const normalized = Math.max(-1200, Math.min(1200, cents));
    this.voicePitch = Math.max(0.5, Math.min(1.8, 1.0 + normalized / 1200));
  }

  public setRate(speed: number): void {
    this.voiceRate = Math.max(0.6, Math.min(1.6, speed));
  }

  public setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (muted) {
      this.stop();
    }
  }

  public isSpeaking(): boolean {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return false;
    return window.speechSynthesis.speaking;
  }

  public stop(): void {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
    } catch {}
    this.currentUtterance = null;
  }

  private sanitizeTextForSpeech(raw: string): string {
    return raw
      .replace(/```[\s\S]*?```/g, " code block ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/https?:\/\/\S+/g, "link")
      .replace(/[*_#~>\[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  public speak(text: string, options: SpeechOptions = {}): void {
    if (this.isMuted) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      console.warn("[SpeechService] Web Speech API not supported in this environment.");
      options.onEnd?.();
      return;
    }

    const cleanText = this.sanitizeTextForSpeech(text);
    if (!cleanText) {
      options.onEnd?.();
      return;
    }

    this.stop();

    if (!this.selectedVoice) {
      this.loadVoices();
    }

    try {
      const utterance = new SpeechSynthesisUtterance(cleanText);
      if (this.selectedVoice) {
        utterance.voice = this.selectedVoice;
      }
      utterance.pitch = options.pitch ?? this.voicePitch;
      utterance.rate = options.rate ?? this.voiceRate;
      utterance.volume = options.volume ?? 1.0;

      utterance.onstart = () => {
        options.onStart?.();
      };

      utterance.onend = () => {
        this.currentUtterance = null;
        options.onEnd?.();
      };

      utterance.onerror = (e) => {
        if (e.error !== "interrupted" && e.error !== "canceled") {
          console.warn("[SpeechService] Utterance error:", e.error);
          options.onError?.(e);
        }
        this.currentUtterance = null;
        options.onEnd?.();
      };

      this.currentUtterance = utterance;

      try {
        if (window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
      } catch {}

      // Chrome/Windows speech bug workaround: long utterances pause after 14-15s
      const resumeTicker = setInterval(() => {
        if (!window.speechSynthesis.speaking) {
          clearInterval(resumeTicker);
        } else {
          try {
            window.speechSynthesis.resume();
          } catch {}
        }
      }, 4000);

      window.speechSynthesis.speak(utterance);
    } catch (err) {
      console.error("[SpeechService] Failed to speak utterance:", err);
      options.onError?.(err);
      options.onEnd?.();
    }
  }
}

export const speechService = new SpeechService();
