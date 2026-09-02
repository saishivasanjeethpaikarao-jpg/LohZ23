/**
 * Path security validation for all file operations.
 *
 * Rules:
 * - Allowed roots ONLY: Desktop, Documents, Downloads, and the LOHZ workspace
 *   (windows-agent/workspace, or LOHZ_WORKSPACE env override).
 * - UNC paths (\\server\share) and device paths are rejected.
 * - Bare filenames resolve against the LOHZ workspace by default.
 * - "Desktop/x.txt", "Documents/x.txt", "Downloads/x.txt" prefixes map to the real user folders.
 * - After normalization the resolved target MUST remain inside an allowed root.
 */
import fs from "fs";
import os from "os";
import path from "path";
import net from "net";
import { runtimeDataRoot } from "../../src/lib/runtimePaths";

export interface SafePathResolution {
  ok: boolean;
  errorCode?: string;
  details?: string;
  /** Absolute normalized path (only when ok). */
  target?: string;
  /** Which root the target belongs to. */
  rootName?: string;
}

function getWorkspaceRoot(): string {
  const custom = process.env.LOHZ_WORKSPACE;
  if (custom && custom.trim()) {
    return path.resolve(custom.trim());
  }
  return process.env.LOHZ_DATA_DIR ? runtimeDataRoot("windows-agent", "workspace") : path.join(process.cwd(), "windows-agent", "workspace");
}

/** Ordered list of allowed roots. Later prefix checks are case-insensitive (win32). */
export function getAllowedRoots(): Array<{ name: string; dir: string }> {
  const home = os.homedir();
  return [
    { name: "Desktop", dir: path.join(home, "Desktop") },
    { name: "Documents", dir: path.join(home, "Documents") },
    { name: "Downloads", dir: path.join(home, "Downloads") },
    { name: "Workspace", dir: getWorkspaceRoot() },
  ];
}

const FORBIDDEN_SYSTEM_DIRS = [
  "c:\\windows",
  "c:\\program files",
  "c:\\program files (x86)",
  "c:\\programdata",
  "c:\\users\\all users",
];

/**
 * Validates and resolves a user-supplied path against the allowed roots.
 * Accepts:
 *   - bare filename            -> workspace/<filename>
 *   - subfolder path           -> workspace/<sub>/<file>
 *   - "Desktop|Documents|Downloads/<relative>" -> that user folder
 *   - absolute path            -> allowed only if already inside an allowed root
 */
export function resolveSafePath(inputPath: string): SafePathResolution {
  const raw = (inputPath || "").trim();
  if (!raw) return { ok: false, errorCode: "PATH_EMPTY", details: "No path supplied." };

  // Reject UNC and device paths outright.
  if (raw.startsWith("\\\\") || raw.startsWith("//")) {
    return { ok: false, errorCode: "PATH_UNC_REJECTED", details: "UNC network paths are not permitted." };
  }
  if (/^[a-zA-Z]:\\{2}/.test(raw) || raw.toLowerCase().includes(":\\$")) {
    return { ok: false, errorCode: "PATH_DEVICE_REJECTED", details: "Device/namespace paths are not permitted." };
  }

  const roots = getAllowedRoots();

  let candidate: string;
  const lowerRaw = raw.toLowerCase().replace(/\//g, "\\");

  if (/^[a-zA-Z]:[\\/]/.test(raw)) {
    // Absolute Windows path: must already be inside an allowed root.
    candidate = path.resolve(raw);
  } else {
    // Relative: map special root prefixes, otherwise default to workspace.
    let rel = raw;
    let base: { name: string; dir: string } | undefined = roots.find((r) =>
      lowerRaw === r.name.toLowerCase() || lowerRaw.startsWith(r.name.toLowerCase() + "\\")
    );
    if (base) {
      rel = raw.slice(base.name.length).replace(/^[\\/]+/, "");
      if (!rel) {
        // The user passed exactly a root name (a directory itself).
        return { ok: true, target: path.resolve(base.dir), rootName: base.name };
      }
    } else {
      base = roots[roots.length - 1]; // Workspace
    }
    candidate = path.resolve(base.dir, rel);
  }

  // Final containment check: candidate must sit under one of the allowed roots.
  const normalized = path.resolve(candidate);
  const matchedRoot = roots.find(
    (r) =>
      normalized.toLowerCase() === path.resolve(r.dir).toLowerCase() ||
      normalized.toLowerCase().startsWith(path.resolve(r.dir).toLowerCase() + path.sep)
  );

  if (!matchedRoot) {
    return {
      ok: false,
      errorCode: "PATH_OUTSIDE_SAFE_ROOTS",
      details:
        `Path "${inputPath}" resolves outside the allowed folders ` +
        `(Desktop, Documents, Downloads, LOHZ workspace).`,
    };
  }

  // Extra guard: never touch Windows/Program Files even if roots were misconfigured.
  const lowerNorm = normalized.toLowerCase();
  for (const forbidden of FORBIDDEN_SYSTEM_DIRS) {
    if (lowerNorm === forbidden || lowerNorm.startsWith(forbidden + "\\")) {
      return { ok: false, errorCode: "PATH_SYSTEM_DIR_REJECTED", details: "System directories are protected." };
    }
  }

  // Lexical containment is insufficient when an allowed directory contains a
  // junction/symlink. Resolve the nearest existing ancestor and ensure its
  // real path remains inside the real allowed root before any file operation.
  try {
    const rootPath = path.resolve(matchedRoot.dir);
    const realRoot = fs.existsSync(rootPath) ? fs.realpathSync.native(rootPath) : rootPath;
    let ancestor = normalized;
    while (!fs.existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    if (fs.existsSync(ancestor)) {
      const realAncestor = fs.realpathSync.native(ancestor);
      const rootKey = realRoot.toLowerCase();
      const ancestorKey = realAncestor.toLowerCase();
      if (ancestorKey !== rootKey && !ancestorKey.startsWith(rootKey + path.sep.toLowerCase())) {
        return { ok: false, errorCode: "PATH_LINK_ESCAPE", details: "Path escapes its allowed root through a link." };
      }
    }
  } catch {
    return { ok: false, errorCode: "PATH_REALPATH_FAILED", details: "Could not verify the path's real location." };
  }

  return { ok: true, target: normalized, rootName: matchedRoot.name };
}

/** True only for public-looking DNS names or non-private IP addresses. */
export function isPublicHostname(input: string): boolean {
  const host = String(input || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  const kind = net.isIP(host);
  if (kind === 4) {
    const parts = host.split(".").map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (kind === 6) {
    if (host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd")) return false;
    if (/^fe[89ab]/.test(host) || host.startsWith("::ffff:127.") || host.startsWith("::ffff:10.")) return false;
    return true;
  }
  if (!host.includes(".") || host.length > 253) return false;
  return host.split(".").every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label));
}

/** Validates a bare file/folder NAME (no separators, no traversal). */
export function isSafeBasename(name: string): boolean {
  if (!name || typeof name !== "string") return false;
  if (/[\\/]/.test(name)) return false;
  if (name === "." || name === "..") return false;
  // Windows forbidden characters.
  if (/[<>:"|?*\x00-\x1f]/.test(name)) return false;
  if (name.length > 120) return false;
  return /^(?!\s+$).+/.test(name); // at least one non-space char
}

export function ensureWorkspaceDirs(): void {
  const screenshots = process.env.LOHZ_DATA_DIR ? runtimeDataRoot("windows-agent", "screenshots") : path.join(process.cwd(), "windows-agent", "screenshots");
  for (const dir of [getWorkspaceRoot(), screenshots]) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.error("[Validation] Could not create directory:", dir, (err as Error).message);
    }
  }
}

/** Content limits for text IO tools. */
export const LIMITS = {
  READ_MAX_BYTES: 200 * 1024, // 200 KB
  WRITE_MAX_BYTES: 1024 * 1024, // 1 MB
  CLIPBOARD_MAX_BYTES: 512 * 1024, // 512 KB
};
