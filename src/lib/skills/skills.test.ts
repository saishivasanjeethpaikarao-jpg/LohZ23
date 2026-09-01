import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryExecutionStore } from "../execution/persistence";
import { PlanExecutionEngine } from "../execution/planExecutor";
import { InMemoryObservationStore } from "../observation/observationStore";
import { ObservationCoordinator } from "../observation/observer";
import { InMemoryPlanStore } from "../planner/planPersistence";
import { SkillExecutor } from "../learning/executor";
import { SkillLearningService } from "../learning/service";
import { InMemoryLearningStore } from "../learning/store";
import { LocalLearningStore } from "../learning/durableStore";
import type { ExperienceRecord, SkillVersion } from "../learning/types";
import { SkillLibrary } from "./library";

const ENV = "windows-local";
const REGISTRY: Record<string, { name: string; risk: string; parameters: unknown }> = {
  openApp: { name: "openApp", risk: "LOW", parameters: { type: "OBJECT", required: ["name"], properties: { name: { type: "STRING" } } } },
  openUrl: { name: "openUrl", risk: "LOW", parameters: { type: "OBJECT", required: ["url"], properties: { url: { type: "STRING" } } } },
  setVolume: { name: "setVolume", risk: "LOW", parameters: { type: "OBJECT", required: [], properties: { level: { type: "INTEGER" } } } },
};

function fp(name: string) {
  const t = REGISTRY[name];
  return t ? JSON.stringify(t) : null;
}
function toolExists(name: string) { return name in REGISTRY; }

function experience(uid: string, id: string, opts: { objective?: string; tools?: string[]; signature?: string } = {}): ExperienceRecord {
  const tools = opts.tools ?? ["openApp", "openUrl"];
  const objective = opts.objective ?? "start my development environment";
  const signature = opts.signature ?? `windows-local|${tools.join(">")}|start-my-development-environment`;
  return {
    id, uid, objective,
    context: { environment: ENV, signature, tags: [] },
    planId: `plan-${id}`, planVersion: 1, requestId: `req-${id}`,
    steps: tools.map((tool, i) => ({
      stepId: `s${i + 1}`, index: i, title: `Step ${tool}`, toolName: tool,
      arguments: tool === "openApp" ? { name: "VS Code" } : tool === "openUrl" ? { url: "http://localhost:3000" } : {},
      dependencies: i > 0 ? [`s${i}`] : [], expectedOutcome: "done", riskLevel: "low" as const,
      outcome: "completed" as const, attempts: 1, durationMs: 10, failureCode: null, verification: "VERIFIED" as const,
    })),
    outcome: "success", failures: [], recovery: { attempted: false, succeeded: false, actions: [] },
    replans: { count: 0, planIds: [`plan-${id}`] }, verification: "VERIFIED", success: true, userCorrections: [],
    source: { executionRequestIds: [`req-${id}`], observationIds: [] }, createdAt: Number(id.replace(/\D/g, "")) || 1, schemaVersion: 1,
  };
}

function makeLib(store = new InMemoryLearningStore()) {
  const fingerprintCalls: string[] = [];
  const fpFn = (name: string) => { fingerprintCalls.push(name); return fp(name); };
  const service = new SkillLearningService(store, () => Object.keys(REGISTRY), Date.now, fpFn);
  const planStore = new InMemoryPlanStore();
  const executionStore = new InMemoryExecutionStore();
  const observationStore = new InMemoryObservationStore();
  const runner = vi.fn(async (_u: string, tool: string) => tool === "listWindows" ? { ok: true, result: ["VS Code"] } : { ok: true, result: "ok" });
  const observer = new ObservationCoordinator({ store: observationStore, probeRunner: runner, sleep: async () => undefined });
  const engine = new PlanExecutionEngine({
    store: executionStore, planStore, toolCatalog: () => ["openApp", "listWindows", "openUrl", "setVolume"],
    runner,
    observation: { executeVerifiedStep: (u, p, r, s, ex) => observer.executeVerifiedStep(u, p, r, s, ex) },
  });
  const executor = new SkillExecutor(store, planStore, engine, service, observationStore, () => 10);
  const library = new SkillLibrary({ store, service, executor, observations: observationStore, toolExists, toolFingerprint: fpFn, environment: () => ENV });
  return { store, service, library, executor, runner, observationStore, planStore, engine, fingerprintCalls };
}

async function toPromoted(lib: ReturnType<typeof makeLib>, uid = "u1") {
  for (let i = 1; i <= 3; i++) await lib.service.ingestExperience(experience(uid, `e${i}`));
  const [candidate] = await lib.service.detectCandidates(uid);
  expect(candidate).toBeDefined();
  expect((await lib.service.validate(uid, candidate.skillId, 1)).ok).toBe(true);
  expect((await lib.service.replay(uid, candidate.skillId, 1)).ok).toBe(true);
  await lib.service.requestApproval(uid, candidate.skillId, 1, "appr-1");
  expect(await lib.library.approve(uid, candidate.skillId, 1, "appr-1")).toBe(true);
  return candidate;
}

describe("Phase 38 — Versioned Skill Library", () => {
  it("exposes the mandated Skill schema fields", async () => {
    const ctx = makeLib();
    const cand = await toPromoted(ctx);
    const skill = await ctx.library.get("u1", cand.skillId, 1);
    expect(skill).toMatchObject({
      skillId: cand.skillId,
      version: 1,
      ownerUserId: "u1",
      status: "active",
      successCount: 3,
      failureCount: 0,
    });
    expect(typeof skill!.name).toBe("string");
    expect(skill!.planTemplate.steps.length).toBe(2);
    expect(skill!.riskProfile.policyMutable).toBe(false);
    expect(Number.isNaN(Date.parse(skill!.createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(skill!.updatedAt))).toBe(false);
    expect(skill!.inputSchema).toBeNull();
  });

  it("detection requires repeated verified workflow (>=3)", async () => {
    const ctx = makeLib();
    await ctx.service.ingestExperience(experience("u1", "e1"));
    await ctx.service.ingestExperience(experience("u1", "e2"));
    expect(await ctx.service.detectCandidates("u1")).toHaveLength(0);
    await ctx.service.ingestExperience(experience("u1", "e3"));
    const cands = await ctx.service.detectCandidates("u1");
    expect(cands).toHaveLength(1);
    const view = await ctx.library.get("u1", cands[0].skillId, 1);
    expect(view!.status).toBe("candidate");
  });

  it("validates parameterized candidates, including a proper inputSchema", async () => {
    const ctx = makeLib();
    const cand = await toPromoted(ctx);
    const v2 = await ctx.service.revise("u1", cand.skillId, 1, [
      { id: "s1", index: 0, title: "Open app", description: "open", toolName: "openApp", arguments: { name: "${appName}" }, dependencies: [], expectedOutcome: "ok", riskLevel: "low", timeoutMs: 5000, maxRetries: 0 },
    ], { inputSchema: { appName: { type: "string", required: true, description: "app to open" } } });
    expect(v2!.version).toBe(2);
    expect(v2!.status).toBe("candidate");
    const ok = await ctx.service.validate("u1", cand.skillId, 2);
    expect(ok.ok).toBe(true);
    expect(ok.issues).toHaveLength(0);
  });

  it("rejects a malicious inputSchema at validation (bad key / type / partial placeholder)", async () => {
    const ctx = makeLib();
    const cand = await toPromoted(ctx);
    const badSchemas = [
      // __proto__ as it actually arrives over the wire (JSON parse creates an OWN property)
      JSON.parse('{"veryBad":{"type":"string","required":true},"__proto__":{"type":"string","required":true}}'),
      { ok: { type: "any", required: true } },
      (() => { const s: Record<string, unknown> = {}; for (let i = 0; i < 9; i++) s[`in${i}`] = { type: "string", required: true }; return s; })(),
      { good: { type: "enum", required: true } },               // enum without options
      { good: { type: "enum", required: true, enum: [] } },     // empty enum
      { good: { type: "string", required: true, default: 42 } },// default type mismatch
    ];
    for (const bad of badSchemas) {
      const v = await ctx.service.revise("u1", cand.skillId, 1, [
        { id: "s1", index: 0, title: "t", description: "d", toolName: "openApp", arguments: { name: "V" }, dependencies: [], expectedOutcome: "o", riskLevel: "low", timeoutMs: 5000, maxRetries: 0 },
      ], { inputSchema: bad });
      expect(v).not.toBeNull();
      const res = await ctx.service.validate("u1", cand.skillId, v!.version);
      expect(res.ok).toBe(false);
      expect(res.issues.join(",")).toMatch(/input_schema|invalid_input|invalid_enum|default_type/);
    }
    // partial placeholder (embedded in a normal string) is a smuggling vector
    const v2 = await ctx.service.revise("u1", cand.skillId, 1, [
      { id: "s1", index: 0, title: "t", description: "d", toolName: "openApp", arguments: { name: "pre-${appName}" }, dependencies: [], expectedOutcome: "o", riskLevel: "low", timeoutMs: 5000, maxRetries: 0 },
    ], { inputSchema: { appName: { type: "string", required: true } } });
    const res2 = await ctx.service.validate("u1", cand.skillId, v2!.version);
    expect(res2.ok).toBe(false);
    expect(res2.issues.join(",")).toContain("partial_placeholder");
    // placeholder with no schema at all
    const v3 = await ctx.service.revise("u1", cand.skillId, 1, [
      { id: "s1", index: 0, title: "t", description: "d", toolName: "openApp", arguments: { name: "${appName}" }, dependencies: [], expectedOutcome: "o", riskLevel: "low", timeoutMs: 5000, maxRetries: 0 },
    ]);
    const res3 = await ctx.service.validate("u1", cand.skillId, v3!.version);
    expect(res3.ok).toBe(false);
  });

  it("owner isolation: cannot approve/get/deprecate another user's skill", async () => {
    const ctx = makeLib();
    const cand = await toPromoted(ctx);
    expect(await ctx.library.get("u2", cand.skillId, 1)).toBeNull();
    expect(await ctx.library.approve("u2", cand.skillId, 2, "x")).toBe(false);
    expect(await ctx.library.deprecate("u2", cand.skillId, 1)).toBe(false);
    expect(await ctx.library.deprecate("u1", cand.skillId, 1)).toBe(true);
    expect((await ctx.library.get("u1", cand.skillId, 1))!.status).toBe("deprecated");
  });

  it("versioning: registry drift degrades the active skill and queues candidate v2, preserving the original graph", async () => {
    const ctx = makeLib();
    const cand = await toPromoted(ctx);
    const before = await ctx.library.get("u1", cand.skillId, 1);
    expect(before!.status).toBe("active");
    const originalGraph = JSON.stringify(before!.planTemplate.steps);

    // simulate registry change: openApp risk/schema changed (fingerprint fn reads live REGISTRY)
    REGISTRY.openApp = { name: "openApp", risk: "MEDIUM", parameters: { type: "OBJECT", required: ["name"], properties: { name: { type: "STRING" } } } };
    try {
      const report = await ctx.library.revalidateAgainstRegistry("u1");
      expect(report.degraded).toHaveLength(1);
      expect(report.degraded[0].reason).toContain("tool_changed:openApp");
      expect(report.candidatesCreated).toHaveLength(1);
      const after = await ctx.library.get("u1", cand.skillId, 1);
      expect(after!.status).toBe("degraded");
      expect(JSON.stringify(after!.planTemplate.steps)).toBe(originalGraph); // original never mutated
      const v2 = await ctx.store.getSkillVersion("u1", cand.skillId, 2);
      expect(v2?.status).toBe("candidate");
      expect(v2?.replacesVersion).toBe(1);
      // Second sweep does not stack another candidate
      const again = await ctx.library.revalidateAgainstRegistry("u1");
      expect(again.candidatesCreated).toHaveLength(0);
    } finally {
      REGISTRY.openApp = { name: "openApp", risk: "LOW", parameters: { type: "OBJECT", required: ["name"], properties: { name: { type: "STRING" } } } };
    }
  });

  it("tool removal degrades the skill too", async () => {
    const ctx = makeLib();
    const cand = await toPromoted(ctx);
    delete (REGISTRY as any).openApp;
    try {
      const report = await ctx.library.revalidateAgainstRegistry("u1");
      expect(report.degraded[0].reason).toContain("tool_removed:openApp");
      expect((await ctx.library.get("u1", cand.skillId, 1))!.status).toBe("degraded");
    } finally {
      REGISTRY.openApp = { name: "openApp", risk: "LOW", parameters: { type: "OBJECT", required: ["name"], properties: { name: { type: "STRING" } } } };
    }
  });

  it("executes an active skill through the normal engine (verification + observation)", async () => {
    const ctx = makeLib();
    const cand = await toPromoted(ctx);
    const result = await ctx.library.executeSkill("u1", cand.skillId, 1, { confirmed: true, requestId: "run-1" });
    expect(result.error).toBeUndefined();
    expect(result.outcome?.authorization).toBe("AUTHORIZED");
    const reliability = await ctx.store.getSkillReliability("u1", cand.skillId, 1, ENV);
    expect(reliability).not.toBeNull();
  });

  it("never bypasses confirmation on medium-risk skill", async () => {
    const ctx = makeLib();
    const cand = await toPromoted(ctx);
    // Inject a medium-risk tool and drive a revision through the FULL pipeline.
    REGISTRY.writeFile = { name: "writeFile", risk: "MEDIUM", parameters: { type: "OBJECT", required: ["path", "content"], properties: {} } };
    try {
      const v2 = await ctx.service.revise("u1", cand.skillId, 1, [
        { id: "s1", index: 0, title: "write file", description: "d", toolName: "writeFile", arguments: { path: "a.txt", content: "hi" }, dependencies: [], expectedOutcome: "o", riskLevel: "medium", timeoutMs: 5000, maxRetries: 0 },
      ]);
      expect((await ctx.service.validate("u1", cand.skillId, v2!.version)).ok).toBe(true);
      expect((await ctx.service.replay("u1", cand.skillId, v2!.version)).ok).toBe(false); // source fingerprint mismatch
      // Force-promote path is impossible without replay; use the store-level flow only via rollback:
      // instead mark promotion honestly with approvals on a fresh candidate built from matching sources.
      for (let i = 10; i <= 12; i++) {
        const e = experience("u1", `e${i}`, { tools: ["writeFile"], signature: "windows-local|writeFile|write-file" });
        e.steps[0].arguments = { path: "a.txt", content: "hi" };
        e.steps[0].riskLevel = "medium";
        e.steps[0].title = "write file";
        e.steps[0].expectedOutcome = "o";
        e.steps[0].stepId = "s1";
        await ctx.service.ingestExperience(e);
      }
      const [cand2] = (await ctx.service.detectCandidates("u1")).filter((c) => c.skillId !== cand.skillId);
      expect(cand2).toBeDefined();
      expect((await ctx.service.validate("u1", cand2.skillId, 1)).ok).toBe(true);
      expect((await ctx.service.replay("u1", cand2.skillId, 1)).ok).toBe(true);
      await ctx.service.requestApproval("u1", cand2.skillId, 1, "appr-m");
      expect(await ctx.library.approve("u1", cand2.skillId, 1, "appr-m")).toBe(true);
      // Unconfirmed medium-risk skill must pause for confirmation, and NO tool runs.
      const r1 = await ctx.library.executeSkill("u1", cand2.skillId, 1, { confirmed: false, requestId: "run-medium" });
      expect(r1.outcome?.authorization).toBe("REQUIRES_CONFIRMATION");
      expect(ctx.runner).not.toHaveBeenCalled();
      // Confirmed medium-risk executes through the engine.
      const r2 = await ctx.library.executeSkill("u1", cand2.skillId, 1, { confirmed: true, requestId: "run-medium-2" });
      expect(r2.outcome?.recordStatus).toBe("completed");
    } finally {
      delete REGISTRY.writeFile;
    }
  });

  it("a repeatedly-failing active skill becomes degraded (library view) without graph mutation", async () => {
    const ctx = makeLib();
    const cand = await toPromoted(ctx);
    const before = JSON.stringify((await ctx.library.get("u1", cand.skillId, 1))!.planTemplate.steps);
    for (let i = 0; i < 3; i++) await ctx.service.recordSkillOutcome("u1", cand.skillId, 1, ENV, "FAILED", "tool_error");
    const view = await ctx.library.get("u1", cand.skillId, 1);
    expect(view!.status).toBe("degraded");
    expect(JSON.stringify(view!.planTemplate.steps)).toBe(before);
    expect(await ctx.library.executeSkill("u1", cand.skillId, 1, { confirmed: true, requestId: "run-fail" })).toMatchObject({ error: expect.stringContaining("not_selectable") });
  });

  it("deprecated skills are not selectable or executable", async () => {
    const ctx = makeLib();
    const cand = await toPromoted(ctx);
    await ctx.library.deprecate("u1", cand.skillId, 1);
    expect(await ctx.library.matchPlanForObjective("u1", "start my development environment", ENV)).toBeNull();
    expect((await ctx.library.executeSkill("u1", cand.skillId, 1, { confirmed: true })).error).toBeDefined();
  });

  it("malicious skill data: unknown inputs rejected at execute time", async () => {
    const ctx = makeLib();
    const cand = await toPromoted(ctx);
    const r = await ctx.library.executeSkill("u1", cand.skillId, 1, { confirmed: true, inputs: { evil: "x" } as any });
    expect(r.error).toBe("invalid_skill_inputs");
  });

  it("restart persistence survives degradation through LocalLearningStore", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lohz-skills-"));
    try {
      const store1 = new LocalLearningStore(dir);
      const svc1 = new SkillLearningService(store1, () => Object.keys(REGISTRY), Date.now, fp);
      for (let i = 1; i <= 3; i++) await svc1.ingestExperience(experience("u1", `e${i}`));
      const [c] = await svc1.detectCandidates("u1");
      expect((await svc1.validate("u1", c.skillId, 1)).ok).toBe(true);
      expect((await svc1.replay("u1", c.skillId, 1)).ok).toBe(true);
      await svc1.requestApproval("u1", c.skillId, 1, "appr-rs");
      expect(await svc1.approveAndPromote("u1", c.skillId, 1, { authenticatedUserId: "u1", approvalRequestId: "appr-rs", approved: true })).toBe(true);
      await svc1.markDegraded("u1", c.skillId, 1, "tool_removed:openApp", "abc123");
      // reopen from disk
      const store2 = new LocalLearningStore(dir);
      const lib2 = new SkillLibrary({
        store: store2, service: new SkillLearningService(store2, () => Object.keys(REGISTRY), Date.now, fp),
        executor: {} as unknown as SkillExecutor, observations: new InMemoryObservationStore(),
        toolExists, toolFingerprint: fp, environment: () => ENV,
      });
      const view = await lib2.get("u1", c.skillId, 1);
      expect(view!.status).toBe("degraded");
      const raw = await store2.getSkillVersion("u1", c.skillId, 1);
      expect(raw!.status).toBe("degraded");
      expect(raw!.degradation!.reason).toBe("tool_removed:openApp");
      expect(raw!.degradation!.catalogFingerprint).toBe("abc123");
      expect(raw!.updatedAt).toBeGreaterThanOrEqual(raw!.createdAt);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("cross-user concurrent isolation: u1 skills invisible to u2", async () => {
    const ctx = makeLib();
    await toPromoted(ctx);
    expect(await ctx.library.get("u2", (await ctx.store.listSkillVersions("u1"))[0].skillId, 1)).toBeNull();
    expect(await ctx.library.list("u2")).toHaveLength(0);
  });
});


