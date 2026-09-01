import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Phase 36 authenticated server wiring", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "server.ts"), "utf8");

  it("installs /api authentication before registering learning routes", () => {
    expect(source.indexOf('app.use("/api", authMiddleware')).toBeGreaterThan(-1);
    expect(source.indexOf('app.use("/api", authMiddleware')).toBeLessThan(source.indexOf("registerLearningRoutes(app"));
  });

  it("exposes the controlled candidate, validation, replay, approval, rollback and execution lifecycle", () => {
    for (const fragment of [
      "/api/skills/detect", "/api/skills/select", "/validate", "/replay", "/request-approval", "/approve", "/reject", "/revise", "/rollback", "/execute",
    ]) expect(source).toContain(fragment);
  });

  it("wires Firestore when available and restart-safe local persistence otherwise", () => {
    expect(source).toContain("new LocalLearningStore()");
    expect(source).toContain("new FirestoreLearningStore(firestore)");
    expect(source).toContain("new SkillExecutor(");
    expect(source).toContain("observedEngine");
  });

  it("reflects newly persisted terminal experiences and exposes read-only lesson views", () => {
    expect(source).toContain("new ExperienceReflectionService(learningStore)");
    expect(source).toContain("experienceReflection.reflect(");
    expect(source).toContain('/api/learning/reflections');
    expect(source).toContain('/api/learning/lessons');
    expect(source.indexOf('app.use("/api", authMiddleware')).toBeLessThan(source.indexOf('/api/learning/lessons'));
    expect(source).not.toContain('app.post("/api/learning/lessons"');
  });

  it("wires Phase 40 evidence, calibration, personalization and approval without a client evidence-write route", () => {
    expect(source).toContain("new AdaptiveDecisionService(");
    expect(source).toContain("adaptiveDecision.observeExperience(");
    expect(source).toContain('/api/adaptation/calibration');
    expect(source).toContain('/api/adaptation/personalization');
    expect(source).toContain('/api/adaptations/propose');
    expect(source).toContain('/request-approval');
    expect(source).not.toContain('app.post("/api/adaptation/observations"');
  });
});
