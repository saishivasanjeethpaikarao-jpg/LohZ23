import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ControlledRepository } from "../selfCoding/repository";

export class RepositoryInspector {
  private readonly repository: ControlledRepository;
  private readonly root: string;
  constructor(root: string) { this.root = fs.realpathSync(path.resolve(root)); this.repository = new ControlledRepository(this.root); }
  listFiles(): string[] { return this.repository.listFiles(); }
  readFile(relativePath: string) { return this.repository.readSource(relativePath); }
  search(query: string) { return this.repository.searchSymbols(query); }
  dependencies(relativePath: string) { return this.repository.dependencies(relativePath); }
  tests() { return this.repository.readTests(); }
  packageManifest(): Record<string, unknown> | null { const value = this.repository.readSource("package.json"); if (!value) return null; try { return JSON.parse(value.content) as Record<string, unknown>; } catch { return null; } }
  gitStatus(): string { return fixedGit(this.root, ["status", "--short"]); }
  recentCommits(limit = 10): string { const bounded = Math.max(1, Math.min(20, Math.floor(limit))); return fixedGit(this.root, ["log", "--oneline", `-${bounded}`]); }
}

function fixedGit(cwd: string, args: string[]): string {
  try { return execFileSync("git", args, { cwd, shell: false, windowsHide: true, encoding: "utf8", timeout: 10_000, maxBuffer: 100_000 }).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").slice(0, 20_000); } catch { return "git_inspection_unavailable"; }
}
