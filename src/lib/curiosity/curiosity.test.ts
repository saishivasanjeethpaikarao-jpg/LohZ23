import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { rankGapActions } from "./infoGain";
import { InMemoryCuriosityStore, type CuriosityStore } from "./store";
import { LocalCuriosityStore } from "./durableStore";
import { ASK_COOLDOWN_MS, CuriosityService } from "./service";
import { CURIOSITY_LIMITS } from "./types";

function service(store: CuriosityStore = new InMemoryCuriosityStore(), providers = {}, now: () => number = () => 1_000_000) {
  return new CuriosityService({ store, providers, now });
}

describe("Phase 42 — gap detection", () => {
  it("produces no gap for a confident, successful, verified route", async () => {
    const s = service();
    const gap = await s.captureRouteOutcome("u1", { intent: "open_app", confidence: 0.98, success: true, verificationStatus: "VERIFIED" });
    expect(gap).toBeNull();
  });

  it("detects low-confidence intent as an ask-the-user gap", async () => {
    const s = service();
    const gap = await s.captureRouteOutcome("u1", { intent: "chat", confidence: 0.45, success: false, inputText: "open the thing" });
    expect(gap).not.toBeNull();
    expect(gap!.source).toBe("low_confidence_intent");
    expect(gap!.possibleSources).toContain("ask_user");
    expect(gap!.status).toBe("open");
    expect(gap!.gapId).toMatch(/^gap_/);
  });

  it("detects an unverified outcome with probe-first sources", async () => {
    const s = service();
    const gap = await s.captureRouteOutcome("u1", { intent: "open_app", confidence: 0.98, success: false, verificationStatus: "INCONCLUSIVE" });
    expect(gap!.source).toBe("unverified_outcome");
    expect(gap!.possibleSources[0]).toBe("safe_probe");
  });

  it("detects explicit user ignorance", async () => {
    const s = service();
    const gap = await s.captureRouteOutcome("u1", { intent: "chat", confidence: 0.9, success: true, inputText: "I don't know where the config file went" });
    expect(gap!.source).toBe("explicit_unknown");
  });

  it("detects stale knowledge references", async () => {
    const s = service();
    const gap = await s.captureRouteOutcome("u1", { intent: "open_app", confidence: 0.9, success: true, staleReference: "chrome open" });
    expect(gap!.source).toBe("stale_knowledge");
  });

  it("dedupes identical recurring gaps (reinforces, never multiplies)", async () => {
    const s = service();
    const input = { intent: "chat", confidence: 0.4, success: false, inputText: "open the thing" };
    const g1 = await s.captureRouteOutcome("u1", input);
    const g2 = await s.captureRouteOutcome("u1", input);
    expect(g1!.gapId).toBe(g2!.gapId);
    expect(g2!.importance).toBeCloseTo(g1!.importance + 0.05, 5);
    expect((await s.listOpen("u1"))).toHaveLength(1);
  });
});

describe("Phase 42 — information gain ranking", () => {
  const askOnly = { possibleSources: ["ask_user" as const], source: "low_confidence_intent" as const, importance: 0.65 };

  it("asks the user when nothing else has the answer", () => {
    const ranked = rankGapActions(askOnly, { memoryHasAnswer: false, worldHasAnswer: false, probeWouldBeSafe: true, fileReadPermitted: false, trustedQueryEnabled: false, questionsUnmuted: true });
    expect(ranked[0].source).toBe("ask_user");
  });

  it("prefers free memory over bugging the user", () => {
    const g = { possibleSources: ["use_memory" as const, "ask_user" as const], source: "explicit_unknown" as const, importance: 0.55 };
    const ranked = rankGapActions(g, { memoryHasAnswer: true, worldHasAnswer: false, probeWouldBeSafe: true, fileReadPermitted: false, trustedQueryEnabled: false, questionsUnmuted: true });
    expect(ranked[0].source).toBe("use_memory");
    expect(ranked.find((r) => r.source === "ask_user")!.score).toBeLessThan(ranked[0].score);
  });

  it("prefers a safe probe for environment-outcome gaps", () => {
    const g = { possibleSources: ["safe_probe" as const, "ask_user" as const], source: "unverified_outcome" as const, importance: 0.75 };
    const ranked = rankGapActions(g, { memoryHasAnswer: false, worldHasAnswer: false, probeWouldBeSafe: true, fileReadPermitted: false, trustedQueryEnabled: false, questionsUnmuted: true });
    expect(ranked[0].source).toBe("safe_probe");
  });

  it("withholds entirely when no source clears the threshold", () => {
    const g = { possibleSources: ["inspect_state" as const, "safe_probe" as const], source: "stale_knowledge" as const, importance: 0.5 };
    const ranked = rankGapActions(g, { memoryHasAnswer: false, worldHasAnswer: false, probeWouldBeSafe: false, fileReadPermitted: false, trustedQueryEnabled: false, questionsUnmuted: true });
    expect(ranked[0].source).toBe("withhold");
  });

  it("never surfaces trusted_query (disabled seam)", () => {
    const g = { possibleSources: ["trusted_query" as const, "ask_user" as const], source: "explicit_unknown" as const, importance: 0.5 };
    const ranked = rankGapActions(g, { memoryHasAnswer: false, worldHasAnswer: false, probeWouldBeSafe: false, fileReadPermitted: false, trustedQueryEnabled: false, questionsUnmuted: true });
    expect(ranked[0].source).toBe("ask_user");
    expect(ranked.find((r) => r.source === "trusted_query")!.safetyFactor).toBe(0);
  });
});

describe("Phase 42 — service lifecycle & safety", () => {
  it("recommend moves gap to probing and records the interaction", async () => {
    const s = service();
    const gap = await s.captureRouteOutcome("u1", { intent: "chat", confidence: 0.4, success: false });
    const rec = await s.recommend("u1", gap!.gapId);
    expect(rec!.action).toBe("ask_user");
    const [reloaded] = await s.listOpen("u1");
    expect(reloaded.status).toBe("probing");
  });

  it("ask cooldown suppresses consecutive questions (second recommend withholds)", async () => {
    const store = new InMemoryCuriosityStore();
    const s = service(store);
    const g1 = await s.captureRouteOutcome("u1", { intent: "chat", confidence: 0.4, success: false, inputText: "thing one" });
    const first = await s.recommend("u1", g1!.gapId);
    expect(first!.action).toBe("ask_user");
    const g2 = await s.captureRouteOutcome("u1", { intent: "chat", confidence: 0.4, success: false, inputText: "thing two different" });
    const second = await s.recommend("u1", g2!.gapId);
    expect(second!.action).toBe("withhold"); // ask muted by cooldown; nothing else available
  });

  it("evicts the least important open gap at capacity (status stale, never deleted blindly)", async () => {
    const store = new InMemoryCuriosityStore();
    const s = service(store);
    for (let i = 0; i < CURIOSITY_LIMITS.maxOpenGapsPerUser; i++) {
      await s.captureRouteOutcome("u1", { intent: "chat", confidence: 0.4, success: false, inputText: `unique topic number ${i}` });
    }
    expect((await s.listOpen("u1")).length).toBe(CURIOSITY_LIMITS.maxOpenGapsPerUser);
    await s.captureRouteOutcome("u1", { intent: "open_app", confidence: 0.98, success: false, verificationStatus: "FAILED" });
    const all = await store.listGaps("u1");
    expect(all.filter((g) => g.status === "open" || g.status === "probing").length).toBe(CURIOSITY_LIMITS.maxOpenGapsPerUser);
    expect(all.some((g) => g.status === "stale")).toBe(true);
  });

  it("resolution requires evidence for high-stakes gaps; user answers only partially reduce them", async () => {
    const store = new InMemoryCuriosityStore();
    const s = service(store);
    const gap = await s.captureRouteOutcome("u1", { intent: "execute_task", confidence: 0.5, success: false, verificationStatus: "FAILED" });
    expect(gap!.importance).toBeGreaterThanOrEqual(0.75);
    // force importance to 0.9 (direct store write; the field drives the reduction rule)
    await store.upsertGap({ ...(gap!), importance: 0.9 });
    await s.resolveWithUserAnswer("u1", gap!.gapId, "the user says it worked");
    expect((await s.sufficiency("u1", gap!.gapId)).sufficient).toBe(false); // not verified yet
    await s.resolveWithEvidence("u1", gap!.gapId, "probe verified");
    expect((await s.sufficiency("u1", gap!.gapId)).sufficient).toBe(true);
  });

  it("sufficiency honestly reports insufficient information", async () => {
    const s = service();
    const gap = await s.captureRouteOutcome("u1", { intent: "chat", confidence: 0.4, success: false });
    const verdict = await s.sufficiency("u1", gap!.gapId);
    expect(verdict.sufficient).toBe(false);
    expect(verdict.reason).toContain("insufficient");
  });

  it("dismiss is terminal and idempotent", async () => {
    const s = service();
    const gap = await s.captureRouteOutcome("u1", { intent: "chat", confidence: 0.4, success: false });
    expect(await s.dismiss("u1", gap!.gapId)).toBe(true);
    expect(await s.dismiss("u1", gap!.gapId)).toBe(false);
    expect((await s.listOpen("u1"))).toHaveLength(0);
    expect(await s.sufficiency("u1", gap!.gapId)).toMatchObject({ sufficient: true, reason: "user_waived" });
  });

  it("expiry settles gaps as stale (time-controlled)", async () => {
    let clock = 1_000_000;
    const store = new InMemoryCuriosityStore();
    const s = service(store, {}, () => clock);
    await s.captureRouteOutcome("u1", { intent: "chat", confidence: 0.4, success: false });
    clock += CURIOSITY_LIMITS.gapTtlMs + 1000;
    expect((await s.listOpen("u1"))).toHaveLength(0);
    const all = await store.listGaps("u1");
    expect(all[0].status).toBe("stale");
  });

  it("cross-user isolation", async () => {
    const s = service();
    await s.captureRouteOutcome("u1", { intent: "chat", confidence: 0.4, success: false });
    expect(await s.listOpen("u2")).toHaveLength(0);
    const gap = (await s.listOpen("u1"))[0];
    expect(await s.dismiss("u2", gap.gapId)).toBe(false);
  });

  it("restart persistence through LocalCuriosityStore", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lohz-curiosity-"));
    try {
      const s1 = service(new LocalCuriosityStore(dir));
      const gap = await s1.captureRouteOutcome("u1", { intent: "chat", confidence: 0.4, success: false, inputText: "persist me" });
      await s1.recommend("u1", gap!.gapId); // logs the question => cooldown persisted
      const s2 = service(new LocalCuriosityStore(dir));
      const reloaded = await s2.listOpen("u1");
      expect(reloaded).toHaveLength(1);
      expect(reloaded[0].status).toBe("probing");
      // cooldown survived the restart
      const g2 = await s2.captureRouteOutcome("u1", { intent: "chat", confidence: 0.4, success: false, inputText: "another topic" });
      expect((await s2.recommend("u1", g2!.gapId))!.action).toBe("withhold");
      expect(ASK_COOLDOWN_MS).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
