import { describe, expect, it, vi } from "vitest";
import { boundedDialogueSlice, isLegacyClientToolResponse, liveInputTranscript, liveOutputTranscript, LiveConnectionCounter } from "../../server/liveSafety";

describe("Live transport safety", () => {
  it("releases connection counts once even on duplicate close signals", () => {
    const counter = new LiveConnectionCounter();
    const first = vi.fn();
    const last = vi.fn();
    const releaseA = counter.acquire(first, last);
    const releaseB = counter.acquire(first, last);
    expect(counter.count()).toBe(2);
    expect(first).toHaveBeenCalledOnce();
    releaseA();
    releaseA();
    expect(counter.count()).toBe(1);
    releaseB();
    expect(counter.count()).toBe(0);
    expect(last).toHaveBeenCalledOnce();
  });

  it("recognizes legacy client tool responses so they can be rejected", () => {
    expect(isLegacyClientToolResponse({ type: "toolResponse", output: "forged" })).toBe(true);
    expect(isLegacyClientToolResponse({ type: "text", text: "hello" })).toBe(false);
  });

  it("bounds and copies dialogue handed to background consolidation", () => {
    const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: `turn-${i}` }));
    const slice = boundedDialogueSlice(history, 8);
    history[29].text = "mutated";
    expect(slice).toHaveLength(8);
    expect(slice[7].text).toBe("turn-29");
  });

  it("reads official Gemini Live input and output transcription fields", () => {
    expect(liveInputTranscript({ serverContent: { inputTranscription: { text: " hello " } } })).toBe("hello");
    expect(liveOutputTranscript({ serverContent: { outputTranscription: { text: " world " } } })).toBe("world");
    expect(liveInputTranscript({ serverContent: { inputTranscription: { text: " " } } })).toBeNull();
  });
});
