import { describe, it, expect, vi } from "vitest";
import { UnifiedCognitiveArchitecture } from "./unifiedLoop";
import { makeEvent } from "./unifiedEventBus";
import { DecisionEngine } from "./decisionEngine";
import { InterruptionController } from "./interruptionControl";
import { ReflectionEngine } from "./reflectionEngine";

function makeLoop(opts?: { eagerSpeaker?: boolean }) {
  const speech = vi.fn();
  const tools = vi.fn();
  const deps: Record<string, unknown> = {
    interruption: new InterruptionController({
      minSpeechGapMs: 0,
      typingWindowMs: 0,
      userActivityWindowMs: 0,
    }),
  };
  if (opts?.eagerSpeaker) {
    deps.decision = new DecisionEngine({ speakCooldownMs: 0, minConfidenceToSpeak: 0.05 });
  }
  const loop = new UnifiedCognitiveArchitecture(
    { onSpeech: speech, onToolUse: tools },
    { autoProactive: false },
    deps as never,
    {}
  );
  return { loop, speech, tools };
}

describe("Loop safety under adversarial conditions", () => {
  it("survives a rapid event storm of 300 distinct messages", () => {
    const { loop } = makeLoop();
    for (let i = 0; i < 300; i++) {
      loop.submitText(`storm message ${i}`);
    }
    expect(loop.bus.getQueueSize()).toBe(0);
    const state = loop.getCognitiveState();
    expect(state.workingMemory.currentConversation.length).toBeLessThanOrEqual(50);
    expect(loop.snapshot().aborted).toBe(false);
  });

  it("terminates speech-triggered-speech naturally (assistant turn ends chain)", async () => {
    const { loop, speech } = makeLoop({ eagerSpeaker: true });
    loop.submitText("What is TypeScript good for");
    await new Promise((r) => setTimeout(r, 30));
    const countAfterFirst = speech.mock.calls.length;
    expect(countAfterFirst).toBeGreaterThanOrEqual(1);

    await new Promise((r) => setTimeout(r, 30));
    expect(speech.mock.calls.length).toBe(countAfterFirst);
  });

  it("does not let reflection trigger further reflections", async () => {
    const reflector = new ReflectionEngine();
    const spy = vi.spyOn(reflector, "reflect").mockResolvedValue({
      insights: [],
      contradictions: [],
      strategyUpdates: [],
      memoryUpdates: [{ id: "l1", text: "lesson alpha", category: "strategy" }],
    } as never);

    const loop = new UnifiedCognitiveArchitecture(
      {},
      { autoProactive: false, reflectionCooldownMs: 60_000 },
      { reflector },
      {}
    );

    loop.submitText("alpha one beta");
    loop.submitText("gamma two delta");
    loop.submitText("epsilon three zeta");
    loop.submitText("actually, that's wrong");

    await new Promise((r) => setTimeout(r, 40));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not let memory ingestion trigger cascades", () => {
    const { loop } = makeLoop();
    const before = loop.bus.getStats().published;
    loop.ingestMemory({
      id: "m1",
      layer: "semantic",
      category: "fact",
      text: "static fact",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {
        importance: 0.5,
        confidence: 0.8,
        source: "conversation",
        timestamp: Date.now(),
        lastAccessed: Date.now(),
        lastReinforced: Date.now(),
        category: "fact",
        relationships: [],
        userId: "default",
      },
    });
    expect(loop.bus.getStats().published).toBe(before + 1);
    expect(loop.getCognitiveState().workingMemory.currentConversation).toHaveLength(0);
  });

  it("tool observation never triggers a new tool dispatch", () => {
    const { loop, tools } = makeLoop();
    loop.reportToolResult("web_search", { ok: 1 }, true);
    loop.reportToolResult("web_search", { ok: 2 }, false);
    expect(tools).not.toHaveBeenCalled();
  });

  it("duplicate event storms are collapsed to a single processing pass", () => {
    const { loop } = makeLoop();
    let accepted = 0;
    for (let i = 0; i < 100; i++) {
      if (
        loop.bus.publish(
          makeEvent({ userId: "default", type: "user_message", payload: { text: "dup" }, source: "user" })
        )
      ) {
        accepted++;
      }
    }
    expect(accepted).toBe(1);
    expect(loop.getCognitiveState().workingMemory.currentConversation).toHaveLength(1);
  });

  it("abort halts processing even while events keep arriving", () => {
    const { loop } = makeLoop();
    loop.abort("storm shutdown");
    for (let i = 0; i < 50; i++) {
      loop.submitText(`ignored ${i}`);
    }
    expect(loop.getCognitiveState().workingMemory.currentConversation).toHaveLength(0);

    loop.resume();
    loop.submitText("back online");
    expect(loop.getCognitiveState().workingMemory.currentConversation).toHaveLength(1);
  });
});

describe("Failure-mode degradation", () => {
  it("continues reflecting when the memory service rejects", async () => {
    const reflector = new ReflectionEngine();
    const spy = vi.spyOn(reflector, "reflect").mockResolvedValue(null);

    const loop = new UnifiedCognitiveArchitecture(
      { getExistingMemories: () => Promise.reject(new Error("memory service down")) },
      { autoProactive: false, reflectionCooldownMs: 0, reflectionTimeoutMs: 2000 },
      { reflector },
      {}
    );

    loop.submitText("alpha one beta");
    loop.submitText("gamma two delta");
    loop.submitText("epsilon three zeta");
    loop.submitText("actually, that's wrong");

    await new Promise((r) => setTimeout(r, 40));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(loop.snapshot().aborted).toBe(false);
  });

  it("survives a throwing speech callback", () => {
    const loop = new UnifiedCognitiveArchitecture(
      {
        onSpeech: () => {
          throw new Error("TTS subsystem exploded");
        },
      },
      { autoProactive: false, speechCooldownMs: 0 },
      {},
      {}
    );

    loop.updateInteractionPreferences({ proactiveFrequency: "frequent" });
    loop.addPendingTask("Finish report");
    loop.reportSilence(20000);

    expect(() => loop.tickProactive()).not.toThrow();

    loop.submitText("still alive after TTS failure");
    expect(loop.getCognitiveState().workingMemory.currentConversation).toHaveLength(1);
  });

  it("survives a throwing memory-update callback", () => {
    const memUpdates = vi.fn(() => {
      throw new Error("persistence layer down");
    });
    const loop = new UnifiedCognitiveArchitecture(
      { onMemoryUpdate: memUpdates },
      { autoProactive: false },
      {},
      {}
    );

    expect(() =>
      loop.reportToolResult("file_write", { bytes: 10 }, true)
    ).not.toThrow();

    const facts = loop.getMemories({ userId: "default", category: "fact" });
    expect(facts.some((r) => r.memory.text.includes("file_write"))).toBe(true);
  });

  it("handles consecutive tool failures without state corruption", () => {
    const evaluations = vi.fn();
    const loop = new UnifiedCognitiveArchitecture(
      { onEvaluation: evaluations },
      { autoProactive: false },
      {},
      {}
    );

    loop.reportToolResult("web_search", { err: "timeout" }, false);
    loop.reportToolResult("web_search", { err: "timeout again" }, false);

    const actions = loop.getCognitiveState().workingMemory.recentToolActions;
    expect(actions).toHaveLength(2);
    expect(actions.every((a) => a.success === false)).toBe(true);
    expect(loop.snapshot().aborted).toBe(false);
  });

  it("ignores malformed payloads without crashing", () => {
    const { loop } = makeLoop();

    expect(loop.bus.publish(makeEvent({ userId: "default", type: "user_message", payload: null }))).toBe(true);
    expect(loop.bus.publish(makeEvent({ userId: "default", type: "tool_result", payload: "not-an-object" }))).toBe(true);
    expect(loop.reportSilence(Number.NaN)).toBe(true);

    expect(loop.snapshot().aborted).toBe(false);
  });
});
