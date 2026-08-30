import { describe, it, expect, vi } from "vitest";
import { UnifiedCognitiveArchitecture } from "./unifiedLoop";
import { InterruptionController } from "./interruptionControl";
import { DecisionEngine } from "./decisionEngine";
import { ReflectionEngine } from "./reflectionEngine";
import { Memory } from "./memoryTypes";

function makeMemory(userId: string, text: string): Memory {
  const now = Date.now();
  return {
    id: `mem_${userId}_${Math.random().toString(36).slice(2, 8)}`,
    layer: "semantic",
    category: "fact",
    text,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    metadata: {
      importance: 0.9,
      confidence: 0.9,
      source: "conversation",
      timestamp: now,
      lastAccessed: now,
      lastReinforced: now,
      category: "fact",
      relationships: [],
      userId,
    },
  };
}

interface Harness {
  loop: UnifiedCognitiveArchitecture;
  speech: ReturnType<typeof vi.fn>;
  tools: ReturnType<typeof vi.fn>;
  evaluations: ReturnType<typeof vi.fn>;
}

function makeHarness(opts?: {
  silentSpeaker?: boolean;
  reflectionCooldownMs?: number;
  toolCooldownMs?: number;
  reflector?: ReflectionEngine;
}): Harness {
  const speech = vi.fn();
  const tools = vi.fn();
  const evaluations = vi.fn();

  const deps: Record<string, unknown> = {
    interruption: new InterruptionController({
      minSpeechGapMs: 0,
      typingWindowMs: 0,
      userActivityWindowMs: 0,
    }),
    decision: opts?.silentSpeaker
      ? new DecisionEngine({ minConfidenceToSpeak: 1.1 })
      : new DecisionEngine({ speakCooldownMs: 0, minConfidenceToSpeak: 0.05 }),
  };
  if (opts?.reflector) deps.reflector = opts.reflector;

  const loop = new UnifiedCognitiveArchitecture(
    { onSpeech: speech, onToolUse: tools, onEvaluation: evaluations },
    {
      autoProactive: false,
      ...(opts?.reflectionCooldownMs !== undefined
        ? { reflectionCooldownMs: opts.reflectionCooldownMs }
        : {}),
      ...(opts?.toolCooldownMs !== undefined ? { toolCooldownMs: opts.toolCooldownMs } : {}),
    },
    deps as never,
    {}
  );
  return { loop, speech, tools, evaluations };
}

const USERS = ["userA", "userB", "userC"] as const;

describe("Concurrent multi-user operation (A / B / C)", () => {
  it("keeps conversations, situations, and memories fully isolated", () => {
    // Silent decision engine: this test targets state isolation, not speech.
    const { loop } = makeHarness({ silentSpeaker: true });
    loop.ingestMemory(makeMemory("userA", "Alice studies astronomy"));
    loop.ingestMemory(makeMemory("userB", "Bob studies botany"));
    loop.ingestMemory(makeMemory("userC", "Cara studies chemistry"));

    loop.submitText("astronomy tonight please", "userA");
    loop.submitText("botany tonight please", "userB");
    loop.submitText("chemistry tonight please", "userC");

    expect(loop.snapshot("userA").currentTopic).toBe("astronomy");
    expect(loop.snapshot("userB").currentTopic).toBe("botany");
    expect(loop.snapshot("userC").currentTopic).toBe("chemistry");

    // Each user holds exactly their own turn; no cross-user leakage.
    for (const u of USERS) {
      const convo = loop.getCognitiveState(u).workingMemory.currentConversation;
      expect(convo).toHaveLength(1);
      expect(convo[0].role).toBe("user");
    }

    for (const u of USERS) {
      const view = loop.getMemories({ userId: u, query: "studies" });
      expect(view.length).toBeGreaterThan(0);
      expect(view.every((r) => r.memory.metadata.userId === u)).toBe(true);
    }

    const allViews = USERS.map((u) => loop.getMemories({ userId: u }));
    expect(allViews[0].some((r) => r.memory.text.includes("botany"))).toBe(false);
    expect(allViews[1].some((r) => r.memory.text.includes("chemistry"))).toBe(false);
  });

  it("keeps goal state isolated per user", () => {
    const { loop } = makeHarness();
    loop.reportGoalChange("created", [{ title: "Ship alpha", status: "active" }], "userA");
    loop.reportGoalChange("created", [{ title: "Ship beta", status: "active" }], "userB");
    loop.reportGoalChange("created", [{ title: "Ship gamma", status: "active" }], "userC");

    expect(loop.getCognitiveState("userA").activeGoal).toBe("Ship alpha");
    expect(loop.getCognitiveState("userB").activeGoal).toBe("Ship beta");
    expect(loop.getCognitiveState("userC").activeGoal).toBe("Ship gamma");
    expect(loop.getSituation("userA").activeGoals).toHaveLength(1);
    expect(loop.getSituation("userB").activeGoals).toHaveLength(1);
    expect(loop.getSituation("userC").activeGoals).toHaveLength(1);
  });

  it("does not carry speech cooldowns across account switches", () => {
    const { loop, speech } = makeHarness();
    loop.addPendingTask("Draft launch checklist alpha", 1, "userA");
    loop.addPendingTask("Build inventory catalog bravo", 1, "userB");

    loop.submitText("alpha one", "userA");
    expect(speech).toHaveBeenCalledTimes(1);
    expect(speech.mock.calls[0][0]).toBe("userA");

    // Immediately switching to user B must not inherit A's cooldown.
    loop.submitText("bravo two", "userB");
    expect(speech).toHaveBeenCalledTimes(2);
    expect(speech.mock.calls[1][0]).toBe("userB");

    // A is still within A's own cooldown window.
    loop.submitText("alpha retry", "userA");
    expect(speech).toHaveBeenCalledTimes(2);
  });

  it("attributes tool actions and observations per user independently", () => {
    const { loop, tools, evaluations } = makeHarness({ toolCooldownMs: 0 });

    expect(loop.requestTool("web_search", "Find docs alpha", "userA")).toBe(true);
    expect(loop.requestTool("web_search", "Find docs bravo", "userB")).toBe(true);
    expect(tools).toHaveBeenCalledTimes(2);
    expect(tools.mock.calls[0][0]).toBe("userA");
    expect(tools.mock.calls[1][0]).toBe("userB");

    // B's observed result must not consume A's pending action.
    loop.reportToolResult("web_search", { hits: 1 }, true, "userB");
    const bEval = evaluations.mock.calls.find((c) => c[1].intendedOutcome === "Find docs bravo");
    expect(bEval).toBeDefined();
    expect(bEval![0]).toBe("userB");
    expect(evaluations.mock.calls.some((c) => c[1].intendedOutcome === "Find docs alpha")).toBe(false);

    // A's own result still correlates correctly afterwards.
    loop.reportToolResult("web_search", { hits: 2 }, true, "userA");
    const aEval = evaluations.mock.calls.find((c) => c[1].intendedOutcome === "Find docs alpha");
    expect(aEval).toBeDefined();
    expect(aEval![0]).toBe("userA");
  });

  it("does not carry reflection cooldowns across users", async () => {
    const reflector = new ReflectionEngine();
    const spy = vi.spyOn(reflector, "reflect").mockResolvedValue(null);
    const { loop } = makeHarness({ reflectionCooldownMs: 60_000, reflector });

    const turns = ["one alpha", "two bravo", "three charlie"];

    for (const t of turns) loop.submitText(t, "userA");
    loop.submitText("actually, that's wrong", "userA");
    await new Promise((r) => setTimeout(r, 30));
    expect(spy).toHaveBeenCalledTimes(1);

    // Same wall-clock moment: user B gets their own reflection budget.
    for (const t of turns) loop.submitText(t, "userB");
    loop.submitText("actually, you're incorrect", "userB");
    await new Promise((r) => setTimeout(r, 30));
    expect(spy).toHaveBeenCalledTimes(2);

    // And A remains inside A's cooldown.
    loop.submitText("actually, wrong again", "userA");
    await new Promise((r) => setTimeout(r, 30));
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
