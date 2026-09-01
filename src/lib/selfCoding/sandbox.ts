import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ProposedFilePatch, VerificationCheck, VerificationRun } from "./types";
import { SELF_CODING_LIMITS } from "./types";
import { ControlledRepository, DiagnosticArtifactStore } from "./repository";
import type { RepairCheckResult, ReproductionTarget } from "./repairTypes";
import { REPAIR_LIMITS } from "./repairTypes";

export interface SandboxExecutor {
  verify(patches: ProposedFilePatch[], checks: VerificationCheck[]): Promise<VerificationRun[]>;
}

export interface RepairSandboxExecutor extends SandboxExecutor {
  reproduce(target: ReproductionTarget): Promise<RepairCheckResult>;
  verifyTargeted(patches: ProposedFilePatch[], target: ReproductionTarget): Promise<RepairCheckResult>;
}

type FixedCommandRunner = (cwd: string, check: Exclude<VerificationCheck, "security">) => Promise<VerificationRun>;
type TargetedCommandRunner = (cwd: string, target: ReproductionTarget) => Promise<RepairCheckResult>;

/**
 * Copies only repository-allowed files and a private dependency snapshot into
 * an OS temp directory, applies patches there, and runs fixed checks.
 * No proposal data is ever interpreted as a command or command argument.
 */
export class FixedSandboxExecutor implements RepairSandboxExecutor {
  constructor(
    private readonly repositoryRoot: string,
    private readonly runner: FixedCommandRunner = runFixedCommand,
    private readonly targetedRunner: TargetedCommandRunner = runTargetedCommand,
  ) {}

  async verify(patches: ProposedFilePatch[], checks: VerificationCheck[]): Promise<VerificationRun[]> {
    const requested = [...new Set(checks)];
    if (requested.some((check) => !["tests", "typecheck", "build", "security"].includes(check))) throw new Error("unknown_verification_check");
    try {
      return await this.inSandbox(patches, async (sandboxRoot) => {
        const runs: VerificationRun[] = [];
        for (const check of requested) {
          if (check === "security") { runs.push({ check, passed: true, exitCode: 0, durationMs: 0, output: "static security policy passed before sandbox" }); continue; }
          const run = await this.runner(sandboxRoot, check); runs.push({ ...run, output: run.output.slice(-SELF_CODING_LIMITS.maxVerificationOutputChars) });
          if (!run.passed) break;
        }
        return runs;
      });
    } catch (error) {
      return [{ check: "security", passed: false, exitCode: 1, durationMs: 0, output: error instanceof Error ? error.message : "sandbox preparation failed" }];
    }
  }

  async reproduce(target: ReproductionTarget): Promise<RepairCheckResult> {
    return this.inSandbox([], async (sandboxRoot, repository) => {
      const normalized = validateTarget(repository, target);
      return this.targetedRunner(sandboxRoot, normalized);
    });
  }

  async verifyTargeted(patches: ProposedFilePatch[], target: ReproductionTarget): Promise<RepairCheckResult> {
    return this.inSandbox(patches, async (sandboxRoot, repository) => {
      const normalized = validateTarget(repository, target);
      return this.targetedRunner(sandboxRoot, normalized);
    });
  }

  private async inSandbox<T>(patches: ProposedFilePatch[], work: (root: string, repository: ControlledRepository) => Promise<T>): Promise<T> {
    const tempBase = fs.realpathSync(os.tmpdir());
    const sandboxRoot = fs.mkdtempSync(path.join(tempBase, "lohz-phase43-"));
    if (!sandboxRoot.startsWith(tempBase + path.sep)) throw new Error("unsafe_sandbox_path");
    try {
      const source = new ControlledRepository(this.repositoryRoot);
      for (const relative of source.listFiles()) {
        const file = source.readSource(relative); if (!file) continue;
        const target = path.join(sandboxRoot, ...relative.split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file.content, "utf8");
      }
      const dependencies = path.join(path.resolve(this.repositoryRoot), "node_modules");
      if (fs.existsSync(dependencies)) fs.cpSync(dependencies, path.join(sandboxRoot, "node_modules"), { recursive: true, dereference: true });
      const sandboxRepo = new ControlledRepository(sandboxRoot, new DiagnosticArtifactStore());
      if (patches.length) {
        const applied = sandboxRepo.applyPatches(patches);
        if (!applied.ok) throw new Error(`sandbox patch rejected: ${applied.error}`);
      }
      return await work(sandboxRoot, sandboxRepo);
    } finally {
      if (sandboxRoot.startsWith(tempBase + path.sep)) fs.rmSync(sandboxRoot, { recursive: true, force: true });
    }
  }
}

const COMMANDS: Record<Exclude<VerificationCheck, "security">, { command: string; args: string[] }> = {
  tests: npmInvocation(["test", "--", "--pool=forks", "--maxWorkers=1"]),
  typecheck: npmInvocation(["run", "lint"]),
  build: npmInvocation(["run", "build"]),
};

async function runFixedCommand(cwd: string, check: Exclude<VerificationCheck, "security">): Promise<VerificationRun> {
  const fixed = COMMANDS[check]; const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(fixed.command, fixed.args, {
      cwd, shell: false, windowsHide: true,
      env: safeEnvironment(), stdio: ["ignore", "pipe", "pipe"],
    });
    let output = ""; let settled = false;
    const capture = (chunk: Buffer): void => { output = (output + chunk.toString("utf8")).slice(-SELF_CODING_LIMITS.maxVerificationOutputChars); };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    const timer = setTimeout(() => {
      if (settled) return; settled = true; child.kill();
      resolve({ check, passed: false, exitCode: 124, durationMs: Date.now() - started, output: `${output}\nverification timeout` });
    }, SELF_CODING_LIMITS.verificationTimeoutMs);
    child.on("error", (error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ check, passed: false, exitCode: 1, durationMs: Date.now() - started, output: `${output}\n${error.message}` });
    });
    child.on("close", (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ check, passed: code === 0, exitCode: code ?? 1, durationMs: Date.now() - started, output });
    });
  });
}

function validateTarget(repository: ControlledRepository, target: ReproductionTarget): ReproductionTarget {
  if (target.kind === "typecheck" || target.kind === "build") return { kind: target.kind };
  if (!Array.isArray(target.testFiles) || target.testFiles.length === 0 || target.testFiles.length > REPAIR_LIMITS.testFilesPerRun) throw new Error("invalid_targeted_test_count");
  const files = [...new Set(target.testFiles.map((value) => String(value).replace(/\\/g, "/")))];
  for (const file of files) {
    if (!/(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(file) || !repository.readSource(file)) throw new Error(`targeted_test_not_allowed:${file}`);
  }
  return { kind: "test", testFiles: files };
}

async function runTargetedCommand(cwd: string, target: ReproductionTarget): Promise<RepairCheckResult> {
  const args = target.kind === "test"
    ? ["test", "--", ...target.testFiles, "--pool=forks", "--maxWorkers=1"]
    : target.kind === "typecheck" ? ["run", "lint"] : ["run", "build"];
  const fixed = npmInvocation(args);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(fixed.command, fixed.args, { cwd, shell: false, windowsHide: true, env: safeEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let settled = false;
    const capture = (chunk: Buffer): void => { output = (output + chunk.toString("utf8")).slice(-REPAIR_LIMITS.outputChars); };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    const done = (exitCode: number, suffix = ""): void => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ target, passed: exitCode === 0, exitCode, durationMs: Date.now() - started, output: `${output}${suffix}`.slice(-REPAIR_LIMITS.outputChars) });
    };
    const timer = setTimeout(() => { child.kill(); done(124, "\nreproduction timeout"); }, SELF_CODING_LIMITS.verificationTimeoutMs);
    child.on("error", (error) => done(1, `\n${error.message}`));
    child.on("close", (code) => done(code ?? 1));
  });
}

function npmInvocation(args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command: "npm", args };
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
    .filter((value): value is string => typeof value === "string" && /npm-cli\.js$/i.test(value) && path.isAbsolute(value));
  const npmCli = candidates.find((value) => fs.existsSync(value)) ?? path.join(path.dirname(process.execPath), "__lohz_fixed_npm_cli_unavailable__.js");
  return { command: process.execPath, args: [npmCli, ...args] };
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const names = ["PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec", "TEMP", "TMP"];
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", CI: "1" };
  for (const name of names) if (process.env[name]) env[name] = process.env[name];
  return env;
}
