import { createHash } from "node:crypto";
import type { CodeChangeProposal, ProposedFilePatch, SecurityEvaluation } from "./types";
import { SELF_CODING_LIMITS } from "./types";

const PROTECTED_PATHS = new Set([
  "server.ts",
  "server/selfCoding.ts",
  "server/authMiddleware.ts",
  "server/credentialAccess.ts",
  "src/credentialStore.ts",
  "src/lib/execution/policy.ts",
  "src/lib/execution/guards.ts",
  "src/lib/cognitive/cognitiveGuards.ts",
  "windows-agent/toolRegistry.ts",
  "windows-agent/utils/validation.ts",
  "firestore.rules",
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
  "vitest.emulator.config.ts",
]);

const PROTECTED_PATTERNS = [
  /(^|\/)auth(?:entication|orization)?[^/]*\.[cm]?[jt]sx?$/i,
  /(^|\/)(?:credential|secret|safetyKernel)[^/]*\.[cm]?[jt]sx?$/i,
  /(^|\/)\.env/i,
];

const FORBIDDEN_ADDITIONS: Array<{ pattern: RegExp; issue: string }> = [
  { pattern: /(?:node:)?child_process/, issue: "arbitrary_process_execution" },
  { pattern: /\b(?:exec|execSync|spawn|spawnSync)\s*\(/, issue: "arbitrary_process_execution" },
  { pattern: /\beval\s*\(|\bnew\s+Function\s*\(/, issue: "dynamic_code_execution" },
  { pattern: /shell\s*:\s*true/, issue: "shell_execution" },
  { pattern: /process\.env\s*(?:\.|\[)/, issue: "credential_or_environment_access" },
  { pattern: /(?:node:)?fs(?:\/promises)?["']|\bfs\.(?:read|write|rm|unlink|rename|copy|createWrite)/, issue: "arbitrary_filesystem_access" },
  { pattern: /process\.cwd\s*\(/, issue: "arbitrary_filesystem_access" },
  { pattern: /\b(?:describe|it|test)\.skip\s*\(/, issue: "test_disabling" },
  { pattern: /@ts-ignore|eslint-disable|coverage\s+ignore/i, issue: "verification_suppression" },
  { pattern: /allow\s+(?:read|write|create|update|delete)[^\n]*:\s*if\s+true/i, issue: "security_rule_bypass" },
  { pattern: /(?:bypass|disable|skip)[A-Za-z_]*(?:Auth|Authorization|Security|Safety)/i, issue: "security_bypass" },
];

export function evaluatePatchSecurity(patches: ProposedFilePatch[], tests: string[], now = Date.now()): SecurityEvaluation {
  const issues: string[] = [];
  if (patches.length === 0) issues.push("no_patch_operations");
  if (patches.length > SELF_CODING_LIMITS.maxPatches) issues.push("too_many_patch_files");
  if (tests.length === 0) issues.push("tests_required");
  if (!patches.some((patch) => /(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(patch.path.replace(/\\/g, "/")))) issues.push("test_patch_required");
  const seen = new Set<string>();
  for (const patch of patches) {
    const normalized = patch.path.replace(/\\/g, "/");
    if (seen.has(normalized)) issues.push(`duplicate_patch:${normalized}`); seen.add(normalized);
    if (PROTECTED_PATHS.has(normalized) || PROTECTED_PATTERNS.some((pattern) => pattern.test(normalized))) issues.push(`protected_path:${normalized}`);
    if (normalized.startsWith("src/lib/selfCoding/")) issues.push(`self_modification_kernel:${normalized}`);
    if (normalized.startsWith("scripts/")) issues.push(`protected_verification_runner:${normalized}`);
    if (patch.hunks.length === 0 || patch.hunks.length > SELF_CODING_LIMITS.maxHunksPerPatch) issues.push(`invalid_hunk_count:${normalized}`);
    const isTest = /(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(normalized);
    for (const hunk of patch.hunks) {
      if (isTest && patch.operation === "update") issues.push(`existing_test_modification:${normalized}`);
      for (const forbidden of FORBIDDEN_ADDITIONS) if (forbidden.pattern.test(hunk.newText)) issues.push(`${forbidden.issue}:${normalized}`);
      if (hunk.newText.length + hunk.oldText.length > SELF_CODING_LIMITS.maxPatchTextChars) issues.push(`patch_too_large:${normalized}`);
    }
  }
  return { passed: issues.length === 0, checkedAt: now, policyVersion: 1, issues: [...new Set(issues)].slice(0, 100) };
}

export function proposalContentDigest(input: {
  kind: CodeChangeProposal["kind"];
  title: string; reason: string; requirement: string; diagnosis: string; rootCauseHypothesis: string;
  patches: ProposedFilePatch[]; tests: string[]; version: number;
}): string {
  return digest({
    kind: input.kind, title: input.title, reason: input.reason, requirement: input.requirement,
    diagnosis: input.diagnosis, rootCauseHypothesis: input.rootCauseHypothesis,
    patches: input.patches, tests: [...input.tests].sort(), version: input.version,
  });
}

export function verifiedApprovalDigest(proposal: CodeChangeProposal): string {
  return digest({
    proposalDigest: proposal.proposalDigest,
    verification: proposal.verification.map((run) => ({ check: run.check, passed: run.passed, exitCode: run.exitCode, outputDigest: digest(run.output) })),
    security: proposal.security,
  });
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
