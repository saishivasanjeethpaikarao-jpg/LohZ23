import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  UnifiedCognitiveArchitecture,
  ModelBudgetTracker,
} from "./unifiedLoop";
import { makeEvent } from "./unifiedEventBus";
import { DecisionEngine } from "./decisionEngine";
import { InterruptionController } from "./interruptionControl";
import { ReflectionEngine } from "./reflectionEngine";
import { Memory } from "./memoryTypes";

function makeMemory(
  userId: string,
  text: string,
  overrides: Partial<Memory> = {}
): Memory {
  const now = Date.now();
  return {
    id: `mem_${Math.random().toString(36).slice(2, 9)}`,
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
    ...overrides,
  };
}

interface Harness {
  loop: UnifiedCognitiveArchitecture;
  speech: ReturnType<typeof vi.fn>;
  tools: ReturnType<typeof vi.fn>;
  asks: ReturnType<typeof vi.fn>;
  memUpdates: ReturnType<typeof vi.fn>;
  evaluations: ReturnType<typeof vi.fn>;
}

function makeHarness(opts?: {
  eagerSpeaker?: boolean;
  silentSpeaker?: boolean;
  reflectionCooldownMs?: number;
  toolCooldownMs?: number;
  reflector?: ReflectionEngine;
  budget?: { maxCallsPerMinute?: number; maxCallsTotal?: number };
}): Harness {
  const speech = vi.fn();
  const tools = vi.fn();
  const asks = vi.fn();
  const memUpdates = vi.fn();
  const evaluations = vi.fn();

  const interruption = new InterruptionController({
    minSpeechGapMs: 0,
    typingWindowMs: 0,
    userActivityWindowMs: 0,
  });

  const deps: Record<string, unknown> = { interruption };
  if (opts?.eagerSpeaker) {
    deps.decision = new DecisionEngine({ speakCooldownMs: 0, minConfidenceToSpeak: 0.05 });
  } else if (opts?.silentSpeaker) {
    deps.decision = new DecisionEngine({ minConfidenceToSpeak: 1.1 });
  }
  if (opts?.reflector) {
    deps.reflector = opts.reflector;
  }

  const loop = new UnifiedCognitiveArchitecture(
    {
      onSpeech: speech,
      onToolUse: tools,
      onAsk: asks,
      onMemoryUpdate: memUpdates,
      onEvaluation: evaluations,
    },
    {
      autoProactive: false,
      ...(opts?.reflectionCooldownMs !== undefined
        ? { reflectionCooldownMs: opts.reflectionCooldownMs }
        : {}),
      ...(opts?.toolCooldownMs !== undefined ? { toolCooldownMs: opts.toolCooldownMs } : {}),
    },
    deps as never,
    opts?.budget ?? {}
  );

  return { loop, speech, tools, asks, memUpdates, evaluations };
}

function feedTurns(loop: UnifiedCognitiveArchitecture, count: number): void {
  const words = ["alpha", "gamma", "epsilon", "eta", "iota", "kappa", "mu"];
  for (let i = 0; i < count; i++) {
    loop.submitText(`${words[i % words.length]} ${i + 1}`);
  }
}

async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("UnifiedCognitiveArchitecture — end-to-end cognitive loop", () => {
  let h: Harness;

  describe("conversation pipeline", () => {
    beforeEach(() => {
      h = makeHarness({ eagerSpeaker: true });
    });

    it("runs perception -> situation -> decision -> speech for a user message", () => {
      const { loop, speech } = h;

      loop.submitText("What is TypeScript good for");

      const snap = loop.snapshot();
      expect(snap.currentTopic).toBe("typescript");
      expect(snap.userIntent).toBe("question");
      expect(snap.conversationPhase).toBe("exploration");

      const state = loop.getCognitiveState();
      expect(state.workingMemory.currentConversation).toHaveLength(2);
      expect(state.workingMemory.currentConversation[1].role).toBe("assistant");
      expect(snap.lastDecision).toBe("SPEAK");

      expect(speech).toHaveBeenCalledTimes(1);
      expect(speech.mock.calls[0][0]).toBe("default");
      expect(speech.mock.calls[0][1]).toContain("typescript");
    });

    it("keeps working memory bounded across many turns", () => {
      const { loop } = h;
      for (let i = 0; i < 55; i++) {
        loop.submitText(`message number ${i} alpha`);
      }
      expect(loop.getCognitiveState().workingMemory.currentConversation.length).toBeLessThanOrEqual(50);
    });
  });

  describe("memory integration", () => {
    beforeEach(() => {
      h = makeHarness();
    });

    it("retrieves only user-scoped relevant memories", () => {
      const { loop } = h;
      const memA = makeMemory("userA", "Kaveri prefers concise summaries", {
        category: "preference",
        layer: "user_model",
      });
      const memB = makeMemory("userB", "Bob likes long detailed reports", {
        category: "preference",
        layer: "user_model",
      });
      loop.ingestMemory(memA);
      loop.ingestMemory(memB);

      loop.submitText("Give me concise summaries please", "userA");

      const ids = loop.getCognitiveState("userA").relevantMemories.map((m) => m.id);
      expect(ids).toContain(memA.id);
      expect(ids).not.toContain(memB.id);

      const results = loop.getMemories({ userId: "userB", query: "reports" });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.memory.metadata.userId === "userB")).toBe(true);
    });
  });

  describe("goals", () => {
    beforeEach(() => {
      h = makeHarness();
    });

    it("updates situation awareness on goal changes", () => {
      const { loop } = h;
      loop.reportGoalChange("created", [{ title: "Ship the app", status: "active" }]);
      expect(loop.getSituation().activeGoals).toHaveLength(1);
      expect(loop.getCognitiveState().activeGoal).toBe("Ship the app");

      loop.reportGoalChange("completed", [{ title: "Ship the app", status: "completed" }]);
      expect(loop.getSituation().activeGoals).toHaveLength(0);
    });

    it("evaluates completed tasks and emits the outcome", () => {
      const { loop, evaluations } = h;
      const taskId = loop.addPendingTask("Write the summary");
      loop.completePendingTask(taskId, true);

      expect(evaluations).toHaveBeenCalledTimes(1);
      expect(evaluations.mock.calls[0][1].taskId).toBe(taskId);
      expect(evaluations.mock.calls[0][1].success).toBe(true);
    });
  });

  describe("tools: act -> observe -> self-evaluate", () => {
    beforeEach(() => {
      h = makeHarness({ toolCooldownMs: 0 });
    });

    it("dispatches controlled tool actions through callbacks", () => {
      const { loop, tools } = h;
      expect(loop.requestTool("web_search", "Find docs")).toBe(true);
      expect(tools).toHaveBeenCalledWith("default", "web_search", {});
    });

    it("observes results and stores an episodic fact — never assumes success", () => {
      const { loop } = h;
      loop.reportToolResult("web_search", { hits: 3 }, true);

      const actions = loop.getCognitiveState().workingMemory.recentToolActions;
      expect(actions).toHaveLength(1);
      expect(actions[0].success).toBe(true);

      const facts = loop.getMemories({ userId: "default", category: "fact" });
      expect(facts.some((r) => r.memory.text.includes("web_search"))).toBe(true);
    });

    it("correlates observed failure back to the dispatched action", async () => {
      const reflector = new ReflectionEngine();
      const reflectSpy = vi.spyOn(reflector, "reflect");
      const { loop, evaluations } = makeHarness({
        toolCooldownMs: 0,
        reflectionCooldownMs: 0,
        reflector,
      });

      feedTurns(loop, 4);
      expect(loop.requestTool("file_write", "Write config file")).toBe(true);
      loop.reportToolResult("file_write", { error: "permission denied" }, false);

      await loop.whenIdle();
      await settle();

      const state = loop.getCognitiveState();
      const lastAction = state.workingMemory.recentToolActions.at(-1)!;
      expect(lastAction.success).toBe(false);

      expect(reflectSpy).toHaveBeenCalledTimes(1);
      const failureEval = evaluations.mock.calls.find(
        (c) => c[1].intendedOutcome === "Write config file"
      );
      expect(failureEval).toBeDefined();
      expect(failureEval![1].success).toBe(false);
    });
  });

  describe("reflection and learning", () => {
    function lessonReflector(): { reflector: ReflectionEngine; spy: ReturnType<typeof vi.spyOn> } {
      const reflector = new ReflectionEngine();
      const spy = vi.spyOn(reflector, "reflect").mockResolvedValue({
        insights: [],
        contradictions: [],
        strategyUpdates: [],
        memoryUpdates: [
          { id: "lesson_1", text: "Batch tool calls when possible", category: "strategy" },
        ],
      } as never);
      return { reflector, spy };
    }

    it("turns reflection output into stored memories", async () => {
      const { reflector, spy } = lessonReflector();
      const { loop, memUpdates } = makeHarness({
        reflectionCooldownMs: 0,
        reflector,
      });

      feedTurns(loop, 3);
      loop.submitText("actually, that's wrong");

      await loop.whenIdle();
      await settle();

      expect(spy).toHaveBeenCalledTimes(1);
      const lessons = loop.getMemories({ userId: "default", query: "batch" });
      expect(lessons.some((r) => r.memory.id === "lesson_1")).toBe(true);
      expect(memUpdates).toHaveBeenCalled();
    });

    it("respects the reflection cooldown", async () => {
      const { reflector, spy } = lessonReflector();
      const { loop } = makeHarness({ reflectionCooldownMs: 60_000, reflector });

      feedTurns(loop, 4);
      loop.submitText("actually, that's wrong");
      loop.submitText("actually, you're incorrect again");

      await loop.whenIdle();
      await settle();

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("times out a hung memory fetch and continues with empty memories", async () => {
      const reflector = new ReflectionEngine();
      const reflectSpy = vi.spyOn(reflector, "reflect").mockResolvedValue(null);

      const loop = new UnifiedCognitiveArchitecture(
        { getExistingMemories: () => new Promise<Memory[]>(() => {}) },
        { autoProactive: false, reflectionCooldownMs: 0, reflectionTimeoutMs: 30 },
        { reflector },
        {}
      );

      feedTurns(loop, 4);
      loop.submitText("actually, that's wrong");

      await settle(120);
      expect(reflectSpy).toHaveBeenCalledTimes(1);

      loop.submitText("still responsive after timeout");
      expect(loop.getCognitiveState().workingMemory.currentConversation.length).toBeGreaterThan(4);
    });
  });

  describe("model budget", () => {
    it("caps model-backed calls and records reasons", async () => {
      const reflector = new ReflectionEngine();
      const reflectSpy = vi.spyOn(reflector, "reflect").mockResolvedValue(null);

      const { loop } = makeHarness({
        reflectionCooldownMs: 0,
        reflector,
        budget: { maxCallsTotal: 2, maxCallsPerMinute: 2 },
      });

      feedTurns(loop, 4);

      loop.reportError("first failure");
      loop.reportError("second failure");
      loop.reportError("third failure");

      await settle(80);

      expect(reflectSpy).toHaveBeenCalledTimes(2);
      const usage = loop.getBudgetUsage();
      expect(usage.total).toBe(2);
      expect(usage.skippedOverBudget).toBe(1);
      expect(usage.reasons.every((r) => r.startsWith("reflection:"))).toBe(true);
    });

    it("tracks usage in the tracker", () => {
      const tracker = new ModelBudgetTracker({ maxCallsTotal: 5 });
      expect(tracker.tryCall("test:one")).toBe(true);
      expect(tracker.tryCall("test:two")).toBe(true);
      expect(tracker.usage().total).toBe(2);
      expect(tracker.usage().reasons).toEqual(["test:one", "test:two"]);
      tracker.reset();
      expect(tracker.usage().total).toBe(0);
    });
  });

  describe("proactive speech", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("speaks proactively about pending tasks during meaningful silence", () => {
      vi.useFakeTimers();
      const { loop, speech } = makeHarness({ silentSpeaker: true });

      loop.updateInteractionPreferences({ proactiveFrequency: "frequent" });
      loop.submitText("hello there friend");
      loop.submitText("continuing the report work");
      loop.addPendingTask("Finish report");

      vi.advanceTimersByTime(11000);
      loop.reportSilence(20000);
      loop.tickProactive();

      expect(speech).toHaveBeenCalledTimes(1);
      expect(speech.mock.calls[0][1]).toContain("Finish report");
    });

    it("does not speak proactively when disabled", () => {
      const { loop, speech } = makeHarness();
      loop.setProactiveEnabled(false);
      loop.addPendingTask("Finish report");
      loop.reportSilence(20000);
      loop.tickProactive();
      expect(speech).not.toHaveBeenCalled();
    });
  });

  describe("account switching / user isolation", () => {
    it("keeps state, situations, and memories scoped per user", () => {
      const { loop } = makeHarness();
      loop.ingestMemory(makeMemory("alice", "Alice studies astronomy"));
      loop.ingestMemory(makeMemory("bob", "Bob studies botany"));

      loop.submitText("astronomy tonight please", "alice");
      loop.submitText("botany tonight please", "bob");

      expect(loop.snapshot("alice").currentTopic).toBe("astronomy");
      expect(loop.snapshot("bob").currentTopic).toBe("botany");

      expect(loop.getCognitiveState("alice").workingMemory.currentConversation).toHaveLength(1);
      expect(loop.getCognitiveState("bob").workingMemory.currentConversation).toHaveLength(1);

      const aliceView = loop.getMemories({ userId: "alice", query: "studies" });
      expect(aliceView.length).toBeGreaterThan(0);
      expect(aliceView.every((r) => r.memory.metadata.userId === "alice")).toBe(true);
      expect(aliceView.some((r) => r.memory.text.includes("botany"))).toBe(false);
    });
  });

  describe("loop safety", () => {
    it("drops duplicate event ids", () => {
      const { loop } = makeHarness();
      const evt = makeEvent({
        userId: "default",
        type: "user_message",
        payload: { text: "only once" },
        source: "user",
      });
      expect(loop.bus.publish(evt)).toBe(true);
      expect(loop.bus.publish(evt)).toBe(false);
      expect(loop.getCognitiveState().workingMemory.currentConversation).toHaveLength(1);
    });

    it("drops identical content published within the dedup window", () => {
      const { loop } = makeHarness();
      loop.submitText("repeat me exactly");
      loop.submitText("repeat me exactly");
      expect(loop.getCognitiveState().workingMemory.currentConversation).toHaveLength(1);
      expect(loop.bus.getStats().duplicatesDropped).toBeGreaterThanOrEqual(1);
    });

    it("bounds runaway event generation", () => {
      const { loop } = makeHarness();
      let spawned = 0;
      const unsubscribe = loop.bus.subscribe((event) => {
        if (event.type !== "external_event") return;
        spawned += 1;
        loop.bus.publish(
          makeEvent({
            userId: "default",
            type: "external_event",
            payload: { n: spawned },
          })
        );
      });

      expect(
        loop.bus.publish(
          makeEvent({ userId: "default", type: "external_event", payload: { seed: true } })
        )
      ).toBe(true);

      expect(loop.bus.getStats().published).toBeLessThanOrEqual(60);
      unsubscribe();
    });

    it("blocks repeated identical tool dispatches", () => {
      const { loop, tools } = makeHarness({ toolCooldownMs: 0 });
      loop.requestTool("web_search", "attempt one");
      loop.requestTool("web_search", "attempt two");
      loop.requestTool("web_search", "attempt three");
      loop.requestTool("web_search", "attempt four");
      expect(tools).toHaveBeenCalledTimes(3);
    });

    it("blocks repeated speech within the cooldown", () => {
      const { loop, speech } = makeHarness({ eagerSpeaker: true });
      loop.submitText("first question about typescript?");
      loop.submitText("second question about typescript?");
      expect(speech).toHaveBeenCalledTimes(1);
    });

    it("supports abort and resume", () => {
      const { loop } = makeHarness();
      loop.abort("maintenance");
      expect(loop.snapshot().aborted).toBe(true);
      expect(loop.snapshot().abortReason).toBe("maintenance");

      loop.submitText("ignored while aborted");
      expect(loop.getCognitiveState().workingMemory.currentConversation).toHaveLength(0);

      loop.resume();
      loop.submitText("processed after resume");
      expect(loop.getCognitiveState().workingMemory.currentConversation).toHaveLength(1);
    });

    it("rejects invalid events at the boundary", () => {
      const { loop } = makeHarness();
      const bad = makeEvent({ userId: "", type: "user_message" });
      expect(loop.bus.publish(bad)).toBe(false);
      expect(loop.bus.getStats().invalidRejected).toBe(1);
    });
  });

  describe("explicit planning", () => {
    it("creates a multi-step plan for complex goals", () => {
      const { loop } = makeHarness();
      const plan = loop.createGoalPlan("search for quantum computing breakthroughs and papers");
      expect(plan).not.toBeNull();
      expect(plan!.steps.length).toBeGreaterThanOrEqual(2);
      expect(plan!.userId).toBe("default");
      expect(loop.snapshot().planStatus).toBe("draft");
    });

    it("returns null instead of duplicating an active plan", () => {
      const { loop } = makeHarness();
      expect(loop.createGoalPlan("search for fusion energy research")).not.toBeNull();
      expect(loop.createGoalPlan("search for fusion energy research")).toBeNull();
    });
  });
});
