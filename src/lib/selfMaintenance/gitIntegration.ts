import { execFile } from "node:child_process";
import path from "node:path";

export interface GitCommandRunner { (cwd: string, args: string[]): Promise<{ code: number; output: string }>; }
export class ControlledGitIntegration {
  constructor(private readonly root: string, private readonly run: GitCommandRunner = runGit) {}
  async commitApproved(input: { approved: boolean; incidentId: string; proposalId: string; files: string[] }): Promise<{ committed: boolean; output: string }> {
    if (!input.approved || !/^[A-Za-z0-9_.:-]{1,160}$/.test(input.incidentId) || !/^[A-Za-z0-9_.:-]{1,160}$/.test(input.proposalId)) return { committed: false, output: "explicit_approval_and_safe_ids_required" };
    const files = [...new Set(input.files.map((file) => file.replace(/\\/g, "/")))];
    if (!files.length || files.some((file) => path.posix.isAbsolute(file) || file.startsWith("../") || file.includes("\0"))) return { committed: false, output: "unsafe_git_paths" };
    const add = await this.run(this.root, ["add", "--", ...files]); if (add.code !== 0) return { committed: false, output: add.output.slice(-2_000) };
    const message = `maintenance(${input.incidentId}): apply approved proposal ${input.proposalId}`; const commit = await this.run(this.root, ["commit", "-m", message]);
    return { committed: commit.code === 0, output: commit.output.slice(-2_000) };
  }
  async rollback(commitSha: string, approved: boolean): Promise<{ rolledBack: boolean; output: string }> { if (!approved || !/^[0-9a-f]{7,64}$/i.test(commitSha)) return { rolledBack: false, output: "explicit_approval_and_commit_sha_required" }; const result = await this.run(this.root, ["revert", "--no-edit", commitSha]); return { rolledBack: result.code === 0, output: result.output.slice(-2_000) }; }
}
function runGit(cwd: string, args: string[]): Promise<{ code: number; output: string }> { return new Promise((resolve) => { const child = execFile("git", args, { cwd, shell: false, windowsHide: true, timeout: 30_000 }, (error, stdout, stderr) => resolve({ code: error ? (typeof (error as any).code === "number" ? (error as any).code : 1) : 0, output: `${stdout}${stderr}` })); child.stdin?.end(); }); }
