import { describe, expect, it, vi } from "vitest";
import { ConversationSession, CONVERSATION_LIMITS } from "./session";
import { normalizeVoiceSpeaker } from "./speakerNormalization";
import { decideResponseEligibility } from "./responseEligibility";
import { TranscriptAccumulator } from "./transcriptAccumulator";
import { ProviderOutputGate } from "./providerOutputGate";

describe("Phase 36 speaker model", () => {
  it("keeps the compatibility path as one authenticated primary speaker", async () => {
    const session = new ConversationSession("s1", "user-a", () => 1_000);
    const turn = await session.addTurn({ text: "Hello LOHZ", source: "voice" });
    expect(turn.speakerId).toBe("primary_user");
    expect(turn.authenticatedUserId).toBe("user-a");
    expect(session.snapshot().participantCount).toBe(1);
  });

  it("falls back to unknown participant in group mode without provider metadata", async () => {
    const session = new ConversationSession("s2", "user-a");
    session.setMode("multi_person");
    const turn = await session.addTurn({ text: "I love cricket", source: "voice" });
    expect(turn.speakerId).toBe("unknown_participant");
    expect(turn.speakerRole).toBe("unknown");
    expect(turn.confidence.kind).toBe("fallback");
  });

  it("normalizes two and three simulated provider speaker tags without claiming identity", async () => {
    // Simulation only: the installed Gemini Live SDK has no speakerTag field.
    const session = new ConversationSession("s3", "user-a");
    session.setMode("multi_person");
    await session.addTurn({ text: "A", source: "voice", provider: { speakerTag: "A", confidence: 0.91, confidenceCalibrated: true } });
    await session.addTurn({ text: "B", source: "voice", provider: { speakerTag: "B", confidence: 0.88, confidenceCalibrated: true } });
    await session.addTurn({ text: "C", source: "voice", provider: { speakerTag: "C", confidence: 0.82, confidenceCalibrated: true } });
    const state = session.snapshot();
    expect(state.speakers.map((s) => s.speakerId)).toEqual(["primary_user", "speaker_a", "speaker_b", "speaker_c"]);
    expect(state.participantCount).toBe(4);
    expect(state.speakers.every((s) => !s.displayName)).toBe(true);
  });

  it("preserves repeated speaker tags and tracks speaker changes", async () => {
    const session = new ConversationSession("s4", "owner");
    session.setMode("multi_person");
    const provider = { speakerTag: "alpha", confidence: 0.7 };
    await session.addTurn({ text: "first", source: "voice", provider });
    await session.addTurn({ text: "other", source: "voice", provider: { speakerTag: "beta", confidence: 0.7 } });
    await session.addTurn({ text: "again", source: "voice", provider });
    const state = session.snapshot();
    expect(state.activeSpeakerId).toBe("speaker_alpha");
    expect(state.speakers.find((s) => s.speakerId === "speaker_alpha")?.turnCount).toBe(2);
  });

  it("downgrades low-confidence tags and records overlap", () => {
    const normalized = normalizeVoiceSpeaker("multi_person", {
      speakerTag: "claimed-person",
      confidence: 0.2,
      confidenceCalibrated: true,
      overlapDetected: true,
    });
    expect(normalized.speakerId).toBe("unknown_participant");
    expect(normalized.confidence.level).toBe("low");
    expect(normalized.overlapDetected).toBe(true);
  });

  it("fails safely on malformed provider metadata", () => {
    const normalized = normalizeVoiceSpeaker("multi_person", {
      speakerTag: "../../Rahul <script>",
      confidence: Number.NaN,
    });
    expect(normalized.speakerId).toMatch(/^speaker_[a-z0-9_-]+$/);
    expect(normalized.confidence.kind).toBe("provider_unscaled");
    expect(normalized.confidence.level).toBe("medium");
  });

  it("serializes concurrent turns, bounds history, and prevents snapshot mutation", async () => {
    let tick = 10;
    const session = new ConversationSession("ordered", "owner", () => ++tick);
    await Promise.all(Array.from({ length: 24 }, (_, index) => session.addTurn({ text: `turn ${index}`, source: "text" })));
    const snapshot = session.snapshot();
    expect(snapshot.recentSpeakerTurns).toHaveLength(CONVERSATION_LIMITS.recentTurns);
    expect(new Set(snapshot.recentSpeakerTurns.map((turn) => turn.turnId)).size).toBe(CONVERSATION_LIMITS.recentTurns);
    snapshot.recentSpeakerTurns[0].text = "mutated";
    expect(session.snapshot().recentSpeakerTurns[0].text).not.toBe("mutated");
  });

  it("allows only explicit session labels and does not persist an identity record", async () => {
    const session = new ConversationSession("labels", "owner");
    session.setMode("multi_person");
    const turn = await session.addTurn({ text: "hello", source: "voice", provider: { speakerTag: "2" } });
    expect(session.identifyParticipant(turn.speakerId, "Rahul")).toBe(true);
    expect(session.snapshot().speakers.find((speaker) => speaker.speakerId === turn.speakerId)?.displayName).toBe("Rahul");
    expect(session.identifyParticipant("primary_user", "Not Owner")).toBe(false);
  });

  it("does not carry unknown participants across a restarted session", async () => {
    const first = new ConversationSession("before-restart", "owner");
    first.setMode("multi_person");
    await first.addTurn({ text: "hello", source: "voice" });
    const restarted = new ConversationSession("after-restart", "owner");
    expect(first.snapshot().participantCount).toBe(2);
    expect(restarted.snapshot().participantCount).toBe(1);
    expect(restarted.snapshot().recentSpeakerTurns).toEqual([]);
  });
});

describe("Phase 36 transcript lifecycle", () => {
  it("waits for a final chunk and combines incremental text", () => {
    const acc = new TranscriptAccumulator();
    expect(acc.push({ text: "Let's", finished: false })).toBeNull();
    expect(acc.push({ text: "go outside", finished: false })).toBeNull();
    expect(acc.push({ text: "tonight", finished: true })?.text).toBe("Let's go outside tonight");
  });

  it("handles cumulative provider text and suppresses duplicate final turns", () => {
    const acc = new TranscriptAccumulator();
    acc.push({ text: "Can", finished: false });
    expect(acc.push({ text: "Can you explain that?", finished: true })?.text).toBe("Can you explain that?");
    expect(acc.push({ text: "Can you explain that?", finished: true })).toBeNull();
    acc.clear();
    expect(acc.push({ text: "Can you explain that?", finished: true })).not.toBeNull();
  });

  it("preserves metadata when turnComplete supplies the final boundary", () => {
    const acc = new TranscriptAccumulator();
    acc.push({ text: "hello", finished: false, metadata: { speakerTag: "simulated-a" } });
    expect(acc.flush()?.metadata?.speakerTag).toBe("simulated-a");
  });
});

describe("Phase 36 response eligibility", () => {
  const turn = (text: string, speakerRole: "primary_user" | "participant" | "unknown" = "unknown", overlapDetected = false) => ({
    text, speakerRole, overlapDetected, addressedToLohz: null,
  });

  it("keeps single-user behavior unchanged", () => {
    expect(decideResponseEligibility("single_user", turn("hello", "primary_user")).action).toBe("respond");
  });

  it("responds when a participant or user explicitly addresses LOHZ", () => {
    expect(decideResponseEligibility("multi_person", turn("LOHZ, what do you think?", "participant")).action).toBe("respond");
    expect(decideResponseEligibility("multi_person", turn("Hey LOHZ, help us", "primary_user")).action).toBe("respond");
  });

  it("stays silent while participants talk to each other", () => {
    expect(decideResponseEligibility("multi_person", turn("Yeah, I finished it yesterday", "participant"), [
      { speakerRole: "primary_user", text: "Did you finish the assignment?" },
    ])).toEqual({ action: "remain_silent", reason: "participant_answering_primary_user" });
    expect(decideResponseEligibility("multi_person", turn("Let's stay home", "participant")).action).toBe("remain_silent");
  });

  it("clarifies an ambiguous primary-user question and overlapping speech", () => {
    expect(decideResponseEligibility("multi_person", turn("Can you explain that?", "primary_user")).action).toBe("clarify");
    const overlap = decideResponseEligibility("multi_person", turn("garbled", "unknown", true));
    expect(overlap.action).toBe("clarify");
    expect(overlap.action === "clarify" && overlap.response).toMatch(/repeat/i);
  });
});

describe("Phase 36 provider output response gate", () => {
  it("preserves single-user streaming and buffers addressed group output until allowed", () => {
    const gate = new ProviderOutputGate();
    gate.begin("single_user");
    expect(gate.pushAudio("pcm")).toBe("pcm");
    gate.begin("multi_person");
    expect(gate.pushAudio("buffered-pcm")).toBeNull();
    expect(gate.pushCaption("buffered caption")).toBeNull();
    expect(gate.allow()).toEqual({ audio: ["buffered-pcm"], captions: ["buffered caption"] });
    expect(gate.pushAudio("live-pcm")).toBe("live-pcm");
  });

  it("drops non-addressed output and fails closed when the ephemeral buffer is exceeded", () => {
    const gate = new ProviderOutputGate(4, 2, 1);
    gate.begin("multi_person");
    gate.pushAudio("1234");
    expect(gate.pushAudio("5")).toBeNull();
    expect(gate.getDisposition()).toBe("suppress");
    expect(gate.allow()).toEqual({ audio: [], captions: [] });
    expect(gate.getDisposition()).toBe("suppress");
    gate.begin("multi_person");
    gate.suppress();
    expect(gate.pushCaption("should not escape")).toBeNull();
  });
});
