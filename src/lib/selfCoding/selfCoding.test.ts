import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockFirestore } from "../persistence/mockFirestore";
import { CodeChangeProposalEngine } from "./engine";
import { FirestoreSelfCodingStore } from "./firestoreStore";
import { LocalSelfCodingStore } from "./localStore";
import { evaluatePatchSecurity } from "./policy";
import { ControlledRepository, DiagnosticArtifactStore } from "./repository";
import { FixedSandboxExecutor, type SandboxExecutor } from "./sandbox";
import { InMemorySelfCodingStore, type SelfCodingStore } from "./store";
import type { ProposedFilePatch, VerificationRun } from "./types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(): { root: string; repo: ControlledRepository; sourceHash: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lohz-self-code-")); roots.push(root);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest", lint: "tsc", build: "vite build" } }));
  fs.writeFileSync(path.join(root, "src", "math.ts"), "export const add = (a: number, b: number) => a - b;\n");
  fs.writeFileSync(path.join(root, "src", "consumer.ts"), 'import { add } from "./math";\nexport const total = add(1, 2);\n');
  fs.writeFileSync(path.join(root, ".env"), "SECRET=never-read\n");
  const artifacts = new DiagnosticArtifactStore(); artifacts.add("error_log", "add(1, 2) returned -1"); artifacts.add("build_output", "build failed in src/math.ts");
  const repo = new ControlledRepository(root, artifacts);
  return { root, repo, sourceHash: repo.readSource("src/math.ts")!.reference.sha256 };
}

function patches(hash: string): ProposedFilePatch[] {
  return [
    { path: "src/math.ts", operation: "update", expectedSha256: hash, hunks: [{ oldText: "a - b", newText: "a + b" }] },
    { path: "src/math.test.ts", operation: "create", expectedSha256: null, hunks: [{ oldText: "", newText: 'import { describe, expect, it } from "vitest";\nimport { add } from "./math";\ndescribe("add", () => { it("adds", () => expect(add(1, 2)).toBe(3)); });\n' }] },
  ];
}

const passingSandbox: SandboxExecutor = {
  verify: async (_patches, checks) => checks.map((check) => ({ check, passed: true, exitCode: 0, durationMs: 1, output: `${check} passed` })),
};

function engine(repo: ControlledRepository, store: SelfCodingStore = new InMemorySelfCodingStore(), sandbox: SandboxExecutor = passingSandbox) {
  return new CodeChangeProposalEngine({ repository: repo, store, sandbox });
}

async function proposal(service: CodeChangeProposalEngine, hash: string, proposalId = "fix-add") {
  return service.create({
    uid: "admin-a", proposalId, kind: "bug_fix", title: "Fix addition", reason: "add subtracts",
    requirement: "Correct add in src math", errorLog: "add returned -1", patches: patches(hash), tests: ["add(1, 2) returns 3"],
  });
}

describe("Phase 43 controlled repository", () => {
  it("reads/searches source and tests without exposing arbitrary files", () => {
    const { repo } = fixture();
    expect(repo.readSource("src/math.ts")?.content).toContain("a - b");
    expect(repo.searchSymbols("add").map((hit) => hit.path)).toContain("src/math.ts");
    expect(repo.dependencies("src/consumer.ts")[0].resolvedPath).toBe("src/math.ts");
    expect(repo.readSource(".env")).toBeNull();
    expect(repo.readSource("../outside.txt")).toBeNull();
    expect(repo.readErrorLog()?.content).toContain("returned -1");
    expect(repo.readBuildOutput()?.content).toContain("build failed");
  });

  it("identifies direct and dependent affected files with hashes", () => {
    const { repo } = fixture();
    const affected = repo.identifyAffectedFiles("Fix the add function in math", "src/math.ts returned wrong total");
    expect(affected.map((file) => file.path)).toEqual(expect.arrayContaining(["src/math.ts", "src/consumer.ts"]));
    expect(affected.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
  });

  it("requires exact hashes and unambiguous hunks", () => {
    const { repo, sourceHash } = fixture();
    expect(() => repo.previewPatches(patches("stale"))).toThrow("stale_file");
    expect(repo.previewPatches(patches(sourceHash)).get("src/math.ts")).toContain("a + b");
  });

  it("rejects writes through a repository-internal junction", () => {
    const { root, repo } = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lohz-self-code-outside-")); roots.push(outside);
    fs.symlinkSync(outside, path.join(root, "src", "external"), "junction");
    expect(() => repo.previewPatches([{ path: "src/external/escape.ts", operation: "create", expectedSha256: null, hunks: [{ oldText: "", newText: "export const escaped = true;" }] }])).toThrow("path_not_allowed");
  });
});

describe("Phase 43 security policy", () => {
  it("blocks authentication, credential, safety, shell, and test-disable changes", () => {
    const result = evaluatePatchSecurity([
      { path: "server/authMiddleware.ts", operation: "update", expectedSha256: "x", hunks: [{ oldText: "safe", newText: "allow all" }] },
      { path: "src/feature.ts", operation: "create", expectedSha256: null, hunks: [{ oldText: "", newText: 'import { exec } from "node:child_process"; exec(userInput);' }] },
      { path: "src/feature.test.ts", operation: "create", expectedSha256: null, hunks: [{ oldText: "", newText: 'it.skip("security", () => {});' }] },
    ], ["security test"]);
    expect(result.passed).toBe(false);
    expect(result.issues.join(" ")).toMatch(/protected_path|arbitrary_process_execution|test_disabling/);
  });

  it("blocks self-modification and proposals without generated test patches", () => {
    const self = evaluatePatchSecurity([{ path: "src/lib/selfCoding/policy.ts", operation: "update", expectedSha256: "x", hunks: [{ oldText: "x", newText: "y" }] }], ["test"]);
    expect(self.issues).toContain("self_modification_kernel:src/lib/selfCoding/policy.ts");
    const noTest = evaluatePatchSecurity([{ path: "src/feature.ts", operation: "create", expectedSha256: null, hunks: [{ oldText: "", newText: "export const x = 1;" }] }], ["test"]);
    expect(noTest.issues).toContain("test_patch_required");
  });
});

describe("Phase 43 proposal lifecycle", () => {
  it("diagnoses, verifies, requires matching approval, applies, and records every transition", async () => {
    const { repo, sourceHash } = fixture(); const service = engine(repo);
    const created = await proposal(service, sourceHash); expect(created?.status).toBe("proposed");
    expect(created?.affectedFiles.map((file) => file.path)).toContain("src/math.ts");
    expect((await service.apply("admin-a", "fix-add", 1))).toBeNull();
    const verified = await service.verify("admin-a", "fix-add", 1); expect(verified?.status).toBe("sandbox_verified");
    const request = await service.requestApproval("admin-a", "fix-add", 1); expect(request).not.toBeNull();
    expect(await service.approve({ uid: "admin-a", proposalId: "fix-add", version: 1, approvalRequestId: "wrong", approved: true })).toBeNull();
    const approved = await service.approve({ uid: "admin-a", proposalId: "fix-add", version: 1, approvalRequestId: request!.approvalRequestId, approved: true });
    expect(approved?.status).toBe("approved");
    const applied = await service.apply("admin-a", "fix-add", 1); expect(applied?.status).toBe("applied");
    expect(repo.readSource("src/math.ts")?.content).toContain("a + b");
    expect(repo.readSource("src/math.test.ts")).not.toBeNull();
    expect((await service.audit("admin-a", "fix-add")).map((event) => event.type)).toEqual([
      "proposal_created", "verification_completed", "approval_requested", "approved", "apply_started", "applied",
    ]);
  });

  it("fails verification closed and cannot request approval", async () => {
    const { repo, sourceHash } = fixture();
    const sandbox: SandboxExecutor = { verify: async () => [{ check: "tests", passed: false, exitCode: 1, durationMs: 2, output: "test failed" }] };
    const service = engine(repo, new InMemorySelfCodingStore(), sandbox);
    await proposal(service, sourceHash);
    expect((await service.verify("admin-a", "fix-add", 1))?.status).toBe("verification_failed");
    expect(await service.requestApproval("admin-a", "fix-add", 1)).toBeNull();
  });

  it("rejects apply when an affected source changed after sandbox verification", async () => {
    const { root, repo, sourceHash } = fixture(); const service = engine(repo);
    await proposal(service, sourceHash); await service.verify("admin-a", "fix-add", 1);
    const request = await service.requestApproval("admin-a", "fix-add", 1);
    await service.approve({ uid: "admin-a", proposalId: "fix-add", version: 1, approvalRequestId: request!.approvalRequestId, approved: true });
    fs.appendFileSync(path.join(root, "src", "consumer.ts"), "// concurrent change\n");
    expect(await service.apply("admin-a", "fix-add", 1)).toBeNull();
    expect(repo.readSource("src/math.ts")?.content).toContain("a - b");
  });

  it("isolates users and allows only one concurrent approval request", async () => {
    const { repo, sourceHash } = fixture(); const service = engine(repo);
    await proposal(service, sourceHash); await service.verify("admin-a", "fix-add", 1);
    expect(await service.get("admin-b", "fix-add", 1)).toBeNull();
    const requests = await Promise.all([
      service.requestApproval("admin-a", "fix-add", 1), service.requestApproval("admin-a", "fix-add", 1),
    ]);
    expect(requests.filter(Boolean)).toHaveLength(1);
  });

  it("persists proposal and immutable audit across restart", async () => {
    const { root, repo, sourceHash } = fixture(); const storeRoot = path.join(root, "audit-store");
    const first = engine(repo, new LocalSelfCodingStore(storeRoot)); await proposal(first, sourceHash);
    const restarted = engine(repo, new LocalSelfCodingStore(storeRoot));
    expect((await restarted.get("admin-a", "fix-add", 1))?.proposalDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await restarted.audit("admin-a", "fix-add")).toHaveLength(1);
  });

  it("versions proposals transactionally in Firestore and preserves user isolation", async () => {
    const { repo, sourceHash } = fixture(); const store = new FirestoreSelfCodingStore(new MockFirestore(), () => undefined);
    const service = engine(repo, store); const first = await proposal(service, sourceHash, "versioned");
    const second = await proposal(service, sourceHash, "versioned");
    expect([first?.version, second?.version]).toEqual([1, 2]);
    expect(await store.getProposal("admin-b", "versioned", 1)).toBeNull();
  });
});

describe("Phase 43 fixed sandbox", () => {
  it("maps enum checks to fixed runner calls and never accepts command text", async () => {
    const { root, sourceHash } = fixture(); const calls: string[] = [];
    const sandbox = new FixedSandboxExecutor(root, async (_cwd, check): Promise<VerificationRun> => {
      calls.push(check); return { check, passed: true, exitCode: 0, durationMs: 1, output: "ok" };
    });
    const runs = await sandbox.verify(patches(sourceHash), ["security", "tests", "typecheck", "build"]);
    expect(calls).toEqual(["tests", "typecheck", "build"]);
    expect(runs.every((run) => run.passed)).toBe(true);
  });
});
