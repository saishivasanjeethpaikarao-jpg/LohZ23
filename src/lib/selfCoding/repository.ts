import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  DependencyRelationship,
  DiagnosticArtifact,
  FileReference,
  ProposedFilePatch,
  SearchHit,
} from "./types";
import { SELF_CODING_LIMITS } from "./types";

const ALLOWED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".css", ".html", ".rules", ".yml", ".yaml"]);
const ALLOWED_ROOT_FILES = new Set(["package.json", "tsconfig.json", "vite.config.ts", "vitest.config.ts", "vitest.emulator.config.ts", "firestore.rules", "server.ts", "agentBridge.ts", "server_memory.ts", "index.html"]);
const ALLOWED_DIRECTORIES = new Set(["src", "server", "windows-agent", "docs", "scripts"]);
const DENIED_SEGMENTS = new Set(["node_modules", ".git", "dist", "data", ".freebuff", "coverage", ".codex"]);

function sha256(content: string): string { return createHash("sha256").update(content, "utf8").digest("hex"); }
function posix(value: string): string { return value.replace(/\\/g, "/"); }

export class DiagnosticArtifactStore {
  private artifacts: DiagnosticArtifact[] = [];
  add(kind: DiagnosticArtifact["kind"], content: string, capturedAt = Date.now()): DiagnosticArtifact {
    const artifact = { artifactId: randomUUID(), kind, content: content.slice(0, SELF_CODING_LIMITS.maxArtifactChars), capturedAt };
    this.artifacts.push(artifact); this.artifacts = this.artifacts.slice(-20); return { ...artifact };
  }
  latest(kind: DiagnosticArtifact["kind"]): DiagnosticArtifact | null {
    const value = [...this.artifacts].reverse().find((item) => item.kind === kind); return value ? { ...value } : null;
  }
}

export class ControlledRepository {
  private readonly root: string;
  constructor(root: string, private readonly artifacts = new DiagnosticArtifactStore()) {
    this.root = fs.realpathSync(path.resolve(root));
  }

  listFiles(): string[] {
    const output: string[] = [];
    const walk = (dir: string): void => {
      if (output.length >= SELF_CODING_LIMITS.maxFilesPerList) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || DENIED_SEGMENTS.has(entry.name)) continue;
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(absolute); continue; }
        const relative = posix(path.relative(this.root, absolute));
        if (this.isAllowed(relative)) output.push(relative);
      }
    };
    for (const name of ALLOWED_DIRECTORIES) {
      const dir = path.join(this.root, name); if (fs.existsSync(dir)) walk(dir);
    }
    for (const name of ALLOWED_ROOT_FILES) if (fs.existsSync(path.join(this.root, name))) output.push(name);
    return [...new Set(output)].sort().slice(0, SELF_CODING_LIMITS.maxFilesPerList);
  }

  readSource(relativePath: string): { reference: FileReference; content: string } | null {
    const resolved = this.resolve(relativePath, false); if (!resolved || !fs.existsSync(resolved.absolute)) return null;
    const stat = fs.statSync(resolved.absolute); if (!stat.isFile() || stat.size > SELF_CODING_LIMITS.maxFileBytes) return null;
    const content = fs.readFileSync(resolved.absolute, "utf8");
    return { reference: referenceFor(resolved.relative, content), content };
  }

  readTests(limit = 100): FileReference[] {
    return this.listFiles().filter((file) => /(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(file)).slice(0, Math.min(Math.max(limit, 0), 100))
      .flatMap((file) => { const value = this.readSource(file); return value ? [value.reference] : []; });
  }

  readBuildOutput(): DiagnosticArtifact | null { return this.artifacts.latest("build_output"); }
  readErrorLog(): DiagnosticArtifact | null { return this.artifacts.latest("error_log"); }
  recordDiagnostic(kind: DiagnosticArtifact["kind"], content: string): DiagnosticArtifact {
    return this.artifacts.add(kind, content);
  }

  searchSymbols(query: string, limit: number = SELF_CODING_LIMITS.maxSearchHits): SearchHit[] {
    const needle = query.trim().slice(0, SELF_CODING_LIMITS.maxSearchQueryChars);
    if (needle.length < 2 || /[\u0000-\u001f]/.test(needle)) return [];
    const hits: SearchHit[] = [];
    const lower = needle.toLowerCase();
    for (const file of this.listFiles()) {
      const source = this.readSource(file); if (!source) continue;
      const lines = source.content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].toLowerCase().includes(lower)) continue;
        hits.push({ path: file, line: index + 1, preview: lines[index].trim().slice(0, 300) });
        if (hits.length >= Math.min(Math.max(limit, 1), SELF_CODING_LIMITS.maxSearchHits)) return hits;
      }
    }
    return hits;
  }

  dependencies(relativePath: string): DependencyRelationship[] {
    const source = this.readSource(relativePath); if (!source) return [];
    const relationships: DependencyRelationship[] = [];
    const patterns: Array<{ kind: DependencyRelationship["kind"]; regex: RegExp }> = [
      { kind: "static_import", regex: /(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g },
      { kind: "dynamic_import", regex: /import\(\s*["']([^"']+)["']\s*\)/g },
      { kind: "require", regex: /require\(\s*["']([^"']+)["']\s*\)/g },
    ];
    for (const { kind, regex } of patterns) {
      for (const match of source.content.matchAll(regex)) {
        const specifier = match[1];
        relationships.push({ from: source.reference.path, specifier, resolvedPath: this.resolveImport(source.reference.path, specifier), kind });
        if (relationships.length >= 200) return relationships;
      }
    }
    return relationships;
  }

  identifyAffectedFiles(requirement: string, diagnostic = ""): FileReference[] {
    const tokens = [...new Set(`${requirement} ${diagnostic}`.match(/[A-Za-z_$][A-Za-z0-9_$.-]{2,}/g) ?? [])]
      .filter((token) => !STOP_WORDS.has(token.toLowerCase())).slice(0, 12);
    const score = new Map<string, number>();
    const files = this.listFiles();
    for (const token of tokens) {
      const lower = token.toLowerCase();
      for (const file of files) if (file.toLowerCase().includes(lower)) score.set(file, (score.get(file) ?? 0) + 2);
      for (const hit of this.searchSymbols(token, 30)) score.set(hit.path, (score.get(hit.path) ?? 0) + 1);
    }
    const direct = [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 15).map(([file]) => file);
    const directSet = new Set(direct);
    for (const file of this.listFiles()) {
      if (directSet.size >= SELF_CODING_LIMITS.maxAffectedFiles) break;
      if (this.dependencies(file).some((item) => item.resolvedPath && direct.includes(item.resolvedPath))) directSet.add(file);
    }
    return [...directSet].slice(0, SELF_CODING_LIMITS.maxAffectedFiles).flatMap((file) => {
      const source = this.readSource(file); return source ? [source.reference] : [];
    });
  }

  previewPatches(patches: ProposedFilePatch[]): Map<string, string> {
    const output = new Map<string, string>();
    for (const patch of patches) {
      const resolved = this.resolve(patch.path, true); if (!resolved) throw new Error(`path_not_allowed:${patch.path}`);
      if (patch.operation === "create") {
        if (fs.existsSync(resolved.absolute) || patch.expectedSha256 !== null || patch.hunks.length !== 1 || patch.hunks[0].oldText !== "") throw new Error(`invalid_create:${patch.path}`);
        output.set(patch.path, boundedPatchText(patch.hunks[0].newText)); continue;
      }
      const source = this.readSource(patch.path);
      if (!source || source.reference.sha256 !== patch.expectedSha256) throw new Error(`stale_file:${patch.path}`);
      let content = source.content;
      for (const hunk of patch.hunks) {
        if (!hunk.oldText || countOccurrences(content, hunk.oldText) !== 1) throw new Error(`ambiguous_hunk:${patch.path}`);
        content = content.replace(hunk.oldText, boundedPatchText(hunk.newText));
      }
      if (content.length > SELF_CODING_LIMITS.maxPatchTextChars) throw new Error(`patched_file_too_large:${patch.path}`);
      output.set(patch.path, content);
    }
    return output;
  }

  applyPatches(patches: ProposedFilePatch[]): { ok: boolean; error?: string } {
    let preview: Map<string, string>;
    try { preview = this.previewPatches(patches); } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "patch_preview_failed" }; }
    const backups = new Map<string, string | null>();
    try {
      for (const [relative, content] of preview) {
        const resolved = this.resolve(relative, true)!;
        backups.set(relative, fs.existsSync(resolved.absolute) ? fs.readFileSync(resolved.absolute, "utf8") : null);
        fs.mkdirSync(path.dirname(resolved.absolute), { recursive: true });
        const temp = `${resolved.absolute}.${process.pid}.${randomUUID()}.phase43.tmp`;
        fs.writeFileSync(temp, content, { encoding: "utf8", flag: "wx" });
        fs.renameSync(temp, resolved.absolute);
      }
      return { ok: true };
    } catch (error) {
      for (const [relative, previous] of backups) {
        const resolved = this.resolve(relative, true); if (!resolved) continue;
        try {
          if (previous === null) { if (fs.existsSync(resolved.absolute)) fs.unlinkSync(resolved.absolute); }
          else fs.writeFileSync(resolved.absolute, previous, "utf8");
        } catch { /* best-effort rollback; caller records apply_failed */ }
      }
      return { ok: false, error: error instanceof Error ? error.message : "patch_apply_failed" };
    }
  }

  private resolve(relativePath: string, forWrite: boolean): { absolute: string; relative: string } | null {
    const relative = posix(path.posix.normalize(posix(String(relativePath ?? ""))));
    if (!relative || relative === "." || relative.startsWith("../") || path.posix.isAbsolute(relative) || !this.isAllowed(relative)) return null;
    const absolute = path.resolve(this.root, ...relative.split("/"));
    if (absolute !== this.root && !absolute.startsWith(this.root + path.sep)) return null;
    let cursor = this.root;
    for (const segment of relative.split("/").slice(0, -1)) {
      cursor = path.join(cursor, segment);
      if (!fs.existsSync(cursor)) break;
      if (fs.lstatSync(cursor).isSymbolicLink()) return null;
      const realParent = fs.realpathSync(cursor);
      if (realParent !== this.root && !realParent.startsWith(this.root + path.sep)) return null;
    }
    if (fs.existsSync(absolute)) {
      const real = fs.realpathSync(absolute); if (real !== this.root && !real.startsWith(this.root + path.sep)) return null;
      if (fs.lstatSync(absolute).isSymbolicLink()) return null;
    } else if (!forWrite) return null;
    return { absolute, relative };
  }

  private isAllowed(relative: string): boolean {
    const segments = relative.split("/");
    if (segments.some((segment) => DENIED_SEGMENTS.has(segment) || segment.startsWith(".env"))) return false;
    if (segments.length === 1) return ALLOWED_ROOT_FILES.has(relative);
    return ALLOWED_DIRECTORIES.has(segments[0]) && ALLOWED_EXTENSIONS.has(path.extname(relative).toLowerCase());
  }

  private resolveImport(from: string, specifier: string): string | null {
    if (!specifier.startsWith(".")) return null;
    const base = posix(path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)));
    for (const candidate of [base, ...[".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"].map((ext) => base + ext), ...["index.ts", "index.tsx", "index.js"].map((file) => `${base}/${file}`)]) {
      if (this.readSource(candidate)) return candidate;
    }
    return null;
  }
}

function referenceFor(relative: string, content: string): FileReference {
  return { path: relative, sha256: sha256(content), size: Buffer.byteLength(content), kind: classify(relative) };
}
function classify(relative: string): FileReference["kind"] {
  if (/(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(relative)) return "test";
  if (relative.startsWith("docs/") || relative.endsWith(".md")) return "documentation";
  if (/\.(?:json|rules|ya?ml)$/.test(relative)) return "config";
  return "source";
}
function countOccurrences(content: string, needle: string): number { return content.split(needle).length - 1; }
function boundedPatchText(value: string): string {
  if (typeof value !== "string" || value.length > SELF_CODING_LIMITS.maxPatchTextChars || value.includes("\0")) throw new Error("patch_text_invalid");
  return value;
}
const STOP_WORDS = new Set(["the", "and", "for", "with", "from", "this", "that", "add", "fix", "feature", "error", "should", "into", "when", "then", "user"]);
